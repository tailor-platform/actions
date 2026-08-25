import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  extractAdvisoryIds,
  findFixedAdvisoryIds,
  findAdvisoryById,
  formatAdvisoryLine,
  formatAdvisoryLines,
  parseImporters,
  loadFixedGroupNormalizer,
  diffRuntimeDeps,
  buildSummary,
} from "./lockfile-audit-fix.mjs";

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

  test("returns an empty set when there are no advisories", () => {
    assert.deepEqual(extractAdvisoryIds({ advisories: {} }), new Set());
    assert.deepEqual(extractAdvisoryIds({}), new Set());
  });
});

describe("findFixedAdvisoryIds", () => {
  test("returns IDs present before but not after (i.e. cleared by the fix)", () => {
    const before = new Set(["GHSA-a", "GHSA-b", "GHSA-c"]);
    const after = new Set(["GHSA-b"]);
    assert.deepEqual(findFixedAdvisoryIds(before, after), ["GHSA-a", "GHSA-c"]);
  });

  test("returns an empty array when nothing was fixed", () => {
    const before = new Set(["GHSA-a"]);
    const after = new Set(["GHSA-a", "GHSA-b"]);
    assert.deepEqual(findFixedAdvisoryIds(before, after), []);
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
    },
  };

  test("findAdvisoryById finds the matching advisory", () => {
    assert.equal(findAdvisoryById(auditJson, "GHSA-whgm-jr23-g3j9")?.module_name, "ansi-html");
  });

  test("formatAdvisoryLine formats a markdown line with an advisory link", () => {
    assert.equal(
      formatAdvisoryLine(auditJson.advisories[1]),
      "- [GHSA-whgm-jr23-g3j9](https://github.com/advisories/GHSA-whgm-jr23-g3j9): Uncontrolled Resource Consumption in ansi-html (`ansi-html`, severity: high)",
    );
  });

  test("formatAdvisoryLine returns null for a missing advisory", () => {
    assert.equal(formatAdvisoryLine(undefined), null);
  });

  test("formatAdvisoryLines skips unresolvable IDs", () => {
    assert.deepEqual(formatAdvisoryLines(auditJson, ["GHSA-nope", "GHSA-whgm-jr23-g3j9"]), [
      "- [GHSA-whgm-jr23-g3j9](https://github.com/advisories/GHSA-whgm-jr23-g3j9): Uncontrolled Resource Consumption in ansi-html (`ansi-html`, severity: high)",
    ]);
  });
});

describe("parseImporters", () => {
  test("extracts only the dependencies block per importer, not devDependencies", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      foo:",
      "        specifier: ^1.0.0",
      "    devDependencies:",
      "      bar:",
      "        specifier: ^2.0.0",
      "  packages/sub:",
      "    dependencies:",
      "      baz:",
      "        specifier: ^3.0.0",
      "packages:",
      "  foo@1.0.0: {}",
    ].join("\n");

    const importers = parseImporters(text);
    assert.equal(Object.keys(importers).length, 2);
    assert.match(importers["."], /foo:/);
    assert.doesNotMatch(importers["."], /bar:/);
    assert.match(importers["packages/sub"], /baz:/);
  });

  test("returns an empty object when there's no importers block", () => {
    assert.deepEqual(parseImporters("lockfileVersion: '9.0'\n"), {});
  });
});

describe("loadFixedGroupNormalizer", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-normalizer-test-"));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("maps a package name to its fixed group's primary name", () => {
    mkdirSync(join(cwd, ".changeset"));
    writeFileSync(
      join(cwd, ".changeset", "config.json"),
      JSON.stringify({ fixed: [["@scope/primary", "@scope/secondary"]] }),
    );
    const normalize = loadFixedGroupNormalizer(cwd);
    assert.equal(normalize("@scope/secondary"), "@scope/primary");
    assert.equal(normalize("@scope/primary"), "@scope/primary");
  });

  test("is a no-op when there's no config.json", () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-no-config-"));
    try {
      const normalize = loadFixedGroupNormalizer(emptyCwd);
      assert.equal(normalize("some-pkg"), "some-pkg");
    } finally {
      rmSync(emptyCwd, { recursive: true, force: true });
    }
  });
});

describe("diffRuntimeDeps", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-diff-test-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root-pkg" }));
    mkdirSync(join(cwd, "private-pkg"));
    writeFileSync(join(cwd, "private-pkg", "package.json"), JSON.stringify({ name: "priv-pkg", private: true }));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const withDeps = (path, dep) =>
    ["importers:", `  ${path}:`, "    dependencies:", `      ${dep}:`, "        specifier: ^1.0.0"].join("\n");

  test("reports a non-private importer whose dependencies block changed", () => {
    const before = withDeps(".", "foo");
    const after = withDeps(".", "foo-renamed");
    assert.deepEqual(diffRuntimeDeps({ beforeText: before, afterText: after, cwd }), ["root-pkg"]);
  });

  test("ignores devDependencies-only changes (dependencies block unchanged)", () => {
    const before = withDeps(".", "foo");
    assert.deepEqual(diffRuntimeDeps({ beforeText: before, afterText: before, cwd }), []);
  });

  test("excludes private packages even when their dependencies changed", () => {
    const before = withDeps("private-pkg", "foo");
    const after = withDeps("private-pkg", "foo-renamed");
    assert.deepEqual(diffRuntimeDeps({ beforeText: before, afterText: after, cwd }), []);
  });

  test("excludes importers with no resolvable package.json", () => {
    const before = withDeps("missing-dir", "foo");
    const after = withDeps("missing-dir", "foo-renamed");
    assert.deepEqual(diffRuntimeDeps({ beforeText: before, afterText: after, cwd }), []);
  });
});

describe("buildSummary", () => {
  const before = {
    advisories: {
      1: {
        github_advisory_id: "GHSA-aaaa",
        title: "Vuln A",
        module_name: "pkg-a",
        severity: "high",
      },
      2: {
        github_advisory_id: "GHSA-bbbb",
        title: "Vuln B",
        module_name: "pkg-b",
        severity: "moderate",
      },
    },
  };

  test("lists fixed advisories and omits the remaining-count line when none remain", () => {
    const after = { advisories: {} };
    const summary = buildSummary(before, after);
    assert.match(summary, /Fixed advisories:/);
    assert.match(summary, /GHSA-aaaa/);
    assert.match(summary, /GHSA-bbbb/);
    assert.doesNotMatch(summary, /remain/);
  });

  test("reports advisories that remain unfixed", () => {
    const after = { advisories: { 1: before.advisories[1] } };
    const summary = buildSummary(before, after);
    assert.match(summary, /Fixed advisories:/);
    assert.match(summary, /GHSA-bbbb/);
    assert.match(summary, /1 advisory remains/);
  });

  test("degrades gracefully when audit data is unavailable", () => {
    const summary = buildSummary(null, null);
    assert.match(summary, /unavailable/);
  });
});

/**
 * Writes a fake `pnpm` binary that drives lockfile-audit-fix.mjs's main()
 * through a real subprocess (main() writes real files and reads/writes
 * them relative to cwd, so this is easier to verify honestly than mocking
 * child_process). Behavior is controlled entirely through env vars read by
 * the fake binary itself:
 *
 *   FAKE_PNPM_AUDIT_JSON_<n>       - stdout for the n-th `pnpm audit --json`
 *                                    call (1-indexed: 1 = before any fix,
 *                                    2 = after)
 *   FAKE_PNPM_AUDIT_JSON_DEFAULT   - fallback when a specific call isn't set
 *   FAKE_PNPM_FIX_<MODE>_LOCKFILE     - if set, overwrites pnpm-lock.yaml on
 *                                       `pnpm audit --fix <mode>`
 *   FAKE_PNPM_FIX_<MODE>_WORKSPACE    - same, for pnpm-workspace.yaml
 *                                       (creating it if absent)
 *   FAKE_PNPM_FIX_<MODE>_PACKAGE_JSON - same, for package.json
 *   FAKE_PNPM_INSTALL_FAIL_<n>     - "1" makes the n-th `pnpm install` call
 *                                    (1-indexed: 1 = after update,
 *                                    2 = after override) fail
 *   FAKE_PNPM_STATE                - directory for the call counters
 */
function writeFakePnpm(fakeBinDir) {
  const script = [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync, existsSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    "",
    "function nextCount(name) {",
    "  const counterPath = `${process.env.FAKE_PNPM_STATE}/${name}-count`;",
    "  let n = 0;",
    '  if (existsSync(counterPath)) n = parseInt(readFileSync(counterPath, "utf8"), 10);',
    "  n += 1;",
    "  writeFileSync(counterPath, String(n));",
    "  return n;",
    "}",
    "",
    'if (args[0] === "audit" && args.includes("--json")) {',
    '  const n = nextCount("audit");',
    "  const json = process.env[`FAKE_PNPM_AUDIT_JSON_${n}`] ?? process.env.FAKE_PNPM_AUDIT_JSON_DEFAULT ?? '{\"advisories\":{}}';",
    "  process.stdout.write(json);",
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "audit" && args.includes("--fix")) {',
    "  const mode = args[2].toUpperCase();",
    "  const lockfile = process.env[`FAKE_PNPM_FIX_${mode}_LOCKFILE`];",
    "  const workspace = process.env[`FAKE_PNPM_FIX_${mode}_WORKSPACE`];",
    "  const packageJson = process.env[`FAKE_PNPM_FIX_${mode}_PACKAGE_JSON`];",
    '  if (lockfile !== undefined) writeFileSync("pnpm-lock.yaml", lockfile);',
    '  if (workspace !== undefined) writeFileSync("pnpm-workspace.yaml", workspace);',
    '  if (packageJson !== undefined) writeFileSync("package.json", packageJson);',
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "install") {',
    '  const n = nextCount("install");',
    '  writeFileSync(`${process.env.FAKE_PNPM_STATE}/install-${n}-args`, JSON.stringify(args));',
    '  if (process.env[`FAKE_PNPM_INSTALL_FAIL_${n}`] === "1") {',
    '    process.stderr.write("install failed\\n");',
    "    process.exit(1);",
    "  }",
    "  process.exit(0);",
    "}",
    "",
    "process.exit(0);",
    "",
  ].join("\n");
  writeFileSync(join(fakeBinDir, "pnpm"), script);
  chmodSync(join(fakeBinDir, "pnpm"), 0o755);
}

function parseGithubOutput(text) {
  const result = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const multilineMatch = line.match(/^([A-Za-z0-9_-]+)<<(\S+)$/);
    if (multilineMatch) {
      const [, name, delim] = multilineMatch;
      const valueLines = [];
      i++;
      while (i < lines.length && lines[i] !== delim) {
        valueLines.push(lines[i]);
        i++;
      }
      result[name] = valueLines.join("\n");
      continue;
    }
    const simpleMatch = line.match(/^([A-Za-z0-9_-]+)=(.*)$/);
    if (simpleMatch) result[simpleMatch[1]] = simpleMatch[2];
  }
  return result;
}

describe("main() end-to-end via a fake pnpm binary", () => {
  let repoDir;
  let fakeBinDir;
  let outputFile;
  let stateDir;

  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-e2e-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-fake-pnpm-"));
    stateDir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-state-"));
    writeFakePnpm(fakeBinDir);
  });

  after(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const runMain = (env) => {
    outputFile = join(stateDir, `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(outputFile, "");
    execFileSync("node", [join(__dirname, "lockfile-audit-fix.mjs")], {
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        FAKE_PNPM_STATE: stateDir,
        GITHUB_OUTPUT: outputFile,
        ...env,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    return parseGithubOutput(readFileSync(outputFile, "utf8"));
  };

  test("no advisories: reports no changes and doesn't touch the lockfile", () => {
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "clean\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({ FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}' });

    assert.equal(outputs.changed, "false");
    assert.equal(outputs["runtime-deps-changed"], "false");
    assert.equal(outputs["changed-names"], "");
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), "clean\n");

    const installArgs = JSON.parse(readFileSync(join(stateDir, "install-1-args"), "utf8"));
    assert.ok(
      installArgs.includes("--config.minimum-release-age-exclude-prune=true"),
      "verifyInstallable should ask pnpm to prune stale minimumReleaseAgeExclude entries",
    );
  });

  test("update mode fixes the advisory: reports the runtime-dependency change and a fixed-advisory summary", () => {
    const before = [
      "importers:",
      "  .:",
      "    dependencies:",
      "      vulnerable-pkg:",
      "        specifier: ^1.0.0",
    ].join("\n");
    const fixed = [
      "importers:",
      "  .:",
      "    dependencies:",
      "      vulnerable-pkg:",
      "        specifier: ^1.0.1",
    ].join("\n");
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_1: JSON.stringify({
        advisories: {
          1: {
            github_advisory_id: "GHSA-xxxx-yyyy-zzzz",
            title: "Vulnerable pkg",
            module_name: "vulnerable-pkg",
            severity: "high",
          },
        },
      }),
      FAKE_PNPM_AUDIT_JSON_2: '{"advisories":{}}',
      FAKE_PNPM_FIX_UPDATE_LOCKFILE: fixed,
    });

    assert.equal(outputs.changed, "true");
    assert.equal(outputs["runtime-deps-changed"], "true");
    assert.equal(outputs["changed-names"], "my-pkg");
    assert.match(outputs.summary, /Fixed advisories:/);
    assert.match(outputs.summary, /GHSA-xxxx-yyyy-zzzz/);
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), fixed);
  });

  test("update-mode install itself fails: rolls back to the pristine original before trying override", () => {
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    const brokenUpdate = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: broken"].join(
      "\n",
    );
    const overrideFixed = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^2.0.0"].join(
      "\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_UPDATE_LOCKFILE: brokenUpdate,
      FAKE_PNPM_INSTALL_FAIL_1: "1", // the install right after update mode fails
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideFixed,
      // install #2 (after override) is left to succeed
    });

    assert.equal(outputs.changed, "true");
    assert.equal(
      readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"),
      overrideFixed,
      "override mode should still be attempted from the restored original, not skipped",
    );
  });

  test("override fallback left the result uninstallable: rolls back to the update-only result", () => {
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    const updateOnly = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.1"].join(
      "\n",
    );
    const overrideBroken = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^2.0.0"].join(
      "\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_UPDATE_LOCKFILE: updateOnly,
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideBroken,
      FAKE_PNPM_INSTALL_FAIL_2: "1", // the install right after override fails
    });

    assert.equal(outputs.changed, "true");
    assert.equal(
      readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"),
      updateOnly,
      "should roll back to the update-only snapshot, not keep the broken override result",
    );
  });

  test("override mode creates pnpm-workspace.yaml from scratch, then its install fails: rollback deletes the file entirely", () => {
    // Regression test: a naive rollback that only restores pnpm-lock.yaml
    // (or only writes pnpm-workspace.yaml when a prior snapshot had one)
    // leaves a newly-created pnpm-workspace.yaml in place, committing
    // exactly the broken override config the rollback exists to discard.
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    const overrideBroken = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^2.0.0"].join(
      "\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    assert.equal(existsSync(join(repoDir, "pnpm-workspace.yaml")), false, "precondition: no workspace file yet");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      // update mode makes no changes (e.g. an exact-pinned dependency it
      // can't bump) — install #1 (a no-op) succeeds trivially.
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideBroken,
      FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: "overrides:\n  vulnerable-pkg@<2.0.0: '>=2.0.0'\n",
      FAKE_PNPM_INSTALL_FAIL_2: "1",
    });

    assert.equal(outputs.changed, "false");
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), before);
    assert.equal(
      existsSync(join(repoDir, "pnpm-workspace.yaml")),
      false,
      "the workspace file override mode created should be removed on rollback, not left behind",
    );
  });

  test("override mode creates pnpm-workspace.yaml from scratch and its install succeeds: the file is kept", () => {
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    const overrideFixed = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^2.0.0"].join(
      "\n",
    );
    const workspaceContent = "overrides:\n  vulnerable-pkg@<2.0.0: '>=2.0.0'\n";
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideFixed,
      FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: workspaceContent,
    });

    assert.equal(outputs.changed, "true");
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), overrideFixed);
    assert.equal(readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"), workspaceContent);
  });
});
