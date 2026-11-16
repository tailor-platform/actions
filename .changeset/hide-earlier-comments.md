---
"tailor-platform-actions": minor
---

`plan`, `preview-comment` and `preview-cleanup` no longer rewrite their previous PR comment. Each run now hides the earlier comments with the same marker as outdated and posts a new comment. A new `sticky` input, `false` by default, restores the old behavior when set to `true`: the newest matching comment is updated in place.
