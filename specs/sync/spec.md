# sync

sync reconciles google tasks with lanes' local projection and makes interrupted work understandable. it does not promise a transaction across google and the database.

## ownership and authority

sync belongs to the task owner. task commands own mutations; sync reads provider state, advances operation records, and repairs confirmed local projections. accounts owns token access and refresh. history accepts confirmed outcomes and external observations without sending task writes back to google.

google owns its supported task/list fields. lanes owns organization, task metadata, operation records, and history. a sync must not replace a lanes label or repeat rule with a missing field from a google response.

the durable operation record is authoritative for what lanes attempted and confirmed. a browser spinner, an in-memory lock, a cron tick, or a cached task is not proof of a completed write.

## foreground refresh

refresh the selected account on initial workspace entry, explicit refresh, and return to a tab whose data is at least 60 seconds old. coalesce overlapping refreshes for that account. rate-limit repeated manual refresh requests to avoid one click per network call.

prioritize list inventory and the visible board's tasks. return cached projections promptly with their freshness and coverage. fetching another page must not hide already loaded content. after a confirmed mutation, update the affected projection and invalidate relevant queries rather than resyncing every account.

do not continuously poll idle accounts. background reads serve tracked repeat occurrences and admitted work; they are bounded and fair across eligible accounts. there is no full-workspace real-time synchronization promise.

## reading provider state

follow every required page token. a list inventory is complete only after all its pages succeed. track task coverage per list, including completed/hidden coverage, independently from the list inventory.

use provider update filters where supported, with an overlap window and resource-version deduplication. query deleted, hidden, completed, and assigned states deliberately; default api filters are not a complete task inventory or history. commit a checkpoint only after its page's records are durably processed. interrupted page work is safe to replay.

refresh full list inventory on account entry and list-changing operations when stale. perform a bounded full task reconciliation periodically while an account is in use, and after reconnect or a suspected mismatch; store its cursor across requests. an incremental watermark does not replace eventual full reconciliation.

google enumeration is not a snapshot across pages. before treating a missing resource as deleted, confirm its absence or a provider deletion signal at the correct address. a partial scan, denied request, or moved task at an old address is not sufficient. keep unresolved mappings visible as stale rather than retiring their metadata.

externally moved tasks cannot always be matched to old lanes identities when google changes addresses without a stable mapping. do not infer identity from equal titles or notes. preserve an in-app move's known mapping; otherwise report the observed disappearance/new resource honestly and retain historical references.

the first successful import of an existing google account establishes a baseline. it does not generate a creation event for every old task or claim to reconstruct earlier history. see [history](../history/spec.md).

reference provider behavior in [task listing](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list) and [list enumeration](https://developers.google.com/workspace/tasks/reference/rest/v1/tasklists/list). verify filters and pagination against live controlled data before using them as deletion evidence.

## mutation contract

each submitted command carries an operation identity, explicit account/resource references, validated input, and the revision the editor used. bind an operation identity to one owner and canonical input hash. the same identity/input returns the existing outcome; the same identity with different input is a conflict.

admit work durably before sending a provider mutation. capture required quota reservations, source revisions, destination, and batch input at admission. two browser requests must not both send the same admitted step merely because they arrive at different worker instances.

use durable compare-and-set state and bounded execution claims. an expired claim does not authorize blind replay of an already dispatched provider request. resolve its outcome first. serialize dependent steps and competing commands for a resource; unrelated accounts need not share one global lock.

| state              | meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| accepted           | validated and durably admitted; no completed result yet               |
| running            | a bounded step is being executed                                      |
| succeeded          | required outcomes and local records are confirmed                     |
| partial            | some batch/grouped steps succeeded and remaining work is known        |
| reconnect required | progress needs renewed account authorization                          |
| blocked by limit   | progress needs available capacity or explicit input changes           |
| uncertain          | a provider request may have succeeded; automatic repetition is unsafe |
| failed             | a definite failure with no further automatic execution scheduled      |
| cancelled          | unsent remaining work was cancelled; confirmed output remains         |

after google confirms a write, persist its returned identity/version, task projection, metadata changes, operation progress, and history intent together where they share the local database. use an idempotent history write if recording crosses an owner boundary. if local persistence fails, repair from the recorded response or reconciliation; do not resend creation to repair history.

operation identities have a documented replay lifetime. retain receipts or reject expired identities so an old retry never becomes a new create after cleanup. unfinished or uncertain operations cannot be pruned merely because a terminal receipt retention period elapsed.

## conflicts

metadata uses a local revision and an atomic compare-and-set update. for provider fields, send a narrow patch against the known provider version where conditional requests are supported. never use a wildcard condition to conceal a stale editor.

a stale revision returns the current confirmed values and identifies the conflicting fields. retain the draft and let the owner refresh or explicitly reapply. do not automatically replace a newer title/note with the old editor's full resource object.

google exposes etags, but support for conditional behavior must be verified for each mutation used. see [google's performance guidance](https://developers.google.com/workspace/tasks/performance). where a method lacks an effective precondition, a read-before-write narrows the race but does not make external editing serializable. document that ceiling and reconcile the returned result; do not promise complete protection against concurrent google-client edits.

## uncertain outcomes

a timeout or worker interruption after dispatch does not mean failure. record uncertainty and preserve the operation's reservations and input.

- for a known-resource patch, read back the authoritative fields/version before deciding whether a retry is needed. distinguish an accepted intended state from a conflicting external edit.
- for deletion, confirm provider absence at the correct identity/address before marking it complete.
- for creation, an identical title or note is not proof of identity. use a confirmed returned id or another verified provider-supported correlation mechanism. lanes does not insert an operation marker into task notes or assume google accepts client-generated task ids.
- when an ambiguous create cannot be matched safely, stop automatic creation and present the candidate results and explicit resolution. the owner may identify the created resource or deliberately authorize a fresh attempt after inspecting the risk of a duplicate.

the product guarantee is durable intent, deduplicated local execution, and visible uncertainty. it is not provider-side exactly-once creation. scheduled templates, repeating tasks, imports, and duplication use the same rule.

## retries, partial work, and cancellation

retry safe reads and definitively rejected retryable writes with exponential backoff, jitter, a persisted next-attempt time, and provider retry guidance. cap immediate attempts; do not hold a request open through a long backoff. refresh an expired access token once through accounts; invalid refresh pauses for reconnect.

distinguish authorization, permissions, validation, missing resources, conflicts, daily rate limits, storage limits, provider outages, and uncertain outcomes. a `403` or `429` alone is not enough to identify a storage quota.

persist batch progress by stable item identity. resume remaining items in the same destination, not a fresh copy of the entire input. cancelling prevents unsent steps and leaves confirmed output in place. cancellation cannot undo or recall a request already dispatched.

do not roll back a partial import or template by deleting created google content automatically. offer the owner enough references to inspect or delete confirmed output through ordinary explicit actions.

## browser/server contract

return a consistent error envelope with a stable lowercase code, readable message, request/operation reference, retryability, and field details where useful. no tokens, raw provider response bodies, or stack traces in browser errors.

use distinct codes for `unauthenticated`, `forbidden`, `validation_failed`, `conflict`, `not_found`, `reconnect_required`, `permission_required`, `list_limit_reached`, `provider_rate_limited`, `storage_unavailable`, `provider_unavailable`, and `outcome_uncertain`. map them consistently to http responses and operation states; a failed request must not be returned as ordinary successful task data.

collection queries are paginated, default 50 and maximum 100 records per page. return explicit next-page/coverage/freshness information. bulk commands accept at most 10 normalized records and 64 kib of input per request, and can reduce a chunk further for runtime limits. a single valid task must fit the accepted envelope.

the browser may show optimistic edits with a pending marker. reconcile against the operation outcome. reload retrieves admitted work from the server; it does not replay a forgotten browser queue. connection failure preserves only an unsent editor draft and disables submission until the server is reachable.

## free-plan work bounds

run large work across resumable requests or scheduled slices. allow at most 10 provider http requests in a slice, including refreshes, and fewer when needed to fit worker cpu, subrequest, and database limits. this is an upper bound, not proof that ten requests always fit.

scheduled ticks select a bounded indexed set of due work and advance a persisted fairness cursor. avoid scanning every task, fetching every connected account, or keeping a permanent worker alive. prioritize an already partial run before admitting another run for the same schedule.

measure cpu on the deployed free plan; waiting on google is not the whole cost. large-file parsing belongs in a browser worker, while the server independently validates bounded normalized chunks. quotas may stop the worker before an application-specific error page can render.

## acceptance

- `sync-01`: partial pagination and interrupted reconciliation do not delete unseen lists/tasks or advance a checkpoint past unprocessed data.
- `sync-02`: local metadata survives google refresh; observed changes do not generate outgoing echo writes.
- `sync-03`: repeated operation input returns one result; changed input under the same identity is rejected.
- `sync-04`: concurrent workers, expired claims, and browser retries cannot blindly dispatch the same uncertain create.
- `sync-05`: a crash before dispatch, after google acceptance, before local commit, and after local commit each leaves a defined recovery path.
- `sync-06`: stale editor conflicts preserve drafts and provider fields outside the requested patch.
- `sync-07`: ambiguous creation stops automatic retries; equal titles cannot auto-resolve identity.
- `sync-08`: a partial batch resumes remaining items; cancelling leaves confirmed output intact.
- `sync-09`: expired grants, rate limits, storage limits, outages, and uncertainty produce distinct states without continuous retry.
- `sync-10`: stale coverage is visible, work remains bounded on the free plan, and old operation replay cannot create new content after receipt cleanup.
