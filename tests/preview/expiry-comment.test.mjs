import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const secondsFromNow = (iso) => (Date.parse(iso) - Date.now()) / 1000;

test("preview-deploy: declares the expires-at output", async () => {
  const action = await loadAction("preview-deploy");
  assert.equal(
    action.outputs["expires-at"].value,
    "${{ steps.workspace.outputs.expires-at }}",
  );
});

test("preview-deploy: outputs the expiry as UTC ISO 8601, counted from now, for a new workspace", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "7d" },
  });
  assert.equal(result.code, 0, result.stderr);
  const value = outputValue(result.output, "expires-at");
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert(Math.abs(secondsFromNow(value) - 7 * 24 * 3600) < 120, value);
});

for (const [ttl, seconds] of [
  ["45s", 45],
  ["30m", 30 * 60],
  ["24h", 24 * 3600],
  ["010m", 10 * 60],
  ["08h", 8 * 3600],
  ["09d", 9 * 24 * 3600],
]) {
  test(`preview-deploy: reads the ttl unit in ${ttl}`, async (context) => {
    const action = await loadAction("preview-deploy");
    const result = await runStep(context, {
      action,
      stepId: "workspace",
      env: { ...deployEnv, TTL: ttl },
    });
    assert.equal(result.code, 0, result.stderr);
    const value = outputValue(result.output, "expires-at");
    assert(Math.abs(secondsFromNow(value) - seconds) < 120, value);
  });
}

const slowCliMs = 4000;

test("preview-deploy: takes the expiry before ttl set runs, so a slow command does not push it later than the one recorded", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "45s" },
    comments: [existingComment],
    mock: { MOCK_TTL_SET_DELAY_MS: String(slowCliMs) },
  });
  const finishedAt = Date.now();
  assert.equal(result.code, 0, result.stderr);
  const value = outputValue(result.output, "expires-at");
  assert(Date.parse(value) - finishedAt < 45_000 - slowCliMs / 2, value);
});

test("preview-deploy: takes the expiry before create runs, so a slow command does not push it later than the one recorded", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "45s" },
    mock: { MOCK_CREATE_DELAY_MS: String(slowCliMs) },
  });
  const finishedAt = Date.now();
  assert.equal(result.code, 0, result.stderr);
  const value = outputValue(result.output, "expires-at");
  assert(Date.parse(value) - finishedAt < 45_000 - slowCliMs / 2, value);
});

for (const ttl of [
  "7",
  "d",
  "7days",
  "7d ",
  "-7d",
  "7.5h",
  "a[$(MARKER)]d",
  "0+a[$(MARKER)]m",
  "1,a[$(MARKER)]h",
]) {
  test(`preview-deploy: gives no expiry for the invalid ttl ${JSON.stringify(ttl)} and runs nothing hidden in it`, async (context) => {
    const marker = path.join(os.tmpdir(), `expiry-ttl-injected-${process.pid}-${Date.now()}`);
    context.after(() => rm(marker, { force: true }));
    const action = await loadAction("preview-deploy");
    const result = await runStep(context, {
      action,
      stepId: "workspace",
      env: { ...deployEnv, TTL: ttl.replace("MARKER", `touch ${marker}`) },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(marker), false);
    assert.equal(outputValue(result.output, "expires-at"), "");
  });
}

test("preview-deploy: outputs an empty expiry when ttl is empty", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, { action, stepId: "workspace", env: deployEnv });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(outputValue(result.output, "expires-at"), "");
});

test("preview-deploy: outputs the new expiry when it extends the one of a reused workspace", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "7d" },
    comments: [existingComment],
  });
  assert.equal(result.code, 0, result.stderr);
  const value = outputValue(result.output, "expires-at");
  assert(Math.abs(secondsFromNow(value) - 7 * 24 * 3600) < 120, value);
});

test("preview-deploy: outputs an empty expiry when extending a reused workspace fails, since the old one still applies", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "7d" },
    comments: [existingComment],
    mock: { MOCK_TTL_SET_STATUS: "1", MOCK_TTL_SET_STDERR: "boom" },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(outputValue(result.output, "expires-at"), "");
});

test("preview-deploy: outputs the expiry set again after create could not confirm it", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "7d" },
    mock: { MOCK_CREATE_STATUS: "1", MOCK_CREATE_STDERR: "could not confirm" },
  });
  assert.equal(result.code, 0, result.stderr);
  const value = outputValue(result.output, "expires-at");
  assert(Math.abs(secondsFromNow(value) - 7 * 24 * 3600) < 120, value);
});

test("preview-deploy: outputs an empty expiry when create could not confirm it and setting it again fails", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "7d" },
    mock: {
      MOCK_CREATE_STATUS: "1",
      MOCK_CREATE_STDERR: "could not confirm",
      MOCK_TTL_SET_STATUS: "1",
      MOCK_TTL_SET_STDERR: "boom",
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(outputValue(result.output, "expires-at"), "");
});
