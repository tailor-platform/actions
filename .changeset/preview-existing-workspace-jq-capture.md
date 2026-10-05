---
"tailor-platform-actions": patch
---

Fix preview-deploy and preview-cleanup not finding the workspace ID recorded in the PR comment when jq rejects the `(?P<id>…)` named-group syntax, as the jq 1.7.1 and 1.8.2 release binaries do. `try` hid the error, so an existing preview workspace went unrecognized: a later push tried to create it again and closing the PR skipped deleting it. The group is now written `(?<id>…)`, which those jq versions accept.
