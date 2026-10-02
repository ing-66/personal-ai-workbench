import type { Element, Node } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { findChildElements, findElements, parseXmlPart, textOf, xmlText } from "./xml.ts";

/**
 * PresentationML (`.pptx`) support: a bounded slide inspector plus an editor
 * that appends a slide, or rewrites the text of one slide, without rebuilding
 * the package.
 *
 * Supported subset: slides made of text shapes (`p:sp` with a `p:txBody`), a
 * title placeholder and a body placeholder, reordered through the presentation's
 * slide id list. Animation, SmartArt, themes beyond the minimal one this module
 * writes, media and layout geometry are preserved verbatim but never edited.
 *
 * Slide order always comes from `ppt/presentation.xml`'s `p:sldIdLst` resolved
 * through `ppt/_rels/presentation.xml.rels`: part names are allocation order,
 * not slide order, and a deck that was reordered in PowerPoint proves it.
 */

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const CONTENT_TYPES_PART = "[Content_Types].xml";
const PRESENTATION_PART = "ppt/presentation.xml";
const PRESENTATION_RELS_PART = "ppt/_rels/presentation.xml.rels";
const RELATIONSHIPS_PART = "_rels/.rels";
const SLIDE_MASTER_PART = "ppt/slideMasters/slideMaster1.xml";
const SLIDE_LAYOUT_PART = "ppt/slideLayouts/slideLayout1.xml";
const THEME_PART = "ppt/theme/theme1.xml";
const CORE_PROPERTIES_PART = "docProps/core.xml";
const EXTENDED_PROPERTIES_PART = "docProps/app.xml";
const APP_NAME = "T3 Code";

const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const PACKAGE_RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const RELATIONSHIP_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const A_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P_NAMESPACE = "http://schemas.openxmlformats.org/presentationml/2006/main";
const CORE_PROPERTIES_NAMESPACE =
  "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
const DC_NAMESPACE = "http://purl.org/dc/elements/1.1/";
const EXTENDED_PROPERTIES_NAMESPACE =
  "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";

const PRESENTATION_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const SLIDE_MASTER_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml";
const SLIDE_LAYOUT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml";
const THEME_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.theme+xml";
const SLIDE_RELATIONSHIP_TYPE = `${RELATIONSHIP_NAMESPACE}/slide`;
const SLIDE_LAYOUT_RELATIONSHIP_TYPE = `${RELATIONSHIP_NAMESPACE}/slideLayout`;
const SLIDE_MASTER_RELATIONSHIP_TYPE = `${RELATIONSHIP_NAMESPACE}/slideMaster`;
const THEME_RELATIONSHIP_TYPE = `${RELATIONSHIP_NAMESPACE}/theme`;

/** The first slide id PowerPoint itself hands out. */
const FIRST_SLIDE_ID = 256;

const PREFIXES = { a: A_NAMESPACE, r: RELATIONSHIP_NAMESPACE, p: P_NAMESPACE } as const;

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
    throw new Error(
      "A part of this .pptx package is not well-formed XML, so its slides cannot be read or edited.",
    );
  }
}

/** How much of a deck the inspector may return. */
export interface PptxInspectBounds {
  readonly maxSlides: number;
  readonly maxTextCharsPerSlide: number;
}

/**
 * One slide, counted the way a human counts them: `index` is 1-based and
 * follows the presentation's slide order. `text` holds every non-empty text
 * paragraph on the slide in shape order, the title's included.
 */
export interface PptxSlideSummary {
  readonly index: number;
  readonly title: string | null;
  readonly text: ReadonlyArray<string>;
}

/** What the inspector can say about a deck. */
export interface PptxInspectResult {
  readonly slideCount: number;
  readonly slides: ReadonlyArray<PptxSlideSummary>;
  readonly truncated: boolean;
}

/**
 * The edits this module can make. `slideIndex` is 1-based, matching
 * `PptxSlideSummary.index` and therefore matching how a human counts slides.
 * A missing `title` or `body` leaves that text alone.
 */
export type PptxWriteOperation =
  | {
      readonly kind: "add-slide";
      readonly title?: string | undefined;
      readonly body?: ReadonlyArray<string> | undefined;
    }
  | {
      readonly kind: "replace-slide-text";
      readonly slideIndex: number;
      readonly title?: string | undefined;
      readonly body?: ReadonlyArray<string> | undefined;
    };

interface WritePptxInput {
  readonly existing: Uint8Array | null;
  readonly title?: string | undefined;
  readonly seedSlides?:
    | ReadonlyArray<{
        readonly title?: string | undefined;
        readonly body?: ReadonlyArray<string> | undefined;
      }>
    | undefined;
  readonly operation?: PptxWriteOperation | undefined;
}

interface ElementSpan {
  readonly start: number;
  readonly end: number;
}

interface Tag extends ElementSpan {
  readonly localName: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
}

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
}

interface TextShape {
  readonly isTitle: boolean;
  readonly paragraphs: string[];
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly xml: string;
}

/** Unpacks a `.pptx`, reporting a non-ZIP input as a readable error. */
function readPackage(bytes: Uint8Array): Record<string, Uint8Array> {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes);
  } catch {
    throw new Error("This is not a .pptx file: its package is not a readable ZIP archive.");
  }
  if (Object.keys(parts).length === 0) {
    throw new Error("This is not a .pptx file: its package is an empty ZIP archive.");
  }
  return parts;
}

/** One part's text, or a readable error naming the part that is missing. */
function requirePartText(parts: Record<string, Uint8Array>, name: string): string {
  const part = parts[name];
  if (part === undefined) {
    throw new Error(
      `This .pptx package has no ${name} part, so its slides cannot be read or edited.`,
    );
  }
  return strFromU8(part);
}

/** The local name of an element node, without its namespace prefix. */
function elementLocalName(node: Node): string {
  const local = node.localName;
  if (local !== null && local.length > 0) return local;
  const name = node.nodeName;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/**
 * The relationship id of a `p:sldId`, which is namespace-qualified (`r:id`)
 * even though the element also carries an unprefixed numeric `id`.
 */
function relationshipId(element: Element): string | null {
  const prefixed = element.getAttribute("r:id");
  if (prefixed !== null && prefixed.length > 0) return prefixed;
  const attributes = element.attributes;
  for (let index = 0; index < attributes.length; index += 1) {
    const attribute = attributes.item(index);
    if (attribute === null) continue;
    if (attribute.localName === "id" && attribute.namespaceURI === RELATIONSHIP_NAMESPACE) {
      return attribute.value;
    }
  }
  return null;
}

/** Resolves a relationship target against the directory of the part that owns it. */
function resolvePartName(baseDirectory: string, target: string): string {
  if (target.length === 0) return target;
  if (target.startsWith("/")) return target.slice(1);
  const segments = baseDirectory.length === 0 ? [] : baseDirectory.split("/");
  const resolved: string[] = [];
  for (const segment of [...segments, ...target.split("/")]) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join("/");
}

function readRelationships(document: XmlPart, baseDirectory: string): Relationship[] {
  const relationships: Relationship[] = [];
  for (const element of findElements(document, "Relationship")) {
    const id = element.getAttribute("Id");
    if (id === null || id.length === 0) continue;
    relationships.push({
      id,
      type: element.getAttribute("Type") ?? "",
      target: resolvePartName(baseDirectory, element.getAttribute("Target") ?? ""),
    });
  }
  return relationships;
}

function presentationRelationships(parts: Record<string, Uint8Array>): Relationship[] {
  return readRelationships(parsePart(requirePartText(parts, PRESENTATION_RELS_PART)), "ppt");
}

/**
 * Slide part names in slide order: the presentation's `p:sldIdLst` ids resolved
 * through its relationships. A slide part that no relationship points at is not
 * part of the deck as far as a reader - or PowerPoint - is concerned.
 */
function orderedSlidePartNames(parts: Record<string, Uint8Array>): string[] {
  const presentation = parsePart(requirePartText(parts, PRESENTATION_PART));
  const byId = new Map(
    presentationRelationships(parts).map((relationship) => [relationship.id, relationship.target]),
  );
  const ordered: string[] = [];
  for (const slideId of findElements(presentation, "sldId")) {
    const id = relationshipId(slideId);
    if (id === null) continue;
    const target = byId.get(id);
    if (target === undefined) continue;
    ordered.push(target);
  }
  return ordered;
}

/**
 * One paragraph's text: the `a:t` runs of a paragraph concatenated, with
 * `a:br` read as a newline.
 */
function paragraphText(paragraph: Element): string {
  const parts: string[] = [];
  collectRunText(paragraph as unknown as Node, parts);
  return parts.join("");
}

function collectRunText(node: Node, out: string[]): void {
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index);
    if (child === null || child.nodeType !== 1) continue;
    const name = elementLocalName(child);
    if (name === "t") {
      out.push(textOf(child as unknown as Element));
      continue;
    }
    if (name === "br") {
      out.push("\n");
      continue;
    }
    if (name === "pPr" || name === "rPr" || name === "endParaRPr") continue;
    collectRunText(child, out);
  }
}

function hasTitlePlaceholder(shape: Element): boolean {
  const placeholder = findElements(shape, "ph")[0];
  if (placeholder === undefined) return false;
  const type = placeholder.getAttribute("type");
  return type === "title" || type === "ctrTitle";
}

/**
 * A content placeholder. An absent `type` with an `idx` is a body placeholder
 * too: that is how a layout numbers several content placeholders.
 */
function isBodyPlaceholder(shape: Element): boolean {
  const placeholder = findElements(shape, "ph")[0];
  if (placeholder === undefined) return false;
  const type = placeholder.getAttribute("type");
  if (type === "body" || type === "obj" || type === "subTitle" || type === "content") return true;
  return (type === null || type.length === 0) && placeholder.getAttribute("idx") !== null;
}

function textBodyOf(shape: Element): Element | null {
  return findElements(shape, "txBody")[0] ?? null;
}

/** The text shapes on a slide, in shape order, each with its own paragraphs. */
function slideTextShapes(document: XmlPart): TextShape[] {
  return findElements(document, "sp").map((shape) => {
    const textBody = textBodyOf(shape);
    const paragraphs =
      textBody === null
        ? []
        : findChildElements(textBody, "p")
            .map((paragraph) => paragraphText(paragraph))
            .filter((text) => text.trim().length > 0);
    return { isTitle: hasTitlePlaceholder(shape), paragraphs };
  });
}

/** Keeps at most `maxChars` characters of text, reporting whether it had to cut. */
function capTexts(
  texts: ReadonlyArray<string>,
  maxChars: number,
): { texts: string[]; truncated: boolean } {
  const kept: string[] = [];
  let characters = 0;
  for (const text of texts) {
    const remaining = maxChars - characters;
    if (remaining <= 0) return { texts: kept, truncated: true };
    if (text.length > remaining) {
      kept.push(text.slice(0, remaining));
      return { texts: kept, truncated: true };
    }
    kept.push(text);
    characters += text.length;
  }
  return { texts: kept, truncated: false };
}

/**
 * What a reader is told about a deck. `slideCount` is the length of the
 * presentation's slide order, so it counts the slides PowerPoint would show.
 * The title is the first title placeholder with text, falling back to the first
 * text on the slide and then to null.
 */
export function inspectPptx(bytes: Uint8Array, bounds: PptxInspectBounds): PptxInspectResult {
  const parts = readPackage(bytes);
  const slideNames = orderedSlidePartNames(parts);
  const slides: PptxSlideSummary[] = [];
  let truncated = false;
  for (let position = 0; position < slideNames.length; position += 1) {
    if (slides.length >= bounds.maxSlides) {
      truncated = true;
      break;
    }
    const name = slideNames[position];
    if (name === undefined) continue;
    const shapes = slideTextShapes(parsePart(requirePartText(parts, name)));
    const titleShape = shapes.find((shape) => shape.isTitle && shape.paragraphs.length > 0);
    const firstTextShape = shapes.find((shape) => shape.paragraphs.length > 0);
    const capped = capTexts(
      shapes.flatMap((shape) => shape.paragraphs),
      bounds.maxTextCharsPerSlide,
    );
    if (capped.truncated) truncated = true;
    slides.push({
      index: position + 1,
      title: titleShape?.paragraphs[0] ?? firstTextShape?.paragraphs[0] ?? null,
      text: capped.texts,
    });
  }
  return { slideCount: slideNames.length, slides, truncated };
}

/**
 * Builds a `.pptx` and applies one optional edit to it. With `existing` set,
 * every part that the edit does not touch is carried over byte for byte, and
 * `title` only applies to a brand-new package.
 */
export function writePptx(input: WritePptxInput): Uint8Array {
  const parts = input.existing === null ? newDeckParts(input) : readPackage(input.existing);
  const operation = input.operation;
  if (operation !== undefined) applyOperation(parts, operation);
  return zipSync(parts);
}

function applyOperation(parts: Record<string, Uint8Array>, operation: PptxWriteOperation): void {
  const slideNames = orderedSlidePartNames(parts);
  if (operation.kind === "add-slide") {
    addSlide(parts, operation);
    return;
  }
  const target = slideNames[operation.slideIndex - 1];
  if (target === undefined) {
    throw new Error(
      `This presentation has no slide ${operation.slideIndex}; it has ${slideNames.length} slide(s).`,
    );
  }
  replaceSlideText(parts, target, operation);
}

/**
 * Appends a slide: a new part name, a new content-type override, a new
 * presentation relationship, and a new `p:sldId` with an unused id. The id is
 * `>= 256` because that is the range PowerPoint itself allocates from.
 */
function addSlide(
  parts: Record<string, Uint8Array>,
  operation: Extract<PptxWriteOperation, { kind: "add-slide" }>,
): void {
  const presentationXmlText = requirePartText(parts, PRESENTATION_PART);
  const relsXmlText = requirePartText(parts, PRESENTATION_RELS_PART);
  const presentation = parsePart(presentationXmlText);
  const relationships = findElements(parsePart(relsXmlText), "Relationship");

  const relId = `rId${Math.max(0, ...relationships.map((relationship) => relNumber(relationship.getAttribute("Id")))) + 1}`;
  const slideNumber = nextSlidePartNumber(parts);
  const partName = `ppt/slides/slide${slideNumber}.xml`;
  const layout = presentationRelationships(parts).find(
    (relationship) => relationship.type === SLIDE_LAYOUT_RELATIONSHIP_TYPE,
  );
  const layoutTarget =
    layout === undefined || !layout.target.startsWith("ppt/")
      ? "../slideLayouts/slideLayout1.xml"
      : `../${layout.target.slice("ppt/".length)}`;

  parts[partName] = strToU8(
    slidePartXml({ title: operation.title ?? null, body: operation.body ?? [] }),
  );
  parts[`ppt/slides/_rels/slide${slideNumber}.xml.rels`] = strToU8(
    slideRelationshipsXml(layoutTarget),
  );
  parts[PRESENTATION_PART] = strToU8(
    insertSlideId(presentationXmlText, nextSlideId(presentation), relId),
  );
  parts[PRESENTATION_RELS_PART] = strToU8(
    insertPresentationRelationship(relsXmlText, relId, `slides/slide${slideNumber}.xml`),
  );
  parts[CONTENT_TYPES_PART] = strToU8(
    insertContentTypeOverride(
      requirePartText(parts, CONTENT_TYPES_PART),
      partName,
      SLIDE_CONTENT_TYPE,
    ),
  );
}

function relNumber(id: string | null): number {
  if (id === null) return 0;
  const digits = Number.parseInt(id.replace(/^rId/, ""), 10);
  return Number.isNaN(digits) ? 0 : digits;
}

function nextSlidePartNumber(parts: Record<string, Uint8Array>): number {
  let highest = 0;
  for (const name of Object.keys(parts)) {
    const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    if (match === null) continue;
    const number = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isNaN(number) && number > highest) highest = number;
  }
  return highest + 1;
}

function nextSlideId(presentation: XmlPart): number {
  let highest = FIRST_SLIDE_ID - 1;
  for (const slideId of findElements(presentation, "sldId")) {
    const id = Number.parseInt(slideId.getAttribute("id") ?? "", 10);
    if (!Number.isNaN(id) && id > highest) highest = id;
  }
  return Math.max(highest + 1, FIRST_SLIDE_ID);
}

/**
 * Adds a `p:sldId`. The list is inserted where the schema expects it:
 * `p:sldIdLst` follows the master id lists and precedes `p:sldSz`, so a deck
 * whose presentation part has no list at all stays schema-valid.
 */
function insertSlideId(presentationXmlText: string, id: number, relId: string): string {
  const entry = `<p:sldId id="${id}" r:id="${xmlText(relId)}"/>`;
  const span = findElementSpans(presentationXmlText, "sldIdLst", 0, presentationXmlText.length)[0];
  if (span !== undefined) {
    const element = presentationXmlText.slice(span.start, span.end);
    if (element.endsWith("/>")) {
      return (
        presentationXmlText.slice(0, span.start) +
        `<p:sldIdLst>${entry}</p:sldIdLst>` +
        presentationXmlText.slice(span.end)
      );
    }
    const close = presentationXmlText.lastIndexOf("</p:sldIdLst>", span.end);
    if (close === -1) {
      throw new Error(
        "ppt/presentation.xml has an unreadable p:sldIdLst element, so no slide was added.",
      );
    }
    return presentationXmlText.slice(0, close) + entry + presentationXmlText.slice(close);
  }
  const anchors = ["<p:sldSz", "<p:notesSz", "<p:defaultTextStyle", "</p:presentation>"];
  for (const anchor of anchors) {
    const at = presentationXmlText.indexOf(anchor);
    if (at === -1) continue;
    return (
      presentationXmlText.slice(0, at) +
      `<p:sldIdLst>${entry}</p:sldIdLst>` +
      presentationXmlText.slice(at)
    );
  }
  throw new Error("ppt/presentation.xml has no p:presentation element, so no slide was added.");
}

function insertPresentationRelationship(relsXmlText: string, id: string, target: string): string {
  const close = relsXmlText.lastIndexOf("</Relationships>");
  if (close === -1) {
    throw new Error("ppt/_rels/presentation.xml.rels is not a readable relationships part.");
  }
  const relationship = `<Relationship Id="${xmlText(id)}" Type="${SLIDE_RELATIONSHIP_TYPE}" Target="${xmlText(target)}"/>`;
  return relsXmlText.slice(0, close) + relationship + relsXmlText.slice(close);
}

function insertContentTypeOverride(
  typesXml: string,
  partName: string,
  contentType: string,
): string {
  const close = typesXml.lastIndexOf("</Types>");
  if (close === -1) {
    throw new Error("[Content_Types].xml is not a readable content-types part.");
  }
  const override = `<Override PartName="/${xmlText(partName)}" ContentType="${contentType}"/>`;
  return typesXml.slice(0, close) + override + typesXml.slice(close);
}

/**
 * Rewrites the text of one slide's title and body shapes, replacing only the
 * paragraph run of each `p:txBody` so body properties, other shapes and every
 * other part are preserved. A slide without the target shape gains one.
 */
function replaceSlideText(
  parts: Record<string, Uint8Array>,
  partName: string,
  operation: Extract<PptxWriteOperation, { kind: "replace-slide-text" }>,
): void {
  const slideXmlText = requirePartText(parts, partName);
  const document = parsePart(slideXmlText);
  const textBodies = findElements(document, "txBody");
  const spans = findElementSpans(slideXmlText, "txBody", 0, slideXmlText.length);
  if (textBodies.length !== spans.length) {
    throw new Error(`${partName} cannot be addressed safely, so it was left untouched.`);
  }
  const shapes = findElements(document, "sp");
  const edits: Edit[] = [];
  let nextShapeId =
    Math.max(
      1,
      ...findElements(document, "cNvPr").map(
        (element) => Number.parseInt(element.getAttribute("id") ?? "", 10) || 0,
      ),
    ) + 1;

  const addText = (
    shape: Element | undefined,
    texts: ReadonlyArray<string>,
    placeholder: string,
    name: string,
  ): void => {
    if (shape === undefined) {
      edits.push(
        shapeInsertion(slideXmlText, textShapeXml({ id: nextShapeId, name, placeholder, texts })),
      );
      nextShapeId += 1;
      return;
    }
    const textBody = textBodyOf(shape);
    const index = textBody === null ? -1 : textBodies.indexOf(textBody);
    const span = index === -1 ? undefined : spans[index];
    if (span === undefined) {
      throw new Error(`${partName} cannot be addressed safely, so it was left untouched.`);
    }
    const region = paragraphRegion(slideXmlText, span);
    edits.push({ start: region.start, end: region.end, xml: paragraphsXml(texts) });
  };

  if (operation.title !== undefined) {
    const titleShape = shapes.find((shape) => hasTitlePlaceholder(shape));
    addText(
      titleShape,
      operation.title.length === 0 ? [] : [operation.title],
      '<p:ph type="title"/>',
      "Title 1",
    );
  }
  if (operation.body !== undefined) {
    const bodyShape =
      shapes.find((shape) => isBodyPlaceholder(shape) && textBodyOf(shape) !== null) ??
      shapes.find((shape) => !hasTitlePlaceholder(shape) && textBodyOf(shape) !== null);
    addText(
      bodyShape,
      operation.body.filter((line) => line.length > 0),
      '<p:ph type="body" idx="1"/>',
      "Content Placeholder 2",
    );
  }

  edits.sort((left, right) => right.start - left.start);
  let updated = slideXmlText;
  for (const edit of edits) {
    updated = updated.slice(0, edit.start) + edit.xml + updated.slice(edit.end);
  }
  parts[partName] = strToU8(updated);
}

/** The paragraph run of a `p:txBody`: everything after its properties. */
function paragraphRegion(part: string, span: ElementSpan): ElementSpan {
  const close = part.lastIndexOf("</p:txBody>", span.end);
  const limit = close === -1 ? span.end : close;
  const first = findElementSpans(part, "p", span.start, limit)[0];
  if (first !== undefined) return { start: first.start, end: limit };
  let cursor = span.start;
  for (;;) {
    const tag = nextTag(part, cursor, limit);
    if (tag === null || tag.closing) return { start: limit, end: limit };
    cursor = tag.end;
    if (tag.localName === "bodyPr" || tag.localName === "lstStyle") continue;
    return { start: tag.start, end: limit };
  }
}

function shapeInsertion(slideXmlText: string, shapeXml: string): Edit {
  const close = slideXmlText.lastIndexOf("</p:spTree>");
  if (close === -1) {
    throw new Error("This slide has no p:spTree element, so it was left untouched.");
  }
  return { start: close, end: close, xml: shapeXml };
}

function paragraphsXml(texts: ReadonlyArray<string>): string {
  if (texts.length === 0) return "<a:p/>";
  return texts.map((text) => paragraphXml(text)).join("");
}

/** A paragraph per line, with `a:br` for a line break inside one paragraph. */
function paragraphXml(text: string): string {
  if (text.length === 0) return "<a:p/>";
  const children = text
    .split(/(\r\n|\n|\r)/)
    .map((segment) => {
      if (segment === "\n" || segment === "\r" || segment === "\r\n") return "<a:br/>";
      if (segment.length === 0) return "";
      return `<a:r><a:t>${xmlText(segment)}</a:t></a:r>`;
    })
    .join("");
  return `<a:p>${children}</a:p>`;
}

function textShapeXml(options: {
  readonly id: number;
  readonly name: string;
  readonly placeholder: string;
  readonly texts: ReadonlyArray<string>;
}): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${options.id}" name="${xmlText(options.name)}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${options.placeholder}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphsXml(options.texts)}</p:txBody></p:sp>`;
}

function slidePartXml(slide: { title: string | null; body: ReadonlyArray<string> }): string {
  const title = slide.title === null || slide.title.length === 0 ? [] : [slide.title];
  const body = slide.body.filter((line) => line.length > 0);
  const titleShape = textShapeXml({
    id: 2,
    name: "Title 1",
    placeholder: '<p:ph type="title"/>',
    texts: title,
  });
  const bodyShape = textShapeXml({
    id: 3,
    name: "Content Placeholder 2",
    placeholder: '<p:ph type="body" idx="1"/>',
    texts: body,
  });
  return `${XML_DECLARATION}<p:sld ${namespaceAttributes()}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${titleShape}${bodyShape}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function slideRelationshipsXml(layoutTarget: string): string {
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${SLIDE_LAYOUT_RELATIONSHIP_TYPE}" Target="${xmlText(layoutTarget)}"/></Relationships>`;
}

function namespaceAttributes(): string {
  return Object.entries(PREFIXES)
    .map(([prefix, namespace]) => `xmlns:${prefix}="${namespace}"`)
    .join(" ");
}

/**
 * A brand-new deck. A master and one title-and-content layout are not optional
 * decoration: PowerPoint refuses a package without them, so they are emitted
 * here rather than left to a repair prompt.
 */
function newDeckParts(input: WritePptxInput): Record<string, Uint8Array> {
  const seeds = input.seedSlides ?? [];
  const title = input.title !== undefined && input.title.trim().length > 0 ? input.title : null;
  const slideEntries = seeds
    .map((_, index) => `<p:sldId id="${FIRST_SLIDE_ID + index}" r:id="rId${index + 2}"/>`)
    .join("");
  const relsXml = [
    `<Relationship Id="rId1" Type="${SLIDE_MASTER_RELATIONSHIP_TYPE}" Target="slideMasters/slideMaster1.xml"/>`,
    ...seeds.map(
      (_, index) =>
        `<Relationship Id="rId${index + 2}" Type="${SLIDE_RELATIONSHIP_TYPE}" Target="slides/slide${index + 1}.xml"/>`,
    ),
  ].join("");

  const parts: Record<string, Uint8Array> = {
    [CONTENT_TYPES_PART]: strToU8(contentTypesXml(seeds.length, title !== null)),
    [RELATIONSHIPS_PART]: strToU8(packageRelationshipsXml(title !== null)),
    [PRESENTATION_PART]: strToU8(
      `${XML_DECLARATION}<p:presentation ${namespaceAttributes()} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst${slideEntries.length === 0 ? "/" : `>${slideEntries}</p:sldIdLst>`}<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    ),
    [PRESENTATION_RELS_PART]: strToU8(
      `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}">${relsXml}</Relationships>`,
    ),
    [SLIDE_MASTER_PART]: strToU8(slideMasterPartXml()),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(slideMasterRelationshipsXml()),
    [SLIDE_LAYOUT_PART]: strToU8(slideLayoutPartXml()),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(slideLayoutRelationshipsXml()),
    [THEME_PART]: strToU8(themePartXml()),
  };
  seeds.forEach((seed, index) => {
    parts[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      slidePartXml({ title: seed.title ?? null, body: seed.body ?? [] }),
    );
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = strToU8(
      slideRelationshipsXml("../slideLayouts/slideLayout1.xml"),
    );
  });
  if (title !== null) {
    parts[CORE_PROPERTIES_PART] = strToU8(corePropertiesXml(title));
    parts[EXTENDED_PROPERTIES_PART] = strToU8(extendedPropertiesXml());
  }
  return parts;
}

function contentTypesXml(slideCount: number, withProperties: boolean): string {
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="${PRESENTATION_CONTENT_TYPE}"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${SLIDE_MASTER_CONTENT_TYPE}"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${SLIDE_LAYOUT_CONTENT_TYPE}"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="${THEME_CONTENT_TYPE}"/>`,
  ];
  for (let index = 1; index <= slideCount; index += 1) {
    overrides.push(
      `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="${SLIDE_CONTENT_TYPE}"/>`,
    );
  }
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
    `<Relationship Id="rId1" Type="${RELATIONSHIP_NAMESPACE}/officeDocument" Target="ppt/presentation.xml"/>`,
  ];
  if (withProperties) {
    relationships.push(
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
      `<Relationship Id="rId3" Type="${RELATIONSHIP_NAMESPACE}/extended-properties" Target="docProps/app.xml"/>`,
    );
  }
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}">${relationships.join("")}</Relationships>`;
}

function slideMasterRelationshipsXml(): string {
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${SLIDE_LAYOUT_RELATIONSHIP_TYPE}" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${THEME_RELATIONSHIP_TYPE}" Target="../theme/theme1.xml"/></Relationships>`;
}

function slideLayoutRelationshipsXml(): string {
  return `${XML_DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIP_NAMESPACE}"><Relationship Id="rId1" Type="${SLIDE_MASTER_RELATIONSHIP_TYPE}" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
}

function slideMasterPartXml(): string {
  const colorMap =
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  const textStyles =
    '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>';
  return `${XML_DECLARATION}<p:sldMaster ${namespaceAttributes()}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld>${colorMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>${textStyles}</p:sldMaster>`;
}

function slideLayoutPartXml(): string {
  const title = textShapeXml({
    id: 2,
    name: "Title 1",
    placeholder: '<p:ph type="title"/>',
    texts: [],
  });
  const body = textShapeXml({
    id: 3,
    name: "Content Placeholder 2",
    placeholder: '<p:ph type="body" idx="1"/>',
    texts: [],
  });
  return `${XML_DECLARATION}<p:sldLayout ${namespaceAttributes()} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${title}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

/**
 * A minimal theme, referenced by the slide master. Without one PowerPoint
 * offers to repair the file, so it is part of the supported subset's package.
 */
function themePartXml(): string {
  const color = (name: string, value: string): string =>
    `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
  const colors = `<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>${color("dk2", "44546A")}${color("lt2", "E7E6E6")}${color("accent1", "4472C4")}${color("accent2", "ED7D31")}${color("accent3", "A5A5A5")}${color("accent4", "FFC000")}${color("accent5", "5B9BD5")}${color("accent6", "70AD47")}${color("hlink", "0563C1")}${color("folHlink", "954F72")}</a:clrScheme>`;
  const fonts =
    '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>';
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line =
    '<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>';
  const effect = "<a:effectStyle><a:effectLst/></a:effectStyle>";
  const format = `<a:fmtScheme name="Office"><a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst><a:lnStyleLst>${line}${line}${line}</a:lnStyleLst><a:effectStyleLst>${effect}${effect}${effect}</a:effectStyleLst><a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst></a:fmtScheme>`;
  return `${XML_DECLARATION}<a:theme xmlns:a="${A_NAMESPACE}" name="Office Theme"><a:themeElements>${colors}${fonts}${format}</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
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
 * contain a raw `>` (PowerPoint escapes it), which is the one place this
 * textual scanner is narrower than the XML parser that already accepted the
 * part.
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
