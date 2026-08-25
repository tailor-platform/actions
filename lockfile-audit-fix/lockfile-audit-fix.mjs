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
 * Also sweeps pnpm-workspace.yaml's `minimumReleaseAgeExclude` and
 * `overrides` lists of entries that have outlived their purpose, and
 * collapses any duplicate entry `pnpm audit --fix` left for the same
 * package (a package with two advisories at different patched-version
 * thresholds can get an overlapping range in either list, which makes the
 * following `pnpm install` hard-fail with
 * ERR_PNPM_NO_MATURE_MATCHING_VERSION). Nothing else — Renovate included —
 * ever removes an entry from either list once `pnpm audit --fix` adds it
 * (pnpm doesn't reconcile an earlier bypass when a later fix moves the
 * resolved version again, either), so both only grow over time unless
 * swept here. Ported from tailor-platform/sdk's
 * .github/scripts/lockfile-audit-fix-normalize.mjs.
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
 * @param {string} cwd
 */
function verifyInstallable(cwd) {
  try {
    execFileSync("pnpm", ["install", "--no-frozen-lockfile", "--ignore-scripts"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (e) {
    const output = [e.stdout, e.stderr]
      .map((s) => s?.toString().trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 2000);
    throw new Error(output ? `pnpm install failed: ${output}` : `pnpm install failed: ${e.message}`);
  }
}

/**
 * `pnpm audit --fix` can add more than one overlapping
 * `minimumReleaseAgeExclude`/`overrides` entry for the same package (e.g. a
 * package with two advisories at different patched-version thresholds),
 * and an "override" fix can leave the two out of sync with what the
 * lockfile actually resolved to — pnpm never goes back to reconcile an
 * earlier bypass once a later fix moves the resolved version again.
 * Overlapping ranges make the following `pnpm install` hard-fail with
 * ERR_PNPM_NO_MATURE_MATCHING_VERSION instead of resolving to the
 * fully-patched version.
 *
 * Nothing else — Renovate included — ever removes either kind of entry, so
 * both lists only grow over time unless swept here:
 *   - minimumReleaseAgeExclude: once a pinned version is older than
 *     minimumReleaseAge on its own, the bypass is a no-op.
 *   - overrides: once nothing in the dependency tree resolves to the
 *     overridden package, the pin protects nothing.
 *
 * Ported from tailor-platform/sdk's
 * .github/scripts/lockfile-audit-fix-normalize.mjs, adapted to run inline
 * (rather than as a separate workflow step) and to report what it dropped
 * as data instead of parsed-from-log-lines text.
 */

/** @param {string} entry */
function splitNameSpec(entry) {
  const at = entry.startsWith("@") ? entry.indexOf("@", 1) : entry.indexOf("@");
  if (at === -1) return [entry, null];
  return [entry.slice(0, at), entry.slice(at + 1)];
}

/** @param {unknown} v */
function parseVer(v) {
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * @param {string} a
 * @param {string} b
 */
function verGt(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

/** @param {string} entry */
function quoteIfNeeded(entry) {
  return entry.startsWith("@") ? `"${entry}"` : entry;
}

/**
 * @param {string[]} lines
 * @param {string} key
 */
function findYamlBlock(lines, key) {
  const startIdx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx };
}

/**
 * Collapses `minimumReleaseAgeExclude` entries that pin more than one
 * version of the same package down to the single highest-version one.
 * Existing comments are preserved as-is (a dropped entry's comment is
 * dropped with it); name-pattern entries (no `@version`, e.g.
 * `"@tailor-platform/*"`) pass through untouched.
 * @param {string[]} lines
 * @returns {{lines: string[], dropped: string[]}}
 */
function collapseExcludeDuplicates(lines) {
  const block = findYamlBlock(lines, "minimumReleaseAgeExclude");
  if (!block) return { lines, dropped: [] };
  const { startIdx, endIdx } = block;
  const body = lines.slice(startIdx + 1, endIdx);

  const items = [];
  let pendingComment = null;
  for (const raw of body) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      pendingComment = null;
      continue;
    }
    if (trimmed.startsWith("#")) {
      pendingComment = raw;
      continue;
    }
    const m = trimmed.match(/^-\s*"?([^"]+?)"?\s*$/);
    if (!m) {
      pendingComment = null;
      continue;
    }
    items.push({ comment: pendingComment, entry: m[1].trim() });
    pendingComment = null;
  }

  const byPkg = new Map();
  const order = [];
  for (const item of items) {
    const [pkg, version] = splitNameSpec(item.entry);
    if (version && parseVer(version)) {
      const existing = byPkg.get(pkg);
      if (!existing || verGt(version, existing.version)) byPkg.set(pkg, { ...item, version });
      if (!order.some((o) => o.type === "pkg" && o.pkg === pkg)) order.push({ type: "pkg", pkg });
    } else {
      order.push({ type: "raw", item });
    }
  }

  const dropped = [];
  const newBody = [];
  for (const o of order) {
    if (o.type === "raw") {
      if (o.item.comment) newBody.push(o.item.comment);
      newBody.push(`  - ${quoteIfNeeded(o.item.entry)}`);
      continue;
    }
    const winner = byPkg.get(o.pkg);
    for (const item of items) {
      const [pkg] = splitNameSpec(item.entry);
      if (pkg === o.pkg && item.entry !== winner.entry) dropped.push(item.entry);
    }
    if (winner.comment) newBody.push(winner.comment);
    newBody.push(`  - ${quoteIfNeeded(winner.entry)}`);
  }

  if (body.length > 0 && body.at(-1).trim() === "") newBody.push("");
  return { lines: [...lines.slice(0, startIdx + 1), ...newBody, ...lines.slice(endIdx)], dropped };
}

/**
 * Same collapse as {@link collapseExcludeDuplicates}, for the `overrides`
 * block.
 * @param {string[]} lines
 * @returns {{lines: string[], dropped: string[]}}
 */
function collapseOverrideDuplicates(lines) {
  const block = findYamlBlock(lines, "overrides");
  if (!block) return { lines, dropped: [] };
  const { startIdx, endIdx } = block;
  const body = lines.slice(startIdx + 1, endIdx);

  const items = body.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return { raw, passthrough: true };
    const idx = trimmed.indexOf(":");
    if (idx === -1) return { raw, passthrough: true };
    return { raw, key: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() };
  });

  const byPkg = new Map();
  const order = [];
  for (const item of items) {
    if (item.passthrough) {
      order.push({ type: "raw", item });
      continue;
    }
    const [pkg] = splitNameSpec(item.key);
    const versionMatch = item.value.match(/(\d+\.\d+\.\d+)/);
    const version = versionMatch ? versionMatch[1] : null;
    if (version) {
      const existing = byPkg.get(pkg);
      if (!existing || verGt(version, existing.version)) byPkg.set(pkg, { ...item, version });
      if (!order.some((o) => o.type === "pkg" && o.pkg === pkg)) order.push({ type: "pkg", pkg });
    } else {
      order.push({ type: "raw", item });
    }
  }

  const dropped = [];
  const newBody = order.map((o) => {
    if (o.type === "raw") return o.item.raw;
    const winner = byPkg.get(o.pkg);
    for (const item of items) {
      if (item.passthrough) continue;
      const [pkg] = splitNameSpec(item.key);
      if (pkg === o.pkg && item.key !== winner.key) dropped.push(item.key);
    }
    return winner.raw;
  });

  return { lines: [...lines.slice(0, startIdx + 1), ...newBody, ...lines.slice(endIdx)], dropped };
}

// pnpm's dep-path syntax (`parent>child`) and range operators (`>=3.0.0`)
// share the `>` character, so read only the leading package name. For
// `parent>child` that resolves to the parent, which is the right target
// anyway: an override keyed on a parent that has left the tree is dead too.
const OVERRIDE_TARGET = /^(?:@[^/@\s>]+\/)?[^@\s>]+/;

/** @param {string} key */
function overrideTargetName(key) {
  const match = key.match(OVERRIDE_TARGET);
  return match ? match[0] : null;
}

const KEEP_OVERRIDE_COMMENT = /^#\s*keep-override\s*:/i;

/**
 * Any mention counts as present, so this only ever errs toward keeping an
 * override. Two forms have to be accepted: `name@version` (resolved package
 * keys and peer-dependency suffixes) and a bare `name:` / `'@scope/name':`
 * key, which is the only form a workspace link ever takes — it gets no
 * `packages:` entry to carry a version. The leading boundary is what stops a
 * `uri` override from matching `fast-uri@3.1.4`.
 * @param {string} haystack
 * @param {string} name
 */
function isMentioned(haystack, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-zA-Z0-9@._/-])${escaped}(@|["']?\\s*:)`, "m").test(haystack);
}

/**
 * The lockfile mirrors pnpm-workspace.yaml's `overrides` in a top-level
 * `overrides:` block of its own, so scanning the file whole would report
 * every override as live off the back of its own entry. That block has to
 * come out before anything else is read. Returns null if `text` doesn't
 * look like a pnpm lockfile (no `packages:` block) — callers treat that as
 * "can't verify, keep everything".
 * @param {string} text
 */
function readLockfileOutsideOverrides(text) {
  const lines = text.split("\n");
  if (!findYamlBlock(lines, "packages")) return null;
  const overrides = findYamlBlock(lines, "overrides");
  if (!overrides) return text;
  return [...lines.slice(0, overrides.startIdx), ...lines.slice(overrides.endIdx)].join("\n");
}

/**
 * Drops `overrides` entries whose target package no longer appears anywhere
 * in the dependency tree — the pin protects nothing once that's true, but
 * Renovate still treats the right-hand side as a live dependency and keeps
 * filing no-op bump PRs against it. An entry with a `# keep-override:
 * <reason>` comment directly above it is kept regardless (for a pin that
 * intentionally targets a package the tree doesn't contain yet).
 * @param {string[]} lines
 * @param {string | null} lockfileText
 * @returns {{lines: string[], dropped: string[]}}
 */
function pruneOrphanedOverrides(lines, lockfileText) {
  const block = findYamlBlock(lines, "overrides");
  if (!block) return { lines, dropped: [] };

  const lockfile = lockfileText === null ? null : readLockfileOutsideOverrides(lockfileText);
  if (lockfile === null) return { lines, dropped: [] };

  const { startIdx, endIdx } = block;
  const body = lines.slice(startIdx + 1, endIdx);

  const kept = [];
  const dropped = [];
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

    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      kept.push(...comments, raw);
      comments = [];
      continue;
    }

    const key = trimmed
      .slice(0, colon)
      .trim()
      .replace(/^["']|["']$/g, "");
    const name = overrideTargetName(key);
    const optedOut = comments.some((c) => KEEP_OVERRIDE_COMMENT.test(c.trim()));

    if (name && !optedOut && !isMentioned(lockfile, name)) {
      dropped.push(key);
      comments = [];
      continue;
    }

    kept.push(...comments, raw);
    comments = [];
  }
  kept.push(...comments);

  // A childless `overrides:` parses as null rather than an empty map. pnpm
  // tolerates that, but nothing should have to rely on it, so the key
  // leaves with its last entry.
  if (!kept.some((l) => l.trim() !== "" && !l.trim().startsWith("#"))) {
    return { lines: [...lines.slice(0, startIdx), ...lines.slice(endIdx)], dropped };
  }
  return { lines: [...lines.slice(0, startIdx + 1), ...kept, ...lines.slice(endIdx)], dropped };
}

/** @param {string[]} lines */
function getMinimumReleaseAgeMinutes(lines) {
  const line = lines.find((l) => /^minimumReleaseAge\s*:/.test(l));
  const m = line && line.match(/^minimumReleaseAge\s*:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Fetches a package's publish-time map (`{version: ISO date}`) once, so
 * that checking a `minimumReleaseAgeExclude` entry that lists several
 * versions for the same package — pnpm writes those as a single entry with
 * `||`-separated versions, e.g. `hono@4.12.27 || 4.12.34` — costs one
 * request rather than one per version.
 * @param {string} pkg
 * @returns {Promise<Record<string, string> | null>}
 */
async function fetchPublishTimes(pkg) {
  const parts = pkg.split("/");
  const encoded = pkg.startsWith("@") ? `@${parts[0].slice(1)}%2F${parts[1]}` : pkg;
  const res = await fetch(`https://registry.npmjs.org/${encoded}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.time ?? null;
}

/**
 * Drops a `minimumReleaseAgeExclude` entry once every version it lists is,
 * on its own, already older than `minimumReleaseAge` — the bypass has
 * become a no-op, but nothing removes it on its own. An entry can list more
 * than one version for the same package as a `||`-separated disjunction
 * (`hono@4.12.27 || 4.12.34`); it's only dropped once *all* of them clear
 * the age bar, since any one of them could still be the version actually
 * being bypassed for. Unknown publish time (registry error, private
 * package, unparseable version) keeps the whole entry conservatively rather
 * than risk dropping a still-needed bypass.
 * @param {string[]} lines
 * @param {number | null} minimumReleaseAgeMinutes
 * @returns {Promise<{lines: string[], dropped: string[]}>}
 */
async function pruneStaleExcludes(lines, minimumReleaseAgeMinutes) {
  if (minimumReleaseAgeMinutes == null) return { lines, dropped: [] };
  const block = findYamlBlock(lines, "minimumReleaseAgeExclude");
  if (!block) return { lines, dropped: [] };
  const { startIdx, endIdx } = block;
  const body = lines.slice(startIdx + 1, endIdx);

  const items = [];
  let pendingComment = null;
  for (const raw of body) {
    const trimmed = raw.trim();
    if (trimmed === "") {
      pendingComment = null;
      continue;
    }
    if (trimmed.startsWith("#")) {
      pendingComment = raw;
      continue;
    }
    const m = trimmed.match(/^-\s*"?([^"]+?)"?\s*$/);
    if (!m) {
      pendingComment = null;
      continue;
    }
    items.push({ comment: pendingComment, entry: m[1].trim() });
    pendingComment = null;
  }

  const publishTimesByPkg = new Map();
  const kept = [];
  const dropped = [];
  for (const item of items) {
    const [pkg, versionSpec] = splitNameSpec(item.entry);
    const versions = versionSpec ? versionSpec.split("||").map((v) => v.trim()) : [];
    if (versions.length === 0 || !versions.every((v) => parseVer(v))) {
      kept.push(item); // no version, or something that doesn't parse — keep as-is
      continue;
    }

    if (!publishTimesByPkg.has(pkg)) {
      let times = null;
      try {
        times = await fetchPublishTimes(pkg);
      } catch {
        times = null;
      }
      publishTimesByPkg.set(pkg, times);
    }
    const times = publishTimesByPkg.get(pkg);

    const allStale =
      times != null &&
      versions.every((v) => {
        const t = times[v];
        if (!t) return false; // unknown publish time for this version — not provably stale
        return (Date.now() - new Date(t).getTime()) / 60_000 >= minimumReleaseAgeMinutes;
      });

    if (allStale) {
      dropped.push(item.entry);
      continue;
    }
    kept.push(item);
  }

  const newBody = [];
  for (const item of kept) {
    if (item.comment) newBody.push(item.comment);
    newBody.push(`  - ${quoteIfNeeded(item.entry)}`);
  }
  if (body.length > 0 && body.at(-1).trim() === "") newBody.push("");
  return { lines: [...lines.slice(0, startIdx + 1), ...newBody, ...lines.slice(endIdx)], dropped };
}

/**
 * Sweeps `pnpm-workspace.yaml` of `minimumReleaseAgeExclude`/`overrides`
 * entries that have outlived their purpose, and collapses any duplicate
 * entry `pnpm audit --fix` left for the same package. A no-op when the
 * caller has no `pnpm-workspace.yaml` at all — this action isn't specific
 * to a repo that uses one.
 * @param {string} cwd
 * @returns {Promise<{changed: boolean, droppedExcludes: string[], droppedOverrides: string[]}>}
 */
async function normalizeWorkspace(cwd) {
  const workspacePath = join(cwd, "pnpm-workspace.yaml");
  if (!existsSync(workspacePath)) return { changed: false, droppedExcludes: [], droppedOverrides: [] };

  const original = readFileSync(workspacePath, "utf8");
  let lines = original.split("\n");

  const excludeCollapse = collapseExcludeDuplicates(lines);
  lines = excludeCollapse.lines;

  const overrideCollapse = collapseOverrideDuplicates(lines);
  lines = overrideCollapse.lines;

  const lockfilePath = join(cwd, "pnpm-lock.yaml");
  const lockfileText = existsSync(lockfilePath) ? readFileSync(lockfilePath, "utf8") : null;
  const orphanPrune = pruneOrphanedOverrides(lines, lockfileText);
  lines = orphanPrune.lines;

  const minimumReleaseAgeMinutes = getMinimumReleaseAgeMinutes(lines);
  const stalePrune = await pruneStaleExcludes(lines, minimumReleaseAgeMinutes);
  lines = stalePrune.lines;

  const result = lines.join("\n");
  const changed = result !== original;
  if (changed) writeFileSync(workspacePath, result);

  const droppedExcludes = [...excludeCollapse.dropped, ...stalePrune.dropped];
  const droppedOverrides = [...overrideCollapse.dropped, ...orphanPrune.dropped];
  for (const entry of droppedExcludes) console.log(`Dropped minimumReleaseAgeExclude entry: ${entry}`);
  for (const entry of droppedOverrides) console.log(`Dropped overrides entry: ${entry}`);

  return { changed, droppedExcludes, droppedOverrides };
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
 * @param {{droppedExcludes?: string[], droppedOverrides?: string[]}} [pruneResult]
 */
function buildSummary(beforeAudit, afterAudit, pruneResult = {}) {
  const lines = ["Automated fix from `pnpm audit --fix`."];
  if (!beforeAudit || !afterAudit) {
    lines.push("", "(Advisory list unavailable — `pnpm audit` failed.)");
  } else {
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
  }

  const droppedExcludes = pruneResult.droppedExcludes ?? [];
  const droppedOverrides = pruneResult.droppedOverrides ?? [];
  if (droppedExcludes.length > 0) {
    lines.push(
      "",
      "Removed `minimumReleaseAgeExclude` entries that are no longer needed (superseded by a higher-version entry for the same package, or the pinned version is now old enough on its own):",
    );
    lines.push(...droppedExcludes.map((e) => `- \`${e}\``));
  }
  if (droppedOverrides.length > 0) {
    lines.push(
      "",
      "Removed `overrides` entries that are no longer needed (superseded by a higher-version entry for the same package, or the package is no longer in the dependency tree):",
    );
    lines.push(...droppedOverrides.map((o) => `- \`${o}\``));
  }

  return lines.join("\n");
}

async function main() {
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
      `::warning::pnpm install failed after the update-mode fix; reverting pnpm-lock.yaml, pnpm-workspace.yaml, and package.json to their original state. ${e.message}`,
    );
    restore(original);
  }

  runFix("override", cwd);
  // Collapsing overlapping minimumReleaseAgeExclude/overrides ranges is
  // what makes the override result installable in the first place (see the
  // ERR_PNPM_NO_MATURE_MATCHING_VERSION case above the normalizeWorkspace
  // definition), not just cosmetic cleanup — so it has to run before this
  // verify, not after.
  let pruneResult = await normalizeWorkspace(cwd);
  try {
    verifyInstallable(cwd);
  } catch (e) {
    // fallback is still `original` here when the update-mode install above
    // also failed — say so, rather than always claiming an update-mode
    // result that may never have existed.
    const revertTarget = fallback === original ? "their original state" : "the update-mode-only result";
    console.log(
      `::warning::pnpm install failed after the override fallback; reverting pnpm-lock.yaml, pnpm-workspace.yaml, and package.json to ${revertTarget}. ${e.message}`,
    );
    restore(fallback);
    // `fallback` was snapshotted before the normalize pass above ran, so
    // the restored files haven't been swept yet — sweep them now. Only
    // re-verify if that sweep actually touched something: `fallback` is
    // proven installable when it's a real update-mode result (verified
    // right after that fix), but when the update-mode install also failed,
    // `fallback` is `original` — never verified at all — and re-running
    // verify unconditionally would newly fail the whole action on an
    // already-broken repo that this feature had no part in breaking. A
    // failure here, when the sweep did change something, means the
    // normalize pass itself broke installability, which must fail the
    // action loudly rather than silently ship an uninstallable result — so
    // it's deliberately not wrapped in try/catch.
    pruneResult = await normalizeWorkspace(cwd);
    if (pruneResult.changed) verifyInstallable(cwd);
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
  setMultilineOutput("summary", buildSummary(beforeAudit, afterAudit, pruneResult));
}

// Only auto-run when executed directly (`node lockfile-audit-fix.mjs`), not
// when imported by the test file.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
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
  splitNameSpec,
  parseVer,
  verGt,
  quoteIfNeeded,
  findYamlBlock,
  collapseExcludeDuplicates,
  collapseOverrideDuplicates,
  overrideTargetName,
  isMentioned,
  readLockfileOutsideOverrides,
  pruneOrphanedOverrides,
  getMinimumReleaseAgeMinutes,
  fetchPublishTimes,
  pruneStaleExcludes,
  normalizeWorkspace,
};
