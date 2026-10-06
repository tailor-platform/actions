# tailor-platform-actions

## 2.5.1

### Patch Changes

- d5a30a6: Keep workspace package manifests and lockfiles together when auditing dependencies. Snapshot and restore child manifests, verify frozen installation before returning a bounded repo-relative changed-files output, and use that output in the automated PR workflow.
- 9bd658d: Preserve base advisory comparison for normal PR checks. When the base lockfile cannot be audited, restore HEAD and require a clean full audit at the configured severity. Before publishing an audit fix, require both frozen installation and a successful final full audit; roll back all workspace files and emit no outputs if verification fails.
  
  Treat a failed `pnpm audit` that prints an error report (for example a registry outage) as a failed audit instead of an audit with no advisories, so the broken-base fallback and the HEAD audit no longer pass silently.

## 2.5.0

### Minor Changes

- 7b2171f: Expose `frontend-urls` from deploy and preview-deploy as a JSON object mapping all static website names in the deployed workspace to URLs. Resolve URLs with `tailor staticwebsite list --json` after deployment, returning `{}` when no sites exist and supporting SDK versions without deploy hook outputs. Preserve existing workspace and backend URL outputs.

## 2.4.0

### Minor Changes

- d762f26: `relevance` accepts `path-patterns`: newline-separated globs with `*`, `**`, and leading `!` exclusions, checked in order so the last line matching a changed file decides it. Other glob characters (`?+[]{}()\`) are rejected, since tools disagree on their meaning. A workflow can use this instead of `on.<event>.paths`, so its checks always report a status and can be required — a workflow skipped by `on.paths` leaves its required checks pending, while a job skipped by `if` reports success. `relevant-paths` is unchanged, and the diff is relevant when a changed file matches either input.
- 104b5ad: `plan` and `tag-guard` no longer need the checkout to persist its credentials. `plan` authenticates its base-branch fetch with `github-token`, and `tag-guard` takes a new optional `github-token` input for its target-branch fetch; the token is passed to that one `git fetch` and is never written to `.git/config`, so callers can check out with `persist-credentials: false`. Without a token, both fetch as before, relying on the credentials the checkout persisted.

### Patch Changes

- 0495746: `check-licenses` now runs `pnpm licenses list -r` when the working directory is inside a pnpm workspace (a `pnpm-workspace.yaml` in it or any parent directory, whatever the file contains). Starting with pnpm 12.8.0, `pnpm licenses list` without `-r` only reports the current project's own dependencies, so at a workspace root whose `package.json` has no dependencies it returned `{}` and the action passed without checking any of the sub-projects' licenses. With `-r`, every pnpm version checks the whole workspace again, matching how earlier pnpm versions (checked on 10.33.0 and 12.4.1) behaved without it. Projects with no `pnpm-workspace.yaml` above them keep running without `-r`, since pnpm 10 crashes on `licenses list -r` in such a project when it has a `file:` dependency on its own subdirectory.
- 4f17cc0: `drift-check` now points the job summary at `tailor setup update` when the installed `@tailor-platform/sdk-plugin-setup` provides it, so a drifted repository can regenerate every workflow recorded in `.github/tailor.lock` with one command instead of re-running `tailor setup ci <kind>` with the original flags for each target. Plugins without `setup update` keep the previous "Re-run `tailor setup` to regenerate" hint.

## 2.3.5

### Patch Changes

- 1542fb8: `lockfile-audit-fix` now enables `minimumReleaseAgeExcludePrune` via a `pnpm-workspace.yaml` setting instead of the `--config.minimum-release-age-exclude-prune=true` CLI flag before running `pnpm install`/`pnpm dedupe`. pnpm's Rust v12 CLI deliberately left this key off the allowlist of `--config.<key>` tokens it re-applies after the yaml/env config layers load (pnpm/pnpm#13930), and the equivalent `PNPM_CONFIG_MINIMUM_RELEASE_AGE_EXCLUDE_PRUNE` env var is dropped the same way, so the CLI flag silently stopped pruning stale `minimumReleaseAgeExclude` entries under pnpm 12 while still working under pnpm 11. The setting is only injected when the workspace file doesn't already declare it (an explicit `minimumReleaseAgeExcludePrune: false` is left alone) and is stripped back out once install/dedupe finish, so it never appears as an unrequested addition to the caller's own `pnpm-workspace.yaml`.

## 2.3.4

### Patch Changes

- aff56d3: `drift-check` now probes `tailor setup check --help` to decide whether to pass `--ci`, instead of always passing it. Newer `@tailor-platform/sdk-plugin-setup` versions detect CI on their own and reject an explicit `--ci` as an unknown flag, which was failing the `tailor-drift-check` step outright (misreported as an unexpected auth/network/config error). Older versions still require `--ci` to skip a local-only check, so it is only dropped once the installed SDK's own `--help` output confirms it no longer accepts the flag.

## 2.3.3

### Patch Changes

- 09031ab: `lockfile-audit-fix` now also drops `pnpm.overrides`/`pnpm-workspace.yaml overrides:` entries whose target package no longer appears anywhere in the dependency tree. In workspaces configured with `sharedWorkspaceLockfile: false`, every project lockfile is checked before an override is considered orphaned, and changes to those lockfiles participate in rollback and the action's change outputs. Nothing else ever removes an override once its purpose is gone (e.g. a package that leaves the tree once its own dependent is upgraded away), so without this the list only grew over time, and Renovate kept filing no-op bump PRs against a pin that protected nothing. Removal overrides whose value is `-` are preserved because their target's absence is intentional. To pin a package ahead of it actually landing in the tree, add a `# keep-override: <reason>` comment directly above the entry in `pnpm-workspace.yaml` to opt it out of pruning (no equivalent exists for `package.json`'s `pnpm.overrides`, since JSON has no comments).
  
  It also inserts a `# Renovate security update: <entry>` comment directly above every version-pinned `pnpm-workspace.yaml` `minimumReleaseAgeExclude` entry that doesn't already have one. `pnpm audit --fix`/`pnpm install` write these `minimumReleaseAge`-bypass entries with no comment at all, but some callers run a separate, always-on policy check requiring this marker on every version-pinned entry as a sign that the bypass was added through this automated flow rather than by hand.

## 2.3.2

### Patch Changes

- 5b24e22: `lockfile-audit-fix` now collapses redundant `pnpm.overrides` entries after `pnpm audit --fix override` runs. Repeated scheduled runs previously left multiple selectors for the same package (e.g. `brace-expansion@<1.1.16`, `brace-expansion@<1.1.17`, `brace-expansion@<1.1.18`) piling up in `pnpm-workspace.yaml`/`package.json` as GHSA advisory ranges and patched versions got revised over time. An entry is now dropped only when another surviving entry for the same package covers a superset version range and pins to the same or a newer version, so no fix coverage is lost.

## 2.3.1

### Patch Changes

- 8b996c2: `lockfile-audit-fix` now passes `--config.minimum-release-age-exclude-prune=true` to its verification `pnpm install`, so pnpm itself drops any `minimumReleaseAgeExclude` entry in `pnpm-workspace.yaml` the freshly-resolved lockfile no longer needs (e.g. a version an earlier fix bypassed the gate for, that a later fix's re-resolution moved away from). Requires pnpm >=11.22.0; a no-op on older pnpm, not an error.

## 2.3.0

### Minor Changes

- 1d4ecc5: `lint-github-actions` now accepts a `paths` input (a space- or
  newline-separated list, forwarded to zizmor), so callers can scope the
  audit to just the workflow/action files changed in a PR instead of always
  auditing the whole repository.

## 2.2.0

### Minor Changes

- c0c7b71: Separate `drift-check` drift findings from execution failures.

  **Behavior change for existing consumers.** Previously, when `tailor setup check --ci` failed for a non-drift reason — expired credentials, a network error, an unloadable config — the action emitted a `::warning::` and the job still passed. It now emits an `::error::` and exits with the check's own status, so these failures surface instead of being reported as a clean canary. Jobs that silently tolerated a broken check will start failing without any workflow change.

  Drift findings themselves stay advisory: they emit `::warning::` annotations and write a step summary without failing the job. Set the new `fail-on-drift` input to `true` to fail on unsuppressed findings.

## 2.1.0

### Minor Changes

- 82a4b37: Add `lockfile-audit`, `lockfile-audit-fix`, `create-signed-pr`, and `lint-github-actions` actions.

  - `lockfile-audit`: regression-only gate against `pnpm-lock.yaml` changes — fails only when a change introduces a security advisory that wasn't already present at the base commit, so pre-existing advisories elsewhere don't block unrelated PRs.
  - `lockfile-audit-fix`: runs `pnpm audit --fix` against `pnpm-lock.yaml` for a standalone scheduled/dispatched workflow, verifying the result installs and reporting what changed (including whether any published package's runtime dependencies were touched). Doesn't commit or open a PR itself — pairs with a caller-provided commit/PR step.
  - `create-signed-pr`: commits a known, bounded list of file paths via GitHub's Git Data API and idempotently creates or updates a pull request for them, producing Verified (signed) commits with `GITHUB_TOKEN`/a GitHub App token — no `git commit` locally, no third-party action dependency. Pairs with `lockfile-audit-fix`.
  - `lint-github-actions`: runs zizmor's security audit against workflows and action definitions in a single step, so a caller adopts this repo's own supply-chain CI lint baseline without wiring it up manually.
