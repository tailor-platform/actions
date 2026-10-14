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
const action = parse(await fs.readFile(path.join(root, "_internal/erd-export/action.yaml"), "utf8"));
const comment = parse(await fs.readFile(path.join(root, "_internal/erd-comment/action.yaml"), "utf8"));
const actionPath = "${{ github.action_path }}";
const hostCheck = `bash "${actionPath}/../lib/is-ghes.sh"`;
const hosts = [
  ["https://github.com", "false"],
  ["https://octo.ghe.com", "false"],
  ["https://ghes.example.com", "true"],
];

const runFrom = (directory, step) => step.run.replaceAll(actionPath, path.join(root, directory));

for (const [server, ghes] of hosts) {
  test(`is-ghes classifies ${server}`, async () => {
    const { stdout } = await executeFile("bash", [path.join(root, "_internal/lib/is-ghes.sh"), server], {
      env: { PATH: process.env.PATH },
    });
    assert.equal(stdout, `${ghes}\n`);
  });
}

test("ERD export and comment classify the host with the shared script", () => {
  for (const step of [
    action.runs.steps.find((step) => step.id === "artifact-backend"),
    comment.runs.steps.find((step) => step.id === "build"),
  ]) {
    assert.ok(step, "expected the host-dependent step");
    assert.ok(step.run.includes(hostCheck), `${step.id} must call the shared host check`);
    assert.ok(!step.run.includes("ghe.com"), `${step.id} must not classify the host itself`);
  }
});

for (const [server, ghes] of hosts) {
  test(`ERD export selects the artifact backend for ${server}`, async (context) => {
    const backend = action.runs.steps.find((step) => step.id === "artifact-backend");
    assert.ok(backend, "expected an artifact backend selector");
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "erd-upload-"));
    context.after(() => fs.rm(temp, { recursive: true, force: true }));
    const output = path.join(temp, "output");
    await executeFile("bash", ["-e", "-o", "pipefail", "-c", runFrom("_internal/erd-export", backend)], {
      env: { PATH: process.env.PATH, GITHUB_SERVER_URL: server, GITHUB_OUTPUT: output },
    });
    assert.equal(await fs.readFile(output, "utf8"), `ghes=${ghes}\n`);
    const upload = action.runs.steps.find((step) => step.id === (ghes === "true" ? "upload-ghes" : "upload-cloud"));
    assert.ok(upload, "expected an upload step for the selected backend");
    assert.ok(upload.if.includes(`steps.artifact-backend.outputs.ghes == '${ghes}'`));
    assert.ok(upload.if.includes("inputs.upload == 'true'"));
    assert.ok(upload.if.includes("steps.export.outputs.exported == 'true'"));
    assert.equal(upload.with.path, "${{ steps.export.outputs.html-path }}");
    assert.equal(upload.with.name, "${{ inputs.artifact-name }}");
    assert.equal(upload.with["if-no-files-found"], "error");
    if (ghes === "true") {
      assert.equal(upload.uses, "actions/upload-artifact@c6a366c94c3e0affe28c06c8df20a878f24da3cf");
      assert.equal(upload.with.archive, undefined);
    } else {
      assert.ok(upload.uses.startsWith("actions/upload-artifact@"));
    }
  });
}

for (const [server, ghes] of hosts) {
  test(`ERD comment explains how to open viewers on ${server}`, async (context) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "erd-comment-"));
    context.after(() => fs.rm(temp, { recursive: true, force: true }));
    const output = path.join(temp, "output");
    const build = comment.runs.steps.find((step) => step.id === "build");
    await executeFile("bash", ["-e", "-o", "pipefail", "-c", runFrom("_internal/erd-comment", build)], {
      env: {
        PATH: process.env.PATH,
        SERVER_URL: server,
        GITHUB_OUTPUT: output,
        LINKS: JSON.stringify([{ label: "tailordb.html", url: `${server}/acme/widgets/actions/runs/99` }]),
        BASE_REF: "main",
      },
    });
    const body = await fs.readFile(output, "utf8");
    assert.ok(body.includes("tailordb.html"));
    assert.ok(body.includes("base branch `main`"));
    if (ghes === "true") {
      assert.ok(body.includes("ZIP"));
      assert.ok(body.includes("candidate"));
      assert.ok(body.includes("[run]"));
      assert.ok(body.includes("irrelevant"));
    } else {
      assert.ok(body.includes("[view]"));
      assert.ok(!body.includes("ZIP"));
    }
  });
}
