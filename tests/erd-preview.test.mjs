import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executeFile = promisify(execFile);
const preview = parse(await fs.readFile(path.join(root, "erd-schema-preview/action.yaml"), "utf8"));
const comment = parse(await fs.readFile(path.join(root, "erd-schema-comment/action.yaml"), "utf8"));
const actionPath = "${{ github.action_path }}";

const runFrom = (directory, step) => step.run.replaceAll(actionPath, path.join(root, directory));

// Renovate bumps third-party pins inside _internal; the pinned commit may lag them without changing behavior.
const withoutThirdPartyShas = (action) => ({
  ...action,
  runs: {
    ...action.runs,
    steps: action.runs.steps.map((step) =>
      step.uses && !step.uses.startsWith("tailor-platform/actions/") ? { ...step, uses: step.uses.replace(/@[0-9a-f]{40}$/, "@<sha>") } : step,
    ),
  },
});

const thirdPartyUses = (action) => action.runs.steps.map((step) => step.uses).filter((uses) => uses && !uses.startsWith("tailor-platform/actions/"));

function outputValue(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}<<`));
  assert.notEqual(start, -1, `missing ${name} output`);
  const end = lines.indexOf(lines[start].slice(name.length + 2), start + 1);
  assert.ok(end > start, `unterminated ${name} output`);
  return lines.slice(start + 1, end).join("\n");
}

async function runList(context, { server, names = "", fixture = [{ artifacts: [] }], apiExit = "0" }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "erd-preview-"));
  context.after(() => fs.rm(temp, { recursive: true, force: true }));
  const bin = path.join(temp, "bin");
  await fs.mkdir(bin);
  const gh = path.join(bin, "gh");
  await fs.writeFile(gh, '#!/usr/bin/env bash\nset -euo pipefail\nprintf "%s|%s|%s\\n" "$GH_HOST" "$GH_TOKEN" "$GH_ENTERPRISE_TOKEN" >> "$GH_CALL_LOG"\n[ "$1" = api ] || exit 71\n[ "$API_EXIT" = 0 ] || exit "$API_EXIT"\nprintf "%s\\n" "$GH_FIXTURE"\n', { mode: 0o755 });
  assert.ok((await fs.stat(gh)).mode & 0o111);
  const callLog = path.join(temp, "gh-calls");
  const output = path.join(temp, "output");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: temp,
    GITHUB_SERVER_URL: server,
    SERVER_URL: server,
    GH_TOKEN: "test-token",
    GH_ENTERPRISE_TOKEN: "test-token",
    GH_CALL_LOG: callLog,
    GH_FIXTURE: JSON.stringify(fixture),
    API_EXIT: apiExit,
    REPO: "acme/widgets",
    RUN_ID: "99",
    PREVIEW_ARTIFACT_NAMES: names,
    GITHUB_OUTPUT: output,
  };
  const { stdout: resolved } = await executeFile("bash", ["-c", "command -v gh"], { env });
  assert.equal(resolved.trim(), gh);
  let error;
  try {
    await executeFile("bash", ["-e", "-o", "pipefail", "-c", runFrom("erd-schema-comment", comment.runs.steps.find((step) => step.id === "list"))], { env });
  } catch (failure) {
    error = failure;
  }
  const calls = await fs.readFile(callLog, "utf8").catch((failure) => {
    if (failure.code === "ENOENT") return "";
    throw failure;
  });
  const rawOutput = await fs.readFile(output, "utf8").catch((failure) => {
    if (failure.code === "ENOENT") return "";
    throw failure;
  });
  return { error, calls, rawOutput };
}

test("GHES comments list candidate artifact names without querying unfinished-run artifacts", async (context) => {
  const result = await runList(context, { server: "https://ghes.example.com", names: '["tailordb.html","analyticsdb.html"]' });
  assert.equal(result.error, undefined);
  assert.equal(result.calls, "");
  assert.deepEqual(JSON.parse(outputValue(result.rawOutput, "links")), [
    { label: "analyticsdb", url: "https://ghes.example.com/acme/widgets/actions/runs/99" },
    { label: "tailordb", url: "https://ghes.example.com/acme/widgets/actions/runs/99" },
  ]);
  assert.equal(comment.runs.steps.find((step) => step.id === "list").env.PREVIEW_ARTIFACT_NAMES, "${{ inputs.preview-artifact-names }}");
});

test("GHES comments accept an explicitly empty candidate list", async (context) => {
  const result = await runList(context, { server: "https://ghes.example.com", names: "[]" });
  assert.equal(result.error, undefined);
  assert.equal(result.calls, "");
  assert.deepEqual(JSON.parse(outputValue(result.rawOutput, "links")), []);
});

for (const names of ["", "not json", "{}", '[1]', '[""]', '["tailordb.zip"]']) {
  test(`GHES comments reject invalid candidate metadata: ${JSON.stringify(names)}`, async (context) => {
    const result = await runList(context, { server: "https://ghes.example.com", names });
    assert.ok(result.error);
    assert.equal(result.calls, "");
    assert.equal(result.rawOutput, "");
  });
}

for (const server of ["https://github.com", "https://octo.ghe.com"]) {
  test(`cloud comments retain artifact-ID links on ${server}`, async (context) => {
    const result = await runList(context, {
      server,
      fixture: [{ artifacts: [{ id: 42, name: "tailordb.html" }, { id: 43, name: "unrelated" }] }],
    });
    assert.equal(result.error, undefined);
    assert.equal(result.calls, `${new URL(server).host}|test-token|test-token\n`);
    assert.deepEqual(JSON.parse(outputValue(result.rawOutput, "links")), [
      { label: "tailordb", url: `${server}/acme/widgets/actions/runs/99/artifacts/42` },
    ]);
  });
}

test("cloud artifact listing failures remain errors rather than no-changes comments", async (context) => {
  const result = await runList(context, { server: "https://github.com", apiExit: "7" });
  assert.ok(result.error);
  assert.equal(result.rawOutput, "");
});

test("cloud comments accept an empty artifact response", async (context) => {
  const result = await runList(context, { server: "https://github.com" });
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(outputValue(result.rawOutput, "links")), []);
});

test("public ERD actions pin the GHES-capable internal definitions", async () => {
  const exported = parse(await fs.readFile(path.join(root, "erd-schema-export/action.yaml"), "utf8"));
  for (const [action, internal] of [[exported, "erd-export"], [preview, "erd-export"], [comment, "erd-comment"]]) {
    const ref = action.runs.steps.find((step) => step.uses?.startsWith(`tailor-platform/actions/_internal/${internal}@`))?.uses;
    assert.ok(ref);
    const sha = ref.split("@")[1];
    assert.match(sha, /^[0-9a-f]{40}$/);
    const { stdout } = await executeFile("git", ["show", `${sha}:_internal/${internal}/action.yaml`], { cwd: root });
    const local = parse(await fs.readFile(path.join(root, `_internal/${internal}/action.yaml`), "utf8"));
    assert.deepEqual(withoutThirdPartyShas(parse(stdout)), withoutThirdPartyShas(local), `${internal} must use the verified implementation`);
    const pinnedUses = thirdPartyUses(parse(stdout));
    for (const [index, uses] of thirdPartyUses(local).entries()) {
      if (uses !== pinnedUses[index]) {
        console.log(`::warning file=_internal/${internal}/action.yaml::consumers still run ${pinnedUses[index]} from the pinned ${sha.slice(0, 7)}; the working tree has ${uses}. Bump the _internal pins to pick it up.`);
      }
    }
  }
});

test("ERD actions classify the host with the shared script", async () => {
  for (const [file, id] of [
    ["erd-schema-preview/action.yaml", "artifact-backend"],
    ["erd-schema-comment/action.yaml", "list"],
    ["_internal/erd-export/action.yaml", "artifact-backend"],
    ["_internal/erd-comment/action.yaml", "build"],
  ]) {
    const action = parse(await fs.readFile(path.join(root, file), "utf8"));
    const run = action.runs.steps.find((step) => step.id === id)?.run;
    assert.ok(run, `missing ${id} step in ${file}`);
    const scripts = [...run.matchAll(/bash "\$\{\{ github\.action_path \}\}\/([^"]+)"/g)].map((match) =>
      path.join(root, path.dirname(file), match[1]),
    );
    assert.deepEqual(scripts, [path.join(root, "_internal/lib/is-ghes.sh")], `${file} must call the shared host check once`);
    assert.ok(!run.includes("ghe.com"), `${file} must not classify the host itself`);
  }
});

for (const [server, ghes] of [["https://github.com", "false"], ["https://octo.ghe.com", "false"], ["https://ghes.example.com", "true"]]) {
  test(`preview uploads use the right backend on ${server}`, async (context) => {
    const backend = preview.runs.steps.find((step) => step.id === "artifact-backend");
    assert.ok(backend);
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "erd-preview-upload-"));
    context.after(() => fs.rm(temp, { recursive: true, force: true }));
    const output = path.join(temp, "output");
    await executeFile("bash", ["-e", "-o", "pipefail", "-c", runFrom("erd-schema-preview", backend)], {
      env: { PATH: process.env.PATH, GITHUB_SERVER_URL: server, GITHUB_OUTPUT: output },
    });
    assert.equal(await fs.readFile(output, "utf8"), `ghes=${ghes}\n`);
    const upload = preview.runs.steps.find((step) => step.id === (ghes === "true" ? "upload-ghes" : "upload-cloud"));
    assert.ok(upload);
    assert.ok(upload.if.includes(`steps.artifact-backend.outputs.ghes == '${ghes}'`));
    assert.ok(upload.if.includes("steps.effective-relevance.outputs.relevant != 'false'"));
    if (ghes === "true") {
      assert.equal(upload.uses, "actions/upload-artifact@c6a366c94c3e0affe28c06c8df20a878f24da3cf");
      assert.equal(upload.with.archive, undefined);
      assert.equal(upload.with.name, "${{ inputs.preview-artifact-name }}");
    } else {
      assert.ok(upload.uses.startsWith("actions/upload-artifact@"));
      assert.equal(upload.with.archive, false);
    }
  });
}
