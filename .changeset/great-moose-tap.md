---
"tailor-platform-actions": minor
---

Expose all workspace application base URLs from deploy and preview-deploy through app-urls. If the lookup fails, emit a warning and return {} without failing the deployment.

Add an app-urls input to preview-comment. When non-empty, it replaces the App URL row with one named row per application, such as App URL (core). Workflows that pass only app-url need no change.

Add console-urls to deploy and preview-deploy, building Console links from the same application list without another API lookup. Pass them to preview-comment through its new console-urls input to add a Console URL (name) row per application. Console URL generation failures emit a warning and return {} without failing the deployment.
