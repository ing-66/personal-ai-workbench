import {
  McpCapabilityUnavailableError,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type ThreadArtifactMetadata,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as CanonicalThreadCoreState from "../../../coreState/CanonicalThreadCoreState.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspacePaths } from "../../../workspace/WorkspacePaths.ts";
import {
  OfficeDocumentUnreadableError,
  OfficeFileTooLargeError,
  OfficeInvalidArgumentsError,
  OfficeOutputInvalidError,
  OfficeOverwriteRefusedError,
  OfficeSaveFailedError,
  OfficeThreadNotFoundError,
  OfficeToolTargetNotFoundError,
  OfficeUnsupportedFormatError,
  OfficeWorkspaceViolationError,
} from "./errors.ts";

/**
 * Office tools exposed on T3's existing MCP Tool Bus.
 *
 * There is no separate tool protocol, registry, or transport here: these are
 * ordinary `Tool.make` declarations registered on the same MCP server as the
 * pull-request, preview, and device toolkits, so every harness that can speak
 * MCP reaches them through the credential it already holds. Office is not part
 * of any provider adapter.
 *
 * Names are stable identifiers (`office_document_write`) because harnesses match
 * tools by name; the "office" group and the format family are carried in the
 * title and description, and every result reports the same group.
 */

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  CanonicalThreadCoreState.CanonicalThreadCoreState,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  WorkspacePaths,
];

export const OfficeDocumentFormat = Schema.Literals(["docx", "xlsx", "pptx", "pdf"]);
export type OfficeDocumentFormat = typeof OfficeDocumentFormat.Type;

const OfficePath = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description:
    "Path relative to the current Project workspace (thread worktree when the thread has one). Absolute paths and paths escaping the workspace are rejected.",
});

export const OfficeArtifactReference = Schema.Struct({
  artifactId: Schema.String,
  workspaceRelativePath: Schema.String,
  artifactType: Schema.String,
  created: Schema.Boolean.annotate({
    description:
      "True when this call registered a new artifact; false when it updated an existing one.",
  }),
});
export type OfficeArtifactReference = typeof OfficeArtifactReference.Type;

const warnings = Schema.Array(Schema.String).annotate({
  description: "Non-fatal notes about this call, for example that a bound truncated the result.",
});

export const OfficeToolError = Schema.Union([
  McpCapabilityUnavailableError,
  OfficeToolTargetNotFoundError,
  OfficeWorkspaceViolationError,
  OfficeUnsupportedFormatError,
  OfficeFileTooLargeError,
  OfficeInvalidArgumentsError,
  OfficeOverwriteRefusedError,
  OfficeOutputInvalidError,
  OfficeDocumentUnreadableError,
  OfficeThreadNotFoundError,
  OfficeSaveFailedError,
]);

/* -------------------------------------------------------------------------- */
/* Inspection                                                                  */
/* -------------------------------------------------------------------------- */

export const OfficeInspectResult = Schema.Struct({
  path: Schema.String,
  format: OfficeDocumentFormat,
  sizeBytes: NonNegativeInt,
  /** Format-specific facts, already bounded by this call's limits. */
  details: Schema.Unknown,
  truncated: Schema.Boolean,
  warnings,
});
export type OfficeInspectResult = typeof OfficeInspectResult.Type;

const OfficeInspectTool = Tool.make("office_inspect", {
  description:
    "Inspect one Office file (.docx, .xlsx, .pptx, or .pdf) inside the current Project workspace and return a bounded, structured summary instead of the whole document. Spreadsheets return sheet names, sizes and a bounded range of cells (pass sheet and range to narrow it); documents return paragraph text, heading outline and table content; presentations return the slide list with each slide's title and text; PDFs return the page count and per-page text. Files above the size limit are refused.",
  parameters: Schema.Struct({
    path: OfficePath,
    sheet: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
        description: "Spreadsheet only. Sheet name to read; defaults to the first sheet.",
      }),
    ),
    range: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(64)).annotate({
        description:
          'Spreadsheet only. A1 range to read, for example "A1:D20", "B2", or "A:C". Defaults to the used range.',
      }),
    ),
    maxRows: Schema.optional(
      PositiveInt.annotate({
        description: "Spreadsheet only. Maximum rows to return. Defaults to 100.",
      }),
    ),
    maxColumns: Schema.optional(
      PositiveInt.annotate({
        description: "Spreadsheet only. Maximum columns to return. Defaults to 26.",
      }),
    ),
    maxItems: Schema.optional(
      PositiveInt.annotate({
        description:
          "Document, presentation, PDF. Maximum paragraphs, slides, or pages to return. Defaults to 50.",
      }),
    ),
  }),
  success: OfficeInspectResult,
  failure: OfficeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Office: inspect a document")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/* -------------------------------------------------------------------------- */
/* Spreadsheet range                                                           */
/* -------------------------------------------------------------------------- */

export const OfficeReadRangeResult = Schema.Struct({
  path: Schema.String,
  sheet: Schema.String,
  range: Schema.String,
  cells: Schema.Array(
    Schema.Struct({
      address: Schema.String,
      value: Schema.String,
      formula: Schema.NullOr(Schema.String),
    }),
  ),
  truncated: Schema.Boolean,
  warnings,
});
export type OfficeReadRangeResult = typeof OfficeReadRangeResult.Type;

const OfficeReadRangeTool = Tool.make("office_read_range", {
  description:
    "Read one cell range from a .xlsx workbook in the current Project workspace. Returns cells in row-major order with their A1 address, value, and formula. Always pass the narrowest range you need: a whole sheet can be very large, and the response is capped by rows, columns and characters.",
  parameters: Schema.Struct({
    path: OfficePath,
    sheet: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
        description: "Sheet name. Defaults to the first sheet.",
      }),
    ),
    range: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(64)).annotate({
        description:
          'A1 range to read, for example "A1:D20", "B2", or "A:C". Defaults to the used range.',
      }),
    ),
    maxRows: Schema.optional(
      PositiveInt.annotate({ description: "Maximum rows. Defaults to 200." }),
    ),
    maxColumns: Schema.optional(
      PositiveInt.annotate({ description: "Maximum columns. Defaults to 50." }),
    ),
  }),
  success: OfficeReadRangeResult,
  failure: OfficeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Office: read a spreadsheet range")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

export const OfficeDocumentWriteResult = Schema.Struct({
  path: Schema.String,
  format: OfficeDocumentFormat,
  operation: Schema.String,
  summary: Schema.String,
  artifact: OfficeArtifactReference,
  openedAfterWrite: Schema.Boolean.annotate({
    description:
      "Always true: the written file was re-opened structurally before it was committed.",
  }),
  warnings,
});
export type OfficeDocumentWriteResult = typeof OfficeDocumentWriteResult.Type;

const OfficeDocumentWriteTool = Tool.make("office_document_write", {
  description:
    "Create or edit a Word document (.docx) inside the current Project workspace. Without `existingPath` a new document is created from `title` and `paragraphs`. With `existingPath` the existing file is edited in place (its other content is preserved) using `operation`. The result is written atomically to `path`; an existing `path` is only replaced when `overwrite=true`, otherwise a clear refusal is returned.",
  parameters: Schema.Struct({
    path: OfficePath.annotate({ description: "Destination path for the .docx file." }),
    existingPath: Schema.optional(
      OfficePath.annotate({
        description: "An existing .docx to edit. Omit to create a new document.",
      }),
    ),
    title: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
        description: "Document title, written to the package metadata.",
      }),
    ),
    paragraphs: Schema.optional(
      Schema.Array(Schema.String).annotate({
        description: "Initial paragraphs for a new document.",
      }),
    ),
    operation: Schema.optional(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("append-paragraph"),
          text: Schema.String,
          headingLevel: Schema.optional(
            Schema.Literals([1, 2, 3]).annotate({
              description: "When set, the paragraph is written as that heading level.",
            }),
          ),
        }),
        Schema.Struct({
          kind: Schema.Literal("replace-paragraph"),
          index: NonNegativeInt.annotate({
            description: "0-based index over the non-empty paragraphs returned by office_inspect.",
          }),
          text: Schema.String,
        }),
        Schema.Struct({
          kind: Schema.Literal("append-table"),
          rows: Schema.Array(Schema.Array(Schema.String)).annotate({
            description: "Rows of cell text appended as a table.",
          }),
        }),
      ]).annotate({ description: "Edit to apply to an existing document." }),
    ),
    overwrite: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace an existing destination file." }),
    ),
  }),
  success: OfficeDocumentWriteResult,
  failure: OfficeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Office: create or edit a Word document")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/* -------------------------------------------------------------------------- */
/* Spreadsheet writes                                                          */
/* -------------------------------------------------------------------------- */

export const OfficeSpreadsheetWriteResult = Schema.Struct({
  path: Schema.String,
  format: Schema.Literal("xlsx"),
  operation: Schema.String,
  summary: Schema.String,
  artifact: OfficeArtifactReference,
  openedAfterWrite: Schema.Boolean,
  warnings,
});
export type OfficeSpreadsheetWriteResult = typeof OfficeSpreadsheetWriteResult.Type;

const OfficeSpreadsheetWriteTool = Tool.make("office_spreadsheet_write", {
  description:
    "Create or edit an Excel workbook (.xlsx) inside the current Project workspace. Without `existingPath` a new workbook is created from `sheets`. With `existingPath` the workbook is edited using `operation` (append a row, write specific cells, or add a sheet) while every other sheet, cell, style and worksheet feature is preserved. Formulas are written as text and are not evaluated here. The result is written atomically; an existing `path` is only replaced when `overwrite=true`.",
  parameters: Schema.Struct({
    path: OfficePath.annotate({ description: "Destination path for the .xlsx file." }),
    existingPath: Schema.optional(
      OfficePath.annotate({
        description: "An existing .xlsx workbook to edit. Omit to create a new one.",
      }),
    ),
    title: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(255)).annotate({
        description: "Workbook title, written to the package metadata.",
      }),
    ),
    sheets: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString.check(Schema.isMaxLength(31)),
          rows: Schema.optional(
            Schema.Array(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
          ),
        }),
      ).annotate({ description: "Initial sheets for a new workbook." }),
    ),
    operation: Schema.optional(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("append-row"),
          sheet: TrimmedNonEmptyString.check(Schema.isMaxLength(31)),
          values: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
        }),
        Schema.Struct({
          kind: Schema.Literal("write-cells"),
          sheet: TrimmedNonEmptyString.check(Schema.isMaxLength(31)),
          cells: Schema.Array(
            Schema.Struct({
              address: TrimmedNonEmptyString.check(Schema.isMaxLength(16)).annotate({
                description: 'Cell address such as "B3".',
              }),
              value: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
              formula: Schema.optional(
                Schema.String.annotate({
                  description: 'Formula without the leading "=", for example "SUM(B2:B10)".',
                }),
              ),
            }),
          ),
        }),
        Schema.Struct({
          kind: Schema.Literal("add-sheet"),
          sheet: TrimmedNonEmptyString.check(Schema.isMaxLength(31)),
        }),
      ]).annotate({ description: "Edit to apply to an existing workbook." }),
    ),
    overwrite: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace an existing destination file." }),
    ),
  }),
  success: OfficeSpreadsheetWriteResult,
  failure: OfficeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Office: create or edit an Excel workbook")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/* -------------------------------------------------------------------------- */
/* Presentations                                                               */
/* -------------------------------------------------------------------------- */

export const OfficePresentationWriteResult = Schema.Struct({
  path: Schema.String,
  format: Schema.Literal("pptx"),
  operation: Schema.String,
  summary: Schema.String,
  slideCount: NonNegativeInt,
  artifact: OfficeArtifactReference,
  openedAfterWrite: Schema.Boolean,
  warnings,
});
export type OfficePresentationWriteResult = typeof OfficePresentationWriteResult.Type;

const slideInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.Array(Schema.String)),
});

const OfficePresentationCreateTool = Tool.make("office_presentation_create", {
  description:
    "Create a PowerPoint presentation (.pptx) inside the current Project workspace. Each slide has an optional title and body lines. The file is written atomically, then re-opened structurally before it is committed, and an existing destination is only replaced when `overwrite=true`.",
  parameters: Schema.Struct({
    path: OfficePath.annotate({ description: "Destination path for the .pptx file." }),
    title: Schema.optional(Schema.String.annotate({ description: "Presentation title." })),
    slides: Schema.Array(slideInput).annotate({ description: "Slides to create, in order." }),
    overwrite: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace an existing destination file." }),
    ),
  }),
  success: OfficePresentationWriteResult,
  failure: OfficeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Office: create a presentation")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const OfficePresentationAddSlideTool = Tool.make("office_presentation_add_slide", {
  description:
    "Add a slide to an existing .pptx in the current Project workspace, or replace the title and body text of one of its slides. Other slides and shapes are preserved. Use office_inspect first to see the slide numbering (1-based, in presentation order).",
  parameters: Schema.Struct({
    existingPath: OfficePath.annotate({ description: "The existing .pptx to edit." }),
    path: OfficePath.annotate({
      description: "Destination path. Use the same path as existingPath to edit in place.",
    }),
    operation: Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("add-slide"),
        slide: slideInput.annotate({ description: "Slide to append." }),
      }),
      Schema.Struct({
        kind: Schema.Literal("replace-slide-text"),
        slideIndex: PositiveInt.annotate({
          description: "1-based slide index in presentation order.",
        }),
        title: Schema.optional(Schema.String),
        body: Schema.optional(Schema.Array(Schema.String)),
      }),
    ]),
    overwrite: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace an existing destination file." }),
    ),
  }),
  success: OfficePresentationWriteResult,
  failure: OfficeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Office: add or edit a presentation slide")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/* -------------------------------------------------------------------------- */
/* PDF                                                                         */
/* -------------------------------------------------------------------------- */

export const OfficePdfCreateResult = Schema.Struct({
  path: Schema.String,
  format: Schema.Literal("pdf"),
  pageCount: NonNegativeInt,
  summary: Schema.String,
  artifact: OfficeArtifactReference,
  openedAfterWrite: Schema.Boolean,
  warnings,
});
export type OfficePdfCreateResult = typeof OfficePdfCreateResult.Type;

const OfficePdfCreateTool = Tool.make("office_pdf_create", {
  description:
    "Create a simple text PDF inside the current Project workspace. Each page has an optional heading and body lines. This writes plain text pages only: it does not convert an Office document to PDF, does not render images, and does not modify existing PDFs.",
  parameters: Schema.Struct({
    path: OfficePath.annotate({ description: "Destination path for the .pdf file." }),
    title: Schema.optional(Schema.String.annotate({ description: "PDF metadata title." })),
    pages: Schema.Array(
      Schema.Struct({
        heading: Schema.optional(Schema.String),
        lines: Schema.Array(Schema.String),
      }),
    ).annotate({ description: "Pages to create, in order." }),
    overwrite: Schema.optional(
      Schema.Boolean.annotate({ description: "Replace an existing destination file." }),
    ),
  }),
  success: OfficePdfCreateResult,
  failure: OfficeToolError,
  dependencies,
})
  .annotate(Tool.Title, "Office: create a text PDF")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const OfficeToolkit = Toolkit.make(
  OfficeInspectTool,
  OfficeReadRangeTool,
  OfficeDocumentWriteTool,
  OfficeSpreadsheetWriteTool,
  OfficePresentationCreateTool,
  OfficePresentationAddSlideTool,
  OfficePdfCreateTool,
);

/**
 * Input types for the toolkit's handlers, derived from the declarations above so
 * a handler signature cannot drift from the schema a caller actually sends.
 */
export type OfficeInspectInput = typeof OfficeInspectTool.parametersSchema.Type;
export type OfficeReadRangeInput = typeof OfficeReadRangeTool.parametersSchema.Type;
export type OfficeDocumentWriteInput = typeof OfficeDocumentWriteTool.parametersSchema.Type;
export type OfficeSpreadsheetWriteInput = typeof OfficeSpreadsheetWriteTool.parametersSchema.Type;
export type OfficePresentationCreateInput =
  typeof OfficePresentationCreateTool.parametersSchema.Type;
export type OfficePresentationAddSlideInput =
  typeof OfficePresentationAddSlideTool.parametersSchema.Type;
export type OfficePdfCreateInput = typeof OfficePdfCreateTool.parametersSchema.Type;

/** Artifact types registered for office output, matching the Phase 2 free-form vocabulary. */
export const officeArtifactType = (format: OfficeDocumentFormat): string =>
  format === "docx"
    ? "document"
    : format === "xlsx"
      ? "spreadsheet"
      : format === "pptx"
        ? "presentation"
        : "pdf";

export type { ThreadArtifactMetadata };
