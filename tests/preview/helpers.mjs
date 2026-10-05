import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export async function loadAction(name) {
  return parse(await readFile(path.join(repositoryRoot, name, "action.yaml"), "utf8"));
}

export async function runStep(context, { action, stepId, env, comments = [], createdId = "ws-new", mock = {} }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "preview-ttl-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const runner = path.join(directory, "runner.mjs");
  const gh = path.join(directory, "gh");
  const outputFile = path.join(directory, "output");
  const envFile = path.join(directory, "env");
  const callsFile = path.join(directory, "calls");
  await Promise.all([
    writeFile(outputFile, ""),
    writeFile(envFile, ""),
    writeFile(callsFile, ""),
    writeFile(path.join(directory, "comments.json"), JSON.stringify([comments])),
    writeFile(
      gh,
      `#!/usr/bin/env bash\ncat "${path.join(directory, "comments.json")}"\n`,
    ),
    writeFile(
      runner,
      `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_CALLS, JSON.stringify(args) + "\\n");
const failure = (name) => {
  const status = Number(process.env["MOCK_" + name + "_STATUS"] ?? 0);
  if (status === 0) return;
  process.stderr.write(process.env["MOCK_" + name + "_STDERR"] ?? "");
  process.exit(status);
};
if (args[0] === "tailor" && args[1] === "workspace" && args[2] === "create") {
  process.stdout.write(JSON.stringify({ id: process.env.MOCK_CREATED_ID }));
}
if (args[0] === "tailor" && args[1] === "workspace" && args[2] === "get") {
  failure("GET");
  process.stdout.write(JSON.stringify({ id: args[4] }));
}
if (args[0] === "tailor" && args[1] === "workspace" && args[2] === "ttl") failure("TTL_SET");
if (args[0] === "tailor" && args[1] === "workspace" && args[2] === "delete") failure("DELETE");
`,
    ),
  ]);
  await chmod(gh, 0o755);

  const step = action.runs.steps.find((candidate) => candidate.id === stepId);
  assert(step, `step ${stepId} must exist`);
  const result = await execute(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run],
    {
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        HOME: process.env.HOME,
        TAILOR_RUN: `node ${runner}`,
        GITHUB_OUTPUT: outputFile,
        GITHUB_ENV: envFile,
        GITHUB_REPOSITORY: "owner/repo",
        MOCK_CALLS: callsFile,
        MOCK_CREATED_ID: createdId,
        ...mock,
        ...env,
      },
    },
  ).then(
    (value) => ({ ...value, code: 0 }),
    (error) => error,
  );
  const calls = (await readFile(callsFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const output = await readFile(outputFile, "utf8");
  return { ...result, calls, step, output };
}
