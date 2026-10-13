---
"tailor-platform-actions": patch
---

Use the workflow's GitHub host for API calls in `relevance`, `find-base-run`, `plan`, `preview-deploy`, `preview-comment`, and `preview-cleanup`, including nested comment actions. ERD schema actions still require GitHub.com because their artifact uploads use `actions/upload-artifact` v4 or later.
