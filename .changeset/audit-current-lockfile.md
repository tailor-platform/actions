---
"tailor-platform-actions": major
---

Always audit the current lockfile instead of comparing advisory IDs with a base commit. Existing vulnerabilities at or above audit-level now fail the job, as do audit errors. No base history is required; base-sha is deprecated and ignored. Callers no longer need a fallback audit when the base lockfile is broken.
