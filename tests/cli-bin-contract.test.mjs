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
const directCliActions = [
  "_internal/deploy/action.yaml",
  "_internal/erd-export/action.yaml",
  "_internal/sdk-setup/action.yaml",
  "drift-check/action.yaml",
  "erd-schema-preview/action.yaml",
  "generate-check/action.yaml",
  "migration-drift-check/action.yaml",
  "plan/action.yaml",
  "preview-cleanup/action.yaml",
  "preview-deploy/action.yaml",
  "staticwebsite-deploy/action.yaml",
];
const removedCliPattern = /\btailor-sdk\b(?!\/)/;
const v2CliPattern = /(?<![.\w-])tailor(?![.\/\w-])/;

function stripShellComment(line) {
  let quote;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }

  return line;
}

function hasAdditionalShellCommand(line) {
  let quote;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) quote = undefined;
      else if (quote === undefined) quote = character;
      continue;
    }
    if (quote !== "'" && (character === "`" || line.slice(index, index + 2) === "$(")) {
      return true;
    }
    if (quote === undefined && /[;&|]/.test(character)) return true;
  }

  return false;
}

function isMessageCommand(line) {
  return /^(?:echo|printf)(?:\s|$)/.test(line) && !hasAdditionalShellCommand(line);
}

function isCliInvocationLine(line, cliPattern) {
  const trimmed = stripShellComment(line).trim();
  if (trimmed === "" || trimmed.startsWith("#") || !cliPattern.test(trimmed)) return false;
  return !isMessageCommand(trimmed);
}

function invokesCli(script, cliPattern) {
  return script.split(/\r?\n/).some((line) => isCliInvocationLine(line, cliPattern));
}

function referencedNames(source, patterns) {
  const names = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1]);
  }
  return names;
}

function referencedEnvironmentValues(script, environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    return [];
  }

  const names = referencedNames(script, [
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    /\$([A-Za-z_][A-Za-z0-9_]*)/g,
    /\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g,
  ]);
  return [...names]
    .map((name) => environment[name])
    .filter((value) => typeof value === "string");
}

function referencedInputDefaults(sources, inputs) {
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) return [];

  const names = new Set();
  for (const source of sources) {
    for (const name of referencedNames(source, [
      /\$\{\{\s*inputs\.([A-Za-z_][A-Za-z0-9_-]*)\s*\}\}/g,
      /\$\{\{\s*inputs\[['"]([A-Za-z_][A-Za-z0-9_-]*)['"]\]\s*\}\}/g,
    ])) {
      names.add(name);
    }
  }

  return [...names]
    .map((name) => inputs[name]?.default)
    .filter((value) => typeof value === "string");
}

function parseAction(source) {
  const action = parse(source);
  assert(action !== null && typeof action === "object" && !Array.isArray(action));
  return action;
}

function actionExecutionSurfaces(action) {
  const steps = Array.isArray(action.runs?.steps) ? action.runs.steps : [];
  const scripts = [];
  const indirectValues = [];

  for (const step of steps) {
    if (step === null || typeof step !== "object" || typeof step.run !== "string") continue;
    scripts.push(step.run);
    const environmentValues = referencedEnvironmentValues(step.run, step.env);
    indirectValues.push(...environmentValues);
    indirectValues.push(...referencedInputDefaults([step.run, ...environmentValues], action.inputs));
  }

  return { indirectValues, scripts };
}

function verifyActionSources(actionSources, expectedDirectCliActions = directCliActions) {
  assert.notEqual(actionSources.size, 0, "no action definitions were found");
  const parsedActions = new Map();

  for (const [relativePath, source] of actionSources) {
    const action = parseAction(source);
    parsedActions.set(relativePath, action);
    const { indirectValues, scripts } = actionExecutionSurfaces(action);
    assert(
      !scripts.some((script) => invokesCli(script, removedCliPattern)) &&
        !indirectValues.some((value) => removedCliPattern.test(value)),
      `${relativePath} invokes the removed tailor-sdk CLI binary`,
    );
  }

  for (const relativePath of expectedDirectCliActions) {
    const action = parsedActions.get(relativePath);
    assert.notEqual(action, undefined, `expected CLI action is missing: ${relativePath}`);
    const { scripts } = actionExecutionSurfaces(action);
    assert(
      scripts.some((script) => invokesCli(script, v2CliPattern)),
      `${relativePath} does not invoke the tailor CLI`,
    );
  }
}

async function discoverActionSources(directory) {
  const actionSources = new Map();
  const { stdout } = await executeFile("git", ["ls-files", "-z"], { cwd: directory });
  const actionPaths = stdout
    .split("\0")
    .filter((relativePath) =>
      ["action.yaml", "action.yml"].includes(path.posix.basename(relativePath)),
    );

  for (const relativePath of actionPaths) {
    actionSources.set(relativePath, await fs.readFile(path.join(directory, relativePath), "utf8"));
  }

  return actionSources;
}

test("accepts v2 Tailor CLI invocations", () => {
  verifyActionSources(
    new Map([["valid/action.yaml", "runs:\n  steps:\n    - run: pnpm exec tailor deploy\n"]]),
    ["valid/action.yaml"],
  );
});

test("rejects the removed CLI binary", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          ["stale/action.yaml", "runs:\n  steps:\n    - run: pnpm exec tailor-sdk generate\n"],
        ]),
        [],
      ),
    /removed tailor-sdk CLI binary/,
  );
});

test("rejects an explicit path to the removed CLI binary", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          [
            "stale-path/action.yaml",
            "runs:\n  steps:\n    - run: node_modules/.bin/tailor-sdk generate\n",
          ],
        ]),
        [],
      ),
    /removed tailor-sdk CLI binary/,
  );
});

test("rejects the removed CLI binary supplied through an environment variable", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          [
            "indirect/action.yaml",
            "runs:\n  steps:\n    - env: { CLI: tailor-sdk }\n      run: $CLI generate\n",
          ],
        ]),
        [],
      ),
    /removed tailor-sdk CLI binary/,
  );
});

test("rejects the removed CLI binary in block scalars with chomping indicators", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          ["chomping/action.yaml", "runs:\n  steps:\n    - run: |+\n        tailor-sdk generate\n"],
        ]),
        [],
      ),
    /removed tailor-sdk CLI binary/,
  );
});

for (const [name, run] of [
  ["if condition", "if tailor-sdk --version; then echo ok; fi"],
  ["inline environment assignment", "FOO=1 tailor-sdk generate"],
  ["exec builtin", "exec tailor-sdk generate"],
  ["nested shell", 'sh -c "tailor-sdk generate"'],
]) {
  test(`rejects the removed CLI binary invoked via ${name}`, () => {
    assert.throws(
      () =>
        verifyActionSources(
          new Map([["alternate/action.yaml", `runs:\n  steps:\n    - run: ${run}\n`]]),
          [],
        ),
      /removed tailor-sdk CLI binary/,
    );
  });
}

test("rejects a multiline environment value used as the CLI command", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          [
            "multiline-env/action.yaml",
            "runs:\n  steps:\n    - env:\n        CLI: |-\n          tailor-sdk\n      run: $CLI generate\n",
          ],
        ]),
        [],
      ),
    /removed tailor-sdk CLI binary/,
  );
});

test("rejects the removed CLI binary supplied through an action input", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          [
            "input/action.yaml",
            "inputs:\n  cli:\n    default: tailor-sdk\nruns:\n  steps:\n    - run: ${{ inputs.cli }} generate\n",
          ],
        ]),
        [],
      ),
    /removed tailor-sdk CLI binary/,
  );
});

test("accepts an unused environment value that only mentions the removed CLI", () => {
  verifyActionSources(
    new Map([
      [
        "notice/action.yaml",
        "runs:\n  steps:\n    - env: { NOTICE: tailor-sdk was removed }\n      run: tailor generate\n",
      ],
    ]),
    ["notice/action.yaml"],
  );
});

test("accepts a quoted inline run scalar", () => {
  verifyActionSources(
    new Map([
      ["quoted/action.yaml", 'runs:\n  steps:\n    - run: "pnpm exec tailor generate"\n'],
    ]),
    ["quoted/action.yaml"],
  );
});

test("rejects the removed CLI after a deeper line in an explicitly indented block", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          [
            "indented/action.yaml",
            "runs:\n  steps:\n    - run: |2\n          echo deeper\n        tailor-sdk generate\n",
          ],
        ]),
        [],
      ),
    /removed tailor-sdk CLI binary/,
  );
});

test("accepts non-executable references to the removed CLI name", () => {
  verifyActionSources(
    new Map([
      [
        "message/action.yaml",
        [
          "description: Explains why tailor-sdk was removed",
          "runs:",
          "  steps:",
          "    - run: |",
          "        # tailor-sdk was removed",
          "        echo 'tailor-sdk was removed'",
          "        tailor generate",
          "",
        ].join("\n"),
      ],
    ]),
    ["message/action.yaml"],
  );
});

test("parses run blocks with trailing YAML comments", () => {
  verifyActionSources(
    new Map([
      [
        "commented/action.yaml",
        "runs:\n  steps:\n    - run: | # security-tool: ignore\n        pnpm exec tailor deploy\n",
      ],
    ]),
    ["commented/action.yaml"],
  );
});

test("does not mistake a generated .tailor-sdk path for a CLI invocation", () => {
  verifyActionSources(
    new Map([
      ["path/action.yaml", "runs:\n  steps:\n    - run: node .tailor-sdk/exec.mjs validate\n"],
    ]),
    [],
  );
});

test("rejects an empty action inventory", () => {
  assert.throws(() => verifyActionSources(new Map(), []), /no action definitions were found/);
});

test("rejects a missing expected CLI action", () => {
  assert.throws(
    () => verifyActionSources(new Map([["other/action.yaml", "runs:\n  steps: []\n"]])),
    /expected CLI action is missing/,
  );
});

test("does not accept an out-of-scope description as CLI evidence", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          [
            "out-of-scope/action.yaml",
            "description: Run tailor deploy\nruns:\n  steps:\n    - run: echo skipped\n",
          ],
        ]),
        ["out-of-scope/action.yaml"],
      ),
    /does not invoke the tailor CLI/,
  );
});

test("does not accept a shell message as CLI execution evidence", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([
          [
            "message-only/action.yaml",
            "runs:\n  steps:\n    - run: echo 'tailor must be installed'\n",
          ],
        ]),
        ["message-only/action.yaml"],
      ),
    /does not invoke the tailor CLI/,
  );
});

test("does not accept an unquoted shell message as CLI execution evidence", () => {
  assert.throws(
    () =>
      verifyActionSources(
        new Map([["unquoted-message/action.yaml", "runs:\n  steps:\n    - run: echo tailor\n"]]),
        ["unquoted-message/action.yaml"],
      ),
    /does not invoke the tailor CLI/,
  );
});

test("accepts a trailing comment that mentions the removed CLI", () => {
  verifyActionSources(
    new Map([
      [
        "trailing-comment/action.yaml",
        "runs:\n  steps:\n    - run: |\n        tailor generate # tailor-sdk was removed\n",
      ],
    ]),
    ["trailing-comment/action.yaml"],
  );
});

test("discovers only action definitions tracked by Git", async (context) => {
  const temporaryRepository = await fs.mkdtemp(path.join(os.tmpdir(), "cli-bin-contract-"));
  context.after(() => fs.rm(temporaryRepository, { force: true, recursive: true }));

  await fs.mkdir(path.join(temporaryRepository, "tracked"), { recursive: true });
  await fs.mkdir(path.join(temporaryRepository, ".agent/worktrees/stale"), { recursive: true });
  await fs.writeFile(
    path.join(temporaryRepository, "tracked/action.yaml"),
    "runs:\n  steps:\n    - run: tailor generate\n",
  );
  await fs.writeFile(
    path.join(temporaryRepository, ".agent/worktrees/stale/action.yaml"),
    "runs:\n  steps:\n    - run: tailor-sdk generate\n",
  );
  await executeFile("git", ["init", "--quiet"], { cwd: temporaryRepository });
  await executeFile("git", ["add", "tracked/action.yaml"], { cwd: temporaryRepository });

  const actionSources = await discoverActionSources(temporaryRepository);
  assert.deepEqual([...actionSources.keys()], ["tracked/action.yaml"]);
});

test("all v2 action definitions use the v2 CLI contract", async () => {
  verifyActionSources(await discoverActionSources(repositoryRoot));
});
