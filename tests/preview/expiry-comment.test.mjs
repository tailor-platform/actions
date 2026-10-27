import assert from "node:assert/strict";
import test from "node:test";
import { loadAction, runStep } from "./helpers.mjs";

const commentEnv = {
  WORKSPACE_ID: "0a1b2c3d-0000-4000-8000-000000000000",
  WORKSPACE_NAME: "my-app-pr-42",
  STATUS: "success",
  APP_URL: "https://app.example.com",
  MENTION_ENABLED: "",
  PR_NUMBER: "42",
  PR_HEAD_SHA: "deadbeef",
  RUN_URL: "https://github.com/owner/repo/actions/runs/1",
  EXPIRES_ROW: "",
};

const expiresRow = "| Expires | 2026-10-27 12:00 UTC |";

const buildComment = async (context, env) => {
  const action = await loadAction("preview-comment");
  const result = await runStep(context, {
    action,
    stepId: "build",
    env: { ...commentEnv, ...env },
  });
  assert.equal(result.code, 0, result.stderr);
  return result;
};

test("preview-comment: declares expires-at as optional with no default expiry", async () => {
  const action = await loadAction("preview-comment");
  assert.equal(action.inputs["expires-at"].required, false);
  assert.equal(action.inputs["expires-at"].default, "");
});

test("preview-comment: declares timezones as optional and defaulting to UTC", async () => {
  const action = await loadAction("preview-comment");
  assert.equal(action.inputs.timezones.required, false);
  assert.equal(action.inputs.timezones.default, "UTC");
});

test("preview-comment: shows no Expires row when the expiry step gave none", async (context) => {
  const { output } = await buildComment(context, {});
  assert.doesNotMatch(output, /\| Expires \|/);
});

test("preview-comment: adds the row the expiry step gave as the last row of the table", async (context) => {
  const { output } = await buildComment(context, { EXPIRES_ROW: expiresRow });
  const rows = output.split("\n").filter((line) => line.startsWith("| "));
  assert.equal(rows.at(-1), expiresRow);
});

test("preview-comment: keeps the Workspace ID, Status and App URL rows", async (context) => {
  const { output } = await buildComment(context, { EXPIRES_ROW: expiresRow });
  assert.match(output, /\| Workspace ID \| `0a1b2c3d-0000-4000-8000-000000000000` \|/);
  assert.match(output, /\| Status \| ✅ Deployed \|/);
  assert.match(output, /\| App URL \| <https:\/\/app\.example\.com> \|/);
});

const deployEnv = {
  NAME_PREFIX: "my-app",
  REGION: "us-west",
  ORG_ID: "",
  FOLDER_ID: "",
  TTL: "",
  PR_NUMBER: "42",
};

const existingComment = {
  user: { type: "Bot" },
  body: "<!-- tailor-preview: my-app-pr-42 id=0a1b2c3d-0000-4000-8000-000000000000 -->",
};

const outputValue = (output, name) =>
  output
    .split("\n")
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const recorded = "2026-11-03T12:00:00.000Z";
const recordedExpiry = { MOCK_EXPIRES_AT_JSON: JSON.stringify(recorded) };

const deploy = async (context, { env = {}, comments = [], mock = {} } = {}) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, ...env },
    comments,
    mock,
  });
  assert.equal(result.code, 0, result.stderr);
  return result;
};

const subcommand = (call) => call.slice(1, 3).join(" ");

test("preview-deploy: declares the expires-at output", async () => {
  const action = await loadAction("preview-deploy");
  assert.equal(
    action.outputs["expires-at"].value,
    "${{ steps.workspace.outputs.expires-at }}",
  );
});

test("preview-deploy: outputs the expiry the CLI reports for a new workspace", async (context) => {
  const result = await deploy(context, { env: { TTL: "7d" }, mock: recordedExpiry });
  assert.equal(outputValue(result.output, "expires-at"), recorded);
});

test("preview-deploy: reads the expiry back after create, not before", async (context) => {
  const result = await deploy(context, { env: { TTL: "7d" }, mock: recordedExpiry });
  const subcommands = result.calls.map(subcommand);
  assert(subcommands.lastIndexOf("workspace get") > subcommands.indexOf("workspace create"), subcommands.join(","));
});

test("preview-deploy: outputs the expiry the CLI reports once ttl set has extended a reused workspace", async (context) => {
  const result = await deploy(context, { env: { TTL: "7d" }, comments: [existingComment], mock: recordedExpiry });
  const subcommands = result.calls.map(subcommand);
  assert(subcommands.lastIndexOf("workspace get") > subcommands.indexOf("workspace ttl"), subcommands.join(","));
  assert.equal(outputValue(result.output, "expires-at"), recorded);
});

test("preview-deploy: still outputs the expiry a reused workspace already records when extending it fails", async (context) => {
  const result = await deploy(context, {
    env: { TTL: "7d" },
    comments: [existingComment],
    mock: { ...recordedExpiry, MOCK_TTL_SET_STATUS: "1", MOCK_TTL_SET_STDERR: "boom" },
  });
  assert.equal(outputValue(result.output, "expires-at"), recorded);
  assert.match(result.stdout, /::warning::.*extend the expiry/);
});

test("preview-deploy: outputs the expiry create left after it could not confirm it and ttl set ran again", async (context) => {
  const result = await deploy(context, {
    env: { TTL: "7d" },
    mock: { ...recordedExpiry, MOCK_CREATE_STATUS: "1", MOCK_CREATE_STDERR: "could not confirm" },
  });
  assert(result.calls.map(subcommand).includes("workspace ttl"));
  assert.equal(outputValue(result.output, "expires-at"), recorded);
});

test("preview-deploy: reports the expiry a workspace records even when ttl is empty", async (context) => {
  const result = await deploy(context, { comments: [existingComment], mock: recordedExpiry });
  assert.equal(outputValue(result.output, "expires-at"), recorded);
});

for (const [name, json] of [
  ["null for a workspace with no expiry", "null"],
  ["invalid for an expiry the CLI could not decode", '"invalid"'],
  ["unavailable for an expiry the CLI could not read", '"unavailable"'],
]) {
  test(`preview-deploy: outputs an empty expiry when the CLI reports ${name}`, async (context) => {
    const result = await deploy(context, { env: { TTL: "7d" }, mock: { MOCK_EXPIRES_AT_JSON: json } });
    assert.equal(outputValue(result.output, "expires-at"), "");
  });
}

test("preview-deploy: outputs an empty expiry with a warning when reading it back fails, without failing the deploy", async (context) => {
  const result = await deploy(context, {
    env: { TTL: "7d" },
    mock: { MOCK_GET_STATUS: "1", MOCK_GET_STDERR: "boom" },
  });
  assert.equal(outputValue(result.output, "expires-at"), "");
  assert.match(result.stdout, /::warning::.*read the expiry/);
  assert.equal(outputValue(result.output, "workspace-id"), "ws-new");
});
