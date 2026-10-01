---
"tailor-platform-actions": patch
---

`check-licenses` now runs `pnpm licenses list -r` when the working directory is inside a pnpm workspace (a `pnpm-workspace.yaml` declaring `packages` in it or any parent directory). Starting with pnpm 12.8.0, `pnpm licenses list` without `-r` only reports the current project's own dependencies, so at a workspace root whose `package.json` has no dependencies it returned `{}` and the action passed without checking any of the sub-projects' licenses. With `-r`, every pnpm version checks the whole workspace again, matching how earlier pnpm versions (checked on 10.33.0 and 12.4.1) behaved without it. Standalone projects keep running without `-r`, since pnpm 10 crashes on `licenses list -r` in a standalone project that has a `file:` dependency on its own subdirectory.
