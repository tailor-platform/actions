import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findBaseRun } from "./find-base-run.mjs";

describe("findBaseRun", () => {
  test("no runs at all returns empty with a distinct reason", async () => {
    const result = await findBaseRun({
      forkSha: "fork",
      runs: [],
      compareStatus: async () => {
        throw new Error("should not be called");
      },
    });
    assert.equal(result.runId, "");
    assert.match(result.reason, /no successful runs/i);
  });

  test("returns the newest run that is at or before the fork point", async () => {
    const runs = [
      { id: 3, head_sha: "c3" },
      { id: 2, head_sha: "c2" },
      { id: 1, head_sha: "c1" },
    ];
    const compareStatus = async (base) => (base === "c2" || base === "c1" ? "ahead" : "behind");
    const result = await findBaseRun({ forkSha: "fork", runs, compareStatus });
    assert.equal(result.runId, "2");
  });

  test("an exact match (identical) is accepted", async () => {
    const runs = [{ id: 1, head_sha: "fork" }];
    const compareStatus = async (base, head) => (base === head ? "identical" : "behind");
    const result = await findBaseRun({ forkSha: "fork", runs, compareStatus });
    assert.equal(result.runId, "1");
  });

  test("does not fall back to the newest run when every candidate is after the fork point", async () => {
    const runs = [
      { id: 2, head_sha: "c2" },
      { id: 1, head_sha: "c1" },
    ];
    const result = await findBaseRun({
      forkSha: "fork",
      runs,
      compareStatus: async () => "behind",
    });
    assert.equal(result.runId, "");
    assert.match(result.reason, /no run found/i);
  });

  test("a diverged/error compare result is treated as not a match", async () => {
    const runs = [{ id: 1, head_sha: "c1" }];
    const result = await findBaseRun({
      forkSha: "fork",
      runs,
      compareStatus: async () => "diverged",
    });
    assert.equal(result.runId, "");
  });

  test("checks candidates across multiple batches when the first batch has no match", async () => {
    // 11 candidates: batch size is 10, so the 11th run is in a second batch.
    const runs = Array.from({ length: 11 }, (_, i) => ({ id: 11 - i, head_sha: `c${11 - i}` }));
    const compareStatus = async (base) => (base === "c1" ? "ahead" : "behind");
    const result = await findBaseRun({ forkSha: "fork", runs, compareStatus });
    assert.equal(result.runId, "1");
  });
});
