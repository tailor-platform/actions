#!/usr/bin/env node

/**
 * License Checker for CI
 *
 * Checks that all dependencies (as reported by `pnpm licenses list`) use
 * allowed licenses, based on the Google licenseclassifier categories:
 * https://github.com/google/licenseclassifier/blob/e6a9bb99b5a6f71d5a34336b8245e305f5430f99/license_type.go
 *
 * Which of the reciprocal/notice/unencumbered groups apply is itself
 * configurable via LICENSE_GROUPS (defaults to all three), since including
 * "reciprocal" (weak-copyleft licenses like MPL/EPL/CDDL) is a licensing
 * policy call, not a fixed fact — organizations may want to change it
 * without editing this script. Per-repository additions/removals on top of
 * the selected groups come in via ADDITIONAL_LICENSES / DENIED_LICENSES
 * (comma- or newline-separated SPDX identifiers). All three typically come
 * from GitHub Variables (e.g. LICENSE_GROUPS / ALLOWED_LICENSES).
 *
 * Multi-license handling:
 *   "(MIT OR Apache-2.0)" is allowed if any member license is allowed.
 *   "(Apache-2.0 AND BSD-3-Clause)" (or a mix of AND/OR) requires every
 *   member license to be allowed, since precedence isn't parsed.
 *
 * Package exceptions (PACKAGE_EXCEPTIONS, a JSON object mapping a license
 * string to an array of dependency chains):
 *
 *   { "LGPL-3.0-or-later": [["nextjs-app", "next"]] }
 *
 * Approving a license outright (ADDITIONAL_LICENSES) would silently bless
 * every future dependency under that license. A chain instead approves one
 * specific route to it: `pnpm why <package> -r --json` finds every
 * dependency path from a workspace project down to the violating package, a
 * chain matches a path if its elements (workspace project name, then
 * intermediate/target package names — glob patterns like
 * "@img/sharp-libvips-*" allowed) appear as an ordered subsequence of it
 * (other dependencies may appear between them), and the package is excused
 * only if EVERY one of its actual paths matches some declared chain — an
 * approved route doesn't excuse a different, unreviewed route to the same
 * package. The chain doesn't need to end at the violating package itself —
 * `["nextjs-app", "next"]` approves this license for anything reached via
 * nextjs-app's use of next, not just one exact package.
 *
 * Exit codes:
 *   0 - All licenses are allowed
 *   1 - Found disallowed licenses or an error occurred
 */

import { execFileSync, execSync } from "node:child_process";

const licenseGroups = {
  // https://github.com/google/licenseclassifier/blob/e6a9bb99b5a6f71d5a34336b8245e305f5430f99/license_type.go#L225
  reciprocal: [
    "APSL-1.0",
    "APSL-1.1",
    "APSL-1.2",
    "APSL-2.0",
    "CDDL-1.0",
    "CDDL-1.1",
    "CPL-1.0",
    "EPL-1.0",
    "EPL-2.0",
    "FreeImage",
    "IPL-1.0",
    "MPL-1.0",
    "MPL-1.1",
    "MPL-2.0",
    "Ruby",
  ],
  // https://github.com/google/licenseclassifier/blob/e6a9bb99b5a6f71d5a34336b8245e305f5430f99/license_type.go#L249
  notice: [
    "AFL-1.1",
    "AFL-1.2",
    "AFL-2.0",
    "AFL-2.1",
    "AFL-3.0",
    "Apache-1.0",
    "Apache-1.1",
    "Apache-2.0",
    "Artistic-1.0-cl8",
    "Artistic-1.0-Perl",
    "Artistic-1.0",
    "Artistic-2.0",
    "BSL-1.0",
    "BSD-2-Clause-FreeBSD",
    "BSD-2-Clause-NetBSD",
    "BSD-2-Clause",
    "BSD-3-Clause-Attribution",
    "BSD-3-Clause-Clear",
    "BSD-3-Clause-LBNL",
    "BSD-3-Clause",
    "BSD-4-Clause",
    "BSD-4-Clause-UC",
    "BSD-Protection",
    "CC-BY-1.0",
    "CC-BY-2.0",
    "CC-BY-2.5",
    "CC-BY-3.0",
    "CC-BY-4.0",
    "FTL",
    "ISC",
    "ImageMagick",
    "Libpng",
    "Lil-1.0",
    "Linux-OpenIB",
    "LPL-1.02",
    "LPL-1.0",
    "MS-PL",
    "MIT",
    "NCSA",
    "OpenSSL",
    "PHP-3.01",
    "PHP-3.0",
    "PIL",
    "Python-2.0",
    "Python-2.0-complete",
    "PostgreSQL",
    "SGI-B-1.0",
    "SGI-B-1.1",
    "SGI-B-2.0",
    "Unicode-DFS-2015",
    "Unicode-DFS-2016",
    "Unicode-TOU",
    "UPL-1.0",
    "W3C-19980720",
    "W3C-20150513",
    "W3C",
    "X11",
    "Xnet",
    "Zend-2.0",
    "zlib-acknowledgement",
    "Zlib",
    "ZPL-1.1",
    "ZPL-2.0",
    "ZPL-2.1",
  ],
  // https://github.com/google/licenseclassifier/blob/e6a9bb99b5a6f71d5a34336b8245e305f5430f99/license_type.go#L324
  unencumbered: ["CC0-1.0", "MIT-0", "Unlicense", "0BSD"],
};

function parseLicenseList(raw) {
  if (!raw) return [];
  const delimiter = raw.includes("\n") ? "\n" : ",";
  return raw
    .split(delimiter)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Thrown by the pure parsing/validation functions below; main() catches it,
// prints a `::error::` annotation, and exits 1. Kept separate from
// process.exit so the parsing logic itself stays unit-testable.
class LicenseCheckError extends Error {}

function resolveGroups(raw) {
  const requested = parseLicenseList(raw);
  if (requested.length === 0) {
    return Object.keys(licenseGroups);
  }
  const unknown = requested.filter((g) => !(g in licenseGroups));
  if (unknown.length > 0) {
    throw new LicenseCheckError(
      `Unknown license group(s) in LICENSE_GROUPS: ${unknown.join(", ")}. ` +
        `Valid groups: ${Object.keys(licenseGroups).join(", ")}`,
    );
  }
  return requested;
}

function buildAllowSet(groups, additionalRaw, deniedRaw) {
  const set = new Set();
  for (const group of groups) {
    for (const license of licenseGroups[group]) {
      set.add(license);
    }
  }
  for (const license of parseLicenseList(additionalRaw)) {
    set.add(license);
  }
  for (const license of parseLicenseList(deniedRaw)) {
    set.delete(license);
  }
  return set;
}

function parsePackageExceptions(raw) {
  if (!raw || raw.trim().length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new LicenseCheckError(`PACKAGE_EXCEPTIONS is not valid JSON: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LicenseCheckError('PACKAGE_EXCEPTIONS must be a JSON object of { "<license>": [[...chain]] }');
  }
  for (const [license, chains] of Object.entries(parsed)) {
    const valid =
      Array.isArray(chains) &&
      chains.every((chain) => Array.isArray(chain) && chain.every((s) => typeof s === "string"));
    if (!valid) {
      throw new LicenseCheckError(
        `PACKAGE_EXCEPTIONS["${license}"] must be an array of string arrays (dependency chains)`,
      );
    }
  }
  return parsed;
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesPattern(name, pattern) {
  return globToRegExp(pattern).test(name);
}

// True if `chain` appears as an ordered subsequence of `path` (other
// entries in `path` may appear between chain elements).
function isOrderedSubsequence(chain, path) {
  let i = 0;
  for (const name of path) {
    if (i < chain.length && matchesPattern(name, chain[i])) {
      i++;
    }
  }
  return i === chain.length;
}

// Recursively walks a `pnpm why` dependents tree, returning every complete
// path from a workspace project (a node with `depField`) down to the
// original queried package, in workspace-project-first order. Branches that
// dead-end without reaching a workspace project (namely `deduped: true`
// nodes, where pnpm points at an identical chain shown elsewhere in the
// tree instead of repeating it) contribute no path — the same route is
// still captured wherever pnpm did expand it in full.
function collectDependencyPaths(node, pathSoFar) {
  const path = [node.name, ...pathSoFar];
  if (node.depField) {
    return [path];
  }
  if (!Array.isArray(node.dependents) || node.dependents.length === 0) {
    return [];
  }
  return node.dependents.flatMap((dependent) => collectDependencyPaths(dependent, path));
}

const whyPathsCache = new Map();

function dependencyPathsFor(packageName) {
  if (whyPathsCache.has(packageName)) {
    return whyPathsCache.get(packageName);
  }
  let paths = [];
  try {
    const output = execFileSync("pnpm", ["why", packageName, "-r", "--json"], { encoding: "utf8" });
    const matches = JSON.parse(output);
    if (Array.isArray(matches)) {
      paths = matches.flatMap((match) =>
        Array.isArray(match.dependents)
          ? match.dependents.flatMap((dependent) => collectDependencyPaths(dependent, [match.name]))
          : [],
      );
    }
  } catch {
    paths = [];
  }
  whyPathsCache.set(packageName, paths);
  return paths;
}

// Excused only if EVERY route to this package is covered by some declared
// chain — one approved route doesn't excuse a different, unreviewed route
// to the same package. If no route could be resolved at all (pnpm why
// failed, or found nothing), there's nothing to verify, so it's not excused
// (fail safe rather than silently pass). `getPaths` defaults to the real
// `pnpm why`-backed lookup; tests inject a fake one to avoid shelling out.
function isPackageException(packageName, license, exceptions, getPaths = dependencyPathsFor) {
  const chains = exceptions[license];
  if (!chains || chains.length === 0) return false;
  const paths = getPaths(packageName);
  if (paths.length === 0) return false;
  return paths.every((path) => chains.some((chain) => isOrderedSubsequence(chain, path)));
}

function splitMembers(expr) {
  return expr
    .split(/\s+(?:OR|AND)\s+/i)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function isLicenseAllowed(licenseString, allowSet) {
  const expr = licenseString.replace(/[()]/g, "").trim();

  // OR: usable under any one license, so allowed if any member is allowed.
  if (/\s+OR\s+/i.test(expr) && !/\s+AND\s+/i.test(expr)) {
    return splitMembers(expr).some((l) => allowSet.has(l));
  }

  // Single license, AND, or mixed (no precedence parsing): all must be allowed.
  return splitMembers(expr).every((l) => allowSet.has(l));
}

function main() {
  let groups, allowSet, packageExceptions;
  try {
    groups = resolveGroups(process.env.LICENSE_GROUPS);
    allowSet = buildAllowSet(groups, process.env.ADDITIONAL_LICENSES, process.env.DENIED_LICENSES);
    packageExceptions = parsePackageExceptions(process.env.PACKAGE_EXCEPTIONS);
  } catch (e) {
    if (!(e instanceof LicenseCheckError)) throw e;
    console.error(`::error::${e.message}`);
    process.exit(1);
  }

  console.log(`Checking licenses (groups: ${groups.join(", ")})...\n`);
  execSync("pnpm licenses list", { stdio: "inherit" });

  const output = execSync("pnpm licenses list --json");
  const licensesJson = JSON.parse(output.toString());

  const violations = [];
  for (const [license, packages] of Object.entries(licensesJson)) {
    if (!isLicenseAllowed(license, allowSet)) {
      for (const pkg of packages) {
        if (isPackageException(pkg.name, license, packageExceptions)) continue;
        violations.push({ package: pkg.name, license });
      }
    }
  }

  if (violations.length === 0) {
    console.log("All licenses are allowed.");
    process.exit(0);
  }

  console.error("Found dependencies with disallowed licenses:\n");
  for (const violation of violations) {
    console.error(`  - ${violation.package}`);
    console.error(`    License: ${violation.license}\n`);
  }
  process.exit(1);
}

// Only auto-run when executed directly (`node check-licenses.mjs`), not when
// imported by the test file.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  licenseGroups,
  LicenseCheckError,
  parseLicenseList,
  resolveGroups,
  buildAllowSet,
  parsePackageExceptions,
  globToRegExp,
  matchesPattern,
  isOrderedSubsequence,
  collectDependencyPaths,
  isPackageException,
  splitMembers,
  isLicenseAllowed,
};
