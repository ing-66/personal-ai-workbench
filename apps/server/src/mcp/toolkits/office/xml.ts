import { DOMParser, type Document, type Element, type Node } from "@xmldom/xmldom";

/**
 * Small XML helpers for Office Open XML parts.
 *
 * OOXML is a ZIP of namespaced XML parts. These helpers deliberately do the
 * minimum a bounded inspector/editor needs: element lookup by local name (so a
 * part can be read without hard-coding its namespace prefix), text extraction,
 * and defensive escaping for the parts we generate. Anything richer belongs in a
 * real OOXML library; the toolkit's supported subset is documented in
 * `docs/spikes/PHASE4_REPORT.md`.
 */

const XML_PARSER_ERROR_HANDLER = {
  warning: () => {},
  error: () => {},
  fatalError: () => {},
} as const;

type XmlDocument = ReturnType<DOMParser["parseFromString"]>;

/**
 * Parses one OOXML part. A malformed part is an error the caller reports as a
 * structured tool failure rather than a crash inside the inspector.
 */
export function parseXmlPart(xml: string): XmlDocument {
  let parseFailed = false;
  const parser = new DOMParser({
    onError: () => {
      parseFailed = true;
    },
    locator: false,
  });
  const document = parser.parseFromString(xml, "text/xml");
  if (parseFailed) {
    throw new Error("The Office part is not well-formed XML.");
  }
  return document;
}

function elementsByLocalName(root: XmlDocument | Element, localName: string): Element[] {
  const found = (root as Document).getElementsByTagName("*") ?? [];
  const matches: Element[] = [];
  for (let index = 0; index < found.length; index += 1) {
    const element = found.item(index);
    if (element === null) continue;
    if (localNameName(element) === localName) matches.push(element as unknown as Element);
  }
  return matches;
}

function localNameName(element: { localName?: string | null; nodeName: string }): string {
  const local = element.localName;
  if (local !== undefined && local !== null && local.length > 0) return local;
  const name = element.nodeName;
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** All descendant elements whose local name matches, ignoring namespace prefixes. */
export const findElements = (root: XmlDocument | Element, localName: string): Element[] =>
  elementsByLocalName(root, localName);

/** Direct children only, which is what "text runs of this paragraph" needs. */
export function findChildElements(parent: Element, localName: string): Element[] {
  const matches: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);
    if (child === null || child.nodeType !== 1) continue;
    const element = child as unknown as Element;
    if (
      localNameName(element as unknown as { localName?: string | null; nodeName: string }) ===
      localName
    ) {
      matches.push(element);
    }
  }
  return matches;
}

/** Concatenated text of every descendant text node, in document order. */
export function textOf(element: Element): string {
  const parts: string[] = [];
  collectText(element as unknown as Node, parts);
  return parts.join("");
}

function collectText(node: Node, out: string[]): void {
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes.item(index);
    if (child === null) continue;
    if (child.nodeType === 3 || child.nodeType === 4) {
      out.push(child.nodeValue ?? "");
      continue;
    }
    if (child.nodeType === 1) collectText(child, out);
  }
}

/** Value of an unprefixed attribute, plus the `r:id` relationship form. */
export function attributeValue(element: Element, name: string): string | null {
  const direct = element.getAttribute(name);
  if (direct !== null && direct.length > 0) return direct;
  const namespaced = element.getAttribute(`r:${name}`) ?? element.getAttribute(`r:id`) ?? null;
  return namespaced !== null && namespaced.length > 0 ? namespaced : null;
}

const ENTITY_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escapes a value for use in generated element text or a quoted attribute. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ENTITY_ESCAPES[character] ?? character);
}

/**
 * Strips characters XML 1.0 cannot carry, so a value copied out of an untrusted
 * spreadsheet cannot produce a part that no reader can open.
 */
export function sanitizeXmlText(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,
    "",
  );
}

export function xmlText(value: string): string {
  return escapeXml(sanitizeXmlText(value));
}
