import {
  CommandId,
  EventId,
  McpCapabilityUnavailableError,
  ThreadArtifactId,
  type ThreadArtifactMetadata,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as CanonicalThreadCoreState from "../../../coreState/CanonicalThreadCoreState.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { inspectDocx, writeDocx, type DocxWriteOperation } from "./docx.ts";
import {
  OfficeDocumentUnreadableError,
  OfficeInvalidArgumentsError,
  OfficeThreadNotFoundError,
  OfficeToolError,
  type OfficeWorkspace,
} from "./errors.ts";
import { createPdf, inspectPdf } from "./pdf.ts";
import { inspectPptx, writePptx } from "./pptx.ts";
import {
  officeArtifactType,
  type OfficeDocumentFormat,
  type OfficeDocumentWriteInput,
  type OfficeDocumentWriteResult,
  type OfficeInspectInput,
  type OfficeInspectResult,
  type OfficePdfCreateInput,
  type OfficePdfCreateResult,
  type OfficePresentationAddSlideInput,
  type OfficePresentationCreateInput,
  type OfficePresentationWriteResult,
  type OfficeReadRangeInput,
  type OfficeReadRangeResult,
  type OfficeSpreadsheetWriteInput,
  type OfficeSpreadsheetWriteResult,
  OfficeToolkit,
} from "./tools.ts";
import { makeOfficeFileAccess } from "./workspace.ts";
import { inspectXlsx, writeXlsx } from "./xlsx.ts";

/** Character budget for returned document text, matching the repo's snapshot text precedent. */
const MAX_INSPECT_TEXT_CHARS = 32_000;
const DEFAULT_MAX_ITEMS = 50;
const DEFAULT_MAX_ROWS = 100;
const DEFAULT_MAX_COLUMNS = 26;
const DEFAULT_RANGE_ROWS = 200;
const DEFAULT_RANGE_COLUMNS = 50;
const MAX_CELLS = 20_000;

const SUPPORTED_EXTENSIONS = [".docx", ".xlsx", ".pptx", ".pdf"] as const;

const formatOfPath = (path: Path.Path, requestedPath: string): OfficeDocumentFormat | null => {
  switch (path.extname(requestedPath).toLowerCase()) {
    case ".docx":
      return "docx";
    case ".xlsx":
      return "xlsx";
    case ".pptx":
      return "pptx";
    case ".pdf":
      return "pdf";
    default:
      return null;
  }
};

/**
 * Wraps whatever a format module throws or fails with as the structured
 * unreadable-document failure. Format modules signal structural problems by
 * throwing, so both the failure channel and defect-shaped causes land here.
 */
const asUnreadable =
  (target: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OfficeDocumentUnreadableError, R> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          new OfficeDocumentUnreadableError({
            path: target,
            detail: Cause.pretty(cause).split("\n")[0] ?? "The document could not be parsed.",
          }),
        ),
      ),
      Effect.orDie,
    );

/** Re-opens the bytes we produced, so a package our reader rejects never commits. */
const inspectProduced = (input: {
  readonly format: OfficeDocumentFormat;
  readonly bytes: Uint8Array;
  readonly target: string;
  readonly sheet?: string | undefined;
  readonly range?: string | undefined;
  readonly maxRows?: number | undefined;
  readonly maxColumns?: number | undefined;
  readonly maxItems?: number | undefined;
}): Effect.Effect<unknown, OfficeDocumentUnreadableError> =>
  Effect.try(() => {
    const maxItems = input.maxItems ?? DEFAULT_MAX_ITEMS;
    switch (input.format) {
      case "docx":
        return inspectDocx(input.bytes, {
          maxParagraphs: maxItems,
          maxTextChars: MAX_INSPECT_TEXT_CHARS,
        });
      case "xlsx":
        return inspectXlsx(
          input.bytes,
          {
            maxSheets: maxItems,
            maxRows: input.maxRows ?? DEFAULT_MAX_ROWS,
            maxColumns: input.maxColumns ?? DEFAULT_MAX_COLUMNS,
            maxCells: MAX_CELLS,
            maxTextChars: MAX_INSPECT_TEXT_CHARS,
          },
          input.sheet,
          input.range,
        );
      case "pptx":
        return inspectPptx(input.bytes, {
          maxSlides: maxItems,
          maxTextCharsPerSlide: MAX_INSPECT_TEXT_CHARS,
        });
      case "pdf":
        return inspectPdf(input.bytes, {
          maxPages: maxItems,
          maxTextCharsPerPage: MAX_INSPECT_TEXT_CHARS,
        });
    }
  }).pipe(asUnreadable(input.target));

/** The spreadsheet inspection shape this module reads fields from. */
interface XlsxInspectionShape {
  readonly sheets: ReadonlyArray<{ readonly name: string }>;
  readonly sheet: string | null;
  readonly range: string | null;
  readonly cells: ReadonlyArray<{
    readonly address: string;
    readonly value: string;
    readonly formula: string | null;
  }>;
  readonly truncated: boolean;
}

/**
 * True when the value is a failure the office tools model themselves. Anything
 * else is an infrastructure fault the tool surface should not pretend to explain.
 */
const isModeledToolFailure = (value: unknown): boolean =>
  Schema.is(OfficeToolError)(value) || Schema.is(McpCapabilityUnavailableError)(value);

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const coreState = yield* CanonicalThreadCoreState.CanonicalThreadCoreState;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const fileAccess = yield* makeOfficeFileAccess();
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const createdAt = () => DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /**
   * A failure the tools do not model (a filesystem fault surfacing as a defect) is
   * reported as an unreadable document rather than as an unhandled crash.
   */
  const guardTool = <A, E, R>(input: {
    readonly path: string;
    readonly effect: Effect.Effect<A, E, R>;
  }): Effect.Effect<A, E | OfficeDocumentUnreadableError, R> =>
    Effect.catchCause(
      input.effect,
      (cause): Effect.Effect<A, E | OfficeDocumentUnreadableError> => {
        const failure = Cause.findErrorOption(cause);
        if (Option.isSome(failure) && isModeledToolFailure(failure.value)) {
          return Effect.failCause(cause);
        }
        return Effect.fail(
          new OfficeDocumentUnreadableError({
            path: input.path,
            detail: Cause.pretty(cause).split("\n")[0] ?? "The tool call failed.",
          }),
        );
      },
    );

  /**
   * Resolves the calling thread and its workspace. The cwd rule is the Phase 1-3
   * rule, unchanged: `thread.worktreePath ?? project.workspaceRoot`.
   */
  const requireWorkspace: () => Effect.Effect<
    {
      readonly scope: McpInvocationContext.McpInvocationScope;
      readonly workspace: OfficeWorkspace;
    },
    McpCapabilityUnavailableError | OfficeThreadNotFoundError,
    McpInvocationContext.McpInvocationContext
  > = Effect.fn("OfficeToolkit.requireWorkspace")(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("office");
    const notFound = () => new OfficeThreadNotFoundError({ threadId: scope.threadId });
    const thread = yield* snapshots.getThreadShellById(scope.threadId).pipe(Effect.orDie);
    if (Option.isNone(thread)) {
      return yield* notFound();
    }
    const project = yield* snapshots
      .getProjectShellById(thread.value.projectId)
      .pipe(Effect.orDie, Effect.map(Option.getOrUndefined));
    const workspaceRoot = thread.value.worktreePath ?? project?.workspaceRoot;
    if (workspaceRoot === undefined) {
      return yield* notFound();
    }
    const workspace: OfficeWorkspace = {
      threadId: thread.value.id,
      projectId: thread.value.projectId,
      workingRoot: workspaceRoot,
      worktreePath: thread.value.worktreePath ?? null,
    };
    return { scope, workspace };
  });

  /**
   * Registers the written file in the Phase 2 artifact metadata registry. The
   * registry is keyed by (thread, workspace-relative path), so rewriting a path
   * that is already registered updates it instead of failing on the unique
   * constraint. Only metadata is stored; the document stays on disk.
   */
  const registerArtifact = (input: {
    readonly workspace: OfficeWorkspace;
    readonly relativePath: string;
    readonly format: OfficeDocumentFormat;
  }): Effect.Effect<OfficeDocumentWriteResult["artifact"], OfficeThreadNotFoundError> =>
    Effect.gen(function* () {
      const artifactType = officeArtifactType(input.format);
      const notFound = () => new OfficeThreadNotFoundError({ threadId: input.workspace.threadId });
      const existing = yield* coreState
        .listArtifacts(input.workspace.threadId)
        .pipe(Effect.orDie, Effect.mapError(notFound));
      const match = existing.find(
        (artifact: ThreadArtifactMetadata) => artifact.workspaceRelativePath === input.relativePath,
      );
      if (match !== undefined) {
        const updated = yield* coreState
          .updateArtifact({
            artifactId: match.artifactId,
            threadId: input.workspace.threadId,
            workspaceRelativePath: input.relativePath,
            artifactType,
          })
          .pipe(Effect.orDie, Effect.mapError(notFound));
        return {
          artifactId: String(updated.artifactId),
          workspaceRelativePath: updated.workspaceRelativePath,
          artifactType: updated.artifactType,
          created: false,
        };
      }
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const created = yield* coreState
        .registerArtifact({
          artifactId: ThreadArtifactId.make(`artifact_${cryptoId(uuid)}`),
          threadId: input.workspace.threadId,
          workspaceRelativePath: input.relativePath,
          artifactType,
        })
        .pipe(Effect.orDie, Effect.mapError(notFound));
      return {
        artifactId: String(created.artifactId),
        workspaceRelativePath: created.workspaceRelativePath,
        artifactType: created.artifactType,
        created: true,
      };
    });

  /**
   * One lightweight activity per tool call. Identity, target and outcome only:
   * document contents, cell values and byte payloads never enter the log.
   */
  const recordToolActivity = (input: {
    readonly workspace: OfficeWorkspace;
    readonly tool: string;
    readonly relativePath: string;
    readonly artifactId: string | null;
    readonly detail: string;
    readonly at: string;
  }) =>
    engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          `office-tool:${input.tool}:${input.workspace.threadId}:${input.at}`,
        ),
        threadId: input.workspace.threadId,
        activity: {
          id: EventId.make(`office-tool:${input.tool}:${input.relativePath}:${input.at}`),
          tone: "tool",
          kind: "office.tool",
          summary: `${input.tool} used on ${input.relativePath}`,
          payload: {
            tool: input.tool,
            workspaceRelativePath: input.relativePath,
            artifactId: input.artifactId,
            outcome: "succeeded",
            detail: input.detail,
          },
          turnId: null,
          createdAt: input.at,
        },
        createdAt: input.at,
      })
      .pipe(
        // An activity is observability, never a reason to fail the tool call.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("office tool activity could not be recorded", { cause }),
        ),
      );

  /** Shared tail for every writer: commit atomically, register, record. */
  const commitDocument = (input: {
    readonly workspace: OfficeWorkspace;
    readonly format: OfficeDocumentFormat;
    readonly tool: string;
    readonly requestedPath: string;
    readonly bytes: Uint8Array;
    readonly overwrite: boolean;
    readonly detail: string;
  }) =>
    Effect.gen(function* () {
      const written = yield* fileAccess.writeBytes({
        workspaceRoot: input.workspace.workingRoot,
        requestedPath: input.requestedPath,
        bytes: input.bytes,
        overwrite: input.overwrite,
        supportedExtensions: [`.${input.format}`],
      });
      const artifact = yield* registerArtifact({
        workspace: input.workspace,
        relativePath: written.relativePath,
        format: input.format,
      });
      yield* recordToolActivity({
        workspace: input.workspace,
        tool: input.tool,
        relativePath: written.relativePath,
        artifactId: artifact.artifactId,
        detail: input.detail,
        at: yield* createdAt(),
      });
      return { written, artifact };
    });

  /*
   * Inspection is progressive by construction: one call returns a bounded summary
   * and the caller narrows with `sheet`/`range`/`maxItems` rather than receiving
   * the whole document.
   */
  const officeInspect = (input: OfficeInspectInput) =>
    Effect.gen(function* () {
      const { workspace } = yield* requireWorkspace();
      const format = formatOfPath(path, input.path);
      if (format === null) {
        return yield* new OfficeInvalidArgumentsError({
          detail: `Cannot inspect ${input.path}: supported formats are ${SUPPORTED_EXTENSIONS.join(", ")}.`,
        });
      }
      const read = yield* fileAccess.readBytes({
        workspaceRoot: workspace.workingRoot,
        requestedPath: input.path,
      });
      const details = yield* inspectProduced({
        format,
        bytes: read.bytes,
        target: read.relativePath,
        sheet: input.sheet,
        range: input.range,
        maxRows: input.maxRows,
        maxColumns: input.maxColumns,
        maxItems: input.maxItems,
      });
      const truncated =
        typeof details === "object" &&
        details !== null &&
        "truncated" in details &&
        Boolean((details as { truncated: unknown }).truncated);
      return {
        path: read.relativePath,
        format,
        sizeBytes: read.bytes.byteLength,
        details,
        truncated,
        warnings: truncated
          ? [
              "The result was capped by this tool's limits. Pass a narrower range or larger limits to see more.",
            ]
          : ([] as ReadonlyArray<string>),
      } satisfies OfficeInspectResult;
    });

  const officeReadRange = (input: OfficeReadRangeInput) =>
    Effect.gen(function* () {
      const { workspace } = yield* requireWorkspace();
      if (formatOfPath(path, input.path) !== "xlsx") {
        return yield* new OfficeInvalidArgumentsError({
          detail: `${input.path} is not a spreadsheet. office_read_range only reads .xlsx files.`,
        });
      }
      const read = yield* fileAccess.readBytes({
        workspaceRoot: workspace.workingRoot,
        requestedPath: input.path,
      });
      const inspected = (yield* inspectProduced({
        format: "xlsx",
        bytes: read.bytes,
        target: read.relativePath,
        sheet: input.sheet,
        range: input.range,
        maxRows: input.maxRows ?? DEFAULT_RANGE_ROWS,
        maxColumns: input.maxColumns ?? DEFAULT_RANGE_COLUMNS,
      })) as XlsxInspectionShape;
      return {
        path: read.relativePath,
        sheet: inspected.sheet ?? input.sheet ?? inspected.sheets[0]?.name ?? "Sheet1",
        range: inspected.range ?? "",
        cells: inspected.cells.map((cell) => ({
          address: cell.address,
          value: cell.value,
          formula: cell.formula,
        })),
        truncated: inspected.truncated,
        warnings: inspected.truncated
          ? [
              "The requested range was larger than the limits, so only its first rows and columns are returned.",
            ]
          : ([] as ReadonlyArray<string>),
      } satisfies OfficeReadRangeResult;
    });

  const officeDocumentWrite = (input: OfficeDocumentWriteInput) =>
    Effect.gen(function* () {
      const { workspace } = yield* requireWorkspace();
      const source =
        input.existingPath === undefined
          ? null
          : (yield* fileAccess.readBytes({
              workspaceRoot: workspace.workingRoot,
              requestedPath: input.existingPath,
              supportedExtensions: [".docx"],
            })).bytes;
      if (source === null && input.operation !== undefined) {
        return yield* new OfficeInvalidArgumentsError({
          detail:
            "operation requires existingPath. To create a document, pass title and/or paragraphs instead.",
        });
      }
      if (source !== null && input.operation === undefined) {
        return yield* new OfficeInvalidArgumentsError({
          detail: "Editing an existing document requires an operation.",
        });
      }
      const produced = yield* Effect.try(() =>
        writeDocx({
          existing: source,
          title: input.title,
          seedParagraphs: input.paragraphs,
          operation: input.operation as DocxWriteOperation | undefined,
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OfficeInvalidArgumentsError({
              detail: `Could not build the document: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );
      const inspection = (yield* inspectProduced({
        format: "docx",
        bytes: produced,
        target: input.path,
      })) as { paragraphCount?: number };
      const { written, artifact } = yield* commitDocument({
        workspace,
        format: "docx",
        tool: "office_document_write",
        requestedPath: input.path,
        bytes: produced,
        overwrite: input.overwrite ?? false,
        detail: `${inspection.paragraphCount ?? 0} paragraph(s)`,
      });
      return {
        path: written.relativePath,
        format: "docx" as const,
        operation: input.operation?.kind ?? "create",
        summary: `Wrote ${written.relativePath} and re-opened it before committing.`,
        artifact,
        openedAfterWrite: true,
        warnings: [] as ReadonlyArray<string>,
      } satisfies OfficeDocumentWriteResult;
    });

  const officeSpreadsheetWrite = (input: OfficeSpreadsheetWriteInput) =>
    Effect.gen(function* () {
      const { workspace } = yield* requireWorkspace();
      const source =
        input.existingPath === undefined
          ? null
          : (yield* fileAccess.readBytes({
              workspaceRoot: workspace.workingRoot,
              requestedPath: input.existingPath,
              supportedExtensions: [".xlsx"],
            })).bytes;
      if (source === null && input.operation !== undefined) {
        return yield* new OfficeInvalidArgumentsError({
          detail: "operation requires existingPath. To create a workbook, pass sheets instead.",
        });
      }
      if (source !== null && input.operation === undefined) {
        return yield* new OfficeInvalidArgumentsError({
          detail: "Editing an existing workbook requires an operation.",
        });
      }
      const produced = yield* Effect.try(() =>
        writeXlsx({
          existing: source,
          title: input.title,
          sheets: input.sheets,
          operation: input.operation,
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OfficeInvalidArgumentsError({
              detail: `Could not build the workbook: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );
      const inspection = (yield* inspectProduced({
        format: "xlsx",
        bytes: produced,
        target: input.path,
      })) as XlsxInspectionShape;
      const { written, artifact } = yield* commitDocument({
        workspace,
        format: "xlsx",
        tool: "office_spreadsheet_write",
        requestedPath: input.path,
        bytes: produced,
        overwrite: input.overwrite ?? false,
        detail: `${inspection.sheets.length} sheet(s)`,
      });
      return {
        path: written.relativePath,
        format: "xlsx" as const,
        operation: input.operation?.kind ?? "create",
        summary: `Wrote ${written.relativePath} and re-opened it before committing.`,
        artifact,
        openedAfterWrite: true,
        warnings: [] as ReadonlyArray<string>,
      } satisfies OfficeSpreadsheetWriteResult;
    });

  const officePresentationCreate = (input: OfficePresentationCreateInput) =>
    Effect.gen(function* () {
      const { workspace } = yield* requireWorkspace();
      const produced = yield* Effect.try(() =>
        writePptx({ existing: null, title: input.title, seedSlides: input.slides }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OfficeInvalidArgumentsError({
              detail: `Could not build the presentation: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );
      const inspection = (yield* inspectProduced({
        format: "pptx",
        bytes: produced,
        target: input.path,
      })) as { slideCount?: number };
      const slideCount = Number(inspection.slideCount ?? 0);
      const { written, artifact } = yield* commitDocument({
        workspace,
        format: "pptx",
        tool: "office_presentation_create",
        requestedPath: input.path,
        bytes: produced,
        overwrite: input.overwrite ?? false,
        detail: `${slideCount} slide(s)`,
      });
      return {
        path: written.relativePath,
        format: "pptx" as const,
        operation: "create",
        summary: `Wrote ${written.relativePath} and re-opened it before committing.`,
        slideCount,
        artifact,
        openedAfterWrite: true,
        warnings: [] as ReadonlyArray<string>,
      } satisfies OfficePresentationWriteResult;
    });

  const officePresentationAddSlide = (input: OfficePresentationAddSlideInput) =>
    Effect.gen(function* () {
      const { workspace } = yield* requireWorkspace();
      const source = yield* fileAccess.readBytes({
        workspaceRoot: workspace.workingRoot,
        requestedPath: input.existingPath,
        supportedExtensions: [".pptx"],
      });
      const operation =
        input.operation.kind === "add-slide"
          ? {
              kind: "add-slide" as const,
              title: input.operation.slide.title,
              body: input.operation.slide.body,
            }
          : {
              kind: "replace-slide-text" as const,
              slideIndex: input.operation.slideIndex,
              title: input.operation.title,
              body: input.operation.body,
            };
      const produced = yield* Effect.try(() =>
        writePptx({ existing: source.bytes, operation }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OfficeInvalidArgumentsError({
              detail: `Could not edit the presentation: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );
      const inspection = (yield* inspectProduced({
        format: "pptx",
        bytes: produced,
        target: input.path,
      })) as { slideCount?: number };
      const slideCount = Number(inspection.slideCount ?? 0);
      const { written, artifact } = yield* commitDocument({
        workspace,
        format: "pptx",
        tool: "office_presentation_add_slide",
        requestedPath: input.path,
        bytes: produced,
        overwrite: input.overwrite ?? false,
        detail: `${slideCount} slide(s)`,
      });
      return {
        path: written.relativePath,
        format: "pptx" as const,
        operation: input.operation.kind,
        summary: `Wrote ${written.relativePath} and re-opened it before committing.`,
        slideCount,
        artifact,
        openedAfterWrite: true,
        warnings: [] as ReadonlyArray<string>,
      } satisfies OfficePresentationWriteResult;
    });

  const officePdfCreate = (input: OfficePdfCreateInput) =>
    Effect.gen(function* () {
      const { workspace } = yield* requireWorkspace();
      const produced = yield* Effect.try(() =>
        createPdf({ title: input.title, pages: input.pages }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OfficeInvalidArgumentsError({
              detail: `Could not build the PDF: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        ),
      );
      const { written, artifact } = yield* commitDocument({
        workspace,
        format: "pdf",
        tool: "office_pdf_create",
        requestedPath: input.path,
        bytes: produced,
        overwrite: input.overwrite ?? false,
        detail: `${input.pages.length} page(s)`,
      });
      return {
        path: written.relativePath,
        format: "pdf" as const,
        pageCount: input.pages.length,
        summary: `Wrote ${written.relativePath}.`,
        artifact,
        openedAfterWrite: true,
        warnings: [
          "This is a plain text PDF from the supported subset. Visual fidelity beyond it is not verified.",
        ],
      } satisfies OfficePdfCreateResult;
    });

  return OfficeToolkit.of({
    office_inspect: (input) => guardTool({ path: input.path, effect: officeInspect(input) }),
    office_read_range: (input) => guardTool({ path: input.path, effect: officeReadRange(input) }),
    office_document_write: (input) =>
      guardTool({ path: input.path, effect: officeDocumentWrite(input) }),
    office_spreadsheet_write: (input) =>
      guardTool({ path: input.path, effect: officeSpreadsheetWrite(input) }),
    office_presentation_create: (input) =>
      guardTool({ path: input.path, effect: officePresentationCreate(input) }),
    office_presentation_add_slide: (input) =>
      guardTool({ path: input.path, effect: officePresentationAddSlide(input) }),
    office_pdf_create: (input) => guardTool({ path: input.path, effect: officePdfCreate(input) }),
  });
});

function cryptoId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

export const OfficeToolkitHandlersLive = OfficeToolkit.toLayer(make);
