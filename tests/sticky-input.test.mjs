import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const commentActions = /_internal\/(sticky-comment|erd-comment)@/;
const forwarding = ["plan", "preview-comment", "preview-cleanup", "_internal/erd-comment", "erd-schema-comment"];

const load = async (name) => parse(await readFile(path.join(repositoryRoot, name, "action.yaml"), "utf8"));

for (const name of forwarding) {
  test(`${name}: sticky is off by default and reaches the comment step`, async () => {
    const action = await load(name);
    assert.equal(action.inputs.sticky.default, "false");
    const posting = action.runs.steps.filter((step) => commentActions.test(step.uses ?? ""));
    assert.ok(posting.length > 0, `${name} must call a comment action`);
    for (const step of posting) {
      assert.equal(step.with.sticky, "${{ inputs.sticky }}", step.name);
    }
  });
}

test("callers pin the sticky-comment definition that has the sticky input", async () => {
  const local = await load("_internal/sticky-comment");
  for (const name of forwarding) {
    const action = await load(name);
    for (const step of action.runs.steps.filter((candidate) => /_internal\/sticky-comment@/.test(candidate.uses ?? ""))) {
      const sha = step.uses.split("@")[1];
      assert.match(sha, /^[0-9a-f]{40}$/, `${name} must pin a full commit SHA`);
      const { stdout } = await execute("git", ["show", `${sha}:_internal/sticky-comment/action.yaml`], { cwd: repositoryRoot });
      assert.deepEqual(parse(stdout), local, `${name} must pin the current sticky-comment`);
    }
  }
});
