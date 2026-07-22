# Project Guidelines

## Branch

This is the `maintenance/v1` branch: the v1 line (actions target the Tailor Platform
SDK's now-removed `tailor-sdk` CLI). It predates the `tailor-sdk` -> `tailor` rename
that lives on `main` (v2) and is not merged into `main` — they're independent lines.

This branch is protected the same way `main` is (PR required, at least one approving
review, no force-push/deletion, signed commits) — direct pushes are rejected. Make
changes via a PR:

```bash
# using the wt helper (or any other way to check out this branch)
wt maintenance/v1

git checkout -b fix/whatever
git add <files>
git commit -m "fix: ..."
git push -u origin fix/whatever
gh pr create --base maintenance/v1 --title "fix: ..." --body "..."
```

This branch's own CI (`ci.yaml` / `test-*.yaml`) runs on PRs against it and on pushes
to it (i.e. once a PR merges), the same way it runs on `main`.

## Release Procedure

Releases on this branch are automated with [Changesets](https://github.com/changesets/changesets),
the same way `main` (v2) is — see `main`'s `CLAUDE.md` for the general shape of the
flow. The only difference is which branch it runs on.

### Steps

1. In the PR making the change, add a changeset describing it and its bump type
   (`patch`/`minor`/`major`):
   ```bash
   pnpm changeset
   ```
   This writes a file under `.changeset/`; commit it with the rest of the PR.
2. Once merged to `maintenance/v1`, `.github/workflows/release.yaml`
   ([`changesets/action`](https://github.com/changesets/action)) opens or updates a
   "Version Packages" PR that bumps `package.json`'s version and `CHANGELOG.md` from
   the accumulated changesets. Merge it like any other PR (review required).
3. Once that PR merges, the same workflow tags the new version (`vX.Y.Z`) and creates
   a GitHub release from the `CHANGELOG.md` entry, targeting `maintenance/v1`
   explicitly (`gh release create --target maintenance/v1 ...` under the hood) — no
   manual release step.
4. The `update-major-tag.yaml` workflow automatically updates the major version tag
   (`v1`) to point to the new release. It only looks at the tag name, so this works
   the same regardless of which branch the release was cut from.
5. Users reference actions via the major version tag (e.g.,
   `tailor-platform/actions/deploy@v1`), so no downstream changes are needed for
   patch/minor releases.

### Notes

- A PR with no changeset doesn't trigger a release — `release.yaml` only tags/releases
  when there are no pending changesets *and* the current `package.json` version isn't
  already released (guarded by checking `gh release view vX.Y.Z` first).
- Tag format is still `vX.Y.Z` (strict semver) — `update-major-tag.yaml` validates this
  regardless of how the tag/release was created.
- This branch's `package.json` `name`/`version` are tracked independently from
  `main`'s — they're separate lines, so their version numbers advance independently.
