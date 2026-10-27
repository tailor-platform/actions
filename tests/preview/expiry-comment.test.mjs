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

test("preview-comment: declares working-directory as optional and defaulting to the repository root", async () => {
  const action = await loadAction("preview-comment");
  assert.equal(action.inputs["working-directory"].required, false);
  assert.equal(action.inputs["working-directory"].default, ".");
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

const readExpiry = async (context, { env = {}, mock = {} } = {}) => {
  const action = await loadAction("preview-comment");
  const result = await runStep(context, {
    action,
    stepId: "read-expiry",
    env: { WORKSPACE_ID: commentEnv.WORKSPACE_ID, STATUS: "success", ...env },
    mock,
  });
  assert.equal(result.code, 0, result.stderr);
  return result;
};

const outputValue = (output, name) =>
  output
    .split("\n")
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const recorded = "2026-11-03T12:00:00.000Z";
const recordedExpiry = { MOCK_EXPIRES_AT_JSON: JSON.stringify(recorded) };

test("preview-comment: reads the expiry the CLI records for the workspace", async (context) => {
  const result = await readExpiry(context, { mock: recordedExpiry });
  assert.deepEqual(result.calls, [
    ["tailor", "workspace", "get", "--workspace-id", commentEnv.WORKSPACE_ID, "--json"],
  ]);
  assert.equal(outputValue(result.output, "expires-at"), recorded);
});

test("preview-comment: does not call the CLI for a workspace that was cleaned up", async (context) => {
  const result = await readExpiry(context, { env: { STATUS: "deleted" }, mock: recordedExpiry });
  assert.deepEqual(result.calls, []);
  assert.equal(outputValue(result.output, "expires-at"), "");
});

test("preview-comment: reads the expiry of a failed deployment because the workspace still exists", async (context) => {
  const result = await readExpiry(context, { env: { STATUS: "failure" }, mock: recordedExpiry });
  assert.equal(outputValue(result.output, "expires-at"), recorded);
});

for (const [name, json] of [
  ["null for a workspace with no expiry", "null"],
  ["invalid for an expiry the CLI could not decode", '"invalid"'],
  ["unavailable for an expiry the CLI could not read", '"unavailable"'],
  ["a date followed by a second line", JSON.stringify("2026-11-03T12:00:00.000Z\nmalformed")],
  ["a date followed by other text", JSON.stringify("2026-11-03T12:00:00.000Z and more")],
]) {
  test(`preview-comment: gives an empty expiry when the CLI reports ${name}`, async (context) => {
    const result = await readExpiry(context, { mock: { MOCK_EXPIRES_AT_JSON: json } });
    assert.equal(outputValue(result.output, "expires-at"), "");
    assert.doesNotMatch(result.stdout, /::warning::/);
  });
}

test("preview-comment: gives an empty expiry with a warning when reading it fails, without failing the step", async (context) => {
  const result = await readExpiry(context, { mock: { MOCK_GET_STATUS: "1", MOCK_GET_STDERR: "boom" } });
  assert.equal(outputValue(result.output, "expires-at"), "");
  assert.match(result.stdout, /::warning::.*read the expiry/);
});

test("preview-comment: gives an empty expiry with a notice when no tailor runner was set up", async (context) => {
  const result = await readExpiry(context, { env: { TAILOR_RUN: "" }, mock: recordedExpiry });
  assert.deepEqual(result.calls, []);
  assert.equal(outputValue(result.output, "expires-at"), "");
  assert.match(result.stdout, /::notice::/);
});
