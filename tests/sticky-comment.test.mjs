import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const marker = "<!-- test-marker -->";

const comment = (id, body, type = "Bot") => ({ id, node_id: `node-${id}`, user: { type }, body });

async function loadAction() {
  return parse(await readFile(path.join(repositoryRoot, "_internal/sticky-comment/action.yaml"), "utf8"));
}

async function runPost(context, { comments = [], sticky, hideStatus = 0, postStatus = 0, minimized = [] }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sticky-comment-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const callsFile = path.join(directory, "calls");
  const outputFile = path.join(directory, "output");
  const created = comment(999, `${marker}\nnew body`);
  await Promise.all([
    writeFile(callsFile, ""),
    writeFile(outputFile, ""),
    writeFile(path.join(directory, "before.json"), JSON.stringify([comments])),
    writeFile(path.join(directory, "after.json"), JSON.stringify([[...comments, created]])),
    writeFile(
      path.join(directory, "gh"),
      `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const stdin = args.includes("--input") ? readFileSync(0, "utf8") : "";
appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ args, stdin }) + "\\n");
const posted = process.env.MOCK_CALLS + ".posted";
if (args[1] === "graphql") {
  const query = args.join(" ");
  if (query.includes("minimizeComment")) process.exit(Number(process.env.MOCK_HIDE_STATUS));
  const minimized = process.env.MOCK_MINIMIZED.split(",");
  const ids = [...query.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const nodes = ids.map((id) => ({ id, isMinimized: minimized.includes(id) }));
  process.stdout.write(JSON.stringify({ data: { nodes } }));
} else if (args.includes("--slurp")) {
  process.stdout.write(readFileSync(existsSync(posted) ? process.env.MOCK_AFTER : process.env.MOCK_BEFORE, "utf8"));
} else if (args.includes("POST")) {
  if (Number(process.env.MOCK_POST_STATUS) !== 0) process.exit(Number(process.env.MOCK_POST_STATUS));
  writeFileSync(posted, "");
  process.stdout.write(JSON.stringify({ id: 999 }));
}
`,
    ),
  ]);
  await chmod(path.join(directory, "gh"), 0o755);

  const action = await loadAction();
  const step = action.runs.steps.find((candidate) => candidate.id === "post");
  const result = await execute("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      HOME: process.env.HOME,
      GITHUB_OUTPUT: outputFile,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_SERVER_URL: "https://github.com",
      MARKER_PREFIX: marker,
      BODY: `${marker}\nnew body`,
      PR_NUMBER: "42",
      MOCK_CALLS: callsFile,
      MOCK_BEFORE: path.join(directory, "before.json"),
      MOCK_AFTER: path.join(directory, "after.json"),
      MOCK_HIDE_STATUS: String(hideStatus),
      MOCK_POST_STATUS: String(postStatus),
      MOCK_MINIMIZED: minimized.join(","),
      ...(sticky === undefined ? {} : { STICKY: sticky }),
    },
  }).then(
    (value) => ({ ...value, code: 0 }),
    (error) => error,
  );
  const calls = (await readFile(callsFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { ...result, calls, output: await readFile(outputFile, "utf8") };
}

const kinds = (calls) =>
  calls.map(({ args }) => {
    if (args.includes("--slurp")) return "list";
    if (args[1] === "graphql") return args.join(" ").includes("minimizeComment") ? "hide" : "query";
    return args.includes("PATCH") ? "patch" : "post";
  });

const hiddenNodes = (calls) =>
  calls
    .filter(({ args }) => args[1] === "graphql" && args.join(" ").includes("minimizeComment"))
    .map(({ args }) => args.find((arg) => arg.startsWith("id=")).slice(3));

test("sticky-comment: sticky input defaults to off", async () => {
  const action = await loadAction();
  assert.equal(action.inputs.sticky.default, "false");
});

test("sticky-comment: off posts a new comment and hides nothing when no earlier comment carries the marker", async (context) => {
  const result = await runPost(context, { comments: [comment(1, "unrelated")] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "post", "list"]);
  assert.match(result.output, /comment-id=999/);
});

test("sticky-comment: off posts first, then hides every earlier visible bot comment with the marker as outdated", async (context) => {
  const result = await runPost(context, {
    comments: [
      comment(1, `${marker}\nfirst`),
      comment(2, "unrelated"),
      comment(3, `${marker}\nsecond`),
      comment(4, `${marker}\nby a person`, "User"),
    ],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "post", "list", "query", "hide", "hide"]);
  assert.deepEqual(hiddenNodes(result.calls), ["node-1", "node-3"]);
  const mutation = result.calls.find(({ args }) => args.join(" ").includes("minimizeComment")).args.join(" ");
  assert.match(mutation, /OUTDATED/);
});

test("sticky-comment: off does not hide a comment that is already hidden", async (context) => {
  const result = await runPost(context, {
    comments: [comment(1, `${marker}\nfirst`), comment(3, `${marker}\nsecond`)],
    minimized: ["node-1"],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(hiddenNodes(result.calls), ["node-3"]);
});

test("sticky-comment: off does not hide a comment newer than the one it posted", async (context) => {
  const result = await runPost(context, { comments: [comment(1, `${marker}\nfirst`), comment(1000, `${marker}\nconcurrent`)] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(hiddenNodes(result.calls), ["node-1"]);
});

test("sticky-comment: off hides nothing when posting fails, so the earlier comment stays visible", async (context) => {
  const result = await runPost(context, { comments: [comment(1, `${marker}\nfirst`)], postStatus: 1 });
  assert.notEqual(result.code, 0);
  assert.deepEqual(kinds(result.calls), ["list", "post"]);
});

test("sticky-comment: off still succeeds with a warning when hiding fails", async (context) => {
  const result = await runPost(context, { comments: [comment(1, `${marker}\nfirst`)], hideStatus: 1 });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /::warning::/);
  assert.match(result.output, /comment-id=999/);
});

test("sticky-comment: off reports the newest earlier comment as existing-body", async (context) => {
  const result = await runPost(context, {
    comments: [comment(1, `${marker}\nfirst`), comment(3, `${marker}\nsecond`)],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.output, /existing-body<<.*\n<!-- test-marker -->\nsecond\n/s);
});

test("sticky-comment: on updates the newest earlier comment in place without hiding or posting", async (context) => {
  const result = await runPost(context, {
    comments: [comment(1, `${marker}\nfirst`), comment(3, `${marker}\nsecond`)],
    sticky: "true",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "patch"]);
  assert.match(result.calls[1].args.join(" "), /comments\/3 /);
  assert.match(result.output, /comment-id=3/);
  assert.match(result.output, /existing-body<<.*\n<!-- test-marker -->\nsecond\n/s);
});

test("sticky-comment: on posts a new comment when none carries the marker", async (context) => {
  const result = await runPost(context, { comments: [], sticky: "true" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "post"]);
});
