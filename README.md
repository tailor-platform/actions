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

#### Secrets and variables setup

```bash
# Machine user credentials (repository or environment secrets)
gh secret set TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID
gh secret set TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET

# Workspace ID (GitHub Environment variable — one per environment)
gh variable set TAILOR_PLATFORM_WORKSPACE_ID --env production
```

#### Scaffold with Tailor SDK CLI

The [`tailor-sdk setup github`](https://github.com/tailor-platform/sdk) command generates a workflow file that uses this action, with package manager auto-detection.

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
- ℹ️ **Not provisioned**: Workspace ID is empty — dry-run skipped

The comment is keyed per workspace via a `<!-- tailor-plan: KEY -->` marker (`KEY` is the `label` input if provided, otherwise `workspace-id`, otherwise `"workspace"`), so multiple environments can post separate comments on the same PR. The comment is automatically updated on subsequent runs.

## License

MIT
