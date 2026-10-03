# Deploy

Deploy an application to an existing Tailor Platform workspace. See the [usage and inputs](../README.md#deploy) for setup and authentication.

## Outputs

| Name | Shape | Description |
|------|-------|-------------|
| `workspace-id` | String | The workspace ID passed to the action. |
| `app-url` | String | Backend application URL (GraphQL endpoint), or an empty string if unavailable. |
| `frontend-urls` | JSON object string | Published frontendPlugin URLs keyed by site name, such as `{"web":"https://web.example.com","admin":"https://admin.example.com"}`. |

`frontend-urls` comes from `tailor deploy --json` hooks whose `pluginId` is `@tailor-platform/frontend`, using `outputs.frontends[].site` and `.url`. It includes every frontend across comma-separated `TAILOR_PLATFORM_SDK_CONFIG_PATH` configs. The config list is passed unchanged to the SDK in a single deploy, so builds and uploads complete before the output is available. If a site appears more than once in the result, the last URL wins.

The output is `{}` when the plugin did not report any frontends, including older SDKs without `deployedHooks`. Static websites uploaded outside frontendPlugin are not included. A failed deploy or frontend build/upload fails the action.

Use `fromJSON(steps.deploy.outputs.frontend-urls)['web']` to read one site's URL. To pass the map to a later job, declare a job output; see the [preview example](../preview-deploy/README.md#use-a-frontend-url-in-a-later-job).
