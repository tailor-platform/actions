import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("lockfile-audit", () => {
  for (const [name, output, status] of [
    ["passes a clean HEAD without a usable base", "No known vulnerabilities found", 0],
    ["fails on existing vulnerabilities at the configured severity", "1 high vulnerability", 1],
    ["passes advisories below the configured severity", "1 low vulnerability", 0],
    ["fails when the registry cannot be reached", "registry unavailable", 1],
  ]) {
    test(name, () => {
      const dir = mkdtempSync(join(tmpdir(), "lockfile-audit-full-"));
      try {
        writeFileSync(join(dir, "pnpm-lock.yaml"), "head-content\n");
        writeFileSync(
          join(dir, "pnpm"),
          `#!/bin/sh\nprintf '%s\n' "$@" > "${join(dir, "args")}"\necho '${output}'\nexit ${status}\n`,
        );
        chmodSync(join(dir, "pnpm"), 0o755);
        const result = spawnSync(process.execPath, [join(__dirname, "lockfile-audit.mjs")], {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            AUDIT_LEVEL: "high",
            BASE_SHA_INPUT: "unusable-base",
          },
          encoding: "utf8",
        });
        assert.equal(result.status, status, result.stderr);
        assert.ok(result.stdout.includes(output), result.stdout);
        assert.equal(readFileSync(join(dir, "args"), "utf8"), "audit\n--audit-level=high\n");
        assert.equal(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8"), "head-content\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
