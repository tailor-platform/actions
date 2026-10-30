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
const action = parse(await fs.readFile(path.join(repositoryRoot, "plan/action.yaml"), "utf8"));
const mergeStep = action.runs.steps.find((step) => step.name === "Merge base branch");
const dryRunStep = action.runs.steps.find((step) => step.name === "Run dry-run");

async function createFixture(t) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  return fixture;
}

function runStep(step, env) {
  return executeFile("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], { env });
}

async function runMergeStep(t, env) {
  const fixture = await createFixture(t);
  const fakeBin = path.join(fixture, "bin");
  const calls = path.join(fixture, "git-calls");
  await fs.mkdir(fakeBin);
  await fs.writeFile(
    path.join(fakeBin, "git"),
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done >> "${calls}"\necho --- >> "${calls}"\n`,
    { mode: 0o755 },
  );
  await runStep(mergeStep, {
    PATH: `${fakeBin}:${process.env.PATH}`,
    GITHUB_SERVER_URL: "https://github.com",
    BASE_REF: "main",
    ...env,
  });
  const recorded = await fs.readFile(calls, "utf8");
  return recorded
    .split("---\n")
    .filter(Boolean)
    .map((call) => call.split("\n").filter(Boolean));
}

async function runDryRunStep(t, { stdout = "", stderr = "", status = 0 }) {
  const fixture = await createFixture(t);
  const runner = path.join(fixture, "run");
  await fs.writeFile(
    runner,
    `#!/bin/sh\nprintf '%s' "$FAKE_STDOUT"\nprintf '%s' "$FAKE_STDERR" >&2\nexit "$FAKE_STATUS"\n`,
    { mode: 0o755 },
  );
  const result = await runStep(dryRunStep, {
    PATH: process.env.PATH,
    TAILOR_RUN: runner,
    GITHUB_OUTPUT: path.join(fixture, "github-output"),
    FAKE_STDOUT: stdout,
    FAKE_STDERR: stderr,
    FAKE_STATUS: String(status),
  });
  return result.stdout;
}

const header = (token) =>
  `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

test("authenticates only the base-branch fetch with github-token, without writing it to git config", async (t) => {
  const [fetch] = await runMergeStep(t, { GH_TOKEN: "test-token" });
  assert.deepEqual(fetch.slice(-5), ["-c", header("test-token"), "fetch", "origin", "main"]);
});

test("drops a header the checkout persisted before adding github-token, so the fetch does not send two Authorization headers", async (t) => {
  const [fetch] = await runMergeStep(t, { GH_TOKEN: "test-token" });
  assert.deepEqual(fetch.slice(0, 2), ["-c", "http.https://github.com/.extraheader="]);
});

test("keeps the header on one line for a token longer than base64's default line width", async (t) => {
  const token = "t".repeat(200);
  const [fetch] = await runMergeStep(t, { GH_TOKEN: token });
  assert.equal(fetch[3], header(token));
});

test("fetches the base branch without extra credentials when no github-token is given", async (t) => {
  const [fetch] = await runMergeStep(t, { GH_TOKEN: "" });
  assert.deepEqual(fetch, ["fetch", "origin", "main"]);
});

test("passes the token to the step through an environment variable rather than inlining it into the script", () => {
  assert.equal(mergeStep.env.GH_TOKEN, "${{ inputs.github-token }}");
  assert.doesNotMatch(mergeStep.run, /\$\{\{/);
});

test("prints the dry-run output, including the CLI's error annotation, to the job log when the dry-run fails", async (t) => {
  const log = await runDryRunStep(t, {
    stderr: [
      'Error [WORKSPACE_NOT_FOUND]: Workspace "ws" was not found.',
      '::error title=WORKSPACE_NOT_FOUND::Workspace "ws" was not found.',
      "",
    ].join("\n"),
    status: 1,
  });
  assert.match(log, /^Error \[WORKSPACE_NOT_FOUND\]: Workspace "ws" was not found\.$/m);
  assert.match(log, /^::error title=WORKSPACE_NOT_FOUND::/m);
});

test("prints the plan to the job log when the dry-run succeeds", async (t) => {
  const log = await runDryRunStep(t, { stdout: "+ TailorDB type: User\n" });
  assert.match(log, /^\+ TailorDB type: User$/m);
});
