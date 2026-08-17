---
"tailor-platform-actions": minor
---

`lint-github-actions` now accepts a `paths` input (a space- or
newline-separated list, forwarded to zizmor), so callers can scope the
audit to just the workflow/action files changed in a PR instead of always
auditing the whole repository.
