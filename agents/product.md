# product

lanes is an open-source, personal workspace for google tasks. each person can host their own instance on cloudflare and connect their own google accounts.

## use

an instance has one owner. that owner can connect several google accounts, work with their tasks, and keep the workspace's additional organization and history in their own cloudflare account.

keep the main workspace direct. common edits should take few steps, account ownership should be visible, and connection state should be understandable.

## scope

| area | included |
| --- | --- |
| tasks and lists | create, edit, complete, reopen, and delete; notes, subtasks, ordering, movement, stars, and list duplication |
| organization | multiple boards, drag and drop, board and list appearance, labels, priorities, and task dependencies |
| planning | calendar views, dates, times, repeating tasks, and list and board templates |
| history | task changes and completion history |
| portability | file import, csv and google sheets export, google sheets import, and transfer between connected accounts |
| use | search, filters, and multiple google accounts |

file import covers spreadsheet, text, markdown, and google takeout data. each supported format needs explicit field mappings, size limits, and invalid-record behavior.

## outside scope

- mobile and desktop pwa installation, native apps, and offline editing.
- shared lists or boards, collaborators, roles, and task assignment.
- notifications, reminders, completion emails, and notification sounds.
- drive attachments and links, chrome extensions, and ai, voice, or image capture.
- a public api, webhooks, zapier, and chatgpt integrations. the browser still needs its own application endpoints.
- subscriptions, billing, team administration, and a centrally hosted public service.

google sheets remains in scope for portability. removing drive attachments does not remove sheets import and export.

## accounts

each installation uses its own google cloud project and one oauth web client. each connected google account grants access separately; its tasks and credentials stay distinct.

use an external audience in testing mode. every account that will connect must be added to that project's test users. google limits this to 100 test users and expires these authorizations and refresh tokens after seven days. reconnecting each account is part of the product. see [google's audience rules](https://support.google.com/cloud/answer/15549945).

show a reconnect action for an expired connection. preserve board organization and recorded history while sync is paused. an allowed google test user is not automatically an owner of the lanes instance.

oauth production publishing and verification are outside the chosen setup path.

## hosting

the default installation must work within cloudflare's free plan. quotas are a real limit: reaching one can stop work. do not require a paid service or silently upgrade an account to keep a feature running.

use one static web client, one worker, and one d1 database as the baseline. default to a `workers.dev` address and verify the complete personal oauth flow on it.

## behavior contracts

the [specs](../specs/index.md) own detailed behavior and acceptance criteria.

- a column is a google task list. a board groups lists from one connected account; google has no board entity.
- each account has a permanent main board. deleting a custom board moves its lists there and preserves google content. deleting a google list is a separate explicit action.
- lanes admits at most 2,000 lists per connected account across all boards, including externally created lists. imports, templates, and duplication share the same admission rule. no automatic rotation or private archival bypass.
- lanes-owned times and repeat rules are separate from native google scheduling. recurrence, template timing, missed work, and expiry behavior follow the planning and template specs.
- history retains supported confirmed changes and external observations for 90 days. it does not provide title/note versioning or a restore guarantee.
- portability defines formats, mappings, preview, limits, partial recovery, source-preserving account transfer, and credential-free workspace archives.

change the owning spec when a product decision changes. an architecture example or a tasksboard feature outside the agreed scope does not create a requirement.
