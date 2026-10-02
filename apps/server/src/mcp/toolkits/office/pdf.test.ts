import { describe, expect, it } from "@effect/vitest";
import { zlibSync } from "fflate";

import { createPdf, inspectPdf } from "./pdf.ts";

const BOUNDS = { maxPages: 50, maxTextCharsPerPage: 10000 };

/** One code unit per byte, so a fixture can hold binary stream bytes. */
const toBytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
};

const toBinaryString = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

interface FixtureOptions {
  readonly content?: string;
  readonly filter?: string;
  readonly withContents?: boolean;
}

/**
 * A hand-written one-page PDF. It carries no xref table on purpose: the
 * extractor scans `obj` … `endobj` directly and never trusts an xref.
 */
const fixturePdf = (options: FixtureOptions = {}): Uint8Array => {
  const content = options.content ?? "";
  const filter = options.filter === undefined ? "" : ` /Filter ${options.filter}`;
  const withContents = options.withContents !== false;
  const page = withContents
    ? "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>"
    : "<< /Type /Page /Parent 2 0 R >>";
  const parts = [
    "%PDF-1.4\n",
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>\nendobj\n",
    `3 0 obj\n${page}\nendobj\n`,
  ];
  if (withContents) {
    parts.push(
      `4 0 obj\n<< /Length ${content.length}${filter} >>\nstream\n${content}\nendstream\nendobj\n`,
    );
  }
  parts.push("trailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n");
  return toBytes(parts.join(""));
};

describe("pdf create and inspect", () => {
  it("round-trips two pages and the title", () => {
    const bytes = createPdf({
      title: "Quarterly report",
      pages: [
        { heading: "First", lines: ["alpha", "beta"] },
        { heading: "Second", lines: ["gamma"] },
      ],
    });

    const inspected = inspectPdf(bytes, BOUNDS);
    expect(inspected.pageCount).toBe(2);
    expect(inspected.title).toBe("Quarterly report");
    expect(inspected.pages).toEqual([
      { page: 1, text: "First\nalpha\nbeta" },
      { page: 2, text: "Second\ngamma" },
    ]);
    expect(inspected.truncated).toBe(false);
  });

  it("writes an xref table whose offsets point at the right objects", () => {
    const raw = toBinaryString(createPdf({ pages: [{ lines: ["one", "two"] }] }));
    expect(raw.startsWith("%PDF-1.4\n")).toBe(true);
    expect(raw).toContain("/MediaBox [ 0 0 612 792 ]");
    expect(raw).toContain("/BaseFont /Helvetica");
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);

    const offsets = [...raw.matchAll(/(\d{10}) 00000 n /g)].map((match) => Number(match[1]));
    expect(offsets).toHaveLength(5);
    for (const offset of offsets) expect(raw.slice(offset, offset + 20)).toMatch(/^\d+ 0 obj\n/);

    const startxref = /startxref\n(\d+)/.exec(raw);
    expect(startxref).not.toBeNull();
    expect(raw.slice(Number(startxref?.[1]), Number(startxref?.[1]) + 4)).toBe("xref");

    // Deterministic: no creation date, so the same input gives the same bytes.
    expect(createPdf({ pages: [{ lines: ["one", "two"] }] })).toEqual(
      createPdf({ pages: [{ lines: ["one", "two"] }] }),
    );
  });

  it("round-trips parens and backslashes", () => {
    const lines = ["parens (round) here", "backslash \\ here", "both (a) \\ (b)"];
    const inspected = inspectPdf(createPdf({ pages: [{ lines }] }), BOUNDS);
    expect(inspected.pages[0]?.text).toBe(lines.join("\n"));
  });

  it("wraps a long line and still round-trips every character", () => {
    const long = Array.from(
      { length: 20 },
      (_, index) => `segment-${String(index).padStart(2, "0")}`,
    ).join(" ");
    expect(long.length).toBeGreaterThan(90);

    const inspected = inspectPdf(createPdf({ pages: [{ lines: [long] }] }), BOUNDS);
    const text = inspected.pages[0]?.text ?? "";
    const wrapped = text.split("\n");
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join("")).toBe(long);
    expect(Math.max(...wrapped.map((line) => line.length))).toBeLessThanOrEqual(90);
  });

  it("rejects a file that is not a PDF", () => {
    expect(() => inspectPdf(toBytes("hello world"), BOUNDS)).toThrow("This file is not a PDF.");
    expect(() => inspectPdf(new Uint8Array(0), BOUNDS)).toThrow("This file is not a PDF.");
  });

  it("returns empty text instead of failing when a page has no readable text", () => {
    const noLines = inspectPdf(createPdf({ pages: [{ lines: [] }] }), BOUNDS);
    expect(noLines.pageCount).toBe(1);
    expect(noLines.pages).toEqual([{ page: 1, text: "" }]);

    const noContents = inspectPdf(fixturePdf({ withContents: false }), BOUNDS);
    expect(noContents.pageCount).toBe(1);
    expect(noContents.pages).toEqual([{ page: 1, text: "" }]);

    // A zlib header with no body cannot be inflated, so the page comes back empty.
    const undecodable = fixturePdf({
      content: String.fromCharCode(0x78, 0x9c),
      filter: "/FlateDecode",
    });
    const inspected = inspectPdf(undecodable, BOUNDS);
    expect(inspected.pageCount).toBe(1);
    expect(inspected.pages).toEqual([{ page: 1, text: "" }]);
  });

  it("applies bounds to the page list and to each page's text", () => {
    const twoPages = createPdf({ pages: [{ lines: ["alpha"] }, { lines: ["beta"] }] });

    const firstPageOnly = inspectPdf(twoPages, { maxPages: 1, maxTextCharsPerPage: 100 });
    expect(firstPageOnly.pageCount).toBe(2);
    expect(firstPageOnly.pages).toEqual([{ page: 1, text: "alpha" }]);
    expect(firstPageOnly.truncated).toBe(true);

    const cappedText = inspectPdf(twoPages, { maxPages: 50, maxTextCharsPerPage: 3 });
    expect(cappedText.pages).toEqual([
      { page: 1, text: "alp" },
      { page: 2, text: "bet" },
    ]);
    expect(cappedText.truncated).toBe(true);
  });

  it("reads TJ gaps, T* breaks and octal escapes out of a content stream", () => {
    const content = "BT /F1 12 Tf 14 TL 50 700 Td [(A) -200 (B) 50 (C)] TJ T* (\\101\\102) Tj ET";
    const inspected = inspectPdf(fixturePdf({ content }), BOUNDS);
    expect(inspected.pageCount).toBe(1);
    expect(inspected.pages).toEqual([{ page: 1, text: "A BC\nAB" }]);
  });

  it("inflates a FlateDecode content stream", () => {
    const content = "BT /F1 12 Tf 20 TL 50 700 Td (compressed) Tj ET";
    const deflated = zlibSync(new TextEncoder().encode(content));
    const fixture = fixturePdf({ content: toBinaryString(deflated), filter: "/FlateDecode" });
    const inspected = inspectPdf(fixture, BOUNDS);
    expect(inspected.pages).toEqual([{ page: 1, text: "compressed" }]);
  });
});
