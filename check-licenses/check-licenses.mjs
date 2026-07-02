#!/usr/bin/env node

/**
 * License Checker for CI
 *
 * Checks that all dependencies (as reported by `pnpm licenses list`) use
 * allowed licenses, based on the Google licenseclassifier categories:
 * https://github.com/google/licenseclassifier/blob/e6a9bb99b5a6f71d5a34336b8245e305f5430f99/license_type.go
 *
 * The reciprocal/notice/unencumbered groups below are the shared baseline.
 * Per-repository additions/removals come in via ADDITIONAL_LICENSES /
 * DENIED_LICENSES (comma- or newline-separated SPDX identifiers), typically
 * sourced from a repository's `ALLOWED_LICENSES` GitHub Variable.
 *
 * Multi-license handling:
 *   "(MIT OR Apache-2.0)" is allowed if any member license is allowed.
 *   "(Apache-2.0 AND BSD-3-Clause)" (or a mix of AND/OR) requires every
 *   member license to be allowed, since precedence isn't parsed.
 *
 * Exit codes:
 *   0 - All licenses are allowed
 *   1 - Found disallowed licenses or an error occurred
 */

import { execSync } from "node:child_process";

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

function buildAllowSet() {
  const set = new Set();
  for (const licenses of Object.values(licenseGroups)) {
    for (const license of licenses) {
      set.add(license);
    }
  }
  for (const license of parseLicenseList(process.env.ADDITIONAL_LICENSES)) {
    set.add(license);
  }
  for (const license of parseLicenseList(process.env.DENIED_LICENSES)) {
    set.delete(license);
  }
  return set;
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
  const allowSet = buildAllowSet();

  console.log("Checking licenses...\n");
  execSync("pnpm licenses list", { stdio: "inherit" });

  const output = execSync("pnpm licenses list --json");
  const licensesJson = JSON.parse(output.toString());

  const violations = [];
  for (const [license, packages] of Object.entries(licensesJson)) {
    if (!isLicenseAllowed(license, allowSet)) {
      for (const pkg of packages) {
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

main();
