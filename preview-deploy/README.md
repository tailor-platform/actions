# Preview deploy

Create or reuse a per-PR workspace, then deploy the application and its frontendPlugin sites. See the [usage and inputs](../README.md#preview-deploy) for setup, authentication, and preview comments.

## Outputs

| Name | Shape | Description |
|------|-------|-------------|
| `workspace-id` | String | Workspace ID of the preview deployment. |
| `workspace-name` | String | Full workspace name, for example `my-app-pr-42`. |
| `app-urls` | JSON object string | All application base URLs in the workspace, keyed by application name, for example `{"core":"https://core.example.com","portal":"https://portal.example.com"}`. `{}` when there are no applications. |
| `console-urls` | JSON object string | Console URLs keyed by application name. `{}` when unavailable. |
| `app-url` | String | **Deprecated**, will be removed in the next major version. Backend application URL (GraphQL endpoint), or an empty string if unavailable. |
| `frontend-urls` | JSON object string | **Deprecated**, will be removed in the next major version. Static website URLs keyed by site name, for example `{"web":"https://web.example.com"}`. |

`app-urls` includes every application in the workspace after deployment, including existing applications and all apps from comma-separated `TAILOR_CONFIG_PATH` configs. These are base URLs; append `/query` for a GraphQL endpoint. The lookup does not load a config file and fetches all pages. A failed application lookup emits a warning and returns `{}` without failing the deployment. Read one URL with `fromJSON(steps.deploy.outputs.app-urls)['core']`, replacing `deploy` with your deployment step ID and `core` with your application name.

`frontend-urls` lists all static websites in the preview workspace after deployment, including sites from comma-separated `TAILOR_CONFIG_PATH` configs and existing sites. It is `{}` when no static websites exist and does not depend on `deployedHooks`. See [deploy output behavior](../deploy/README.md#outputs) for details.

Pass `app-urls: ${{ steps.preview.outputs.app-urls }}` to `preview-comment` to display one named URL row per application. Also pass `console-urls: ${{ steps.preview.outputs.console-urls }}` to add one `Console URL (name)` row per application. Existing callers passing only `app-url` keep their single URL row.

`console-urls` uses the same application lookup without another API call. Its base is `TAILOR_PLATFORM_CONSOLE_URL`, otherwise the origin of `TAILOR_PLATFORM_URL` with the first hostname label replaced by `console`, otherwise `https://console.tailor.tech`. Each URL points to `/workspaces/<id>/services/applications/<name>`, with path components URL-encoded. Generation failures emit a warning and return `{}` without failing the deployment.

## Use a frontend URL in a later job

After checkout, runtime setup, and dependency installation in the `preview` job:

```yaml
jobs:
  preview:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    outputs:
      frontend-urls: ${{ steps.preview.outputs.frontend-urls }}
    steps:
      - uses: tailor-platform/actions/preview-deploy@v2
        id: preview
        with:
          workspace-name-prefix: my-app
          region: us-west
          platform-client-id: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID }}
          platform-client-secret: ${{ secrets.TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

  e2e:
    needs: preview
    runs-on: ubuntu-latest
    permissions:
      contents: read
    env:
      BASE_URL: ${{ fromJSON(needs.preview.outputs.frontend-urls)['web'] }}
    steps:
      - run: |
          test -n "$BASE_URL"
          pnpm exec playwright test
```

Replace `web` with the configured static website's site name. `app-url` remains the backend URL; frontend URLs are available only after the plugin finishes building and uploading.
