import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseLines, readTreeFiles, main } from "./create-signed-pr.mjs";

describe("parseLines", () => {
  test("splits on newlines, trims, and drops empty lines", () => {
    assert.deepEqual(parseLines("a\n  b  \n\nc\n"), ["a", "b", "c"]);
  });

  test("returns an empty array for undefined/empty input", () => {
    assert.deepEqual(parseLines(undefined), []);
    assert.deepEqual(parseLines(""), []);
  });
});

describe("readTreeFiles", () => {
  let workspace;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "create-signed-pr-files-"));
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "a.txt"), "hello");
    writeFileSync(join(workspace, "sub", "b.txt"), "world");
  });

  after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test("reads each listed path's content relative to the workspace", () => {
    const files = readTreeFiles({ paths: ["a.txt", "sub/b.txt"], workspace });
    assert.equal(files.length, 2);
    assert.equal(files[0].path, "a.txt");
    assert.equal(files[0].content.toString("utf8"), "hello");
    assert.equal(files[1].path, "sub/b.txt");
    assert.equal(files[1].content.toString("utf8"), "world");
    assert.equal(files[0].mode, "100644");
    assert.equal(files[0].type, "blob");
  });

  test("throws when a listed path doesn't exist locally", () => {
    assert.throws(() => readTreeFiles({ paths: ["missing.txt"], workspace }), /does not exist locally/);
  });
});

/**
 * A minimal mock GitHub API server. `responder(entry)` receives
 * `{method, url, body}` for each request and returns `{status, json}`;
 * every request is also appended to the returned `requests` array so tests
 * can assert on exact call sequence and bodies.
 */
function startMockGitHub(responder) {
  const requests = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : undefined;
        const entry = { method: req.method, url: req.url, body };
        requests.push(entry);
        const result = responder(entry) ?? { status: 404, json: { message: "not found" } };
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(result.json !== undefined ? JSON.stringify(result.json) : "");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe("main() against a mock GitHub API", () => {
  let workspace;
  let outputFile;

  before(() => {
    workspace = mkdtempSync(join(tmpdir(), "create-signed-pr-e2e-"));
    writeFileSync(join(workspace, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nfixed: true\n");
  });

  after(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const runMain = async (server, env) => {
    outputFile = join(workspace, `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(outputFile, "");
    const originalEnv = { ...process.env };
    Object.assign(process.env, {
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_WORKSPACE: workspace,
      GITHUB_API_URL: server.url,
      GITHUB_OUTPUT: outputFile,
      TOKEN: "test-token",
      PATHS: "pnpm-lock.yaml",
      BRANCH: "fix-branch",
      BASE: "main",
      COMMIT_MESSAGE: "fix(deps): automated fix",
      TITLE: "fix(deps): automated fix",
      BODY: "",
      LABELS: "",
      ...env,
    });
    try {
      await main();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key];
      }
      Object.assign(process.env, originalEnv);
    }
    const outputs = {};
    for (const line of readFileSync(outputFile, "utf8").split("\n")) {
      const m = line.match(/^([A-Za-z0-9_-]+)=(.*)$/);
      if (m) outputs[m[1]] = m[2];
    }
    return outputs;
  };

  test("fresh branch, fresh PR: creates blob/tree/commit, creates the ref, creates the PR, adds labels", async () => {
    const server = await startMockGitHub((entry) => {
      const { method, url, body } = entry;
      if (method === "GET" && url === "/repos/acme/widgets/git/ref/heads/main") {
        return { status: 200, json: { object: { sha: "base-sha-1" } } };
      }
      if (method === "GET" && url === "/repos/acme/widgets/git/commits/base-sha-1") {
        return { status: 200, json: { tree: { sha: "base-tree-1" } } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/blobs") {
        return { status: 201, json: { sha: "blob-sha-1" } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/trees") {
        return { status: 201, json: { sha: "new-tree-1" } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/commits") {
        return { status: 201, json: { sha: "commit-sha-1" } };
      }
      if (method === "GET" && url === "/repos/acme/widgets/git/ref/heads/fix-branch") {
        return { status: 404, json: { message: "not found" } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/refs") {
        return { status: 201, json: {} };
      }
      if (method === "GET" && url.startsWith("/repos/acme/widgets/pulls?")) {
        return { status: 200, json: [] };
      }
      if (method === "POST" && url === "/repos/acme/widgets/pulls") {
        return { status: 201, json: { number: 42, html_url: "https://github.com/acme/widgets/pull/42" } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/issues/42/labels") {
        return { status: 200, json: [] };
      }
      return null;
    });

    try {
      const outputs = await runMain(server, { LABELS: "security\nskip-changeset" });

      assert.equal(outputs.changed, "true");
      assert.equal(outputs["pull-request-number"], "42");
      assert.equal(outputs["pull-request-url"], "https://github.com/acme/widgets/pull/42");
      assert.equal(outputs["commit-sha"], "commit-sha-1");

      const blobReq = server.requests.find((r) => r.url === "/repos/acme/widgets/git/blobs");
      assert.equal(blobReq.body.encoding, "base64");
      assert.equal(Buffer.from(blobReq.body.content, "base64").toString("utf8"), "lockfileVersion: '9.0'\nfixed: true\n");

      const treeReq = server.requests.find((r) => r.url === "/repos/acme/widgets/git/trees");
      assert.equal(treeReq.body.base_tree, "base-tree-1");
      assert.deepEqual(treeReq.body.tree, [{ path: "pnpm-lock.yaml", mode: "100644", type: "blob", sha: "blob-sha-1" }]);

      const commitReq = server.requests.find((r) => r.url === "/repos/acme/widgets/git/commits");
      assert.equal(commitReq.body.tree, "new-tree-1");
      assert.deepEqual(commitReq.body.parents, ["base-sha-1"]);
      assert.equal("author" in commitReq.body, false, "must not set a custom author — that risks dropping Verified status");
      assert.equal("committer" in commitReq.body, false);

      const refCreateReq = server.requests.find((r) => r.method === "POST" && r.url === "/repos/acme/widgets/git/refs");
      assert.equal(refCreateReq.body.ref, "refs/heads/fix-branch");
      assert.equal(refCreateReq.body.sha, "commit-sha-1");
      assert.equal(
        server.requests.some((r) => r.method === "PATCH" && r.url.includes("/git/refs/")),
        false,
        "a brand-new branch must be created (POST), not force-moved (PATCH)",
      );

      const pullsLookup = server.requests.find((r) => r.method === "GET" && r.url.startsWith("/repos/acme/widgets/pulls?"));
      assert.match(pullsLookup.url, /head=acme%3Afix-branch/);
      assert.match(pullsLookup.url, /base=main/);
      assert.match(pullsLookup.url, /state=open/);

      const labelsReq = server.requests.find((r) => r.url === "/repos/acme/widgets/issues/42/labels");
      assert.deepEqual(labelsReq.body.labels, ["security", "skip-changeset"]);
    } finally {
      await server.close();
    }
  });

  test("existing branch, existing PR: force-moves the ref and updates the PR, without touching labels", async () => {
    const server = await startMockGitHub((entry) => {
      const { method, url } = entry;
      if (method === "GET" && url === "/repos/acme/widgets/git/ref/heads/main") {
        return { status: 200, json: { object: { sha: "base-sha-2" } } };
      }
      if (method === "GET" && url === "/repos/acme/widgets/git/commits/base-sha-2") {
        return { status: 200, json: { tree: { sha: "base-tree-2" } } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/blobs") {
        return { status: 201, json: { sha: "blob-sha-2" } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/trees") {
        return { status: 201, json: { sha: "new-tree-2" } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/commits") {
        return { status: 201, json: { sha: "commit-sha-2" } };
      }
      if (method === "GET" && url === "/repos/acme/widgets/git/ref/heads/fix-branch") {
        return { status: 200, json: { object: { sha: "old-branch-sha" } } };
      }
      if (method === "PATCH" && url === "/repos/acme/widgets/git/refs/heads/fix-branch") {
        return { status: 200, json: {} };
      }
      if (method === "GET" && url.startsWith("/repos/acme/widgets/pulls?")) {
        return { status: 200, json: [{ number: 7, html_url: "https://github.com/acme/widgets/pull/7" }] };
      }
      if (method === "PATCH" && url === "/repos/acme/widgets/pulls/7") {
        return { status: 200, json: {} };
      }
      return null;
    });

    try {
      const outputs = await runMain(server, {});

      assert.equal(outputs.changed, "true");
      assert.equal(outputs["pull-request-number"], "7");
      assert.equal(outputs["commit-sha"], "commit-sha-2");

      const refMoveReq = server.requests.find((r) => r.method === "PATCH" && r.url === "/repos/acme/widgets/git/refs/heads/fix-branch");
      assert.equal(refMoveReq.body.sha, "commit-sha-2");
      assert.equal(refMoveReq.body.force, true);
      assert.equal(
        server.requests.some((r) => r.method === "POST" && r.url === "/repos/acme/widgets/git/refs"),
        false,
        "an existing branch must be force-moved (PATCH), not created (POST)",
      );
      assert.equal(
        server.requests.some((r) => r.method === "POST" && r.url === "/repos/acme/widgets/pulls"),
        false,
        "an existing PR must be updated (PATCH), not created (POST)",
      );
      assert.equal(
        server.requests.some((r) => r.url.includes("/labels")),
        false,
        "no labels input was given, so no labels call should happen",
      );
    } finally {
      await server.close();
    }
  });

  test("no-op (tree matches base): no commit, no ref move, no PR create — but an existing PR's number is still reported", async () => {
    const server = await startMockGitHub((entry) => {
      const { method, url } = entry;
      if (method === "GET" && url === "/repos/acme/widgets/git/ref/heads/main") {
        return { status: 200, json: { object: { sha: "base-sha-3" } } };
      }
      if (method === "GET" && url === "/repos/acme/widgets/git/commits/base-sha-3") {
        return { status: 200, json: { tree: { sha: "base-tree-3" } } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/blobs") {
        return { status: 201, json: { sha: "blob-sha-3" } };
      }
      if (method === "POST" && url === "/repos/acme/widgets/git/trees") {
        // Identical to the base tree sha => nothing actually changed.
        return { status: 201, json: { sha: "base-tree-3" } };
      }
      if (method === "GET" && url.startsWith("/repos/acme/widgets/pulls?")) {
        return { status: 200, json: [{ number: 9, html_url: "https://github.com/acme/widgets/pull/9" }] };
      }
      return null;
    });

    try {
      const outputs = await runMain(server, {});

      assert.equal(outputs.changed, "false");
      assert.equal(outputs["commit-sha"], "");
      assert.equal(outputs["pull-request-number"], "9", "an existing PR's number is still reported even when nothing changed");

      assert.equal(
        server.requests.some((r) => r.url === "/repos/acme/widgets/git/commits" && r.method === "POST"),
        false,
        "no commit should be created when the tree is unchanged",
      );
      assert.equal(
        server.requests.some((r) => r.url.includes("/git/refs")),
        false,
        "no ref should be created or moved when the tree is unchanged",
      );
      assert.equal(
        server.requests.some((r) => r.url === "/repos/acme/widgets/pulls/9" && r.method === "PATCH"),
        false,
        "an existing PR must be left untouched when nothing changed, not updated",
      );
    } finally {
      await server.close();
    }
  });

  test("throws with the API's response body on an error, instead of a generic failure", async () => {
    const server = await startMockGitHub((entry) => {
      if (entry.method === "GET" && entry.url === "/repos/acme/widgets/git/ref/heads/main") {
        return { status: 500, json: { message: "internal server error from the mock" } };
      }
      return null;
    });

    try {
      await assert.rejects(runMain(server, {}), /internal server error from the mock/);
    } finally {
      await server.close();
    }
  });
});
