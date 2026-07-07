#!/usr/bin/env node
// Finds the most recent run of a given workflow, on a given branch, at or
// before a given commit (the "fork point"). Searches successful runs
// newest-first, bounded by RETENTION_DAYS (the artifacts those runs
// produced typically expire on the same schedule — a run older than that
// has nothing left to download regardless) and by MAX_CANDIDATE_RUNS as a
// secondary safety cap. Returns no match (rather than falling back to the
// latest run) when nothing at-or-before the fork point is found among the
// checked candidates — a later run could include changes merged into the
// branch after the fork point, which is the exact mismatch this search
// exists to avoid; callers should treat an empty run-id as "no usable base"
// and degrade accordingly, not as an error.
import { appendFileSync } from "node:fs";

export const DEFAULT_MAX_CANDIDATE_RUNS = 1000;
export const DEFAULT_RETENTION_DAYS = 90;
const COMPARE_BATCH_SIZE = 10;

/**
 * @param {object} params
 * @param {string} params.forkSha
 * @param {{ id: number, head_sha: string }[]} params.runs - newest-first, already bounded
 * @param {(base: string, head: string) => Promise<string>} params.compareStatus - resolves to a compare `status`, or "diverged" on error
 * @returns {Promise<{ runId: string, reason: string }>}
 */
export async function findBaseRun({ forkSha, runs, compareStatus }) {
  for (let i = 0; i < runs.length; i += COMPARE_BATCH_SIZE) {
    const batch = runs.slice(i, i + COMPARE_BATCH_SIZE);
    // Checked in batches (not all at once) to stay well clear of GitHub's
    // secondary rate limits, and not one at a time so a fork point with no
    // nearby match doesn't serialize hundreds of round trips.
    const statuses = await Promise.all(batch.map((run) => compareStatus(run.head_sha, forkSha)));
    for (let j = 0; j < batch.length; j++) {
      if (statuses[j] === "ahead" || statuses[j] === "identical") {
        return { runId: String(batch[j].id), reason: "Matched at or before the fork point." };
      }
    }
  }

  if (runs.length === 0) {
    return { runId: "", reason: "No successful runs found." };
  }
  return {
    runId: "",
    reason: `No run found at or before fork point ${forkSha} among the checked candidates.`,
  };
}

async function main() {
  const {
    GH_TOKEN,
    GITHUB_REPOSITORY,
    WORKFLOW_FILE,
    BASE_REF,
    FORK_SHA,
    MAX_CANDIDATE_RUNS = String(DEFAULT_MAX_CANDIDATE_RUNS),
    RETENTION_DAYS = String(DEFAULT_RETENTION_DAYS),
    GITHUB_OUTPUT,
  } = process.env;
  const maxCandidateRuns = Number(MAX_CANDIDATE_RUNS);
  if (!Number.isInteger(maxCandidateRuns) || maxCandidateRuns <= 0) {
    throw new Error(`MAX_CANDIDATE_RUNS must be a positive integer, got: "${MAX_CANDIDATE_RUNS}"`);
  }
  const retentionDays = Number(RETENTION_DAYS);
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(`RETENTION_DAYS must be a positive integer, got: "${RETENTION_DAYS}"`);
  }

  function setOutput(name, value) {
    if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
  }

  async function githubApi(path) {
    const res = await fetch(`https://api.github.com/${path}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async function compareStatus(base, head) {
    try {
      const { status } = await githubApi(`repos/${GITHUB_REPOSITORY}/compare/${base}...${head}`);
      return status;
    } catch {
      return "diverged";
    }
  }

  async function listRuns() {
    const since = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const runs = [];
    for (let page = 1; runs.length < maxCandidateRuns; page++) {
      const qs = new URLSearchParams({
        branch: BASE_REF,
        status: "success",
        created: `>=${since}`,
        per_page: "100",
        page: String(page),
      });
      const { workflow_runs } = await githubApi(
        `repos/${GITHUB_REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?${qs}`,
      );
      runs.push(...workflow_runs);
      if (workflow_runs.length < 100) break;
    }
    return runs.slice(0, maxCandidateRuns);
  }

  const runs = await listRuns();
  const { runId, reason } = await findBaseRun({ forkSha: FORK_SHA, runs, compareStatus });
  console.log(reason);
  setOutput("run-id", runId);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
