# tailor-platform-actions

## 2.1.0

### Minor Changes

- 82a4b37: Add `lockfile-audit`, `lockfile-audit-fix`, `create-signed-pr`, and `lint-github-actions` actions.

  - `lockfile-audit`: regression-only gate against `pnpm-lock.yaml` changes — fails only when a change introduces a security advisory that wasn't already present at the base commit, so pre-existing advisories elsewhere don't block unrelated PRs.
  - `lockfile-audit-fix`: runs `pnpm audit --fix` against `pnpm-lock.yaml` for a standalone scheduled/dispatched workflow, verifying the result installs and reporting what changed (including whether any published package's runtime dependencies were touched). Doesn't commit or open a PR itself — pairs with a caller-provided commit/PR step.
  - `create-signed-pr`: commits a known, bounded list of file paths via GitHub's Git Data API and idempotently creates or updates a pull request for them, producing Verified (signed) commits with `GITHUB_TOKEN`/a GitHub App token — no `git commit` locally, no third-party action dependency. Pairs with `lockfile-audit-fix`.
  - `lint-github-actions`: runs zizmor's security audit against workflows and action definitions in a single step, so a caller adopts this repo's own supply-chain CI lint baseline without wiring it up manually.
