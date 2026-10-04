import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("published file list retains optional peer manifests required by real pnpm frozen install", () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "audit-workspace-publication-")));
  const root = join(temp, "repo");
  const published = join(temp, "published");
  const fakeBin = join(temp, "bin");
  const pnpm = execFileSync("which", ["pnpm"], { encoding: "utf8" }).trim();
  const run = (args, cwd) => execFileSync(pnpm, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    mkdirSync(join(root, "packages/peer"), { recursive: true });
    mkdirSync(join(root, "packages/foo"), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(root, "package.json"), '{"private":true}\n');
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\nlinkWorkspacePackages: true\n");
    writeFileSync(join(root, "packages/foo/package.json"), '{"name":"foo","version":"1.2.0"}\n');
    const manifest = '{"name":"peer","peerDependencies":{"foo":"^1.0.0"},"peerDependenciesMeta":{"foo":{"optional":true}}}\n';
    writeFileSync(join(root, "packages/peer/package.json"), manifest);
    run(["install", "--no-frozen-lockfile", "--ignore-scripts", "--offline"], root);
    cpSync(root, published, { recursive: true });
    writeFileSync(join(fakeBin, "pnpm"), `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "audit") {
  if (args.includes("--json")) process.stdout.write('{"advisories":{}}');
  if (args[2] === "update") {
    for (const path of ["packages/peer/package.json", "pnpm-lock.yaml"]) {
      fs.writeFileSync(path, fs.readFileSync(path, "utf8").replaceAll("^1.0.0", "^1.1.0"));
    }
  }
} else {
  const result = cp.spawnSync(process.env.REAL_PNPM, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
`);
    chmodSync(join(fakeBin, "pnpm"), 0o755);
    const output = join(temp, "outputs");
    execFileSync("node", [fileURLToPath(new URL("../../lockfile-audit-fix/lockfile-audit-fix.mjs", import.meta.url))], {
      cwd: root,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, REAL_PNPM: pnpm, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: output },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const text = readFileSync(output, "utf8");
    const match = text.match(/changed-files<<(\S+)\n([\s\S]*?)\n\1\n/);
    assert.ok(match);
    assert.match(text, /\nchanged=true\n/);
    assert.deepEqual(match[2].split("\n"), ["package.json", "packages/foo/package.json", "packages/peer/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
    for (const path of match[2].split("\n")) cpSync(join(root, path), join(published, path));
    run(["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], published);
    writeFileSync(join(published, "packages/peer/package.json"), manifest);
    assert.throws(() => run(["install", "--frozen-lockfile", "--ignore-scripts", "--offline"], published),
      (error) => /ERR_PNPM_OUTDATED_LOCKFILE/.test([error.stdout, error.stderr].join("\n")));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
