# Phase 4 Report

## 1. Result

PASS

Phase 4 makes the host's document tooling reachable by whichever harness holds the baton, without
adding a tool protocol, a tool registry, a second transport, or any per-harness Office code. It
reuses T3's existing MCP server and tool model, and closes one real gap in the workspace write path
that Phase 2 left open.

Scope note recorded up front: `MASTER_SPEC.md` Phase 4 lists MarkItDown plus
python-docx/openpyxl/python-pptx/pdf-lib. That stack is Python, and this phase's brief forbids a
Python sidecar unless the JS/TS ecosystem genuinely cannot do the job. All four formats are
implemented in-process in TypeScript instead; §9 and §19 record what that buys and what it costs.

## 2. Implementation Audit Summary

Full audit: `docs/spikes/PHASE4_IMPLEMENTATION_AUDIT.md` (written before coding). Findings that
shaped the work:

- T3 already **is** an MCP server for its own agents (`McpServer.layerHttp`, path `/mcp`) with
  per-thread bearer credentials and capability checks, and it already has three toolkits
  (`pullRequests`, `preview`, `device`) declared with `Tool.make` / `Toolkit.make`.
- Tool capability was already modelled: `HarnessCapabilityView` reports `mcpServers`,
  `filesystemRead/Write`, `terminal`; the credential grants capabilities per session.
- Tool annotations (`Readonly`, `Destructive`, `Idempotent`, `OpenWorld`) are metadata only — no
  approval gate exists for MCP tool calls, and the repo's trust boundary is the environment.
- Nothing persisted MCP tool invocations; thread activities are the established lightweight log.
- **The gap**: `WorkspacePaths.resolveRelativePathWithinRoot` is string-only. Reads have a realpath
  defence (`WorkspaceFileSystem.resolveReadTarget`), writes had none, so a symlink or junction
  inside the workspace could redirect a write outside it.
- Artifact metadata (`CanonicalThreadCoreState`) accepts a free-form `artifactType`, so no new
  taxonomy is needed; `UNIQUE (thread_id, workspace_relative_path)` means a rewrite must update
  rather than re-insert.

## 3. Existing T3 Tool/MCP Reuse

Reused unchanged:

- `McpServer.layerHttp` transport, `McpSessionRegistry` credentials, and the per-request
  `McpInvocationContext` (threadId, providerInstanceId, provider session, capabilities).
- The `Tool.make` / `Toolkit.make` declaration style with typed success and tagged error unions.
- The toolkit registration pattern `McpServer.toolkit(X).pipe(Layer.provide(XHandlersLive))`,
  merged into the served layer.
- `ProviderService` MCP credential issuance (the office capability is granted like
  `pull-requests`, not gated behind a new settings toggle).
- `ProjectionSnapshotQuery` for thread/project facts, and `resolveThreadWorkspaceCwd`'s rule
  (`thread.worktreePath ?? project.workspaceRoot`) for every path.
- `thread.activity.append` for the lightweight per-call record.
- `CanonicalThreadCoreState` for artifact metadata.
- Phase 3's handoff briefing, which already reads registered artifacts and the capability view —
  so an Office artifact automatically appears in the next handoff without changing that protocol.

Nothing about the tool surface is per-provider: there is no `CodexOffice*` / `KimiOffice*` code, and
`GenericAcpAdapter` was not touched.

## 4. Tool Bus Architecture

```text
Project → Canonical Thread → Current Baton Holder → Provider Runtime
   → provider MCP client
   → POST /mcp                                (existing transport + per-thread credential)
   → McpInvocationContext                     (existing; capability "office" added)
   → registered MCP toolkits                  <-- this IS the tool bus
       ├── pull-requests  (existing)
       ├── preview        (existing)
       ├── device         (existing)
       └── office         (NEW: 7 tools)
   → toolkit handlers                          <-- this IS the tool executor
       ├── workspace guard (new: realpath-checked read + write)
       ├── atomic byte write + package validation
       ├── artifact metadata registration (existing core state)
       └── thread activity (existing)
   → workspace-bound file (`thread.worktreePath ?? project.workspaceRoot`)
```

No new layer was added for the sake of the diagram: the registered toolkit registry already answers
discovery, the transport already answers routing, and the handlers already answer execution.

## 5. Tool Source of Truth

| Question          | Single authoritative answer                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool definition   | The `Tool.make` declarations in `apps/server/src/mcp/toolkits/office/tools.ts`, registered once on the one MCP server                                                                                 |
| Tool availability | Live facts: the harness must reach the MCP endpoint, and the session credential's capability set must include `office`. Reported through `HarnessCapabilityView.workspaceTools`, derived at read time |
| Tool permission   | The existing boundary: bearer credential + capability check, plus `Tool.Readonly`/`Destructive` annotations as accurate client hints. No second permission language                                   |
| Tool result       | The handler's typed `success` schema; the artifact metadata row is the durable trace, the file itself stays on disk                                                                                   |

There is deliberately no tool catalog table, no marketplace, and no persisted snapshot of which
tools exist: `HarnessCapabilityView.workspaceTools` is one derived state, not an enumeration of tool
names, so adding a tool never migrates data.

## 6. Tool Availability / Capability

- New capability value `"office"` in `McpCapability`, granted to every session alongside
  `pull-requests` (`McpSessionRegistry.issue`, `ProviderService.agentAccessCapabilities`) because
  office tools are workspace-contained by construction. A call without it fails with the existing
  `McpCapabilityUnavailableError`.
- `HarnessCapabilityView` gained one field, `workspaceTools: supported | unsupported | unknown`,
  derived from live session facts — no persisted snapshot, no per-tool rows.
- A harness that cannot speak MCP simply never calls these tools. Nothing pretends otherwise, and no
  provider-specific workaround was written.
- Phase 3's briefing now carries that single derived fact (`- Workbench tools: …`) instead of a tool
  dump, so a briefing does not grow with the tool surface.

## 7. Permission Model

Unchanged boundary, made explicit:

- Server-side authorization is the bearer credential plus its capability set.
- Every tool declares truthful MCP annotations. `office_inspect` and `office_read_range` are
  `Readonly: true`; every writer is `Readonly: false`; all seven are `OpenWorld: false`, because
  nothing on this surface reaches the network (asserted by test).
- Destructive-by-overwrite is prevented **by construction**, not by a new approval framework: a
  write refuses to replace an existing file unless the caller passes `overwrite: true`, and the
  refusal is a structured, actionable error.
- Errors are differentiated: `OfficeToolTargetNotFoundError`, `OfficeWorkspaceViolationError`,
  `OfficeUnsupportedFormatError`, `OfficeFileTooLargeError`, `OfficeInvalidArgumentsError`,
  `OfficeOverwriteRefusedError`, `OfficeOutputInvalidError`, `OfficeDocumentUnreadableError`,
  `OfficeThreadNotFoundError`, `OfficeSaveFailedError`, plus the existing capability error. Messages
  are written for a model to read and correct, for example
  `Cannot use ../outside.xlsx: the path is absolute or escapes the workspace root.` Lower-level
  detail is never presented as the message.

## 8. Workspace Boundary

Every office path goes through `WorkspacePaths.resolveRelativePathWithinRoot` against
`thread.worktreePath ?? project.workspaceRoot`, then through a second, filesystem-level check:

- Reads resolve the target's real path and reject anything landing outside the canonical root.
- Writes resolve the nearest existing path component and walk each existing component from the root
  down, so a symlink or Windows junction **inside** the workspace cannot redirect a write outside it.
  A missing tail component is fine: nothing below a missing component can exist.
- Absolute paths, drive-letter paths, UNC paths, `..` traversals, and mixed separators are rejected
  before any filesystem work.
- Reads are capped at 1 MiB (`OFFICE_MAX_INSPECT_BYTES`), matching the existing workspace read cap.
- Nothing defaults to `C:\`, a home directory, SSH keys, a browser profile, or system config.

## 9. Office Build-vs-Reuse Decision

| Format | Spec's declared stack   | Purpose-built JS option                                                         | Chosen                                              |
| ------ | ----------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| DOCX   | python-docx (+ COM)     | `docx` 9.7.1 (MIT, 4.6 MB, 6 deps)                                              | OOXML subset on `fflate` + `@xmldom/xmldom`         |
| XLSX   | openpyxl / ExcelJS      | `exceljs` 4.4.0 (MIT, **21.8 MB**, 9 deps, dormant since 2023)                  | same                                                |
| PPTX   | python-pptx + PptxGenJS | `pptxgenjs` 4.0.1 (MIT, 2.6 MB, generation only — cannot open an existing deck) | same                                                |
| PDF    | MarkItDown + pdf-lib    | `unpdf` (2.0 MB) for text; `pdf-lib` (18.6 MB, 4 deps) for editing              | hand-written minimal writer + best-effort extractor |

Why this route:

- It is the only option that satisfies the phase's own constraints: no Python runtime or sidecar
  (the repo has none), no Microsoft Office requirement, Windows-headless, deterministic in tests.
- Two MIT dependencies with **zero transitive dependencies** (~1.2 MB combined) against ~21–27 MB and
  ~20 direct dependencies for the purpose-built route.
- Byte-level control matters for the preservation requirement: the writers mutate existing parts in
  place (offset splicing on DOM-derived spans) instead of re-serialising a whole part, so untouched
  bytes, attributes, namespaces and sibling parts survive exactly.
- The cost is honest and recorded in §19: we own a deliberately narrow OOXML subset.

Rejected during the audit: `xlsx`/SheetJS on npm (unmaintained there, two open advisories with no
npm fix), `fast-xml-parser` (6 transitive dependencies; `@xmldom/xmldom` is zero-dependency),
LibreOffice/`soffice` (not installed; not a core dependency), OCR, and Office COM/GUI automation.

## 10. DOCX Support

`office_document_write` (create + edit) and `office_inspect`.

- Create: `title` plus `paragraphs`, emitting `[Content_Types].xml`, `_rels/.rels`,
  `word/document.xml`, its rels, `word/styles.xml` (Normal + Heading1-3 so headings render), and
  `docProps/*` when a title is given.
- Inspect: paragraph text with runs concatenated (`w:tab` → tab, `w:br`/`w:cr` → newline), a
  heading outline from `Heading*` styles, table content as table → row → cell text, bounded by
  `maxItems`/`maxTextChars` with `truncated`.
- Edit: `append-paragraph` (optional heading level), `replace-paragraph` (0-based index over the
  non-empty paragraphs `inspect` returns), `append-table`. Appends land immediately before the
  body-level `w:sectPr`, so section properties stay last.
- Preservation: existing packages are edited in place; the targeted `<w:p>` keeps its original
  `<w:pPr>`, so numbering, styles, images, comments and other parts survive. Asserted by a
  hand-built fixture with `<w:numPr>`, a `Quote` style reference, custom rels, styles, numbering and
  a media file, all verified byte-identical or exactly-once after an edit.

Not supported (documented, not silently ignored): track changes, section/header/footer editing,
image insertion, fields, list numbering semantics, nested tables as body items, style fidelity
beyond the emitted stylesheet.

## 11. XLSX Support

`office_inspect`, `office_read_range`, `office_spreadsheet_write` (create + edit).

- Tab order is read from `xl/workbook.xml` joined to `xl/_rels/workbook.xml.rels` — never part
  order (proven with a fixture whose first tab resolves to `sheet1.xml` after `sheet2.xml`).
- Reads shared strings (including rich-text runs), inline strings, numbers, booleans, `t="str"` and
  `t="e"`; a cell carrying `<f>` returns the formula with a leading `=` plus its cached value.
  Sparse rows/columns are handled by `cell/@r` address. Ranges accept `A1:C10`, `B2`, and `A:C`; an
  oversize range returns the visible slice with `truncated: true` rather than failing.
- Create: minimal valid package with a required `xl/styles.xml`; text is written as inline strings,
  numbers as numeric cells.
- Edit: `append-row`, `write-cells` (arbitrary addresses, created when missing, ordered, no duplicate
  `r`), `add-sheet`. Formulas are stored as `<f>…</f>` and are **not evaluated**.
- Preservation: the existing worksheet part is spliced in place. `<cols>`, `<sheetViews>`,
  `<sheetPr>`, `<sheetFormatPr>`, `<autoFilter>`, `<mergeCells>`, `<conditionalFormatting>`,
  `<dataValidations>`, `<pageMargins>`, `mc:Ignorable`, comments parts, workbook, rels and content
  types all survive; `<dimension>` is rewritten only when it no longer covers the data. Comments and
  CDATA are masked before markup scanning so text inside them cannot be edited by mistake.

Not supported: VBA, pivot tables, charts, external links, cell styling/widths/merges, date and
number formats (values are the raw cached text), formula evaluation, and shared-formula follow-up
(a `<f t="shared">` follower without its own text reports `formula: null`).

## 12. PPTX Support

`office_presentation_create` and `office_presentation_add_slide`.

- Slide order comes from `p:sldIdLst` resolved through `ppt/_rels/presentation.xml.rels`, not
  filename order. A minimal master, one title/content layout and a minimal theme are emitted so real
  PowerPoint can open the deck.
- Inspect returns the slide count and, per slide (1-based, presentation order), its title (from the
  title/ctrTitle placeholder) and all text-frame paragraphs, each bounded.
- Add-slide allocates a unique `p:sldId@id` (≥ 256), a free part name, a content-type override and a
  presentation relationship. Replace-slide-text rewrites only that slide's text body.
- Preservation: other shapes (verified with a picture shape and its `r:embed`), other slides, rels
  and media parts stay byte-identical after an edit.

Not supported: animation, SmartArt, embedded media, notes slides, theme fidelity, placeholder
geometry, and arbitrary fidelity editing of an unfamiliar deck.

PDF is covered in §19 rather than pretending it is a first-class Office format here:
`office_pdf_create` writes plain-text pages and `office_inspect` extracts text best-effort.

## 13. Artifact Registry Integration

- Each successful write registers the file through the existing `CanonicalThreadCoreState` registry
  with a workspace-relative path, using the existing free-form type vocabulary:
  `document`, `spreadsheet`, `presentation`, `pdf`.
- Re-writing an already-registered path **updates** the existing row (matching the
  `UNIQUE (thread_id, workspace_relative_path)` constraint) instead of inserting, and reports
  `created: false`.
- Only metadata is stored. No document bytes, no cell data, no extracted text enters the database.
- No second registry exists: there is no `OfficeArtifactRegistry`.

## 14. Handoff Integration

Phase 3's handoff protocol was **not** modified. The integration is by construction: the briefing
already lists registered artifacts and one derived capability fact, so a harness that creates
`cleaned.xlsx` and `summary.docx` and then hands off produces a briefing that names both files. The
only Phase 4 addition to that path is the single `workspaceTools` capability line.

Each tool call also appends one `kind: "office.tool"` thread activity with `tone: "tool"` carrying
tool name, workspace-relative path, artifact id, outcome and a bounded detail string — never file
contents, cell values or bytes.

## 15. Persistence / Migration

**No migration was added.** Nothing in Phase 4 needs a new table:

- Tool definitions and availability are code plus live session facts, not data.
- Tool configuration needs none: the toolkit is fixed and registered unconditionally; there is no
  enable/disable setting, no timeout setting, and no per-project tool configuration. Had a knob been
  needed, it would have gone into existing `ServerSettings` — not a `tools.sqlite` or
  `office-config.json`.
- Handoff history already lives in thread activities; artifact metadata already lives in
  `thread_artifacts`; the audit trail for a tool call is one activity row.

`Migrations.ts` is unchanged by this phase.

## 16. Dependencies Added

Two new direct dependencies on `apps/server`, both MIT, both with **zero transitive dependencies**
(verified against the registry before install, and confirmed in the installed tree):

| Package          | Version | Unpacked | Why                                                                                      |
| ---------------- | ------- | -------- | ---------------------------------------------------------------------------------------- |
| `fflate`         | 0.8.3   | ~778 KB  | ZIP container read/write for the OOXML packages and PDF stream inflation; 0 dependencies |
| `@xmldom/xmldom` | 0.9.12  | ~430 KB  | Namespace-aware XML parsing for OOXML parts; 0 dependencies                              |

Alternatives audited and rejected: `fast-xml-parser` 5.11.1 (clean, but 6 transitive dependencies),
`jszip` (`MIT OR GPL-3.0-or-later` dual licence, 4 dependencies, non-deterministic entry timestamps),
`docx`, `exceljs`, `pptxgenjs`, `pptx-automizer`, `xlsx`/SheetJS (`@e965/xlsx` republish),
`write-excel-file`/`read-excel-file`, `mammoth`, `pdf-lib`, `unpdf`, `@zip.js/zip.js`. The audit's
Build-vs-Reuse section records the reasoning; no Office GUI, OCR, or Python dependency was added.

## 17. Tests

Regression Baseline Capture (Phase 3 to Phase 4):

Command:

```
.\node_modules\.bin\vp.CMD test run packages/contracts/src/handoff.test.ts apps/server/src/orchestration/decider.handoff.test.ts apps/server/src/provider/capabilityView.test.ts apps/server/src/coreState/CanonicalThreadCoreState.test.ts apps/server/src/persistence/Migrations/053_CanonicalThreadCoreState.test.ts apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts apps/server/src/provider/Drivers/GenericAcpDriver.test.ts apps/server/src/provider/Drivers/GenericAcpDiagnostics.test.ts apps/server/src/provider/Layers/GenericAcpAdapter.test.ts
```

Result: 48 passed, 0 failed, 0 skipped (9 files)

Phase 4 command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/mcp/toolkits/office
```

Result: 53 passed, 0 failed, 0 skipped (5 files: docx 13, xlsx 13, ppt 10, pdf 9, workspace-guard 8)

Phase 4 command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/mcp/toolkits/office apps/server/src/mcp/McpHttpServer.test.ts apps/server/src/mcp/McpSessionRegistry.test.ts apps/server/src/mcp/McpInvocationContext.test.ts apps/server/src/mcp/McpDeviceToolkit.test.ts apps/server/src/mcp/toolkits/pullRequests
```

Result: 75 passed, 1 failed, 0 skipped (11 files)

The single failure is pre-existing and unrelated:
`McpHttpServer.test.ts > saves the snapshot PNG on request and reports its path` asserts that a
Windows path appears inside the JSON text content, but the serialized content escapes backslashes
(`C:\\Users\\…`) so `toContain` misses. That file is unmodified in this phase, and the same test
fails on the pre-Phase-4 tree.

Phase 4 command:

```
.\node_modules\.bin\vp.CMD test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts packages/shared/src/composerContextReferences.test.ts packages/contracts/src/orchestration.test.ts apps/web/src/components/chat/handoff.logic.test.ts
```

Result: 153 passed, 0 failed, 0 skipped (4 files: reactor 69, orchestration contracts 58, composer context 17, web handoff logic 9)

Typecheck (affected package, not repo-wide):

Command:

```
.\node_modules\.bin\vp.CMD exec tsc --noEmit -p apps/server/tsconfig.json
```

Result: 350 errors, 0 of them in any Phase 4 file. Every remaining error is pre-existing and lives in
`apps/server/src/server.test.ts` (missing `CanonicalThreadCoreState` in its layer stack) and
`apps/server/src/project/AgentSessionImporter.test.ts` (the same missing service). Both files are
untouched by this phase and fail on the pre-Phase-4 tree; fixing them is a test-harness change that
does not belong to Office work, so it is recorded here rather than done silently.

What the Phase 4 tests actually cover:

- Tool Bus: the office toolkit registers exactly seven stable tool names on the shared MCP server;
  `office_inspect` is refused without the `office` capability; annotations are truthful
  (read-only for readers, world-closed for all seven).
- Workspace boundary: absolute paths, drive-letter paths, UNC paths, `..` traversal, nested
  traversal and mixed separators are all rejected with `OfficeWorkspaceViolationError`; a real
  symlink inside the workspace pointing outside is refused for both read and write and nothing is
  created through it; an over-limit file is refused as `OfficeFileTooLargeError`; an unsupported
  extension is refused before any filesystem work.
- Atomic write: a refused overwrite leaves the previous bytes intact; a failed validation leaves the
  previous bytes intact and cleans up its temp directory (temp removal is the scoped cleanup on
  failure, not a leftover).
- DOCX: create → re-open and read exact paragraph texts; append keeps prior paragraphs and puts the
  new one last; append-table round-trips rows and cells; replace-paragraph changes exactly one;
  caps mark `truncated`; non-ZIP input throws; numbering/styles/media/unrelated parts survive an edit.
- XLSX: create two sheets and read both back; formula cells return `=…`; append-row preserves prior
  rows; write-cells updates a non-adjacent cell without disturbing neighbours; range reads
  (`A1:B2`, single cell, whole column) and truncation on a 5000-row sheet; tab order follows
  relationships, not part order; unknown sheet and non-ZIP input rejected; `<cols>`,
  `<conditionalFormatting>`, comments and workbook parts survive an edit byte-identically; text is
  written as inline strings and numbers as numeric cells.
- PPTX: create two slides and read titles/bodies back; add-slide becomes the third slide with the
  first two intact; replace-slide-text leaves the other slide untouched; a picture shape and
  unrelated parts survive; caps truncate; non-ZIP input throws.
- PDF: create two pages and extract the exact text per page; escaping and long-line wrapping
  round-trip; non-PDF input throws; an unreadable page yields `""` rather than failing; bounds
  truncate page text.
- Every generated package is re-opened as a ZIP and its parts parsed as well-formed XML, with
  `[Content_Types].xml` checked to cover each emitted part extension — the only independent
  structural validation available on a machine with no Office and no LibreOffice.

## 18. Regression Status

- Generic ACP (driver, diagnostics, adapter): PASS.
- Provider session mapping and current-mapping selection: PASS.
- Core state, migration 053, capability view: PASS.
- Phase 3 handoff: contracts, decider, briefing, and the full `ProviderCommandReactor` suite
  (69/69) PASS with the new capability field and office toolkit registered.
- MCP: session registry, invocation context, device toolkit, pull-requests toolkit PASS
  (`McpSessionRegistry` expectations were updated for the always-granted `office` capability).
- Office: 53/53 PASS.

## 19. Known Limitations

- **PDF is the narrowest format.** `office_inspect` extracts text best-effort: no OCR, no images, no
  encryption, no form fields, no embedded fonts, no object streams (PDF 1.5 compressed objects are
  invisible because the cross-reference is not read), no LZW/ASCII85/DCT filters, and no ToUnicode
  CMap decoding, so non-Latin-1 text comes back as raw bytes. `office_pdf_create` writes plain-text
  Latin-1 pages only. PDF _modification_ — which `MASTER_SPEC.md` assigns to `pdf-lib` — is **not**
  implemented, and neither is MarkItDown-based extraction. Adopting either means either a Python
  sidecar (forbidden by this phase's brief) or `pdf-lib` (18.6 MB, 4 dependencies). Recorded as a
  deliberate, reversible decision rather than an oversight.
- Office fidelity is not claimed anywhere. There is no Word/Excel/PowerPoint renderer on this
  machine, so validation is structural (re-open, parse, content types, byte-preservation of
  untouched parts) plus round-tripping through our own reader. Excel's own "repair" behaviour on an
  unfamiliar workbook is not measurable here.
- The readers and writers support the documented subsets only. Charts, pivots, SmartArt, track
  changes, macros and complex layout are preserved when untouched but are not understood or edited.
- Numbers and dates in XLSX come back as their raw cached text; there is no number-format or date
  interpretation, and formulas are never evaluated.
- The office toolkit has no UI of its own beyond what MCP clients show; there is no Settings surface
  for enabling/disabling it or tuning limits, because the phase brief asks for minimal UI and the
  capability is granted like `pull-requests`.
- Tool invocations are recorded as thread activities only. There is no tool metric, no per-call
  duration histogram, and no tool-call id correlation with provider transcripts.
- No browser/computer-use verification was run; the project requires explicit authorization for it.
- Platform faults inside the office guard are collapsed to defects (`Effect.orDie`) so that a
  transient filesystem error cannot masquerade as a modelled tool error. That keeps the tool's error
  channel honest at the cost of a crash log rather than a structured message for that class of
  failure.

## 20. Files Changed

New — server (office toolkit under `apps/server/src/mcp/toolkits/office/`):

- `tools.ts` — the seven `Tool.make` declarations, result schemas, artifact reference, handler input
  types derived from the declarations
- `handlers.ts` — the toolkit handlers: capability + workspace resolution, artifact registration,
  activity recording, atomic commit
- `workspace.ts` — the workspace-bound file access: string containment + realpath walk, read cap,
  atomic byte write with pre-commit validation
- `xml.ts` — OOXML XML helpers on `@xmldom/xmldom`
- `docx.ts`, `xlsx.ts`, `pptx.ts`, `pdf.ts` — the format readers/writers
- `errors.ts` — the structured tool error union and the workspace identity type

New — tests:

- `workspace-guard.test.ts`, `docx.test.ts`, `xlsx.test.ts`, `ppt.test.ts`, `pdf.test.ts`

Modified:

- `apps/server/src/mcp/McpHttpServer.ts` — register the office toolkit
- `apps/server/src/mcp/McpInvocationContext.ts` — add the `office` capability
- `apps/server/src/mcp/McpSessionRegistry.ts` — grant `office` to every session
- `apps/server/src/mcp/McpSessionRegistry.test.ts` — expectations for that grant
- `apps/server/src/provider/Layers/ProviderService.ts` — grant `office` alongside `pull-requests`
- `packages/contracts/src/coreState.ts` — `HarnessCapabilityView.workspaceTools`
- `apps/server/src/provider/capabilityView.ts` and its test — derive `workspaceTools`
- `packages/contracts/src/handoff.ts` and its test — carry `workspaceTools` as one derived fact
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — report `workspaceTools` in the
  handoff briefing's capability view
- `apps/server/package.json`, `pnpm-lock.yaml` — the two dependencies

Docs:

- `docs/spikes/PHASE4_IMPLEMENTATION_AUDIT.md` (new)
- `docs/spikes/PHASE4_REPORT.md` (this file)

Two files were created and then consolidated during the work and are worth noting for reviewers:
`apps/server/src/mcp/toolkits/office/workspace.test.ts` was replaced by
`workspace-guard.test.ts` (the tests now exercise the real guard directly and include the symlink
case). No stray file remains.

## 21. Git Diff Summary

Phase 4 adds one MCP toolkit (four format modules, workspace guard, XML helpers, tool declarations,
handlers, error model), five test files, one capability value plus one derived capability field
threaded through the registry, the provider service, the capability view, and the handoff briefing,
and two dependencies. No migration, no new table, no new tool protocol, no new transport, no
per-provider Office code, no new UI surface, and no new settings store.

All uncommitted Phase 1, Phase 1.5, Phase 2, and Phase 3 changes were preserved untouched: no
commit, push, tag, reset, clean, checkout, restore, or stash was executed against working-tree
content at any point (the one `git checkout` in this session restored a file this session had itself
just modified, `apps/server/src/server.test.ts`, returning it to its original committed state).

## 22. Phase 5 Readiness

Phase 5 (Browser, reusing Playwright MCP) has a usable foundation: a working MCP Tool Bus that
already carries capability-gated, workspace-bound, activity-recorded tools; a proven pattern for
registering a new toolkit; a documented capability grant path; and artifact metadata that a browser
recording or downloaded file could be registered into.

Two things Phase 5 will need that Phase 4 deliberately did not build: an out-of-process or
long-lived helper (Playwright MCP is a separate process, and the repo already has a precedent for
this in the device hub's spawned daemon with an HTTP+token transport), and a decision about
per-session browser profiles versus T3's existing preview/browser settings.

Phase 5 has **not** been started. No browser, knowledge/RAG, model-gateway, marketplace, or workflow
work was done in this phase.
