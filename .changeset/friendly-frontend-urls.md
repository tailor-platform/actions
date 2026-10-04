---
"tailor-platform-actions": minor
---

Expose `frontend-urls` from deploy and preview-deploy as a JSON object mapping all static website names in the deployed workspace to URLs. Resolve URLs with `tailor staticwebsite list --json` after deployment, returning `{}` when no sites exist and supporting SDK versions without deploy hook outputs. Preserve existing workspace and backend URL outputs.
