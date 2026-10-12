import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { findBaseRun } from "./find-base-run.mjs";

const runScript = (script, env) =>
  promisify(execFile)(process.execPath, [script], { env: { PATH: process.env.PATH, ...env }, timeout: 10000 });

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

describe("find-base-run.mjs as a script", () => {
  test("calls the runs and compare APIs under GITHUB_API_URL, as on GitHub Enterprise Server", async () => {
    const requests = [];
    const server = createServer((req, res) => {
      const { pathname } = new URL(req.url, "http://localhost");
      requests.push(pathname);
      const json = (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (pathname === "/api/v3/repos/acme/widgets/actions/workflows/erd.yml/runs") {
        return json({ workflow_runs: [{ id: 42, head_sha: "run-sha" }] });
      }
      if (pathname === "/api/v3/repos/acme/widgets/compare/run-sha...fork-sha") {
        return json({ status: "ahead" });
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dir = mkdtempSync(join(tmpdir(), "find-base-run-main-"));
    const outputFile = join(dir, "output");
    writeFileSync(outputFile, "");
    try {
      await runScript(fileURLToPath(new URL("./find-base-run.mjs", import.meta.url)), {
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}/api/v3`,
        GH_TOKEN: "test-token",
        GITHUB_REPOSITORY: "acme/widgets",
        WORKFLOW_FILE: "erd.yml",
        BASE_REF: "main",
        FORK_SHA: "fork-sha",
        GITHUB_OUTPUT: outputFile,
      });
      assert.deepEqual(requests, [
        "/api/v3/repos/acme/widgets/actions/workflows/erd.yml/runs",
        "/api/v3/repos/acme/widgets/compare/run-sha...fork-sha",
      ]);
      assert.equal(readFileSync(outputFile, "utf8"), "run-id=42\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
