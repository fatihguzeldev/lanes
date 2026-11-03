# specs

lanes is a personal workspace over google tasks. these specs define its behavior, including the parts stored only by lanes and the limits inherited from google and cloudflare.

read [product](../agents/product.md) for scope and the [architecture proposal](../agents/architecture.md) for a possible implementation. everything in that proposal is subject to change. a spec folder describes a behavior boundary; it does not require a source folder, service, or package with the same name.

## map

| spec                                 | owns the contract for                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| [accounts](accounts/spec.md)         | instance ownership, sign-in, connecting accounts, selection, reconnecting, and disconnecting |
| [lists](lists/spec.md)               | google task lists, list actions, duplication, and the account-wide list quota                |
| [tasks](tasks/spec.md)               | task fields, subtasks, completion, movement, labels, priorities, stars, and dependencies     |
| [boards](boards/spec.md)             | grouping lists, board lifecycle, appearance, views, search, and filters                      |
| [planning](planning/spec.md)         | calendar behavior, dates, times, time zones, and lanes repeat rules                          |
| [templates](templates/spec.md)       | reusable list and board snapshots, application, and scheduled creation                       |
| [sync](sync/spec.md)                 | provider reconciliation, confirmed writes, conflicts, retries, partial work, and freshness   |
| [history](history/spec.md)           | recorded changes, external observations, retention, and completed-task browsing              |
| [portability](portability/spec.md)   | file and sheets import/export, account transfer, and portable workspace metadata             |
| [self-hosting](self-hosting/spec.md) | installation inputs, agent responsibilities, free-plan operation, updates, and recovery      |

## reading and changing a contract

these are intended product contracts, not claims that a provider flow or deployment has passed verification. acceptance criteria describe evidence an implementation must produce.

each spec states its owner, behavior, dependencies, failures, and acceptance criteria. add an open decision only when a real product question remains. do not use that section to defer routine implementation choices.

change the owning spec before changing an observable rule. update affected consumers and acceptance criteria in the same change. keep the reason for a consequential choice beside the rule. keep implementation tasks, session notes, and completion checklists elsewhere.

tasksboard is a behavior reference for the agreed scope. links explain the reference; the rules written here define lanes. lanes deliberately preserves lists when deleting a board, stores its metadata outside task notes, and handles uncertain writes explicitly.

## vocabulary and identity

| term              | meaning                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------- |
| instance          | one installation with one owner and its own cloudflare resources and oauth client         |
| owner             | the google identity allowed to enter and administer that instance                         |
| connected account | a separately authorized google identity whose tasks the owner can manage                  |
| list              | one google tasks list, displayed as one board column                                      |
| board             | a lanes-owned group of lists from one connected account                                   |
| main board        | the account's permanent home for lists without another board                              |
| task              | a google task plus its lanes-owned metadata                                               |
| confirmed         | the responsible system accepted the change and lanes recorded its outcome                 |
| observed          | lanes discovered a provider state during sync; the full external edit sequence is unknown |

google ids are scoped to a connected account. task references also carry the list mapping needed to address google. a title, email address, or browser-selected account is never a resource identity. preserve a stable lanes task identity when google changes a task's address during movement.

## shared product rules

- an instance has one owner. connected accounts do not become additional users.
- boards and lists belong to one connected account. moving a card across accounts is an explicit copy operation in portability.
- google owns fields its tasks api exposes. lanes owns boards and additional task metadata. a cached google value is a projection, not a second authority.
- show which account an operation affects. switching accounts does not retarget work already submitted.
- saving, saved, partially saved, stale, and failed are different states. an optimistic change must not look confirmed after failure.
- app-owned edits still require an authenticated owner and a reachable server. offline editing and an offline mutation queue are outside scope.
- no feature may silently delete source data, overwrite a same-named resource, enable billing, or publish the oauth client.
- provider quotas are constraints, not capacity promises. see [lists](lists/spec.md#list-quota) and [self-hosting](self-hosting/spec.md#free-plan-contract).

## interaction requirements

all scoped actions must be available with a keyboard. drag and drop has a menu or keyboard equivalent. interactive controls have accessible names, visible focus, and understandable disabled and error states. color is not the only way to communicate priority, blocking, account state, or failure.

use confirmation for destructive list/task deletion and for completing a blocked task. name the affected resource and consequence. board deletion explains that its lists move to the main board. routine edits do not need an approval dialog.

render task content as text. notes do not execute html or markdown. external links may open safely, but lanes does not fetch attachments or implement the excluded drive features.

theme supports light, dark, and system preference. use the browser's locale for display and an explicit time zone for scheduling. dates, numbers, and downloaded data must not change meaning with display formatting. visual composition, typography, tokens, and exact shortcuts belong to design; these specs do not choose them.

## engineering and verification

follow [engineering](../agents/engineering.md) for source organization and checks, and [security](../agents/security.md) for credentials and access. test a rule at its owner and the boundary where a failure could violate it. live google and cloudflare checks use controlled data.

build, test, development, migration, and deployment commands are defined by executable repository configuration. do not invent a package command or a provider guarantee in a spec. the self-hosting acceptance criteria require those entry points to be documented when they exist.

implementation choices such as framework versions, table layouts, endpoint paths, and parser libraries remain revisable. the implementation must still satisfy the behavior here or change the relevant contract explicitly.
