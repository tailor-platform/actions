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

async function runDeploy(context, actionName, options = {}) {
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
  config: process.env.TAILOR_PLATFORM_SDK_CONFIG_PATH,
}) + "\\n");
if (args[0] !== "tailor") process.exit(2);
if (args[1] === "deploy") {
  process.stdout.write("Deployment complete (SDK without hook outputs)\\n");
  process.exit(Number(process.env.MOCK_DEPLOY_STATUS));
}
if (args[1] === "show") {
  process.stdout.write(process.env.MOCK_SHOW_JSON);
  process.exit(Number(process.env.MOCK_SHOW_STATUS));
}
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
  let deploySteps;
  if (actionName === "_internal/deploy") {
    deploySteps = action.runs.steps.filter((step) => step.id !== "frontends");
  } else {
    const deployStep = action.runs.steps.find((step) => step.id === "deploy");
    assert.equal(deployStep.with["workspace-id"], frontendStep.env.TAILOR_PLATFORM_WORKSPACE_ID);
    assert.equal(deployStep.with["working-directory"], frontendStep["working-directory"]);
    const match = deployStep.uses.match(/^tailor-platform\/actions\/_internal\/deploy@([a-f0-9]{40})$/);
    assert(match, "public actions must use the SHA-pinned internal deploy action");
    const { stdout } = await execute("git", ["show", `${match[1]}:_internal/deploy/action.yaml`], {
      cwd: repositoryRoot,
    });
    deploySteps = parse(stdout).runs.steps;
  }
  for (const step of deploySteps) {
    assert.equal(step["working-directory"], "${{ inputs.working-directory }}");
    assert.equal(step.env.TAILOR_PLATFORM_WORKSPACE_ID, "${{ inputs.workspace-id }}");
  }
  const script = [...deploySteps, frontendStep].map((step) => step.run).join("\n");
  const result = await execute("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd: project,
    env: {
      ...process.env,
      TAILOR_RUN: `node ${runner}`,
      TAILOR_PLATFORM_WORKSPACE_ID: "workspace-123",
      TAILOR_PLATFORM_SDK_CONFIG_PATH: options.config ?? "tailor.config.ts",
      GITHUB_OUTPUT: outputFile,
      MOCK_CALLS: callsFile,
      MOCK_DEPLOY_STATUS: String(options.deployStatus ?? 0),
      MOCK_SHOW_JSON: JSON.stringify(options.show ?? { url: "https://backend.example.com/query" }),
      MOCK_SHOW_STATUS: String(options.showStatus ?? 0),
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
  return { ...result, action, outputs, output, calls, project: await realpath(project) };
}

for (const actionName of actions) {
  test(`${actionName}: resolves all workspace sites after multi-config deployment`, async (context) => {
    const config = "apps/backend/tailor.config.ts, apps/admin/tailor.config.ts";
    const result = await runDeploy(context, actionName, {
      config,
      websites: [web, { name: "admin", url: "https://admin.example.com" },
        { name: "existing", url: "https://existing.example.com" }],
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), {
      web: web.url,
      admin: "https://admin.example.com",
      existing: "https://existing.example.com",
    });
    assert.equal(result.outputs["app-url"], "https://backend.example.com/query");
    assert.equal(result.action.outputs["frontend-urls"].value, "${{ steps.frontends.outputs.frontend-urls }}");
    assert.equal(result.action.outputs["app-url"].value, actionName === "_internal/deploy"
      ? "${{ steps.show.outputs.app-url }}" : "${{ steps.deploy.outputs.app-url }}");
    assert.deepEqual(result.calls, [
      { args: ["tailor", "deploy", "--yes"], cwd: result.project, workspace: "workspace-123", config },
      { args: ["tailor", "show", "--json"], cwd: result.project, workspace: "workspace-123", config },
      { args: ["tailor", "staticwebsite", "list", "--json"], cwd: result.project, workspace: "workspace-123", config },
    ]);
    assert.match(result.stdout, /SDK without hook outputs/);
  });

  test(`${actionName}: returns {} when the workspace has no sites`, async (context) => {
    const result = await runDeploy(context, actionName);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.outputs["frontend-urls"], "{}");
  });

  test(`${actionName}: writes compact JSON without output injection`, async (context) => {
    const name = 'web\nforged-output=bad"';
    const url = 'https://web.example.com/?x="quoted"&y=1\nother=bad';
    const result = await runDeploy(context, actionName, { websites: [{ name, url }] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.output.trimEnd().split("\n").length, 2);
    assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), { [name]: url });
  });

  for (const [name, options] of [
    ["show fails", { showStatus: 1 }],
    ["show has no URL", { show: {} }],
    ["show URL is null", { show: { url: null } }],
  ]) {
    test(`${actionName}: resolves frontend URLs with empty app-url when ${name}`, async (context) => {
      const result = await runDeploy(context, actionName, { ...options, websites: [web] });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs["app-url"], "");
      assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), { web: web.url });
    });
  }

  test(`${actionName}: does not query URLs after deployment fails`, async (context) => {
    const result = await runDeploy(context, actionName, { deployStatus: 7 });
    assert.equal(result.code, 7);
    assert.equal(result.output, "");
    assert.equal(result.calls.length, 1);
  });

  for (const [name, options] of [
    ["lookup fails", { listStatus: 7 }],
    ["list JSON is invalid", { rawJson: "not JSON" }],
    ["list JSON is empty", { rawJson: "" }],
  ]) {
    test(`${actionName}: fails without frontend-urls when ${name}`, async (context) => {
      const result = await runDeploy(context, actionName, options);
      assert.notEqual(result.code, 0);
      assert.equal(result.outputs["frontend-urls"], undefined);
      assert.equal(result.calls.length, 3);
    });
  }
}

test("public workspace outputs retain their existing sources", async () => {
  const deploy = parse(await readFile(path.join(repositoryRoot, "deploy/action.yaml"), "utf8"));
  const preview = parse(await readFile(path.join(repositoryRoot, "preview-deploy/action.yaml"), "utf8"));
  assert.equal(deploy.outputs["workspace-id"].value, "${{ inputs.workspace-id }}");
  assert.equal(preview.outputs["workspace-id"].value, "${{ steps.workspace.outputs.workspace-id }}");
  assert.equal(preview.outputs["workspace-name"].value, "${{ steps.workspace.outputs.workspace-name }}");
});
