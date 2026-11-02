# product

lanes is an open-source, personal workspace for google tasks. each person can host their own instance on cloudflare and connect their own google accounts.

## use

an instance has one owner. that owner can connect several google accounts, work with their tasks, and keep the workspace's additional organization and history in their own cloudflare account.

keep the main workspace direct. common edits should take few steps, account ownership should be visible, and connection state should be understandable.

## scope

| area | included |
| --- | --- |
| tasks and lists | create, edit, complete, reopen, and delete; notes, subtasks, ordering, movement, and list duplication |
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

- define whether columns represent google task lists, application statuses, or a chosen view. that mapping determines what moving a card changes; the folder layout does not select one.
- define recurrence and template timing through completion rules, time zones, missed runs, and expired connections.
- define what history records, how long it is retained, and how application-owned data can be carried to another installation.
- define accepted import formats, field mappings, and failure behavior for each format.

these choices require explicit product decisions. do not turn an example from a discussion into an assumed requirement.
