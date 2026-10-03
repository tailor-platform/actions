#!/usr/bin/env bash
set -euo pipefail

DEPLOY_JSON=$($TAILOR_RUN tailor deploy --yes --json)
FRONTEND_URLS=$(printf '%s\n' "$DEPLOY_JSON" | jq -ce '
  [.deployedHooks[]?
    | select(.pluginId == "@tailor-platform/frontend")
    | .outputs.frontends[]?
    | {key: .site, value: .url}]
  | from_entries
')
printf 'frontend-urls=%s\n' "$FRONTEND_URLS" >> "$GITHUB_OUTPUT"

if APP_JSON=$($TAILOR_RUN tailor show --json 2>/dev/null); then
  APP_URL=$(echo "$APP_JSON" | jq -r '.url // ""')
else
  APP_URL=""
fi
echo "app-url=$APP_URL" >> "$GITHUB_OUTPUT"
