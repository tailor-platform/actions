#!/usr/bin/env node
// Determines whether a diff between two commits touches any path the
// caller cares about, and emits the compare's fork point (merge_base_commit)
// for reuse by find-base-run. Each line of RELEVANT_PATHS is either an exact
// path or, if it ends with "/", a prefix — no regex, so callers never need to
// worry about pattern-escaping their own paths. PATH_PATTERNS takes GitHub's
// `paths` filter patterns instead, for callers that already speak that
// syntax. A full (300-entry) page of compare files is treated as
// possibly truncated, and kept relevant unconditionally, since the API
// gives no total count to detect truncation by.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const ZERO_SHA = "0".repeat(40);

/**
 * @param {string} relevantPathsText - newline-separated; trailing "/" means prefix match
 * @returns {string[]}
 */
export function parseRelevantPaths(relevantPathsText) {
  return relevantPathsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * @typedef {{ negate: boolean, regex: RegExp }} PathPattern
 */

function escapeRegExp(char) {
  return char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function patternToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
      if (i >= pattern.length) throw new Error("trailing backslash");
      source += escapeRegExp(pattern[i]);
    } else if (char === "*" && pattern[i + 1] === "*") {
      i += 1;
      if (pattern[i + 1] === "/") {
        i += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?" || char === "+") {
      if (source.length === 0) throw new Error(`"${char}" has no preceding character`);
      source += char;
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) throw new Error("unclosed [");
      const body = pattern.slice(i + 1, end);
      if (!/^(?:[A-Za-z0-9](?:-[A-Za-z0-9])?)+$/.test(body)) {
        throw new Error("[] may list only letters, digits, and a-z / A-Z / 0-9 ranges");
      }
      source += `[${body}]`;
      i = end;
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * @param {string} pathPatternsText - newline-separated GitHub `paths` filter patterns
 * @returns {PathPattern[]}
 */
export function parsePathPatterns(pathPatternsText) {
  const patterns = pathPatternsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const negate = line.startsWith("!");
      const pattern = negate ? line.slice(1) : line;
      try {
        return { negate, regex: patternToRegExp(pattern) };
      } catch (error) {
        throw new Error(`Invalid path pattern "${line}": ${error.message}`);
      }
    });
  if (patterns.length > 0 && patterns.every((p) => p.negate)) {
    throw new Error('path-patterns needs at least one pattern without "!".');
  }
  return patterns;
}

/**
 * @param {string} file - repository-relative path
 * @param {PathPattern[]} patterns
 * @returns {boolean} whether the last pattern matching `file` includes it
 */
export function matchesPathPatterns(file, patterns) {
  let included = false;
  for (const { negate, regex } of patterns) {
    if (regex.test(file)) included = !negate;
  }
  return included;
}

/**
 * @param {object} params
 * @param {string} params.shaBase
 * @param {string} params.shaHead
 * @param {string[]} params.relevantPaths - exact paths, or prefixes ending in "/"
 * @param {PathPattern[]} [params.pathPatterns] - GitHub `paths` filter patterns
 * @param {(base: string, head: string) => Promise<{ files?: { filename: string, previous_filename?: string }[], merge_base_commit: { sha: string } }>} params.compareCommits
 * @returns {Promise<{ relevant: boolean, forkSha?: string, reason: string }>}
 */
export async function determineRelevance({
  shaBase,
  shaHead,
  relevantPaths,
  pathPatterns = [],
  compareCommits,
}) {
  if (shaBase === ZERO_SHA) {
    return { relevant: true, reason: "No previous commit to diff against; treating as relevant." };
  }

  const compare = await compareCommits(shaBase, shaHead);
  const forkSha = compare.merge_base_commit.sha;

  const files = compare.files ?? [];
  if (files.length >= 300) {
    return {
      relevant: true,
      forkSha,
      reason: "Compare API file list may be truncated at 300 entries; treating as relevant to be safe.",
    };
  }

  // Renames carry both the new filename and (via previous_filename) the old
  // one; matching only the new name would miss a relevant path a file was
  // renamed out of.
  const changedFiles = files.flatMap((f) =>
    f.previous_filename ? [f.filename, f.previous_filename] : [f.filename],
  );
  const relevant = changedFiles.some(
    (f) =>
      relevantPaths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)) ||
      matchesPathPatterns(f, pathPatterns),
  );
  return {
    relevant,
    forkSha,
    reason: relevant ? "A relevant path changed." : "No relevant path changed.",
  };
}

async function main() {
  const {
    GH_TOKEN,
    GITHUB_REPOSITORY,
    SHA_BASE,
    SHA_HEAD,
    RELEVANT_PATHS = "",
    PATH_PATTERNS = "",
    GITHUB_OUTPUT,
  } = process.env;

  function setOutput(name, value) {
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
  }

  async function compareCommits(base, head) {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPOSITORY}/compare/${base}...${head}`,
      { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) {
      throw new Error(`compare ${base}...${head} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  const { relevant, forkSha, reason } = await determineRelevance({
    shaBase: SHA_BASE,
    shaHead: SHA_HEAD,
    relevantPaths: parseRelevantPaths(RELEVANT_PATHS),
    pathPatterns: parsePathPatterns(PATH_PATTERNS),
    compareCommits,
  });

  console.log(reason);
  if (forkSha) setOutput("fork-sha", forkSha);
  setOutput("relevant", String(relevant));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
