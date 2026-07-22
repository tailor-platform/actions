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

Releases on `main` (the v2 line) are automated with [Changesets](https://github.com/changesets/changesets).
`maintenance/v1` and any future `maintenance/vN` branch still release manually — see
their own `CLAUDE.md` for that.

### Steps (main)

1. In the PR making the change, add a changeset describing it and its bump type
   (`patch`/`minor`/`major`):
   ```bash
   pnpm changeset
   ```
   This writes a file under `.changeset/`; commit it with the rest of the PR.
2. Once merged to `main`, `.github/workflows/release.yaml`
   ([`changesets/action`](https://github.com/changesets/action)) opens or updates a
   "Version Packages" PR that bumps `package.json`'s version and `CHANGELOG.md` from
   the accumulated changesets. Merge it like any other PR (review required).
3. Once that PR merges, the same workflow tags the new version (`vX.Y.Z`) and creates
   a GitHub release from the `CHANGELOG.md` entry — no manual `gh release create` step.
4. The `update-major-tag.yaml` workflow automatically updates the major version tag
   (`v2`) to point to the new release.
5. Users reference actions via the major version tag (e.g.,
   `tailor-platform/actions/deploy@v2`), so no downstream changes are needed for
   patch/minor releases.

### Notes

- A PR with no changeset doesn't trigger a release — `release.yaml` only tags/releases
  when there are no pending changesets *and* the current `package.json` version isn't
  already released (guarded by checking `gh release view vX.Y.Z` first).
- For breaking changes, use a `major` changeset (e.g. bumps `2.x.y` -> `3.0.0`). Update
  README usage examples to reference the new major tag, and branch the outgoing major
  version into its own `maintenance/vN` branch first (see `maintenance/v1` for the
  pattern) before merging the breaking change to `main`.
- Tag format is still `vX.Y.Z` (strict semver) — `update-major-tag.yaml` validates this
  regardless of how the tag/release was created.
