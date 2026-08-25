# tailor-platform-actions

## 2.3.1

### Patch Changes

- 8b996c2: `lockfile-audit-fix` now passes `--config.minimum-release-age-exclude-prune=true` to its verification `pnpm install`, so pnpm itself drops any `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` the freshly-resolved lockfile no longer needs (e.g. a version an earlier fix bypassed the gate for, that a later fix's re-resolution moved away from). Requires pnpm >=11.22.0; a no-op on older pnpm, not an error.

## 2.3.0

### Minor Changes

- 1d4ecc5: `lint-github-actions` now accepts a `paths` input (a space- or
  newline-separated list, forwarded to zizmor), so callers can scope the
  audit to just the workflow/action files changed in a PR instead of always
  auditing the whole repository.

## 2.2.0

### Minor Changes

- c0c7b71: Separate `drift-check` drift findings from execution failures.

  **Behavior change for existing consumers.** Previously, when `tailor setup check --ci` failed for a non-drift reason — expired credentials, a network error, an unloadable config — the action emitted a `::warning::` and the job still passed. It now emits an `::error::` and exits with the check's own status, so these failures surface instead of being reported as a clean canary. Jobs that silently tolerated a broken check will start failing without any workflow change.

  Drift findings themselves stay advisory: they emit `::warning::` annotations and write a step summary without failing the job. Set the new `fail-on-drift` input to `true` to fail on unsuppressed findings.

## 2.1.0

### Minor Changes

- 82a4b37: Add `lockfile-audit`, `lockfile-audit-fix`, `create-signed-pr`, and `lint-github-actions` actions.

  - `lockfile-audit`: regression-only gate against `pnpm-lock.yaml` changes — fails only when a change introduces a security advisory that wasn't already present at the base commit, so pre-existing advisories elsewhere don't block unrelated PRs.
  - `lockfile-audit-fix`: runs `pnpm audit --fix` against `pnpm-lock.yaml` for a standalone scheduled/dispatched workflow, verifying the result installs and reporting what changed (including whether any published package's runtime dependencies were touched). Doesn't commit or open a PR itself — pairs with a caller-provided commit/PR step.
  - `create-signed-pr`: commits a known, bounded list of file paths via GitHub's Git Data API and idempotently creates or updates a pull request for them, producing Verified (signed) commits with `GITHUB_TOKEN`/a GitHub App token — no `git commit` locally, no third-party action dependency. Pairs with `lockfile-audit-fix`.
  - `lint-github-actions`: runs zizmor's security audit against workflows and action definitions in a single step, so a caller adopts this repo's own supply-chain CI lint baseline without wiring it up manually.
