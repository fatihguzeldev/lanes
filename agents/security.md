# security

## owner and connected accounts

application ownership and a connected google account are separate identities. initial owner sign-in authorizes identity and offline tasks access together. verify the configured owner, granted scope, and usable refresh credentials before saving the initial owner binding, connection, and session. failed onboarding must not partially claim ownership or leave a connection behind. an oauth test-user entry or a successful google identity check alone must not grant ownership.

add secondary accounts only from an authenticated owner session. when connection records already exist, owner sign-in is identity-only and must not restore revoked access or replace credentials. reconnect remains a separate flow.

validate oauth state, callback parameters, token responses, and the identity attached to an account link. use server-managed sessions and appropriate secure cookie settings. handle linking and sign-in as explicit flows.

keep account identity attached to every task operation and lookup. changing a browser-selected account must not let a request access another connection without server authorization.

## credentials

google client secrets, refresh tokens, session keys, and token-encryption keys stay on the server. protect stored tokens with encryption whose key is held separately from the database. preserve the key across ordinary updates and define rotation before changing it.

do not put credentials in client bundles, urls, repository files, task notes, history entries, logs, issue reports, or screenshots. ignore local credential files in git.

exporting workspace data must not export credentials or sessions. a disconnected or expired account must not erase its board organization or history as a side effect.

## external data

treat task notes, provider responses, import files, and sheets values as untrusted input. validate them at their boundary. render text safely, use parameterized database queries, and bound file size, row counts, pagination, and parsing work.

keep import errors separate from accepted records. do not silently delete or overwrite source tasks during an import or account transfer. make destructive actions explicit in the operation's contract.

use the least access needed for the selected feature. google tasks access does not require reading gmail. sheets permissions need their own deliberate scope choice.

## deployment

keep the owner configuration closed during initial deployment. do not expose a public first-visitor ownership claim.

keep secrets out of build output and diagnostic responses. verify callback matching, owner access, and account separation on the deployed instance. prefer dedicated test data for provider write checks.

## reporting

use the repository's published private reporting channel for vulnerabilities. if no private channel is listed, ask the maintainer for one before sending sensitive details. do not invent a contact address or assume private reporting is enabled.

keep credentials and personal task data out of public issues. a public bug report should use a minimal, redacted reproduction.
