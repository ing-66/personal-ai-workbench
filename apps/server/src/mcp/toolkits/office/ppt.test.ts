import { describe, expect, it } from "@effect/vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { inspectPptx, writePptx } from "./pptx.ts";
import { parseXmlPart } from "./xml.ts";

const BOUNDS = { maxSlides: 50, maxTextCharsPerSlide: 10_000 };

function partText(bytes: Uint8Array, name: string): string {
  return strFromU8(unzipSync(bytes)[name] ?? new Uint8Array());
}

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

const TWO_SLIDE_DECK = {
  existing: null,
  title: "Roadmap",
  seedSlides: [
    { title: "One", body: ["alpha", "beta"] },
    { title: "Two", body: ["gamma"] },
  ],
} as const;

describe("pptx", () => {
  it("creates a two-slide deck whose slides re-open in order", () => {
    const bytes = writePptx(TWO_SLIDE_DECK);
    expectValidPackage(bytes, [
      "[Content_Types].xml",
      "_rels/.rels",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "docProps/core.xml",
    ]);

    const inspected = inspectPptx(bytes, BOUNDS);
    expect(inspected.slideCount).toBe(2);
    expect(inspected.truncated).toBe(false);
    expect(inspected.slides.map((slide) => slide.index)).toEqual([1, 2]);
    expect(inspected.slides[0]).toEqual({ index: 1, title: "One", text: ["One", "alpha", "beta"] });
    expect(inspected.slides[1]).toEqual({ index: 2, title: "Two", text: ["Two", "gamma"] });
  });

  it("orders slides by the presentation's id list, not by part name", () => {
    const parts = unzipSync(writePptx(TWO_SLIDE_DECK));
    const presentation = strFromU8(parts["ppt/presentation.xml"] ?? new Uint8Array());
    const entries = [...presentation.matchAll(/<p:sldId [^>]*\/>/g)].map((match) => match[0]);
    expect(entries.length).toBe(2);
    const reordered = presentation
      .replace(/<p:sldId [^>]*\/>/g, "")
      .replace("</p:sldIdLst>", `${entries[1] ?? ""}${entries[0] ?? ""}</p:sldIdLst>`);
    expect(reordered).not.toBe(presentation);

    const swapped = zipSync({ ...parts, "ppt/presentation.xml": strToU8(reordered) });
    const inspected = inspectPptx(swapped, BOUNDS);
    expect(inspected.slideCount).toBe(2);
    expect(inspected.slides[0]?.title).toBe("Two");
    expect(inspected.slides[1]?.title).toBe("One");
  });

  it("adds a slide as the next slide, with a new id, part and relationship", () => {
    const first = writePptx(TWO_SLIDE_DECK);
    const added = writePptx({
      existing: first,
      operation: { kind: "add-slide", title: "Three", body: ["delta"] },
    });
    expectValidPackage(added, ["ppt/slides/slide3.xml", "ppt/slides/_rels/slide3.xml.rels"]);

    const inspected = inspectPptx(added, BOUNDS);
    expect(inspected.slideCount).toBe(3);
    expect(inspected.slides[2]).toEqual({ index: 3, title: "Three", text: ["Three", "delta"] });
    expect(inspected.slides[0]).toEqual({ index: 1, title: "One", text: ["One", "alpha", "beta"] });
    expect(inspected.slides[1]).toEqual({ index: 2, title: "Two", text: ["Two", "gamma"] });

    const presentation = partText(added, "ppt/presentation.xml");
    const ids = [...presentation.matchAll(/<p:sldId id="(\d+)"/g)].map((match) =>
      Number.parseInt(match[1] ?? "", 10),
    );
    expect(ids).toEqual([256, 257, 258]);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id >= 256)).toBe(true);

    const rels = partText(added, "ppt/_rels/presentation.xml.rels");
    expect(rels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide3.xml"',
    );
    expect(partText(added, "[Content_Types].xml")).toContain('PartName="/ppt/slides/slide3.xml"');
  });

  it("replaces one slide's text and leaves the other slides byte-identical", () => {
    const first = writePptx(TWO_SLIDE_DECK);
    const replaced = writePptx({
      existing: first,
      operation: {
        kind: "replace-slide-text",
        slideIndex: 2,
        title: "Two updated",
        body: ["gamma", "delta"],
      },
    });
    expectValidPackage(replaced, ["ppt/slides/slide2.xml"]);

    const inspected = inspectPptx(replaced, BOUNDS);
    expect(inspected.slideCount).toBe(2);
    expect(inspected.slides[0]).toEqual({ index: 1, title: "One", text: ["One", "alpha", "beta"] });
    expect(inspected.slides[1]).toEqual({
      index: 2,
      title: "Two updated",
      text: ["Two updated", "gamma", "delta"],
    });
    expect(partText(replaced, "ppt/slides/slide1.xml")).toBe(
      partText(first, "ppt/slides/slide1.xml"),
    );
    expect(partText(replaced, "ppt/presentation.xml")).toBe(
      partText(first, "ppt/presentation.xml"),
    );
  });

  it("leaves shapes it was not asked to change alone", () => {
    const parts = unzipSync(writePptx(TWO_SLIDE_DECK));
    const slide = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="4" name="Footnote"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Do not touch</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="5" name="Content Placeholder"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>old body</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    const custom = zipSync({ ...parts, "ppt/slides/slide1.xml": strToU8(slide) });
    expect(inspectPptx(custom, BOUNDS).slides[0]).toEqual({
      index: 1,
      title: "Do not touch",
      text: ["Do not touch", "old body"],
    });

    const replaced = writePptx({
      existing: custom,
      operation: { kind: "replace-slide-text", slideIndex: 1, body: ["new body"] },
    });
    expect(inspectPptx(replaced, BOUNDS).slides[0]).toEqual({
      index: 1,
      title: "Do not touch",
      text: ["Do not touch", "new body"],
    });
    expect(partText(replaced, "ppt/slides/slide2.xml")).toBe(
      partText(custom, "ppt/slides/slide2.xml"),
    );
  });

  it("caps slides and per-slide text", () => {
    const bytes = writePptx(TWO_SLIDE_DECK);

    const cappedSlides = inspectPptx(bytes, { maxSlides: 1, maxTextCharsPerSlide: 10_000 });
    expect(cappedSlides.slides.length).toBe(1);
    expect(cappedSlides.slideCount).toBe(2);
    expect(cappedSlides.truncated).toBe(true);

    const cappedText = inspectPptx(bytes, { maxSlides: 50, maxTextCharsPerSlide: 6 });
    expect(cappedText.slides.length).toBe(2);
    const returned =
      cappedText.slides[0]?.text.reduce((total, text) => total + text.length, 0) ?? 0;
    expect(returned).toBeLessThanOrEqual(6);
    expect(cappedText.truncated).toBe(true);

    expect(inspectPptx(bytes, BOUNDS).truncated).toBe(false);
  });

  it("rejects input that is not a ZIP", () => {
    const junk = new TextEncoder().encode("this is not a pptx");
    expect(() => inspectPptx(junk, BOUNDS)).toThrow(/not a readable ZIP archive/);
    expect(() => writePptx({ existing: junk })).toThrow(/not a readable ZIP archive/);
  });

  it("reports a package without a presentation part", () => {
    const bytes = zipSync({ "hello.txt": strToU8("hi") });
    expect(() => inspectPptx(bytes, BOUNDS)).toThrow(/no ppt\/presentation\.xml part/);
  });

  it("refuses a slide index that is not there", () => {
    const bytes = writePptx(TWO_SLIDE_DECK);
    expect(() =>
      writePptx({
        existing: bytes,
        operation: { kind: "replace-slide-text", slideIndex: 9, body: ["x"] },
      }),
    ).toThrow(/no slide 9/);
  });

  it("keeps a picture shape and unrelated parts when editing a hand-built slide", () => {
    const occurrences = (haystack: string, needle: string): number =>
      haystack.split(needle).length - 1;
    const picture =
      '<p:pic><p:nvPicPr><p:cNvPr id="9" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr/></p:pic>';
    const slide = `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>One</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>alpha</a:t></a:r></a:p></p:txBody></p:sp>${picture}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    const slideRelationships = `${'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`;
    const handBuilt = zipSync({
      ...unzipSync(writePptx(TWO_SLIDE_DECK)),
      "ppt/slides/slide1.xml": strToU8(slide),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(slideRelationships),
      "ppt/media/image1.png": strToU8("png bytes"),
    });
    const untouched = unzipSync(handBuilt);

    const added = writePptx({
      existing: handBuilt,
      operation: { kind: "add-slide", title: "Three", body: ["delta"] },
    });
    const replaced = writePptx({
      existing: added,
      operation: {
        kind: "replace-slide-text",
        slideIndex: 1,
        title: "One updated",
        body: ["alpha", "epsilon"],
      },
    });

    const inspected = inspectPptx(replaced, BOUNDS);
    expect(inspected.slideCount).toBe(3);
    expect(inspected.slides[0]).toEqual({
      index: 1,
      title: "One updated",
      text: ["One updated", "alpha", "epsilon"],
    });
    expect(inspected.slides[2]).toEqual({ index: 3, title: "Three", text: ["Three", "delta"] });

    const raw = partText(replaced, "ppt/slides/slide1.xml");
    expect(occurrences(raw, "<p:pic")).toBe(1);
    expect(occurrences(raw, 'r:embed="rId2"')).toBe(1);
    expect(partText(replaced, "ppt/slides/_rels/slide1.xml.rels")).toBe(
      strFromU8(untouched["ppt/slides/_rels/slide1.xml.rels"] ?? new Uint8Array()),
    );
    expect(partText(replaced, "ppt/slides/slide2.xml")).toBe(
      strFromU8(untouched["ppt/slides/slide2.xml"] ?? new Uint8Array()),
    );
    expect(strFromU8(unzipSync(replaced)["ppt/media/image1.png"] ?? new Uint8Array())).toBe(
      "png bytes",
    );
  });
});
