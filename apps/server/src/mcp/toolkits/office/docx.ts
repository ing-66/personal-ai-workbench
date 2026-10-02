import type { Element, Node } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { findChildElements, findElements, parseXmlPart, textOf, xmlText } from "./xml.ts";

/**
 * WordprocessingML (`.docx`) support: a bounded body inspector plus an editor
 * that inserts into, or rewrites one paragraph of, `word/document.xml`.
 *
 * Supported subset: body-level paragraphs and their text runs (including a
 * paragraph split across several runs, `w:tab` and `w:br`), heading styles, and
 * simple text tables. Everything else - styles, themes, headers and footers,
 * images, tracked changes, section properties - is carried through untouched but
 * never interpreted.
 */

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const DOCUMENT_PART = "word/document.xml";
const CONTENT_TYPES_PART = "[Content_Types].xml";
const CORE_PROPERTIES_PART = "docProps/core.xml";
const EXTENDED_PROPERTIES_PART = "docProps/app.xml";
const APP_NAME = "T3 Code";

const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const CORE_PROPERTIES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const EXTENDED_PROPERTIES_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";

type XmlPart = ReturnType<typeof parseXmlPart>;

/**
 * Parses one part. Every parse failure becomes the same readable message, so a
 * malformed part reaches the caller as a structured tool failure rather than as
 * a parser diagnostic, and no part content is echoed back.
 */
function parsePart(xml: string): XmlPart {
  try {
    return parseXmlPart(xml);
  } catch {
    throw new Error("A part of this .docx package is not well-formed XML, so it cannot be read.");
  }
}

/** How much of a document the inspector may return. */
export interface DocxInspectBounds {
  readonly maxParagraphs: number;
  readonly maxTextChars: number;
}

/**
 * What the inspector can say about a document. `paragraphs` only holds
 * non-empty, body-level paragraph texts, and the same index space is what
 * `replace-paragraph` addresses.
 */
export interface DocxInspectResult {
  readonly paragraphs: ReadonlyArray<string>;
  readonly outline: ReadonlyArray<string>;
  readonly tables: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>;
  readonly truncated: boolean;
  readonly paragraphCount: number;
}

/**
 * The edits this module can make. `index` counts the non-empty, body-level
 * paragraphs `inspectDocx` returns, so index 0 is the first paragraph a reader
 * sees.
 */
export type DocxWriteOperation =
  | { readonly kind: "append-paragraph"; readonly text: string; readonly headingLevel?: 1 | 2 | 3 }
  | { readonly kind: "replace-paragraph"; readonly index: number; readonly text: string }
  | { readonly kind: "append-table"; readonly rows: ReadonlyArray<ReadonlyArray<string>> };

interface WriteDocxInput {
  readonly existing: Uint8Array | null;
  readonly title?: string | undefined;
  readonly seedParagraphs?: ReadonlyArray<string> | undefined;
  readonly operation?: DocxWriteOperation | undefined;
}

interface BodyContent {
  readonly paragraphs: Element[];
  readonly tables: Element[];
}

interface ElementSpan {
  readonly start: number;
  readonly end: number;
}

interface BodyItem {
  readonly kind: "p" | "tbl";
  readonly start: number;
  readonly end: number;
}

interface Tag extends ElementSpan {
  readonly localName: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

/** Unpacks a `.docx`, reporting a non-ZIP input as a readable error. */
function readPackage(bytes: Uint8Array): Record<string, Uint8Array> {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new Error("This is not a .docx file: its package is not a readable ZIP archive.");
  }
  if (Object.keys(parts).length === 0) {
    throw new Error("This is not a .docx file: its package is an empty ZIP archive.");
  }
  return parts;
}

/** The main document part's text, or a readable error when it is missing. */
function readDocumentPartText(bytes: Uint8Array): string {
  const parts = readPackage(bytes);
  const document = parts[DOCUMENT_PART];
  if (document === undefined) {
    throw new Error(
      "This .docx package has no word/document.xml part, so it is not a Word document.",
    );
  }
  return strFromU8(document);
}

/** The local name of an element node, without its namespace prefix. */
function elementLocalName(node: Node): string {
  const local = node.localName;
  if (local !== null && local.length > 0) return local;
  const name = node.nodeName;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Reads a namespaced attribute without assuming which prefix the part used. */
function namespacedAttribute(
  element: Element,
  namespace: string,
  prefix: string,
  name: string,
): string | null {
  for (const candidate of [`${prefix}:${name}`, name]) {
    const value = element.getAttribute(candidate);
    if (value !== null && value.length > 0) return value;
  }
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes.item(index);
    if (attribute === null) continue;
    if (attribute.localName === name && attribute.namespaceURI === namespace)
      return attribute.value;
  }
  return null;
}

/**
 * One paragraph's text. Runs are concatenated, `w:tab` becomes a tab and
 * `w:br`/`w:cr` a newline, and wrappers such as hyperlinks are followed because
 * their runs are still this paragraph's text. A nested table is skipped: its
 * paragraphs belong to the table.
 */
function paragraphText(paragraph: Element): string {
  const parts: string[] = [];
  collectParagraphText(paragraph as unknown as Node, parts);
  return parts.join("");
}

function collectParagraphText(node: Node, out: string[]): void {
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index);
    if (child === null || child.nodeType !== 1) continue;
    const name = elementLocalName(child);
    if (name === "t") {
      out.push(textOf(child as unknown as Element));
      continue;
    }
    if (name === "tab") {
      out.push("\t");
      continue;
    }
    if (name === "br" || name === "cr") {
      out.push("\n");
      continue;
    }
    if (name === "tbl" || name === "pPr" || name === "rPr") continue;
    collectParagraphText(child, out);
  }
}

/** The `w:pStyle` style id of a paragraph, or null when it has none. */
function paragraphStyleId(paragraph: Element): string | null {
  const properties = findChildElements(paragraph, "pPr")[0];
  if (properties === undefined) return null;
  const style = findChildElements(properties, "pStyle")[0];
  if (style === undefined) return null;
  return namespacedAttribute(style, WORD_NAMESPACE, "w", "val");
}

/**
 * `Heading1`, `heading 1` and friends are the outline. The `Title` style is
 * deliberately not a heading: it names the document, not a section of it.
 */
function isHeadingStyle(styleId: string | null): boolean {
  return styleId !== null && /^heading\s*\d*$/i.test(styleId.trim());
}

/**
 * The body's own paragraphs and tables, in document order. Wrappers such as
 * `w:sdt` are transparent, and paragraphs inside a table stay with the table, so
 * `paragraphs` is an index space the writer can map back onto the part.
 */
function collectBodyContent(parent: Element, out: BodyContent): void {
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);
    if (child === null || child.nodeType !== 1) continue;
    const element = child as unknown as Element;
    const name = elementLocalName(child);
    if (name === "p") {
      out.paragraphs.push(element);
      continue;
    }
    if (name === "tbl") {
      out.tables.push(element);
      continue;
    }
    collectBodyContent(element, out);
  }
}

/** The body's readable content, or a readable error when the part has no body. */
function bodyContentOf(document: XmlPart): BodyContent {
  const body = findElements(document, "body")[0];
  if (body === undefined) {
    throw new Error(
      "word/document.xml has no w:body element, so it is not a readable Word document.",
    );
  }
  const content: BodyContent = { paragraphs: [], tables: [] };
  collectBodyContent(body, content);
  return content;
}

/** Table -> row -> cell text; a cell's paragraphs are joined with a space. */
function tableRows(table: Element): string[][] {
  return findChildElements(table, "tr").map((row) =>
    findChildElements(row, "tc").map((cell) => cellText(cell)),
  );
}

function cellText(cell: Element): string {
  const texts: string[] = [];
  for (const paragraph of findChildElements(cell, "p")) {
    const text = paragraphText(paragraph);
    if (text.trim().length > 0) texts.push(text);
  }
  return texts.join(" ");
}

interface AddressedParagraph {
  readonly text: string;
  readonly heading: boolean;
  readonly span: ElementSpan | null;
}

/**
 * The paragraphs a reader can address, in order: non-empty body-level
 * paragraphs, paired with the source range of the element that produced them.
 * The writer needs those ranges because it edits `word/document.xml` as text, so
 * every byte it does not touch survives.
 */
function addressedParagraphs(document: XmlPart, documentXml: string): AddressedParagraph[] {
  const content = bodyContentOf(document);
  const paragraphSpans = topLevelItems(documentXml)
    .filter((item) => item.kind === "p")
    .map((item) => ({ start: item.start, end: item.end }));
  if (paragraphSpans.length !== content.paragraphs.length) {
    throw new Error(
      "This document's body cannot be addressed safely, so it was left untouched. Only body-level paragraphs and tables are supported.",
    );
  }
  const addressed: AddressedParagraph[] = [];
  content.paragraphs.forEach((paragraph, index) => {
    const text = paragraphText(paragraph);
    if (text.trim().length === 0) return;
    addressed.push({
      text,
      heading: isHeadingStyle(paragraphStyleId(paragraph)),
      span: paragraphSpans[index] ?? null,
    });
  });
  return addressed;
}

/**
 * Everything a reader is told about a document, capped by `bounds`.
 *
 * `paragraphCount` is the full non-empty paragraph index space before capping,
 * so a caller can tell a short document from a capped one. `outline` is drawn
 * from the returned paragraphs, which keeps `truncated` honest: a heading past
 * the cap is not silently reported as present.
 */
export function inspectDocx(bytes: Uint8Array, bounds: DocxInspectBounds): DocxInspectResult {
  const documentXml = readDocumentPartText(bytes);
  const document = parsePart(documentXml);
  const addressed = addressedParagraphs(document, documentXml);

  const paragraphs: string[] = [];
  const outline: string[] = [];
  let characters = 0;
  let truncated = false;
  for (const paragraph of addressed) {
    if (paragraphs.length >= bounds.maxParagraphs) {
      truncated = true;
      break;
    }
    const remaining = bounds.maxTextChars - characters;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (paragraph.text.length > remaining) {
      const clipped = paragraph.text.slice(0, remaining);
      paragraphs.push(clipped);
      if (paragraph.heading) outline.push(clipped);
      truncated = true;
      break;
    }
    paragraphs.push(paragraph.text);
    if (paragraph.heading) outline.push(paragraph.text);
    characters += paragraph.text.length;
  }

  return {
    paragraphs,
    outline,
    tables: bodyContentOf(document).tables.map((table) => tableRows(table)),
    truncated,
    paragraphCount: addressed.length,
  };
}

/**
 * Builds a `.docx`. With `existing` set, the document part is edited in place
 * and every other part - and every untouched byte of the document part - is
 * carried over verbatim. `title` only applies to a brand-new package, where it
 * becomes the document's first paragraph (Heading 1) and the package metadata.
 */
export function writeDocx(input: WriteDocxInput): Uint8Array {
  const operation = input.operation;
  if (input.existing === null) return writeNewDocument(input, operation);

  const parts = readPackage(input.existing);
  const document = parts[DOCUMENT_PART];
  if (document === undefined) {
    throw new Error(
      "This .docx package has no word/document.xml part, so it is not a Word document.",
    );
  }
  const documentXml = strFromU8(document);
  parsePart(documentXml);
  const updated = applyOperation(documentXml, operation);
  const written: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(parts)) {
    written[name] = name === DOCUMENT_PART ? strToU8(updated) : content;
  }
  return zipSync(written);
}

function writeNewDocument(
  input: WriteDocxInput,
  operation: DocxWriteOperation | undefined,
): Uint8Array {
  const body: string[] = [];
  const title = input.title !== undefined && input.title.trim().length > 0 ? input.title : null;
  if (title !== null) body.push(paragraphXml(title, headingProperties(1)));
  for (const paragraph of input.seedParagraphs ?? []) body.push(paragraphXml(paragraph, null));

  if (operation !== undefined) {
    if (operation.kind === "append-paragraph") {
      body.push(
        paragraphXml(operation.text, paragraphPropertiesForHeading(operation.headingLevel)),
      );
    } else if (operation.kind === "append-table") {
      body.push(tableXml(operation.rows));
    } else {
      throw new Error(
        `Cannot replace paragraph ${operation.index}: this is a new document and it has no paragraphs yet.`,
      );
    }
  }
  return packageNewDocument(body.join(""), title);
}

/** Applies one operation to an existing document part, as text. */
function applyOperation(documentXml: string, operation: DocxWriteOperation | undefined): string {
  if (operation === undefined) return documentXml;
  if (operation.kind === "replace-paragraph") {
    return replaceParagraph(documentXml, operation.index, operation.text);
  }
  const insertion =
    operation.kind === "append-paragraph"
      ? paragraphXml(operation.text, paragraphPropertiesForHeading(operation.headingLevel))
      : tableXml(operation.rows);
  return insertBeforeSection(documentXml, insertion);
}

/**
 * Replaces one paragraph, keeping its paragraph properties so a heading stays a
 * heading, and touching nothing else. `index` is the 0-based index over the
 * non-empty paragraphs `inspectDocx` returns; an out-of-range index is a
 * user-readable error rather than a silent no-op.
 */
function replaceParagraph(documentXml: string, index: number, text: string): string {
  const addressed = addressedParagraphs(parsePart(documentXml), documentXml);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Paragraph index ${index} is not valid; indexes start at 0.`);
  }
  const target = addressed[index];
  if (target === undefined || target.span === null) {
    throw new Error(
      `This document has no paragraph at index ${index}; it has ${addressed.length} non-empty paragraph(s).`,
    );
  }
  const original = documentXml.slice(target.span.start, target.span.end);
  const properties = findElementSpans(original, "pPr", 0, original.length)[0];
  const kept = properties === undefined ? null : original.slice(properties.start, properties.end);
  return (
    documentXml.slice(0, target.span.start) +
    paragraphXml(text, kept) +
    documentXml.slice(target.span.end)
  );
}

/**
 * Adds content as the last body content. Section properties must stay the final
 * child of `w:body`, so the insertion point is the body-level `w:sectPr` when
 * the document has one and `</w:body>` otherwise.
 */
function insertBeforeSection(documentXml: string, content: string): string {
  const bodyEnd = documentXml.lastIndexOf("</w:body>");
  if (bodyEnd === -1) {
    throw new Error(
      "word/document.xml has no w:body element, so there is nowhere to add this content.",
    );
  }
  const sectionStart = lastElementStart(documentXml, "sectPr", bodyEnd);
  if (sectionStart !== -1) {
    const section = elementSpanAt(documentXml, sectionStart, bodyEnd);
    if (section !== null && documentXml.slice(section.end, bodyEnd).trim().length === 0) {
      return `${documentXml.slice(0, sectionStart)}${content}${documentXml.slice(sectionStart)}`;
    }
  }
  return `${documentXml.slice(0, bodyEnd)}${content}${documentXml.slice(bodyEnd)}`;
}

function paragraphPropertiesForHeading(level: 1 | 2 | 3 | undefined): string | null {
  return level === undefined ? null : headingProperties(level);
}

function headingProperties(level: 1 | 2 | 3): string {
  return `<w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>`;
}

/**
 * One paragraph. `properties` is either a heading's `w:pPr` or an existing
 * paragraph's own properties, which is how a replacement keeps its style.
 */
function paragraphXml(text: string, properties: string | null): string {
  return `<w:p>${properties ?? ""}${textRunXml(text)}</w:p>`;
}

/** A tab or a line break becomes the element Word uses for it, not a raw byte. */
function textRunXml(text: string): string {
  const children = text
    .split(/(\r\n|\n|\r|\t)/)
    .map((segment) => {
      if (segment === "\t") return "<w:tab/>";
      if (segment === "\n" || segment === "\r" || segment === "\r\n") return "<w:br/>";
      if (segment.length === 0) return "";
      return `<w:t xml:space="preserve">${xmlText(segment)}</w:t>`;
    })
    .join("");
  return `<w:r>${children}</w:r>`;
}

function tableXml(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const rowsXml = rows
    .map((cells) => {
      const source = cells.length === 0 ? [""] : cells;
      const cellsXml = source
        .map(
          (cell) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${cellXml(cell)}</w:tc>`,
        )
        .join("");
      return `<w:tr>${cellsXml}</w:tr>`;
    })
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>${rowsXml}</w:tbl>`;
}

/** A cell's line breaks become separate paragraphs, which is how Word stores them. */
function cellXml(cell: string): string {
  return cell
    .split(/\r\n|\n|\r/)
    .map((line) => paragraphXml(line, null))
    .join("");
}

function packageNewDocument(bodyContent: string, title: string | null): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    [CONTENT_TYPES_PART]: strToU8(contentTypesXml(title !== null)),
    "_rels/.rels": strToU8(packageRelationshipsXml(title !== null)),
    [DOCUMENT_PART]: strToU8(documentPartXml(bodyContent)),
    "word/_rels/document.xml.rels": strToU8(documentRelationshipsXml()),
    "word/styles.xml": strToU8(stylesPartXml()),
  };
  if (title !== null) {
    parts[CORE_PROPERTIES_PART] = strToU8(corePropertiesXml(title));
    parts[EXTENDED_PROPERTIES_PART] = strToU8(extendedPropertiesXml());
  }
  return zipSync(parts);
}

function contentTypesXml(withProperties: boolean): string {
  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
  ];
  if (withProperties) {
    overrides.push(
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    );
  }
  return `${XML_DECLARATION}<Types xmlns="${CONTENT_TYPES_NAMESPACE}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`;
}

function packageRelationshipsXml(withProperties: boolean): string {
  const relationships = [
    `<Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="word/document.xml"/>`,
  ];
  if (withProperties) {
    relationships.push(
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
      `<Relationship Id="rId3" Type="${RELATIONSHIP_NAMESPACE}/extended-properties" Target="docProps/app.xml"/>`,
    );
  }
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}">${relationships.join("")}</Relationships>`;
}

function documentRelationshipsXml(): string {
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/styles" Target="styles.xml"/></Relationships>`;
}

function documentPartXml(bodyContent: string): string {
  const section =
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
  return `${XML_DECLARATION}<w:document xmlns:w="${WORD_NAMESPACE}" xmlns:r="${RELATIONSHIP_NAMESPACE}"><w:body>${bodyContent}${section}</w:body></w:document>`;
}

/** A heading is only a style reference until the package defines the style. */
function stylesPartXml(): string {
  const heading = (level: 1 | 2 | 3, size: number): string =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  return `${XML_DECLARATION}<w:styles xmlns:w="${WORD_NAMESPACE}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading(1, 32)}${heading(2, 28)}${heading(3, 26)}</w:styles>`;
}

function corePropertiesXml(title: string): string {
  return `${XML_DECLARATION}<cp:coreProperties xmlns:cp="${CORE_PROPERTIES_NAMESPACE}" xmlns:dc="${DC_NAMESPACE}"><dc:title>${xmlText(title)}</dc:title><dc:creator>${APP_NAME}</dc:creator><cp:lastModifiedBy>${APP_NAME}</cp:lastModifiedBy></cp:coreProperties>`;
}

function extendedPropertiesXml(): string {
  return `${XML_DECLARATION}<Properties xmlns="${EXTENDED_PROPERTIES_NAMESPACE}"><Application>${APP_NAME}</Application></Properties>`;
}

/**
 * The next markup tag at or after `from`. Comments, CDATA sections and
 * processing instructions are skipped. Attribute values are assumed not to
 * contain a raw `>` (Word escapes it), which is the one place this textual
 * scanner is narrower than the XML parser that already accepted the part.
 */
function nextTag(xml: string, from: number, limit: number): Tag | null {
  let cursor = from;
  while (cursor < limit) {
    const start = xml.indexOf("<", cursor);
    if (start === -1 || start >= limit) return null;
    if (xml.startsWith("<!--", start)) {
      const close = xml.indexOf("-->", start);
      if (close === -1) return null;
      cursor = close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", start)) {
      const close = xml.indexOf("]]>", start);
      if (close === -1) return null;
      cursor = close + 3;
      continue;
    }
    const end = xml.indexOf(">", start);
    if (end === -1 || end >= limit) return null;
    if (xml.startsWith("<?", start) || xml.startsWith("<!", start)) {
      cursor = end + 1;
      continue;
    }
    const raw = xml.slice(start + 1, end);
    const closing = raw.startsWith("/");
    const body = closing ? raw.slice(1) : raw;
    const selfClosing = body.endsWith("/");
    const name = (selfClosing ? body.slice(0, -1) : body).trim().split(/[\s/]/, 1)[0] ?? "";
    if (name.length === 0) {
      cursor = end + 1;
      continue;
    }
    const colon = name.indexOf(":");
    const localName = colon === -1 ? name : name.slice(colon + 1);
    return { localName, closing, selfClosing, start, end: end + 1 };
  }
  return null;
}

/** The range of the element that opens at `index`, or null if it never closes. */
function elementSpanAt(xml: string, index: number, limit: number): ElementSpan | null {
  const open = nextTag(xml, index, limit);
  if (open === null || open.start !== index || open.closing) return null;
  if (open.selfClosing) return { start: open.start, end: open.end };
  let depth = 1;
  let cursor = open.end;
  while (depth > 0) {
    const tag = nextTag(xml, cursor, limit);
    if (tag === null) return null;
    cursor = tag.end;
    if (tag.localName !== open.localName) continue;
    if (tag.closing) depth -= 1;
    else if (!tag.selfClosing) depth += 1;
  }
  return { start: open.start, end: cursor };
}

/** Every element with this local name in the range, in document order. */
function findElementSpans(xml: string, localName: string, from: number, to: number): ElementSpan[] {
  const spans: ElementSpan[] = [];
  let cursor = from;
  for (;;) {
    const tag = nextTag(xml, cursor, to);
    if (tag === null) return spans;
    cursor = tag.end;
    if (tag.closing || tag.localName !== localName) continue;
    const span = tag.selfClosing
      ? { start: tag.start, end: tag.end }
      : elementSpanAt(xml, tag.start, to);
    if (span !== null) spans.push(span);
    cursor = span === null ? tag.end : span.end;
  }
}

/**
 * The body's own `w:p` and `w:tbl` elements, in document order, using the same
 * nesting rule the reader uses: a paragraph inside a table belongs to the table.
 */
function topLevelItems(xml: string): BodyItem[] {
  const body = findElementSpans(xml, "body", 0, xml.length)[0];
  if (body === undefined) {
    throw new Error(
      "word/document.xml has no w:body element, so it is not a readable Word document.",
    );
  }
  const openingTag = nextTag(xml, body.start, body.end);
  const items: BodyItem[] = [];
  const open: { kind: "p" | "tbl"; start: number | null }[] = [];
  let cursor = openingTag === null ? body.end : openingTag.end;
  for (;;) {
    const tag = nextTag(xml, cursor, body.end);
    if (tag === null) return items;
    cursor = tag.end;
    if (tag.localName !== "p" && tag.localName !== "tbl") continue;
    const kind = tag.localName;
    if (tag.closing) {
      const frame = open.pop();
      if (frame !== undefined && frame.kind === kind && frame.start !== null) {
        items.push({ kind, start: frame.start, end: tag.end });
      }
      continue;
    }
    const topLevel = open.length === 0;
    if (tag.selfClosing) {
      if (topLevel) items.push({ kind, start: tag.start, end: tag.end });
      continue;
    }
    open.push({ kind, start: topLevel ? tag.start : null });
  }
}

/** The offset of the last element with this local name that opens before `before` - 1. */
function lastElementStart(xml: string, localName: string, before: number): number {
  let cursor = 0;
  let found = -1;
  for (;;) {
    const tag = nextTag(xml, cursor, before);
    if (tag === null) return found;
    cursor = tag.end;
    if (tag.closing || tag.localName !== localName) continue;
    found = tag.start;
    const span = tag.selfClosing ? null : elementSpanAt(xml, tag.start, before);
    if (span !== null) cursor = span.end;
  }
}
