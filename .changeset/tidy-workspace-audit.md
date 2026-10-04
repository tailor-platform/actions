---
"tailor-platform-actions": patch
---

Keep workspace package manifests and lockfiles together when auditing dependencies. Snapshot and restore child manifests, verify frozen installation before returning a bounded repo-relative changed-files output, and use that output in the automated PR workflow.
