import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executeFile = promisify(execFile);
const action = parse(await fs.readFile(path.join(repositoryRoot, "drift-check/action.yaml"), "utf8"));
const actionStep = action.runs.steps.find((step) => step.name === "Check workflow drift");
const actionScript = actionStep.run;
const actionShellArguments = ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c"];

async function runAction(t, mode, options = {}) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "drift-check-test-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));

  const fakeBin = path.join(fixture, "bin");
  const fakePnpm = path.join(fakeBin, "pnpm");
  const summary = path.join(fixture, "summary.md");
  const marker = `DRIFT_CHECK_${mode.toUpperCase()}_${path.basename(fixture)}`;
  await fs.mkdir(fakeBin);
  await fs.writeFile(
    fakePnpm,
    `#!/bin/sh
if [ "$1" != "exec" ] || [ "$2" != "tailor" ] || [ "$3" != "setup" ] || [ "$4" != "check" ] || [ "$5" != "--ci" ]; then
  echo "unexpected fake pnpm arguments: $*" >&2
  exit 97
fi

case "$FAKE_CHECK_MODE" in
  clean)
    echo "$CHECK_MARKER clean"
    exit 0
    ;;
  drift)
    echo "⚠ [template-version] $CHECK_MARKER workflow drifted (ignore key: template-version)"
    echo 'TAILOR_SETUP_CHECK_DRIFT_COUNT=1'
    echo '✖ Detected 1 drift finding(s) across 1 target(s). Re-run \`tailor setup\` to regenerate, or address each finding above.'
    exit 1
    ;;
  legacy-drift)
    echo "⚠ [template-version] $CHECK_MARKER workflow drifted (ignore key: template-version)"
    echo '✖ Detected 1 drift finding(s) across 1 target(s). Re-run \`tailor setup\` to regenerate, or address each finding above.'
    exit 1
    ;;
  marker-drift)
    echo "⚠ [template-version] $CHECK_MARKER workflow drifted (ignore key: template-version)"
    echo 'TAILOR_SETUP_CHECK_DRIFT_COUNT=1'
    exit 1
    ;;
  error)
    echo "$CHECK_MARKER could not load tailor.config.ts" >&2
    exit 2
    ;;
  malformed)
    echo "$CHECK_MARKER (ignore key: " >&2
    exit 3
    ;;
  stale)
    echo "[template-version] $CHECK_MARKER workflow drifted (ignore rule: template-version)" >&2
    exit 4
    ;;
  spoofed-error)
    echo "$CHECK_MARKER invalid config (ignore key: template-version)" >&2
    exit 5
    ;;
  mismatched-summary)
    echo "⚠ [template-version] $CHECK_MARKER workflow drifted (ignore key: template-version)"
    echo '✖ Detected 2 drift finding(s) across 1 target(s). Re-run \`tailor setup\` to regenerate, or address each finding above.'
    exit 6
    ;;
  malformed-marker)
    echo "⚠ [template-version] $CHECK_MARKER workflow drifted (ignore key: template-version)"
    echo 'TAILOR_SETUP_CHECK_DRIFT_COUNT=many'
    echo '✖ Detected 1 drift finding(s) across 1 target(s). Re-run \`tailor setup\` to regenerate, or address each finding above.'
    exit 7
    ;;
  stale-marker)
    echo "⚠ [template-version] $CHECK_MARKER workflow drifted (ignore key: template-version)"
    echo 'TAILOR_SETUP_CHECK_FINDINGS=1'
    exit 8
    ;;
  *)
    echo "unknown fake mode: $FAKE_CHECK_MODE" >&2
    exit 98
    ;;
esac
`,
  );
  await fs.chmod(fakePnpm, 0o755);
  await fs.access(fakePnpm, fs.constants.X_OK);

  const environment = {
    ...process.env,
    CHECK_MARKER: marker,
    FAIL_ON_DRIFT:
      options.failOnDrift ?? action.inputs?.["fail-on-drift"]?.default ?? "",
    FAKE_CHECK_MODE: mode,
    GITHUB_STEP_SUMMARY: summary,
    IGNORE_RULES: options.ignore ?? "",
    PACKAGE_MANAGER: options.packageManager ?? "pnpm",
    PATH: `${fakeBin}:${process.env.PATH}`,
  };
  const { stdout: resolvedPnpm } = await executeFile("bash", ["-c", "command -v pnpm"], {
    cwd: fixture,
    env: environment,
  });
  assert.equal(resolvedPnpm.trim(), fakePnpm);

  try {
    const result = await executeFile("bash", [...actionShellArguments, actionScript], {
      cwd: fixture,
      env: environment,
    });
    return {
      exitCode: 0,
      marker,
      stderr: result.stderr,
      stdout: result.stdout,
      summary: await fs.readFile(summary, "utf8").catch(() => ""),
    };
  } catch (error) {
    return {
      exitCode: error.code,
      marker,
      stderr: error.stderr,
      stdout: error.stdout,
      summary: await fs.readFile(summary, "utf8").catch(() => ""),
    };
  }
}

test("keeps fail-on-drift disabled by default", () => {
  assert.equal(action.inputs?.["fail-on-drift"]?.default, "false");
  assert.equal(actionStep.env?.FAIL_ON_DRIFT, "${{ inputs.fail-on-drift }}");
});

test("succeeds when the Tailor check succeeds", async (t) => {
  const result = await runAction(t, "clean");

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(result.marker));
});

test("keeps drift findings advisory by default", async (t) => {
  const result = await runAction(t, "drift");

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(`::warning::\\[template-version\\] ${result.marker}`));
  assert.match(result.summary, /1 finding\(s\) emitted, 0 suppressed\./);
});

test("supports the legacy SDK drift summary", async (t) => {
  const result = await runAction(t, "legacy-drift");

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(`::warning::\\[template-version\\] ${result.marker}`));
});

test("accepts the stable drift marker without relying on error prose", async (t) => {
  const result = await runAction(t, "marker-drift");

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(`::warning::\\[template-version\\] ${result.marker}`));
});

test("fails on an unsuppressed finding when fail-on-drift is enabled", async (t) => {
  const result = await runAction(t, "drift", { failOnDrift: "true" });

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, new RegExp(`::warning::\\[template-version\\] ${result.marker}`));
});

test("succeeds when every finding is suppressed in strict mode", async (t) => {
  const result = await runAction(t, "drift", {
    failOnDrift: "true",
    ignore: "template-version",
  });

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, new RegExp(`Suppressed \\(template-version\\): .*${result.marker}`));
  assert.match(result.summary, /0 finding\(s\) emitted, 1 suppressed\./);
});

test("fails when the Tailor check exits without a parseable finding", async (t) => {
  const result = await runAction(t, "error");

  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /::error::\[drift-check\].*valid drift result/);
  assert.match(result.stdout, new RegExp(result.marker));
});

test("fails closed when a malformed finding cannot be parsed", async (t) => {
  const result = await runAction(t, "malformed");

  assert.equal(result.exitCode, 3);
  assert.match(result.stdout, /::error::\[drift-check\].*valid drift result/);
  assert.match(result.stdout, new RegExp(result.marker));
});

test("fails closed when a stale finding format cannot be parsed", async (t) => {
  const result = await runAction(t, "stale");

  assert.equal(result.exitCode, 4);
  assert.match(result.stdout, /::error::\[drift-check\].*valid drift result/);
  assert.match(result.stdout, new RegExp(result.marker));
});

test("fails when an error only resembles a drift finding", async (t) => {
  const result = await runAction(t, "spoofed-error");

  assert.equal(result.exitCode, 5);
  assert.match(result.stdout, /::error::\[drift-check\].*valid drift result/);
  assert.match(result.stdout, new RegExp(result.marker));
});

test("fails when the drift summary count does not match the findings", async (t) => {
  const result = await runAction(t, "mismatched-summary");

  assert.equal(result.exitCode, 6);
  assert.match(result.stdout, /::error::\[drift-check\].*valid drift result/);
  assert.match(result.stdout, new RegExp(result.marker));
});

test("fails when the stable drift marker is malformed", async (t) => {
  const result = await runAction(t, "malformed-marker");

  assert.equal(result.exitCode, 7);
  assert.match(result.stdout, /::error::\[drift-check\].*valid drift result/);
  assert.match(result.stdout, new RegExp(result.marker));
});

test("fails when only a stale drift marker is present", async (t) => {
  const result = await runAction(t, "stale-marker");

  assert.equal(result.exitCode, 8);
  assert.match(result.stdout, /::error::\[drift-check\].*valid drift result/);
  assert.match(result.stdout, new RegExp(result.marker));
});

test("rejects invalid fail-on-drift values", async (t) => {
  const result = await runAction(t, "clean", { failOnDrift: "sometimes" });

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /::error::fail-on-drift must be 'true' or 'false'/);
  assert.doesNotMatch(result.stdout, new RegExp(result.marker));
});

test("rejects unsupported package managers", async (t) => {
  const result = await runAction(t, "clean", { packageManager: "deno" });

  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /::error::Unsupported package-manager 'deno'/);
  assert.doesNotMatch(result.stdout, new RegExp(result.marker));
});
