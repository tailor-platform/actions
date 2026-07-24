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
`maintenance/v1` is automated the same way, via its own copy of
`.github/workflows/release.yaml` — `main` and `maintenance/v1` are independent lines
(neither merges into the other), so each carries its own copy rather than sharing one.
Any future `maintenance/vN` branch should set up the same automation when it's branched
off; see `maintenance/v1`'s own `CLAUDE.md` for that branch's specific steps (e.g. it
passes `--target maintenance/v1` to `gh release create`).

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
3. Once that PR merges (no pending changesets left), the same workflow runs
   `changeset publish` as its `publish` command. This package is `"private": true`,
   and `.changeset/config.json`'s `privatePackages.tag: true` tells `changeset publish`
   to skip an actual npm publish but still create the git tag for the new version.
   `changesets/action` detects that and creates the GitHub release itself from the
   `CHANGELOG.md` entry — no hand-rolled `gh release create` step.
4. The same job then updates the major version tag (`v2`) to point to the new
   release, right after creating it — a release created with the workflow's own
   `GITHUB_TOKEN` doesn't fire `update-major-tag.yaml`'s `release: published` trigger,
   so it can't rely on that separate workflow. `update-major-tag.yaml` still exists as
   a fallback for any release created by other means (e.g. manually via the GitHub UI).
5. Users reference actions via the major version tag (e.g.,
   `tailor-platform/actions/deploy@v2`), so no downstream changes are needed for
   patch/minor releases.

### Notes

- A PR with no changeset doesn't trigger a release — `changeset publish` only
  tags/releases when there are no pending changesets *and* the current version isn't
  already tagged (it checks this itself, locally and against the remote).
- `release.yaml` deliberately has no `concurrency:` group: GitHub's concurrency queue
  keeps only the latest *pending* run per group and cancels older ones, which would
  silently skip a version's release if pushes to `main` land close together. The
  alternative (rare) risk of two truly concurrent runs racing to push to the same
  Version Packages PR branch is self-evident (one push fails loudly) and self-corrects
  on the next push, rather than silently losing a release.
- `changesets/action`'s inputs/outputs are camelCase (`commitMode`, `publish`,
  `publishedPackages`) at the pinned `v1.9.0` — its own `main` branch docs use a newer,
  unreleased kebab-case naming (`commit-mode`, `publish-script`, `published-packages`).
  Passing the wrong casing doesn't error since GitHub Actions silently ignores a
  `with:` key an action doesn't declare — always check the input/output names against
  the actual pinned commit's `action.yml`, not the action's default-branch docs.
- For breaking changes, use a `major` changeset (e.g. bumps `2.x.y` -> `3.0.0`). Update
  README usage examples to reference the new major tag, and branch the outgoing major
  version into its own `maintenance/vN` branch first (see `maintenance/v1` for the
  pattern) before merging the breaking change to `main`.
- Tag format is still `vX.Y.Z` (strict semver) — `update-major-tag.yaml` validates this
  regardless of how the tag/release was created.
