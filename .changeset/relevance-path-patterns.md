---
"tailor-platform-actions": minor
---

`relevance` accepts `path-patterns`: newline-separated globs with `*`, `**`, and leading `!` exclusions, checked in order so the last line matching a changed file decides it. Other glob characters (`?+[]{}()\`) are rejected, since tools disagree on their meaning. A workflow can use this instead of `on.<event>.paths`, so its checks always report a status and can be required — a workflow skipped by `on.paths` leaves its required checks pending, while a job skipped by `if` reports success. `relevant-paths` is unchanged, and the diff is relevant when a changed file matches either input.
