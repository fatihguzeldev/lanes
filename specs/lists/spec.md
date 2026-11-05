# lists

a list is one google tasks list. lanes displays it as a column and stores its board placement and appearance separately.

## ownership and dependencies

the task owner owns list identity, provider fields, commands, duplication, and quota admission. boards owns placement, display order, and appearance. transfer and templates use the same creation commands and quota checks as the editor.

read [boards](../boards/spec.md), [tasks](../tasks/spec.md), and [sync](../sync/spec.md). moving a list between boards is a local board operation, not a google copy or a task move.

## create, read, and rename

- create a list in the selected account and target board. capture both before submitting.
- require a nonblank title of at most 1,024 characters, matching the provider field limit. trim outside whitespace on new or edited titles; preserve internal whitespace and unicode.
- allow duplicate titles. identify lists by account and provider id, never by name.
- show creation as pending until google returns the list and lanes records its mapping and placement.
- rename only the provider title. preserve tasks, appearance, board membership, and references.
- new lists discovered outside lanes go to that account's main board, after its existing lists, in a deterministic order.

the board's new-list action becomes an inline name field in the same place. enter or leaving a nonblank field creates the list without a separate approval step. leaving an empty field or pressing escape closes the entry. retain a failed name for correction, and preserve an uncertain operation's captured name, board, account, and receipt identity. enter followed by blur must not create two lists.

load all provider list pages before calling the account inventory complete. an empty or partially loaded page is not evidence that other lists were deleted. see [google's list resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists).

## default list

resolve google's default list by its provider identity, including `@default` where supported. do not infer it from a translated title or the first page's order.

the default list stays on the main board and cannot be deleted through lanes. it may be renamed, styled, reordered within the main board, and used for tasks. show why moving or deleting it is unavailable. this follows the [tasksboard list behavior](https://support.tasksboard.com/lists/create-and-manage-lists/).

## ordering and presentation

dragging a column, or its keyboard/menu equivalent, changes lanes' list order inside its board. it does not rename lists or change google's native list order.

lists show open top-level tasks in manual order by default, with subtasks attached to parents and completed work in a separate collapsible section. task count means open tasks, including subtasks, and is labeled consistently. loading or partial data cannot be presented as a complete count.

temporary sorts can use manual order, scheduled date/time, title, last update, or priority. break ties by manual order and stable identity. sorting is a view preference and must not issue a sequence of google move requests. reorder actions require manual order; switching back restores that order.

## duplication

duplicate creates a new google list in a chosen board of the same account. the original is unchanged. preview the destination, title, task count, and whether completed tasks are included. default to open tasks only.

copy task titles, notes, hierarchy, order, dates, and lanes metadata. preserve completion state for completed tasks explicitly included. when an excluded completed parent has an included open child, copy that parent as open context and show it in preview. give every copy new identities. copy repeat rules as new independent series; an already completed copy must not generate a repeat merely because it was copied.

remap dependencies between copied tasks. omit dependencies pointing outside the copy and report the count before confirmation. do not make the duplicate block or modify original tasks. the board owner applies copied list appearance through its own operation; task duplication does not write board metadata. do not copy history or an original series' occurrence identities.

use the [portability operation contract](../portability/spec.md#execution-and-recovery) for batching, partial results, and resume. duplication consumes one list slot and must pass the same quota admission as a new list.

## delete

deleting a list is a separate action from deleting a board. show its account, title, and task count, and state that google deletes its tasks too. do not provide a misleading history-based undo or recovery promise.

once google deletion is confirmed, remove the active list projection and its board placement, stop dependent task schedules, and retire its active task metadata. retain already recorded history for its retention window. templates previously saved from the list remain independent snapshots.

external confirmed deletion has the same local cleanup. a stale inventory, denied request, or interrupted sync does not count as confirmation. if a create or delete outcome is unknown, follow [sync](../sync/spec.md#uncertain-outcomes) before changing capacity or retrying.

## list quota

lanes admits at most **2,000 google lists per connected account**, across all boards and including lists created outside lanes. this mirrors the [documented google limit](https://developers.google.com/resources/api-libraries/documentation/tasks/v1/python/latest/tasks_v1.tasklists.html). it is not a per-board allowance or a guarantee that google will accept every write below 2,000.

| operation                                                                                  | list slots needed               |
| ------------------------------------------------------------------------------------------ | ------------------------------- |
| empty board creation, board rename, board deletion, moving an existing list between boards | 0                               |
| create or duplicate one list                                                               | 1                               |
| import, account transfer, or template use creating lists                                   | number of new destination lists |
| import into an existing list                                                               | 0                               |

count the last complete google inventory plus admitted creations not yet reflected in it. reserve capacity durably with the operation so two tabs or jobs cannot both claim the same last slot. a confirmed creation converts its reservation into a known list; it must not count twice. an uncertain creation keeps its reservation until reconciled.

refresh a stale inventory before admitting list creation. new lists from another google client can still race that check; google remains the final authority. if the local inventory already exceeds a revised app limit, retain it and block additions rather than hiding or deleting lists.

when a batch needs more slots than available, reject it before creating anything and report required and available slots. when google rejects a batch midway, preserve confirmed results and report the remainder; a preflight cannot promise external atomicity.

at the limit, existing task work and local board organization remain available subject to their own provider limits. deleting a board does not free slots because its lists are preserved. there is no automatic rotation, silent deletion, or relocation into a private archive.

refresh after confirmed list deletion before claiming renewed capacity. do not promise that deleted lists stop counting immediately or that a storage limit resets daily. google rate limits and storage limits are different failures.

## failures

report `list_limit_reached` for local quota refusal or a provider response that identifies list storage exhaustion. report rate limiting separately, with bounded retry when safe. do not classify every google `403` or `429` as a full account.

retain the requested title and destination on validation or provider failure. a failed rename restores the confirmed title. a partially duplicated list is visible with its operation result; retry resumes it instead of silently making another list.

## acceptance

- `lists-01`: creating and renaming a list changes the corresponding google list and preserves board metadata.
- `lists-02`: two lists with the same title remain distinct through sync, movement, export, and deletion.
- `lists-03`: the default list is identified correctly across pages and cannot be moved off the main board or deleted.
- `lists-04`: sorting and column reordering do not rewrite provider list order or task order.
- `lists-05`: duplication preserves hierarchy and selected metadata, remaps internal dependencies, and leaves the source unchanged.
- `lists-06`: with 1,999 known lists, two simultaneous creation attempts cannot both reserve the final slot.
- `lists-07`: a batch requiring three slots with two available creates nothing and reports the mismatch.
- `lists-08`: an external creation racing preflight produces an explicit provider failure without deleting existing content.
- `lists-09`: deleting a board changes neither google list count nor task data; deleting a list requires its own confirmation.
- `lists-10`: incomplete inventory, uncertain creation, and uncertain deletion do not manufacture free capacity.
