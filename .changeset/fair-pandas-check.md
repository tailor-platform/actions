---
"tailor-platform-actions": minor
---

Separate `drift-check` drift findings from execution failures.

**Behavior change for existing consumers.** Previously, when `tailor setup check --ci` failed for a non-drift reason — expired credentials, a network error, an unloadable config — the action emitted a `::warning::` and the job still passed. It now emits an `::error::` and exits with the check's own status, so these failures surface instead of being reported as a clean canary. Jobs that silently tolerated a broken check will start failing without any workflow change.

Drift findings themselves stay advisory: they emit `::warning::` annotations and write a step summary without failing the job. Set the new `fail-on-drift` input to `true` to fail on unsuppressed findings.
