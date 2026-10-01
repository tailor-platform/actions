#!/usr/bin/env node
// Determines whether a diff between two commits touches any path the
// caller cares about, and emits the compare's fork point (merge_base_commit)
// for reuse by find-base-run. Each line of RELEVANT_PATHS is either an exact
// path or, if it ends with "/", a prefix — no regex, so callers never need to
// worry about pattern-escaping their own paths. PATH_PATTERNS takes globs
// instead: `*`, `**`, and leading `!` exclusions checked in order. A full
// (300-entry) page of compare files is treated as
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
 * @typedef {{ type: "char", char: string } | { type: "star" | "globstar" | "optional" | "untilSlash" }} Token
 * @typedef {{ negate: boolean, tokens: Token[] }} PathPattern
 */

// Other tools give these characters different meanings (`?` is one character in
// minimatch but "zero or one of the previous one" in GitHub's `paths`), so they
// are rejected rather than picked a meaning for.
const UNSUPPORTED_CHARACTERS = /[?+[\]{}()\\]/;

function tokenize(pattern) {
  if (UNSUPPORTED_CHARACTERS.test(pattern)) {
    throw new Error("only *, **, and a leading ! have a special meaning; ?+[]{}()\\ are not supported");
  }
  const tokens = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      const segmentStart = i === 0 || pattern[i - 1] === "/";
      while (pattern[i + 1] === "*") i += 1;
      if (segmentStart && pattern[i + 1] === "/") {
        i += 1;
        tokens.push({ type: "optional" }, { type: "untilSlash" });
      } else {
        tokens.push({ type: "globstar" });
      }
    } else if (char === "*") {
      tokens.push({ type: "star" });
    } else {
      tokens.push({ type: "char", char });
    }
  }
  return tokens;
}

// Tracks every pattern position the path so far can be at, one character at a
// time. A backtracking RegExp would instead retry each way of splitting the path
// between the wildcards, which grows exponentially with the number of `*`.
function matchesTokens(file, tokens) {
  const addWithEpsilons = (positions, start) => {
    const pending = [start];
    while (pending.length > 0) {
      const i = pending.pop();
      if (positions[i]) continue;
      positions[i] = true;
      const token = tokens[i];
      if (token === undefined) continue;
      if (token.type === "star" || token.type === "globstar") pending.push(i + 1);
      if (token.type === "optional") pending.push(i + 1, i + 2);
    }
  };
  let positions = new Array(tokens.length + 1).fill(false);
  addWithEpsilons(positions, 0);
  for (let at = 0; at < file.length; at++) {
    const char = file[at];
    const next = new Array(tokens.length + 1).fill(false);
    positions.forEach((reached, i) => {
      if (!reached) return;
      const token = tokens[i];
      if (token === undefined) return;
      if (token.type === "char" && token.char === char) addWithEpsilons(next, i + 1);
      if (token.type === "star" && char !== "/") addWithEpsilons(next, i);
      if (token.type === "globstar") addWithEpsilons(next, i);
      if (token.type === "untilSlash") {
        addWithEpsilons(next, i);
        if (char === "/") addWithEpsilons(next, i + 1);
      }
    });
    positions = next;
  }
  return positions[tokens.length];
}

/**
 * @param {string} pathPatternsText - newline-separated `*` / `**` / leading `!` patterns
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
        return { negate, tokens: tokenize(pattern) };
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
  for (const { negate, tokens } of patterns) {
    if (matchesTokens(file, tokens)) included = !negate;
  }
  return included;
}

/**
 * @param {object} params
 * @param {string} params.shaBase
 * @param {string} params.shaHead
 * @param {string[]} params.relevantPaths - exact paths, or prefixes ending in "/"
 * @param {PathPattern[]} [params.pathPatterns] - patterns from {@link parsePathPatterns}
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
