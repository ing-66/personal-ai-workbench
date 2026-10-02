import { type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/**
 * Structured failures for the office toolkit.
 *
 * Every failure the caller can act on is its own tagged error with a message a
 * model can read and correct, instead of a raw errno. Lower-level detail rides in
 * `cause` for diagnostics and is never presented as the message.
 */

export class OfficeToolTargetNotFoundError extends Schema.TaggedError<OfficeToolTargetNotFoundError>()(
  "OfficeToolTargetNotFoundError",
  { path: Schema.String },
) {
  override get message(): string {
    return `No file exists at ${this.path} inside the current Project workspace.`;
  }
}

export class OfficeWorkspaceViolationError extends Schema.TaggedError<OfficeWorkspaceViolationError>()(
  "OfficeWorkspaceViolationError",
  { path: Schema.String, reason: Schema.String, cause: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return `Cannot use ${this.path}: ${this.reason} Tools may only reach files inside the current Project workspace (thread.worktreePath ?? project.workspaceRoot).`;
  }
}

export class OfficeUnsupportedFormatError extends Schema.TaggedError<OfficeUnsupportedFormatError>()(
  "OfficeUnsupportedFormatError",
  { path: Schema.String, supportedExtensions: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `${this.path} has an unsupported extension for this tool. Supported: ${this.supportedExtensions.join(", ")}.`;
  }
}

export class OfficeFileTooLargeError extends Schema.TaggedError<OfficeFileTooLargeError>()(
  "OfficeFileTooLargeError",
  { path: Schema.String, sizeBytes: Schema.Number, maxBytes: Schema.Number },
) {
  override get message(): string {
    return `${this.path} is ${this.sizeBytes} bytes, above the ${this.maxBytes} byte limit for document inspection. Narrow the file or split it first.`;
  }
}

export class OfficeInvalidArgumentsError extends Schema.TaggedError<OfficeInvalidArgumentsError>()(
  "OfficeInvalidArgumentsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export class OfficeOverwriteRefusedError extends Schema.TaggedError<OfficeOverwriteRefusedError>()(
  "OfficeOverwriteRefusedError",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} already exists and would be replaced. Pass overwrite=true to replace it deliberately, or choose a different output path.`;
  }
}

export class OfficeOutputInvalidError extends Schema.TaggedError<OfficeOutputInvalidError>()(
  "OfficeOutputInvalidError",
  { path: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `The document written to ${this.path} could not be validated: ${this.detail}`;
  }
}

export class OfficeDocumentUnreadableError extends Schema.TaggedError<OfficeDocumentUnreadableError>()(
  "OfficeDocumentUnreadableError",
  { path: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Could not read ${this.path} as an Office document: ${this.detail}`;
  }
}

export class OfficeThreadNotFoundError extends Schema.TaggedError<OfficeThreadNotFoundError>()(
  "OfficeThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found, so the workspace for this tool call cannot be resolved.`;
  }
}

export class OfficeSaveFailedError extends Schema.TaggedError<OfficeSaveFailedError>()(
  "OfficeSaveFailedError",
  { path: Schema.String, cause: Schema.Unknown },
) {
  override get message(): string {
    return `Could not save ${this.path}. The existing file was left unchanged.`;
  }
}

export const OfficeToolError = Schema.Union([
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
export type OfficeToolError = typeof OfficeToolError.Type;

/** Identity of the calling thread/project, resolved once per tool call. */
export interface OfficeWorkspace {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** `thread.worktreePath ?? project.workspaceRoot`, used for every relative path. */
  readonly workingRoot: string;
  readonly worktreePath: string | null;
}
