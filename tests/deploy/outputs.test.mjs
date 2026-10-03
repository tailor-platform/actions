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
const frontendHook = (application, frontends) => ({
  application,
  pluginId: "@tailor-platform/frontend",
  outputs: { frontends },
});

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
  process.stderr.write("frontend build log\\n");
  process.stdout.write(process.env.MOCK_DEPLOY_JSON);
  process.exit(Number(process.env.MOCK_DEPLOY_STATUS));
}
if (args[1] === "show") {
  process.stdout.write(process.env.MOCK_SHOW_JSON);
  process.exit(Number(process.env.MOCK_SHOW_STATUS));
}
process.exit(2);
`);

  const actionPath = path.join(repositoryRoot, actionName);
  const action = parse(await readFile(path.join(actionPath, "action.yaml"), "utf8"));
  const step = action.runs.steps.find((step) => step.id === "deploy");
  assert.equal(step["working-directory"], "${{ inputs.working-directory }}");
  assert.equal(step.env.TAILOR_PLATFORM_WORKSPACE_ID, actionName === "preview-deploy"
    ? "${{ steps.workspace.outputs.workspace-id }}"
    : "${{ inputs.workspace-id }}");
  const actionEnv = Object.fromEntries(Object.entries(step.env).map(([name, value]) => [
    name,
    value.replaceAll("${{ github.action_path }}", actionPath)
      .replaceAll("${{ inputs.workspace-id }}", "workspace-123")
      .replaceAll("${{ steps.workspace.outputs.workspace-id }}", "workspace-123"),
  ]));
  const result = await execute("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run], {
    cwd: project,
    env: {
      ...process.env,
      ...actionEnv,
      TAILOR_RUN: `node ${runner}`,
      TAILOR_PLATFORM_SDK_CONFIG_PATH: options.config ?? "tailor.config.ts",
      GITHUB_OUTPUT: outputFile,
      MOCK_CALLS: callsFile,
      MOCK_DEPLOY_JSON: options.rawJson ?? JSON.stringify(options.result ?? { status: "applied" }),
      MOCK_DEPLOY_STATUS: String(options.deployStatus ?? 0),
      MOCK_SHOW_JSON: JSON.stringify(options.show ?? { url: "https://backend.example.com/query" }),
      MOCK_SHOW_STATUS: String(options.showStatus ?? 0),
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
  test(`${actionName}: exposes only frontendPlugin URLs from all configs`, async (context) => {
    const config = "apps/backend/tailor.config.ts, apps/admin/tailor.config.ts";
    const result = await runDeploy(context, actionName, {
      config,
      result: {
        status: "applied",
        deployedHooks: [
          frontendHook("backend", [
            { site: "web", url: "https://web.example.com", skippedFiles: [] },
            { site: "docs", url: "https://docs.example.com" },
          ]),
          { pluginId: "other-plugin", outputs: { frontends: [{ site: "ignored", url: "wrong" }] } },
          frontendHook("admin", [{ site: "admin", url: "https://admin.example.com" }]),
        ],
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), {
      web: "https://web.example.com",
      docs: "https://docs.example.com",
      admin: "https://admin.example.com",
    });
    assert.equal(result.outputs["app-url"], "https://backend.example.com/query");
    assert.equal(result.action.outputs["frontend-urls"].value, "${{ steps.deploy.outputs.frontend-urls }}");
    assert.equal(result.action.outputs["app-url"].value, "${{ steps.deploy.outputs.app-url }}");
    assert.deepEqual(result.calls, [
      { args: ["tailor", "deploy", "--yes", "--json"], cwd: result.project, workspace: "workspace-123", config },
      { args: ["tailor", "show", "--json"], cwd: result.project, workspace: "workspace-123", config },
    ]);
    assert.match(result.stderr, /frontend build log/);
  });

  for (const [name, deployedHooks] of [
    ["older SDK without deployedHooks", undefined],
    ["no hooks", []],
    ["unrelated hooks", [{ pluginId: "other-plugin", outputs: { value: 42 } }]],
    ["empty frontends", [frontendHook("app", [])]],
    ["missing frontend outputs", [{ pluginId: "@tailor-platform/frontend" }]],
  ]) {
    test(`${actionName}: returns {} for ${name}`, async (context) => {
      const result = await runDeploy(context, actionName, { result: { status: "applied", deployedHooks } });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs["frontend-urls"], "{}");
    });
  }

  test(`${actionName}: keeps the last URL for a repeated site`, async (context) => {
    const result = await runDeploy(context, actionName, { result: { deployedHooks: [
      frontendHook("first", [{ site: "web", url: "https://old.example.com" }]),
      frontendHook("last", [{ site: "web", url: "https://new.example.com" }]),
    ] } });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), { web: "https://new.example.com" });
  });

  test(`${actionName}: writes compact JSON without output injection`, async (context) => {
    const site = 'web\nforged-output=bad"';
    const url = 'https://web.example.com/?x="quoted"&y=1\nother=bad';
    const result = await runDeploy(context, actionName, { result: {
      deployedHooks: [frontendHook("app", [{ site, url }])],
    } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.output.trimEnd().split("\n").length, 2);
    assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), { [site]: url });
  });

  for (const [name, options] of [
    ["show fails", { showStatus: 1 }],
    ["show has no URL", { show: {} }],
    ["show URL is null", { show: { url: null } }],
  ]) {
    test(`${actionName}: preserves frontend URLs and empty app-url when ${name}`, async (context) => {
      const result = await runDeploy(context, actionName, {
        ...options,
        result: { deployedHooks: [frontendHook("app", [{ site: "web", url: "https://web.example.com" }])] },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.outputs["app-url"], "");
      assert.deepEqual(JSON.parse(result.outputs["frontend-urls"]), { web: "https://web.example.com" });
    });
  }

  for (const [name, options] of [
    ["deploy or frontend upload fails", { deployStatus: 7 }],
    ["deploy JSON is invalid", { rawJson: "not JSON" }],
    ["deploy JSON is empty", { rawJson: "" }],
  ]) {
    test(`${actionName}: fails without outputs or show when ${name}`, async (context) => {
      const result = await runDeploy(context, actionName, options);
      assert.notEqual(result.code, 0);
      assert.equal(result.output, "");
      assert.equal(result.calls.length, 1);
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
