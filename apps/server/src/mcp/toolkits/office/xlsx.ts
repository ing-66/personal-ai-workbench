import { unzipSync, zipSync } from "fflate";

import * as Xml from "./xml.ts";

/**
 * SpreadsheetML (.xlsx) support for the Office toolkit.
 *
 * Read: the sheet list and tab order from `xl/workbook.xml` joined to its
 * relationships, shared and inline strings, numbers, booleans, error cells and
 * formula results, plus bounded A1 range reads over sparse rows and columns.
 * Formulas are returned as text and are never evaluated here.
 *
 * Write: a minimal valid package for new workbooks, or in-place edits to an
 * existing one. An edit never rebuilds a part: the target worksheet is spliced
 * so that only the `<row>` and `<c>` elements the operation names change, plus
 * its `<dimension>` and only when that no longer covers the data. Column widths,
 * autofilters, merged cells, conditional formatting, data validations,
 * comments and anything else this module does not understand therefore survive,
 * and `[Content_Types].xml`, `xl/workbook.xml`, the rels, sibling sheets and
 * every other part are copied through untouched.
 *
 * Splicing by offsets is deliberate: re-serializing a parsed tree would
 * renormalize the whole part (attribute order, whitespace, entity forms), which
 * is a weaker guarantee than leaving untouched bytes untouched.
 *
 * Supported subset, on purpose: no VBA projects, no pivot tables, no charts,
 * no external links, no cell styling, no shared-formula resolution, and no
 * formula evaluation. Cells are written as inline strings or plain numbers.
 */

export interface XlsxInspectBounds {
  readonly maxSheets: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxCells: number;
  readonly maxTextChars: number;
}

export interface XlsxSheetSummary {
  readonly name: string;
  /** From the used range or `<dimension>`; 0 when the sheet's size is unknown. */
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface XlsxCell {
  /** Normalized address, for example `B3`. */
  readonly address: string;
  /** Cached value as text, `""` when the cell is empty. */
  readonly value: string;
  /** `=SUM(B2:B10)` when the cell holds a formula, otherwise null. */
  readonly formula: string | null;
}

export interface XlsxInspectResult {
  readonly sheets: ReadonlyArray<XlsxSheetSummary>;
  readonly sheet: string | null;
  /** The normalized A1 range actually returned, null when no cell was returned. */
  readonly range: string | null;
  readonly cells: ReadonlyArray<XlsxCell>;
  /** True when the bounds cut the sheet list, the range, or the returned text. */
  readonly truncated: boolean;
}

export type XlsxWriteOperation =
  | {
      readonly kind: "append-row";
      readonly sheet: string;
      readonly values: ReadonlyArray<string | number>;
    }
  | {
      readonly kind: "write-cells";
      readonly sheet: string;
      readonly cells: ReadonlyArray<{
        readonly address: string;
        readonly value?: string | number | undefined;
        readonly formula?: string | undefined;
      }>;
    }
  | { readonly kind: "add-sheet"; readonly sheet: string };

export interface XlsxWriteInput {
  /** An existing workbook to edit, or null to build a new one. */
  readonly existing: Uint8Array | null;
  readonly title?: string | undefined;
  readonly sheets?:
    | ReadonlyArray<{
        readonly name: string;
        readonly rows?: ReadonlyArray<ReadonlyArray<string | number>> | undefined;
      }>
    | undefined;
  readonly operation?: XlsxWriteOperation | undefined;
}

type PartMap = Record<string, Uint8Array>;

/** The element type the XML helpers take, so these signatures need no DOM lib. */
type XmlElement = Parameters<typeof Xml.findChildElements>[0];

const CONTENT_TYPES_PART = "[Content_Types].xml";
const ROOT_RELS_PART = "_rels/.rels";
const WORKBOOK_PART = "xl/workbook.xml";
const WORKBOOK_RELS_PART = "xl/_rels/workbook.xml.rels";
const SHARED_STRINGS_PART = "xl/sharedStrings.xml";
const STYLES_PART = "xl/styles.xml";
const CORE_PROPS_PART = "docProps/core.xml";
const APP_PROPS_PART = "docProps/app.xml";

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORKSHEET_REL_TYPE = `${DOC_REL_NS}/worksheet`;
const STYLES_REL_TYPE = `${DOC_REL_NS}/styles`;
const OFFICE_DOCUMENT_REL_TYPE = `${DOC_REL_NS}/officeDocument`;
const END_USER_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CORE_PROPS_REL_TYPE = `${END_USER_REL_NS}/metadata/core-properties`;
const APP_PROPS_REL_TYPE = `${DOC_REL_NS}/extended-properties`;
const WORKSHEET_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const WORKBOOK_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const STYLES_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml";
const CORE_PROPS_CONTENT_TYPE = "application/vnd.openxmlformats-package.core-properties+xml";
const APP_PROPS_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.extended-properties+xml";
const EXTENDED_PROPS_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
const CORE_PROPS_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DC_NS = "http://purl.org/dc/elements/1.1/";

/** Excel requires a styles part, and requires it to carry the default font and fills. */
const STYLES_XML =
  `${XML_DECL}\n<styleSheet xmlns="${SPREADSHEET_NS}">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

const APP_PROPS_XML = `${XML_DECL}\n<Properties xmlns="${EXTENDED_PROPS_NS}"><Application>T3 Code</Application></Properties>`;

/**
 * A fixed timestamp in epoch milliseconds (1980-07-01 UTC). fflate rejects DOS
 * dates outside 1980-2099, and a constant keeps the output deterministic.
 */
const ZIP_MTIME = 331344000000;

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

function toBytes(text: string): Uint8Array {
  return utf8.encode(text);
}

/**
 * Reads the ZIP container. Non-ZIP input is the common mistake, so it gets a
 * message that says what the caller actually passed.
 */
function openPackage(bytes: Uint8Array): PartMap {
  if (bytes.length === 0) throw new Error("This file is empty, so it is not a .xlsx workbook.");
  let parts: PartMap;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new Error("This file is not a .xlsx workbook: its ZIP container could not be read.");
  }
  if (Object.keys(parts).length === 0) {
    throw new Error("This file is not a .xlsx workbook: its ZIP container holds no parts.");
  }
  return parts;
}

function readPartText(parts: PartMap, part: string): string | null {
  const bytes = parts[part];
  return bytes === undefined ? null : utf8Decoder.decode(bytes);
}

function requirePartText(parts: PartMap, part: string, message: string): string {
  const text = readPartText(parts, part);
  if (text === null) throw new Error(message);
  return text;
}

function setTextPart(parts: PartMap, part: string, text: string): void {
  parts[part] = toBytes(text);
}

function parsePart(text: string, part: string): ReturnType<typeof Xml.parseXmlPart> {
  try {
    return Xml.parseXmlPart(text);
  } catch {
    throw new Error(`The workbook part ${part} is not well-formed XML.`);
  }
}

function columnLetters(column: number): string {
  let value = column;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters.length === 0 ? "A" : letters;
}

function columnIndex(letters: string): number {
  let value = 0;
  for (const character of letters.toUpperCase()) {
    value = value * 26 + (character.charCodeAt(0) - 64);
  }
  return value;
}

const CELL_ADDRESS = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/;
const COLUMN_ONLY = /^\$?([A-Za-z]{1,3})$/;

interface GridAddress {
  readonly row: number;
  readonly column: number;
}

function parseCellAddressSafe(address: string): GridAddress | null {
  const match = CELL_ADDRESS.exec(address.trim());
  if (match === null) return null;
  const letters = match[1];
  const digits = match[2];
  if (letters === undefined || digits === undefined) return null;
  const row = Number.parseInt(digits, 10);
  if (!Number.isInteger(row) || row < 1) return null;
  return { row, column: columnIndex(letters) };
}

function parseCellAddress(address: string): GridAddress {
  const parsed = parseCellAddressSafe(address);
  if (parsed === null) {
    throw new Error(`"${address}" is not a cell address. Use a form like A1 or C10.`);
  }
  return parsed;
}

interface SheetExtent {
  readonly minRow: number;
  readonly minColumn: number;
  readonly maxRow: number;
  readonly maxColumn: number;
}

const SINGLE_CELL_EXTENT: SheetExtent = { minRow: 1, minColumn: 1, maxRow: 1, maxColumn: 1 };

function extentFromRef(ref: string): SheetExtent | null {
  const [left, right] = ref.split(":");
  if (left === undefined) return null;
  const start = parseCellAddressSafe(left);
  if (start === null) return null;
  const end = right === undefined || right.length === 0 ? start : parseCellAddressSafe(right);
  if (end === null) return null;
  return {
    minRow: Math.min(start.row, end.row),
    minColumn: Math.min(start.column, end.column),
    maxRow: Math.max(start.row, end.row),
    maxColumn: Math.max(start.column, end.column),
  };
}

/** The range the part's own `<dimension>` element declares, when it has one. */
function declaredDimensionExtent(xml: string): SheetExtent | null {
  const dimension = /<dimension\b[^>]*\bref="([^"]*)"/.exec(xml);
  const ref = dimension?.[1];
  return ref === undefined || ref.length === 0 ? null : extentFromRef(ref);
}

/** The used range of the cells physically present in the part. */
function measuredExtentFromXml(xml: string): SheetExtent | null {
  let found: SheetExtent | null = null;
  const pattern = /\br="([A-Za-z]{1,3}\$?[0-9]{1,7})"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const address = match[1];
    if (address === undefined) continue;
    const parsed = parseCellAddressSafe(address);
    if (parsed === null) continue;
    found =
      found === null
        ? {
            minRow: parsed.row,
            minColumn: parsed.column,
            maxRow: parsed.row,
            maxColumn: parsed.column,
          }
        : {
            minRow: Math.min(found.minRow, parsed.row),
            minColumn: Math.min(found.minColumn, parsed.column),
            maxRow: Math.max(found.maxRow, parsed.row),
            maxColumn: Math.max(found.maxColumn, parsed.column),
          };
  }
  return found;
}

/**
 * The sheet's used range: `<dimension>` when the producer wrote one, otherwise
 * the min/max of the cell addresses actually present. Null when neither is
 * available, which callers report as an unknown size rather than as zero cells.
 */
function sheetExtentFromXml(xml: string): SheetExtent | null {
  const declared = declaredDimensionExtent(xml);
  return declared === null ? measuredExtentFromXml(xml) : declared;
}

/** True when `outer` already spans every cell of `inner`. */
function coversExtent(outer: SheetExtent | null, inner: SheetExtent): boolean {
  return (
    outer !== null &&
    outer.minRow <= inner.minRow &&
    outer.maxRow >= inner.maxRow &&
    outer.minColumn <= inner.minColumn &&
    outer.maxColumn >= inner.maxColumn
  );
}

function unionExtent(base: SheetExtent | null, extra: SheetExtent | null): SheetExtent | null {
  if (base === null) return extra;
  if (extra === null) return base;
  return {
    minRow: Math.min(base.minRow, extra.minRow),
    minColumn: Math.min(base.minColumn, extra.minColumn),
    maxRow: Math.max(base.maxRow, extra.maxRow),
    maxColumn: Math.max(base.maxColumn, extra.maxColumn),
  };
}

interface WorkbookSheet {
  readonly name: string;
  readonly part: string;
}

/** Resolves a relationship target (relative or package-absolute) to a part name. */
function resolvePartPath(baseDirectory: string, target: string): string {
  const segments = target.replace(/^\/+/, "").split("/");
  const resolved =
    target.startsWith("/") || baseDirectory.length === 0 ? [] : baseDirectory.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join("/");
}

function sharedStringTable(parts: PartMap): ReadonlyArray<string> {
  const text = readPartText(parts, SHARED_STRINGS_PART);
  if (text === null) return [];
  const document = parsePart(text, SHARED_STRINGS_PART);
  return Xml.findElements(document, "si").map((element) => Xml.textOf(element));
}

/**
 * Sheet tab order comes from the relationship ids in `xl/workbook.xml`, never
 * from the order of `xl/worksheets/*.xml`, which producers are free to differ
 * from (and Excel does after reordering or deleting tabs).
 */
function readWorkbook(parts: PartMap): {
  readonly sheets: ReadonlyArray<WorkbookSheet>;
  readonly sharedStrings: ReadonlyArray<string>;
} {
  const workbookXml = readPartText(parts, WORKBOOK_PART);
  if (workbookXml === null) {
    throw new Error("This workbook has no xl/workbook.xml part, so its sheets cannot be read.");
  }
  const workbook = parsePart(workbookXml, WORKBOOK_PART);
  const relsXml = readPartText(parts, WORKBOOK_RELS_PART);
  if (relsXml === null) {
    throw new Error(
      "This workbook has no xl/_rels/workbook.xml.rels part, so its sheet order cannot be resolved.",
    );
  }
  const relationships = parsePart(relsXml, WORKBOOK_RELS_PART);
  const targetsById = new Map<string, string>();
  for (const relationship of Xml.findElements(relationships, "Relationship")) {
    const id = relationship.getAttribute("Id");
    const target = relationship.getAttribute("Target");
    if (id === null || id.length === 0 || target === null || target.length === 0) continue;
    targetsById.set(id, resolvePartPath("xl", target));
  }

  const sheets: WorkbookSheet[] = [];
  for (const element of Xml.findElements(workbook, "sheet")) {
    const name = element.getAttribute("name");
    if (name === null || name.length === 0)
      throw new Error("xl/workbook.xml declares a sheet without a name.");
    const relationshipId = Xml.attributeValue(element, "id");
    const part = relationshipId === null ? undefined : targetsById.get(relationshipId);
    if (part === undefined) {
      throw new Error(`The worksheet "${name}" has no relationship in xl/_rels/workbook.xml.rels.`);
    }
    sheets.push({ name, part });
  }
  return { sheets, sharedStrings: sharedStringTable(parts) };
}

function firstChildText(element: XmlElement, localName: string): string {
  const child = Xml.findChildElements(element, localName)[0];
  return child === undefined ? "" : Xml.textOf(child);
}

function readCellValue(cell: XmlElement, sharedStrings: ReadonlyArray<string>): string {
  const type = cell.getAttribute("t") ?? "";
  const raw = firstChildText(cell, "v");
  if (type === "s") {
    const index = Number.parseInt(raw, 10);
    if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) return raw;
    return sharedStrings[index] ?? "";
  }
  if (type === "inlineStr") {
    const inline = Xml.findChildElements(cell, "is")[0];
    return inline === undefined ? "" : Xml.textOf(inline);
  }
  if (type === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
  return raw;
}

function readCellFormula(cell: XmlElement): string | null {
  const formula = Xml.findChildElements(cell, "f")[0];
  if (formula === undefined) return null;
  const text = Xml.textOf(formula).trim();
  return text.length === 0 ? null : `=${text}`;
}

/** Every cell of a sheet, keyed by normalized address, so sparse gaps stay gaps. */
function readSheetCells(
  xml: string,
  part: string,
  sharedStrings: ReadonlyArray<string>,
): Map<string, XlsxCell> {
  const document = parsePart(xml, part);
  const cells = new Map<string, XlsxCell>();
  let fallbackRow = 0;
  for (const row of Xml.findElements(document, "row")) {
    const rowAttribute = row.getAttribute("r");
    const declaredRow = rowAttribute === null ? Number.NaN : Number.parseInt(rowAttribute, 10);
    fallbackRow = Number.isInteger(declaredRow) && declaredRow > 0 ? declaredRow : fallbackRow + 1;
    let fallbackColumn = 0;
    for (const cell of Xml.findChildElements(row, "c")) {
      const addressAttribute = cell.getAttribute("r");
      const declared = addressAttribute === null ? null : parseCellAddressSafe(addressAttribute);
      // Cell addresses are authoritative: a cell may carry a row the element does not.
      const rowIndex = declared === null ? fallbackRow : declared.row;
      const column = declared === null ? fallbackColumn + 1 : declared.column;
      fallbackColumn = column;
      const address = `${columnLetters(column)}${rowIndex}`;
      if (cells.has(address)) continue;
      cells.set(address, {
        address,
        value: readCellValue(cell, sharedStrings),
        formula: readCellFormula(cell),
      });
    }
  }
  return cells;
}

interface ParsedRange {
  readonly startRow: number | null;
  readonly startColumn: number;
  readonly endRow: number | null;
  readonly endColumn: number;
}

/** Accepts `A1:C10`, `B2` and `A:C`; anything else is a caller mistake, not a guess. */
function parseRangeArgument(range: string): ParsedRange {
  const text = range.trim();
  if (text.length === 0) throw new Error("The range is empty. Pass a range like A1:C10.");
  const parts = text.split(":");
  if (parts.length > 2)
    throw new Error(`"${range}" is not a range. Pass a range like A1:C10 or A:C.`);
  const left = parts[0] ?? "";
  const right = parts.length === 2 ? (parts[1] ?? "") : null;
  if (right === null) {
    if (COLUMN_ONLY.test(left)) {
      return {
        startRow: null,
        startColumn: columnIndex(left),
        endRow: null,
        endColumn: columnIndex(left),
      };
    }
    const cell = parseCellAddress(left);
    return {
      startRow: cell.row,
      startColumn: cell.column,
      endRow: cell.row,
      endColumn: cell.column,
    };
  }
  if (COLUMN_ONLY.test(left) || COLUMN_ONLY.test(right)) {
    if (!COLUMN_ONLY.test(left) || !COLUMN_ONLY.test(right)) {
      throw new Error(`"${range}" mixes a cell and a column. Pass A1:C10 or A:C.`);
    }
    return {
      startRow: null,
      startColumn: Math.min(columnIndex(left), columnIndex(right)),
      endRow: null,
      endColumn: Math.max(columnIndex(left), columnIndex(right)),
    };
  }
  const start = parseCellAddress(left);
  const end = parseCellAddress(right);
  return {
    startRow: Math.min(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endRow: Math.max(start.row, end.row),
    endColumn: Math.max(start.column, end.column),
  };
}

/** A rectangle to walk. Unlike a sheet extent, both corners are always known. */
interface ResolvedRange {
  readonly startRow: number;
  readonly startColumn: number;
  readonly endRow: number;
  readonly endColumn: number;
}

function resolveRange(parsed: ParsedRange, extent: SheetExtent | null): ResolvedRange {
  const fallback = extent ?? SINGLE_CELL_EXTENT;
  return {
    startRow: parsed.startRow ?? fallback.minRow,
    startColumn: parsed.startColumn,
    endRow: parsed.endRow ?? fallback.maxRow,
    endColumn: parsed.endColumn,
  };
}

/** No range argument means the sheet's used range, or one cell when that is unknown. */
function defaultRange(extent: SheetExtent | null): ResolvedRange {
  const used = extent ?? SINGLE_CELL_EXTENT;
  return {
    startRow: used.minRow,
    startColumn: used.minColumn,
    endRow: used.maxRow,
    endColumn: used.maxColumn,
  };
}

/** The bounding box of the cells actually returned, which is what the caller sees. */
function formatRange(
  firstRow: number,
  firstColumn: number,
  lastRow: number,
  lastColumn: number,
): string {
  if (firstRow === lastRow && firstColumn === lastColumn)
    return `${columnLetters(firstColumn)}${firstRow}`;
  return `${columnLetters(firstColumn)}${firstRow}:${columnLetters(lastColumn)}${lastRow}`;
}

function describeSheets(sheets: ReadonlyArray<WorkbookSheet>): string {
  return sheets.length === 0 ? "no worksheets" : sheets.map((sheet) => sheet.name).join(", ");
}

/**
 * Bounded read of one sheet's used range, or of a requested A1 range.
 *
 * A range larger than the bounds is not an error: the visible slice is returned
 * with `truncated: true`, so an agent can page through a big sheet instead of
 * being refused.
 */
export function inspectXlsx(
  bytes: Uint8Array,
  bounds: XlsxInspectBounds,
  sheetName?: string,
  range?: string,
): XlsxInspectResult {
  const parts = openPackage(bytes);
  const workbook = readWorkbook(parts);
  if (workbook.sheets.length === 0) throw new Error("This workbook has no worksheets.");

  const maxSheets = Math.max(1, Math.floor(bounds.maxSheets));
  const maxRows = Math.max(1, Math.floor(bounds.maxRows));
  const maxColumns = Math.max(1, Math.floor(bounds.maxColumns));
  const maxCells = Math.max(1, Math.floor(bounds.maxCells));
  const maxTextChars = Math.max(1, Math.floor(bounds.maxTextChars));

  const summaries: XlsxSheetSummary[] = [];
  let truncated = workbook.sheets.length > maxSheets;
  for (const sheet of workbook.sheets.slice(0, maxSheets)) {
    const xml = readPartText(parts, sheet.part);
    const extent = xml === null ? null : sheetExtentFromXml(xml);
    summaries.push({
      name: sheet.name,
      rowCount: extent === null ? 0 : extent.maxRow - extent.minRow + 1,
      columnCount: extent === null ? 0 : extent.maxColumn - extent.minColumn + 1,
    });
  }

  const target =
    sheetName === undefined
      ? workbook.sheets[0]
      : workbook.sheets.find((sheet) => sheet.name === sheetName);
  if (target === undefined) {
    throw new Error(
      `Unknown worksheet "${sheetName ?? ""}". The workbook has: ${describeSheets(workbook.sheets)}.`,
    );
  }
  const targetXml = readPartText(parts, target.part);
  if (targetXml === null)
    throw new Error(`The worksheet "${target.name}" has no part (${target.part}).`);

  const extent = sheetExtentFromXml(targetXml);
  const requested =
    range === undefined ? defaultRange(extent) : resolveRange(parseRangeArgument(range), extent);
  const cells = readSheetCells(targetXml, target.part, workbook.sharedStrings);

  const requestedRows = requested.endRow - requested.startRow + 1;
  const requestedColumns = requested.endColumn - requested.startColumn + 1;
  const visibleRows = Math.min(requestedRows, maxRows);
  const visibleColumns = Math.min(requestedColumns, maxColumns);
  if (visibleRows < requestedRows || visibleColumns < requestedColumns) truncated = true;

  const returned: XlsxCell[] = [];
  let textChars = 0;
  let firstRow = 0;
  let firstColumn = 0;
  let lastRow = 0;
  let lastColumn = 0;
  let stopped = false;
  for (let row = requested.startRow; row < requested.startRow + visibleRows && !stopped; row += 1) {
    for (
      let column = requested.startColumn;
      column < requested.startColumn + visibleColumns;
      column += 1
    ) {
      if (returned.length >= maxCells) {
        truncated = true;
        stopped = true;
        break;
      }
      const address = `${columnLetters(column)}${row}`;
      const found = cells.get(address);
      let value = found === undefined ? "" : found.value;
      if (textChars + value.length > maxTextChars) {
        value = value.slice(0, Math.max(0, maxTextChars - textChars));
        truncated = true;
        stopped = true;
      }
      textChars += value.length;
      returned.push({ address, value, formula: found === undefined ? null : found.formula });
      // Row-major order, so the first cell sets the top-left and the widest cell the right edge.
      if (returned.length === 1) {
        firstRow = row;
        firstColumn = column;
      }
      lastRow = row;
      lastColumn = Math.max(lastColumn, column);
      if (stopped) break;
    }
  }

  return {
    sheets: summaries,
    sheet: target.name,
    range: returned.length === 0 ? null : formatRange(firstRow, firstColumn, lastRow, lastColumn),
    cells: returned,
    truncated,
  };
}

interface TagSpan {
  readonly start: number;
  readonly end: number;
  readonly selfClosing: boolean;
  readonly innerStart: number;
  readonly innerEnd: number;
  /** Raw attribute text between the element name and the tag end. */
  readonly attributes: string;
}

/**
 * Blanks out comments, CDATA sections and processing instructions, so markup that
 * only appears inside them can never be mistaken for a real element. Offsets are
 * preserved, so positions still index the original part.
 */
function maskIgnorable(xml: string): string {
  const regions: Array<{ readonly start: number; readonly end: number }> = [];
  const collect = (open: string, close: string): void => {
    let cursor = 0;
    while (cursor < xml.length) {
      const start = xml.indexOf(open, cursor);
      if (start === -1) break;
      const closeIndex = xml.indexOf(close, start + open.length);
      const end = closeIndex === -1 ? xml.length : closeIndex + close.length;
      regions.push({ start, end });
      cursor = end;
    }
  };
  collect("<!--", "-->");
  collect("<![CDATA[", "]]>");
  collect("<?", "?>");
  if (regions.length === 0) return xml;
  regions.sort((left, right) => left.start - right.start);
  let masked = "";
  let cursor = 0;
  for (const region of regions) {
    if (region.end <= cursor) continue;
    const start = Math.max(region.start, cursor);
    masked += `${xml.slice(cursor, start)}${" ".repeat(region.end - start)}`;
    cursor = region.end;
  }
  return masked + xml.slice(cursor);
}

/**
 * Top-level elements named `name` inside `[start, end)`. Never assumes nesting.
 * `search` is the masked copy of the part, used only for locating markup.
 */
function scanChildren(
  xml: string,
  search: string,
  start: number,
  end: number,
  name: string,
): TagSpan[] {
  const spans: TagSpan[] = [];
  const opening = `<${name}`;
  let cursor = start;
  while (cursor < end) {
    const index = search.indexOf(opening, cursor);
    if (index === -1 || index >= end) break;
    const following = search.charAt(index + opening.length);
    if (following !== "" && !/[\s/>]/.test(following)) {
      cursor = index + opening.length;
      continue;
    }
    const tagEnd = search.indexOf(">", index);
    if (tagEnd === -1 || tagEnd >= end) break;
    const selfClosing = search.charAt(tagEnd - 1) === "/";
    const attributes = xml.slice(index + opening.length, selfClosing ? tagEnd - 1 : tagEnd);
    if (selfClosing) {
      spans.push({
        start: index,
        end: tagEnd + 1,
        selfClosing: true,
        innerStart: tagEnd + 1,
        innerEnd: tagEnd + 1,
        attributes,
      });
      cursor = tagEnd + 1;
      continue;
    }
    const closing = `</${name}>`;
    const closeIndex = search.indexOf(closing, tagEnd);
    if (closeIndex === -1) break;
    spans.push({
      start: index,
      end: closeIndex + closing.length,
      selfClosing: false,
      innerStart: tagEnd + 1,
      innerEnd: closeIndex,
      attributes,
    });
    cursor = closeIndex + closing.length;
  }
  return spans;
}

function readTagAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|[\\s])${name}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match === null ? null : (match[1] ?? null);
}

function locateSheetData(xml: string, search: string): TagSpan {
  const span = scanChildren(xml, search, 0, xml.length, "sheetData")[0];
  if (span === undefined) {
    throw new Error("The worksheet has no <sheetData> element, so its cells cannot be edited.");
  }
  return span;
}

function dimensionElement(xml: string, search: string): TagSpan | null {
  return scanChildren(xml, search, 0, xml.length, "dimension")[0] ?? null;
}

function rootOpenTagEnd(xml: string): number {
  let index = xml.indexOf("<worksheet");
  if (index === -1) index = xml.indexOf("?>") + 2;
  const end = xml.indexOf(">", Math.max(0, index));
  return end === -1 ? xml.length : end + 1;
}

/** Rewrites `<dimension>` so consumers still see the sheet's used range. */
function withDimension(xml: string, extent: SheetExtent): string {
  const ref = `${columnLetters(extent.minColumn)}${extent.minRow}:${columnLetters(extent.maxColumn)}${extent.maxRow}`;
  const tag = `<dimension ref="${ref}"/>`;
  const existing = dimensionElement(xml, maskIgnorable(xml));
  if (existing !== null) return xml.slice(0, existing.start) + tag + xml.slice(existing.end);
  // Sheet properties, when present, must stay the first child of <worksheet>.
  const sheetProperties = xml.indexOf("</sheetPr>");
  const insertAt =
    sheetProperties === -1 ? rootOpenTagEnd(xml) : sheetProperties + "</sheetPr>".length;
  return xml.slice(0, insertAt) + tag + xml.slice(insertAt);
}

/** Adds a child to an element that may be written in either the open or self-closing form. */
function insertChild(xml: string, parentName: string, content: string): string {
  const closing = `</${parentName}>`;
  const closeIndex = xml.indexOf(closing);
  if (closeIndex !== -1) return xml.slice(0, closeIndex) + content + xml.slice(closeIndex);
  const selfClosing = new RegExp(`<${parentName}(\\s[^>]*)?/>`);
  const match = selfClosing.exec(xml);
  if (match === null)
    throw new Error(`The workbook part has no <${parentName}> element to extend.`);
  const attributes = match[1] ?? "";
  return (
    xml.slice(0, match.index) +
    `<${parentName}${attributes}>${content}</${parentName}>` +
    xml.slice(match.index + match[0].length)
  );
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Higher runs first when two edits share a position, which keeps columns ascending. */
  readonly order: number;
}

/**
 * Applies edits right-to-left so every offset still refers to the input string.
 * Ties are resolved by the larger end first (a replacement before an insertion
 * at the same position) and then by `order`.
 */
function applyEdits(xml: string, edits: ReadonlyArray<TextEdit>): string {
  const sorted = [...edits].sort(
    (left, right) => right.start - left.start || right.end - left.end || right.order - left.order,
  );
  let output = xml;
  for (const edit of sorted) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return output;
}

interface RowCell {
  readonly address: string;
  readonly column: number;
  readonly value?: string | number | undefined;
  readonly formula?: string | undefined;
}

/**
 * One cell element. Text becomes an inline string, numbers a plain value, and a
 * formula is stored without its leading `=` and with no cached `<v>`, because
 * this module never evaluates formulas.
 */
function renderCellXml(
  address: string,
  value: string | number | undefined,
  formula: string | undefined,
): string {
  if (formula !== undefined && formula.length > 0) {
    const expression = formula.startsWith("=") ? formula.slice(1) : formula;
    return expression.length === 0
      ? `<c r="${address}"/>`
      : `<c r="${address}"><f>${Xml.xmlText(expression)}</f></c>`;
  }
  if (value === undefined) return `<c r="${address}"/>`;
  if (typeof value === "number" && Number.isFinite(value))
    return `<c r="${address}"><v>${value}</v></c>`;
  return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${Xml.xmlText(String(value))}</t></is></c>`;
}

function renderRow(
  index: number,
  attributes: string | null,
  cells: ReadonlyArray<RowCell>,
): string {
  const attributesText =
    attributes !== null && readTagAttribute(attributes, "r") !== null
      ? attributes
      : ` r="${index}"`;
  return `<row${attributesText}>${cells.map((cell) => renderCellXml(cell.address, cell.value, cell.formula)).join("")}</row>`;
}

interface ScannedRow {
  readonly index: number;
  readonly span: TagSpan;
}

interface ScannedCell {
  readonly address: string;
  readonly column: number;
  readonly start: number;
  readonly end: number;
}

function scanRows(xml: string, search: string, sheetData: TagSpan): ScannedRow[] {
  const rows: ScannedRow[] = [];
  let fallback = 0;
  for (const span of scanChildren(xml, search, sheetData.innerStart, sheetData.innerEnd, "row")) {
    const declared = readTagAttribute(span.attributes, "r");
    const parsed = declared === null ? Number.NaN : Number.parseInt(declared, 10);
    fallback = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback + 1;
    rows.push({ index: fallback, span });
  }
  return rows;
}

function scanCells(xml: string, search: string, row: ScannedRow): ScannedCell[] {
  const cells: ScannedCell[] = [];
  let fallback = 0;
  for (const span of scanChildren(xml, search, row.span.innerStart, row.span.innerEnd, "c")) {
    const declared = readTagAttribute(span.attributes, "r");
    const parsed = declared === null ? null : parseCellAddressSafe(declared);
    const column = parsed === null ? fallback + 1 : parsed.column;
    fallback = column;
    const index = parsed === null ? row.index : parsed.row;
    cells.push({
      address: `${columnLetters(column)}${index}`,
      column,
      start: span.start,
      end: span.end,
    });
  }
  return cells;
}

function cellsExtent(row: number, cells: ReadonlyArray<RowCell>): SheetExtent | null {
  const first = cells[0];
  const last = cells[cells.length - 1];
  if (first === undefined || last === undefined) return null;
  return { minRow: row, maxRow: row, minColumn: first.column, maxColumn: last.column };
}

/**
 * Edits one worksheet part: only the cells (and `<dimension>`) named by the
 * operation change, so untouched cells keep their exact original bytes.
 */
function editWorksheetPart(xml: string, operation: XlsxWriteOperation): string {
  const search = maskIgnorable(xml);
  const declared = declaredDimensionExtent(xml);
  const sheetData = locateSheetData(xml, search);
  const rows = scanRows(xml, search, sheetData);
  let extent = sheetExtentFromXml(xml);
  const edits: TextEdit[] = [];

  if (operation.kind === "append-row") {
    const measured = measuredExtentFromXml(xml);
    const lastExisting = rows.reduce((highest, row) => Math.max(highest, row.index), 0);
    // After the last row that has content; a declared range may overstate it.
    const lastUsed = Math.max(lastExisting, measured === null ? 0 : measured.maxRow);
    const rowIndex = lastUsed + 1;
    const cells: RowCell[] = operation.values.map((value, position) => ({
      address: `${columnLetters(position + 1)}${rowIndex}`,
      column: position + 1,
      value,
      formula: undefined,
    }));
    edits.push({
      start: sheetData.innerEnd,
      end: sheetData.innerEnd,
      text: renderRow(rowIndex, null, cells),
      order: 0,
    });
    extent = unionExtent(extent, cellsExtent(rowIndex, cells));
  } else if (operation.kind === "write-cells") {
    const byRow = new Map<number, RowCell[]>();
    for (const request of operation.cells) {
      const parsed = parseCellAddress(request.address);
      const address = `${columnLetters(parsed.column)}${parsed.row}`;
      const list = byRow.get(parsed.row) ?? [];
      const entry: RowCell = {
        address,
        column: parsed.column,
        value: request.value,
        formula: request.formula,
      };
      const duplicate = list.findIndex((candidate) => candidate.address === address);
      if (duplicate === -1) list.push(entry);
      else list[duplicate] = entry;
      byRow.set(parsed.row, list);
    }
    for (const [rowIndex, list] of byRow) {
      list.sort((left, right) => left.column - right.column);
      const row = rows.find((candidate) => candidate.index === rowIndex);
      if (row === undefined) {
        const position =
          rows.find((candidate) => candidate.index > rowIndex)?.span.start ?? sheetData.innerEnd;
        edits.push({
          start: position,
          end: position,
          text: renderRow(rowIndex, null, list),
          order: rowIndex,
        });
      } else if (row.span.selfClosing) {
        edits.push({
          start: row.span.start,
          end: row.span.end,
          text: renderRow(rowIndex, row.span.attributes, list),
          order: 0,
        });
      } else {
        const existing = scanCells(xml, search, row);
        for (const entry of list) {
          const target = existing.find((cell) => cell.address === entry.address);
          const text = renderCellXml(entry.address, entry.value, entry.formula);
          if (target !== undefined) {
            edits.push({ start: target.start, end: target.end, text, order: entry.column });
            continue;
          }
          const position =
            existing.find((cell) => cell.column > entry.column)?.start ?? row.span.innerEnd;
          edits.push({ start: position, end: position, text, order: entry.column });
        }
      }
      extent = unionExtent(extent, cellsExtent(rowIndex, list));
    }
  } else {
    throw new Error("Adding a worksheet is handled by the package writer, not by a sheet edit.");
  }

  let updated = applyEdits(xml, edits);
  // Only fix <dimension> when it no longer covers the data, so an edit inside
  // the declared range leaves that element byte-identical.
  if (extent !== null && !coversExtent(declared, extent)) updated = withDimension(updated, extent);
  try {
    Xml.parseXmlPart(updated);
  } catch {
    throw new Error("The worksheet could not be updated: the result would not be well-formed XML.");
  }
  return updated;
}

function worksheetPartName(index: number): string {
  return `xl/worksheets/sheet${index}.xml`;
}

function buildWorksheetPart(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  const rowXml: string[] = [];
  let lastRow = 0;
  let lastColumn = 0;
  rows.forEach((values, position) => {
    if (values.length === 0) return;
    const rowIndex = position + 1;
    const cells: RowCell[] = values.map((value, column) => ({
      address: `${columnLetters(column + 1)}${rowIndex}`,
      column: column + 1,
      value,
      formula: undefined,
    }));
    lastRow = rowIndex;
    lastColumn = Math.max(lastColumn, cells.length);
    rowXml.push(renderRow(rowIndex, null, cells));
  });
  const dimension =
    lastRow === 0 ? "" : `<dimension ref="A1:${columnLetters(lastColumn)}${lastRow}"/>`;
  return (
    `${XML_DECL}\n<worksheet xmlns="${SPREADSHEET_NS}">${dimension}` +
    `<sheetData>${rowXml.join("")}</sheetData></worksheet>`
  );
}

function buildWorkbookXml(names: ReadonlyArray<string>): string {
  const sheets = names
    .map(
      (name, index) =>
        `<sheet name="${Xml.xmlText(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  return `${XML_DECL}\n<workbook xmlns="${SPREADSHEET_NS}" xmlns:r="${DOC_REL_NS}"><sheets>${sheets}</sheets></workbook>`;
}

function buildWorkbookRels(sheetCount: number): string {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="${WORKSHEET_REL_TYPE}" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  const styles = `<Relationship Id="rId${sheetCount + 1}" Type="${STYLES_REL_TYPE}" Target="styles.xml"/>`;
  return `${XML_DECL}\n<Relationships xmlns="${RELS_NS}">${sheets}${styles}</Relationships>`;
}

function buildContentTypes(sheetCount: number, withDocProps: boolean): string {
  const overrides = [
    `<Override PartName="/${WORKBOOK_PART}" ContentType="${WORKBOOK_CONTENT_TYPE}"/>`,
  ];
  for (let index = 1; index <= sheetCount; index += 1) {
    overrides.push(
      `<Override PartName="/${worksheetPartName(index)}" ContentType="${WORKSHEET_CONTENT_TYPE}"/>`,
    );
  }
  overrides.push(`<Override PartName="/${STYLES_PART}" ContentType="${STYLES_CONTENT_TYPE}"/>`);
  if (withDocProps) {
    overrides.push(
      `<Override PartName="/${CORE_PROPS_PART}" ContentType="${CORE_PROPS_CONTENT_TYPE}"/>`,
    );
    overrides.push(
      `<Override PartName="/${APP_PROPS_PART}" ContentType="${APP_PROPS_CONTENT_TYPE}"/>`,
    );
  }
  return (
    `${XML_DECL}\n<Types xmlns="${CONTENT_TYPES_NS}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>${overrides.join("")}</Types>`
  );
}

function buildRootRels(withDocProps: boolean): string {
  const document = `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_REL_TYPE}" Target="xl/workbook.xml"/>`;
  const docProps = withDocProps
    ? `<Relationship Id="rId2" Type="${CORE_PROPS_REL_TYPE}" Target="docProps/core.xml"/>` +
      `<Relationship Id="rId3" Type="${APP_PROPS_REL_TYPE}" Target="docProps/app.xml"/>`
    : "";
  return `${XML_DECL}\n<Relationships xmlns="${RELS_NS}">${document}${docProps}</Relationships>`;
}

function buildCoreProps(title: string): string {
  return (
    `${XML_DECL}\n<cp:coreProperties xmlns:cp="${CORE_PROPS_NS}" xmlns:dc="${DC_NS}">` +
    `<dc:title>${Xml.xmlText(title)}</dc:title></cp:coreProperties>`
  );
}

function maxDeclaredNumber(xml: string, pattern: RegExp): number {
  let highest = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(value) && value > highest) highest = value;
  }
  return highest;
}

function nextWorksheetPartName(parts: PartMap): string {
  let highest = 0;
  for (const part of Object.keys(parts)) {
    const match = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(part);
    if (match === null) continue;
    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(value) && value > highest) highest = value;
  }
  return worksheetPartName(highest + 1);
}

/** Excel's sheet-name rules, enforced before we write anything. */
function validateSheetName(name: string, existingNames: ReadonlyArray<string>): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("A worksheet needs a name.");
  if (trimmed.length > 31) {
    throw new Error(
      `The worksheet name "${trimmed}" is longer than the 31 characters Excel allows.`,
    );
  }
  if (/[\\/?*[\]:]/.test(trimmed)) {
    throw new Error(
      `The worksheet name "${trimmed}" contains a character Excel does not allow ( \\ / ? * [ ] : ).`,
    );
  }
  if (existingNames.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`The workbook already has a worksheet named "${trimmed}".`);
  }
  return trimmed;
}

function addSheet(parts: PartMap, name: string, existingNames: ReadonlyArray<string>): PartMap {
  const sheetName = validateSheetName(name, existingNames);
  const updated: PartMap = { ...parts };
  const partName = nextWorksheetPartName(parts);
  setTextPart(updated, partName, buildWorksheetPart([]));

  const workbookXml = requirePartText(
    parts,
    WORKBOOK_PART,
    "This workbook has no xl/workbook.xml part.",
  );
  const relsXml = requirePartText(
    parts,
    WORKBOOK_RELS_PART,
    "This workbook has no xl/_rels/workbook.xml.rels part, so a new sheet cannot be registered.",
  );
  const contentTypes = requirePartText(
    parts,
    CONTENT_TYPES_PART,
    "This workbook has no [Content_Types].xml part, so a new sheet cannot be declared.",
  );
  const sheetId = maxDeclaredNumber(workbookXml, /sheetId="(\d+)"/g) + 1;
  const relationshipId = `rId${maxDeclaredNumber(relsXml, /Id="rId(\d+)"/g) + 1}`;
  setTextPart(
    updated,
    WORKBOOK_PART,
    insertChild(
      workbookXml,
      "sheets",
      `<sheet name="${Xml.xmlText(sheetName)}" sheetId="${sheetId}" r:id="${relationshipId}"/>`,
    ),
  );
  setTextPart(
    updated,
    WORKBOOK_RELS_PART,
    insertChild(
      relsXml,
      "Relationships",
      `<Relationship Id="${relationshipId}" Type="${WORKSHEET_REL_TYPE}" Target="${partName.replace(/^xl\//, "")}"/>`,
    ),
  );
  setTextPart(
    updated,
    CONTENT_TYPES_PART,
    insertChild(
      contentTypes,
      "Types",
      `<Override PartName="/${partName}" ContentType="${WORKSHEET_CONTENT_TYPE}"/>`,
    ),
  );
  return updated;
}

function unknownSheetError(sheets: ReadonlyArray<WorkbookSheet>, name: string): Error {
  return new Error(`Unknown worksheet "${name}". The workbook has: ${describeSheets(sheets)}.`);
}

function createPackage(input: XlsxWriteInput): PartMap {
  const requested = input.sheets ?? [];
  const names: string[] = [];
  for (const sheet of requested) names.push(validateSheetName(sheet.name, names));
  if (names.length === 0) names.push("Sheet1");

  const parts: PartMap = {};
  names.forEach((name, index) => {
    setTextPart(
      parts,
      worksheetPartName(index + 1),
      buildWorksheetPart(requested[index]?.rows ?? []),
    );
  });
  setTextPart(parts, WORKBOOK_PART, buildWorkbookXml(names));
  setTextPart(parts, WORKBOOK_RELS_PART, buildWorkbookRels(names.length));
  setTextPart(
    parts,
    CONTENT_TYPES_PART,
    buildContentTypes(names.length, input.title !== undefined),
  );
  setTextPart(parts, STYLES_PART, STYLES_XML);
  setTextPart(parts, ROOT_RELS_PART, buildRootRels(input.title !== undefined));
  if (input.title !== undefined) {
    setTextPart(parts, CORE_PROPS_PART, buildCoreProps(input.title));
    setTextPart(parts, APP_PROPS_PART, APP_PROPS_XML);
  }
  return parts;
}

function applyOperation(parts: PartMap, operation: XlsxWriteOperation): PartMap {
  const workbook = readWorkbook(parts);
  if (operation.kind === "add-sheet") {
    return addSheet(
      parts,
      operation.sheet,
      workbook.sheets.map((sheet) => sheet.name),
    );
  }
  const sheet = workbook.sheets.find((candidate) => candidate.name === operation.sheet);
  if (sheet === undefined) throw unknownSheetError(workbook.sheets, operation.sheet);
  const xml = readPartText(parts, sheet.part);
  if (xml === null) throw new Error(`The worksheet "${sheet.name}" has no part (${sheet.part}).`);
  const updated: PartMap = { ...parts };
  setTextPart(updated, sheet.part, editWorksheetPart(xml, operation));
  return updated;
}

/**
 * Creates a workbook, or edits an existing one in place.
 *
 * Every part the operation does not name is copied through unchanged, so
 * untouched sheets keep their exact original bytes. Deterministic for a given
 * input: every ZIP entry carries the same fixed 1980 timestamp.
 */
export function writeXlsx(input: XlsxWriteInput): Uint8Array {
  const creating = input.existing === null;
  if (!creating && input.sheets !== undefined) {
    throw new Error(
      "sheets can only be given when creating a new workbook. Use operation to change an existing one.",
    );
  }

  let parts = creating ? createPackage(input) : openPackage(input.existing ?? new Uint8Array(0));
  if (input.operation !== undefined) {
    if (creating && input.operation.kind !== "add-sheet") {
      // A new workbook has no data to protect, so a named target sheet is created on demand.
      const workbook = readWorkbook(parts);
      if (!workbook.sheets.some((sheet) => sheet.name === input.operation?.sheet)) {
        parts = addSheet(
          parts,
          input.operation.sheet,
          workbook.sheets.map((sheet) => sheet.name),
        );
      }
    }
    parts = applyOperation(parts, input.operation);
  }
  return zipSync(parts, { mtime: ZIP_MTIME });
}
