import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  resolveBaseSha,
  isValidSha,
  extractAdvisoryIds,
  findNewAdvisoryIds,
  findAdvisoryById,
  formatAdvisoryLine,
  formatAdvisoryLines,
  baseCommitExists,
  baseHasLockfile,
} from "./lockfile-audit.mjs";

const ZERO_SHA = "0000000000000000000000000000000000000000";

describe("resolveBaseSha", () => {
  test("an explicit base-sha input always wins", () => {
    assert.equal(
      resolveBaseSha({ baseShaInput: "abc123", eventName: "pull_request", prBaseSha: "def456" }),
      "abc123",
    );
  });

  test("pull_request uses the PR's base sha", () => {
    assert.equal(
      resolveBaseSha({ eventName: "pull_request", prBaseSha: "abc123", pushBeforeSha: "def456" }),
      "abc123",
    );
  });

  test("pull_request_target also uses the PR's base sha (same payload shape as pull_request)", () => {
    assert.equal(
      resolveBaseSha({ eventName: "pull_request_target", prBaseSha: "abc123", pushBeforeSha: "def456" }),
      "abc123",
    );
  });

  test("push (or any other event) uses the ref's previous tip", () => {
    assert.equal(
      resolveBaseSha({ eventName: "push", prBaseSha: "abc123", pushBeforeSha: "def456" }),
      "def456",
    );
  });

  test("returns null when the resolved sha is empty", () => {
    assert.equal(resolveBaseSha({ eventName: "push", pushBeforeSha: "" }), null);
    assert.equal(resolveBaseSha({ eventName: "push", pushBeforeSha: undefined }), null);
  });

  test("returns null for the all-zero sha (new branch / workflow_dispatch)", () => {
    assert.equal(resolveBaseSha({ eventName: "push", pushBeforeSha: ZERO_SHA }), null);
  });
});

describe("isValidSha", () => {
  test("accepts a full 40-char hex SHA-1", () => {
    assert.equal(isValidSha("a".repeat(40)), true);
  });

  test("accepts a full 64-char hex SHA-256", () => {
    assert.equal(isValidSha("a".repeat(64)), true);
  });

  test("accepts uppercase hex", () => {
    assert.equal(isValidSha("A".repeat(40)), true);
  });

  test("rejects a value starting with - (could be parsed as a git option)", () => {
    assert.equal(isValidSha(`-${"a".repeat(39)}`), false);
  });

  test("rejects a non-hex or wrong-length string", () => {
    assert.equal(isValidSha("not-a-sha"), false);
    assert.equal(isValidSha("a".repeat(39)), false);
    assert.equal(isValidSha(""), false);
  });
});

describe("extractAdvisoryIds", () => {
  test("reads IDs from an object keyed by advisory ID (pnpm/npm-classic shape)", () => {
    const auditJson = {
      advisories: {
        1001: { github_advisory_id: "GHSA-aaaa-bbbb-cccc" },
        1002: { github_advisory_id: "GHSA-dddd-eeee-ffff" },
      },
    };
    assert.deepEqual(extractAdvisoryIds(auditJson), new Set(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]));
  });

  test("tolerates an array shape too", () => {
    const auditJson = { advisories: [{ github_advisory_id: "GHSA-aaaa-bbbb-cccc" }] };
    assert.deepEqual(extractAdvisoryIds(auditJson), new Set(["GHSA-aaaa-bbbb-cccc"]));
  });

  test("ignores entries with a missing or empty ID", () => {
    const auditJson = { advisories: { 1: { github_advisory_id: "" }, 2: {} } };
    assert.deepEqual(extractAdvisoryIds(auditJson), new Set());
  });

  test("returns an empty set when there are no advisories", () => {
    assert.deepEqual(extractAdvisoryIds({ advisories: {} }), new Set());
    assert.deepEqual(extractAdvisoryIds({}), new Set());
  });
});

describe("findNewAdvisoryIds", () => {
  test("returns IDs present in head but not base", () => {
    const head = new Set(["GHSA-a", "GHSA-b", "GHSA-c"]);
    const base = new Set(["GHSA-a"]);
    assert.deepEqual(findNewAdvisoryIds(head, base), ["GHSA-b", "GHSA-c"]);
  });

  test("returns an empty array when nothing new was introduced", () => {
    const head = new Set(["GHSA-a"]);
    const base = new Set(["GHSA-a", "GHSA-b"]);
    assert.deepEqual(findNewAdvisoryIds(head, base), []);
  });

  test("sorts the result", () => {
    const head = new Set(["GHSA-c", "GHSA-a", "GHSA-b"]);
    const base = new Set();
    assert.deepEqual(findNewAdvisoryIds(head, base), ["GHSA-a", "GHSA-b", "GHSA-c"]);
  });
});

describe("findAdvisoryById / formatAdvisoryLine / formatAdvisoryLines", () => {
  const auditJson = {
    advisories: {
      1: {
        github_advisory_id: "GHSA-whgm-jr23-g3j9",
        title: "Uncontrolled Resource Consumption in ansi-html",
        module_name: "ansi-html",
        severity: "high",
      },
      2: {
        github_advisory_id: "GHSA-w5p7-h5w8-2hfq",
        title: "Regular Expression Denial of Service in trim",
        module_name: "trim",
        severity: "high",
      },
    },
  };

  test("findAdvisoryById finds the matching advisory", () => {
    assert.equal(findAdvisoryById(auditJson, "GHSA-w5p7-h5w8-2hfq")?.module_name, "trim");
  });

  test("findAdvisoryById returns undefined for an unknown ID", () => {
    assert.equal(findAdvisoryById(auditJson, "GHSA-nope"), undefined);
  });

  test("formatAdvisoryLine formats id/title/module/severity", () => {
    assert.equal(
      formatAdvisoryLine(auditJson.advisories[2]),
      "- GHSA-w5p7-h5w8-2hfq: Regular Expression Denial of Service in trim (module: trim, severity: high)",
    );
  });

  test("formatAdvisoryLine returns null for a missing advisory", () => {
    assert.equal(formatAdvisoryLine(undefined), null);
  });

  test("formatAdvisoryLines formats each new ID in order, skipping unresolvable ones", () => {
    assert.deepEqual(formatAdvisoryLines(auditJson, ["GHSA-whgm-jr23-g3j9", "GHSA-nope", "GHSA-w5p7-h5w8-2hfq"]), [
      "- GHSA-whgm-jr23-g3j9: Uncontrolled Resource Consumption in ansi-html (module: ansi-html, severity: high)",
      "- GHSA-w5p7-h5w8-2hfq: Regular Expression Denial of Service in trim (module: trim, severity: high)",
    ]);
  });
});

describe("baseCommitExists / baseHasLockfile", () => {
  let repoDir;
  let noLockfileSha;
  let withLockfileSha;

  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "lockfile-audit-test-"));
    const git = (...args) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");

    // A commit that predates pnpm-lock.yaml's introduction.
    writeFileSync(join(repoDir, "package.json"), "{}\n");
    git("add", "-A");
    git("commit", "-q", "-m", "no lockfile yet");
    noLockfileSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git("add", "-A");
    git("commit", "-q", "-m", "add lockfile");
    withLockfileSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  });

  after(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("baseCommitExists is true for a commit reachable in this checkout", () => {
    assert.equal(baseCommitExists(withLockfileSha, repoDir), true);
    assert.equal(baseCommitExists(noLockfileSha, repoDir), true);
  });

  test("baseCommitExists is false for a sha absent from history (e.g. shallow clone misconfiguration)", () => {
    // Well-formed but unreachable in this tiny repo's history.
    const unreachableSha = "f".repeat(40);
    assert.equal(baseCommitExists(unreachableSha, repoDir), false);
  });

  test("baseHasLockfile is true when the commit has pnpm-lock.yaml", () => {
    assert.equal(baseHasLockfile(withLockfileSha, repoDir), true);
  });

  test("baseHasLockfile is false when the commit predates the lockfile (commit itself still exists)", () => {
    assert.equal(baseCommitExists(noLockfileSha, repoDir), true);
    assert.equal(baseHasLockfile(noLockfileSha, repoDir), false);
  });
});

describe("baseHasLockfile resolves paths relative to cwd, for monorepo working-directory callers", () => {
  let repoDir;
  let rootOnlySha;

  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "lockfile-audit-monorepo-test-"));
    const git = (...args) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");

    // Only the repo root has a lockfile; the "sub" project doesn't yet.
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "root\n");
    git("add", "-A");
    git("commit", "-q", "-m", "root lockfile only");
    rootOnlySha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  });

  after(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("with cwd at the repo root, the root's own lockfile resolves", () => {
    assert.equal(baseHasLockfile(rootOnlySha, repoDir), true);
  });

  test("with cwd in a subdirectory that has no lockfile at that commit, resolution fails (proves it's cwd-relative, not repo-root-relative)", () => {
    const subDir = join(repoDir, "sub");
    mkdirSync(subDir);
    // If `${sha}:./pnpm-lock.yaml` resolved against the repo root instead
    // of cwd, this would incorrectly find the root's lockfile.
    assert.equal(baseHasLockfile(rootOnlySha, subDir), false);
  });
});

describe("main() restores pnpm-lock.yaml before exiting on a base-audit error", () => {
  // Spawns the script as a real subprocess (main() calls process.exit(),
  // which would kill an in-process test) with a fake `pnpm` on PATH that
  // succeeds once (the HEAD audit) and then fails with unparseable output
  // (the BASE audit) — reproducing the exact LockfileAuditError path that
  // process.exit() must not short-circuit past the outer finally.
  test("pnpm-lock.yaml still holds the HEAD content after the process exits", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "lockfile-audit-restore-test-"));
    const fakeBinDir = mkdtempSync(join(tmpdir(), "lockfile-audit-fake-pnpm-"));
    try {
      const git = (...args) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");

      writeFileSync(join(repoDir, "pnpm-lock.yaml"), "base-content\n");
      git("add", "-A");
      git("commit", "-q", "-m", "base");
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

      writeFileSync(join(repoDir, "pnpm-lock.yaml"), "head-content\n");
      git("add", "-A");
      git("commit", "-q", "-m", "head");

      const counterFile = join(fakeBinDir, "call-count");
      writeFileSync(counterFile, "0");
      writeFileSync(
        join(fakeBinDir, "pnpm"),
        [
          "#!/bin/sh",
          `n=$(cat "${counterFile}")`,
          "n=$((n + 1))",
          `echo "$n" > "${counterFile}"`,
          'if [ "$n" -eq 1 ]; then echo \'{"advisories":{}}\'; exit 0; fi',
          "echo 'not valid json' >&2",
          "exit 1",
        ].join("\n"),
      );
      chmodSync(join(fakeBinDir, "pnpm"), 0o755);

      let exitCode = 0;
      try {
        execFileSync("node", [join(__dirname, "lockfile-audit.mjs")], {
          cwd: repoDir,
          env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, BASE_SHA_INPUT: baseSha },
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch (e) {
        exitCode = e.status;
      }

      assert.equal(exitCode, 1, "the script should exit 1 on an unparseable base audit");
      assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), "head-content\n");
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });
});

describe("main() rejects a base-sha that doesn't look like a git object id, before ever invoking git or pnpm", () => {
  test("a base-sha input starting with - fails hard instead of being passed to git", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "lockfile-audit-invalid-sha-test-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repoDir, stdio: "ignore" });

      let exitCode = 0;
      let stderr = "";
      try {
        execFileSync("node", [join(__dirname, "lockfile-audit.mjs")], {
          cwd: repoDir,
          // No fake pnpm on PATH: if this ever reached git or pnpm, the
          // process would fail differently (ENOENT/git errors), not with
          // the intended validation message below.
          env: { ...process.env, BASE_SHA_INPUT: `-${"a".repeat(39)}` },
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (e) {
        exitCode = e.status;
        stderr = e.stderr.toString();
      }

      assert.equal(exitCode, 1);
      assert.match(stderr, /does not look like a git object id/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
