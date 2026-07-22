# Project Guidelines

## Branches

`main` is the current major line (v2 — actions target the Tailor Platform SDK's
`tailor` CLI). `maintenance/v1` holds the pre-v2 line (actions target the removed
`tailor-sdk` CLI) so the v1.x.y release series can still receive patches. It predates
the `v1` -> `v2` rename and is not merged into `main`. `maintenance/v1` is protected
the same way `main` is (PR required, at least one approving review, no
force-push/deletion, signed commits) — send v1 fixes as a PR against it, not a direct
push. See its own `CLAUDE.md` for that branch's release steps. Its CI (`ci.yaml` /
`test-*.yaml`) runs on PRs against it and on pushes to it, the same way it does on
`main`.

## Release Procedure

This repository uses GitHub Releases with automatic major version tag updates.

### Steps

1. Create a GitHub release with a semver tag (e.g., `v2.1.0`):
   ```bash
   gh release create v2.1.0 --title "v2.1.0" --generate-notes
   ```
   This targets `main` by default. For a v1.x.y patch release, target the maintenance
   branch explicitly instead (see `maintenance/v1`'s `CLAUDE.md`).
2. The `update-major-tag.yaml` workflow automatically updates the major version tag (e.g., `v2`) to point to the new release. It only looks at the tag name, so this works the same regardless of which branch the release was cut from.
3. Users reference actions via the major version tag (e.g., `tailor-platform/actions/deploy@v2`), so no downstream changes are needed for patch/minor releases.

### Notes

- Tag format MUST be `vX.Y.Z` (strict semver). The workflow validates this and fails on non-conforming tags.
- Use `--generate-notes` to auto-generate release notes from merged PRs, or write notes manually with `--notes`.
- For breaking changes, bump the major version (e.g., `v3.0.0`). Update README usage examples to reference the new major tag, and branch off the outgoing major version into its own `maintenance/vN` branch first (see `maintenance/v1` for the pattern).
