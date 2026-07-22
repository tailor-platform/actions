# Project Guidelines

## Branch

This is the `maintenance/v1` branch: the v1 line (actions target the Tailor Platform
SDK's now-removed `tailor-sdk` CLI). It predates the `tailor-sdk` -> `tailor` rename
that lives on `main` (v2) and is not merged into `main` — they're independent lines.

This branch is **not** protected by any GitHub ruleset, so commits/PRs can go straight
to it:

```bash
# using the wt helper (or any other way to check out this branch)
wt maintenance/v1

git add <files>
git commit -m "fix: ..."
git push origin maintenance/v1
```

Pushing directly runs this branch's own CI (`ci.yaml` / `test-*.yaml`) the same way it
runs on `main`.

## Release Procedure

This repository uses GitHub Releases with automatic major version tag updates.

### Steps

1. Create a GitHub release with a semver tag (e.g., `v1.8.0`), targeting this branch
   explicitly — `gh release create` targets the repository's default branch (`main`,
   the v2 line) unless told otherwise:
   ```bash
   gh release create v1.8.0 --target maintenance/v1 --title "v1.8.0" --generate-notes
   ```
2. The `update-major-tag.yaml` workflow automatically updates the major version tag (`v1`) to point to the new release. It only looks at the tag name, so this works the same regardless of which branch the release was cut from.
3. Users reference actions via the major version tag (e.g., `tailor-platform/actions/deploy@v1`), so no downstream changes are needed for patch/minor releases.

### Notes

- Tag format MUST be `vX.Y.Z` (strict semver). The workflow validates this and fails on non-conforming tags.
- Use `--generate-notes` to auto-generate release notes from merged PRs, or write notes manually with `--notes`.
- Always pass `--target maintenance/v1` for releases cut from this branch — omitting it releases whatever commit is currently at the tip of `main` instead.
