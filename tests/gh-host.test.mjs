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
// gh sends GH_TOKEN only to github.com and *.ghe.com, and targets github.com unless GH_HOST names
// another host, so a step on GitHub Enterprise Server needs both GH_HOST and GH_ENTERPRISE_TOKEN.
const ghHostExport = 'export GH_HOST="${GITHUB_SERVER_URL#*://}"';
const ghTokenInput = "${{ inputs.github-token }}";
const ghCommandPattern = /(?:^|[\s;&|(])gh(?:\s|$)/;

function firstGhCommandLine(lines) {
  return lines.findIndex((line) => ghCommandPattern.test(line));
}

async function shippedActionFiles(directory = repositoryRoot) {
  const { stdout } = await executeFile("git", ["ls-files", "-z"], { cwd: directory });
  return stdout
    .split("\0")
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
      const firstGhLine = firstGhCommandLine(lines);
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

test("discovers only action definitions tracked by Git", async (context) => {
  const temporaryRepository = await fs.mkdtemp(path.join(os.tmpdir(), "gh-host-"));
  context.after(() => fs.rm(temporaryRepository, { force: true, recursive: true }));

  await fs.mkdir(path.join(temporaryRepository, "tracked"), { recursive: true });
  await fs.mkdir(path.join(temporaryRepository, ".agent/worktrees/stale"), { recursive: true });
  await fs.writeFile(path.join(temporaryRepository, "tracked/action.yaml"), "runs:\n  steps: []\n");
  await fs.writeFile(
    path.join(temporaryRepository, ".agent/worktrees/stale/action.yaml"),
    "runs:\n  steps: []\n",
  );
  await executeFile("git", ["init", "--quiet"], { cwd: temporaryRepository });
  await executeFile("git", ["add", "tracked/action.yaml"], { cwd: temporaryRepository });

  assert.deepEqual(await shippedActionFiles(temporaryRepository), ["tracked/action.yaml"]);
});

test("detects gh commands with leading options or a continued subcommand", () => {
  for (const script of [
    'gh --repo "$GITHUB_REPOSITORY" api repos/acme/widgets',
    'gh -R "$GITHUB_REPOSITORY" api repos/acme/widgets',
    "gh \\\n  api repos/acme/widgets",
  ]) {
    assert.notEqual(firstGhCommandLine(script.split("\n")), -1, script);
  }
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
