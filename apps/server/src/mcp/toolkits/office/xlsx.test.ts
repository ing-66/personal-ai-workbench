import { describe, expect, it } from "@effect/vitest";
import { unzipSync, zipSync } from "fflate";

import * as Xml from "./xml.ts";
import { inspectXlsx, writeXlsx } from "./xlsx.ts";

const BOUNDS = {
  maxSheets: 20,
  maxRows: 1000,
  maxColumns: 100,
  maxCells: 20000,
  maxTextChars: 200000,
};

const DOC_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const WORKSHEET_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const WORKBOOK_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8").decode(bytes);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const partText = (bytes: Uint8Array, part: string): string => {
  const partBytes = unzipSync(bytes)[part];
  if (partBytes === undefined) throw new Error(`missing part ${part}`);
  return decode(partBytes);
};

const seedWorkbook = (): Uint8Array =>
  writeXlsx({
    existing: null,
    sheets: [
      {
        name: "Summary",
        rows: [
          ["Name", "Score"],
          ["Ada", 42],
          ["Grace", 7],
        ],
      },
      { name: "Detail", rows: [["Note"], ["kept"]] },
    ],
  });

const rendered = (bytes: Uint8Array, range: string, sheet?: string): ReadonlyArray<string> =>
  inspectXlsx(bytes, BOUNDS, sheet, range).cells.map((cell) => `${cell.address}=${cell.value}`);

describe("xlsx read and write", () => {
  it("round-trips sheet names and exact cell values", () => {
    const bytes = seedWorkbook();
    const inspected = inspectXlsx(bytes, BOUNDS, "Summary", "A1:B3");

    expect(inspected.sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Detail"]);
    expect(inspected.sheets[0]).toEqual({ name: "Summary", rowCount: 3, columnCount: 2 });
    expect(inspected.sheet).toBe("Summary");
    expect(inspected.range).toBe("A1:B3");
    expect(inspected.truncated).toBe(false);
    expect(inspected.cells.map((cell) => `${cell.address}=${cell.value}`)).toEqual([
      "A1=Name",
      "B1=Score",
      "A2=Ada",
      "B2=42",
      "A3=Grace",
      "B3=7",
    ]);
    expect(inspected.cells.every((cell) => cell.formula === null)).toBe(true);

    expect(rendered(bytes, "A1:B2", "Detail")).toEqual(["A1=Note", "B1=", "A2=kept", "B2="]);

    // No sheet name means the first tab in workbook order, not the first part.
    const firstTab = inspectXlsx(bytes, BOUNDS);
    expect(firstTab.sheet).toBe("Summary");
    expect(firstTab.range).toBe("A1:B3");
    expect(firstTab.cells).toHaveLength(6);
  });

  it("returns formulas as text with the leading equals sign", () => {
    const withFormula = writeXlsx({
      existing: seedWorkbook(),
      operation: {
        kind: "write-cells",
        sheet: "Summary",
        cells: [
          { address: "C2", formula: "=SUM(B2:B3)" },
          { address: "C3", formula: "SUM(B2:B3)" },
        ],
      },
    });

    const inspected = inspectXlsx(withFormula, BOUNDS, "Summary", "C2:C3");
    expect(inspected.cells).toEqual([
      { address: "C2", value: "", formula: "=SUM(B2:B3)" },
      { address: "C3", value: "", formula: "=SUM(B2:B3)" },
    ]);

    // Stored without the leading `=` and with no cached result.
    const sheet = partText(withFormula, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("<f>SUM(B2:B3)</f>");
    expect(sheet).not.toContain("<v>SUM");
  });

  it("appends a row without disturbing the rows that were already there", () => {
    const withFormula = writeXlsx({
      existing: seedWorkbook(),
      operation: {
        kind: "write-cells",
        sheet: "Summary",
        cells: [{ address: "C2", formula: "=SUM(B2:B3)" }],
      },
    });
    const appended = writeXlsx({
      existing: withFormula,
      operation: { kind: "append-row", sheet: "Summary", values: ["Total", "", 49] },
    });

    const inspected = inspectXlsx(appended, BOUNDS, "Summary", "A1:C4");
    expect(inspected.cells.map((cell) => `${cell.address}=${cell.value}`)).toEqual([
      "A1=Name",
      "B1=Score",
      "C1=",
      "A2=Ada",
      "B2=42",
      "C2=",
      "A3=Grace",
      "B3=7",
      "C3=",
      "A4=Total",
      "B4=",
      "C4=49",
    ]);
    expect(inspected.cells.find((cell) => cell.address === "C2")?.formula).toBe("=SUM(B2:B3)");
    expect(inspected.sheets[0]?.rowCount).toBe(4);
  });

  it("updates one existing cell and leaves its neighbours alone", () => {
    const updated = writeXlsx({
      existing: seedWorkbook(),
      operation: { kind: "write-cells", sheet: "Summary", cells: [{ address: "B3", value: 99 }] },
    });

    expect(rendered(updated, "A1:B3", "Summary")).toEqual([
      "A1=Name",
      "B1=Score",
      "A2=Ada",
      "B2=42",
      "A3=Grace",
      "B3=99",
    ]);
  });

  it("inserts missing cells in column order without duplicate addresses", () => {
    const sparse = writeXlsx({ existing: null, sheets: [{ name: "Sparse", rows: [["a"]] }] });
    const edited = writeXlsx({
      existing: sparse,
      operation: {
        kind: "write-cells",
        sheet: "Sparse",
        cells: [
          { address: "C1", value: "c" },
          { address: "B1", value: "b" },
        ],
      },
    });

    const sheet = partText(edited, "xl/worksheets/sheet1.xml");
    const addresses = [...sheet.matchAll(/<c r="([A-Z]+[0-9]+)"/g)].map((match) => match[1]);
    expect(addresses).toEqual(["A1", "B1", "C1"]);
    expect(rendered(edited, "A1:C1", "Sparse")).toEqual(["A1=a", "B1=b", "C1=c"]);
  });

  it("reads A1 ranges, single cells and whole columns", () => {
    const bytes = seedWorkbook();

    expect(rendered(bytes, "A1:B2", "Summary")).toEqual(["A1=Name", "B1=Score", "A2=Ada", "B2=42"]);

    const single = inspectXlsx(bytes, BOUNDS, "Summary", "B2");
    expect(single.range).toBe("B2");
    expect(single.cells).toEqual([{ address: "B2", value: "42", formula: null }]);

    const columns = inspectXlsx(bytes, BOUNDS, "Summary", "A:C");
    expect(columns.cells).toHaveLength(9);
    expect(columns.range).toBe("A1:C3");
    expect(columns.truncated).toBe(false);

    expect(() => inspectXlsx(bytes, BOUNDS, "Summary", "A1:B2:C3")).toThrow(/is not a range/);
    expect(() => inspectXlsx(bytes, BOUNDS, "Summary", "1:10")).toThrow(/is not a cell address/);
    expect(() => inspectXlsx(bytes, BOUNDS, "Summary", "A1:C")).toThrow(
      /mixes a cell and a column/,
    );
  });

  it("truncates an oversize read instead of failing it", () => {
    const rows = Array.from({ length: 5000 }, (_, index) => [index + 1, `row ${index + 1}`]);
    const big = writeXlsx({ existing: null, sheets: [{ name: "Big", rows }] });
    expect(inspectXlsx(big, BOUNDS, "Big", "A1:A1").sheets[0]).toEqual({
      name: "Big",
      rowCount: 5000,
      columnCount: 2,
    });

    const cappedRows = inspectXlsx(big, { ...BOUNDS, maxRows: 10 }, "Big", "A1:B5000");
    expect(cappedRows.truncated).toBe(true);
    expect(cappedRows.cells).toHaveLength(20);
    expect(cappedRows.range).toBe("A1:B10");
    expect(cappedRows.cells[19]).toEqual({ address: "B10", value: "row 10", formula: null });

    const cappedCells = inspectXlsx(big, { ...BOUNDS, maxCells: 3 }, "Big", "A1:B5000");
    expect(cappedCells.cells.map((cell) => cell.address)).toEqual(["A1", "B1", "A2"]);
    expect(cappedCells.range).toBe("A1:B2");
    expect(cappedCells.truncated).toBe(true);

    const cappedText = inspectXlsx(big, { ...BOUNDS, maxTextChars: 12 }, "Big", "A1:B3");
    expect(cappedText.cells.reduce((total, cell) => total + cell.value.length, 0)).toBe(12);
    expect(cappedText.truncated).toBe(true);
  });

  it("rejects unknown sheets, non-ZIP input and malformed names", () => {
    const bytes = seedWorkbook();
    expect(() => inspectXlsx(bytes, BOUNDS, "Missing")).toThrow(/Unknown worksheet "Missing"/);
    expect(() =>
      writeXlsx({
        existing: bytes,
        operation: { kind: "append-row", sheet: "Missing", values: ["x"] },
      }),
    ).toThrow(/Unknown worksheet "Missing"/);
    expect(() =>
      writeXlsx({
        existing: bytes,
        operation: { kind: "write-cells", sheet: "Missing", cells: [] },
      }),
    ).toThrow(/Unknown worksheet "Missing"/);

    const notAZip = encode("this is not a spreadsheet");
    expect(() => inspectXlsx(notAZip, BOUNDS)).toThrow(/not a .xlsx workbook/);
    expect(() =>
      writeXlsx({ existing: notAZip, operation: { kind: "add-sheet", sheet: "Extra" } }),
    ).toThrow(/not a .xlsx workbook/);

    expect(() => writeXlsx({ existing: null, sheets: [{ name: "a/b" }] })).toThrow(
      /Excel does not allow/,
    );
    expect(() =>
      writeXlsx({ existing: bytes, operation: { kind: "add-sheet", sheet: "summary" } }),
    ).toThrow(/already has a worksheet/);
    expect(() => writeXlsx({ existing: bytes, sheets: [{ name: "Extra" }] })).toThrow(
      /sheets can only be given when creating a new workbook/,
    );
  });

  it("resolves tab order from relationship ids, not part order", () => {
    // Hand-built fixture: the first tab ("Zeta") lives in sheet1.xml and the
    // second ("Alpha") in sheet2.xml, so part order and tab order disagree.
    const worksheet = (value: string): string =>
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${SPREADSHEET_NS}">` +
      `<dimension ref="A1:A1"/><sheetData><row r="1">` +
      `<c r="A1" t="inlineStr"><is><t>${value}</t></is></c></row></sheetData></worksheet>`;
    const workbook =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${SPREADSHEET_NS}" xmlns:r="${DOC_REL_NS}">` +
      '<sheets><sheet name="Zeta" sheetId="2" r:id="rId2"/><sheet name="Alpha" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const rels =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}">` +
      `<Relationship Id="rId1" Type="${DOC_REL_NS}/worksheet" Target="worksheets/sheet2.xml"/>` +
      `<Relationship Id="rId2" Type="${DOC_REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
    const fixture = zipSync(
      {
        "xl/workbook.xml": encode(workbook),
        "xl/_rels/workbook.xml.rels": encode(rels),
        "xl/worksheets/sheet1.xml": encode(worksheet("zeta")),
        "xl/worksheets/sheet2.xml": encode(worksheet("alpha")),
      },
      // Fixed timestamp, matching what writeXlsx uses for its own packages.
      { mtime: 331344000000 },
    );

    const inspected = inspectXlsx(fixture, BOUNDS);
    expect(inspected.sheets.map((sheet) => sheet.name)).toEqual(["Zeta", "Alpha"]);
    expect(inspected.sheet).toBe("Zeta");
    expect(inspected.cells[0]?.value).toBe("zeta");
    expect(rendered(fixture, "A1", "Alpha")).toEqual(["A1=alpha"]);

    // Writes resolve the sheet through the relationship too, and only touch that part.
    const appended = writeXlsx({
      existing: fixture,
      operation: { kind: "append-row", sheet: "Alpha", values: ["alpha-two"] },
    });
    expect(rendered(appended, "A1:A2", "Alpha")).toEqual(["A1=alpha", "A2=alpha-two"]);
    expect(rendered(appended, "A1:A2", "Zeta")).toEqual(["A1=zeta", "A2="]);
    expect(partText(appended, "xl/worksheets/sheet1.xml")).toBe(worksheet("zeta"));
  });

  it("adds a sheet to an existing workbook", () => {
    const bytes = writeXlsx({
      existing: seedWorkbook(),
      operation: { kind: "add-sheet", sheet: "Extra" },
    });
    const inspected = inspectXlsx(bytes, BOUNDS, "Extra", "A1");
    expect(inspected.sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Detail", "Extra"]);
    expect(inspected.cells).toEqual([{ address: "A1", value: "", formula: null }]);
    expect(rendered(bytes, "A1:A3", "Summary")).toEqual(["A1=Name", "A2=Ada", "A3=Grace"]);
    expect(unzipSync(bytes)["xl/worksheets/sheet3.xml"]).toBeInstanceOf(Uint8Array);
  });

  it("writes a package whose parts are all declared and well-formed", () => {
    const bytes = writeXlsx({
      existing: null,
      title: "Quarterly report",
      sheets: [{ name: "One", rows: [["x", 1]] }],
    });
    const parts = unzipSync(bytes);
    const names = Object.keys(parts);
    expect(names).toContain("[Content_Types].xml");
    expect(names).toContain("_rels/.rels");
    expect(names).toContain("xl/workbook.xml");
    expect(names).toContain("xl/_rels/workbook.xml.rels");
    expect(names).toContain("xl/styles.xml");
    expect(names).toContain("docProps/core.xml");
    expect(names).toContain("docProps/app.xml");

    const contentTypes = Xml.parseXmlPart(partText(bytes, "[Content_Types].xml"));
    const extensions = new Set(
      Xml.findElements(contentTypes, "Default").map((element) => element.getAttribute("Extension")),
    );
    const overrides = new Set(
      Xml.findElements(contentTypes, "Override").map((element) => element.getAttribute("PartName")),
    );
    for (const name of names) {
      const extension = name.slice(name.lastIndexOf(".") + 1);
      const declared = overrides.has(`/${name}`) || extensions.has(extension);
      expect(declared, `${name} is not declared in [Content_Types].xml`).toBe(true);
    }
    expect(overrides.has("/xl/worksheets/sheet1.xml")).toBe(true);
    expect(overrides.has("/xl/styles.xml")).toBe(true);
    expect(partText(bytes, "docProps/core.xml")).toContain("<dc:title>Quarterly report</dc:title>");

    for (const name of names) {
      expect(
        () => Xml.parseXmlPart(decode(parts[name] ?? new Uint8Array(0))),
        `${name} must parse`,
      ).not.toThrow();
    }

    // Same input, same parts (ZIP entries carry no timestamp).
    const again = writeXlsx({
      existing: null,
      title: "Quarterly report",
      sheets: [{ name: "One", rows: [["x", 1]] }],
    });
    expect(Object.keys(unzipSync(again))).toEqual(names);
    for (const name of names) expect(partText(again, name)).toBe(partText(bytes, name));
  });

  it("keeps every worksheet element and attribute it does not understand", () => {
    const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
    const rowsOf = (xml: string): string =>
      /<sheetData>([\s\S]*)<\/sheetData>/.exec(xml)?.[1] ?? "";
    const ROW_ONE =
      '<row r="1" spans="1:3" ht="21" customHeight="1">' +
      '<c r="A1" s="1" t="inlineStr"><is><t>Name</t></is></c>' +
      '<c r="B1" s="1" t="inlineStr"><is><t>Score</t></is></c></row>';
    const ROW_TWO_PREFIX = '<row r="2" spans="1:2"><c r="A2" t="inlineStr"><is><t>Ada</t></is></c>';
    const WORKSHEET = (rows: string, dimension: string): string =>
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<worksheet xmlns="${SPREADSHEET_NS}" xmlns:r="${DOC_REL_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac">` +
      '<sheetPr><tabColor rgb="FF00B0F0"/></sheetPr>' +
      `<dimension ref="${dimension}"/>` +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="B2" sqref="B2"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols><col min="1" max="1" width="24.7109375" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/></cols>' +
      `<sheetData>${rows}</sheetData>` +
      '<autoFilter ref="A1:B3"/>' +
      '<mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells>' +
      '<conditionalFormatting sqref="B2:B3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>10</formula></cfRule></conditionalFormatting>' +
      '<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="C1:C3"><formula1>"yes,no"</formula1></dataValidation></dataValidations>' +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      "</worksheet>\n";
    const UNTOUCHED = [
      '<sheetPr><tabColor rgb="FF00B0F0"/></sheetPr>',
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="B2" sqref="B2"/></sheetView></sheetViews>',
      '<sheetFormatPr defaultRowHeight="15"/>',
      '<cols><col min="1" max="1" width="24.7109375" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/></cols>',
      '<autoFilter ref="A1:B3"/>',
      '<mergeCells count="1"><mergeCell ref="D1:E1"/></mergeCells>',
      '<conditionalFormatting sqref="B2:B3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>10</formula></cfRule></conditionalFormatting>',
      '<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="C1:C3"><formula1>"yes,no"</formula1></dataValidation></dataValidations>',
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>',
      `xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac"`,
      ROW_ONE,
    ];

    const comments =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<authors><author>Ada</author></authors><commentList><comment ref="B2" authorId="0"><text><t>check</t></text></comment></commentList></comments>';
    const fixture = zipSync(
      {
        "[Content_Types].xml": encode(
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            `<Override PartName="/xl/workbook.xml" ContentType="${WORKBOOK_CONTENT_TYPE}"/>` +
            `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${WORKSHEET_CONTENT_TYPE}"/>` +
            '<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/></Types>',
        ),
        "xl/workbook.xml": encode(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${SPREADSHEET_NS}" xmlns:r="${DOC_REL_NS}">` +
            '<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
        "xl/_rels/workbook.xml.rels": encode(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}">` +
            `<Relationship Id="rId1" Type="${DOC_REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        ),
        "xl/worksheets/sheet1.xml": encode(
          WORKSHEET(
            ROW_ONE +
              '<row r="2" spans="1:2"><c r="A2" t="inlineStr"><is><t>Ada</t></is></c><c r="B2"><v>42</v></c></row>',
            "A1:B2",
          ),
        ),
        "xl/worksheets/_rels/sheet1.xml.rels": encode(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}">` +
            `<Relationship Id="rId1" Type="${DOC_REL_NS}/comments" Target="../comments1.xml"/></Relationships>`,
        ),
        "xl/comments1.xml": encode(comments),
      },
      // Fixed timestamp, matching what writeXlsx uses for its own packages.
      { mtime: 331344000000 },
    );
    const original = (part: string): string =>
      decode(unzipSync(fixture)[part] ?? new Uint8Array(0));
    const untouchedParts = [
      "[Content_Types].xml",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/_rels/sheet1.xml.rels",
      "xl/comments1.xml",
    ];

    // An edit inside the declared range leaves <dimension> alone.
    const inside = writeXlsx({
      existing: fixture,
      operation: { kind: "write-cells", sheet: "Data", cells: [{ address: "B2", value: 43 }] },
    });
    const insidePart = partText(inside, "xl/worksheets/sheet1.xml");
    expect(count(insidePart, '<dimension ref="A1:B2"/>')).toBe(1);
    expect(count(insidePart, "<dimension")).toBe(1);
    expect(count(insidePart, ROW_ONE)).toBe(1);
    expect(count(insidePart, ROW_TWO_PREFIX)).toBe(1);
    expect(count(insidePart, '<c r="B2"><v>43</v></c>')).toBe(1);

    // An edit that adds row 3 fixes the dimension and nothing else.
    const edited = writeXlsx({
      existing: inside,
      operation: {
        kind: "write-cells",
        sheet: "Data",
        cells: [
          { address: "C3", value: "Third" },
          { address: "A3", value: "Grace" },
          { address: "B3", value: 99 },
        ],
      },
    });
    const part = partText(edited, "xl/worksheets/sheet1.xml");
    const partBytes = unzipSync(edited)["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0);

    expect(() => Xml.parseXmlPart(part)).not.toThrow();
    expect(part.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(new TextDecoder("utf-8").decode(partBytes)).toBe(part);
    for (const fragment of UNTOUCHED) {
      expect(count(part, fragment), `${fragment} should survive exactly once`).toBe(1);
    }
    expect(count(part, ROW_TWO_PREFIX)).toBe(1);
    expect(count(part, '<c r="B2"><v>43</v></c>')).toBe(1);
    expect(count(part, '<dimension ref="A1:C3"/>')).toBe(1);
    expect(count(part, "<dimension")).toBe(1);

    // Rows stay ordered by @r and cells by column, with no duplicate addresses.
    expect([...part.matchAll(/<row r="(\d+)"/g)].map((match) => Number(match[1]))).toEqual([
      1, 2, 3,
    ]);
    const addresses = [...part.matchAll(/<c r="([A-Z]+[0-9]+)"/g)].map((match) => match[1]);
    expect(addresses).toEqual(["A1", "B1", "A2", "B2", "A3", "B3", "C3"]);
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(rendered(edited, "A1:C3", "Data")).toEqual([
      "A1=Name",
      "B1=Score",
      "C1=",
      "A2=Ada",
      "B2=43",
      "C2=",
      "A3=Grace",
      "B3=99",
      "C3=Third",
    ]);

    // The workbook, its rels, the sheet rels and the comments part are untouched.
    for (const name of untouchedParts) {
      expect(partText(edited, name), `${name} should be unchanged`).toBe(original(name));
    }

    // append-row goes after the last existing <row> and preserves all of them.
    const appended = writeXlsx({
      existing: edited,
      operation: { kind: "append-row", sheet: "Data", values: ["More", 7] },
    });
    const appendedPart = partText(appended, "xl/worksheets/sheet1.xml");
    expect([...appendedPart.matchAll(/<row r="(\d+)"/g)].map((match) => Number(match[1]))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(rowsOf(appendedPart).startsWith(rowsOf(part))).toBe(true);
    expect(count(appendedPart, '<autoFilter ref="A1:B3"/>')).toBe(1);
    expect(count(appendedPart, "<conditionalFormatting")).toBe(1);
    expect(count(appendedPart, "<cols>")).toBe(1);
    expect(rendered(appended, "A1:C4", "Data")[9]).toBe("A4=More");
    for (const name of untouchedParts) {
      expect(partText(appended, name), `${name} should still be unchanged`).toBe(original(name));
    }
  });

  it("writes text as inline strings, numbers as numeric cells, and re-reads them", () => {
    const written = writeXlsx({
      existing: writeXlsx({ existing: null, sheets: [{ name: "Types" }] }),
      operation: {
        kind: "write-cells",
        sheet: "Types",
        cells: [
          { address: "A1", value: "text value" },
          { address: "B1", value: 42 },
          { address: "C1", value: 3.5 },
          { address: "D1", value: "007" },
          { address: "E1", formula: "=SUM(B1:C1)" },
        ],
      },
    });
    const appended = writeXlsx({
      existing: written,
      operation: { kind: "append-row", sheet: "Types", values: ["More", 7] },
    });
    const part = partText(appended, "xl/worksheets/sheet1.xml");

    expect(part).toContain(
      '<c r="A1" t="inlineStr"><is><t xml:space="preserve">text value</t></is></c>',
    );
    expect(part).toContain('<c r="B1"><v>42</v></c>');
    expect(part).toContain('<c r="C1"><v>3.5</v></c>');
    expect(part).toContain('<c r="D1" t="inlineStr"><is><t xml:space="preserve">007</t></is></c>');
    expect(part).toContain('<c r="E1"><f>SUM(B1:C1)</f></c>');
    expect(part).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">More</t></is></c>');
    expect(part).toContain('<c r="B2"><v>7</v></c>');
    // A numeric-looking string must stay text.
    expect(part).not.toContain("<v>007</v>");

    expect(inspectXlsx(appended, BOUNDS, "Types", "A1:E2").cells).toEqual([
      { address: "A1", value: "text value", formula: null },
      { address: "B1", value: "42", formula: null },
      { address: "C1", value: "3.5", formula: null },
      { address: "D1", value: "007", formula: null },
      { address: "E1", value: "", formula: "=SUM(B1:C1)" },
      { address: "A2", value: "More", formula: null },
      { address: "B2", value: "7", formula: null },
      { address: "C2", value: "", formula: null },
      { address: "D2", value: "", formula: null },
      { address: "E2", value: "", formula: null },
    ]);
  });
});
