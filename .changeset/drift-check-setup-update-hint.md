---
"tailor-platform-actions": patch
---

`drift-check` now points the job summary at `tailor setup update` when the installed `@tailor-platform/sdk-plugin-setup` provides it, so a drifted repository can regenerate every workflow recorded in `.github/tailor.lock` with one command instead of re-running `tailor setup ci <kind>` with the original flags for each target. Plugins without `setup update` keep the previous "Re-run `tailor setup` to regenerate" hint.
