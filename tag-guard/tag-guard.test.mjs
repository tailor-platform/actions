import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executeFile = promisify(execFile);
const action = parse(await fs.readFile(path.join(repositoryRoot, "tag-guard/action.yaml"), "utf8"));
const guardStep = action.runs.steps.find((step) => step.name === "Check tag reachability");

async function runGuardStep(t, env) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "tag-guard-test-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const fakeBin = path.join(fixture, "bin");
  const calls = path.join(fixture, "git-calls");
  await fs.mkdir(fakeBin);
  await fs.writeFile(
    path.join(fakeBin, "git"),
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done >> "${calls}"\necho --- >> "${calls}"\n` +
      `[ "$1" = "rev-parse" ] && echo 0123456789abcdef0123456789abcdef01234567\nexit 0\n`,
    { mode: 0o755 },
  );
  await executeFile("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guardStep.run], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      GITHUB_OUTPUT: path.join(fixture, "output"),
      TARGET_BRANCH: "main",
      ...env,
    },
  });
  const recorded = await fs.readFile(calls, "utf8");
  return recorded
    .split("---\n")
    .filter(Boolean)
    .map((call) => call.split("\n").filter(Boolean));
}

const header = (token) =>
  `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

test("accepts an optional github-token that defaults to empty", () => {
  assert.equal(action.inputs["github-token"].required, false);
  assert.equal(action.inputs["github-token"].default, "");
});

test("authenticates only the target-branch fetch with github-token, without writing it to git config", async (t) => {
  const [fetch] = await runGuardStep(t, { GH_TOKEN: "test-token" });
  assert.deepEqual(fetch.slice(-5), ["-c", header("test-token"), "fetch", "origin", "main"]);
});

test("drops a header the checkout persisted before adding github-token, so the fetch does not send two Authorization headers", async (t) => {
  const [fetch] = await runGuardStep(t, { GH_TOKEN: "test-token" });
  assert.deepEqual(fetch.slice(0, 2), ["-c", "http.https://github.com/.extraheader="]);
});

test("fetches the target branch without extra credentials when no github-token is given", async (t) => {
  const [fetch] = await runGuardStep(t, { GH_TOKEN: "" });
  assert.deepEqual(fetch, ["fetch", "origin", "main"]);
});

test("passes the token to the step through an environment variable rather than inlining it into the script", () => {
  assert.equal(guardStep.env.GH_TOKEN, "${{ inputs.github-token }}");
  assert.doesNotMatch(guardStep.run, /\$\{\{/);
});
