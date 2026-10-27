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
  EXPIRES_AT: "",
  TIMEZONES: "UTC",
};

const expiresAt = "2026-10-27T12:00:00Z";

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

const expiresRow = (output) => output.split("\n").find((line) => line.startsWith("| Expires |"));

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

test("preview-comment: shows no Expires row when expires-at is empty", async (context) => {
  const { output } = await buildComment(context, {});
  assert.equal(expiresRow(output), undefined);
});

test("preview-comment: shows the expiry in UTC by default", async (context) => {
  const { output } = await buildComment(context, { EXPIRES_AT: expiresAt });
  assert.equal(expiresRow(output), "| Expires | 2026-10-27 12:00 UTC |");
});

test("preview-comment: shows the expiry once per timezone, in the order given", async (context) => {
  const { output } = await buildComment(context, {
    EXPIRES_AT: expiresAt,
    TIMEZONES: "UTC,Asia/Tokyo,America/Los_Angeles",
  });
  assert.equal(
    expiresRow(output),
    "| Expires | 2026-10-27 12:00 UTC / 2026-10-27 21:00 Asia/Tokyo / 2026-10-27 05:00 America/Los_Angeles |",
  );
});

test("preview-comment: accepts timezones separated by newlines and surrounding spaces", async (context) => {
  const { output } = await buildComment(context, {
    EXPIRES_AT: expiresAt,
    TIMEZONES: " Asia/Tokyo \n UTC ",
  });
  assert.equal(
    expiresRow(output),
    "| Expires | 2026-10-27 21:00 Asia/Tokyo / 2026-10-27 12:00 UTC |",
  );
});

test("preview-comment: carries the date across midnight in a timezone ahead of UTC", async (context) => {
  const { output } = await buildComment(context, {
    EXPIRES_AT: "2026-10-27T20:30:00Z",
    TIMEZONES: "Asia/Tokyo",
  });
  assert.equal(expiresRow(output), "| Expires | 2026-10-28 05:30 Asia/Tokyo |");
});

test("preview-comment: skips an unknown timezone with a warning and keeps the valid ones", async (context) => {
  const { output, stdout } = await buildComment(context, {
    EXPIRES_AT: expiresAt,
    TIMEZONES: "UTC,Mars/Olympus",
  });
  assert.equal(expiresRow(output), "| Expires | 2026-10-27 12:00 UTC |");
  assert.match(stdout, /::warning::.*Mars\/Olympus/);
});

test("preview-comment: falls back to UTC when no timezone is valid", async (context) => {
  const { output, stdout } = await buildComment(context, {
    EXPIRES_AT: expiresAt,
    TIMEZONES: "Mars/Olympus",
  });
  assert.equal(expiresRow(output), "| Expires | 2026-10-27 12:00 UTC |");
  assert.match(stdout, /::warning::.*Mars\/Olympus/);
});

test("preview-comment: falls back to UTC when timezones is empty", async (context) => {
  const { output } = await buildComment(context, { EXPIRES_AT: expiresAt, TIMEZONES: "" });
  assert.equal(expiresRow(output), "| Expires | 2026-10-27 12:00 UTC |");
});

test("preview-comment: rejects a timezone with shell metacharacters without running it", async (context) => {
  const { output, stdout } = await buildComment(context, {
    EXPIRES_AT: expiresAt,
    TIMEZONES: "UTC,$(touch /tmp/pwned)",
  });
  assert.equal(expiresRow(output), "| Expires | 2026-10-27 12:00 UTC |");
  assert.match(stdout, /::warning::/);
});

test("preview-comment: shows no Expires row once the workspace is cleaned up", async (context) => {
  const { output } = await buildComment(context, { EXPIRES_AT: expiresAt, STATUS: "deleted" });
  assert.equal(expiresRow(output), undefined);
});

test("preview-comment: shows the expiry for a failed deployment because the workspace still exists", async (context) => {
  const { output } = await buildComment(context, { EXPIRES_AT: expiresAt, STATUS: "failure" });
  assert.equal(expiresRow(output), "| Expires | 2026-10-27 12:00 UTC |");
});

test("preview-comment: skips a malformed expires-at with a warning instead of failing the step", async (context) => {
  const { output, stdout } = await buildComment(context, { EXPIRES_AT: "next tuesday" });
  assert.equal(expiresRow(output), undefined);
  assert.match(stdout, /::warning::.*next tuesday/);
});

test("preview-comment: keeps the Workspace ID, Status and App URL rows", async (context) => {
  const { output } = await buildComment(context, { EXPIRES_AT: expiresAt });
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
