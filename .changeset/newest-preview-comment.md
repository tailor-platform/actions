---
"tailor-platform-actions": patch
---

`preview-deploy` and `preview-cleanup` now read the workspace ID from the newest PR comment that carries the preview marker instead of the first one. Once earlier comments are left behind, a workspace that was swept and recreated is found again instead of being created on every push.
