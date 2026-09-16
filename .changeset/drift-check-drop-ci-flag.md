---
"tailor-platform-actions": patch
---

`drift-check` now probes `tailor setup check --help` to decide whether to pass `--ci`, instead of always passing it. Newer `@tailor-platform/sdk-plugin-setup` versions detect CI on their own and reject an explicit `--ci` as an unknown flag, which was failing the `tailor-drift-check` step outright (misreported as an unexpected auth/network/config error). Older versions still require `--ci` to skip a local-only check, so it is only dropped once the installed SDK's own `--help` output confirms it no longer accepts the flag.
