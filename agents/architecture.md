# architecture

everything in this document is subject to change. it is a design proposal covering the stack, layout, ownership, dependencies, runtime boundaries, and data handling.

revise it when a better design fits the product. explain the reason and tradeoffs, check the relevant product and security requirements, and keep affected code, contracts, and guides aligned.

## runtime

host lanes as one cloudflare deployment: a static browser client, a worker for server behavior, and d1 for application data. use a scheduled worker entry for bounded recurrence or template work when its timing rules require it.

the browser client is designed around react and typescript. dependency versions belong in the package manifest and lockfile. build and test commands belong with their executable configuration.

## ownership map

```text
src/
  web/
  worker/
  modules/
    accounts/
    tasks/
    boards/
    history/
    transfer/
  ui/
  styles/
migrations/
wrangler.jsonc
```

each path groups code by its owner. create internal folders when their responsibilities need them.

| owner               | responsibility                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `web/`              | browser startup, routes, application shell, and screen composition                                 |
| `worker/`           | server startup, http and scheduled entry points, environment loading, and dependency wiring        |
| `modules/accounts/` | owner session, connected google accounts, oauth, token refresh, and reconnection                   |
| `modules/tasks/`    | google task lists and tasks, application task metadata, mutations, scheduling rules, and sync      |
| `modules/boards/`   | board grouping, layout, filters, calendar presentation, and board templates                        |
| `modules/history/`  | storing and reading confirmed changes and observed external changes                                |
| `modules/transfer/` | parsing and validating imports, exports, sheets access, and account transfers                      |
| `ui/`               | context-independent visual primitives                                                              |
| `styles/`           | shared visual tokens and base rules                                                                |
| `migrations/`       | ordered changes to the d1 schema                                                                   |
| `wrangler.jsonc`    | shared local and ci defaults; personal deployment values belong in ignored `wrangler.deploy.jsonc` |

## inside an owner

keep browser-safe models and contracts with their owner. browser components, client requests, server commands, persistence, and provider access have different responsibilities even when they belong to the same module.

tasks separates models and contracts, components, client queries and mutations, scheduling rules, and server commands, queries, persistence, google access, and sync. this describes responsibilities; it does not require a folder or an interface for every item.

task recurrence belongs with the task lifecycle. list templates belong with tasks; board templates belong with boards. the calendar presents the same tasks and schedules used by the other views.

## dependency direction

composition can join concrete parts. a route delegates behavior to its owner; it does not grow a second implementation of the rule.

- boards can compose task queries, commands, and presentation. tasks do not depend on board layout.
- transfer calls the owning task or board commands. it does not write another owner's tables.
- task server code uses accounts for authorized google access and history for change recording.
- history does not perform task mutations. accounts does not depend on task or board models.
- shared ui does not import application modules. module-specific cards, icons, and formatting stay with their owner.
- cross-owner imports use explicit contract or operation files. one module does not reach into another module's repository or provider implementation.

keep the google tasks adapter under the task owner, oauth under accounts, and sheets behavior under transfer. extract a shared transport capability only when its behavior is actually shared.

## browser and server

the browser can consume browser-safe contracts, models, components, and its http client. it cannot import server modules, credentials, database bindings, or server environment values.

server code does not import browser components or depend on the currently selected account in the ui. resolve the owner session and the connected account on the server for each operation.

enforce these directions with import checks that cover the actual source paths and aliases used by the project.

## data ownership

google is authoritative for the task fields its api supports, including titles, notes, completion, scheduled day, and ordering. d1 owns board organization, labels, priorities, stars, dependencies, scheduled time, application repeat rules, account connections, task mappings, sync state, and history. the [specs](../specs/index.md) define the behavior these owners must provide; the storage and source layout here remain proposals.

the task owner combines those records into the view consumed by the browser. google response shapes stay at its adapter boundary. account identity must travel with task references, queries, mutations, sync state, and history; provider ids alone are not an account boundary.

google's task api records a scheduled day, but cannot read or write its scheduled time. it also lacks native repeat-rule, star, and reminder fields. application scheduling must be described honestly in other google clients. see the [task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).

## changes, sync, and history

task commands own changes made through lanes. imports, templates, and calendar edits use those commands so they follow the same validation and history rules.

record confirmed outcomes. a click or an optimistic ui change is not proof that google accepted a mutation. google and d1 do not share a transaction; define how interrupted operations are recognized and reconciled before claiming reliable writes.

sync belongs inside the task owner. it reconciles external changes with the local view. an observed google edit must not be fed back into an outgoing write merely to record it.

history distinguishes a change made through lanes from a change discovered during sync. discovery time is not the exact time or full sequence of external edits. google does not provide an audit trail to backfill. d1 backups are separate from product history.

## entry points to keep discoverable

keep the exact paths for browser startup, worker startup, oauth start and callback, owner access checks, commands, scheduled work, schema migrations, bindings, secrets, and build and deploy commands discoverable from their owning guide and configuration.

keep environment parsing in one server entry. pass the dependencies an owner needs. keep database queries with their data owner.
