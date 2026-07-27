# Project Guidelines

## Branch

This is the `maintenance/v1` branch: the v1 line (actions target the Tailor Platform
SDK's now-removed `tailor-sdk` CLI). It predates the `tailor-sdk` -> `tailor` rename
that lives on `main` (v2) and is not merged into `main` — they're independent lines.

This branch has no protection ruleset yet — protecting it the same way `main` is (PR
required, at least one approving review, no force-push/deletion, signed commits) is
still pending, so direct pushes currently succeed. Make changes via a PR anyway, so
that this branch's CI runs before anything lands:

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
3. Once that PR merges (no pending changesets left), the same workflow runs
   `changeset publish` as its `publish` command. This package is `"private": true`,
   and `.changeset/config.json`'s `privatePackages.tag: true` tells `changeset publish`
   to skip an actual npm publish but still create the git tag for the new version.
   `changesets/action` detects that and creates the GitHub release itself from the
   `CHANGELOG.md` entry — no hand-rolled `gh release create` step.
4. The same job then updates the major version tag (`v1`) to point to the new
   release, right after creating it — a release created with the workflow's own
   `GITHUB_TOKEN` doesn't fire `update-major-tag.yaml`'s `release: published` trigger,
   so it can't rely on that separate workflow. `update-major-tag.yaml` still exists as
   a fallback for any release created by other means (e.g. manually via the GitHub UI).
5. Users reference actions via the major version tag (e.g.,
   `tailor-platform/actions/deploy@v1`), so no downstream changes are needed for
   patch/minor releases.

### Notes

- A PR with no changeset doesn't trigger a release — `changeset publish` only
  tags/releases when there are no pending changesets *and* the current version isn't
  already tagged (it checks this itself, locally and against the remote).
- `release.yaml` deliberately has no `concurrency:` group: GitHub's concurrency queue
  keeps only the latest *pending* run per group and cancels older ones, which would
  silently skip a version's release if pushes to `maintenance/v1` land close together.
  The alternative (rare) risk of two truly concurrent runs racing to push to the same
  Version Packages PR branch is self-evident (one push fails loudly) and self-corrects
  on the next push, rather than silently losing a release.
- `changesets/action`'s inputs/outputs are camelCase (`commitMode`, `publish`,
  `publishedPackages`) at the pinned `v1.9.0` — its own `main` branch docs use a newer,
  unreleased kebab-case naming (`commit-mode`, `publish-script`, `published-packages`).
  Passing the wrong casing doesn't error since GitHub Actions silently ignores a
  `with:` key an action doesn't declare — always check the input/output names against
  the actual pinned commit's `action.yml`, not the action's default-branch docs.
- Tag format is still `vX.Y.Z` (strict semver) — the `update-major-tag` composite
  action (`.github/actions/update-major-tag`, shared by `release.yaml` and
  `update-major-tag.yaml`) validates this regardless of how the tag/release was created.
- This branch's `package.json` `name`/`version` are tracked independently from
  `main`'s — they're separate lines, so their version numbers advance independently.
