# engineering

## organization

group by ownership first, then by responsibility. a clearly named file can live directly in its owner. create deeper structure when there is a real distinction to express.

keep component implementation, styles, and component-specific behavior together. keep tests beside the behavior they verify. extract a shared component when its meaning is shared across uses.

use explicit cross-owner imports and local relative imports inside a small owned unit. avoid pass-through index files and broad barrels that mix browser and server exports. keep contracts with the owner that defines their meaning.

validate user input, imported data, configuration, and provider responses at their entry boundaries. use one predictable error shape at the browser/server boundary. make account expiry, validation failures, provider failures, and interrupted writes distinguishable.

## changes

read the current source before extending it. keep behavior changes, structural cleanup, dependency upgrades, and formatting separate when they can be reviewed independently.

prefer the platform and the dependencies already in use. a new dependency should have a concrete purpose, an understood runtime and bundle cost, and a compatible license. record decisions that future changes will depend on.

avoid speculative provider frameworks, event buses, package splits, and abstractions with no current consumer. use the smallest structure that makes ownership and failure behavior clear.

## verification

use the package scripts and tool configuration in the checkout. keep command documentation aligned with those entry points. report a missing check as a verification limit.

`npm run check` runs formatting, type checking, ownership checks, tests, and the production build. `npm run format` applies the repository's prettier configuration. keep generated files and byte-sensitive fixtures out of formatting changes.

choose checks for the behavior at risk:

| change                                                  | useful verification                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| documentation                                           | read for accuracy, check local links, scope, and repository state                                   |
| task or scheduling rules                                | focused behavior tests, including dates, account identity, and failure cases                        |
| provider access or persistence                          | boundary tests and a narrow integration check with controlled data                                  |
| source organization                                     | type checking, import boundary checks, and the build                                                |
| authentication, drag and drop, or calendar interactions | browser verification of the actual flow                                                             |
| static text or straightforward css                      | source inspection and existing checks; leave final visual confirmation to the user unless requested |

tests should exercise a contract or catch a plausible failure. avoid tests that restate private implementation details. mocks cannot establish that live google consent or a cloudflare deployment works.

before starting a background process, inspect the intended port or command and reuse a matching process. stop processes started for a finished check when they are no longer needed.

## free-plan constraints

bound list reads, imports, exports, and sync work. avoid polling every account continuously or recording unchanged task snapshots on each sync. choose indexes for actual queries.

free-plan quotas are shared with other applications on the same cloudflare account. read the current [workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [worker limits](https://developers.cloudflare.com/workers/platform/limits/), and [d1 limits](https://developers.cloudflare.com/d1/platform/limits/) before making deployment or capacity claims.

use meaningful failure states when a quota is reached. a feature must not depend on silently enabling billing.

## documentation

keep english prose and headings lowercase. preserve case in commands, identifiers, filenames, and quoted external values where it matters.

explain decisions with their consequences. use concrete examples when a rule is easy to misread. distinguish implemented behavior, intended structure, and an unresolved choice.

update the relevant guide when changing an owner, entry point, contract, setup requirement, or product boundary. link to the owning explanation instead of duplicating it. keep personal paths, private project history, and chat transcripts out of public guidance.
