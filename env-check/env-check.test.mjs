import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const action = parse(await fs.readFile(path.join(repositoryRoot, "env-check/action.yaml"), "utf8"));
const checkStep = action.runs.steps.find((step) => step.name === "Check variables and secrets");

const FAKE_CLI = `#!/bin/sh
{
  echo "bin=$(basename "$0")"
  echo "args=$*"
  echo "cwd=$(pwd)"
  echo "client-id=\${TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID-unset}"
  echo "json=\${TAILOR_JSON_OUTPUT-unset}"
} > "$FAKE_CALLS"
echo "# fake setup ci env output"
exit "\${FAKE_STATUS:-0}"
`;

async function runCheck(t, { inputs = {}, values = {}, env = {} } = {}) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "env-check-test-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const fakeBin = path.join(fixture, "bin");
  const workspace = path.join(fixture, "workspace");
  const calls = path.join(fixture, "calls");
  await fs.mkdir(fakeBin);
  await fs.mkdir(workspace);
  for (const name of ["pnpm", "npm", "yarn", "bun"]) {
    await fs.writeFile(path.join(fakeBin, name), FAKE_CLI, { mode: 0o755 });
  }
  const input = (name) => inputs[name] ?? action.inputs[name].default ?? "";
  const result = await new Promise((resolve) => {
    execFile(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", checkStep.run],
      {
        cwd: fixture,
        env: {
          PATH: `${fakeBin}:${process.env.PATH}`,
          GITHUB_WORKSPACE: workspace,
          FAKE_CALLS: calls,
          ENV_CHECK_ENVIRONMENT: input("environment"),
          ENV_CHECK_REQUIRED: input("required"),
          ENV_CHECK_OPTIONAL: input("optional"),
          ENV_CHECK_FAIL_ON_MISSING: input("fail-on-missing"),
          ENV_CHECK_PACKAGE_MANAGER: input("package-manager"),
          ...values,
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
    );
  });
  const recorded = await fs.readFile(calls, "utf8").catch(() => null);
  const call = recorded && Object.fromEntries(recorded.trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)));
  return { ...result, call, workspace };
}

const annotations = (stdout) => stdout.split("\n").filter((line) => line.startsWith("::"));

const CLIENT_ID = "TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID";
const CLIENT_SECRET = "TAILOR_PLATFORM_MACHINE_USER_CLIENT_SECRET";
const WORKSPACE_ID = "TAILOR_PLATFORM_WORKSPACE_ID";
const required = [CLIENT_ID, CLIENT_SECRET, WORKSPACE_ID].join("\n");

test("passes without annotations when every required name is set", async (t) => {
  const result = await runCheck(t, {
    inputs: { environment: "stg", required, "package-manager": "pnpm" },
    values: { [CLIENT_ID]: "true", [CLIENT_SECRET]: "true", [WORKSPACE_ID]: "true" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(annotations(result.stdout), []);
  assert.equal(result.call, null);
});

test("fails with one error naming every empty required name and the commands that register them", async (t) => {
  const result = await runCheck(t, {
    inputs: { environment: "stg", required },
    values: { [CLIENT_ID]: "true", [CLIENT_SECRET]: "false", [WORKSPACE_ID]: "false" },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(annotations(result.stdout), [
    `::error title=Missing GitHub variables or secrets::No value for ${CLIENT_SECRET}, ${WORKSPACE_ID} in GitHub Environment "stg", the repository, or the organization. Run \`tailor setup ci env --check --environment stg\` to list what is missing and print the gh commands that set it, or \`tailor setup ci env --environment stg\` without write access to the repository.`,
  ]);
  assert.equal(result.call, null);
});

test("reports empty required names as a warning without failing when fail-on-missing is false", async (t) => {
  const result = await runCheck(t, {
    inputs: { environment: "stg", required: WORKSPACE_ID, "fail-on-missing": "false" },
    values: { [WORKSPACE_ID]: "false" },
  });

  assert.equal(result.status, 0, result.stderr);
  const [annotation, ...rest] = annotations(result.stdout);
  assert.match(annotation, /^::warning title=Missing GitHub variables or secrets::No value for TAILOR_PLATFORM_WORKSPACE_ID in GitHub Environment "stg"/);
  assert.deepEqual(rest, []);
});

test("logs empty optional names on one plain line without failing", async (t) => {
  const result = await runCheck(t, {
    inputs: { environment: "stg", optional: "TAILOR_SLACK_BOT_TOKEN\nTAILOR_PLATFORM_FOLDER_ID\nTAILOR_SLACK_CHANNEL_ID" },
    values: { TAILOR_SLACK_BOT_TOKEN: "false", TAILOR_PLATFORM_FOLDER_ID: "true", TAILOR_SLACK_CHANNEL_ID: "false" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(annotations(result.stdout), []);
  assert.match(result.stdout, /^Optional, not set: TAILOR_SLACK_BOT_TOKEN, TAILOR_SLACK_CHANNEL_ID$/m);
});

test("ignores blank lines and surrounding whitespace in the name lists", async (t) => {
  const result = await runCheck(t, {
    inputs: { environment: "stg", required: `\n  ${CLIENT_ID}  \n\n${CLIENT_SECRET}\n` },
    values: { [CLIENT_ID]: "true", [CLIENT_SECRET]: "true" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(annotations(result.stdout), []);
});

for (const value of ["", "abc", "TRUE"]) {
  test(`rejects ${JSON.stringify(value)} as a value instead of reading it as set or empty`, async (t) => {
    const result = await runCheck(t, {
      inputs: { environment: "stg", required: CLIENT_ID },
      values: { [CLIENT_ID]: value },
    });

    assert.equal(result.status, 1);
    assert.deepEqual(annotations(result.stdout), [
      `::error::${CLIENT_ID} must be 'true' or 'false' in this step's env, the result of an expression such as secrets.${CLIENT_ID} != ''`,
    ]);
  });
}

test("rejects a listed name missing from the step env", async (t) => {
  const result = await runCheck(t, { inputs: { environment: "stg", optional: CLIENT_ID } });

  assert.equal(result.status, 1);
  assert.match(annotations(result.stdout)[0], /^::error::TAILOR_PLATFORM_MACHINE_USER_CLIENT_ID must be 'true' or 'false'/);
});

for (const name of ["lower_case", "1STARTS_WITH_DIGIT", "HAS-DASH", "ENV_CHECK_EXTRA"]) {
  test(`rejects the name ${name}`, async (t) => {
    const result = await runCheck(t, { inputs: { environment: "stg", required: name }, values: { [name]: "true" } });

    assert.equal(result.status, 1);
    assert.deepEqual(annotations(result.stdout), [`::error::Invalid variable or secret name in required: '${name}'`]);
  });
}

test("rejects a fail-on-missing value other than true or false", async (t) => {
  const result = await runCheck(t, { inputs: { environment: "stg", "fail-on-missing": "yes" } });

  assert.equal(result.status, 1);
  assert.deepEqual(annotations(result.stdout), ["::error::fail-on-missing must be 'true' or 'false' (received 'yes')"]);
});

test("rejects an unsupported package-manager", async (t) => {
  const result = await runCheck(t, {
    inputs: { environment: "stg", required: CLIENT_ID, "package-manager": "deno" },
    values: { [CLIENT_ID]: "false" },
  });

  assert.equal(result.status, 1);
  assert.deepEqual(annotations(result.stdout), [
    "::error::Unsupported package-manager 'deno' (expected pnpm, npm, yarn, or bun)",
  ]);
});

for (const [packageManager, bin, args] of [
  ["pnpm", "pnpm", "exec tailor setup ci env --environment stg"],
  ["yarn", "yarn", "tailor setup ci env --environment stg"],
  ["npm", "npm", "exec --no -- tailor setup ci env --environment stg"],
  ["bun", "bun", "run tailor setup ci env --environment stg"],
]) {
  test(`prints tailor setup ci env through ${packageManager} from the workspace root when a required name is empty`, async (t) => {
    const result = await runCheck(t, {
      inputs: { environment: "stg", required: `${CLIENT_ID}\n${CLIENT_SECRET}`, "package-manager": packageManager },
      values: { [CLIENT_ID]: "true", [CLIENT_SECRET]: "false" },
      env: { TAILOR_JSON_OUTPUT: "1" },
    });

    assert.equal(result.status, 1);
    assert.deepEqual(result.call, {
      bin,
      args,
      cwd: result.workspace,
      "client-id": "unset",
      json: "unset",
    });
    assert.match(
      result.stdout,
      /^::group::tailor setup ci env --environment stg\n# fake setup ci env output\n::endgroup::$/m,
    );
    assert.match(
      annotations(result.stdout).find((line) => line.startsWith("::error title=")),
      / This step's log shows the output of `tailor setup ci env --environment stg`\.$/,
    );
  });
}

test("keeps the outcome and says so when tailor setup ci env fails", async (t) => {
  for (const [failOnMissing, status] of [["true", 1], ["false", 0]]) {
    const result = await runCheck(t, {
      inputs: { environment: "stg", required: CLIENT_SECRET, "package-manager": "pnpm", "fail-on-missing": failOnMissing },
      values: { [CLIENT_SECRET]: "false" },
      env: { FAKE_STATUS: "2" },
    });

    assert.equal(result.status, status);
    assert.match(result.stdout, /^Could not run `tailor setup ci env --environment stg` \(exit 2\)\.$/m);
    assert.doesNotMatch(result.stdout, /This step's log shows/);
  }
});

test("leaves out --environment for a job without a GitHub Environment", async (t) => {
  const result = await runCheck(t, {
    inputs: { required: "TAILOR_AUTOFIX_APP_PRIVATE_KEY", "package-manager": "pnpm" },
    values: { TAILOR_AUTOFIX_APP_PRIVATE_KEY: "false" },
  });

  assert.equal(result.status, 1);
  assert.equal(result.call.args, "exec tailor setup ci env");
  assert.match(
    annotations(result.stdout).find((line) => line.startsWith("::error title=")),
    /::No value for TAILOR_AUTOFIX_APP_PRIVATE_KEY in the repository or the organization\. Run `tailor setup ci env --check` to list what is missing and print the gh commands that set it, or `tailor setup ci env` without write access to the repository\. This step's log shows the output of `tailor setup ci env`\.$/,
  );
});

test("adds that Dependabot runs receive Dependabot secrets", async (t) => {
  const result = await runCheck(t, {
    inputs: { environment: "stg", required: CLIENT_SECRET },
    values: { [CLIENT_SECRET]: "false" },
    env: { GITHUB_ACTOR: "dependabot[bot]" },
  });

  assert.equal(result.status, 1);
  assert.match(annotations(result.stdout)[0], / Runs that Dependabot starts receive Dependabot secrets, not Actions secrets\.$/);
});
