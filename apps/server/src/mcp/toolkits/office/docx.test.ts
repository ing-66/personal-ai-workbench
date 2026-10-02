import { describe, expect, it } from "@effect/vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { inspectDocx, writeDocx } from "./docx.ts";
import { parseXmlPart } from "./xml.ts";

const BOUNDS = { maxParagraphs: 100, maxTextChars: 100_000 };
const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>';
const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function parsesPart(content: Uint8Array): boolean {
  try {
    parseXmlPart(strFromU8(content));
    return true;
  } catch {
    return false;
  }
}

/**
 * The only independent structural check this machine has (no Office, no
 * LibreOffice): the package must re-open as a ZIP, hold well-formed XML, cover
 * every part with a content type, and contain the required parts.
 */
function expectValidPackage(
  bytes: Uint8Array,
  required: ReadonlyArray<string>,
): Record<string, Uint8Array> {
  const parts = unzipSync(bytes);
  const names = Object.keys(parts);
  expect(names.length).toBeGreaterThan(0);
  expect(names.includes("[Content_Types].xml")).toBe(true);

  const types = strFromU8(parts["[Content_Types].xml"] ?? new Uint8Array());
  const defaults = new Set(
    [...types.matchAll(/<Default Extension="([^"]+)"/g)].map((match) =>
      (match[1] ?? "").toLowerCase(),
    ),
  );
  const overrides = new Set(
    [...types.matchAll(/<Override PartName="([^"]+)"/g)].map((match) => match[1] ?? ""),
  );
  const uncovered = names.filter((name) => {
    const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    return !defaults.has(extension) && !overrides.has(`/${name}`);
  });
  expect(uncovered).toEqual([]);
  expect(required.filter((name) => parts[name] === undefined)).toEqual([]);
  expect(names.filter((name) => !parsesPart(parts[name] ?? new Uint8Array()))).toEqual([]);
  return parts;
}

describe("docx", () => {
  it("creates a document whose title and seed paragraphs re-open unchanged", () => {
    const bytes = writeDocx({
      existing: null,
      title: "Quarterly Report",
      seedParagraphs: ["First paragraph.", "Second paragraph."],
    });
    expectValidPackage(bytes, [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "docProps/core.xml",
      "docProps/app.xml",
    ]);

    const inspected = inspectDocx(bytes, BOUNDS);
    expect(inspected.paragraphs).toEqual([
      "Quarterly Report",
      "First paragraph.",
      "Second paragraph.",
    ]);
    expect(inspected.outline).toEqual(["Quarterly Report"]);
    expect(inspected.paragraphCount).toBe(3);
    expect(inspected.truncated).toBe(false);
    expect(inspected.tables).toEqual([]);
  });

  it("escapes generated text instead of interpolating it", () => {
    const hostile = 'Total <b>&</b> "net" > 0';
    const bytes = writeDocx({ existing: null, seedParagraphs: [hostile] });
    const inspected = inspectDocx(bytes, BOUNDS);
    expect(inspected.paragraphs).toEqual([hostile]);
  });

  it("appends a paragraph, keeping the old ones and the trailing section properties", () => {
    const first = writeDocx({ existing: null, title: "Doc", seedParagraphs: ["Alpha", "Beta"] });
    const second = writeDocx({
      existing: first,
      operation: { kind: "append-paragraph", text: "Gamma", headingLevel: 2 },
    });
    expectValidPackage(second, ["word/document.xml"]);

    const inspected = inspectDocx(second, BOUNDS);
    expect(inspected.paragraphs).toEqual(["Doc", "Alpha", "Beta", "Gamma"]);
    expect(inspected.outline).toEqual(["Doc", "Gamma"]);

    const documentXml = strFromU8(unzipSync(second)["word/document.xml"] ?? new Uint8Array());
    expect(documentXml.indexOf("Gamma")).toBeGreaterThan(documentXml.indexOf("Beta"));
    expect(documentXml.lastIndexOf("<w:sectPr")).toBeGreaterThan(documentXml.lastIndexOf("Gamma"));
    expect(documentXml.lastIndexOf("</w:body>")).toBeGreaterThan(
      documentXml.lastIndexOf("<w:sectPr"),
    );

    const untouched = unzipSync(first)["docProps/core.xml"];
    expect(strFromU8(unzipSync(second)["docProps/core.xml"] ?? new Uint8Array())).toBe(
      strFromU8(untouched ?? new Uint8Array()),
    );
  });

  it("appends a table without touching the paragraphs", () => {
    const first = writeDocx({ existing: null, seedParagraphs: ["Intro"] });
    const second = writeDocx({
      existing: first,
      operation: {
        kind: "append-table",
        rows: [
          ["A", "B"],
          ["C", "D"],
        ],
      },
    });
    expectValidPackage(second, ["word/document.xml"]);

    const inspected = inspectDocx(second, BOUNDS);
    // A cell is its own list of paragraph texts, so tables are table -> row -> cell lists.
    expect(inspected.tables).toEqual([
      [
        ["A", "B"],
        ["C", "D"],
      ],
    ]);
    expect(inspected.paragraphs).toEqual(["Intro"]);
  });

  it("replaces exactly the addressed paragraph", () => {
    const first = writeDocx({
      existing: null,
      title: "Doc",
      seedParagraphs: ["Alpha", "Beta", "Gamma"],
    });
    const second = writeDocx({
      existing: first,
      operation: { kind: "replace-paragraph", index: 2, text: "Beta rewritten" },
    });
    expectValidPackage(second, ["word/document.xml"]);

    const inspected = inspectDocx(second, BOUNDS);
    expect(inspected.paragraphs).toEqual(["Doc", "Alpha", "Beta rewritten", "Gamma"]);
    expect(inspected.paragraphCount).toBe(4);
    expect(inspected.outline).toEqual(["Doc"]);
  });

  it("keeps a replaced heading in the outline", () => {
    const first = writeDocx({ existing: null, title: "Old title", seedParagraphs: ["Body"] });
    const second = writeDocx({
      existing: first,
      operation: { kind: "replace-paragraph", index: 0, text: "New title" },
    });
    const inspected = inspectDocx(second, BOUNDS);
    expect(inspected.paragraphs).toEqual(["New title", "Body"]);
    expect(inspected.outline).toEqual(["New title"]);
  });

  it("refuses an index that is not in the document", () => {
    const doc = writeDocx({ existing: null, seedParagraphs: ["Only"] });
    expect(() =>
      writeDocx({ existing: doc, operation: { kind: "replace-paragraph", index: 7, text: "x" } }),
    ).toThrow(/no paragraph at index 7/);
  });

  it("caps a long document and reports the cap", () => {
    const seeds = Array.from({ length: 500 }, (_, index) => `Paragraph ${index + 1}`);
    const bytes = writeDocx({ existing: null, seedParagraphs: seeds });
    expectValidPackage(bytes, ["word/document.xml"]);

    const whole = inspectDocx(bytes, { maxParagraphs: 500, maxTextChars: 1_000_000 });
    expect(whole.paragraphs.length).toBe(500);
    expect(whole.paragraphCount).toBe(500);
    expect(whole.truncated).toBe(false);

    const capped = inspectDocx(bytes, { maxParagraphs: 100, maxTextChars: 1_000_000 });
    expect(capped.paragraphs.length).toBe(100);
    expect(capped.paragraphs[0]).toBe("Paragraph 1");
    expect(capped.paragraphs[99]).toBe("Paragraph 100");
    expect(capped.paragraphCount).toBe(500);
    expect(capped.truncated).toBe(true);

    const clipped = inspectDocx(bytes, { maxParagraphs: 500, maxTextChars: 20 });
    const returned = clipped.paragraphs.reduce((total, text) => total + text.length, 0);
    expect(returned).toBeLessThanOrEqual(20);
    expect(clipped.paragraphCount).toBe(500);
    expect(clipped.truncated).toBe(true);
  });

  it("reads a paragraph split across runs, with a tab, a break and a table", () => {
    const documentXml = `${'<?xml version="1.0"?>'}<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>wor</w:t><w:t>ld</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>again</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>One</w:t></w:r></w:p><w:p><w:r><w:t>Two</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const bytes = zipSync({
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "word/document.xml": strToU8(documentXml),
    });

    const inspected = inspectDocx(bytes, BOUNDS);
    expect(inspected.paragraphs).toEqual(["Hello \tworld\nagain"]);
    expect(inspected.tables).toEqual([[["One Two"]]]);
  });

  it("rejects input that is not a ZIP", () => {
    const junk = new TextEncoder().encode("this is not a docx");
    expect(() => inspectDocx(junk, BOUNDS)).toThrow(/not a readable ZIP archive/);
    expect(() => writeDocx({ existing: junk, operation: undefined })).toThrow(
      /not a readable ZIP archive/,
    );
  });

  it("reports a package without a document part", () => {
    const bytes = zipSync({ "hello.txt": strToU8("hi") });
    expect(() => inspectDocx(bytes, BOUNDS)).toThrow(/no word\/document\.xml part/);
  });

  it("reports a document part that is not well-formed XML", () => {
    const bytes = zipSync({
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "word/document.xml": strToU8(`<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>`),
    });
    expect(() => inspectDocx(bytes, BOUNDS)).toThrow(/well-formed/);
  });

  it("keeps numbering, styles and unrelated parts when editing a hand-built document", () => {
    const occurrences = (haystack: string, needle: string): number =>
      haystack.split(needle).length - 1;
    const documentXml = `${'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'}<w:document xmlns:w="${WORD_NAMESPACE}"><w:body><w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>Numbered item</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr><w:r><w:t>Quoted item</w:t></w:r></w:p><w:p><w:r><w:t>Plain paragraph</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
    const relationships = `${'<?xml version="1.0"?>'}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`;
    const existing = zipSync({
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "word/document.xml": strToU8(documentXml),
      "word/_rels/document.xml.rels": strToU8(relationships),
      "word/styles.xml": strToU8(
        `<w:styles xmlns:w="${WORD_NAMESPACE}"><w:style w:type="paragraph" w:styleId="Quote"/></w:styles>`,
      ),
      "word/numbering.xml": strToU8(
        `<w:numbering xmlns:w="${WORD_NAMESPACE}"><w:num w:numId="7"/></w:numbering>`,
      ),
      "word/media/image1.png": strToU8("not really a png"),
    });
    const untouched = unzipSync(existing);

    const appended = writeDocx({
      existing,
      operation: { kind: "append-paragraph", text: "Added line" },
    });
    const replaced = writeDocx({
      existing: appended,
      operation: { kind: "replace-paragraph", index: 0, text: "Numbered item, rewritten" },
    });

    const parts = unzipSync(replaced);
    const written = strFromU8(parts["word/document.xml"] ?? new Uint8Array());
    expect(inspectDocx(replaced, BOUNDS).paragraphs).toEqual([
      "Numbered item, rewritten",
      "Quoted item",
      "Plain paragraph",
      "Added line",
    ]);
    expect(occurrences(written, "<w:numPr>")).toBe(1);
    expect(occurrences(written, "<w:numId")).toBe(1);
    expect(occurrences(written, 'w:val="Quote"')).toBe(1);
    expect(written.lastIndexOf("<w:sectPr")).toBeGreaterThan(written.indexOf("Added line"));
    expect(strFromU8(parts["word/_rels/document.xml.rels"] ?? new Uint8Array())).toBe(
      strFromU8(untouched["word/_rels/document.xml.rels"] ?? new Uint8Array()),
    );
    expect(strFromU8(parts["word/numbering.xml"] ?? new Uint8Array())).toBe(
      strFromU8(untouched["word/numbering.xml"] ?? new Uint8Array()),
    );
    expect(strFromU8(parts["word/styles.xml"] ?? new Uint8Array())).toBe(
      strFromU8(untouched["word/styles.xml"] ?? new Uint8Array()),
    );
    expect(strFromU8(parts["word/media/image1.png"] ?? new Uint8Array())).toBe("not really a png");
  });
});
