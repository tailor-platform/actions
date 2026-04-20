# Project Guidelines

## Release Procedure

This repository uses GitHub Releases with automatic major version tag updates.

### Steps

1. Create a GitHub release with a semver tag (e.g., `v1.1.0`):
   ```bash
   gh release create v1.1.0 --title "v1.1.0" --generate-notes
   ```
2. The `update-major-tag.yaml` workflow automatically updates the major version tag (e.g., `v1`) to point to the new release.
3. Users reference actions via the major version tag (e.g., `tailor-platform/actions/deploy@v1`), so no downstream changes are needed for patch/minor releases.

### Notes

- Tag format MUST be `vX.Y.Z` (strict semver). The workflow validates this and fails on non-conforming tags.
- Use `--generate-notes` to auto-generate release notes from merged PRs, or write notes manually with `--notes`.
- For breaking changes, bump the major version (e.g., `v2.0.0`). Update README usage examples to reference the new major tag.
