import assert from "node:assert/strict";
import test from "node:test";
import { loadAction, runStep } from "./helpers.mjs";

const deployEnv = {
  NAME_PREFIX: "my-app",
  REGION: "us-west",
  ORG_ID: "",
  FOLDER_ID: "",
  PR_NUMBER: "42",
};

test("preview-deploy: reuses the workspace recorded in the PR comment instead of creating another", async (context) => {
  const action = await loadAction("preview-deploy");
  const result = await runStep(context, {
    action,
    stepId: "workspace",
    env: { ...deployEnv, TTL: "7d" },
    comments: [
      {
        user: { type: "Bot" },
        body: "<!-- tailor-preview: my-app-pr-42 id=0a1b2c3d-0000-4000-8000-000000000000 -->",
      },
    ],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    result.calls.filter((args) => args[2] === "create"),
    [],
  );
});

test("preview-cleanup: deletes the workspace recorded in the PR comment", async (context) => {
  const action = await loadAction("preview-cleanup");
  const result = await runStep(context, {
    action,
    stepId: "delete",
    env: { NAME_PREFIX: "my-app", PR_NUMBER: "42" },
    comments: [
      {
        user: { type: "Bot" },
        body: "<!-- tailor-preview: my-app-pr-42 id=0a1b2c3d-0000-4000-8000-000000000000 -->",
      },
    ],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls, [
    ["tailor", "workspace", "delete", "--workspace-id", "0a1b2c3d-0000-4000-8000-000000000000", "--yes"],
  ]);
});
