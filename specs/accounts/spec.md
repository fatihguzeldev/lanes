# accounts

one person owns an instance. that person can connect several google accounts without mixing their tasks, credentials, or organization.

## ownership and dependencies

accounts owns the owner identity, sessions, oauth flows, connected-account identities, token storage, refresh, and connection state. other owners request authorized provider access through accounts. they do not read tokens or implement refresh themselves.

read [security](../../agents/security.md), self-hosting, and [sync](../sync/spec.md) with this spec. boards owns each account's main board; accounts must not create task or board records directly.

## instance access

- configure the intended owner's exact google identity before exposing sign-in. deployment can begin with an owner email allowlist, then bind the first matching verified identity to its immutable google subject.
- check issuer, audience, signature, expiry, nonce, and verified email when validating that initial identity. after binding, the subject is authoritative; a changed email does not silently transfer ownership.
- changing the owner requires an explicit installation configuration change and session invalidation. there is no public first-visitor claim or sign-up flow.
- a successful login by another google user fails closed, even if that user is a google oauth test user or a connected account.
- additional accounts are linked only from an authenticated owner session. signing in with a secondary account does not replace the owner.

use server-managed sessions with secure, http-only cookies and an appropriate same-site policy. state-changing requests require same-origin protection. sessions expire after seven days without renewal; signing in again creates a new session. oauth grant expiry and session expiry are separate events.

signing out ends the current browser session and clears private browser state. it does not revoke task access, stop valid schedules, or remove connected accounts. an expired owner session cannot submit work or read operation results.

## oauth client and permissions

use one google cloud project and one web oauth client per installation. each connected account authorizes it separately. keep tokens distinct by immutable google identity.

the chosen setup is an external audience in testing mode. every account granting tasks or sheets access must be a test user. google allows up to 100 test users and expires these testing-mode grants and refresh tokens after seven days. reconnecting is expected behavior, not a reason to publish the oauth app. identity-only sign-in has different google expiry rules; do not describe all google sign-in as a seven-day grant. see [google's audience rules](https://support.google.com/cloud/answer/15549945).

| capability | permission |
| --- | --- |
| owner identity and account identification | `openid`, `email`, `profile` |
| reading and editing tasks | `https://www.googleapis.com/auth/tasks` |
| sheets import/export | incremental permission defined by [portability](../portability/spec.md#google-sheets) |

request offline access for background task work. validate the scopes actually granted. a missing refresh token is not a valid background connection; keep an existing usable refresh token when google legitimately omits a replacement. do not discard working task access because optional sheets consent was declined.

use explicit sign-in, link, reconnect, and optional-permission flows. bind a short-lived, one-use oauth state to its purpose, initiating session where applicable, intended connection, and approved return location. use nonce and authorization-code protections supported by the web flow. accept only the exact configured callback and local return locations.

client secrets and tokens stay on the server. encrypt stored tokens with a key held outside the database. browser code receives a connection summary, never a provider access token. any browser integration that requires a token needs an explicit revision of this boundary.

## connect and reconnect

1. the owner starts linking from the current instance.
2. google lets the owner select the intended account and consent.
3. the server verifies the callback and identity, then stores the grant for that subject.
4. accounts asks the task and board owners to initialize or resume that account's workspace.
5. show the account immediately with loading state while its first sync runs.

linking an already connected subject refreshes that connection; it does not create a second account, duplicate main board, or import another copy of its tasks. a reconnect flow that returns a different subject must not overwrite the intended account's credentials. offer an explicit separate link instead.

reconnect preserves account identity, task mappings, labels, boards, templates, history, and unfinished operations. reconcile provider state before resuming writes whose outcome is uncertain.

## selection

show the active account's email and profile identity in the workspace. every route, query, cache, and operation carries an explicit connected-account reference.

remember the last selected account per browser. selection is local to a tab; other tabs may show another account. this avoids changing the destination under a user editing in another tab. signing out and disconnecting invalidate affected views across tabs.

when switching accounts, keep an in-progress editor attached to its original account and require saving or discarding its unsent draft. a submitted operation continues against its captured account and remains discoverable there. never copy an unsent draft into the newly selected account.

## connection states

| state | meaning and behavior |
| --- | --- |
| connecting | authorization or first initialization is incomplete; do not claim tasks are synced |
| connected | tasks scope and usable credentials exist; normal operations are available |
| reconnect required | grant expired, revoked, or refresh is invalid; show reconnect and pause provider work |
| permission required | an optional capability lacks its scope; task work can remain available |
| temporarily unavailable | google or the network failed; retain credentials and use bounded retry |
| disconnected | the owner removed the grant from lanes; retained workspace data is read-only until relinked |

a provider outage or rate limit must not be mislabeled as expired consent. store the last successful sync separately from connection state. show retained task data as stale when it cannot be refreshed.

## disconnect and removal

disconnect stops new provider work for that account, invalidates queued authorization, and removes its usable credentials. serialize it with account operations: acknowledge it after already-issued provider requests settle or are recorded as uncertain. do not promise to recall a request already sent to google.

attempt provider revocation and report whether it succeeded. google revocation can affect grants associated with the same app; optional sheets permissions must not be treated as an independently revocable token without checking provider behavior. local disconnect still succeeds when remote revocation is unavailable.

preserve workspace metadata and history on disconnect. schedules are paused and retained. no google lists or tasks are deleted. relinking the same subject restores the same workspace.

provide a separate confirmed action to remove the disconnected account's retained local data. it removes its projections, metadata, boards, templates, schedules, history, and operation records after unresolved work is addressed. explain that google data remains. references in another account must not become a deletion cascade or retain access to the removed credentials.

## failures

cancelled consent leaves existing connections intact. a test-user restriction names the account and the google project setup step. an organization policy restriction explains that administrator policy may prevent connection.

invalid state, replayed callbacks, mismatched reconnect identity, missing tasks scope, and unauthorized owner sign-in fail without granting a session or replacing credentials. redact provider diagnostics before showing or logging them.

token refresh for one connection must be serialized or coordinated through durable state. competing worker instances cannot erase a newer refresh result with an older one. an encryption-key problem is an installation error, not a reason to delete tokens or ask every account to reconnect blindly.

## acceptance

- `accounts-01`: an allowed owner signs in; another test user cannot enter the instance.
- `accounts-02`: the owner links two google subjects through one client and each has distinct lists, metadata, credentials, and connection state.
- `accounts-03`: reconnecting a subject preserves its workspace; returning a different subject cannot replace it.
- `accounts-04`: a seven-day tasks grant expiry pauses provider work and exposes reconnect without removing local organization.
- `accounts-05`: denied sheets permission leaves an existing tasks grant usable.
- `accounts-06`: account switching cannot retarget a draft, submitted command, cache entry, or background job.
- `accounts-07`: callback replay, wrong state, wrong audience, and missing owner authorization are rejected.
- `accounts-08`: sign-out blocks private requests; disconnect preserves google data and pauses schedules; explicit local removal affects only its account.
- `accounts-09`: interrupted refresh and disconnect are exercised with concurrent requests, not only a single browser session.
