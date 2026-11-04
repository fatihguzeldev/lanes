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

create ordinary tasks inline in their destination list. a title and enter are sufficient; successful creation leaves the input ready for another task. escape closes the input without silently discarding an unsent draft. additional fields belong to task details. there is no global create action that silently chooses a list.

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

moving a top-level task between columns moves it between google lists in the same account. confirm the destination account/list in the command. a subtask can move to another eligible parent or become top level; its destination parent must be in the destination list.

moving a parent carries its subtasks. treat a provider move's descendant behavior as an integration check: verify the returned tree and mapping before claiming success. if google requires several requests, execute a resumable grouped operation and expose partial state. never implement movement as a silent copy followed by destructive deletion.

preserve lanes identity, labels, priority, star, time, repeat rule, dependencies, and recorded history on movement. update list mappings and provider ids from confirmed responses. a move does not reset a task's scheduled day or completion.

account-to-account movement is outside this command. offer the explicit source-preserving [transfer](../portability/spec.md#account-transfer) flow instead. cross-board movement within an account chooses a destination list; moving the list itself belongs to boards.

## labels, priorities, and stars

labels belong to an account. each has a name and a color; tasks may carry up to 20. require a trimmed name of 1–64 characters and compare names case-insensitively for uniqueness within that account. preserve the chosen spelling. renaming a label keeps its identity; deleting it removes associations without deleting tasks. this per-task bound keeps editing, rendering, and import requests bounded.

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
