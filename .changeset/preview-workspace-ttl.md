---
"tailor-platform-actions": minor
---

Add `ttl` to preview-deploy and `prune-expired` (with `organization-id` and `folder-id`) to preview-cleanup. A preview workspace created with `ttl` records an expiry, and with `prune-expired: "true"` every PR close also deletes this app's other `{prefix}-pr-{number}` workspaces in the same folder or organization root whose expiry has passed, so a preview whose own cleanup never ran no longer lingers. Both inputs are off by default and existing workflows behave as before.
