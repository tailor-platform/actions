---
"tailor-platform-actions": patch
---

Run yarn through Corepack in `setup`, so `package-manager: yarn` uses the Yarn version that `packageManager` or `devEngines.packageManager` declares. Projects on Yarn 2 or later without a committed `yarnPath` no longer fail in `setup` and `install` with `However the current global version of Yarn is 1.22.22`, and the action no longer needs Yarn or Corepack preinstalled on the runner. With yarn, the runner now needs access to the npm registry and to `repo.yarnpkg.com` (Yarn 2 and later) or `registry.yarnpkg.com` (Yarn 1).
