---
"tailor-platform-actions": patch
---

Preserve base advisory comparison for normal PR checks. When the base lockfile cannot be audited, restore HEAD and require a clean full audit at the configured severity. Before publishing an audit fix, require both frozen installation and a successful final full audit; roll back all workspace files and emit no outputs if verification fails.

Treat a failed `pnpm audit` that prints an error report (for example a registry outage) as a failed audit instead of an audit with no advisories, so the broken-base fallback and the HEAD audit no longer pass silently.
