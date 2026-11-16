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

async function runPost(context, { comments = [], sticky, hideStatus = 0 }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sticky-comment-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const callsFile = path.join(directory, "calls");
  const outputFile = path.join(directory, "output");
  await Promise.all([
    writeFile(callsFile, ""),
    writeFile(outputFile, ""),
    writeFile(path.join(directory, "comments.json"), JSON.stringify([comments])),
    writeFile(
      path.join(directory, "gh"),
      `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const stdin = args.includes("--input") ? readFileSync(0, "utf8") : "";
appendFileSync(process.env.MOCK_CALLS, JSON.stringify({ args, stdin }) + "\\n");
if (args[1] === "graphql") process.exit(Number(process.env.MOCK_HIDE_STATUS));
if (args.includes("--slurp")) process.stdout.write(readFileSync(process.env.MOCK_COMMENTS, "utf8"));
else if (args.includes("POST")) process.stdout.write(JSON.stringify({ id: 999 }));
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
      MOCK_COMMENTS: path.join(directory, "comments.json"),
      MOCK_HIDE_STATUS: String(hideStatus),
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
    if (args[1] === "graphql") return "hide";
    return args.includes("PATCH") ? "patch" : "post";
  });

test("sticky-comment: sticky input defaults to off", async () => {
  const action = await loadAction();
  assert.equal(action.inputs.sticky.default, "false");
});

test("sticky-comment: off posts a new comment when no earlier comment carries the marker", async (context) => {
  const result = await runPost(context, { comments: [comment(1, "unrelated")] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "post"]);
  assert.match(result.output, /comment-id=999/);
});

test("sticky-comment: off hides every earlier comment with the marker as outdated, then posts a new one", async (context) => {
  const result = await runPost(context, {
    comments: [
      comment(1, `${marker}\nfirst`),
      comment(2, "unrelated"),
      comment(3, `${marker}\nsecond`),
      comment(4, `${marker}\nby a person`, "User"),
    ],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "hide", "hide", "post"]);
  const hidden = result.calls.filter(({ args }) => args[1] === "graphql").map(({ args }) => args.join(" "));
  for (const [index, nodeId] of ["node-1", "node-3"].entries()) {
    assert.match(hidden[index], new RegExp(`id=${nodeId}`));
    assert.match(hidden[index], /minimizeComment/);
    assert.match(hidden[index], /OUTDATED/);
  }
});

test("sticky-comment: off still posts the new comment when hiding fails", async (context) => {
  const result = await runPost(context, { comments: [comment(1, `${marker}\nfirst`)], hideStatus: 1 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "hide", "post"]);
  assert.match(result.stdout, /::warning::/);
});

test("sticky-comment: off reports the newest earlier comment as existing-body", async (context) => {
  const result = await runPost(context, {
    comments: [comment(1, `${marker}\nfirst`), comment(3, `${marker}\nsecond`)],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.output, /existing-body<<.*\n<!-- test-marker -->\nsecond\n/s);
});

test("sticky-comment: on updates the earlier comment in place without hiding or posting", async (context) => {
  const result = await runPost(context, { comments: [comment(1, `${marker}\nfirst`)], sticky: "true" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "patch"]);
  assert.match(result.output, /comment-id=1/);
});

test("sticky-comment: on posts a new comment when none carries the marker", async (context) => {
  const result = await runPost(context, { comments: [], sticky: "true" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(kinds(result.calls), ["list", "post"]);
});
