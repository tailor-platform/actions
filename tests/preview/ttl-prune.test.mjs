import assert from "node:assert/strict";
import test from "node:test";
import { loadAction, runStep } from "./helpers.mjs";

const deployEnv = {
  NAME_PREFIX: "my-app",
  REGION: "us-west",
  ORG_ID: "",
  FOLDER_ID: "",
  TTL: "",
  PR_NUMBER: "42",
};

const createCalls = (calls) =>
  calls.filter((args) => args[1] === "workspace" && args[2] === "create");

test("preview-deploy: declares ttl as an optional input that defaults to no expiry", async () => {
  const action = await loadAction("preview-deploy");
  assert.equal(action.inputs.ttl.required, false);
  assert.equal(action.inputs.ttl.default, "");
});

test("preview-deploy: records the expiry when the workspace is created with a ttl", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "7d" },
  });
  assert.equal(result.code, 0, result.stderr);
  const [create] = createCalls(result.calls);
  const index = create.indexOf("--ttl");
  assert.notEqual(index, -1, "--ttl must be passed to workspace create");
  assert.equal(create[index + 1], "7d");
});

test("preview-deploy: creates the workspace without an expiry when ttl is empty", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, { action, stepId: "workspace", env: deployEnv });
  assert.equal(result.code, 0, result.stderr);
  const [create] = createCalls(result.calls);
  assert(create, "workspace create must run");
  assert(!create.includes("--ttl"));
});

const cleanupEnv = {
  NAME_PREFIX: "my-app",
  ORG_ID: "",
  FOLDER_ID: "",
};

const pruneCalls = (calls) =>
  calls.filter((args) => args[1] === "workspace" && args[2] === "prune");

test("preview-cleanup: declares prune-expired as off by default", async () => {
  const action = await loadAction("preview-cleanup");
  assert.equal(action.inputs["prune-expired"].default, "false");
  assert.equal(action.inputs["organization-id"].default, "");
  assert.equal(action.inputs["folder-id"].default, "");
});

test("preview-cleanup: sweeps only when prune-expired is true, even after the deletion step failed", async () => {
  const action = await loadAction("preview-cleanup");
  const steps = action.runs.steps;
  const prune = steps.find((step) => step.id === "prune");
  assert.match(prune.if, /inputs\.prune-expired == 'true'/);
  assert.match(prune.if, /!cancelled\(\)/);
  assert.equal(steps.at(-1), prune, "the sweep must run after the workspace is deleted and the comment updated");
});

test("preview-cleanup: sweeps the folder the previews are created in, limited to this app's PR workspaces", async (context) => {
  const action = await loadAction("preview-cleanup");
  const result = await runStep(context, {
    action,
    stepId: "prune",
    env: { ...cleanupEnv, FOLDER_ID: "folder-1" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(pruneCalls(result.calls), [
    [
      "tailor",
      "workspace",
      "prune",
      "--expired",
      "--yes",
      "--limit",
      "0",
      "--folder-id",
      "folder-1",
      "--name",
      "my-app-pr-[0-9]+",
    ],
  ]);
});

test("preview-cleanup: prefers the folder over the organization, as preview-deploy does when it creates the workspace", async (context) => {
  const action = await loadAction("preview-cleanup");
  const result = await runStep(context, {
    action,
    stepId: "prune",
    env: { ...cleanupEnv, FOLDER_ID: "folder-1", ORG_ID: "org-1" },
  });
  const [prune] = pruneCalls(result.calls);
  assert(prune.includes("--folder-id"));
  assert(!prune.includes("--organization-root"));
});

test("preview-cleanup: sweeps the organization root when no folder is given", async (context) => {
  const action = await loadAction("preview-cleanup");
  const result = await runStep(context, {
    action,
    stepId: "prune",
    env: { ...cleanupEnv, ORG_ID: "org-1" },
  });
  const [prune] = pruneCalls(result.calls);
  const index = prune.indexOf("--organization-root");
  assert.notEqual(index, -1);
  assert.equal(prune[index + 1], "org-1");
  assert(!prune.includes("--folder-id"));
});

test("preview-cleanup: falls back to TAILOR_PLATFORM_ORGANIZATION_ID like preview-deploy", async (context) => {
  const action = await loadAction("preview-cleanup");
  const result = await runStep(context, {
    action,
    stepId: "prune",
    env: { ...cleanupEnv, TAILOR_PLATFORM_ORGANIZATION_ID: "org-from-env" },
  });
  const [prune] = pruneCalls(result.calls);
  assert.equal(prune[prune.indexOf("--organization-root") + 1], "org-from-env");
});

test("preview-cleanup: falls back to TAILOR_PLATFORM_FOLDER_ID like workspace create, and prefers it over the organization", async (context) => {
  const action = await loadAction("preview-cleanup");
  const result = await runStep(context, {
    action,
    stepId: "prune",
    env: {
      ...cleanupEnv,
      ORG_ID: "org-1",
      TAILOR_PLATFORM_FOLDER_ID: "folder-from-env",
    },
  });
  const [prune] = pruneCalls(result.calls);
  assert.equal(prune[prune.indexOf("--folder-id") + 1], "folder-from-env");
  assert(!prune.includes("--organization-root"));
});

test("preview-cleanup: warns and skips the sweep when no location is known, without failing the job", async (context) => {
  const action = await loadAction("preview-cleanup");
  const result = await runStep(context, { action, stepId: "prune", env: cleanupEnv });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^::warning::/m);
  assert.deepEqual(result.calls, []);
});

test("preview-cleanup: matches the prefix literally so other apps' workspaces stay out of the sweep", async (context) => {
  const action = await loadAction("preview-cleanup");
  const result = await runStep(context, {
    action,
    stepId: "prune",
    env: { ...cleanupEnv, NAME_PREFIX: "my.app+1", FOLDER_ID: "folder-1" },
  });
  const [prune] = pruneCalls(result.calls);
  assert.equal(prune[prune.indexOf("--name") + 1], "my\\.app\\+1-pr-[0-9]+");
});
