---
"tailor-platform-actions": minor
---

Add `lockfile-audit` and `lint-github-actions` actions.

- `lockfile-audit`: regression-only gate against `pnpm-lock.yaml` changes — fails only when a change introduces a security advisory that wasn't already present at the base commit, so pre-existing advisories elsewhere don't block unrelated PRs.
- `lint-github-actions`: bundles actionlint (via reviewdog), ghalint, and zizmor behind a single step, so a caller adopts this repo's own supply-chain CI lint baseline without wiring up all three individually.
