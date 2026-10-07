# Deploy

Deploy an application to an existing Tailor Platform workspace. See the [usage and inputs](../README.md#deploy) for setup and authentication.

## Outputs

| Name | Shape | Description |
|------|-------|-------------|
| `workspace-id` | String | The workspace ID passed to the action. |
| `app-url` | String | **Deprecated**, will be removed in the next major version. Backend application URL (GraphQL endpoint), or an empty string if unavailable. |
| `frontend-urls` | JSON object string | **Deprecated**, will be removed in the next major version. Static website URLs keyed by site name, such as `{"web":"https://web.example.com","admin":"https://admin.example.com"}`. |

After `tailor deploy` completes, the action runs `tailor staticwebsite list --json` to collect every static website in the workspace. This includes frontendPlugin sites after their builds and uploads complete, as well as existing sites. Comma-separated `TAILOR_PLATFORM_SDK_CONFIG_PATH` configs are deployed together as before; the URL lookup covers the whole workspace and does not depend on deploy hook outputs.

The output is `{}` when the workspace has no static websites. It also works with SDK versions without `deployedHooks`. A failed deploy, frontend build/upload, or website lookup fails the action.

Use `fromJSON(steps.deploy.outputs.frontend-urls)['web']` to read one site's URL. To pass the map to a later job, declare a job output; see the [preview example](../preview-deploy/README.md#use-a-frontend-url-in-a-later-job).
