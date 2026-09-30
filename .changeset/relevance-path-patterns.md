---
"tailor-platform-actions": minor
---

`relevance` accepts `path-patterns`: newline-separated GitHub `paths` filter patterns (the syntax of `on.<push|pull_request>.paths`), with `*`, `**`, `?`, `+`, and `[]` wildcards and `!` exclusions checked in order. A workflow can drop `on.<event>.paths` for this, so its checks always report a status and can be required — a workflow skipped by `on.paths` leaves its required checks pending, while a job skipped by `if` reports success. `relevant-paths` is unchanged, and the diff is relevant when a changed file matches either input.
