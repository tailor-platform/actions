---
"tailor-platform-actions": patch
---

`lockfile-audit-fix`: support pnpm's experimental lockfile format v13 (`lockfile.format: v13` in `pnpm-workspace.yaml`). With a v13 `pnpm-lock.yaml`, `runtime-deps-changed` and `changed-names` always reported no runtime dependency change, and unused overrides were never pruned from `pnpm-workspace.yaml`. Both now work as they do with the default format. When the format differs between the lockfile before and after the fix, every non-private project that has runtime dependencies is reported as changed. A lockfile that follows the env document pnpm writes when `packageManager` or `configDependencies` is set is now read in both formats; before, `runtime-deps-changed` and override pruning ignored it.
