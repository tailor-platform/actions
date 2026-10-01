---
"tailor-platform-actions": minor
---

`plan` and `tag-guard` no longer need the checkout to persist its credentials. `plan` authenticates its base-branch fetch with `github-token`, and `tag-guard` takes a new optional `github-token` input for its target-branch fetch; the token is passed to that one `git fetch` and is never written to `.git/config`, so callers can check out with `persist-credentials: false`. Without a token, both fetch as before, relying on the credentials the checkout persisted.
