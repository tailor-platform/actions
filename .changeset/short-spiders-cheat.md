---
"tailor-platform-actions": minor
---

Add `lockfile-audit`, `lockfile-audit-fix`, and `lint-github-actions` actions.

- `lockfile-audit`: regression-only gate against `pnpm-lock.yaml` changes — fails only when a change introduces a security advisory that wasn't already present at the base commit, so pre-existing advisories elsewhere don't block unrelated PRs.
- `lockfile-audit-fix`: runs `pnpm audit --fix` against `pnpm-lock.yaml` for a standalone scheduled/dispatched workflow, verifying the result installs and reporting what changed (including whether any published package's runtime dependencies were touched). Doesn't commit or open a PR itself — pairs with a caller-provided commit/PR step.
- `lint-github-actions`: runs zizmor's security audit against workflows and action definitions in a single step, so a caller adopts this repo's own supply-chain CI lint baseline without wiring it up manually.
