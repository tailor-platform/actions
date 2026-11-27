---
"tailor-platform-actions": minor
---

Add `env-check`, which reports the GitHub variables and secrets a job reads that have no value, names every empty required one in a single annotation, and points to `tailor setup ci env` to register them. It takes only whether each value is set, so the step never sees a secret. The `plan` summary for an empty `workspace-id` now says to create the workspace with `tailor workspace create` and set `TAILOR_PLATFORM_WORKSPACE_ID`, instead of telling you to run deploy first, which fails on an empty workspace ID.
