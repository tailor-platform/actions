import assert from "node:assert/strict";
import test from "node:test";
import { loadAction, runStep } from "./helpers.mjs";

const workspaceId = "0a1b2c3d-0000-4000-8000-000000000000";
const comments = [
  {
    user: { type: "Bot" },
    body: `<!-- tailor-preview: my-app-pr-42 id=${workspaceId} -->`,
  },
];
const deployEnv = {
  NAME_PREFIX: "my-app",
  REGION: "us-west",
  ORG_ID: "",
  FOLDER_ID: "",
  TTL: "7d",
  PR_NUMBER: "42",
};
const notFound = {
  MOCK_GET_STATUS: "1",
  MOCK_GET_STDERR: "[not_found] workspace not found or can not be accessed",
};

const deploy = async (context, options) =>
  runStep(context, {
    action: await loadAction("preview-deploy"),
    stepId: "workspace",
    comments,
    ...options,
    env: { ...deployEnv, ...options.env },
  });

const callsTo = (result, subcommand) =>
  result.calls.filter((args) => args[2] === subcommand);

test("preview-deploy: extends the expiry of the recorded workspace on every push", async (context) => {
  const result = await deploy(context, { env: {} });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(callsTo(result, "ttl"), [
    ["tailor", "workspace", "ttl", "set", "--workspace-id", workspaceId, "--ttl", "7d"],
  ]);
  assert.deepEqual(callsTo(result, "create"), []);
});

test("preview-deploy: leaves the expiry alone when no ttl is configured", async (context) => {
  const result = await deploy(context, { env: { TTL: "" } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(callsTo(result, "ttl"), []);
});

test("preview-deploy: still deploys when extending the expiry fails, and says so", async (context) => {
  const result = await deploy(context, {
    env: {},
    mock: { MOCK_TTL_SET_STATUS: "1", MOCK_TTL_SET_STDERR: "boom" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^::warning::.*expiry/m);
  assert.match(result.output, new RegExp(`workspace-id=${workspaceId}`));
});

test("preview-deploy: creates a new workspace when the recorded one no longer exists", async (context) => {
  const result = await deploy(context, { env: {}, mock: notFound, createdId: "ws-recreated" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^::warning::.*no longer exists/m);
  const [create] = callsTo(result, "create");
  assert.deepEqual(create.slice(0, 7), [
    "tailor",
    "workspace",
    "create",
    "--name",
    "my-app-pr-42",
    "--region",
    "us-west",
  ]);
  assert(create.includes("--ttl"));
  assert.match(result.output, /workspace-id=ws-recreated/);
  assert.deepEqual(callsTo(result, "ttl"), []);
});

test("preview-deploy: fails instead of creating a duplicate when the existence check fails for another reason", async (context) => {
  const result = await deploy(context, {
    env: {},
    mock: { MOCK_GET_STATUS: "1", MOCK_GET_STDERR: "[unauthenticated] token expired" },
  });
  assert.notEqual(result.code, 0);
  assert.deepEqual(callsTo(result, "create"), []);
});

test("preview-cleanup: treats an already pruned workspace as deleted and still reports it for the comment update", async (context) => {
  const result = await runStep(context, {
    action: await loadAction("preview-cleanup"),
    stepId: "delete",
    comments,
    env: { NAME_PREFIX: "my-app", PR_NUMBER: "42" },
    mock: { MOCK_DELETE_STATUS: "1", MOCK_DELETE_STDERR: "[not_found] workspace not found" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^::warning::.*no longer exists/m);
  assert.match(result.output, new RegExp(`workspace-id=${workspaceId}`));
});

test("preview-cleanup: still fails when the deletion fails for another reason", async (context) => {
  const result = await runStep(context, {
    action: await loadAction("preview-cleanup"),
    stepId: "delete",
    comments,
    env: { NAME_PREFIX: "my-app", PR_NUMBER: "42" },
    mock: { MOCK_DELETE_STATUS: "1", MOCK_DELETE_STDERR: "[permission_denied] nope" },
  });
  assert.notEqual(result.code, 0);
});

test("preview-deploy: does not take an unrelated 'not found' for a missing workspace", async (context) => {
  const result = await deploy(context, {
    env: {},
    mock: { MOCK_GET_STATUS: "1", MOCK_GET_STDERR: "[unauthenticated] user not found" },
  });
  assert.notEqual(result.code, 0);
  assert.deepEqual(callsTo(result, "create"), []);
});

test("preview-cleanup: does not take an unrelated 'not found' for an already deleted workspace", async (context) => {
  const result = await runStep(context, {
    action: await loadAction("preview-cleanup"),
    stepId: "delete",
    comments,
    env: { NAME_PREFIX: "my-app", PR_NUMBER: "42" },
    mock: { MOCK_DELETE_STATUS: "1", MOCK_DELETE_STDERR: "[unauthenticated] user not found" },
  });
  assert.notEqual(result.code, 0);
});

test("preview-deploy: keeps the workspace when create prints its ID and then fails to confirm the expiry", async (context) => {
  const result = await deploy(context, {
    env: {},
    comments: [],
    createdId: "ws-partial",
    mock: {
      MOCK_CREATE_STATUS: "1",
      MOCK_CREATE_STDERR: "WORKSPACE_TTL_WRITE_FAILED: --ttl could not be confirmed",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^::warning::.*ws-partial/m);
  assert.match(result.output, /workspace-id=ws-partial/);
  assert.deepEqual(callsTo(result, "ttl"), [
    ["tailor", "workspace", "ttl", "set", "--workspace-id", "ws-partial", "--ttl", "7d"],
  ]);
});

test("preview-deploy: fails when create fails without printing a workspace ID", async (context) => {
  const result = await deploy(context, {
    env: {},
    comments: [],
    createdId: "",
    mock: { MOCK_CREATE_STATUS: "1", MOCK_CREATE_STDERR: "boom" },
  });
  assert.notEqual(result.code, 0);
  assert.doesNotMatch(result.output, /workspace-id=/);
});
