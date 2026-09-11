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
 * first one, and an exactly-pinned dependency (`"minimist": "1.2.5"`, not a
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
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

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
    // ENOENT means pnpm itself isn't on PATH — a workflow misconfiguration
    // (the caller forgot to set up pnpm), not a transient audit failure.
    // Swallowing that here would report a misleadingly clean "no
    // advisories" instead of failing loudly.
    if (e.code === "ENOENT") throw new Error(`pnpm not found: ${e.message}`);
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
  } catch (e) {
    // Same ENOENT reasoning as runAuditSafe: a missing pnpm binary must
    // fail the action, not silently no-op into "changed=false".
    if (e.code === "ENOENT") throw new Error(`pnpm not found: ${e.message}`);
    // best-effort otherwise; the caller verifies installability separately
  }
}

/**
 * Parses a `pnpm.overrides` selector into its bare package name and version
 * range. `pnpm audit --fix override` only ever writes the plain
 * `<name>[@<range>]` form (never the nested `<parent>>child@<range>`
 * selector pnpm also supports for scoping an override to one dependency
 * path). The `>` that marks a nested selector always lives in the name
 * segment (before the last `@`) — unlike a `>`/`>=` range comparator, which
 * lives after it — so the name/range split happens first and only the name
 * half is checked, to avoid misreading a range like `>=3.0.0 <3.1.5` as
 * nested.
 * @param {string} selector
 */
function parseOverrideSelector(selector) {
  const atIndex = selector.startsWith("@") ? selector.indexOf("@", 1) : selector.indexOf("@");
  const name = atIndex === -1 ? selector : selector.slice(0, atIndex);
  const range = atIndex === -1 ? null : selector.slice(atIndex + 1);
  if (name.includes(">")) return { name: selector, range: null, nested: true };
  return { name, range, nested: false };
}

/**
 * Parses one of `pnpm audit --fix`'s own range shapes into a version
 * interval: `<X`, `<=X`, `>=X`, `>=X <Y`, `>=X <=Y`, or a bare `X` (exact
 * pin). Returns null for anything else (a prerelease/build-metadata tag, an
 * `||` union, ...) so the caller abstains rather than guesses.
 * @param {string | null} range
 * @returns {{lower: string|null, lowerIncl: boolean, upper: string|null, upperIncl: boolean} | null}
 */
function parseVersionInterval(range) {
  if (range == null) return { lower: null, lowerIncl: true, upper: null, upperIncl: true };
  let lower = null;
  let lowerIncl = true;
  let upper = null;
  let upperIncl = true;
  for (const token of range.trim().split(/\s+/)) {
    const m = token.match(/^(>=|>|<=|<)?(\d[\w.+-]*)$/);
    if (!m) return null;
    const [, op, version] = m;
    if (op === ">=") {
      lower = version;
      lowerIncl = true;
    } else if (op === ">") {
      lower = version;
      lowerIncl = false;
    } else if (op === "<=") {
      upper = version;
      upperIncl = true;
    } else if (op === "<") {
      upper = version;
      upperIncl = false;
    } else {
      // no operator: an exact pin is both its own lower and upper bound
      lower = version;
      lowerIncl = true;
      upper = version;
      upperIncl = true;
    }
  }
  return { lower, lowerIncl, upper, upperIncl };
}

/**
 * @param {string} version e.g. "3.1.18", "^18.2.5", "~1.2.3"
 * @returns {number[] | null} dotted numeric parts, or null when any part
 *   isn't a plain integer (a prerelease tag can't be compared numerically)
 */
function numericVersionParts(version) {
  const parts = version.replace(/^[\^~]/, "").split(".");
  return parts.every((p) => /^\d+$/.test(p)) ? parts.map(Number) : null;
}

/** @returns {number | null} -1/0/1, or null when either side can't be compared numerically */
function compareVersions(a, b) {
  const pa = numericVersionParts(a);
  const pb = numericVersionParts(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * @param {ReturnType<typeof parseVersionInterval>} inner
 * @param {ReturnType<typeof parseVersionInterval>} outer
 * @returns {boolean} true if every version matching `inner` also matches `outer`
 */
function isIntervalSubset(inner, outer) {
  if (!inner || !outer) return false;
  if (outer.lower != null) {
    if (inner.lower == null) return false;
    const cmp = compareVersions(inner.lower, outer.lower);
    if (cmp === null || cmp < 0) return false;
    if (cmp === 0 && inner.lowerIncl && !outer.lowerIncl) return false;
  }
  if (outer.upper != null) {
    if (inner.upper == null) return false;
    const cmp = compareVersions(inner.upper, outer.upper);
    if (cmp === null || cmp > 0) return false;
    if (cmp === 0 && inner.upperIncl && !outer.upperIncl) return false;
  }
  return true;
}

/**
 * Collapses redundant `pnpm.overrides` entries that `pnpm audit --fix
 * override` accumulates across repeated runs: as GHSA advisory data for a
 * package gets revised (a wider vulnerable range published, a newer patched
 * version released), each run appends a brand-new `name@range: version`
 * selector rather than replacing the one it already wrote for that package,
 * so the override list only ever grows.
 *
 * An entry is dropped only when another surviving entry for the same bare
 * package name *dominates* it: that entry's range is a superset of the
 * dropped one's, and it pins to a version that's the same or newer — so
 * every package version the dropped entry would have matched is still
 * covered, at least as well, by the entry that remains. When two entries
 * have an equal range and version, the one earlier in the original list
 * wins (an arbitrary but stable tie-break — this never removes both). Any
 * nested selector, or any range/version this can't parse as a plain
 * numeric interval, is left untouched rather than guessed at.
 * @param {[string, string][]} entries in original file order
 * @returns {{survivors: [string, string][], removedKeys: string[]}}
 */
function dedupeOverrideEntries(entries) {
  const parsed = entries.map(([key, version], index) => ({
    key,
    version,
    index,
    ...parseOverrideSelector(key),
  }));

  const removed = new Set();
  for (const a of parsed) {
    if (a.nested) continue;
    const intervalA = parseVersionInterval(a.range);
    if (!intervalA) continue;

    const dominatedBy = parsed.find((b) => {
      if (b.key === a.key || b.nested || b.name !== a.name) return false;
      const intervalB = parseVersionInterval(b.range);
      if (!intervalB) return false;
      if (!isIntervalSubset(intervalA, intervalB)) return false;
      const versionCmp = compareVersions(a.version, b.version);
      if (versionCmp === null || versionCmp > 0) return false;
      // equal range and version: keep whichever entry is earlier in the file
      if (versionCmp === 0 && isIntervalSubset(intervalB, intervalA) && b.index > a.index) return false;
      return true;
    });
    if (dominatedBy) removed.add(a.key);
  }

  return {
    survivors: entries.filter(([key]) => !removed.has(key)),
    removedKeys: entries.map(([key]) => key).filter((key) => removed.has(key)),
  };
}

/**
 * Parses one line of pnpm-workspace.yaml's `overrides:` block into its raw
 * key and value. pnpm quotes a key when it starts with `@` (a plain YAML
 * scalar can't start with that character) but never quotes one that merely
 * contains range operators like `<`/`>=` mid-string, so both forms show up
 * across real entries; this unquotes either. Returns null for anything
 * that isn't a `key: value` line (a comment, a blank line, ...), which the
 * caller then leaves untouched.
 * @param {string} line
 * @returns {{key: string, value: string} | null}
 */
function parseOverrideLine(line) {
  if (/^\s*#/.test(line)) return null;
  const m = line.match(/^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^:\s][^:]*?):\s*(.+?)\s*$/);
  if (!m) return null;
  let key = m[1];
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  return { key, value: m[2] };
}

/**
 * Finds the line range of pnpm-workspace.yaml's top-level `overrides:`
 * block: the line index of `overrides:` itself, and the exclusive end
 * index where a line returns to column 0 (the next top-level key). Blank
 * lines inside the block don't end it.
 * @param {string[]} lines
 * @returns {{headerIdx: number, endIdx: number} | null}
 */
function findOverridesBlock(lines) {
  const headerIdx = lines.findIndex((l) => /^overrides:\s*$/.test(l));
  if (headerIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (!/^\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { headerIdx, endIdx };
}

/**
 * Edits pnpm-workspace.yaml's `overrides:` block by deleting whole lines,
 * not by parsing/re-serializing the file with a YAML library: this action
 * runs via `node "${{ github.action_path }}/lockfile-audit-fix.mjs"` with
 * no install step for its own dependencies, in both the composite action
 * itself and this repo's own unit-tests job, so it can only rely on
 * Node's built-in modules (matching parseImporters above, which parses
 * pnpm-lock.yaml's importers block as raw indented text for the same
 * reason). Deleting matched lines outright also guarantees every
 * untouched line survives byte-for-byte, comments included.
 * @param {string} workspacePath
 * @returns {boolean} true if the file was rewritten
 */
function dedupeWorkspaceOverrides(workspacePath) {
  if (!existsSync(workspacePath)) return false;
  const lines = readFileSync(workspacePath, "utf8").split("\n");
  const block = findOverridesBlock(lines);
  if (!block) return false;

  const parsedLines = [];
  for (let i = block.headerIdx + 1; i < block.endIdx; i++) {
    const parsed = parseOverrideLine(lines[i]);
    if (parsed) parsedLines.push({ ...parsed, lineIndex: i });
  }
  if (parsedLines.length === 0) return false;

  const entries = parsedLines.map(({ key, value }) => [key, value]);
  const { removedKeys } = dedupeOverrideEntries(entries);
  if (removedKeys.length === 0) return false;

  const removedKeySet = new Set(removedKeys);
  const removedIndexes = new Set(
    parsedLines.filter(({ key }) => removedKeySet.has(key)).map(({ lineIndex }) => lineIndex),
  );
  writeFileSync(workspacePath, lines.filter((_, i) => !removedIndexes.has(i)).join("\n"));
  return true;
}

/**
 * @param {string} packageJsonPath
 * @returns {boolean} true if the file was rewritten
 */
function dedupePackageJsonOverrides(packageJsonPath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const overrides = pkg.pnpm?.overrides;
  if (!overrides || typeof overrides !== "object") return false;

  const entries = Object.entries(overrides);
  const { survivors, removedKeys } = dedupeOverrideEntries(entries);
  if (removedKeys.length === 0) return false;

  pkg.pnpm.overrides = Object.fromEntries(survivors);
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * pnpm's dep-path syntax (`parent>child`) and range operators (`>=3.0.0`)
 * share the `>` character, so only the leading name segment is read here.
 * For a nested `parent>child` selector this resolves to `parent` — which is
 * the right target anyway: an override keyed on a parent that has left the
 * tree is dead too.
 */
const OVERRIDE_TARGET = /^(?:@[^/@\s>]+\/)?[^@\s>]+/;

/**
 * A `# keep-override: <reason>` comment immediately above a
 * pnpm-workspace.yaml override entry opts it out of orphan-pruning — for a
 * pin intentionally placed ahead of the package actually landing in the
 * dependency tree.
 */
const KEEP_OVERRIDE_COMMENT = /^#\s*keep-override\s*:/i;

/**
 * @param {string} key a `pnpm.overrides`/`pnpm-workspace.yaml overrides:` key
 * @returns {string | null} the bare target package name, or null if unparsable
 */
function overrideTargetName(key) {
  const match = key.match(OVERRIDE_TARGET);
  return match ? match[0] : null;
}

/** @param {string[]} removedKeys */
function logPrunedOverrideKeys(removedKeys) {
  for (const key of removedKeys) {
    console.log(`Dropping orphaned override entry "${key}" (not in the dependency tree).`);
  }
}

/**
 * True if `name` appears anywhere in `haystack` (a pnpm-lock.yaml with its
 * own `overrides:` block excluded — see readLockfileOutsideOverrides) either
 * as a resolved package key/peer-dependency suffix (`name@version`) or a
 * bare importer/workspace-link key (`name:` or `'@scope/name':` — the only
 * form a workspace link ever takes, since it gets no `packages:` entry to
 * carry a version). Any mention counts as present, so this only ever errs
 * toward keeping an override rather than dropping a live one. The leading
 * boundary check is what keeps a `uri` override from matching
 * `fast-uri@3.1.4`.
 * @param {string} haystack
 * @param {string} name
 */
function isMentioned(haystack, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zA-Z0-9@._/-])${escaped}(@|["']?\\s*:)`, "m").test(haystack);
}

/**
 * Reads pnpm-lock.yaml with its own top-level `overrides:` block (a mirror
 * of pnpm-workspace.yaml's `overrides:`) excluded first — scanning the file
 * whole would make every override look "mentioned" off the back of its own
 * entry. Returns null when the file is missing or doesn't look like a real
 * lockfile (no top-level `packages:` key), so callers abstain from pruning
 * rather than act on a bad read.
 * @param {string} lockfilePath
 * @returns {string | null}
 */
function readLockfileOutsideOverrides(lockfilePath) {
  if (!existsSync(lockfilePath)) return null;
  const lines = readFileSync(lockfilePath, "utf8").split("\n");
  if (!lines.some((l) => /^packages:\s*$/.test(l))) return null;
  const block = findOverridesBlock(lines);
  if (!block) return lines.join("\n");
  return [...lines.slice(0, block.headerIdx), ...lines.slice(block.endIdx)].join("\n");
}

/**
 * Drops `pnpm.overrides`/`pnpm-workspace.yaml overrides:` entries whose
 * target package is no longer mentioned anywhere in the dependency tree
 * (`lockfileText`, see readLockfileOutsideOverrides) — an override like that
 * protects nothing, since pnpm never resolves it into anything, yet nothing
 * else ever removes it, so the list only grows over time otherwise. Any
 * entry whose target name can't be parsed is left untouched rather than
 * guessed at.
 * @param {[string, string][]} entries
 * @param {string} lockfileText
 * @returns {{survivors: [string, string][], removedKeys: string[]}}
 */
function pruneOrphanedOverrideEntries(entries, lockfileText) {
  const survivors = [];
  const removedKeys = [];
  for (const [key, value] of entries) {
    const name = overrideTargetName(key);
    if (name && !isMentioned(lockfileText, name)) {
      removedKeys.push(key);
      continue;
    }
    survivors.push([key, value]);
  }
  return { survivors, removedKeys };
}

/**
 * Prunes pnpm-workspace.yaml's `overrides:` block of entries whose target
 * package is no longer mentioned anywhere in pnpm-lock.yaml's dependency
 * tree — same line-deletion approach as dedupeWorkspaceOverrides, for the
 * same reason (no YAML library available). Unlike dedupeWorkspaceOverrides,
 * a dropped entry also takes any plain comment immediately above it with it
 * (that comment only ever explained the now-dead entry), except a
 * `# keep-override: <reason>` comment, which opts the entry out of pruning
 * entirely instead.
 * @param {string} workspacePath
 * @param {string} lockfilePath
 * @returns {boolean} true if the file was rewritten
 */
function pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath) {
  if (!existsSync(workspacePath)) return false;
  const lines = readFileSync(workspacePath, "utf8").split("\n");
  const block = findOverridesBlock(lines);
  if (!block) return false;

  const lockfileText = readLockfileOutsideOverrides(lockfilePath);
  if (lockfileText === null) return false;

  const { headerIdx, endIdx } = block;
  const body = lines.slice(headerIdx + 1, endIdx);

  const kept = [];
  const removedKeys = [];
  let comments = [];
  for (const raw of body) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      kept.push(...comments, raw);
      comments = [];
      continue;
    }
    if (trimmed.startsWith("#")) {
      comments.push(raw);
      continue;
    }
    const parsed = parseOverrideLine(raw);
    if (!parsed) {
      kept.push(...comments, raw);
      comments = [];
      continue;
    }
    const name = overrideTargetName(parsed.key);
    const optedOut = comments.some((c) => KEEP_OVERRIDE_COMMENT.test(c.trim()));
    if (name && !optedOut && !isMentioned(lockfileText, name)) {
      removedKeys.push(parsed.key);
      comments = [];
      continue;
    }
    kept.push(...comments, raw);
    comments = [];
  }
  kept.push(...comments);

  if (removedKeys.length === 0) return false;
  logPrunedOverrideKeys(removedKeys);

  // A childless `overrides:` parses as null rather than an empty map. pnpm
  // tolerates that, but the whole key is dropped along with its last entry
  // instead of relying on it.
  const hasEntries = kept.some((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  const newLines = hasEntries
    ? [...lines.slice(0, headerIdx + 1), ...kept, ...lines.slice(endIdx)]
    : [...lines.slice(0, headerIdx), ...lines.slice(endIdx)];
  writeFileSync(workspacePath, newLines.join("\n"));
  return true;
}

/**
 * @param {string} packageJsonPath
 * @param {string} lockfilePath
 * @returns {boolean} true if the file was rewritten
 */
function pruneOrphanedPackageJsonOverrides(packageJsonPath, lockfilePath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const overrides = pkg.pnpm?.overrides;
  if (!overrides || typeof overrides !== "object") return false;

  const lockfileText = readLockfileOutsideOverrides(lockfilePath);
  if (lockfileText === null) return false;

  const entries = Object.entries(overrides);
  const { survivors, removedKeys } = pruneOrphanedOverrideEntries(entries, lockfileText);
  if (removedKeys.length === 0) return false;
  logPrunedOverrideKeys(removedKeys);

  pkg.pnpm.overrides = Object.fromEntries(survivors);
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return true;
}

/**
 * Explicit `--no-frozen-lockfile`, not just the absence of
 * `--frozen-lockfile`: pnpm auto-enables frozen mode whenever it sees
 * `CI=true` in the environment (true on every GitHub Actions runner by
 * default), and frozen mode's whole job is to REFUSE to touch the lockfile
 * when it doesn't already match package.json/pnpm-workspace.yaml — which is
 * guaranteed right after `pnpm audit --fix` just added an override neither
 * has resolved into the lockfile yet
 * (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH: Cannot proceed with the frozen
 * installation`). This install's actual job is the opposite: resolve that
 * fix into a consistent pnpm-lock.yaml. `--ignore-scripts` skips dependency
 * lifecycle scripts, which have no bearing on whether the lockfile itself
 * resolves and shouldn't run with this job's ambient permissions just to
 * verify that.
 *
 * Throws with pnpm's own output attached (truncated) so a caller's rollback
 * warning is actually diagnosable instead of just "it failed" — pnpm prints
 * some errors to stdout rather than stderr, so both are captured.
 *
 * `--config.minimum-release-age-exclude-prune=true` causes pnpm to also
 * drop any `minimumReleaseAgeExclude` entry in pnpm-workspace.yaml that it
 * no longer needs, per the freshly-resolved lockfile (pnpm >=11.22.0; a
 * no-op on older pnpm, not an error) — but only on a real re-resolution.
 * `install` skips re-resolving (and so skips pruning) whenever the
 * lockfile is already "up to date" for package.json/pnpm-workspace.yaml —
 * the exact state a scheduled run with no new advisory to fix leaves it
 * in. The follow-up `dedupe` always re-resolves, so it's what actually
 * prunes a stale exclude entry in that case. Skipped unless
 * pnpm-workspace.yaml actually mentions `minimumReleaseAgeExclude` (a
 * plain substring check, not full parsing — this action otherwise never
 * reads that file): with nothing there to prune, the extra resolver pass
 * would only add cost and risk an unrelated duplicate-version cleanup
 * `dedupe` might also make along the way.
 * @param {string} cwd
 */
function verifyInstallable(cwd) {
  const pruneFlag = "--config.minimum-release-age-exclude-prune=true";
  const opts = { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 64 };
  const workspacePath = join(cwd, "pnpm-workspace.yaml");
  const hasExcludesToPrune =
    existsSync(workspacePath) && readFileSync(workspacePath, "utf8").includes("minimumReleaseAgeExclude");
  let step = "install";
  try {
    execFileSync("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts", pruneFlag], opts);
    if (hasExcludesToPrune) {
      step = "dedupe";
      execFileSync("pnpm", ["dedupe", "--ignore-scripts", pruneFlag], opts);
    }
  } catch (e) {
    const output = [e.stdout, e.stderr]
      .map((s) => s?.toString().trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);
    throw new Error(output ? `pnpm ${step} failed: ${output}` : `pnpm ${step} failed: ${e.message}`);
  }
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
    // A fixed delimiter could theoretically collide with the value itself
    // (advisory titles/URLs come from GitHub's advisory database, outside
    // this action's control) and corrupt $GITHUB_OUTPUT parsing — a random
    // delimiter per call closes that off entirely.
    const delimiter = `LOCKFILE_AUDIT_FIX_EOF_${randomBytes(16).toString("hex")}`;
    appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
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
  } catch (e) {
    console.log(
      `::warning::pnpm verification failed after the update-mode fix; reverting pnpm-lock.yaml, pnpm-workspace.yaml, and package.json to their original state. ${e.message}`,
    );
    restore(original);
  }

  runFix("override", cwd);
  dedupeWorkspaceOverrides(workspacePath);
  dedupePackageJsonOverrides(packageJsonPath);
  pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
  pruneOrphanedPackageJsonOverrides(packageJsonPath, lockfilePath);
  try {
    verifyInstallable(cwd);
  } catch (e) {
    // fallback is still `original` here when the update-mode install above
    // also failed — say so, rather than always claiming an update-mode
    // result that may never have existed.
    const revertTarget = fallback === original ? "their original state" : "the update-mode-only result";
    console.log(
      `::warning::pnpm verification failed after the override fallback; reverting pnpm-lock.yaml, pnpm-workspace.yaml, and package.json to ${revertTarget}. ${e.message}`,
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
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
  parseOverrideSelector,
  parseVersionInterval,
  compareVersions,
  isIntervalSubset,
  dedupeOverrideEntries,
  parseOverrideLine,
  findOverridesBlock,
  dedupeWorkspaceOverrides,
  dedupePackageJsonOverrides,
  overrideTargetName,
  isMentioned,
  readLockfileOutsideOverrides,
  pruneOrphanedOverrideEntries,
  pruneOrphanedWorkspaceOverrides,
  pruneOrphanedPackageJsonOverrides,
};
