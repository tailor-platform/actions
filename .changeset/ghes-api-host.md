---
"tailor-platform-actions": patch
---

Support GitHub Enterprise Server in `relevance`, `find-base-run`, and `preview-deploy`: they now call the GitHub API, directly and through `gh`, on the host the workflow runs on instead of github.com.
