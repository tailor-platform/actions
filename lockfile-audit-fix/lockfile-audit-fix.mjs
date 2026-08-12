#!/usr/bin/env node

/**
 * Lockfile Audit Auto-fix
 *
 * Runs `pnpm audit --fix` against pnpm-lock.yaml and verifies the result
 * before keeping it, then reports what changed. Unlike lockfile-audit.mjs
 * (a regression-only gate meant to run on every PR), this is meant for a
 * standalone scheduled/dispatched workflow that clears pre-existing
 * advisories independent of any specific change — so a fix failing here
 * never blocks an unrelated PR.
 *
 * "update" mode patches vulnerable versions directly in the lockfile but can
 * silently stop short: a package with two advisories at different
 * patched-version thresholds gets bumped to the version that clears only the
 * first one, and an exactly-pinned dependency (`"trim": "0.0.1"`, not a
 * range) can't be bumped at all this way. "override" mode reaches further,
 * but pnpm resolves the override into an installable lockfile only once
 * `pnpm install` actually runs afterward — and depending on whether the
 * repo already has a pnpm-workspace.yaml, that install can rewrite
 * pnpm-lock.yaml, pnpm-workspace.yaml (creating it if it didn't exist), and
 * package.json's `pnpm.overrides`. So: try update, verify it installs
 * cleanly and snapshot *all three* files as a known-good fallback (or the
 * pristine originals, if even that fails), then try override on top and
 * roll back to the fallback snapshot — deleting pnpm-workspace.yaml
 * entirely if the fallback didn't have one — if override leaves the result
 * uninstallable.
 *
 * This action does not commit or open a pull request — pair it with a
 * caller-provided commit/PR step (e.g. tailor-platform/actions'
 * create-signed-pr) so the changeset-insertion point stays under the
 * caller's control.
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   changed              - "true" if pnpm-lock.yaml, pnpm-workspace.yaml,
 *                           and/or package.json changed
 *   runtime-deps-changed - "true" if any non-private package's runtime
 *                           (non-dev) dependencies changed, per
 *                           pnpm-lock.yaml; devDependencies-only changes and
 *                           pnpm-workspace.yaml/package.json-overrides-only
 *                           changes don't affect consumers
 *   changed-names        - newline-separated names of packages whose
 *                           runtime dependencies changed
 *   summary              - markdown summary of fixed/remaining advisories,
 *                           for use as a PR body
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `.advisories` is an object keyed by advisory ID in both npm's classic
 * audit format and pnpm's audit output (pnpm deliberately mirrors it), but
 * tolerate an array too rather than assume the shape.
 * @param {unknown} auditJson
 */
function advisoryList(auditJson) {
  const advisories = auditJson?.advisories ?? {};
  return Array.isArray(advisories) ? advisories : Object.values(advisories);
}

/** @param {unknown} auditJson */
function extractAdvisoryIds(auditJson) {
  return new Set(
    advisoryList(auditJson)
      .map((a) => a?.github_advisory_id)
      .filter((id) => typeof id === "string" && id.length > 0),
  );
}

/**
 * @param {Set<string>} beforeIds
 * @param {Set<string>} afterIds
 * @returns {string[]} advisory IDs present in beforeIds but not afterIds, sorted
 */
function findFixedAdvisoryIds(beforeIds, afterIds) {
  return [...beforeIds].filter((id) => !afterIds.has(id)).sort();
}

/**
 * @param {unknown} auditJson
 * @param {string} id
 */
function findAdvisoryById(auditJson, id) {
  return advisoryList(auditJson).find((a) => a?.github_advisory_id === id);
}

/** @param {unknown} advisory */
function formatAdvisoryLine(advisory) {
  if (!advisory) return null;
  const { github_advisory_id: id, title, module_name: moduleName, severity } = advisory;
  return `- [${id}](https://github.com/advisories/${id}): ${title} (\`${moduleName}\`, severity: ${severity})`;
}

/**
 * @param {unknown} beforeAuditJson
 * @param {string[]} fixedIds
 */
function formatAdvisoryLines(beforeAuditJson, fixedIds) {
  return fixedIds.map((id) => formatAdvisoryLine(findAdvisoryById(beforeAuditJson, id))).filter(Boolean);
}

/**
 * Unlike lockfile-audit's gate, a failed `pnpm audit` here (registry outage,
 * etc.) shouldn't block the fix itself — it only degrades the summary to
 * "advisory list unavailable".
 * @param {string} auditLevel
 * @param {string} cwd
 * @returns {unknown} parsed `pnpm audit --json` output, or null on any failure
 */
function runAuditSafe(auditLevel, cwd) {
  try {
    const output = execFileSync("pnpm", ["audit", `--audit-level=${auditLevel}`, "--json"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    });
    return JSON.parse(output);
  } catch (e) {
    // pnpm audit exits non-zero merely because it found advisories; its JSON
    // report is still on stdout in that case.
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout.toString());
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * `pnpm audit --fix` legitimately exits non-zero when advisories remain
 * unresolved after fixing what it can — that's expected, not a failure to
 * surface. The result is verified afterwards by an explicit `pnpm install`.
 * @param {"update" | "override"} mode
 * @param {string} cwd
 */
function runFix(mode, cwd) {
  try {
    execFileSync("pnpm", ["audit", "--fix", mode, "--ignore-registry-errors"], { cwd, stdio: "ignore" });
  } catch {
    // best-effort; the caller verifies installability separately
  }
}

/**
 * Not `--frozen-lockfile`: this install's job is to resolve whatever
 * `pnpm audit --fix` just wrote (an override, a bumped specifier) into a
 * consistent pnpm-lock.yaml, which by definition doesn't match the lockfile
 * yet. `--ignore-scripts` skips dependency lifecycle scripts, which have no
 * bearing on whether the lockfile itself resolves and shouldn't run with
 * this job's ambient permissions just to verify that.
 * @param {string} cwd
 */
function verifyInstallable(cwd) {
  execFileSync("pnpm", ["install", "--ignore-scripts"], { cwd, stdio: "ignore" });
}

/**
 * Parses pnpm-lock.yaml's per-importer `dependencies` blocks (never
 * `devDependencies`), keyed by importer path, as raw indented text — good
 * enough to diff without a full YAML parser.
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseImporters(text) {
  const lines = text.split("\n");
  const importersIdx = lines.findIndex((l) => /^importers:\s*$/.test(l));
  if (importersIdx === -1) return {};

  const importers = {};
  let currentImporter = null;
  let currentSection = null;
  let sectionLines = [];

  const flush = () => {
    if (currentImporter && currentSection === "dependencies") {
      importers[currentImporter] = sectionLines.join("\n");
    }
    sectionLines = [];
  };

  for (let i = importersIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.match(/^ */)[0].length;
    if (indent === 0) break; // back to top-level key, importers block ended

    if (indent === 2) {
      flush();
      currentImporter = line
        .trim()
        .replace(/:$/, "")
        .replace(/^["']|["']$/g, "");
      currentSection = null;
      continue;
    }
    if (indent === 4) {
      flush();
      currentSection = line.trim().replace(/:$/, "");
      continue;
    }
    if (currentSection === "dependencies") sectionLines.push(line);
  }
  flush();

  return importers;
}

/**
 * @param {string} importerPath
 * @param {string} cwd
 * @returns {{name?: string, private: boolean} | null}
 */
function readPackageMeta(importerPath, cwd) {
  const pkgPath = importerPath === "." ? join(cwd, "package.json") : join(cwd, importerPath, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return { name: pkg.name, private: pkg.private === true };
  } catch {
    return null;
  }
}

/**
 * Packages in the same changeset "fixed" group always release together, so
 * a change to one is reported under the group's first (primary) package
 * name.
 * @param {string} cwd
 * @returns {(name: string) => string}
 */
function loadFixedGroupNormalizer(cwd) {
  const map = new Map();
  try {
    const config = JSON.parse(readFileSync(join(cwd, ".changeset", "config.json"), "utf8"));
    for (const group of config.fixed ?? []) {
      for (const name of group) map.set(name, group[0]);
    }
  } catch {
    // no config.json or no "fixed" groups — normalization is a no-op
  }
  return (name) => map.get(name) ?? name;
}

/**
 * @param {{beforeText: string, afterText: string, cwd: string}} args
 * @returns {string[]} sorted names of non-private packages whose runtime dependencies changed
 */
function diffRuntimeDeps({ beforeText, afterText, cwd }) {
  const beforeImporters = parseImporters(beforeText);
  const afterImporters = parseImporters(afterText);
  const paths = new Set([...Object.keys(beforeImporters), ...Object.keys(afterImporters)]);
  const normalize = loadFixedGroupNormalizer(cwd);
  const changedNames = new Set();

  for (const importerPath of paths) {
    const beforeDeps = beforeImporters[importerPath] ?? "";
    const afterDeps = afterImporters[importerPath] ?? "";
    if (beforeDeps === afterDeps) continue;

    const meta = readPackageMeta(importerPath, cwd);
    if (!meta || meta.private || !meta.name) continue;
    changedNames.add(normalize(meta.name));
  }

  return [...changedNames].sort();
}

/**
 * @param {unknown} beforeAudit
 * @param {unknown} afterAudit
 */
function buildSummary(beforeAudit, afterAudit) {
  const lines = ["Automated fix from `pnpm audit --fix`."];
  if (!beforeAudit || !afterAudit) {
    lines.push("", "(Advisory list unavailable — `pnpm audit` failed.)");
    return lines.join("\n");
  }

  const beforeIds = extractAdvisoryIds(beforeAudit);
  const afterIds = extractAdvisoryIds(afterAudit);
  const fixedIds = findFixedAdvisoryIds(beforeIds, afterIds);

  if (fixedIds.length > 0) {
    lines.push("", "Fixed advisories:");
    lines.push(...formatAdvisoryLines(beforeAudit, fixedIds));
  }
  if (afterIds.size > 0) {
    const noun = afterIds.size === 1 ? "advisory remains" : "advisories remain";
    lines.push(
      "",
      `${afterIds.size} ${noun} and could not be auto-fixed (no compatible patched version in range, or still blocked by \`minimumReleaseAge\`).`,
    );
  }
  return lines.join("\n");
}

function main() {
  const cwd = process.cwd();
  const auditLevel = process.env.AUDIT_LEVEL || "moderate";
  const lockfilePath = join(cwd, "pnpm-lock.yaml");
  const workspacePath = join(cwd, "pnpm-workspace.yaml");
  const packageJsonPath = join(cwd, "package.json");

  const outputFile = process.env.GITHUB_OUTPUT;
  const setOutput = (name, value) => {
    if (!outputFile) return;
    appendFileSync(outputFile, `${name}=${value}\n`);
  };
  const setMultilineOutput = (name, value) => {
    if (!outputFile) return;
    appendFileSync(outputFile, `${name}<<LOCKFILE_AUDIT_FIX_EOF\n${value}\nLOCKFILE_AUDIT_FIX_EOF\n`);
  };

  // pnpm writes an override it can't express as a lockfile-only version
  // bump to pnpm-workspace.yaml if one exists, or to package.json's
  // `pnpm.overrides` otherwise — and can create pnpm-workspace.yaml from
  // scratch to do it. So all three are part of the state a rollback must
  // restore, not just the lockfile.
  const snapshot = () => ({
    lockfile: readFileSync(lockfilePath, "utf8"),
    workspace: existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : null,
    packageJson: readFileSync(packageJsonPath, "utf8"),
  });
  const restore = (snap) => {
    writeFileSync(lockfilePath, snap.lockfile);
    writeFileSync(packageJsonPath, snap.packageJson);
    if (snap.workspace !== null) {
      writeFileSync(workspacePath, snap.workspace);
    } else if (existsSync(workspacePath)) {
      unlinkSync(workspacePath);
    }
  };

  const original = snapshot();
  const beforeAudit = runAuditSafe(auditLevel, cwd);

  runFix("update", cwd);
  let fallback = original;
  try {
    verifyInstallable(cwd);
    fallback = snapshot();
  } catch {
    console.log("::warning::pnpm install failed after the update-mode fix; leaving the lockfile untouched.");
    restore(original);
  }

  runFix("override", cwd);
  try {
    verifyInstallable(cwd);
  } catch {
    console.log(
      "::warning::pnpm install failed after the override fallback; reverting to the update-mode-only result.",
    );
    restore(fallback);
  }

  const after = snapshot();
  const changed =
    after.lockfile !== original.lockfile ||
    after.workspace !== original.workspace ||
    after.packageJson !== original.packageJson;
  setOutput("changed", changed);

  if (!changed) {
    console.log("No lockfile changes; nothing to fix.");
    setOutput("runtime-deps-changed", false);
    setMultilineOutput("changed-names", "");
    setMultilineOutput("summary", "");
    return;
  }

  const changedNames = diffRuntimeDeps({ beforeText: original.lockfile, afterText: after.lockfile, cwd });
  setOutput("runtime-deps-changed", changedNames.length > 0);
  setMultilineOutput("changed-names", changedNames.join("\n"));
  console.log(
    changedNames.length > 0
      ? `Runtime dependency changes detected in: ${changedNames.join(", ")}`
      : "No runtime dependency changes (devDependencies-only and/or pnpm-workspace.yaml/package.json-overrides changes).",
  );

  const afterAudit = runAuditSafe(auditLevel, cwd);
  setMultilineOutput("summary", buildSummary(beforeAudit, afterAudit));
}

// Only auto-run when executed directly (`node lockfile-audit-fix.mjs`), not
// when imported by the test file.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  extractAdvisoryIds,
  findFixedAdvisoryIds,
  findAdvisoryById,
  formatAdvisoryLine,
  formatAdvisoryLines,
  parseImporters,
  loadFixedGroupNormalizer,
  diffRuntimeDeps,
  buildSummary,
};
