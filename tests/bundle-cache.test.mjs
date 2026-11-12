import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(root, "_internal/lib/bundle-cache.mjs");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function createFixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "bundle-cache-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function parseOutputs(text) {
  return Object.fromEntries(text.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function runScript(cwd, args, env = {}) {
  const { stdout } = await execute(process.execPath, [script, ...args], { cwd, env: { PATH: process.env.PATH, ...env } });
  return parseOutputs(stdout);
}

test("restore: names the cache directory and a prefix holding the hash of a lockfile found in an ancestor directory", async (t) => {
  const fixture = await createFixture(t);
  const app = path.join(fixture, "apps", "app");
  await mkdir(app, { recursive: true });
  await writeFile(path.join(fixture, "pnpm-lock.yaml"), "lockfile");
  assert.deepEqual(await runScript(app, ["restore"]), {
    path: path.join(app, ".tailor", "cache"),
    prefix: `tailor-bundle-${sha256("lockfile")}-`,
  });
});

test("restore: prefers pnpm-lock.yaml in an ancestor over package-lock.json in the working directory, as the SDK does", async (t) => {
  const fixture = await createFixture(t);
  const app = path.join(fixture, "app");
  await mkdir(app);
  await writeFile(path.join(fixture, "pnpm-lock.yaml"), "pnpm");
  await writeFile(path.join(app, "package-lock.json"), "npm");
  assert.equal((await runScript(app, ["restore"])).prefix, `tailor-bundle-${sha256("pnpm")}-`);
});

test("restore: marks the prefix when no lockfile exists", async (t) => {
  const fixture = await createFixture(t);
  assert.equal((await runScript(fixture, ["restore"])).prefix, "tailor-bundle-none-");
});

test("restore: places the cache under a relative TAILOR_BUILD_OUTPUT_DIR, resolved against the working directory", async (t) => {
  const fixture = await createFixture(t);
  const outputs = await runScript(fixture, ["restore"], { TAILOR_BUILD_OUTPUT_DIR: "build" });
  assert.equal(outputs.path, path.join(fixture, "build", "cache"));
});

test("restore: places the cache under an absolute TAILOR_BUILD_OUTPUT_DIR", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture, "elsewhere");
  const outputs = await runScript(fixture, ["restore"], { TAILOR_BUILD_OUTPUT_DIR: output });
  assert.equal(outputs.path, path.join(output, "cache"));
});

test("restore: falls back to .tailor when TAILOR_BUILD_OUTPUT_DIR is empty", async (t) => {
  const fixture = await createFixture(t);
  const outputs = await runScript(fixture, ["restore"], { TAILOR_BUILD_OUTPUT_DIR: "" });
  assert.equal(outputs.path, path.join(fixture, ".tailor", "cache"));
});

async function saveKey(t, manifest) {
  const fixture = await createFixture(t);
  const cache = path.join(fixture, "cache");
  if (manifest !== undefined) {
    await mkdir(cache);
    await writeFile(path.join(cache, "manifest.json"), manifest);
  }
  return (await runScript(fixture, ["save-key", "tailor-bundle-lock-", cache])).key;
}

const manifest = {
  version: 1,
  sdkVersion: "2.36.0",
  lockfileHash: "abc",
  entries: { "resolver:hello": { kind: "bundle", inputHash: "1", createdAt: "2026-11-12T00:00:00.000Z" } },
};

test("save-key: appends a hash of the manifest to the prefix", async (t) => {
  assert.match(await saveKey(t, JSON.stringify(manifest)), /^tailor-bundle-lock-[0-9a-f]{64}$/);
});

test("save-key: gives no key when the SDK wrote no manifest", async (t) => {
  assert.equal(await saveKey(t, undefined), undefined);
});

test("save-key: gives the same key for a manifest whose keys the SDK wrote in another order", async (t) => {
  const { lockfileHash, entries, ...head } = manifest;
  const firstWrite = JSON.stringify({ ...head, entries, lockfileHash }, null, 2);
  const rewrite = JSON.stringify(manifest, null, 2);
  const key = await saveKey(t, firstWrite);
  assert.match(key, /^tailor-bundle-lock-[0-9a-f]{64}$/);
  assert.equal(await saveKey(t, rewrite), key);
});

test("save-key: changes the key when a bundle entry changes", async (t) => {
  const changed = { ...manifest, entries: { "resolver:hello": { ...manifest.entries["resolver:hello"], inputHash: "2" } } };
  assert.notEqual(await saveKey(t, JSON.stringify(manifest)), await saveKey(t, JSON.stringify(changed)));
});

const actions = [
  { name: "plan", bundling: (step) => step.name === "Run dry-run", saves: true },
  { name: "deploy", bundling: (step) => step.id === "deploy", saves: true },
  { name: "preview-deploy", bundling: (step) => step.id === "deploy", saves: false },
];

async function loadAction(name) {
  return parse(await readFile(path.join(root, name, "action.yaml"), "utf8"));
}

async function runStep(t, actionName, step, env) {
  const fixture = await createFixture(t);
  const outputFile = path.join(fixture, "github-output");
  await writeFile(outputFile, "");
  await writeFile(path.join(fixture, "pnpm-lock.yaml"), "lockfile");
  await execute("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
    cwd: fixture,
    env: { PATH: process.env.PATH, GITHUB_ACTION_PATH: path.join(root, actionName), GITHUB_OUTPUT: outputFile, ...env },
  });
  return { fixture, outputs: parseOutputs(await readFile(outputFile, "utf8")) };
}

const savesOnBranchRuns = "startsWith(github.ref, 'refs/heads/') && contains(fromJSON('[\"push\", \"workflow_dispatch\", \"schedule\"]'), github.event_name)";

for (const { name, bundling, saves } of actions) {
  test(`${name}: enables the bundle cache by default`, async () => {
    const action = await loadAction(name);
    assert.equal(action.inputs["bundle-cache"].default, "true");
  });

  test(`${name}: resolves and restores the bundle cache right before bundling, unless bundle-cache is false`, async () => {
    const steps = (await loadAction(name)).runs.steps;
    const index = steps.findIndex(bundling);
    const [resolve, restore] = steps.slice(index - 2, index);
    assert.equal(resolve.id, "bundle-cache");
    assert.match(resolve.if, /inputs\.bundle-cache == 'true'/);
    assert.equal(resolve["working-directory"], "${{ inputs.working-directory }}");
    assert.equal(resolve.shell, "bash");
    assert.equal(restore.id, "bundle-cache-restore");
    assert.equal(restore.if, "steps.bundle-cache.outputs.prefix != ''");
    assert.match(restore.uses, /^actions\/cache\/restore@[0-9a-f]{40}$/);
    assert.deepEqual(restore.with, {
      path: "${{ steps.bundle-cache.outputs.path }}",
      key: "${{ steps.bundle-cache.outputs.prefix }}",
    });
  });

  test(`${name}: runs the shared script from the action's own checkout to resolve the cache`, async (t) => {
    const resolve = (await loadAction(name)).runs.steps.find((step) => step.id === "bundle-cache");
    const { fixture, outputs } = await runStep(t, name, resolve);
    assert.deepEqual(outputs, {
      path: path.join(fixture, ".tailor", "cache"),
      prefix: `tailor-bundle-${sha256("lockfile")}-`,
    });
  });

  if (saves) {
    test(`${name}: saves a changed bundle cache right after bundling, even when bundling failed, on branch runs only`, async () => {
      const steps = (await loadAction(name)).runs.steps;
      const index = steps.findIndex(bundling);
      const [key, save] = steps.slice(index + 1, index + 3);
      const restore = steps.find((step) => step.id === "bundle-cache-restore");
      assert.equal(key.id, "bundle-cache-key");
      assert.equal(key.shell, "bash");
      assert.equal(key.if, `\${{ !cancelled() && steps.bundle-cache.outputs.prefix != '' && ${savesOnBranchRuns} }}`);
      assert.deepEqual(key.env, {
        PREFIX: "${{ steps.bundle-cache.outputs.prefix }}",
        CACHE_PATH: "${{ steps.bundle-cache.outputs.path }}",
      });
      assert.equal(save.id, "bundle-cache-save");
      assert.equal(
        save.if,
        "${{ !cancelled() && steps.bundle-cache-key.outputs.key != '' && steps.bundle-cache-key.outputs.key != steps.bundle-cache-restore.outputs.cache-matched-key }}",
      );
      assert.equal(save.uses, restore.uses.replace("actions/cache/restore@", "actions/cache/save@"));
      assert.deepEqual(save.with, {
        path: "${{ steps.bundle-cache.outputs.path }}",
        key: "${{ steps.bundle-cache-key.outputs.key }}",
      });
    });

    test(`${name}: runs the shared script from the action's own checkout to key the save`, async (t) => {
      const key = (await loadAction(name)).runs.steps.find((step) => step.id === "bundle-cache-key");
      const fixture = await createFixture(t);
      await writeFile(path.join(fixture, "manifest.json"), JSON.stringify(manifest));
      const { outputs } = await runStep(t, name, key, { PREFIX: "tailor-bundle-lock-", CACHE_PATH: fixture });
      assert.match(outputs.key, /^tailor-bundle-lock-[0-9a-f]{64}$/);
    });
  } else {
    test(`${name}: only restores the bundle cache, as its pull request runs cannot save one other runs can read`, async () => {
      const steps = (await loadAction(name)).runs.steps;
      assert.equal(steps.some((step) => step.uses?.startsWith("actions/cache/save@")), false);
    });
  }
}
