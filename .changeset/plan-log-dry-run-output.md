---
"tailor-platform-actions": patch
---

Print the dry-run output to the job log in `plan`. The output went to the step summary and, on pull requests, the PR comment, so the log of a failed plan showed nothing but `Plan dry-run failed with exit code 1`. The log now shows the CLI's error, for example `Error [WORKSPACE_NOT_FOUND]: Workspace "<id>" was not found.`, and with SDK 2.16.0 or later the run also gets the CLI's error annotation next to the `Plan dry-run failed` one.
