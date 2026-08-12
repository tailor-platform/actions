# Tailor Platform Actions

Reusable GitHub Actions for [Tailor Platform](https://tailor.tech/).

## Versioning

Pin usage to a major tag (e.g. `tailor-platform/actions/deploy@v2`) or a full commit
SHA — see each release's notes for the exact SHA. `v2` targets the Tailor Platform
SDK's `tailor` CLI. If you're still on the SDK's pre-rename `tailor-sdk` CLI, use `@v1`
instead; that line is maintained on the [`maintenance/v1`](https://github.com/tailor-platform/actions/tree/maintenance/v1)
branch, not `main`.

## Actions

### [`deploy`](deploy/action.yaml)

Deploy an application to Tailor Platform. Handles token acquisition, code generation, and deployment.

The action targets the workspace by `workspace-id` only. Workspace creation/provisioning happens outside this action (e.g. via the Tailor Platform console or CLI). Pass the workspace ID from a GitHub Environment variable (`vars.TAILOR_PLATFORM_WORKSPACE_ID`).

**Prerequisites:** The caller is responsible for checkout, Node.js setup, package manager setup, and dependency installation. This keeps the action package-manager agnostic.

#### Usage

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: tailor-platform/actions/deploy@v2
        with:
          workspace-id: ${{ vars.TAILOR_PLATFORM_WORKSPACE_ID }}
          platform-client-id: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID }}
          platform-client-secret: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET }}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `workspace-id` | Yes | | Workspace ID (from a GitHub Environment variable, e.g. `vars.TAILOR_PLATFORM_WORKSPACE_ID`) |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |
| `platform-client-id` | Yes | | OAuth2 client ID for machine user |
| `platform-client-secret` | Yes | | OAuth2 client secret for machine user |

#### Outputs

| Name | Description |
|------|-------------|
| `workspace-id` | Workspace ID passed in |
| `app-url` | Application URL (GraphQL endpoint) of the deployed workspace. Available to subsequent steps, e.g. for passing to a static website build slot. |

#### Secrets and variables setup

```bash
# Machine user credentials (repository or environment secrets)
gh secret set TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID
gh secret set TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET

# Workspace ID (GitHub Environment variable — one per environment)
gh variable set TAILOR_PLATFORM_WORKSPACE_ID --env production
```

#### Scaffold with Tailor SDK CLI

The [`tailor setup`](https://github.com/tailor-platform/sdk) command generates a workflow file using this action together with the [`install`](#install) action, with package manager auto-detection.

---

### [`plan`](plan/action.yaml)

Show planned changes by running dry-run against the target workspace. Merges the base branch and runs `tailor deploy --dry-run`, then comments the result on the PR.

The action targets the workspace by `workspace-id` only. When `workspace-id` is empty (workspace not yet provisioned), the action skips the dry-run and reports that the workspace is not provisioned yet — the job succeeds. This covers the chicken-and-egg situation of running `plan` on a PR before the first deploy.

**Prerequisites:** Same as `deploy` - checkout, Node.js setup, package manager setup, and dependency installation.

#### Usage

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    environment: production
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: tailor-platform/actions/plan@v2
        with:
          workspace-id: ${{ vars.TAILOR_PLATFORM_WORKSPACE_ID }}
          label: production
          platform-client-id: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID }}
          platform-client-secret: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `workspace-id` | No | | Workspace ID to run dry-run against (from a GitHub Environment variable, e.g. `vars.TAILOR_PLATFORM_WORKSPACE_ID`). When empty, the dry-run is skipped and the action reports that the workspace is not provisioned yet. |
| `label` | No | | Human-readable label for the PR comment heading and marker (e.g. the workspace name). Falls back to `workspace-id`, then `"workspace"`. |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |
| `platform-client-id` | Yes | | OAuth2 client ID for machine user |
| `platform-client-secret` | Yes | | OAuth2 client secret for machine user |
| `github-token` | No | | GitHub token for commenting on PR. When omitted, no PR comment is posted (step summary only). |

#### Outputs

| Name | Description |
|------|-------------|
| `workspace-id` | Workspace ID passed in (empty when not provisioned yet) |
| `exit-code` | Exit code of the dry-run (empty when skipped) |

#### Step summary

The action always writes the result to the job's step summary (status emoji, workspace identifier, and the full output in a `<details>` block). This is the primary signal when the action runs outside of a pull request (e.g. on a tag push for deploy approval).

#### PR Comment

When `github-token` is provided and the event is a pull request, the action posts (or updates) a comment with the dry-run output:

- ✅ **Success**: Shows the planned changes
- ❌ **Failure**: Shows the error output

When `workspace-id` is not set, no PR comment is posted — the step summary records the "not yet provisioned" state instead.

The comment is keyed per workspace via a `<!-- tailor-plan: KEY -->` marker (`KEY` is the `label` input if provided, otherwise `workspace-id`, otherwise `"workspace"`), so multiple environments can post separate comments on the same PR. The comment is automatically updated on subsequent runs.

---

### [`setup`](setup/action.yaml)

Set up the Tailor Platform toolchain (Node.js and package manager). Does not install project dependencies — use the [`install`](#install) action for that.

---

### [`generate-check`](generate-check/action.yaml)

Run `tailor generate` and fail if it produces uncommitted changes. Catches generated files (seed data, enum constants, etc.) that were regenerated but not committed.

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `package-manager` | Yes | | Package manager (`pnpm`, `npm`, `yarn`, or `bun`) |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |
| `ignore` | No | | Newline-separated list of file paths to exclude from the check (e.g. `.npmrc` created by earlier steps) |

---

### [`tag-guard`](tag-guard/action.yaml)

Guard that a pushed tag is reachable from a target branch before allowing a deploy to proceed. Skips gracefully when the tag is outside the branch (not an error).

---

### [`drift-check`](drift-check/action.yaml)

Detect drift between the generated GitHub Actions workflows and the current config/repo state. Emits `::warning::` annotations and writes a step summary, but **never fails the job** — use as a non-blocking canary in plan jobs.

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `package-manager` | Yes | | Package manager (`pnpm`, `npm`, `yarn`, or `bun`) |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |
| `ignore` | No | | Comma-separated drift rule keys to suppress (e.g. `"default-branch,template-version"`). Supported keys: `missing-file`, `hand-edit`, `template-version`, `config-dir`, `default-branch` |

---

### [`seed-validate`](seed-validate/action.yaml)

Validate seed data against the generated schema, detecting JSONL records that do not match their target type. Requires `tailor generate` to have run first.

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `working-directory` | No | `.` | Working directory (for monorepo setups) |

---

### [`staticwebsite-deploy`](staticwebsite-deploy/action.yaml)

Deploy a built static website to Tailor Platform and output its public URL. Run this after the `deploy` action in the same job (authentication is reused).

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `workspace-id` | Yes | | Workspace ID (from a GitHub Environment variable, e.g. `vars.TAILOR_PLATFORM_WORKSPACE_ID`) |
| `name` | Yes | | Static website name as defined in `tailor.config.ts` |
| `dist-dir` | Yes | | Path to the built static website files |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |
| `package-manager` | No | | Package manager (`pnpm`, `npm`, `yarn`, or `bun`). Defaults to `npx`. |

#### Outputs

| Name | Description |
|------|-------------|
| `site-url` | Public URL of the deployed static website |

---

### [`notify`](notify/action.yaml)

Send a deployment notification. Currently supports Slack via Bot token and channel ID.

#### Usage

```yaml
    steps:
      # ... deploy steps ...
      - if: always()
        uses: tailor-platform/actions/notify@v2
        with:
          provider: slack
          status: ${{ job.status }}
          workspace-name: my-app-prod
          slack-channel-id: ${{ vars.SLACK_DEPLOY_CHANNEL_ID }}
          slack-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `provider` | Yes | | Notification provider. Currently only `slack` is supported. |
| `status` | Yes | | Deployment status. Accepts `success`, `failure`, or `cancelled` (any non-`success` value is reported as a failure). Pass `${{ job.status }}`. |
| `workspace-name` | No | | Workspace name shown in the message |
| `slack-channel-id` | No | | Slack channel ID. When empty, the notification is silently skipped. |
| `slack-token` | No | | Slack Bot token with `chat:write` permission. When empty, the notification is silently skipped. |

---

### [`preview-deploy`](preview-deploy/action.yaml)

Deploy a per-PR preview workspace. On the first push to a PR the workspace is created; subsequent pushes reuse the existing workspace (identified by the workspace ID recorded in the PR comment by `preview-comment`). Run on `pull_request` events (not `closed`).

**Prerequisites:** Same as `deploy` — checkout, Node.js, package manager, and dependency installation.

#### Usage

```yaml
jobs:
  preview:
    runs-on: ubuntu-latest
    if: github.event.action != 'closed' && !github.event.pull_request.draft
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - id: preview
        uses: tailor-platform/actions/preview-deploy@v2
        with:
          workspace-name-prefix: my-app
          region: us-west
          organization-id: ${{ vars.TAILOR_PLATFORM_ORGANIZATION_ID }}
          platform-client-id: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID }}
          platform-client-secret: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - uses: tailor-platform/actions/preview-comment@v2
        with:
          workspace-id: ${{ steps.preview.outputs.workspace-id }}
          workspace-name: ${{ steps.preview.outputs.workspace-name }}
          status: ${{ job.status }}
          app-url: ${{ steps.preview.outputs.app-url }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          mention: "true"
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `workspace-name-prefix` | Yes | | Prefix for the workspace name. The full name is `{prefix}-pr-{PR number}` (max 57 chars). |
| `region` | Yes | | Workspace region for creation (e.g. `us-west`, `asia-northeast`). Only used on first run. |
| `organization-id` | No | | Organization ID for workspace creation. Defaults to `TAILOR_PLATFORM_ORGANIZATION_ID` env var. |
| `folder-id` | No | | Folder ID for workspace creation |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |
| `package-manager` | No | | Package manager (`pnpm`, `npm`, `yarn`, or `bun`). Defaults to `npx`. |
| `platform-client-id` | Yes | | OAuth2 client ID for machine user |
| `platform-client-secret` | Yes | | OAuth2 client secret for machine user |
| `github-token` | Yes | | GitHub token for reading PR comments to find an existing workspace ID |

#### Outputs

| Name | Description |
|------|-------------|
| `workspace-id` | Workspace ID of the preview deployment |
| `workspace-name` | Full workspace name (e.g. `my-app-pr-42`) |
| `app-url` | Application URL (GraphQL endpoint) of the preview workspace |

---

### [`preview-comment`](preview-comment/action.yaml)

Post or update a PR comment with preview deployment status, workspace ID, app URL, and optional @mention. Typically called after `preview-deploy`. The comment is keyed by workspace name so multiple preview environments can coexist on one PR.

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `workspace-id` | Yes | | Workspace ID of the preview deployment |
| `workspace-name` | Yes | | Workspace name (from `preview-deploy` output) |
| `status` | Yes | | Deployment status: `success`, `failure`, or `deleted` |
| `app-url` | No | | Application URL to show in the comment |
| `github-token` | Yes | | GitHub token with `pull-requests: write` |
| `mention` | No | | Set to `"true"` to @mention the commit author (falls back to PR author if commit is by a bot) |

---

### [`check-licenses`](check-licenses/action.yaml)

Check that all dependencies use allowed licenses, based on the Google [licenseclassifier](https://github.com/google/licenseclassifier) categories (`reciprocal`, `notice`, `unencumbered`). Fails the job when a dependency's license isn't in the allowed set.

**Prerequisites:** The caller is responsible for checkout, Node.js setup, pnpm setup, and dependency installation.

#### Usage

```yaml
jobs:
  check-licenses:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: tailor-platform/actions/check-licenses@v2
        with:
          license-groups: ${{ vars.LICENSE_GROUPS }}
          additional-licenses: ${{ vars.ALLOWED_LICENSES }}
          denied-licenses: ${{ vars.DENIED_LICENSES }}
          # examples/nextjs-app pulls in @img/sharp-libvips-* (LGPL-3.0-or-later)
          # transitively via next's built-in image optimization, used
          # unmodified as a prebuilt binary — the standard case LGPL's
          # dynamic-linking allowance covers.
          package-exceptions: |
            {"LGPL-3.0-or-later": [["nextjs-app", "next"]]}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `license-groups` | No | `reciprocal,notice,unencumbered` | Which Google licenseclassifier categories to allow. Comma- or newline-separated. Including `reciprocal` (weak-copyleft licenses like MPL/EPL/CDDL) is a licensing-policy decision, not a fixed fact, so it's configurable rather than hardcoded — source it from a `LICENSE_GROUPS` GitHub Variable. |
| `additional-licenses` | No | | Extra individually-allowed SPDX license identifiers, beyond the selected `license-groups`. Comma- or newline-separated. Source this from an `ALLOWED_LICENSES` GitHub Variable (organization-level, Terraform-managed) so every consuming repo shares one allowlist. |
| `denied-licenses` | No | | SPDX license identifiers to remove from the allow set, even if they belong to a selected group. Comma- or newline-separated. Source this from a `DENIED_LICENSES` GitHub Variable, kept alongside `LICENSE_GROUPS` / `ALLOWED_LICENSES` even while empty, so denying a license later is a Variable update, not a workflow edit. |
| `package-exceptions` | No | | Approve specific dependency routes to an otherwise-disallowed license, independent of the inputs above. A JSON object mapping a license string to an array of dependency chains — see [Package exceptions](#package-exceptions) below. Unlike the other inputs, this one is tied to one repo's specific dependency tree, so declare it directly in that repo's workflow instead of a shared GitHub Variable. |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |

#### Package exceptions

Allowing a license outright (`additional-licenses`) silently blesses every future dependency under that license — approving one package's LGPL-licensed prebuilt binary shouldn't approve LGPL in general. `package-exceptions` instead approves a specific **route** to a license, expressed as a dependency chain:

```json
{ "LGPL-3.0-or-later": [["nextjs-app", "next"]] }
```

Each chain is an ordered list of package names (the workspace project name first; `*` globs allowed elsewhere). A package can be reached multiple ways (e.g. two different workspace projects both depending on it) — `pnpm why <package> --recursive --json` finds every such route, and the package is excused only if **every** route matches some declared chain; approving one route never excuses a different, unreviewed route to the same package. Within a route, other dependencies may appear between the chain's listed names, and the chain doesn't need to end at the violating package itself: `["nextjs-app", "next"]` approves this license for anything reached via `nextjs-app`'s use of `next`, not one exact package — useful since a native dependency like `sharp`/`libvips` ships a different package name per OS/arch (`@img/sharp-libvips-linux-x64`, `@img/sharp-libvips-darwin-arm64`, ...); one chain covers all of them without enumerating every platform variant.

#### Managing the allowlist

`license-groups`, `additional-licenses`, and `denied-licenses` are policy decisions shared across repos, not implementation details — they live in GitHub Variables rather than in this action's code, so they can change without a workflow edit or a new action release. Managed via Terraform as single **organization-level** variables so the values aren't duplicated per repo:

```hcl
resource "github_actions_organization_variable" "license_groups" {
  variable_name = "LICENSE_GROUPS"
  visibility    = "selected"
  selected_repository_ids = [
    data.github_repository.erp_kit.repo_id,
    data.github_repository.sdk.repo_id,
    data.github_repository.app_shell.repo_id,
  ]
  value = "reciprocal,notice,unencumbered"
}

resource "github_actions_organization_variable" "allowed_licenses" {
  variable_name = "ALLOWED_LICENSES"
  visibility    = "selected"
  selected_repository_ids = [
    data.github_repository.erp_kit.repo_id,
    data.github_repository.sdk.repo_id,
    data.github_repository.app_shell.repo_id,
  ]
  value = "BlueOak-1.0.0,WTFPL,Unknown,OFL-1.1"
}

# Empty for now — kept so denying a specific license later is a value
# update here, not a new input wired through every consuming workflow.
resource "github_actions_organization_variable" "denied_licenses" {
  variable_name = "DENIED_LICENSES"
  visibility    = "selected"
  selected_repository_ids = [
    data.github_repository.erp_kit.repo_id,
    data.github_repository.sdk.repo_id,
    data.github_repository.app_shell.repo_id,
  ]
  value = ""
}
```

`package-exceptions` isn't managed this way — see the Usage example above.

---

### [`lockfile-audit`](lockfile-audit/action.yaml)

Regression-only gate against `pnpm-lock.yaml` changes: fails only when a pull request or push introduces a security advisory that wasn't already present in the lockfile at the base commit. Pre-existing advisories elsewhere in the lockfile don't block unrelated changes — pair this with a scheduled `pnpm audit --fix` workflow (run independent of any PR) to clear those over time.

**Prerequisites:** The caller is responsible for checkout (with `fetch-depth: 0` — the base commit's lockfile must be reachable) and pnpm setup. `pnpm audit` resolves advisories from the lockfile alone, so no dependency install is needed. A resolved base commit that isn't reachable in the checkout (most commonly a missing `fetch-depth: 0`) fails the job outright rather than silently skipping — silently no-op'ing would defeat the gate for exactly the callers who most need it.

#### Usage

```yaml
jobs:
  lockfile-audit:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
        with:
          run_install: false
      - uses: tailor-platform/actions/lockfile-audit@v2
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `audit-level` | No | `moderate` | Minimum severity to report, passed through to `pnpm audit --audit-level`. One of `low`, `moderate`, `high`, `critical`. |
| `base-sha` | No | | Commit to diff the lockfile against, overriding the default auto-detection (the pull request's base commit, or the pushed ref's previous tip). Mainly for `workflow_dispatch` runs, where neither of those is available from the event payload. |
| `working-directory` | No | `.` | Working directory containing `pnpm-lock.yaml` (for monorepo setups) |

---

### [`lockfile-audit-fix`](lockfile-audit-fix/action.yaml)

Runs `pnpm audit --fix` against `pnpm-lock.yaml` (update mode, falling back to override mode when update alone can't clear an advisory), verifying the result still installs before keeping it. Meant for a standalone scheduled/dispatched workflow that clears pre-existing advisories independent of any specific PR — pair with `lockfile-audit`'s regression-only gate, which only blocks *new* advisories.

This action does not commit or open a pull request; it only fixes the lockfile in the working tree and reports what changed. Pair it with a commit/PR step of your own so you control where a changeset gets inserted (if `runtime-deps-changed` calls for one).

**Prerequisites:** The caller is responsible for checkout and pnpm setup.

#### Usage

```yaml
jobs:
  lockfile-audit-fix:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          run_install: false
      - uses: tailor-platform/actions/lockfile-audit-fix@v2
        id: fix
      # commit pnpm-lock.yaml / pnpm-workspace.yaml / package.json and open
      # a PR yourself when steps.fix.outputs.changed == 'true'
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `audit-level` | No | `moderate` | Minimum severity to report, passed through to `pnpm audit --audit-level`. One of `low`, `moderate`, `high`, `critical`. |
| `working-directory` | No | `.` | Working directory containing `pnpm-lock.yaml` (for monorepo setups) |

#### Outputs

| Name | Description |
|------|-------------|
| `changed` | `'true'` if `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and/or `package.json` changed — pnpm writes an override it can't express as a plain version bump to `pnpm-workspace.yaml` (creating it if it doesn't exist) or to `package.json`'s `pnpm.overrides`, depending on pnpm version and whether the repo already has a `pnpm-workspace.yaml` |
| `runtime-deps-changed` | `'true'` if any non-private package's runtime (non-dev) dependencies changed, per `pnpm-lock.yaml` — devDependencies-only and `pnpm-workspace.yaml`/`package.json`-overrides-only changes don't affect consumers |
| `changed-names` | Newline-separated names of packages whose runtime dependencies changed |
| `summary` | Markdown summary of fixed and remaining advisories, for use as a PR body |

---

### [`create-signed-pr`](create-signed-pr/action.yaml)

Commits a known, bounded list of file paths via GitHub's Git Data API (blob -> tree -> commit -> ref) and idempotently creates or updates a pull request for them — without running `git commit` locally or depending on a third-party action. Pair with `lockfile-audit-fix` (or any step that leaves modified files in the working tree) to open a PR for the result.

Commits created this way are automatically shown as "Verified" on GitHub when using the default `GITHUB_TOKEN` or a GitHub App installation token, satisfying a `required_signatures` branch protection rule with no GPG key material. A classic/fine-grained PAT still works but produces unsigned commits.

This is deliberately **not** a general-purpose alternative to [`peter-evans/create-pull-request`](https://github.com/peter-evans/create-pull-request): `paths` must be a known, caller-supplied list of files that already exist in the checkout (e.g. files a prior step just modified), not an arbitrary repo-wide diff — this action never inspects the working tree's git status, doesn't support deletions, and reads each listed path directly.

Each run re-parents the new commit on the base branch's *current* head and force-moves the target branch to it, so the branch always holds a single commit rebased on the latest base. A consequence: any commit a human pushed to that branch directly is discarded on the next run — same behavior as `peter-evans/create-pull-request`'s default mode.

**A pull request created with the default `GITHUB_TOKEN` does not trigger `pull_request`-triggered workflows** (GitHub suppresses recursive workflow runs from its own token) — the created PR gets no CI. Use a GitHub App installation token instead if the PR needs to run your normal CI.

**Prerequisites:** The caller is responsible for checkout. The token needs `contents: write` and `pull-requests: write` permissions.

#### Usage

```yaml
jobs:
  lockfile-audit-fix:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          run_install: false
      - uses: tailor-platform/actions/lockfile-audit-fix@v2
        id: fix
      - uses: tailor-platform/actions/create-signed-pr@v2
        if: steps.fix.outputs.changed == 'true'
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          paths: |
            pnpm-lock.yaml
            pnpm-workspace.yaml
          branch: chore/lockfile-audit-fix
          commit-message: "fix(deps): automated lockfile security fix"
          title: "fix(deps): automated lockfile security fix"
          body: ${{ steps.fix.outputs.summary }}
          labels: |
            security
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `token` | Yes | | GitHub token with `contents: write` and `pull-requests: write` permissions. `GITHUB_TOKEN` or a GitHub App installation token for Verified (signed) commits; a PAT works but produces unsigned commits. |
| `paths` | Yes | | Newline-separated list of repo-root-relative file paths to commit. Each must exist in the local checkout. |
| `branch` | Yes | | Branch to create or force-update with the new commit. |
| `base` | No | (repository default branch) | Base branch to commit onto and open the pull request against. |
| `commit-message` | Yes | | Commit message for the new commit. |
| `title` | Yes | | Pull request title. |
| `body` | No | `""` | Pull request body. |
| `labels` | No | `""` | Newline-separated list of labels to add to the pull request. |
| `api-base-url` | No | `""` | Override the GitHub REST API base URL (e.g. for GHES, or to point at a test double). Defaults to `$GITHUB_API_URL`, then `https://api.github.com`. |

#### Outputs

| Name | Description |
|------|-------------|
| `changed` | `'true'` if a new commit was created (the tree differed from the base branch's) |
| `pull-request-number` | The pull request's number, or empty if none exists |
| `pull-request-url` | The pull request's URL, or empty if none exists |
| `commit-sha` | The new commit's sha, or empty if nothing changed |

---

### [`lint-github-actions`](lint-github-actions/action.yaml)

Run [zizmor](https://docs.zizmor.sh/)'s security audit — missing SHA pins, `pull_request_target` misuse, script injection via untrusted input, overly broad permissions, etc. — against this repository's workflows and action definitions.

**Prerequisites:** The caller is responsible for checkout.

#### Usage

```yaml
jobs:
  lint-github-actions:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: tailor-platform/actions/lint-github-actions@v2
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `zizmor-advanced-security` | No | `false` | Upload zizmor's findings to the repository's Security tab (GitHub Advanced Security) as SARIF instead of plain workflow annotations. Requires GHAS to be enabled on the repository. |
| `github-token` | No | `${{ github.token }}` | GitHub token for zizmor's online audits |

---

### [`preview-cleanup`](preview-cleanup/action.yaml)

Delete the preview workspace when a PR is closed. Reads the workspace ID from the PR comment posted by `preview-comment` and deletes the workspace. Run on `pull_request` `closed` events.

#### Usage

```yaml
jobs:
  preview-cleanup:
    runs-on: ubuntu-latest
    if: github.event.action == 'closed'
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - uses: tailor-platform/actions/preview-cleanup@v2
        with:
          workspace-name-prefix: my-app
          platform-client-id: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID }}
          platform-client-secret: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `workspace-name-prefix` | Yes | | Same prefix used in `preview-deploy` |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |
| `package-manager` | No | | Package manager (`pnpm`, `npm`, `yarn`, or `bun`). Defaults to `npx`. |
| `platform-client-id` | Yes | | OAuth2 client ID for machine user |
| `platform-client-secret` | Yes | | OAuth2 client secret for machine user |
| `github-token` | Yes | | GitHub token with `pull-requests: write` for reading and updating the PR comment |

---

### [`relevance`](relevance/action.yaml)

Decide whether the diff between two commits touches any path you care about, and resolve the true fork point (git merge-base) between them via the compare API's `merge_base_commit` — not `sha-base`'s moving tip, which would otherwise mix in unrelated changes made to the base branch after the two commits diverged. Useful for skipping expensive work on an irrelevant push/PR while still reusing a base-branch snapshot found at the correct fork point (pair with [`find-base-run`](#find-base-run)).

#### Usage

```yaml
jobs:
  check-relevance:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: tailor-platform/actions/relevance@v2
        id: relevance
        with:
          sha-base: ${{ github.event.pull_request.base.sha }}
          sha-head: ${{ github.event.pull_request.head.sha }}
          relevant-paths: |
            tailor.config.ts
            tailordb/
          github-token: ${{ secrets.GITHUB_TOKEN }}
    outputs:
      relevant: ${{ steps.relevance.outputs.relevant }}
      fork-sha: ${{ steps.relevance.outputs.fork-sha }}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `sha-base` | Yes | | Base commit to diff from. Pass the all-zero SHA (`0000000000000000000000000000000000000000`, as GitHub does for a branch's first push) to always treat the diff as relevant. |
| `sha-head` | Yes | | Head commit to diff to |
| `relevant-paths` | No | | Newline-separated list of paths that make the diff relevant. A line ending in `/` matches as a prefix against changed file paths; anything else must match a changed file path exactly. Empty means no path makes the diff relevant on its own — only `sha-base` being the all-zero SHA, or the compare API's file list hitting its 300-entry cap (treated as possibly truncated), will set `relevant=true`. |
| `github-token` | Yes | | GitHub token for the compare API call |

#### Outputs

| Name | Description |
|------|-------------|
| `relevant` | `"true"` or `"false"` |
| `fork-sha` | The true fork point (merge-base) between `sha-base` and `sha-head`. Empty when `sha-base` is the all-zero SHA (no prior commit to compare against, so there is no fork point to resolve). |

---

### [`find-base-run`](find-base-run/action.yaml)

Search a workflow's successful runs on a given branch, newest-first, for the most recent one at or before a given commit (the "fork point"). Useful for reusing a base-branch artifact at the correct point in history instead of the branch's moving tip, which would otherwise mix in changes made after the two commits diverged — pair with [`relevance`](#relevance), which resolves the fork point via the compare API's `merge_base_commit`.

Deliberately returns no match (rather than falling back to the latest run) when nothing at-or-before the fork point is found among the checked candidates — a later run could include changes merged into the branch after the fork point, which is the exact mismatch this action exists to avoid. Treat an empty `run-id` as "no usable base" and degrade accordingly (e.g. render everything as newly added), not as an error.

#### Usage

```yaml
jobs:
  find-base:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: tailor-platform/actions/find-base-run@v2
        id: find
        with:
          workflow-file: schema-export.yaml
          base-ref: ${{ github.event.pull_request.base.ref }}
          fork-sha: ${{ steps.relevance.outputs.fork-sha }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
    outputs:
      run-id: ${{ steps.find.outputs.run-id }}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `workflow-file` | Yes | | Filename of the workflow whose run history to search (e.g. `schema-export.yaml`), not its display name |
| `base-ref` | Yes | | Branch to search runs on |
| `fork-sha` | Yes | | Commit to find a run at or before |
| `max-candidate-runs` | No | `1000` | Safety cap on how many candidate runs to check, on top of `retention-days`. Must be a positive integer. |
| `retention-days` | No | `90` | Only consider runs created within this many days. Set this to match whatever artifact retention period your runs use — a run outside that window has nothing left to download regardless of whether it matches. Must be a positive integer. |
| `github-token` | Yes | | GitHub token with `actions: read` permission |

#### Outputs

| Name | Description |
|------|-------------|
| `run-id` | ID of the matching run, or empty if none of the checked candidates are at or before `fork-sha`. |

---

## License

MIT
