# Preview deploy

Create or reuse a per-PR workspace, then deploy the application and its frontendPlugin sites. See the [usage and inputs](../README.md#preview-deploy) for setup, authentication, and preview comments.

## Outputs

| Name | Shape | Description |
|------|-------|-------------|
| `workspace-id` | String | Workspace ID of the preview deployment. |
| `workspace-name` | String | Full workspace name, for example `my-app-pr-42`. |
| `app-url` | String | Backend application URL (GraphQL endpoint), or an empty string if unavailable. |
| `frontend-urls` | JSON object string | Published frontendPlugin URLs keyed by site name, for example `{"web":"https://web.example.com"}`. |

`frontend-urls` combines all frontends from comma-separated `TAILOR_PLATFORM_SDK_CONFIG_PATH` configs. It is `{}` when no frontendPlugin URLs were reported, including with older SDKs without `deployedHooks`. See [deploy output behavior](../deploy/README.md#outputs) for details.

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
