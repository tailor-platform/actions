# Project Guidelines

## Release Procedure

This repository uses GitHub Releases with automatic major version tag updates.

### Steps

1. Create a GitHub release with a semver tag (e.g., `v1.1.0`):
   ```bash
   gh release create v1.1.0 --title "v1.1.0" --generate-notes
   ```
2. The `update-major-tag.yaml` workflow automatically updates the major version tag (e.g., `v1`) to point to the new release.

### Consumer usage: pin to a full commit SHA, not the `v1` tag

Reference actions by the release commit's full SHA with a version comment, e.g. `tailor-platform/actions/deploy@<sha> # v1.2.3` — not the floating `v1` tag. Several consuming repos enforce SHA-pinning as a supply-chain-security policy (e.g. `ghalint`'s `action_ref_should_be_full_length_commit_sha`), which a floating tag fails outright.

This means downstream repos don't automatically pick up new `v1.x.y` releases the way a floating tag would. **Recommended: let Renovate keep the pin (and version comment) current automatically** — its default GitHub Actions manager already understands the `@<sha> # vX.Y.Z` pattern and opens a PR when a new release lands, the same way it tracks any other pinned action. Repos without Renovate configured for this can instead run `pinact run --update` periodically (verify with `pinact run --verify` first) — see this repo's own `renovate.json` (`:pinAllExceptPeerDependencies`) for a working baseline config.

The `v1` major tag still exists (and still moves on every release, via `update-major-tag.yaml`) for convenience — e.g. quick manual testing — but production workflows should pin to a SHA.

### Notes

- Tag format MUST be `vX.Y.Z` (strict semver). The `update-major-tag.yaml` workflow validates this and fails on non-conforming tags.
- Use `--generate-notes` to auto-generate release notes from merged PRs, or write notes manually with `--notes`.
- For breaking changes, bump the major version (e.g., `v2.0.0`). Update README usage examples to reference the new release's SHA.
