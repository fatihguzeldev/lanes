# contributing

read [product](product.md), the [architecture proposal](architecture.md), and [engineering](engineering.md) before changing the application. read [self-hosting](self-hosting.md) for installation work.

## a useful change

pick a concrete problem and find its owner. describe the trigger, the expected result, and the current behavior when there is one. include a small reproduction for a bug.

discuss changes to product scope, ownership, or the free-hosting model before building around them. leave unresolved decisions explicit. a feature existing in tasksboard does not automatically put it in lanes' scope.

keep a change focused enough to review. include the relevant contract, tests, and guide updates. explain a new dependency or a changed boundary where the reviewer can see it.

## commits

use conventional commits: `type: description` or `type(scope): description`. write messages in english and lowercase, preserving case-sensitive identifiers. keep each commit focused on one logical change.

choose a type that describes the change, such as `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`. add a scope when it helps identify the owner. mark breaking changes with `!` before the colon and explain them in a `BREAKING CHANGE:` footer.

```text
docs: require conventional commit messages
fix(sync): preserve uncertain creation results
```

## pull requests

use a short descriptive title. follow repository history as conventions develop. do not introduce agent branding.

describe the problem and resulting behavior, then give the verification and any material limit. for a bug, a before/after example is often enough. screenshots help when the change depends on layout or interaction.

keep the description about the final change. do not paste chat transcripts, long tool logs, or a chronology of abandoned approaches. check generated work yourself before submitting it.

report checks actually run and any that could not run. documentation changes do not need an invented application build.

## review

review behavior, ownership, readability, data handling, and the cost of the change on the free plan. explain a finding with a concrete consequence or example.

keep required fixes distinct from optional suggestions. update the relevant guide when a review results in a lasting decision.

## repository policy

licensing terms belong in the repository's license files. a license change or contributor agreement requires an explicit owner decision.

keep issue and pull request templates, release instructions, and reporting guidance aligned with the workflow they describe. link to the owning guide instead of maintaining a second copy.

agents follow the task's branch and publishing instructions. creating documentation is not authorization to open a pull request or publish it.
