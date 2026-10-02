import { inflateSync, unzlibSync } from "fflate";

/**
 * Minimal, dependency-free PDF support for the Office toolkit.
 *
 * Read: page count, the Info `/Title`, and per-page text taken from the page's
 * content streams. Write: a small uncompressed PDF assembled by hand.
 *
 * Supported subset, on purpose: FlateDecode (and uncompressed) content streams,
 * base-14 Helvetica, literal and hexadecimal strings, the `Tj` / `TJ` / `'` /
 * `"` text operators, and the newline shown by `T*` / `Td` / `TD` / `TL`.
 *
 * Not supported: OCR, images, encryption, form fields, embedded fonts, object
 * streams (PDF 1.5 compressed xref), LZW/ASCII85/DCT filters, and the exact
 * glyph spacing a viewer computes. Text is a best-effort approximation: a page
 * whose stream cannot be decoded yields `text: ""` rather than an error.
 */

export interface PdfInspectBounds {
  readonly maxPages: number;
  readonly maxTextCharsPerPage: number;
}

export interface PdfPageText {
  readonly page: number;
  readonly text: string;
}

export interface PdfInspectResult {
  readonly pageCount: number;
  readonly title: string | null;
  readonly pages: ReadonlyArray<PdfPageText>;
  readonly truncated: boolean;
}

export interface PdfWritePage {
  readonly heading?: string | undefined;
  readonly lines: ReadonlyArray<string>;
}

export interface PdfWriteInput {
  readonly title?: string | undefined;
  readonly pages: ReadonlyArray<PdfWritePage>;
}

/** Page geometry and text metrics for generated files (US Letter-ish). */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 54;
const BODY_FONT_SIZE = 11;
const BODY_LEADING = 14;
const HEADING_FONT_SIZE = 14;
const HEADING_LEADING = 20;
/** Helvetica at 11pt averages ~0.5em per glyph, so 90 characters stay inside the margins. */
const MAX_LINE_CHARS = 90;

/**
 * One Latin-1 code unit per byte, so string offsets are byte offsets. The
 * `windows-1252` decoder used by `TextDecoder("latin1")` does not give that
 * identity for 0x80-0x9F, which would corrupt binary streams.
 */
function toBinaryString(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let text = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    text += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return text;
}

function toBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

interface PdfObject {
  readonly number: number;
  /** The dictionary text that precedes the stream, or the whole object body. */
  readonly body: string;
  readonly streamStart: number;
  readonly streamEnd: number;
}

const PAGE_TYPE = /\/Type\s*\/Page(?![\w])/;
const PAGES_TYPE = /\/Type\s*\/Pages(?![\w])/;

/**
 * Every `N G obj … endobj` in the file. The xref table is ignored on purpose:
 * broken and incrementally-updated files still yield Objects, and a repair pass
 * is out of scope.
 */
function scanObjects(raw: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const pattern = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (match.index < cursor) continue;
    const number = Number(match[1]);
    if (!Number.isInteger(number) || objects.has(number)) {
      cursor = match.index + match[0].length;
      continue;
    }
    const start = match.index + match[0].length;
    const dictionary = raw.slice(
      start,
      raw.indexOf("endobj", start) === -1 ? raw.length : raw.indexOf("endobj", start),
    );
    let bodyEnd = start + dictionary.length;
    let streamStart = -1;
    let streamEnd = -1;
    const streamKeyword = /\bstream\b/.exec(dictionary);
    if (streamKeyword !== null) {
      bodyEnd = start + streamKeyword.index;
      let dataStart = bodyEnd + streamKeyword[0].length;
      if (raw.charAt(dataStart) === "\r") dataStart += 1;
      if (raw.charAt(dataStart) === "\n") dataStart += 1;
      const declaredLength = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dictionary);
      const declared = declaredLength === null ? Number.NaN : Number(declaredLength[1]);
      if (Number.isInteger(declared) && declared >= 0 && dataStart + declared <= raw.length) {
        streamStart = dataStart;
        streamEnd = dataStart + declared;
      } else {
        const endStream = raw.indexOf("endstream", dataStart);
        if (endStream !== -1) {
          streamStart = dataStart;
          streamEnd = endStream;
          if (raw.charAt(streamEnd - 1) === "\n") streamEnd -= 1;
          if (raw.charAt(streamEnd - 1) === "\r") streamEnd -= 1;
        }
      }
      const endObject = raw.indexOf("endobj", streamEnd === -1 ? dataStart : streamEnd);
      bodyEnd = endObject === -1 ? raw.length : endObject;
    }
    objects.set(number, { number, body: raw.slice(start, bodyEnd), streamStart, streamEnd });
    cursor = bodyEnd;
  }
  return objects;
}

/** Object numbers referenced by `/Key`, either `5 0 R` or `[ 5 0 R 7 0 R ]`. */
function referencesFor(body: string, key: string): number[] {
  const match = new RegExp(`/${key}\\s*(\\[[^\\]]*\\]|\\d+\\s+\\d+\\s+R)`).exec(body);
  if (match === null) return [];
  const value = match[1] ?? "";
  const references: number[] = [];
  const pattern = /(\d+)\s+\d+\s+R/g;
  let reference: RegExpExecArray | null;
  while ((reference = pattern.exec(value)) !== null) references.push(Number(reference[1]));
  return references;
}

function isPageObject(object: PdfObject): boolean {
  return PAGE_TYPE.test(object.body);
}

/**
 * Pages in reading order: the `/Kids` array of every `/Pages` node first, then
 * any page object the tree did not mention, ordered by object number. Files
 * that write their pages out of object order still come back in tab order.
 */
function pageObjects(objects: Map<number, PdfObject>): PdfObject[] {
  const all = [...objects.values()];
  const ordered: PdfObject[] = [];
  const seen = new Set<number>();
  for (const node of all) {
    if (!PAGES_TYPE.test(node.body)) continue;
    for (const reference of referencesFor(node.body, "Kids")) {
      const kid = objects.get(reference);
      if (kid === undefined || !isPageObject(kid) || seen.has(kid.number)) continue;
      seen.add(kid.number);
      ordered.push(kid);
    }
  }
  for (const page of all) {
    if (!isPageObject(page) || seen.has(page.number)) continue;
    seen.add(page.number);
    ordered.push(page);
  }
  return ordered;
}

interface StringRead {
  readonly value: string;
  readonly next: number;
}

/** A `( … )` literal, undoing `\(`, `\)`, `\\`, `\n`, `\r`, `\t`, `\ddd` and line continuations. */
function readLiteralString(content: string, start: number): StringRead {
  let index = start + 1;
  let depth = 1;
  let value = "";
  while (index < content.length) {
    const character = content.charAt(index);
    if (character === "\\") {
      const escaped = content.charAt(index + 1);
      index += 2;
      if (escaped === "") {
        index -= 1;
        continue;
      }
      if (escaped === "n") value += "\n";
      else if (escaped === "r") value += "\r";
      else if (escaped === "t") value += "\t";
      else if (escaped === "b") value += "\b";
      else if (escaped === "f") value += "\f";
      else if (escaped === "\n") value += "";
      else if (escaped === "\r") {
        if (content.charAt(index) === "\n") index += 1;
      } else if (escaped >= "0" && escaped <= "7") {
        let digits = escaped;
        while (digits.length < 3) {
          const digit = content.charAt(index);
          if (digit < "0" || digit > "7") break;
          digits += digit;
          index += 1;
        }
        value += String.fromCharCode(Number.parseInt(digits, 8) & 0xff);
      } else {
        value += escaped;
      }
      continue;
    }
    if (character === "(") {
      depth += 1;
      value += character;
      index += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      index += 1;
      if (depth === 0) break;
      value += character;
      continue;
    }
    if (character === "\r") {
      if (content.charAt(index + 1) === "\n") index += 1;
      value += "\n";
      index += 1;
      continue;
    }
    value += character;
    index += 1;
  }
  return { value, next: index };
}

function hexStringToText(hex: string): string {
  const digits = hex.replace(/[^0-9A-Fa-f]/g, "");
  const padded = digits.length % 2 === 1 ? `${digits}0` : digits;
  let value = "";
  for (let index = 0; index + 1 < padded.length; index += 2) {
    value += String.fromCharCode(Number.parseInt(padded.slice(index, index + 2), 16));
  }
  return value;
}

function readHexString(content: string, start: number): StringRead {
  const end = content.indexOf(">", start);
  if (end === -1) return { value: "", next: content.length };
  return { value: hexStringToText(content.slice(start + 1, end)), next: end + 1 };
}

function readName(content: string, start: number): number {
  let index = start + 1;
  while (index < content.length && !/[\s()<>\[\]{}/%]/.test(content.charAt(index))) index += 1;
  return index;
}

function isWordCharacter(character: string): boolean {
  return /^[A-Za-z*'"0-9]$/.test(character);
}

/** Skips a `<< … >>` dictionary, including nested ones and the strings inside. */
function skipDictionary(content: string, start: number): number {
  let index = start;
  let depth = 0;
  while (index < content.length) {
    const character = content.charAt(index);
    if (character === "<" && content.charAt(index + 1) === "<") {
      depth += 1;
      index += 2;
      continue;
    }
    if (character === ">" && content.charAt(index + 1) === ">") {
      depth -= 1;
      index += 2;
      if (depth <= 0) return index;
      continue;
    }
    if (character === "(") {
      index = readLiteralString(content, index).next;
      continue;
    }
    index += 1;
  }
  return index;
}

/**
 * Text shown by one content stream. Operators are applied as they are seen; a
 * `TJ` number below -100 means a visible horizontal gap, which we surface as a
 * space, and the line-moving operators surface as a newline.
 */
function extractText(content: string): string {
  let text = "";
  let pendingBreak = false;
  const operands: Array<number | string | ReadonlyArray<number | string>> = [];
  const arrays: Array<Array<number | string>> = [];

  const append = (value: string): void => {
    if (pendingBreak) {
      pendingBreak = false;
      if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    }
    text += value;
  };

  const pushOperand = (value: number | string): void => {
    const current = arrays[arrays.length - 1];
    if (current === undefined) operands.push(value);
    else current.push(value);
  };

  const lastStringOperand = (): string | null => {
    for (let index = operands.length - 1; index >= 0; index -= 1) {
      const operand = operands[index];
      if (typeof operand === "string") return operand;
    }
    return null;
  };

  const showArrayOperand = (): void => {
    for (let index = operands.length - 1; index >= 0; index -= 1) {
      const operand = operands[index];
      if (!Array.isArray(operand)) continue;
      for (const element of operand) {
        if (typeof element === "number") {
          if (element < -100 && text.length > 0 && !text.endsWith(" ") && !text.endsWith("\n"))
            text += " ";
          continue;
        }
        append(element);
      }
      return;
    }
  };

  const applyOperator = (operator: string): void => {
    if (operator === "Tj") {
      const value = lastStringOperand();
      if (value !== null) append(value);
    } else if (operator === "TJ") {
      showArrayOperand();
    } else if (operator === "'" || operator === '"') {
      pendingBreak = true;
      const value = lastStringOperand();
      if (value !== null) append(value);
    } else if (operator === "T*" || operator === "Td" || operator === "TD" || operator === "TL") {
      pendingBreak = true;
    }
    operands.length = 0;
    arrays.length = 0;
  };

  let index = 0;
  while (index < content.length) {
    const character = content.charAt(index);
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "%") {
      while (
        index < content.length &&
        content.charAt(index) !== "\n" &&
        content.charAt(index) !== "\r"
      ) {
        index += 1;
      }
      continue;
    }
    if (character === "(") {
      const literal = readLiteralString(content, index);
      pushOperand(literal.value);
      index = literal.next;
      continue;
    }
    if (character === "<" && content.charAt(index + 1) === "<") {
      index = skipDictionary(content, index);
      continue;
    }
    if (character === "<") {
      const hex = readHexString(content, index);
      pushOperand(hex.value);
      index = hex.next;
      continue;
    }
    if (character === "[") {
      arrays.push([]);
      index += 1;
      continue;
    }
    if (character === "]") {
      const array = arrays.pop();
      operands.push(array === undefined ? [] : array);
      index += 1;
      continue;
    }
    if (character === "/") {
      index = readName(content, index);
      continue;
    }
    if (character === "+" || character === "-" || character === "." || /[0-9]/.test(character)) {
      const start = index;
      while (index < content.length && /[0-9+\-.]/.test(content.charAt(index))) index += 1;
      const value = Number(content.slice(start, index));
      pushOperand(Number.isFinite(value) ? value : 0);
      continue;
    }
    if (isWordCharacter(character)) {
      const start = index;
      while (index < content.length && isWordCharacter(content.charAt(index))) index += 1;
      applyOperator(content.slice(start, index));
      continue;
    }
    index += 1;
  }
  return text;
}

/**
 * `/FlateDecode` is zlib-wrapped (RFC 1950), which is `unzlibSync`; `inflateSync`
 * is the raw-DEFLATE variant some producers emit. The header check picks the
 * likely one and the other is the fallback, so neither path throws out of here.
 */
function inflateFlateStream(data: Uint8Array): string | null {
  const first = data[0] ?? 0;
  const second = data[1] ?? 0;
  const zlibWrapped = data.length > 2 && (first & 15) === 8 && ((first << 8) | second) % 31 === 0;
  for (const attempt of zlibWrapped ? [unzlibSync, inflateSync] : [inflateSync, unzlibSync]) {
    try {
      return toBinaryString(attempt(data));
    } catch {
      continue;
    }
  }
  return null;
}

/** Decoded stream text, or null when the stream is absent or uses a filter we cannot undo. */
function decodeStream(bytes: Uint8Array, object: PdfObject): string | null {
  if (object.streamEnd <= object.streamStart || object.streamStart < 0) return null;
  const data = bytes.subarray(object.streamStart, object.streamEnd);
  const filter = /\/Filter\s*(\[[^\]]*\]|\/[^\s/<>\[\]]*)/.exec(object.body);
  const value = filter === null ? "" : (filter[1] ?? "");
  if (value.includes("/FlateDecode")) return inflateFlateStream(data);
  if (value.includes("/")) return null;
  return toBinaryString(data);
}

/** PDF text strings may be UTF-16BE (BOM) or PDFDocEncoding; we decode the former exactly. */
function decodePdfString(value: string): string {
  if (value.charCodeAt(0) === 0xfe && value.charCodeAt(1) === 0xff) {
    let text = "";
    for (let index = 2; index + 1 < value.length; index += 2) {
      text += String.fromCharCode((value.charCodeAt(index) << 8) | value.charCodeAt(index + 1));
    }
    return text;
  }
  if (
    value.charCodeAt(0) === 0xef &&
    value.charCodeAt(1) === 0xbb &&
    value.charCodeAt(2) === 0xbf
  ) {
    return value.slice(3);
  }
  return value;
}

function readTextValue(body: string, key: string): string | null {
  const literal = new RegExp(`/${key}\\s*\\(`).exec(body);
  if (literal !== null) {
    return decodePdfString(readLiteralString(body, literal.index + literal[0].length - 1).value);
  }
  const hex = new RegExp(`/${key}\\s*<([0-9A-Fa-f\\s]*)>`).exec(body);
  if (hex !== null) return decodePdfString(hexStringToText(hex[1] ?? ""));
  return null;
}

function readTitle(raw: string, objects: Map<number, PdfObject>): string | null {
  const candidates: string[] = [];
  const pattern = /\/Info\s+(\d+)\s+\d+\s+R/g;
  const references: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) references.push(Number(match[1]));
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const reference = references[index];
    if (reference === undefined) continue;
    const object = objects.get(reference);
    if (object !== undefined) candidates.push(object.body);
  }
  for (const object of objects.values()) candidates.push(object.body);
  for (const body of candidates) {
    const value = readTextValue(body, "Title");
    if (value !== null && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Best-effort text extraction. A page whose stream cannot be decoded comes back
 * with `text: ""`, and a file with no `%PDF-` header at all is rejected.
 */
export function inspectPdf(bytes: Uint8Array, bounds: PdfInspectBounds): PdfInspectResult {
  if (bytes.length === 0) throw new Error("This file is not a PDF.");
  const raw = toBinaryString(bytes);
  if (!raw.slice(0, 4096).includes("%PDF-")) throw new Error("This file is not a PDF.");

  const objects = scanObjects(raw);
  const pages = pageObjects(objects);
  let pageCount = pages.length;
  if (pageCount === 0) {
    for (const object of objects.values()) {
      if (!PAGES_TYPE.test(object.body)) continue;
      const count = /\/Count\s+(\d+)/.exec(object.body);
      if (count !== null) pageCount = Math.max(pageCount, Number(count[1]));
    }
  }

  const maxPages = Math.max(0, Math.floor(bounds.maxPages));
  const maxTextChars = Math.max(0, Math.floor(bounds.maxTextCharsPerPage));
  const returned: PdfPageText[] = [];
  let truncated = Math.max(pageCount, pages.length) > maxPages;
  for (let index = 0; index < pages.length && index < maxPages; index += 1) {
    const page = pages[index];
    if (page === undefined) continue;
    let text = "";
    for (const reference of referencesFor(page.body, "Contents")) {
      const stream = objects.get(reference);
      if (stream === undefined) continue;
      const decoded = decodeStream(bytes, stream);
      if (decoded === null) continue;
      text += extractText(decoded);
    }
    if (text.length > maxTextChars) {
      text = text.slice(0, maxTextChars);
      truncated = true;
    }
    returned.push({ page: index + 1, text });
  }

  return { pageCount, title: readTitle(raw, objects), pages: returned, truncated };
}

/** Escapes a literal string, replacing what WinAnsi cannot carry with `?`. */
function escapePdfText(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    const code = value.charCodeAt(index);
    if (character === "(" || character === ")" || character === "\\") out += `\\${character}`;
    else if (character === "\n" || character === "\r" || character === "\t") out += " ";
    else if (code < 32 || code > 255) out += "?";
    else out += character;
  }
  return out;
}

/** Breaks a line at spaces so no chunk exceeds `MAX_LINE_CHARS`, keeping every character. */
function wrapLine(value: string): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > MAX_LINE_CHARS) {
    let cut = remaining.lastIndexOf(" ", MAX_LINE_CHARS - 1);
    cut = cut <= 0 ? MAX_LINE_CHARS : cut + 1;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  chunks.push(remaining);
  return chunks;
}

/** One page's content stream: a heading block, then one text block per wrapped line. */
function buildPageContent(page: PdfWritePage): string {
  const blocks: string[] = [];
  let cursor = PAGE_HEIGHT - PAGE_MARGIN;

  const emitLine = (value: string, fontSize: number, leading: number): boolean => {
    if (cursor < PAGE_MARGIN + fontSize) return false;
    blocks.push(
      `BT /F1 ${fontSize} Tf ${leading} TL ${PAGE_MARGIN} ${cursor} Td (${escapePdfText(value)}) Tj ET`,
    );
    cursor -= leading;
    return true;
  };

  if (page.heading !== undefined && page.heading.trim().length > 0) {
    for (const chunk of wrapLine(page.heading)) {
      if (!emitLine(chunk, HEADING_FONT_SIZE, HEADING_LEADING)) break;
    }
  }
  for (const line of page.lines) {
    let stopped = false;
    for (const chunk of wrapLine(line)) {
      if (!emitLine(chunk, BODY_FONT_SIZE, BODY_LEADING)) {
        stopped = true;
        break;
      }
    }
    if (stopped) break;
  }
  return blocks.join("\n");
}

/**
 * A minimal, valid, uncompressed PDF written by hand: Catalog, Pages tree, one
 * Page and Contents object per input page, one Helvetica resource, and an xref
 * table with real byte offsets. No creation date is embedded, so the same input
 * always produces the same bytes.
 */
export function createPdf(input: PdfWriteInput): Uint8Array {
  const pageInputs = input.pages.length === 0 ? [{ lines: [] }] : input.pages;
  const pageCount = pageInputs.length;
  const catalogNumber = 1;
  const pagesNumber = 2;
  const firstPageNumber = 3;
  const fontNumber = firstPageNumber + pageCount * 2;
  const infoNumber = input.title === undefined ? null : fontNumber + 1;
  const size = (infoNumber ?? fontNumber) + 1;

  const bodies = new Map<number, string>();
  bodies.set(catalogNumber, `<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`);
  const kids = pageInputs.map((_, index) => `${firstPageNumber + index * 2} 0 R`).join(" ");
  bodies.set(pagesNumber, `<< /Type /Pages /Count ${pageCount} /Kids [ ${kids} ] >>`);
  bodies.set(
    fontNumber,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  pageInputs.forEach((page, index) => {
    const pageObject = firstPageNumber + index * 2;
    const contentObject = pageObject + 1;
    const content = buildPageContent(page);
    bodies.set(contentObject, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    bodies.set(
      pageObject,
      `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [ 0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT} ] /Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    );
  });
  if (infoNumber !== null && input.title !== undefined) {
    bodies.set(infoNumber, `<< /Title (${escapePdfText(input.title)}) /Producer (T3 Code) >>`);
  }

  let output = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (let number = 1; number < size; number += 1) {
    const body = bodies.get(number);
    if (body === undefined) continue;
    offsets.set(number, output.length);
    output += `${number} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = output.length;
  output += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let number = 1; number < size; number += 1) {
    const offset = offsets.get(number);
    output +=
      offset === undefined
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${size} /Root ${catalogNumber} 0 R${
    infoNumber === null ? "" : ` /Info ${infoNumber} 0 R`
  } >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return toBytes(output);
}
