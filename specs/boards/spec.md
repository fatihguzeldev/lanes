# boards

a board groups google task lists from one connected account. every column is a list. a board has no separate task-status model.

## ownership and dependencies

boards owns board identity, list membership, column order, appearance, view preferences, search composition, and filters. the task owner owns the lists and tasks being presented. calendar rules belong to [planning](../planning/spec.md); board templates follow templates.

board queries combine task contracts with board metadata. tasks do not depend on board layout. moving a list calls a board operation; moving a task calls a task operation.

## account and main board

each connected account has exactly one main board. it is permanent and cannot be deleted or converted to a custom board. its display name may be customized; its internal role remains stable.

every confirmed list belongs to exactly one board of that account. new externally discovered lists go to the main board. a list never appears in several ordinary boards at once. smart views may present the same tasks without changing membership.

the default google list remains on the main board. ordinary lists may be moved out. an account switch shows only the selected account's boards, with their own ordering, appearance, and preferences.

google has no board entity. creating, renaming, styling, or deleting an empty board sends no task-list creation request. see [tasksboard's model](https://support.tasksboard.com/boards/multiple-boards/) and [moving lists](https://support.tasksboard.com/how-to/move-a-list-to-another-board/).

## board lifecycle

create a blank board with a nonblank title of at most 128 characters. an optional emoji and appearance do not affect identity. duplicate names are allowed, and actions must distinguish boards by identity and account.

rename or reorder a board without changing its lists or tasks. new boards append after existing boards. persist account-owned ordering on the server so another browser sees the same organization.

allow choosing a start board per account and browser. default to the main board. a removed or inaccessible preference falls back to the main board without losing the rest of the workspace settings.

## moving lists

move a list to another board of the same account. remove it from the source and append it to the destination in one atomic lanes change. preserve google identity, content, appearance, task order, and task metadata. allow a deliberate insertion position when reordering within a board.

reject cross-account board references. the default list cannot leave the main board. concurrent moves use a board/list revision so one list cannot acquire two memberships or silently overwrite a newer placement.

moving a list does not create, delete, or move its tasks in google. a disappeared destination fails without removing the source placement.

## deleting a board

deleting a custom board **preserves every google list and task**. move its lists to the account's main board, after the lists already there, preserving their relative order. remove the custom board and reset any local start-board reference.

the membership changes and board removal are one local transaction. if they fail, the original board and membership remain. this action requires no provider write and consumes no list slots.

the confirmation names the board and says where its lists will go. do not offer a checked-by-default option that deletes google content. actual list deletion remains a separate [list action](../lists/spec.md#delete).

pause template schedules targeting the deleted board and show that a new destination is needed. do not silently redirect scheduled creation to the main board. saved board templates remain snapshots.

stop unsent batch steps targeting the removed board. if an already dispatched request creates a google list afterward, preserve that list on the main board, flag the operation as partial, and explain the fallback. this is recovery of confirmed content, not permission to continue the scheduled run against a new destination.

this deliberately differs from tasksboard, whose [board deletion](https://support.tasksboard.com/boards/multiple-boards/) also deletes google lists. preserving tasks is the lanes contract.

## appearance and views

support board colors, an optional emoji, and an optional background image from bundled assets or a user-supplied https image url. keep list colors and names readable in light and dark themes. image loading failure falls back to the chosen color. file uploads, an image hosting service, and an image search integration are not required.

validate image urls and render them only as images in the browser. do not server-fetch arbitrary urls or treat them as executable styles. selecting a remote image causes the browser to contact that host; do not describe it as privately hosted by the instance.

support kanban, stacked-list, and calendar views over the same tasks. remember view choice per board and browser. changing a view does not create records or change task ordering. allow showing task counts and completed sections without altering their contents.

## search

search defaults to the current board. allow an explicit all-boards search within the selected account; never merge other accounts implicitly. search title, notes, label names, list title, and parent title for subtask context. use case-insensitive text matching, preserve unicode, and do not interpret text as a command or require an undocumented query language.

show each match's list and board when it is outside the current board. opening, editing, or completing a result acts on the original task. do not create a search copy.

query a paginated, server-owned task projection. return coverage and freshness with results. if some lists have never synced or a requested completed range is still loading, show incomplete coverage rather than claiming no matches. ordinary search includes open tasks; include completed work only when requested.

## filters and sorts

filters support list, completion, labels, priority, star, dependencies, and scheduled date: overdue, today, a chosen range, or no date. combine different filter types with and; multiple values inside one type use or. labels additionally allow an explicit match-all option. clearing filters restores the unfiltered view.

overdue means an open task's scheduled day is before today in the account's planning time zone. a time earlier today does not make a separate deadline state. date filters include descendants by their own dates and keep parent context visible.

filters and text search combine. show active conditions and a clear action. filtered manual reordering must not silently reorder hidden tasks: disable it and explain how to return to the full manual view. cross-list movement remains available through an explicit destination action.

provide a due-today smart view across the selected account's lists. it groups real tasks by list and includes open tasks scheduled today. the view cannot be renamed or deleted. it consumes no list quota and uses the same edit commands. assignment-based smart views are outside scope.

## persistence and failures

board data is lanes-owned and may be edited while a google grant is expired if the server remains available. display cached task data as stale and keep provider-backed task edits gated by account state.

when a google list is confirmed deleted, remove its active placement. retain history with historical names and context. do not remove an entire board because its last list disappeared; an empty board is valid.

read/write conflicts, missing destinations, and local storage failures keep confirmed organization intact. an empty board, a board with no search matches, a partially loaded board, and a failed board query need distinct states.

## acceptance

- `boards-01`: each account has one main board and every list has one valid membership.
- `boards-02`: creating an empty board and changing its appearance make no google list or task writes.
- `boards-03`: moving a list preserves its provider identity and data; two concurrent moves cannot create duplicate membership.
- `boards-04`: deleting a custom board atomically appends its lists to the main board in order and makes no google deletion request.
- `boards-05`: deleting a destination board pauses affected template schedules instead of redirecting them.
- `boards-06`: switching views, sorting, and filtering preserve task identity and manual provider order.
- `boards-07`: search finds matching subtasks with parent context, stays within the selected account, and discloses incomplete coverage.
- `boards-08`: filter combinations, date boundaries, completed inclusion, and filtered reorder behavior are deterministic.
- `boards-09`: the due-today view edits original tasks and uses no list slots.
- `boards-10`: board operations remain usable with an expired google grant while provider-backed edits show reconnect.
