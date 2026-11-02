# lanes

a self-hosted workspace for google tasks.

## start here

use the [guide index](agents/index.md) to find the guidance for the work. read [product](agents/product.md) and the [architecture proposal](agents/architecture.md) before changing behavior or ownership. everything in the architecture proposal is subject to change.

these guides belong in the repository. keep them aligned with the source and the decisions they explain.

## working agreement

- check the repository, branch, working tree, and existing changes before editing. preserve work already present.
- use the branch requested for the task. inspect repository conventions before creating a branch.
- keep changes uncommitted unless a commit is requested. push, merge, deploy, and publish only when the task authorizes them.
- do not use agent-branded branch names or pull request titles. follow repository history; use a short descriptive name when no convention exists.
- distinguish decisions, proposals, and verified behavior. keep unanswered product questions open.
- keep changes within the requested scope.

## responsibility and context

give each behavior an owner. group code by that owner, then separate responsibilities inside it. document the allowed dependency direction and the browser/server boundary.

read the relevant owner and its consumers before changing a contract. keep contracts, behavior, tests, and documentation in the same change when they need to move together.

share code when the meaning is shared. keep a component's styles and local behavior beside it. make cross-owner imports explicit.

## verification

select checks from the repository's actual commands and configuration. report what ran, what passed, and what could not be verified.

before starting a server, watcher, or other long-running process, check its expected port or command. reuse a matching process.

use source inspection, focused tests, type checking, and builds when they can establish correctness. browser automation is for interaction, layout, responsive behavior, browser apis, authentication, or another runtime concern. simple text and css edits can leave final visual confirmation to the user.

## writing

write documentation in english, with lowercase headings and prose. preserve the spelling of filenames, identifiers, commands, and external values that depend on case, including `AGENTS.md`.

use concrete statements: what owns a behavior, why a boundary exists, what changed, and how it was checked. keep claims close to their evidence. remove filler, sales language, repeated rules, and instructions that have no effect on the work.

keep task status, session notes, and progress reports out of these guides. inspect the working tree and source to establish the repository's state.
