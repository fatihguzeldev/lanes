# sync

sync reconciles google tasks with lanes' local projection. google and lanes' database do not share a transaction.

## ownership and authority

sync belongs to the task owner. task commands own mutations; sync reads provider state, advances operation records, and repairs confirmed local projections. accounts owns token access and refresh. history accepts confirmed outcomes and external observations without sending task writes back to google.

google owns its supported task/list fields. lanes owns organization, task metadata, operation records, and history. a sync must not replace a lanes label or repeat rule with a missing field from a google response.

the durable operation record is authoritative for what lanes attempted and confirmed. a browser spinner, an in-memory lock, a cron tick, or a cached task is not proof of a completed write.

## foreground refresh

refresh the selected account on initial workspace entry, explicit refresh, and return to a tab whose data is at least 60 seconds old. coalesce overlapping refreshes for that account. rate-limit repeated manual refresh requests to avoid one click per network call.

prioritize list inventory and the visible board's tasks. return cached projections promptly with their freshness and coverage. fetching another page must not hide already loaded content. after a confirmed mutation, update the affected projection and invalidate relevant queries rather than resyncing every account.

an initialized workspace opens when its current local board and task reads settle; provider refresh continues behind it. combine progress and scheduling status in the foreground step response. coalesce read invalidations until a short refresh settles, or once per ten seconds during longer work. refresh board topology for list changes and task reads for task changes. provider sync does not invalidate local label definitions. a recurrence check with no advancement does not invalidate reads; a lost response may require a conservative reread because work could already have committed.

a foreground request may advance several ready slices within the same invocation. count database and provider calls across the whole request, including session, account, and credential access. reserve enough budget for the next slice and final status before starting it. preserve each slice's durable claim, account access check, guarded commit, and fairness update. yield when the budget, reconciliation work bound, or response deadline is reached; do not hold a request through provider backoff or another worker's claim.

report confirmed browser-visible changes across every committed slice in that response. list appearance, membership, missing-state recovery, task fields, hierarchy, capabilities, and initial coverage recovery can require a reread. advancing scan timestamps, cursors, or bookkeeping revisions alone does not. an unchanged entry refresh does not repeat the local reads already fetched for that workspace. manual refresh and return to a stale tab reread retained local data once after settlement: another client may have committed before this refresh began. preserve conservative invalidation when another worker completes the work or a response is lost.

a successful foreground refresh still resumes admitted repeat work when provider values are unchanged. that check is independent of read invalidation; a no-op result does not reload the workspace.

continue ready work without a fixed browser delay. honor the server's next-attempt time using the session's clock offset. a coalesced or idle response that leaves pending work must wait before trying again. a hidden tab does not dispatch its queued continuation.

retain the visible workspace while a refresh advances. show ordinary synchronization progress in one account-level control rather than repeated loading messages in every list. incomplete or failed refreshes must not report success. actionable failures remain available from that control or the affected action.

do not continuously poll idle accounts. background reads serve tracked repeat occurrences and admitted work; they are bounded and fair across eligible accounts. there is no full-workspace real-time synchronization promise.

## reading provider state

follow every required page token. a list inventory is complete only after all its pages succeed. track task coverage per list, including completed/hidden coverage, independently from the list inventory.

use provider update filters where supported, with an overlap window and resource-version deduplication. query deleted, hidden, completed, and assigned states deliberately; default api filters are not a complete task inventory or history. commit a checkpoint only after its page's records are durably processed. interrupted page work is safe to replay.

provider page size and reconciliation slice size are separate bounds. retain a validated provider page while bounded slices process it, and advance its provider token only after the entire page is committed. persist each slice's offset with its projection writes. discard a retained page if the local projection changed before it resumes. unchanged ordinary tasks may update scan coverage together; moved, deleted, recurring, assigned, and hierarchical tasks retain their reconciliation rules.

the incremental update window overlaps the saved watermark by 120 seconds. an active account becomes eligible for a full task reconciliation after 30 minutes; this eligibility does not create a continuous idle-account poll.

refresh full list inventory on account entry and list-changing operations when stale. perform a bounded full task reconciliation periodically while an account is in use, and after reconnect or a suspected mismatch; store its cursor across requests. an incremental watermark does not replace eventual full reconciliation.

google enumeration is not a snapshot across pages. before treating a missing resource as deleted, confirm its absence or a provider deletion signal at the correct address. a partial scan, denied request, or moved task at an old address is not sufficient. keep unresolved mappings visible as stale rather than retiring their metadata.

when a task appears in another list with the same google id and one prior identity in the connected account, confirm that its old address is no longer available before reusing that lanes identity. preserve its metadata and history, record the observed move, and reconcile the source list again. a stale list page must not recreate the task at its previous address. if both addresses still return live tasks, keep them distinct.

parent and child observations may arrive on different pages. preserve each child's identity, metadata, and provider parent reference while its location is being reconciled; unresolved hierarchy remains read-only until the confirmed destination relationship is available.

externally moved tasks cannot always be matched when google changes ids without a stable mapping. do not infer identity from equal titles or notes. preserve an in-app move's known mapping; otherwise report the observed disappearance/new resource honestly and retain historical references.

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

operation identities have a documented replay lifetime. an identity that has never been admitted expires after 24 hours. finished command request bodies, copied task snapshots, and provider response bodies become eligible for bounded cleanup after 24 hours. retain canonical request and chunk hashes, operation outcomes, input-local mappings, confirmed task identities, revisions, and etags for 90 days so an identical retry can return its existing outcome without retaining old notes. after the receipt window, reject the expired identity rather than treating it as a new creation. unfinished and uncertain operations keep the input and receipts needed for resolution. active recurrence owns its functional baseline separately from command receipt retention.

## conflicts

metadata uses a local revision and an atomic compare-and-set update. for provider fields, send a narrow patch against the known provider version where conditional requests are supported. never use a wildcard condition to conceal a stale editor.

a stale revision returns the current confirmed values and identifies the conflicting fields. retain the draft and let the owner refresh or explicitly reapply. do not automatically replace a newer title/note with the old editor's full resource object.

a move may accept a fresh provider version when google only resequenced an ordinary, unassigned task among its siblings. verify that its identity, parent, title, notes, completion, scheduled day, and hidden state still match the captured task, and that the local task and list revisions remain current. a content or hierarchy change remains a conflict; this exception does not apply to edits or deletion. record the fresh provider version and position in the durable dispatched step before sending the move, so response repair and uncertainty checks use the version actually dispatched.

a confirmed move can change sibling positions and etags beyond the returned task. invalidate task coverage and queue a targeted full order reconciliation for its source and destination lists in the same local commit. the next positioning command waits for that coverage before capturing its predecessor; it must not use stale sibling positions or trigger a full-account refresh instead.

google exposes etags, but support for conditional behavior must be verified for each mutation used. see [google's performance guidance](https://developers.google.com/workspace/tasks/performance). where a method lacks an effective precondition, a read-before-write narrows the race but does not make external editing serializable. document that ceiling and reconcile the returned result; do not promise complete protection against concurrent google-client edits.

## uncertain outcomes

a timeout or worker interruption after dispatch does not mean failure. record uncertainty and preserve the operation's reservations and input.

- for a known-resource patch, read back the authoritative fields/version before deciding whether a retry is needed. distinguish an accepted intended state from a conflicting external edit.
- for deletion, confirm provider absence at the correct identity/address before marking it complete.
- for creation, an identical title or note is not proof of identity. use a confirmed returned id or another verified provider-supported correlation mechanism. lanes does not insert an operation marker into task notes or assume google accepts client-generated task ids.
- when an ambiguous create cannot be matched safely, stop automatic creation and present the candidate results and explicit resolution. the owner may identify the created resource or deliberately authorize a fresh attempt after inspecting the risk of a duplicate.

the owner can also keep a freshly read google state and stop the remaining intent. this is an explicit terminal partial result, not proof of the original request's outcome. preserve the original response receipt, keep separately retained resource identities and metadata separate, and record the stop decision. fence late workers and cancel only unsent steps. an owner-stopped step remains causally uncertain; it no longer keeps automatic work or disconnect draining alive. normal finished-operation retention applies to its request bodies and minimal receipts.

the product guarantee is durable intent, deduplicated local execution, and visible uncertainty. it is not provider-side exactly-once creation. scheduled templates, repeating tasks, imports, and duplication use the same rule.

## retries, partial work, and cancellation

retry safe reads and definitively rejected retryable writes with exponential backoff, jitter, a persisted next-attempt time, and provider retry guidance. cap immediate attempts; do not hold a request open through a long backoff. refresh an expired access token once through accounts; invalid refresh pauses for reconnect.

distinguish authorization, permissions, validation, missing resources, conflicts, daily rate limits, storage limits, provider outages, and uncertain outcomes. a `403` or `429` alone is not enough to identify a storage quota.

persist batch progress by stable item identity. resume remaining items in the same destination, not a fresh copy of the entire input. cancelling prevents unsent steps and leaves confirmed output in place. cancellation cannot undo or recall a request already dispatched.

do not roll back a partial import or template by deleting created google content automatically. offer the owner enough references to inspect or delete confirmed output through ordinary explicit actions.

## browser/server contract

keep progress and recovery with the action that started the work. an import, copy, or template can reopen its saved progress; a task edit reports its own result. durable operation records do not require a permanent operations navigation item or expose internal step names as ordinary product copy. the sync menu exposes unfinished saves after reload, with bounded pages and a link to each saved result or recovery action.

return a consistent error envelope with a stable lowercase code, readable message, request/operation reference, retryability, and field details where useful. no tokens, raw provider response bodies, or stack traces in browser errors.

use distinct codes for `unauthenticated`, `forbidden`, `validation_failed`, `conflict`, `not_found`, `reconnect_required`, `permission_required`, `list_limit_reached`, `provider_rate_limited`, `storage_unavailable`, `provider_unavailable`, `outcome_uncertain`, and `owner_stopped`. map them consistently to http responses and operation states; a failed request must not be returned as ordinary successful task data.

collection queries are paginated, default 50 and maximum 100 records per page. return explicit next-page/coverage/freshness information. bulk commands accept at most 10 normalized records and 64 kib of input per request, and can reduce a chunk further for runtime limits. a single valid task must fit the accepted envelope.

routine edits update their presentation immediately and save through an account-scoped online queue. do not keep their editor open, show per-item saving messages, or disable unrelated controls while a save runs. preserve each queued command's captured input and receipt identity; a busy submission must not silently drop the next one. reconcile optimistic values against the operation outcome and a fresh read. failed or uncertain changes report an error and restore confirmed presentation; dependent unsent work stops. reload retrieves admitted work from the server; it does not replay a forgotten browser queue. connection failure preserves only an unsent editor draft and disables submission until the server is reachable.

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
- `sync-11`: an externally moved task with a verified unchanged provider id keeps its lanes identity, metadata, dependencies, and history across pages; stale source pages and live address collisions do not merge or recreate it.
- `sync-12`: a move accepts an order-only provider change while rejecting changed content or hierarchy; lost responses retain the fresh dispatched version for recovery.
- `sync-13`: confirmed moves schedule source and destination order reconciliation, and later positioning commands cannot capture stale sibling order before it completes.
- `sync-14`: a returning workspace opens after its coherent local read batch while provider refresh remains pending. short refreshes coalesce invalidations, no-op recurrence checks do not repeat reads, and cancelled account generations cannot publish changes.
- `sync-15`: a retained provider page resumes across bounded slices without advancing its cursor early. local revision changes discard the capture, failed commits retain its prior offset, and unchanged-page optimization preserves metadata and history semantics.
- `sync-16`: foreground batching stays within the whole invocation's database and provider bounds, retains completed slices after a later failure, and resumes deferred work. unchanged entry does not duplicate initial reads; manual and stale refreshes coalesce local rereads. coverage recovery and concurrent settlement remain observable. ready browser continuations have no fixed pause and actual backoff is respected.
