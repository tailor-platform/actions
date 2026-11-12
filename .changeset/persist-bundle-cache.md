---
"tailor-platform-actions": minor
---

Persist the SDK bundle cache (`.tailor/cache`) across runs with `actions/cache`, so `tailor deploy` rebuilds only the bundles whose sources changed instead of every bundle on every run. `deploy`, `plan`, and `preview-deploy` restore the cache before bundling. `deploy` and `plan` save it right after bundling, even when the deployment fails, on `push`, `workflow_dispatch`, and `schedule` runs of a branch, and only when the bundles changed; pull request runs restore the cache their base branch saved.

This is on by default. Each saved entry counts toward the repository's Actions cache limit. On GitHub Enterprise Server, `actions/cache` must be available on the server like the other github.com actions. Set the new `bundle-cache` input to `false` to turn it off.
