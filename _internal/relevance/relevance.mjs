#!/usr/bin/env node
// Determines whether a diff between two commits touches any path the
// caller cares about, and emits the compare's fork point (merge_base_commit)
// for reuse by find-base-run. Path matching is generic: each line of
// RELEVANT_PATHS is either an exact path or, if it ends with "/", a prefix
// — no regex, so callers never need to worry about pattern-escaping their
// own paths. A full (300-entry) page of compare files is treated as
// possibly truncated, and kept relevant unconditionally, since the API
// gives no total count to detect truncation by.
import { appendFileSync } from "node:fs";

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
 * @param {object} params
 * @param {string} params.shaBase
 * @param {string} params.shaHead
 * @param {string[]} params.relevantPaths - exact paths, or prefixes ending in "/"
 * @param {(base: string, head: string) => Promise<{ files?: { filename: string }[], merge_base_commit: { sha: string } }>} params.compareCommits
 * @returns {Promise<{ relevant: boolean, forkSha?: string, reason: string }>}
 */
export async function determineRelevance({ shaBase, shaHead, relevantPaths, compareCommits }) {
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

  const changedFiles = files.map((f) => f.filename);
  const relevant = changedFiles.some((f) =>
    relevantPaths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p)),
  );
  return {
    relevant,
    forkSha,
    reason: relevant ? "A relevant path changed." : "No relevant path changed.",
  };
}

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY, SHA_BASE, SHA_HEAD, RELEVANT_PATHS = "", GITHUB_OUTPUT } =
    process.env;

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
    compareCommits,
  });

  console.log(reason);
  if (forkSha) setOutput("fork-sha", forkSha);
  setOutput("relevant", String(relevant));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
