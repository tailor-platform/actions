---
"tailor-platform-actions": minor
---

Show when a preview workspace expires in the PR comment. `preview-deploy` gains an `expires-at` output, the instant the workspace becomes prunable as the CLI records it, read back with `tailor workspace get` (CLI 2.16.0 or later) after the workspace is created or its expiry extended, and empty when the workspace has no expiry. `preview-comment` gains an `expires-at` input that adds an `Expires` row to the comment, and a `timezones` input (comma- or newline-separated IANA names, default `UTC`) that picks the timezones the expiry is shown in, one under the other, for example `UTC,Asia/Tokyo` shows `2026-10-27 12:00 UTC` and, on the next line, `2026-10-27 21:00 Asia/Tokyo`. Pass `expires-at: ${{ steps.<preview-deploy step id>.outputs.expires-at }}` to `preview-comment` to turn it on. A name that is not a known timezone is skipped with a warning, and both inputs are off by default, so existing workflows behave as before.
