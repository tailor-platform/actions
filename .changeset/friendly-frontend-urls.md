---
"tailor-platform-actions": minor
---

Expose `frontend-urls` from deploy and preview-deploy as a JSON object mapping frontendPlugin site names to published URLs across all deployed configs. Return `{}` when no frontend outputs are present, including with older SDK versions, while preserving existing workspace and backend URL outputs.
