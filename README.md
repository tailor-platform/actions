# Tailor Platform Actions

Reusable GitHub Actions for [Tailor Platform](https://tailor.tech/).

## Actions

### [`deploy`](deploy/action.yaml)

Deploy an application to Tailor Platform. Handles token acquisition, workspace provisioning, code generation, and deployment.

**Prerequisites:** The caller is responsible for checkout, Node.js setup, package manager setup, and dependency installation. This keeps the action package-manager agnostic.

#### Usage

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
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
          workspace-name: my-app
          workspace-region: asia-northeast
          organization-id: ${{ vars.TAILOR_PLATFORM_ORGANIZATION_ID }}
          folder-id: ${{ vars.TAILOR_PLATFORM_FOLDER_ID }}
          platform-client-id: ${{ secrets.PLATFORM_MACHINE_USER_CLIENT_ID }}
          platform-client-secret: ${{ secrets.PLATFORM_MACHINE_USER_CLIENT_SECRET }}
```

#### Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `workspace-name` | Yes | | Workspace name |
| `workspace-region` | Yes | | Workspace region |
| `organization-id` | Yes | | Organization ID |
| `folder-id` | Yes | | Folder ID |
| `working-directory` | No | `.` | Working directory (for monorepo setups) |
| `platform-client-id` | Yes | | OAuth2 client ID for machine user |
| `platform-client-secret` | Yes | | OAuth2 client secret for machine user |

#### Outputs

| Name | Description |
|------|-------------|
| `workspace-id` | Workspace ID (created or existing) |

#### Secrets setup

```bash
gh secret set PLATFORM_MACHINE_USER_CLIENT_ID
gh secret set PLATFORM_MACHINE_USER_CLIENT_SECRET
```

#### Scaffold with Tailor SDK CLI

The [`tailor-sdk setup github`](https://github.com/tailor-platform/sdk) command generates a workflow file that uses this action, with package manager auto-detection.

## License

MIT
