#!/usr/bin/env node

/**
 * Lockfile Audit — regression-only advisory gate
 *
 * Fails only when the current pnpm-lock.yaml introduces a security advisory
 * that wasn't already present at the base commit. Pre-existing advisories
 * elsewhere in the lockfile don't block unrelated changes — a scheduled
 * fix workflow (running `pnpm audit --fix` independent of any PR) is the
 * right place to clear those, since fixing them here would tie an unrelated
 * change's merge to the availability of a patched version.
 *
 * Base commit resolution (BASE_SHA env, or derived when unset):
 *   - `pull_request`: the PR's base commit (`github.event.pull_request.base.sha`)
 *   - anything else (push, workflow_dispatch, ...): the ref's previous tip
 *     (`github.event.before`) — absent on `workflow_dispatch`, in which case
 *     the regression check is skipped (nothing to diff against)
 *
 * A resolved base sha that isn't reachable in this checkout (e.g. the
 * caller forgot `fetch-depth: 0`) is a hard failure, not a skip — silently
 * no-op'ing there would defeat the gate for exactly the callers who most
 * need it. A resolved base sha that IS reachable but predates
 * pnpm-lock.yaml's introduction has nothing to compare against, which is a
 * legitimate skip.
 *
 * `pnpm audit` resolves advisories from the lockfile alone (no dependency
 * install needed), so the base commit's lockfile is audited by temporarily
 * swapping pnpm-lock.yaml in the working tree for the base revision's copy,
 * then restoring it — never by checking out the base commit itself, which
 * would require a second full checkout.
 *
 * Unlike the original inline-bash version this replaces, a `pnpm audit`
 * invocation that fails for a reason OTHER than "found vulnerabilities"
 * (e.g. a registry outage) surfaces as a hard error instead of silently
 * being treated as "zero advisories" — a transient audit failure should
 * not be indistinguishable from a clean lockfile.
 *
 * Exit codes:
 *   0 - No new advisories (or nothing to compare against)
 *   1 - New advisories introduced, or an error occurred
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ZERO_SHA = "0000000000000000000000000000000000000000";

class LockfileAuditError extends Error {}

/**
 * @param {{baseShaInput?: string, eventName?: string, prBaseSha?: string, pushBeforeSha?: string}} env
 * @returns {string | null} the base commit SHA to diff against, or null when there's nothing to compare
 */
function resolveBaseSha({ baseShaInput, eventName, prBaseSha, pushBeforeSha }) {
  if (baseShaInput) return baseShaInput;
  const sha = eventName === "pull_request" ? prBaseSha : pushBeforeSha;
  return sha && sha !== ZERO_SHA ? sha : null;
}

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
 * @param {Set<string>} headIds
 * @param {Set<string>} baseIds
 * @returns {string[]} advisory IDs present in headIds but not baseIds, sorted
 */
function findNewAdvisoryIds(headIds, baseIds) {
  return [...headIds].filter((id) => !baseIds.has(id)).sort();
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
  return `- ${id}: ${title} (module: ${moduleName}, severity: ${severity})`;
}

/**
 * @param {unknown} headAuditJson
 * @param {string[]} newIds
 * @returns {string[]} one formatted line per new advisory, in the same order as newIds
 */
function formatAdvisoryLines(headAuditJson, newIds) {
  return newIds.map((id) => formatAdvisoryLine(findAdvisoryById(headAuditJson, id))).filter(Boolean);
}

/**
 * @param {string} auditLevel
 * @param {string} cwd
 * @returns {unknown} parsed `pnpm audit --json` output
 */
function runAudit(auditLevel, cwd) {
  try {
    const output = execFileSync("pnpm", ["audit", `--audit-level=${auditLevel}`, "--json"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    });
    return JSON.parse(output);
  } catch (e) {
    // pnpm audit exits non-zero merely because it found advisories at or
    // above audit-level — that's expected data, not a failure, and its JSON
    // report is still on stdout. Only treat this as a real error when stdout
    // isn't valid JSON (registry outage, auth failure, etc.).
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout.toString());
      } catch {
        throw new LockfileAuditError(`\`pnpm audit\` produced unparseable output: ${e.message}`);
      }
    }
    throw new LockfileAuditError(`\`pnpm audit\` failed: ${e.message}`);
  }
}

/**
 * Distinct from baseHasLockfile: this checks the commit OBJECT itself, not
 * a path within it. A caller who forgot `fetch-depth: 0` (shallow clone)
 * has a base commit that's genuinely unreachable — that's a misconfiguration
 * the gate should fail loudly on, not silently treat the same as a commit
 * that legitimately predates pnpm-lock.yaml's introduction.
 * @param {string} baseSha
 * @param {string} cwd
 * @returns {boolean} whether baseSha exists in this checkout's history
 */
function baseCommitExists(baseSha, cwd) {
  try {
    execFileSync("git", ["cat-file", "-e", baseSha], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} baseSha
 * @param {string} cwd
 * @returns {boolean} whether pnpm-lock.yaml exists at baseSha
 */
function baseHasLockfile(baseSha, cwd) {
  try {
    // The leading "./" forces git to resolve the pathspec relative to cwd
    // (working-directory) rather than the repository root, so a monorepo
    // caller auditing a subdirectory's lockfile resolves the right file.
    execFileSync("git", ["cat-file", "-e", `${baseSha}:./pnpm-lock.yaml`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} baseSha
 * @param {string} cwd
 * @returns {Buffer} pnpm-lock.yaml's content at baseSha
 */
function readLockfileAtRevision(baseSha, cwd) {
  return execFileSync("git", ["show", `${baseSha}:./pnpm-lock.yaml`], { cwd, maxBuffer: 1024 * 1024 * 64 });
}

function main() {
  const cwd = process.cwd();
  const auditLevel = process.env.AUDIT_LEVEL || "moderate";
  const baseSha = resolveBaseSha({
    baseShaInput: process.env.BASE_SHA_INPUT,
    eventName: process.env.EVENT_NAME,
    prBaseSha: process.env.PR_BASE_SHA,
    pushBeforeSha: process.env.PUSH_BEFORE_SHA,
  });

  let headAudit;
  try {
    // pnpm audit resolves advisories against the lockfile only; no install needed.
    headAudit = runAudit(auditLevel, cwd);
  } catch (e) {
    if (!(e instanceof LockfileAuditError)) throw e;
    console.error(`::error::${e.message}`);
    process.exit(1);
  }

  if (!baseSha) {
    console.log("No base commit to compare against; skipping regression check.");
    process.exit(0);
  }
  if (!baseCommitExists(baseSha, cwd)) {
    console.error(
      `::error::Base commit ${baseSha} is not reachable in this checkout. ` +
        "Ensure the caller checks out with fetch-depth: 0 (full history) so the base commit is present.",
    );
    process.exit(1);
  }
  if (!baseHasLockfile(baseSha, cwd)) {
    console.log("Base commit has no pnpm-lock.yaml; skipping regression check.");
    process.exit(0);
  }

  const lockfilePath = join(cwd, "pnpm-lock.yaml");
  const headLockfile = readFileSync(lockfilePath);
  let baseAudit;
  try {
    writeFileSync(lockfilePath, readLockfileAtRevision(baseSha, cwd));
    try {
      baseAudit = runAudit(auditLevel, cwd);
    } catch (e) {
      if (!(e instanceof LockfileAuditError)) throw e;
      console.error(`::error::${e.message}`);
      process.exit(1);
    }
  } finally {
    writeFileSync(lockfilePath, headLockfile);
  }

  const headIds = extractAdvisoryIds(headAudit);
  const baseIds = extractAdvisoryIds(baseAudit);
  const newIds = findNewAdvisoryIds(headIds, baseIds);

  if (newIds.length > 0) {
    console.log("::error::This change introduces new security advisories not present on the base commit:");
    for (const line of formatAdvisoryLines(headAudit, newIds)) {
      console.log(line);
    }
    process.exit(1);
  }

  console.log("No new advisories introduced by this change.");
}

// Only auto-run when executed directly (`node lockfile-audit.mjs`), not when
// imported by the test file.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  LockfileAuditError,
  resolveBaseSha,
  extractAdvisoryIds,
  findNewAdvisoryIds,
  findAdvisoryById,
  formatAdvisoryLine,
  formatAdvisoryLines,
  baseCommitExists,
  baseHasLockfile,
};
