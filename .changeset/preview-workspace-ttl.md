---
"tailor-platform-actions": minor
---

Add `ttl` to preview-deploy and `prune-expired` (with `organization-id` and `folder-id`) to preview-cleanup. With `ttl`, a preview workspace records an expiry that every push to the PR restarts, and with `prune-expired: "true"` every PR close also deletes this app's other `{prefix}-pr-{number}` workspaces in the same folder or organization root whose expiry has passed, so a preview whose own cleanup never ran no longer lingers. A PR that sat idle past `ttl` gets a fresh workspace on its next push, and closing it after its workspace was pruned no longer fails. Both inputs are off by default and existing workflows behave as before.
