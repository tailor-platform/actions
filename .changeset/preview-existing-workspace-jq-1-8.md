---
"tailor-platform-actions": patch
---

Fix preview-deploy and preview-cleanup not finding the workspace ID recorded in the PR comment under jq 1.8, which rejects the `(?P<id>…)` named-group syntax. A push would have created a second preview workspace, and closing the PR would have skipped deleting it.
