# Tailor Platform Actions

Reusable GitHub Actions for [Tailor Platform](https://tailor.tech/).

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
      - uses: tailor-platform/actions/deploy@v1
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

The [`tailor-sdk setup`](https://github.com/tailor-platform/sdk) command generates a workflow file using this action together with the [`install`](#install) action, with package manager auto-detection.

---

### [`plan`](plan/action.yaml)

Show planned changes by running dry-run against the target workspace. Merges the base branch and runs `tailor-sdk apply --dry-run`, then comments the result on the PR.

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
      - uses: tailor-platform/actions/plan@v1
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

Run `tailor-sdk generate` and fail if it produces uncommitted changes. Catches generated files (seed data, enum constants, etc.) that were regenerated but not committed.

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

Validate seed data against the generated schema, detecting JSONL records that do not match their target type. Requires `tailor-sdk generate` to have run first.

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
        uses: tailor-platform/actions/notify@v1
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
        uses: tailor-platform/actions/preview-deploy@v1
        with:
          workspace-name-prefix: my-app
          region: us-west
          organization-id: ${{ vars.TAILOR_PLATFORM_ORGANIZATION_ID }}
          platform-client-id: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID }}
          platform-client-secret: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - uses: tailor-platform/actions/preview-comment@v1
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
      - uses: tailor-platform/actions/check-licenses@v1
        with:
          additional-licenses: ${{ vars.ALLOWED_LICENSES }}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `additional-licenses` | No | | Extra individually-allowed SPDX license identifiers, beyond the reciprocal/notice/unencumbered baseline. Comma- or newline-separated. Source this from a repository `ALLOWED_LICENSES` GitHub Variable (managed centrally in `tailor-inc/tailor-infra`) so the allowlist stays auditable per repository. |
| `denied-licenses` | No | | SPDX license identifiers to remove from the baseline allow set, even if they belong to an allowed group. Comma- or newline-separated. |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |

#### Managing the allowlist

The reciprocal/notice/unencumbered groups are fixed inside the action (they rarely change). Per-repository exceptions belong in that repository's `ALLOWED_LICENSES` GitHub Variable, managed via Terraform in `tailor-inc/tailor-infra`, e.g.:

```hcl
resource "github_actions_variable" "allowed_licenses" {
  repository    = github_repository.this.name
  variable_name = "ALLOWED_LICENSES"
  value         = "BlueOak-1.0.0,WTFPL,Unknown"
}
```

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
      - uses: tailor-platform/actions/preview-cleanup@v1
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

## License

MIT
