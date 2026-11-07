# tasks

the task owner provides one task model to the board, calendar, search, history, templates, and portability. those consumers do not keep competing versions of task behavior.

## data and ownership

| field                                                                                      | authority                                            |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| title, notes, list, parent, sibling order, completion, scheduled day, provider update time | google tasks                                         |
| labels, priority, starred state, dependencies                                              | lanes                                                |
| scheduled time, time zone, repeat rule and occurrence identity                             | lanes, under [planning](../planning/spec.md)         |
| cached provider values and sync revision                                                   | task owner projection, under [sync](../sync/spec.md) |

every reference includes its connected account. keep a stable lanes identity and an explicit provider address. cross-list moves must preserve metadata and history even if the provider returns a different id. google response objects do not become public browser contracts.

lanes metadata is stored separately from task notes. do not insert hidden syntax into notes or reinterpret user text as labels, repeat rules, or dependencies. metadata is visible in lanes and its supported exports; it does not become a native google feature.

## create and edit

the list's add-a-task action opens a new row with its task editor already expanded: focus the empty title and expose notes and optional detail controls in the same place. it has no separate approval button. enter in the title, its close control, or an outside click submits a nonblank draft once and closes after admission captures its receipt. a pristine empty entry closes without creating a task; escape cancels an unsubmitted creation draft. validation or failed admission keeps the draft available for correction. nested menus and dialogs remain part of the editor. there is no global create action that silently chooses a list.

after admission closes the editor, keep the submitted task visible as a local row while its save runs. replace it when a fresh list read after confirmation settles, without showing both rows or requiring a page reload. other tasks and the list's add action remain available. failed or uncertain saves use the existing error and receipt flow without resubmitting creation.

open a task in its row, with its title selected for editing and notes immediately available. schedule, metadata, dependencies, and checklist controls reveal their own fields when requested. keep a retained non-modal editor when its card is outside the current view; changing presentation must not remount its draft or abandon a submitted save. closing or navigating away still applies the unsent-draft guard.

clicking outside an editor requests the same close as its close control. clicks in its nested menus or an open dialog do not discard the editor. icon-only detail actions show their meaning on hover and keyboard focus, in addition to their accessible names.

an admitted save continues when its editor closes. keep its operation identity and account fixed while it drains; a later result cannot close another editor or clear that editor's unsent input. a hidden save that needs recovery appears in the workspace's save status.

task menus contain secondary actions. completion remains on the task's checkbox rather than a duplicate menu item. show each row's options control on hover or keyboard focus, and keep it available on devices without hover.

- require a nonblank title, at most 1,024 characters. trim outer whitespace when the owner submits it. notes allow up to 8,192 characters and preserve line breaks.
- create an open task in a selected list, at the end of the manual sibling order unless an insertion position was explicitly chosen.
- notes are plain text. changing a title or note does not reset other fields or replace unrelated provider values.
- a patch changes only the submitted fields. distinguish an omitted field from an explicit clear.
- retain unsent input while a save fails. do not dismiss an editor or show saved until its operation has a confirmed outcome.
- tasks discovered with an empty title remain visible with a presentation fallback. do not rewrite external data merely to satisfy lanes' creation validation.

use the [google task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks) for provider field capabilities. google status values map to open and completed; columns are lists, not additional task statuses.

## completion and reopening

completing an ordinary task sets its provider completion state and timestamp. reopening clears completion. completed tasks leave the open section and remain available in the completed section, history queries, and exports.

when completing a parent with open subtasks, state how many will also complete and confirm that combined action. capture any repeat successor input before changing the children's states. complete children through the same commands before completing the parent. if a step fails, show the actual partial result; do not invent a transaction spanning google requests.

reopening a parent does not silently reopen completed children. reopening a child under a completed parent also reopens the parent so the open child remains reachable. show both changes and record both confirmed outcomes.

completing a blocked task requires explicit confirmation; see dependencies. recurring task completion and reopening follow [planning](../planning/spec.md#completion-and-the-next-occurrence). a template or import containing completed tasks is not a live completion action and does not trigger recurrence.

## subtasks

support one visible level: a top-level task and its direct subtasks. do not allow self-parenting, cycles, a parent in another list, or a subtask becoming a parent without first being promoted. preserve provider data that cannot be represented; show an explicit unsupported state rather than flattening it silently.

subtasks have their own title, notes, completion, dates, and lanes metadata, and may be reordered among siblings. the parent card exposes their open/completed count. a matching subtask in search remains associated with its parent.

promoting a subtask to top level and nesting an eligible top-level task use provider movement. nesting a task with children requires an explicit reorganization first; do not discard or silently flatten them.

google documents additional restrictions on assigned and native repeating tasks, and a limit of 2,000 subtasks per parent. do not offer an operation the provider forbids; preserve the task and explain the restriction. see [task movement](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/move).

## ordering and movement

manual order belongs to the provider among siblings. use the provider's positioning operations, not lexical guesses about task titles or locally generated position strings.

lifting a task starts its visual movement immediately. the held card follows the pointer while surrounding tasks move smoothly to make room. crossing lists preserves its expanded checklist and metadata. keep this gesture local: pointer movement does not submit commands, refresh provider data, or change provider positions. respect reduced-motion preferences.

release validates the task's identity, current eligibility, list order, and final position before queuing a move. dropping onto the dragged task or back into its existing sibling position is a no-op: do not dispatch a provider move or change its revision. cancelling the gesture or releasing outside an eligible destination restores its prior placement without submitting work.

an eligible drop updates the displayed order immediately while saving online. keep this pending presentation separate from confirmed provider positions. allow further drops while earlier moves save, serialize their provider work, and capture each move against the confirmed state when its turn starts. this queue is limited to the current browser session; it is not an offline outbox.

keep a confirmed move's displayed placement until fresh source and destination reads acknowledge their reconciled order. a definite failure restores confirmed placement and discards later unsent moves that depended on it; earlier confirmed moves remain. an uncertain result stops that dependent queue and exposes its operation receipt for checking, without automatically submitting the move again.

moving a top-level task between columns moves it between google lists in the same account. confirm the destination account/list in the command. a subtask can move to another eligible parent or become top level; its destination parent must be in the destination list.

the move menu reuses the workspace's loaded boards and current-board lists, including their paging controls. opening it does not refetch known destinations or wait for a task preflight. read an unvisited board's lists when its submenu opens. after a destination is chosen, validate the current task and its complete tree before capturing the move; closing the menu cancels an unfinished preflight, while an admitted save keeps running.

moving a parent carries its subtasks. treat a provider move's descendant behavior as an integration check: verify the returned tree and mapping before claiming success. if google requires several requests, execute a resumable grouped operation and expose partial state. never implement movement as a silent copy followed by destructive deletion.

preserve lanes identity, labels, priority, star, time, repeat rule, dependencies, and recorded history on movement. update list mappings and provider ids from confirmed responses. a move does not reset a task's scheduled day or completion.

account-to-account movement is outside this command. offer the explicit source-preserving [transfer](../portability/spec.md#account-transfer) flow instead. cross-board movement within an account chooses a destination list; moving the list itself belongs to boards.

## labels, priorities, and stars

choose task labels in a compact anchored picker, with search and removable selected chips in the editor. priority has its own control. opening either control does not expand a generic details form, and an empty label selection shows no quota counter. label selection remains part of the task draft until that task is saved.

label creation and management stay in an anchored menu beside the task. account switching waits for pending label writes, including writes whose menu has closed. label names use inline editing: enter or leaving a changed nonblank name saves it, and escape cancels the draft. label colors apply from the shared picker without a save form. retain submitted writes when the labels view closes; failures keep the draft and explain the error.

labels belong to an account. each has a name and a color; tasks may carry up to 20. require a trimmed name of 1–64 characters and compare names case-insensitively for uniqueness within that account. preserve the chosen spelling. renaming a label keeps its identity; deleting it removes associations without deleting tasks. this per-task bound keeps editing, rendering, and import requests bounded.

task rows expose a direct star control immediately before their options menu. unstarred controls appear on row hover or keyboard focus; starred controls remain visible. touch keeps the control visible. reserve its space so interaction does not shift the title, and use the accent without a separate hover tile or tooltip.

quick stars and completion toggles preview immediately without disabling either control. serialize their online saves in click order and read the current task when each action starts, rather than reusing the clicked row's revision. confirmation for blocked tasks and checklists remains required. cancellation, failure, an uncertain save, or handoff to the recurring-reopen workflow drops later unsent actions for that task and restores their confirmed presentation; unrelated tasks can continue. queued work belongs to the current account and browser session. leaving the account waits for it; reload does not replay an unsent queue.

priority is one of none, low, medium, or high. starring is an independent boolean. both are lanes metadata and do not claim to set google's native star. default to no priority, no labels, and not starred.

metadata-only edits can be confirmed during grant expiry or a temporary google outage if the owner session and server are usable and the task is still retained. an explicitly disconnected workspace remains read-only until relinked. mark provider data stale. deletion, due-day edits, and other provider-backed actions remain unavailable without valid provider access.

## dependencies

a task may be blocked by up to 50 other tasks in the same account. the initial picker searches the current board; existing edges survive later movement into another board. cross-account edges, self-dependencies, and cycles are rejected. cycle validation and edge changes share one serialized graph revision so concurrent additions cannot create a cycle that neither request saw.

a task is blocked while at least one existing blocker is open. completed blockers remain listed but do not block. reopening one blocks it again. a confirmed deleted blocker stops blocking; a missing record in an incomplete sync must not be treated as deleted.

show the blockers and the tasks this task blocks. changing one edge updates both views. completing a blocked task asks for confirmation and can proceed after explicit override. dependencies do not prevent editing, rescheduling, movement, or deletion.

deleting a blocker retires the active edge without rewriting old history. a dependency belongs to a specific task occurrence: completing a repeating blocker does not retarget dependants to its successor. copied tasks remap only dependencies inside the copied set.

dependencies are advisory for completion and explicit for organization. lanes stores the graph outside notes and rejects cycles to avoid an unusable dependency graph.

## deletion and bulk actions

task deletion requires confirmation and identifies any included subtasks. deleting a parent deletes its subtree; do not silently promote children. confirmed deletion stops its lanes recurrence and retires active metadata while retaining history for its retention window.

deleting all completed tasks is a separate confirmed list action. use the same per-task outcome rules and report partial deletion. do not substitute google's hide/clear operation while claiming permanent deletion.

there is no history-based version restore or guaranteed trash recovery. a stale view of a deleted task cannot recreate it by sending an edit.

## provider restrictions and limits

google currently documents 20,000 non-hidden tasks per list and 100,000 tasks per account. these are provider bounds, not promised lanes capacity. apply available preflight information, preserve all existing data, and handle a provider refusal explicitly. see [task insertion](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/insert).

tasks assigned from docs or chat can appear in a connected account. assignment creation, routing, and collaborators remain outside scope. display provider-backed content and permit only supported ordinary edits. explain before deletion when it also deletes the original assignment in its source product. do not add an assignment ui.

native google recurrence cannot be managed through the tasks api. lanes must not report its own repeat metadata as a native rule or claim it can reliably detect every native rule.

## dependencies and failures

accounts supplies authorization; sync owns operation and reconciliation rules; history records confirmed task events. boards and planning consume task operations. templates and transfer call them instead of writing task records directly.

validation leaves the draft intact. stale revision conflicts offer refresh and explicit reapplication. failed provider actions preserve the confirmed model. partial parent/subtask operations name each completed and remaining step. metadata failure after google acceptance remains repair work, not a reason to send the provider action again.

## acceptance

- `tasks-01`: title and notes validation respects limits and preserves unicode, line breaks, and unrelated fields.
- `tasks-02`: completion, reopening, and parent/child transitions agree across kanban, calendar, search, and completed-task browsing.
- `tasks-03`: parent completion failure after some children complete exposes that partial result accurately.
- `tasks-04`: nesting rejects cycles and invalid parents; keyboard actions can perform the same moves as dragging.
- `tasks-05`: a cross-list parent move preserves the complete tree, metadata, and history, including provider id changes.
- `tasks-06`: labels remain account-scoped; priority and star do not alter notes or claim native google support.
- `tasks-07`: dependency cycles are rejected; completion and reopening update blocking; confirmed deletion removes active blocking.
- `tasks-08`: completing a blocked task requires an explicit override, including from a bulk operation.
- `tasks-09`: provider errors and stale ids never turn an edit or move into a new task or a destructive fallback.
- `tasks-10`: assigned-task restrictions, native-repeat movement refusal, task storage exhaustion, and ambiguous writes preserve data and show the actual limit.
- `tasks-11`: dropping onto the same task or unchanged sibling position produces no provider mutation and preserves the task's revision and fields.
- `tasks-12`: rapid drops update presentation immediately while provider moves run serially; failed or uncertain moves stop dependent unsent work and preserve confirmed outcomes.
- `tasks-13`: a lifted task follows the pointer and siblings move to make room before release. hover and cancellation submit no work; only a validated changed drop enters the move queue.

- `tasks-14`: opening task details edits the existing row without a modal. optional fields appear on request; failed saves keep the same draft, including when its card leaves the visible collection.
- `tasks-15`: outside dismissal preserves the unsent-draft guard and nested menus; an admitted hidden save continues independently without closing or clearing a newer editor.
- `tasks-16`: adding a task opens its full editor in the list, without an approval control. enter or leaving captures one creation with all chosen fields; empty entries make no request, invalid input survives, and failed admission cannot lose its draft to the same outside navigation.
- `tasks-17`: opening move destinations uses the workspace's loaded topology without duplicate reads or a source-validation wait. paging remains available; unvisited board lists load on demand. selecting a destination validates fresh source revisions and checklist coverage, and a cancelled preflight cannot submit from a late reply.
- `tasks-18`: rapid stars and completion clicks remain interactive and save serially against fresh task revisions. failed or uncertain work stops later unsent changes to that task, preserves earlier confirmed changes, and exposes its error or receipt. closing a row or changing views does not drop admitted work; leaving an account or unloading cannot silently abandon queued changes.
