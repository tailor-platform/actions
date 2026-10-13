---
"tailor-platform-actions": minor
---

Use the workflow's GitHub host for API calls in `relevance`, `find-base-run`, `plan`, `preview-deploy`, `preview-comment`, and `preview-cleanup`, including nested comment actions. Support ERD schema export and preview on GitHub Enterprise Server with upload-artifact v3.2.2 ZIP artifacts. On GHES, pass the new `preview-artifact-names` JSON array to `erd-schema-comment` to list candidate artifact names with run-page links; GitHub.com and Enterprise Cloud retain direct HTML links.
