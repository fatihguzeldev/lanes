# engineering

## organization

keep tests beside the behavior they verify. extract a shared component when its meaning is shared across uses.

use explicit cross-owner imports and local relative imports inside a small owned unit. avoid pass-through index files and broad barrels that mix browser and server exports.

keep application composition in `web/`, generic browser infrastructure in `client/`, and feature workflows under their module owner. an owner's `client/` and `components/` files cannot depend back on the shell. see the [ownership map](architecture.md#ownership-map) for the dependency direction.

when moving a unit, move its tests and local styles, then update every consumer. check test mock paths, dynamic imports, and `new URL(..., import.meta.url)` worker references as well as static imports. do not leave a compatibility file that hides the old ownership.

validate user input, imported data, configuration, and provider responses at their entry boundaries. use one predictable error shape at the browser/server boundary. make account expiry, validation failures, provider failures, and interrupted writes distinguishable.

## changes

keep behavior changes, structural cleanup, dependency upgrades, and formatting separate when they can be reviewed independently.

for structural refactors, preserve the existing request schemas, permission checks, account scope, receipt identities, commit boundaries, and failure recovery. compare extracted functions with their original bodies and run the existing behavior tests. add focused coverage where a new seam exposes a previously untested contract; do not weaken assertions to accommodate a move.

prefer the platform and the dependencies already in use. a new dependency should have a concrete purpose, an understood runtime and bundle cost, and a compatible license.

avoid speculative provider frameworks, event buses, package splits, and abstractions with no current consumer.

## verification

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

stop processes started for a finished check when they are no longer needed.

## free-plan constraints

bound list reads, imports, exports, and sync work. avoid polling every account continuously or recording unchanged task snapshots on each sync. choose indexes for actual queries.

free-plan quotas are shared with other applications on the same cloudflare account. read the current [workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [worker limits](https://developers.cloudflare.com/workers/platform/limits/), and [d1 limits](https://developers.cloudflare.com/d1/platform/limits/) before making deployment or capacity claims.

use meaningful failure states when a quota is reached. a feature must not depend on silently enabling billing.

## documentation

keep personal paths, private project history, and chat transcripts out of public guidance.
