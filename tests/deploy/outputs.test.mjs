import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const actions = ["deploy", "preview-deploy", "_internal/deploy"];
const web = { name: "web", url: "https://web.example.com" };

async function runFrontends(context, actionName, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "deploy-outputs-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, "project with spaces");
  await mkdir(project);
  const runner = path.join(directory, "runner.mjs");
  const outputFile = path.join(directory, "output");
  const callsFile = path.join(directory, "calls");
  await writeFile(outputFile, "");
  await writeFile(callsFile, "");
  await writeFile(runner, `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_CALLS, JSON.stringify({
  args,
  cwd: process.cwd(),
  workspace: process.env.TAILOR_PLATFORM_WORKSPACE_ID,
}) + "\\n");
if (args[0] !== "tailor") process.exit(2);
if (args[1] === "staticwebsite" && args[2] === "list") {
  process.stdout.write(process.env.MOCK_WEBSITES_JSON);
  process.exit(Number(process.env.MOCK_LIST_STATUS));
}
process.exit(2);
`);

  const action = parse(await readFile(path.join(repositoryRoot, actionName, "action.yaml"), "utf8"));
  const frontendStep = action.runs.steps.find((step) => step.id === "frontends");
  assert.equal(frontendStep["working-directory"], "${{ inputs.working-directory }}");
  assert.equal(frontendStep.env.TAILOR_PLATFORM_WORKSPACE_ID, actionName === "preview-deploy"
    ? "${{ steps.workspace.outputs.workspace-id }}"
    : "${{ inputs.workspace-id }}");
  assert.equal(action.outputs["frontend-urls"].value, "${{ steps.frontends.outputs.frontend-urls }}");
  assert.equal(frontendStep.shell, "bash");
  const result = await execute("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", frontendStep.run], {
    cwd: project,
    env: {
      ...process.env,
      TAILOR_RUN: `node ${runner}`,
      TAILOR_PLATFORM_WORKSPACE_ID: "workspace-123",
      GITHUB_OUTPUT: outputFile,
      MOCK_CALLS: callsFile,
      MOCK_WEBSITES_JSON: options.rawJson ?? JSON.stringify(options.websites ?? []),
      MOCK_LIST_STATUS: String(options.listStatus ?? 0),
    },
  }).then((result) => ({ ...result, code: 0 }), (error) => error);
  const output = await readFile(outputFile, "utf8");
  const outputs = Object.fromEntries(output.trimEnd().split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const calls = (await readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  return { ...result, outputs, output, calls, project: await realpath(project) };
}

for (const actionName of actions) {
  test(`${actionName}: resolves all workspace sites`, async (context) => {
    const result = await runFrontends(context, actionName, {
      websites: [web, { name: "admin", url: "https://admin.example.com" },
        { name: "existing", url: "https://existing.example.com" }],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), {
      web: web.url,
      admin: "https://admin.example.com",
      existing: "https://existing.example.com",
    });
    assert.deepEqual(result.calls, [
      { args: ["tailor", "staticwebsite", "list", "--json"], cwd: result.project, workspace: "workspace-123" },
    ]);
  });

  test(`${actionName}: returns {} when the workspace has no sites`, async (context) => {
    const result = await runFrontends(context, actionName);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs["frontend-urls"], "{}");
  });

  test(`${actionName}: writes compact JSON without output injection`, async (context) => {
    const name = 'web\nforged-output=bad"';
    const url = 'https://web.example.com/?x="quoted"&y=1\nother=bad';
    const result = await runFrontends(context, actionName, { websites: [{ name, url }] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.output, `frontend-urls=${JSON.stringify({ [name]: url })}\n`);
    assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), { [name]: url });
  });

  for (const [name, options] of [
    ["lookup fails", { listStatus: 7 }],
    ["list JSON is invalid", { rawJson: "not JSON" }],
    ["list JSON is empty", { rawJson: "" }],
  ]) {
    test(`${actionName}: fails without frontend-urls when ${name}`, async (context) => {
      const result = await runFrontends(context, actionName, options);
      assert.notEqual(result.code, 0);
      assert.equal(result.output, "");
      assert.equal(result.calls.length, 1);
    });
  }
}
