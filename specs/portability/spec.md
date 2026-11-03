# portability

the owner can bring tasks in, take them out, copy work between connected accounts, and carry lanes-owned organization to another installation. source data is preserved unless an ordinary destructive action is explicitly requested.

## ownership and dependencies

transfer owns file parsing, normalized import plans, field mapping, sheets access, export formatting, and transfer orchestration. it uses the owning task/board/template/history commands. it does not write their private tables or implement a second mutation path.

accounts supplies account identity and incremental permissions. [sync](../sync/spec.md) owns execution receipts and uncertainty. [lists](../lists/spec.md#list-quota) owns list-slot admission. [security](../../agents/security.md) applies to every file, cell, and provider response.

## supported inputs and bounds

| input                               | supported interpretation                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `.csv`, `.tsv`                      | utf-8 delimited text, optional byte-order mark, quoted multiline cells, selectable header row               |
| `.xlsx`, `.xls`, `.ods`, `.numbers` | selected workbook tables/sheets normalized to rows; values only                                             |
| `.txt`, `.md`                       | headings for lists, lines/bullets for tasks, checkboxes for completion, indentation for hierarchy and notes |
| google takeout `Tasks.json`         | lists, tasks, hierarchy, notes, scheduled days, and completion represented in that export                   |
| google sheets                       | selected tabs/ranges of a spreadsheet authorized through the chosen account                                 |
| lanes workspace archive             | versioned task snapshots and/or lanes-owned metadata described below                                        |

accept at most 20 mib per file. archive-based workbook parsers also cap total decompressed input at 100 mib and reject unsupported/encrypted containers. do not accept an arbitrary zip of files as a task import. bound table dimensions and stop after detecting more than the allowed task count; a workbook's declared empty range cannot allocate unbounded memory.

one task-creation operation imports at most 2,000 tasks, counting subtasks, and creates at most 100 lists. this is a lanes batch limit, separate from the account's 2,000-list quota. a larger source requires selecting a smaller subset or separate explicit operations; do not silently import its first 2,000 rows.

parse complex local files in a browser worker. the server independently validates every bounded normalized chunk. never evaluate workbook formulas, macros, external data links, html, embedded scripts, or takeout links. show cached formula values where present; a formula with no cached value is an unresolved field, not an instruction to execute it.

unsupported workbook variants, encodings, and export versions fail with a concrete reason and an available conversion path. format support needs real representative fixtures, including a real numbers file, not only extension recognition.

## preview and mapping

parsing and preview make no google writes. choose the source account where relevant, destination account, target board/list, included tabs, and grouping before admission. display detected lists, tasks, subtasks, completed tasks, warnings, and required list slots.

support new lists grouped by worksheet, a mapped list column, or one chosen new list. support appending to an existing list without consuming a list slot. never merge into an existing list just because its title matches an imported value.

| field                      | mapping rule                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------- |
| task title                 | required; blank rows are skipped and counted                                            |
| notes                      | plain text with preserved line breaks                                                   |
| list                       | grouping value for new lists; cannot change an explicitly selected existing destination |
| source key / parent key    | input-local identities for hierarchy; never trusted as destination provider ids         |
| subtask column             | legacy parent-title/child-title layout, normalized into explicit parent keys            |
| scheduled day              | iso date by default; explicitly selected date convention for other forms                |
| scheduled time / zone      | optional local time plus valid iana zone; requires a scheduled day                      |
| completed / completed at   | explicit boolean values and optional completion timestamp                               |
| labels / priority / star   | validated lanes metadata, with preview of names and allowed values                      |
| repeat rule / dependencies | supported structured lanes format with input-local references                           |

recognize common headers case-insensitively, including tasksboard-style `Task`, `Subtask`, `Notes`, `Due date`, `Completed`, and `List`. display the resulting mapping and allow changes. do not claim every trello, todoist, or asana export schema is supported without a documented mapping.

in a legacy task/subtask table, a contiguous run of the same parent title within a list defines one parent and its child rows. a later run can define another parent with the same title. preview that grouping; ambiguous or deeper hierarchy needs correction rather than silent title-based merging.

for text/markdown, a heading starts a list. a top-level nonblank line or bullet starts a task; `- [ ]` is open and `- [x]` is completed. one indented bullet level is a subtask; indented plain lines append notes to the preceding task. reject deeper task nesting with line references. do not render or execute markdown html.

takeout parsing preserves hierarchy and completion that are actually present. unknown fields do not become new features. unsupported schema versions fail before admission; do not import all unknown json strings as task titles.

## invalid data

require a title mapping before running. reject invalid hierarchy, cycles, missing parents, over-limit fields, invalid structured rules, and references to a different account. let the owner fix mappings or explicitly exclude offending rows.

skip blank-title rows with a visible count. an unreadable date or unknown optional value produces a row-level warning. importing that task without the field requires accepting the warning in preview; do not drop a date silently. ambiguous numeric dates require a chosen day/month convention rather than guessing per row.

allow skipping completed tasks. if that would omit a parent of an included child, include the parent as open context and show it. imported completed tasks preserve their completion state but do not trigger lanes recurrence. absent source completion timestamps remain unknown. if google assigns a completion time during import, distinguish that import-time value from an original historical completion.

capture the normalized plan when the owner confirms. editing the source file or sheet afterward cannot change the admitted run. repeated preview is harmless; deliberately starting a new import is a new copy operation, even if its file contents match an earlier one.

## execution and recovery

all multi-item creation, including duplication and templates, follows this contract:

1. validate the complete selected plan, target identity, permissions, and known limits before making provider changes.
2. reserve all required list slots atomically and persist an operation with stable source-item keys.
3. create destination containers, then parents, then children, then remapped dependencies in bounded chunks.
4. persist each confirmed destination identity and its local metadata before advancing the item checkpoint.
5. show confirmed, skipped, failed, uncertain, and remaining counts with destination links.

resume the same operation and use its stored destination mapping. do not recreate confirmed lists or tasks. an unknown create outcome blocks that item for the [sync resolution path](../sync/spec.md#uncertain-outcomes), not a fresh whole-file retry.

cancel only unsent remaining work. keep confirmed output and show where it is. do not automatically delete output as rollback, and never delete the source. if preflight passed but google rejects later work, show a partial result; external systems cannot be made atomic by a preview.

staging/progress data is retained while work is resumable. release unused reservations when an operation is definitely cancelled or failed, but keep reservations for uncertain creations until resolved. clean terminal staging data after its replay/receipt contract permits it.

## csv export

export a selected list, board, or selected-account search result, with an explicit include-completed option. preserve the chosen scope, hierarchy, and deterministic order. state whether the export uses refreshed provider data or a stale retained projection.

use utf-8 with a header row, standards-compliant quoting, and one row per task/subtask. columns include `source_key`, `parent_key`, `list`, `task`, `notes`, `scheduled_day`, `scheduled_time`, `time_zone`, `completed`, `completed_at`, `priority`, `labels`, `starred`, `repeat_rule`, `dependencies`, and `order`. keys are export-local references, not authority to edit a live task.

use iso dates/timestamps, explicit booleans, and json arrays/objects inside structured cells. empty optional fields mean absent. the importer recognizes this schema without guessing title-based hierarchy. exclude history and credentials from task csv.

neutralize spreadsheet formula prefixes in textual cells, including `=`, `+`, `-`, `@`, and leading control characters, using a documented text-escape prefix. make that transformation visible in the export explanation and import preview. do not describe csv as a lossless backup of arbitrary text; use the lanes archive for exact text preservation.

page large exports and build the download incrementally. do not load every task into one worker invocation. a provider change during export may produce a mixed-time snapshot; include generation/freshness information and do not claim a transactionally consistent google backup.

## google sheets

use the same normalized preview and mapping for sheets import. the owner pastes a google spreadsheet url or id, selects tabs/ranges, and previews values. do not add a drive browser or require a google picker browser token and extra frontend credentials.

request `https://www.googleapis.com/auth/spreadsheets.readonly` only when importing. explain that this permission can read the account's spreadsheets; entering one url is a product access boundary, not a google-enforced per-file grant. server requests use only the selected spreadsheet and ranges.

for export, request `https://www.googleapis.com/auth/drive.file` incrementally and create a new spreadsheet through the sheets api. this permits files created/authorized through the app without broad drive access. never overwrite an existing sheet by title. write text as raw values so formulas are not executed. see [sheets scopes](https://developers.google.com/workspace/sheets/api/scopes) and [spreadsheet creation](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/create).

the oauth client and server token boundary stay unchanged. enable the sheets api when configuring this capability. no service account, picker key, public sharing, or additional storage service is required by this path.

show the google account used for sheets access separately from the task destination if they differ. both must be connected to the same owner-controlled instance. an arbitrary shared url still needs permission under the selected google account; never fetch it as an unrestricted server url.

task access remains usable if optional consent is declined. revoked/expired sheets access pauses only the sheets operation when task access remains valid. sheets export returns the new file url and retains its operation result; an uncertain spreadsheet creation must not create another file automatically.

## account transfer

transfer means **copy**, with the source preserved. select distinct connected source and destination accounts and the lists to copy. default to all tasks, including completed tasks, and show that choice before confirmation. use the same 2,000-task/100-new-list operation bounds.

create distinct lists on the destination main board, including when equal titles already exist. copy titles, notes, hierarchy, manual order, dates, completion, labels, priority, stars, local times, and lanes repeat rules. remap internal dependencies and omit references outside the selected set with a preview warning. merge destination label definitions by case-insensitive name after showing any color conflict; preserve destination color by default.

list colors, board placement/backgrounds, template schedules, and recorded history are not part of an account transfer. a workspace archive handles lanes organization separately. native google repeat rules or stars not exposed by the api cannot be promised as copied. source active repeat rules remain active; copied rules create independent destination series, clearly shown before confirmation.

source authorization is needed while reading the captured input; destination authorization is needed while writing. losing either does not delete source content or discard confirmed destination progress. this follows the source-preserving baseline in [tasksboard transfer](https://support.tasksboard.com/how-to/transfer-tasks-to-another-account/) with explicit resumable operation rules.

## lanes workspace archive

provide a versioned json archive for a selected account or board. include export-local identities, source google subjects and provider mappings, board/list organization and appearance, task metadata, labels, template snapshots, schedule definitions, preferences, and retained history. allow including task snapshots for a readable, exact-text copy.

no oauth tokens, client secrets, owner sessions, encryption keys, account access, or deployment credentials are exported. account addresses and task data are still personal data; the archive is a private file, not a public share link.

archive generation is paginated and bounded. cap an individual archive at 20 mib, and task snapshots at 2,000 tasks/100 lists per selection. stop with a clear narrower-scope request if it would exceed a limit; do not return a truncated success. metadata-only archives do not consume task-creation quota and can cover more lists within the byte bound.

support two explicit import modes:

| mode                | behavior                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| restore metadata    | reconnect the same google subjects, match verified provider resources, and restore lanes-owned data without creating google tasks |
| copy task snapshots | use ordinary import to create new resources in a selected account; remap included metadata and references; preserve the source    |

metadata restore previews matches, unmatched records, and conflicts. only explicit account mappings are accepted. matching task titles is insufficient. do not create missing provider content or assign another account's metadata as a shortcut. let the owner skip unmatched records or select the separate snapshot-copy mode.

when restoring into an existing workspace, preserve its values by default and require explicit selection of conflicting incoming values. use owning commands and revisions. map board membership so every list still belongs to one board; the destination main board keeps its permanent role. schedules import paused until their targets, authorization, and catch-up choice are confirmed.

history restoration preserves event identity/time and normal retention. unknown future archive versions fail clearly; migrations of older supported versions are explicit and validated before writes. imported task snapshots do not make old history appear to be actions on newly created copies.

an archive is application portability, not an infrastructure restore. database backups, secret preservation, and deployment rollback belong to [self-hosting](../self-hosting/spec.md#updates-and-recovery).

## acceptance

- `portability-01`: each promised input format has representative real fixtures and produces the same normalized plan without running formulas or embedded content.
- `portability-02`: oversized, encrypted, corrupt, deeply nested, and decompression-heavy inputs fail within the stated bounds.
- `portability-03`: preview makes no writes; mappings, ambiguous dates, blank rows, parent context, and omitted fields are visible before confirmation.
- `portability-04`: list/task quota preflight rejects an impossible batch before creation; later provider refusal produces an accurate partial result.
- `portability-05`: interrupting after any created container/parent/child resumes its stored mapping without recreating confirmed output.
- `portability-06`: csv exports hierarchy and structured metadata; formula escapes are explicit and archive text remains exact.
- `portability-07`: sheets import uses only selected ranges; export creates a new spreadsheet with raw values; denied optional scopes preserve task access.
- `portability-08`: account transfer preserves every source record, keeps equal-named destination lists distinct, and remaps copied references.
- `portability-09`: metadata restore makes no google creation/deletion requests, rejects mismatched subjects, and previews conflicts/unmatched records.
- `portability-10`: archives exclude credentials, reject unsupported versions, preserve history retention, and restore schedules paused.
