#!/usr/bin/env node

/**
 * Create Signed PR
 *
 * Commits a caller-supplied, bounded list of known file paths via GitHub's
 * Git Data API (blob -> tree -> commit -> ref) and idempotently creates or
 * updates a pull request for them — without ever running `git commit`
 * locally or depending on a third-party action.
 *
 * Why the Git Data API instead of a local commit + push: a commit created
 * through GitHub's REST API using the default `GITHUB_TOKEN` or a GitHub
 * App installation token is automatically shown as "Verified" on GitHub,
 * satisfying a `required_signatures` branch protection rule without any
 * GPG key material. A plain personal access token has no such effect —
 * its commits are unsigned, same as a local `git commit` would produce.
 *
 * This action is deliberately narrow: `paths` is a known, caller-supplied
 * list of files (e.g. the ones a prior step like lockfile-audit-fix just
 * modified), not an arbitrary repo-wide diff. That's what makes a from-
 * scratch Git Data API implementation tractable — general-purpose PR
 * automation (peter-evans/create-pull-request) has to handle arbitrary
 * working-tree diffs, deletions, renames, and binary files at scale; this
 * only has to read a short list of paths and write them as blobs.
 *
 * Each run re-parents the commit on the base branch's CURRENT head (not
 * the fix branch's previous tip) and force-moves the fix branch ref to it,
 * so the branch always holds a single clean commit rebased on the latest
 * base — the same behavior peter-evans' default (non-`commit-message`
 * accumulation) mode has. A consequence: any commit a human pushed to the
 * fix branch directly is discarded on the next run, same as upstream.
 *
 * Token requirements:
 *   - `contents: write` and `pull-requests: write` permissions.
 *   - GITHUB_TOKEN or a GitHub App installation token, for Verified
 *     commits. A classic/fine-grained PAT still works but produces
 *     unsigned commits — defeating the point of this action under a
 *     `required_signatures` branch protection rule.
 *   - A PR created with the default GITHUB_TOKEN does NOT trigger
 *     `pull_request`-triggered workflows (GitHub suppresses recursive
 *     workflow runs from its own token) — the created PR gets no CI. Use a
 *     GitHub App installation token if the PR needs to run your normal CI.
 *
 * No-op behavior: if the new tree is identical to the base branch's tree
 * (nothing actually changed), no commit or ref update happens, and an
 * existing open PR for the branch (if any) is left untouched rather than
 * closed — unlike peter-evans' `delete-branch: true` default. Its number
 * and URL are still reported as outputs.
 *
 * Outputs (via $GITHUB_OUTPUT):
 *   changed             - "true" if a new commit was created
 *   pull-request-number - the PR's number, or empty if none exists
 *   pull-request-url    - the PR's HTML URL, or empty if none exists
 *   commit-sha          - the new commit's sha, or empty if unchanged
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const API_VERSION = "2022-11-28";

class GitHubApiError extends Error {}

/**
 * @param {{method: string, path: string, token: string, apiBaseUrl: string, body?: unknown}} args
 */
async function githubRequest({ method, path, token, apiBaseUrl, body }) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new GitHubApiError(`${method} ${path} failed with ${res.status}: ${text.slice(0, 2000)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** @param {string} pathsInput */
function parseLines(input) {
  return (input ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * @param {{owner: string, repo: string, token: string, apiBaseUrl: string}} repoArgs
 */
function makeClient({ owner, repo, token, apiBaseUrl }) {
  const request = (method, path, body) => githubRequest({ method, path: `/repos/${owner}/${repo}${path}`, token, apiBaseUrl, body });
  return {
    getDefaultBranch: async () => {
      const repoInfo = await request("GET", "");
      return repoInfo.default_branch;
    },
    /** @returns {Promise<string | null>} the branch's head commit sha, or null if it doesn't exist */
    getBranchSha: async (branch) => {
      const ref = await request("GET", `/git/ref/heads/${encodeURIComponent(branch)}`);
      return ref?.object?.sha ?? null;
    },
    /** @returns {Promise<string>} the commit's tree sha */
    getCommitTreeSha: async (sha) => {
      const commit = await request("GET", `/git/commits/${sha}`);
      return commit.tree.sha;
    },
    createBlobSha: async (content) => {
      const blob = await request("POST", "/git/blobs", { content: content.toString("base64"), encoding: "base64" });
      return blob.sha;
    },
    /** @returns {Promise<string>} the new tree's sha */
    createTree: async (baseTreeSha, entries) => {
      const tree = await request("POST", "/git/trees", { base_tree: baseTreeSha, tree: entries });
      return tree.sha;
    },
    /** @returns {Promise<string>} the new commit's sha */
    createCommit: async (message, treeSha, parentSha) => {
      const commit = await request("POST", "/git/commits", { message, tree: treeSha, parents: [parentSha] });
      return commit.sha;
    },
    createBranch: (branch, sha) => request("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha }),
    forceMoveBranch: (branch, sha) => request("PATCH", `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: true }),
    findOpenPullRequest: async (branch, base) => {
      const prs = await request("GET", `/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&state=open`);
      return prs?.[0] ?? null;
    },
    createPullRequest: (branch, base, title, body) => request("POST", "/pulls", { head: branch, base, title, body }),
    updatePullRequest: (number, title, body) => request("PATCH", `/pulls/${number}`, { title, body }),
    addLabels: (number, labels) => request("POST", `/issues/${number}/labels`, { labels }),
  };
}

/**
 * @param {{paths: string[], workspace: string}} args
 * @returns {{path: string, mode: "100644", type: "blob", content: Buffer}[]}
 */
function readTreeFiles({ paths, workspace }) {
  return paths.map((path) => {
    const absolutePath = join(workspace, path);
    if (!existsSync(absolutePath)) {
      throw new Error(`Path listed in \`paths\` does not exist locally: ${path}`);
    }
    return { path, mode: "100644", type: "blob", content: readFileSync(absolutePath) };
  });
}

async function main() {
  const token = process.env.TOKEN;
  const paths = parseLines(process.env.PATHS);
  const branch = process.env.BRANCH;
  const baseInput = process.env.BASE || "";
  const commitMessage = process.env.COMMIT_MESSAGE;
  const title = process.env.TITLE;
  const body = process.env.BODY || "";
  const labels = parseLines(process.env.LABELS);
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  // GITHUB_API_URL is one of the reserved variables the Actions runner
  // injects into every step's process environment itself — a job- or
  // workflow-level `env:` override for it is silently discarded before the
  // step actually runs, so it can't be used to redirect this action's API
  // calls in a test. API_BASE_URL is a plain, unreserved env var this
  // action's own action.yaml maps from an `api-base-url` input, letting a
  // caller (typically a test) override it directly.
  const apiBaseUrl = process.env.API_BASE_URL || process.env.GITHUB_API_URL || "https://api.github.com";
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");

  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be set as owner/repo");
  if (paths.length === 0) throw new Error("`paths` must list at least one file");

  const outputFile = process.env.GITHUB_OUTPUT;
  const setOutput = (name, value) => {
    if (!outputFile) return;
    appendFileSync(outputFile, `${name}=${value ?? ""}\n`);
  };

  const client = makeClient({ owner, repo, token, apiBaseUrl });

  const base = baseInput || (await client.getDefaultBranch());
  const baseSha = await client.getBranchSha(base);
  if (!baseSha) throw new Error(`Base branch not found: ${base}`);
  const baseTreeSha = await client.getCommitTreeSha(baseSha);

  const files = readTreeFiles({ paths, workspace });
  const treeEntries = [];
  for (const file of files) {
    const sha = await client.createBlobSha(file.content);
    treeEntries.push({ path: file.path, mode: file.mode, type: file.type, sha });
  }
  const newTreeSha = await client.createTree(baseTreeSha, treeEntries);

  const changed = newTreeSha !== baseTreeSha;
  let commitSha = null;

  if (changed) {
    commitSha = await client.createCommit(commitMessage, newTreeSha, baseSha);
    const branchSha = await client.getBranchSha(branch);
    if (branchSha) {
      await client.forceMoveBranch(branch, commitSha);
    } else {
      await client.createBranch(branch, commitSha);
    }
  } else {
    console.log("No changes to commit (new tree matches the base branch's tree).");
  }

  const existingPr = await client.findOpenPullRequest(branch, base);
  let prNumber = existingPr?.number ?? null;
  let prUrl = existingPr?.html_url ?? null;

  if (changed) {
    if (existingPr) {
      await client.updatePullRequest(existingPr.number, title, body);
    } else {
      const pr = await client.createPullRequest(branch, base, title, body);
      prNumber = pr.number;
      prUrl = pr.html_url;
    }
    if (labels.length > 0 && prNumber) {
      await client.addLabels(prNumber, labels);
    }
  } else if (existingPr) {
    console.log(`No changes; leaving existing pull request #${existingPr.number} as-is.`);
  }

  setOutput("changed", changed);
  setOutput("pull-request-number", prNumber);
  setOutput("pull-request-url", prUrl);
  setOutput("commit-sha", commitSha);
}

// Only auto-run when executed directly (`node create-signed-pr.mjs`), not
// when imported by the test file.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error::${e.message}`);
    process.exit(1);
  });
}

export { GitHubApiError, parseLines, makeClient, readTreeFiles, githubRequest, main };
