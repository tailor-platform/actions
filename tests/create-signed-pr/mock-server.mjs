#!/usr/bin/env node

// Standalone mock GitHub API used by .github/workflows/test-create-signed-pr.yaml
// to exercise the real composite action (env-to-input mapping, output
// extraction) against a scripted "fresh branch, fresh PR" scenario, without
// touching any real repository. The detailed request-body assertions
// (parents, base64 blob content, force:true, ...) live in
// create-signed-pr.test.mjs's mock-server tests; this only has to prove the
// action.yaml wiring itself works end to end.

import { createServer } from "node:http";

const port = process.env.MOCK_PORT || 8991;
let branchExists = false;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const { method, url } = req;
    const respond = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(json !== undefined ? JSON.stringify(json) : "");
    };

    if (method === "GET" && /\/git\/ref\/heads\/main$/.test(url)) return respond(200, { object: { sha: "base-sha" } });
    if (method === "GET" && /\/git\/commits\/base-sha$/.test(url)) return respond(200, { tree: { sha: "base-tree" } });
    if (method === "POST" && /\/git\/blobs$/.test(url)) return respond(201, { sha: "blob-sha" });
    if (method === "POST" && /\/git\/trees$/.test(url)) return respond(201, { sha: "new-tree" });
    if (method === "POST" && /\/git\/commits$/.test(url)) return respond(201, { sha: "commit-sha" });
    if (method === "GET" && /\/git\/ref\/heads\/test-branch$/.test(url)) {
      return branchExists ? respond(200, { object: { sha: "old-sha" } }) : respond(404, { message: "not found" });
    }
    if (method === "POST" && /\/git\/refs$/.test(url)) {
      branchExists = true;
      return respond(201, {});
    }
    if (method === "PATCH" && /\/git\/refs\/heads\/test-branch$/.test(url)) return respond(200, {});
    if (method === "GET" && /\/pulls\?/.test(url)) return respond(200, []);
    if (method === "POST" && /\/pulls$/.test(url)) {
      return respond(201, { number: 123, html_url: "https://example.invalid/pull/123" });
    }
    if (method === "POST" && /\/labels$/.test(url)) return respond(200, []);
    respond(404, { message: `mock-server: unhandled ${method} ${url}` });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-github listening on 127.0.0.1:${port}`);
});
