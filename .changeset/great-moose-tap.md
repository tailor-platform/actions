---
"tailor-platform-actions": minor
---

Expose all workspace application base URLs from deploy and preview-deploy through app-urls. If the lookup fails, emit a warning and return {} without failing the deployment.

Add an app-urls input to preview-comment. When non-empty, it replaces the App URL row with one named row per application, such as App URL (core). Workflows that pass only app-url need no change.
