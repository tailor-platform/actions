---
"tailor-platform-actions": minor
---

Show when a preview workspace expires in the PR comment. `preview-deploy` gains an `expires-at` output, the instant the workspace becomes prunable as UTC ISO 8601, set when `ttl` is given and the expiry was recorded on that push. `preview-comment` gains an `expires-at` input that adds an `Expires` row to the comment, and a `timezones` input (comma- or newline-separated IANA names, default `UTC`) that picks the timezones the expiry is shown in, for example `UTC,Asia/Tokyo` renders `2026-10-27 12:00 UTC / 2026-10-27 21:00 Asia/Tokyo`. Pass `expires-at: ${{ steps.<preview-deploy step id>.outputs.expires-at }}` to `preview-comment` to turn it on. A name that is not a known timezone is skipped with a warning, and both inputs are off by default, so existing workflows behave as before.
