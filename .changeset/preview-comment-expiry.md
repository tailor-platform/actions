---
"tailor-platform-actions": minor
---

Show when a preview workspace expires in the PR comment. `preview-comment` reads the expiry of the workspace with `tailor workspace get --json` (CLI 2.16.0 or later), using the `tailor` runner and login that `preview-deploy` set up earlier in the same job, and adds an `Expires` row to the comment. A `timezones` input (comma- or newline-separated IANA names, default `UTC`) picks the timezones it is shown in, one under the other, for example `UTC,Asia/Tokyo` shows `2026-10-27 12:00 UTC` and, on the next line, `2026-10-27 21:00 Asia/Tokyo`. A `working-directory` input sets where the CLI is run from in a monorepo. No row is shown for a workspace with no expiry, one that was cleaned up, or when the CLI cannot be run, so existing workflows need no change and get the row once they set `ttl` on `preview-deploy`.
