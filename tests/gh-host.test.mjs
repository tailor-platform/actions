import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executeFile = promisify(execFile);
// gh sends GH_TOKEN only to github.com and *.ghe.com, and targets github.com unless GH_HOST names
// another host, so a step on GitHub Enterprise Server needs both GH_HOST and GH_ENTERPRISE_TOKEN.
const ghHostExport = 'export GH_HOST="${GITHUB_SERVER_URL#*://}"';
const ghTokenInput = "${{ inputs.github-token }}";
const ghCommandPattern = /(?:^|[\s;&|(])gh\s+[a-z]/;

async function shippedActionFiles() {
  const entries = await fs.readdir(repositoryRoot, { recursive: true });
  return entries
    .filter((entry) => /(^|\/)action\.ya?ml$/.test(entry))
    .filter((entry) => !/^(\.github|node_modules|tests)\//.test(entry))
    .sort();
}

async function ghSteps() {
  const steps = [];
  for (const file of await shippedActionFiles()) {
    const action = parse(await fs.readFile(path.join(repositoryRoot, file), "utf8"));
    for (const step of action.runs?.steps ?? []) {
      if (typeof step.run !== "string") continue;
      const lines = step.run.split("\n").filter((line) => !line.trim().startsWith("#"));
      const firstGhLine = lines.findIndex((line) => ghCommandPattern.test(line));
      if (firstGhLine === -1) continue;
      steps.push({ file, name: step.name ?? step.id, step, lines, firstGhLine });
    }
  }
  return steps;
}

function assertGhTokenEnv(step, label) {
  assert.equal(
    step.env?.GH_TOKEN,
    ghTokenInput,
    `${label} must pass inputs.github-token as GH_TOKEN`,
  );
  assert.equal(
    step.env?.GH_ENTERPRISE_TOKEN,
    ghTokenInput,
    `${label} must pass inputs.github-token as GH_ENTERPRISE_TOKEN`,
  );
}

test("every step that runs gh targets the workflow's own GitHub host", async () => {
  const steps = await ghSteps();
  const files = new Set(steps.map(({ file }) => file));
  for (const known of [
    "_internal/sticky-comment/action.yaml",
    "erd-schema-preview/action.yaml",
    "preview-deploy/action.yaml",
  ]) {
    assert.ok(files.has(known), `expected ${known} to have a step that runs gh`);
  }

  for (const { file, name, step, lines, firstGhLine } of steps) {
    const label = `${file} (${name})`;
    assertGhTokenEnv(step, label);
    const exportLine = lines.findIndex((line) => line.trim() === ghHostExport);
    assert.ok(
      exportLine !== -1 && exportLine < firstGhLine,
      `${label} must run \`${ghHostExport}\` before its first gh command`,
    );
  }
});

test("rejects matching token variables that do not read the github-token input", () => {
  assert.throws(
    () =>
      assertGhTokenEnv(
        {
          env: {
            GH_TOKEN: "${{ inputs.missing-token }}",
            GH_ENTERPRISE_TOKEN: "${{ inputs.missing-token }}",
          },
        },
        "fixture",
      ),
    /inputs\.github-token/,
  );
});

test("GH_HOST is the host of GITHUB_SERVER_URL", async () => {
  for (const [serverUrl, host] of [
    ["https://github.com", "github.com"],
    ["https://ghes.example.com", "ghes.example.com"],
    ["https://octo.ghe.com", "octo.ghe.com"],
  ]) {
    const { stdout } = await executeFile("bash", ["-c", `${ghHostExport}; printf '%s' "$GH_HOST"`], {
      env: { PATH: process.env.PATH, GITHUB_SERVER_URL: serverUrl },
    });
    assert.equal(stdout, host);
  }
});
