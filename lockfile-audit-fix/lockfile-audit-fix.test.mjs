import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
  extractAdvisoryIds,
  findFixedAdvisoryIds,
  findAdvisoryById,
  formatAdvisoryLine,
  formatAdvisoryLines,
  parseImporters,
  loadFixedGroupNormalizer,
  diffRuntimeDeps,
  buildSummary,
  splitNameSpec,
  parseVer,
  verGt,
  findYamlBlock,
  collapseExcludeDuplicates,
  collapseOverrideDuplicates,
  overrideTargetName,
  isMentioned,
  readLockfileOutsideOverrides,
  pruneOrphanedOverrides,
  getMinimumReleaseAgeMinutes,
  pruneStaleExcludes,
  normalizeWorkspace,
} from "./lockfile-audit-fix.mjs";

/**
 * Temporarily replaces the global `fetch` for tests that exercise
 * `pruneStaleExcludes`/`normalizeWorkspace` (both call the real npm
 * registry otherwise). `impl` receives the same args as `fetch`.
 */
async function withFakeFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * @param {Record<string, Record<string, string>>} publishTimes package name -> version -> ISO publish date
 */
function fakeRegistryFetch(publishTimes) {
  return async (url) => {
    const name = decodeURIComponent(String(url).replace("https://registry.npmjs.org/", ""));
    if (!(name in publishTimes)) return { ok: false };
    return { ok: true, json: async () => ({ time: publishTimes[name] }) };
  };
}

describe("extractAdvisoryIds", () => {
  test("reads IDs from an object keyed by advisory ID (pnpm/npm-classic shape)", () => {
    const auditJson = {
      advisories: {
        1001: { github_advisory_id: "GHSA-aaaa-bbbb-cccc" },
        1002: { github_advisory_id: "GHSA-dddd-eeee-ffff" },
      },
    };
    assert.deepEqual(extractAdvisoryIds(auditJson), new Set(["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"]));
  });

  test("returns an empty set when there are no advisories", () => {
    assert.deepEqual(extractAdvisoryIds({ advisories: {} }), new Set());
    assert.deepEqual(extractAdvisoryIds({}), new Set());
  });
});

describe("findFixedAdvisoryIds", () => {
  test("returns IDs present before but not after (i.e. cleared by the fix)", () => {
    const before = new Set(["GHSA-a", "GHSA-b", "GHSA-c"]);
    const after = new Set(["GHSA-b"]);
    assert.deepEqual(findFixedAdvisoryIds(before, after), ["GHSA-a", "GHSA-c"]);
  });

  test("returns an empty array when nothing was fixed", () => {
    const before = new Set(["GHSA-a"]);
    const after = new Set(["GHSA-a", "GHSA-b"]);
    assert.deepEqual(findFixedAdvisoryIds(before, after), []);
  });
});

describe("findAdvisoryById / formatAdvisoryLine / formatAdvisoryLines", () => {
  const auditJson = {
    advisories: {
      1: {
        github_advisory_id: "GHSA-whgm-jr23-g3j9",
        title: "Uncontrolled Resource Consumption in ansi-html",
        module_name: "ansi-html",
        severity: "high",
      },
    },
  };

  test("findAdvisoryById finds the matching advisory", () => {
    assert.equal(findAdvisoryById(auditJson, "GHSA-whgm-jr23-g3j9")?.module_name, "ansi-html");
  });

  test("formatAdvisoryLine formats a markdown line with an advisory link", () => {
    assert.equal(
      formatAdvisoryLine(auditJson.advisories[1]),
      "- [GHSA-whgm-jr23-g3j9](https://github.com/advisories/GHSA-whgm-jr23-g3j9): Uncontrolled Resource Consumption in ansi-html (`ansi-html`, severity: high)",
    );
  });

  test("formatAdvisoryLine returns null for a missing advisory", () => {
    assert.equal(formatAdvisoryLine(undefined), null);
  });

  test("formatAdvisoryLines skips unresolvable IDs", () => {
    assert.deepEqual(formatAdvisoryLines(auditJson, ["GHSA-nope", "GHSA-whgm-jr23-g3j9"]), [
      "- [GHSA-whgm-jr23-g3j9](https://github.com/advisories/GHSA-whgm-jr23-g3j9): Uncontrolled Resource Consumption in ansi-html (`ansi-html`, severity: high)",
    ]);
  });
});

describe("parseImporters", () => {
  test("extracts only the dependencies block per importer, not devDependencies", () => {
    const text = [
      "lockfileVersion: '9.0'",
      "importers:",
      "  .:",
      "    dependencies:",
      "      foo:",
      "        specifier: ^1.0.0",
      "    devDependencies:",
      "      bar:",
      "        specifier: ^2.0.0",
      "  packages/sub:",
      "    dependencies:",
      "      baz:",
      "        specifier: ^3.0.0",
      "packages:",
      "  foo@1.0.0: {}",
    ].join("\n");

    const importers = parseImporters(text);
    assert.equal(Object.keys(importers).length, 2);
    assert.match(importers["."], /foo:/);
    assert.doesNotMatch(importers["."], /bar:/);
    assert.match(importers["packages/sub"], /baz:/);
  });

  test("returns an empty object when there's no importers block", () => {
    assert.deepEqual(parseImporters("lockfileVersion: '9.0'\n"), {});
  });
});

describe("loadFixedGroupNormalizer", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-normalizer-test-"));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("maps a package name to its fixed group's primary name", () => {
    mkdirSync(join(cwd, ".changeset"));
    writeFileSync(
      join(cwd, ".changeset", "config.json"),
      JSON.stringify({ fixed: [["@scope/primary", "@scope/secondary"]] }),
    );
    const normalize = loadFixedGroupNormalizer(cwd);
    assert.equal(normalize("@scope/secondary"), "@scope/primary");
    assert.equal(normalize("@scope/primary"), "@scope/primary");
  });

  test("is a no-op when there's no config.json", () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-no-config-"));
    try {
      const normalize = loadFixedGroupNormalizer(emptyCwd);
      assert.equal(normalize("some-pkg"), "some-pkg");
    } finally {
      rmSync(emptyCwd, { recursive: true, force: true });
    }
  });
});

describe("diffRuntimeDeps", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-diff-test-"));
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "root-pkg" }));
    mkdirSync(join(cwd, "private-pkg"));
    writeFileSync(join(cwd, "private-pkg", "package.json"), JSON.stringify({ name: "priv-pkg", private: true }));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const withDeps = (path, dep) =>
    ["importers:", `  ${path}:`, "    dependencies:", `      ${dep}:`, "        specifier: ^1.0.0"].join("\n");

  test("reports a non-private importer whose dependencies block changed", () => {
    const before = withDeps(".", "foo");
    const after = withDeps(".", "foo-renamed");
    assert.deepEqual(diffRuntimeDeps({ beforeText: before, afterText: after, cwd }), ["root-pkg"]);
  });

  test("ignores devDependencies-only changes (dependencies block unchanged)", () => {
    const before = withDeps(".", "foo");
    assert.deepEqual(diffRuntimeDeps({ beforeText: before, afterText: before, cwd }), []);
  });

  test("excludes private packages even when their dependencies changed", () => {
    const before = withDeps("private-pkg", "foo");
    const after = withDeps("private-pkg", "foo-renamed");
    assert.deepEqual(diffRuntimeDeps({ beforeText: before, afterText: after, cwd }), []);
  });

  test("excludes importers with no resolvable package.json", () => {
    const before = withDeps("missing-dir", "foo");
    const after = withDeps("missing-dir", "foo-renamed");
    assert.deepEqual(diffRuntimeDeps({ beforeText: before, afterText: after, cwd }), []);
  });
});

describe("buildSummary", () => {
  const before = {
    advisories: {
      1: {
        github_advisory_id: "GHSA-aaaa",
        title: "Vuln A",
        module_name: "pkg-a",
        severity: "high",
      },
      2: {
        github_advisory_id: "GHSA-bbbb",
        title: "Vuln B",
        module_name: "pkg-b",
        severity: "moderate",
      },
    },
  };

  test("lists fixed advisories and omits the remaining-count line when none remain", () => {
    const after = { advisories: {} };
    const summary = buildSummary(before, after);
    assert.match(summary, /Fixed advisories:/);
    assert.match(summary, /GHSA-aaaa/);
    assert.match(summary, /GHSA-bbbb/);
    assert.doesNotMatch(summary, /remain/);
  });

  test("reports advisories that remain unfixed", () => {
    const after = { advisories: { 1: before.advisories[1] } };
    const summary = buildSummary(before, after);
    assert.match(summary, /Fixed advisories:/);
    assert.match(summary, /GHSA-bbbb/);
    assert.match(summary, /1 advisory remains/);
  });

  test("degrades gracefully when audit data is unavailable", () => {
    const summary = buildSummary(null, null);
    assert.match(summary, /unavailable/);
  });

  test("reports dropped exclude/override entries from pruneResult", () => {
    const summary = buildSummary(null, null, {
      droppedExcludes: ["hono@4.12.27"],
      droppedOverrides: ["ghost-pkg@1"],
    });
    assert.match(summary, /Removed `minimumReleaseAgeExclude` entries/);
    assert.match(summary, /`hono@4\.12\.27`/);
    assert.match(summary, /Removed `overrides` entries/);
    assert.match(summary, /`ghost-pkg@1`/);
  });

  test("omits both prune sections when nothing was dropped", () => {
    const summary = buildSummary(null, null, {});
    assert.doesNotMatch(summary, /Removed/);
  });
});

describe("splitNameSpec / parseVer / verGt", () => {
  test("splits a plain package name from its version", () => {
    assert.deepEqual(splitNameSpec("hono@4.12.27"), ["hono", "4.12.27"]);
  });

  test("splits a scoped package name (second @ is the boundary)", () => {
    assert.deepEqual(splitNameSpec("@hono/node-server@1.19.15"), ["@hono/node-server", "1.19.15"]);
  });

  test("returns a null version for a bare name-pattern entry", () => {
    assert.deepEqual(splitNameSpec("@tailor-platform/*"), ["@tailor-platform/*", null]);
  });

  test("verGt compares parsed semver-ish triples", () => {
    assert.equal(verGt("4.13.3", "4.12.27"), true);
    assert.equal(verGt("4.12.27", "4.13.3"), false);
    assert.equal(verGt("1.0.0", "1.0.0"), false);
  });

  test("verGt is false when either side doesn't parse as a version", () => {
    assert.equal(verGt("not-a-version", "1.0.0"), false);
    assert.equal(verGt("1.0.0", "<1.0.0"), false); // range operators aren't stripped by parseVer
  });

  test("parseVer ignores range operators and reads the embedded triple", () => {
    assert.deepEqual(parseVer(">=3.0.0 <3.1.5"), [3, 0, 0]);
    assert.equal(parseVer("not-a-version"), null);
  });
});

describe("findYamlBlock", () => {
  test("returns null when the key isn't present", () => {
    assert.equal(findYamlBlock(["foo: bar"], "overrides"), null);
  });

  test("finds the block's start and the next top-level key's index", () => {
    const lines = ["overrides:", "  a: 1", "  b: 2", "blockExoticSubdeps: true"];
    assert.deepEqual(findYamlBlock(lines, "overrides"), { startIdx: 0, endIdx: 3 });
  });

  test("runs to the end of the file when the block is last", () => {
    const lines = ["overrides:", "  a: 1", "  b: 2"];
    assert.deepEqual(findYamlBlock(lines, "overrides"), { startIdx: 0, endIdx: 3 });
  });
});

describe("collapseExcludeDuplicates", () => {
  test("keeps only the highest-version entry for a package with overlapping ranges", () => {
    const { lines, dropped } = collapseExcludeDuplicates(
      "minimumReleaseAgeExclude:\n  - hono@4.12.27\n  - hono@4.13.3\n".split("\n"),
    );
    assert.equal(lines.join("\n"), "minimumReleaseAgeExclude:\n  - hono@4.13.3\n");
    assert.deepEqual(dropped, ["hono@4.12.27"]);
  });

  test("drops the comment attached to the losing entry", () => {
    const { lines, dropped } = collapseExcludeDuplicates(
      [
        "minimumReleaseAgeExclude:",
        "  # a note about the old pin",
        "  - hono@4.12.27",
        "  - hono@4.13.3",
        "",
      ].join("\n").split("\n"),
    );
    assert.doesNotMatch(lines.join("\n"), /a note about the old pin/);
    assert.deepEqual(dropped, ["hono@4.12.27"]);
  });

  test("passes name-pattern entries through untouched", () => {
    const { lines, dropped } = collapseExcludeDuplicates(
      'minimumReleaseAgeExclude:\n  - "@tailor-platform/*"\n  - politty\n'.split("\n"),
    );
    assert.equal(lines.join("\n"), 'minimumReleaseAgeExclude:\n  - "@tailor-platform/*"\n  - politty\n');
    assert.deepEqual(dropped, []);
  });

  test("is a no-op when the block is absent", () => {
    const lines = ["minimumReleaseAge: 4320"];
    assert.deepEqual(collapseExcludeDuplicates(lines), { lines, dropped: [] });
  });
});

describe("collapseOverrideDuplicates", () => {
  test("keeps only the highest-version override for the same package", () => {
    const { lines, dropped } = collapseOverrideDuplicates(
      ["overrides:", "  hono@<4.12.27: 4.12.27", "  hono@<4.13.3: 4.13.3", ""].join("\n").split("\n"),
    );
    assert.equal(lines.join("\n"), ["overrides:", "  hono@<4.13.3: 4.13.3", ""].join("\n"));
    assert.deepEqual(dropped, ["hono@<4.12.27"]);
  });

  test("leaves a single override for a package untouched", () => {
    const lines = ["overrides:", "  esbuild@>=0.17.0 <0.28.1: 0.28.1", ""].join("\n").split("\n");
    const result = collapseOverrideDuplicates(lines);
    assert.equal(result.lines.join("\n"), lines.join("\n"));
    assert.deepEqual(result.dropped, []);
  });
});

describe("overrideTargetName / isMentioned", () => {
  test("overrideTargetName reads the package name ahead of a version range", () => {
    assert.equal(overrideTargetName("fast-uri@>=3.0.0 <3.1.4"), "fast-uri");
  });

  test("overrideTargetName resolves a dep-path key to its parent package", () => {
    assert.equal(overrideTargetName("parent-pkg>child-pkg"), "parent-pkg");
  });

  test("overrideTargetName handles a scoped package name", () => {
    assert.equal(overrideTargetName('"@scope/live@<1"'.replace(/^"|"$/g, "")), "@scope/live");
  });

  test("isMentioned finds a resolved package key", () => {
    assert.equal(isMentioned("  fast-uri@3.1.4:\n    resolution: {}", "fast-uri"), true);
  });

  test("isMentioned finds a bare importer/link key", () => {
    assert.equal(isMentioned("  '@scope/linked':\n    specifier: workspace:^", "@scope/linked"), true);
  });

  test("isMentioned does not confuse a package name with a longer one ending in it", () => {
    assert.equal(isMentioned("  build@<1:\n    resolution: {}", "uild"), false);
  });

  test("isMentioned returns false when the name doesn't appear at all", () => {
    assert.equal(isMentioned("  esbuild@0.28.1:\n    resolution: {}", "ghost-pkg"), false);
  });
});

describe("readLockfileOutsideOverrides", () => {
  test("strips the lockfile's own overrides mirror block", () => {
    const text = ["overrides:", "  ghost-pkg@1: 2.0.0", "", "packages:", "", "  esbuild@0.28.1: {}", ""].join("\n");
    const result = readLockfileOutsideOverrides(text);
    assert.doesNotMatch(result, /ghost-pkg/);
    assert.match(result, /esbuild@0\.28\.1/);
  });

  test("returns null when there's no packages block (not a real lockfile)", () => {
    assert.equal(readLockfileOutsideOverrides("lockfileVersion: '9.0'\n"), null);
  });

  test("returns the text unchanged when there's no overrides block", () => {
    const text = "packages:\n\n  esbuild@0.28.1: {}\n";
    assert.equal(readLockfileOutsideOverrides(text), text);
  });
});

// Ported from tailor-platform/sdk's lockfile-audit-fix-normalize.test.mjs.
describe("pruneOrphanedOverrides", () => {
  const LOCKFILE = [
    "lockfileVersion: '9.0'",
    "",
    "overrides:",
    "  ghost-pkg@1: 2.0.0",
    "",
    "importers:",
    "",
    "  .:",
    "    devDependencies:",
    "      '@scope/live':",
    "        specifier: 1.0.0",
    "        version: 1.0.0",
    "      '@scope/linked':",
    "        specifier: workspace:^",
    "        version: link:packages/linked",
    "      linked-tool:",
    "        specifier: workspace:*",
    "        version: link:packages/tool",
    "",
    "packages:",
    "",
    "  esbuild@0.28.1:",
    "    resolution: {integrity: sha512-x}",
    "",
    "  '@scope/live@1.0.0':",
    "    resolution: {integrity: sha512-y}",
    "",
    "  parent-pkg@2.0.0:",
    "    resolution: {integrity: sha512-z}",
    "",
    "snapshots:",
    "",
    "  esbuild@0.28.1: {}",
    "",
    "  '@scope/live@1.0.0': {}",
    "",
    "  parent-pkg@2.0.0: {}",
    "",
  ].join("\n");

  function overrideKeys(lines) {
    const block = findYamlBlock(lines, "overrides");
    if (!block) return [];
    return lines
      .slice(block.startIdx + 1, block.endIdx)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"))
      .map((l) => l.slice(0, l.indexOf(":")));
  }

  test("drops overrides whose package left the dependency tree", () => {
    const { lines, dropped } = pruneOrphanedOverrides(
      ["overrides:", "  esbuild@>=0.17.0 <0.28.1: 0.28.1", "  fast-uri@>=3.0.0 <3.1.4: 3.1.4", "  ghost-pkg@1: 2.0.0"],
      LOCKFILE,
    );
    assert.deepEqual(overrideKeys(lines), ["esbuild@>=0.17.0 <0.28.1"]);
    assert.deepEqual(dropped.sort(), ["fast-uri@>=3.0.0 <3.1.4", "ghost-pkg@1"].sort());
  });

  test("keeps overrides reachable through resolved keys or dep paths", () => {
    const { lines } = pruneOrphanedOverrides(['overrides:', '  "@scope/live@<1": 1.0.0', "  parent-pkg>child-pkg: 3.0.0"], LOCKFILE);
    assert.deepEqual(overrideKeys(lines), ['"@scope/live@<1"', "parent-pkg>child-pkg"]);
  });

  test("keeps overrides on workspace-linked packages", () => {
    const { lines, dropped } = pruneOrphanedOverrides(
      ["overrides:", '  "@scope/linked@<1": 1.0.0', "  linked-tool@<1: 1.0.0"],
      LOCKFILE,
    );
    assert.deepEqual(overrideKeys(lines), ['"@scope/linked@<1"', "linked-tool@<1"]);
    assert.deepEqual(dropped, []);
  });

  test("does not confuse a package name with a longer one ending in it", () => {
    const { lines } = pruneOrphanedOverrides(["overrides:", "  build@<1: 1.0.0"], LOCKFILE);
    assert.deepEqual(overrideKeys(lines), []);
  });

  test("honours a keep-override opt-out comment", () => {
    const { lines, dropped } = pruneOrphanedOverrides(
      ["overrides:", "  # keep-override: pinned ahead of the dependency landing", "  future-pkg@<9: 9.0.0"],
      LOCKFILE,
    );
    assert.deepEqual(overrideKeys(lines), ["future-pkg@<9"]);
    assert.deepEqual(dropped, []);
  });

  test("keeps every override when the lockfile is missing", () => {
    const { lines, dropped } = pruneOrphanedOverrides(["overrides:", "  fast-uri@>=3.0.0 <3.1.4: 3.1.4"], null);
    assert.deepEqual(overrideKeys(lines), ["fast-uri@>=3.0.0 <3.1.4"]);
    assert.deepEqual(dropped, []);
  });

  test("keeps every override when the lockfile has no packages block", () => {
    const { lines, dropped } = pruneOrphanedOverrides(
      ["overrides:", "  fast-uri@>=3.0.0 <3.1.4: 3.1.4"],
      "lockfileVersion: '9.0'\n\noverrides:\n  fast-uri@x: 1\n",
    );
    assert.deepEqual(overrideKeys(lines), ["fast-uri@>=3.0.0 <3.1.4"]);
    assert.deepEqual(dropped, []);
  });

  test("removes the overrides key itself once the block empties", () => {
    const { lines } = pruneOrphanedOverrides(
      ["minimumReleaseAge: 4320", "", "overrides:", "  ghost-pkg@1: 2.0.0", "", "blockExoticSubdeps: true"],
      LOCKFILE,
    );
    assert.equal(lines.join("\n"), "minimumReleaseAge: 4320\n\nblockExoticSubdeps: true");
  });
});

describe("getMinimumReleaseAgeMinutes", () => {
  test("reads the configured value", () => {
    assert.equal(getMinimumReleaseAgeMinutes(["minimumReleaseAge: 4320"]), 4320);
  });

  test("returns null when unset", () => {
    assert.equal(getMinimumReleaseAgeMinutes(["trustPolicy: no-downgrade"]), null);
  });
});

describe("pruneStaleExcludes", () => {
  test("drops an entry once its version is old enough to no longer need the bypass", async () => {
    const { lines, dropped } = await withFakeFetch(
      fakeRegistryFetch({ hono: { "4.12.27": "2020-01-01T00:00:00.000Z" } }),
      () => pruneStaleExcludes(["minimumReleaseAgeExclude:", "  - hono@4.12.27", ""], 4320),
    );
    assert.equal(lines.join("\n"), "minimumReleaseAgeExclude:\n");
    assert.deepEqual(dropped, ["hono@4.12.27"]);
  });

  test("keeps an entry whose version is still within the minimumReleaseAge window", async () => {
    const justPublished = new Date().toISOString();
    const { lines, dropped } = await withFakeFetch(
      fakeRegistryFetch({ hono: { "4.13.3": justPublished } }),
      () => pruneStaleExcludes(["minimumReleaseAgeExclude:", "  - hono@4.13.3", ""], 4320),
    );
    assert.equal(lines.join("\n"), "minimumReleaseAgeExclude:\n  - hono@4.13.3\n");
    assert.deepEqual(dropped, []);
  });

  test("keeps an entry conservatively when the publish time can't be determined", async () => {
    const { lines, dropped } = await withFakeFetch(fakeRegistryFetch({}), () =>
      pruneStaleExcludes(["minimumReleaseAgeExclude:", "  - unknown-pkg@1.0.0", ""], 4320),
    );
    assert.equal(lines.join("\n"), "minimumReleaseAgeExclude:\n  - unknown-pkg@1.0.0\n");
    assert.deepEqual(dropped, []);
  });

  test("keeps a name-pattern entry untouched (no version to check)", async () => {
    const { lines, dropped } = await pruneStaleExcludes(['minimumReleaseAgeExclude:', '  - "@tailor-platform/*"', ""], 4320);
    assert.equal(lines.join("\n"), 'minimumReleaseAgeExclude:\n  - "@tailor-platform/*"\n');
    assert.deepEqual(dropped, []);
  });

  test("is a no-op when minimumReleaseAge isn't set", async () => {
    const lines = ["minimumReleaseAgeExclude:", "  - hono@4.12.27", ""];
    assert.deepEqual(await pruneStaleExcludes(lines, null), { lines, dropped: [] });
  });

  // pnpm writes a `||`-separated disjunction for a package that needed the
  // bypass at more than one version, e.g. erp-kit#1056's
  // `hono@4.12.27 || 4.12.34` — a single entry, not two duplicate ones.
  test("drops a `||`-disjunction entry once every listed version is old enough (erp-kit#1056 shape)", async () => {
    const { lines, dropped } = await withFakeFetch(
      fakeRegistryFetch({
        hono: { "4.12.27": "2020-01-01T00:00:00.000Z", "4.12.34": "2020-02-01T00:00:00.000Z" },
      }),
      () => pruneStaleExcludes(["minimumReleaseAgeExclude:", "  - hono@4.12.27 || 4.12.34", ""], 4320),
    );
    assert.equal(lines.join("\n"), "minimumReleaseAgeExclude:\n");
    assert.deepEqual(dropped, ["hono@4.12.27 || 4.12.34"]);
  });

  test("keeps a `||`-disjunction entry when even one listed version isn't provably stale", async () => {
    const justPublished = new Date().toISOString();
    const { lines, dropped } = await withFakeFetch(
      fakeRegistryFetch({ hono: { "4.12.27": "2020-01-01T00:00:00.000Z", "4.12.34": justPublished } }),
      () => pruneStaleExcludes(["minimumReleaseAgeExclude:", "  - hono@4.12.27 || 4.12.34", ""], 4320),
    );
    assert.equal(lines.join("\n"), "minimumReleaseAgeExclude:\n  - hono@4.12.27 || 4.12.34\n");
    assert.deepEqual(dropped, []);
  });

  test("fetches a package's publish times only once even with multiple versions listed for it", async () => {
    let calls = 0;
    const baseImpl = fakeRegistryFetch({
      hono: { "4.12.27": "2020-01-01T00:00:00.000Z", "4.12.34": "2020-02-01T00:00:00.000Z" },
    });
    await withFakeFetch(
      async (url) => {
        calls++;
        return baseImpl(url);
      },
      () => pruneStaleExcludes(["minimumReleaseAgeExclude:", "  - hono@4.12.27 || 4.12.34", ""], 4320),
    );
    assert.equal(calls, 1);
  });
});

describe("normalizeWorkspace", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-normalize-workspace-"));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("is a no-op when there's no pnpm-workspace.yaml", async () => {
    const result = await normalizeWorkspace(cwd);
    assert.deepEqual(result, { changed: false, droppedExcludes: [], droppedOverrides: [] });
  });

  test("collapses two separate exclude entries pnpm added for the same package at different advisory thresholds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-normalize-collapse-"));
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), ["minimumReleaseAgeExclude:", "  - hono@4.12.27", "  - hono@4.13.3", ""].join("\n"));
      writeFileSync(
        join(dir, "pnpm-lock.yaml"),
        ["lockfileVersion: '9.0'", "", "packages:", "", "  hono@4.13.3:", "    resolution: {integrity: sha512-x}", ""].join(
          "\n",
        ),
      );

      const result = await normalizeWorkspace(dir);
      assert.equal(result.changed, true);
      assert.deepEqual(result.droppedExcludes, ["hono@4.12.27"]);
      assert.equal(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8"), "minimumReleaseAgeExclude:\n  - hono@4.13.3\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reproduces the erp-kit#1056 case: drops a stale `||`-disjunction exclude entry via age-based pruning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-normalize-1056-"));
    try {
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        ["minimumReleaseAge: 4320", "minimumReleaseAgeExclude:", "  - hono@4.12.27 || 4.12.34", ""].join("\n"),
      );
      writeFileSync(
        join(dir, "pnpm-lock.yaml"),
        ["lockfileVersion: '9.0'", "", "packages:", "", "  hono@4.13.3:", "    resolution: {integrity: sha512-x}", ""].join(
          "\n",
        ),
      );

      const result = await withFakeFetch(
        fakeRegistryFetch({
          hono: { "4.12.27": "2020-01-01T00:00:00.000Z", "4.12.34": "2020-02-01T00:00:00.000Z" },
        }),
        () => normalizeWorkspace(dir),
      );
      assert.equal(result.changed, true);
      assert.deepEqual(result.droppedExcludes, ["hono@4.12.27 || 4.12.34"]);
      assert.equal(
        readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8"),
        "minimumReleaseAge: 4320\nminimumReleaseAgeExclude:\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent: a second pass reports no further changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-normalize-idempotent-"));
    try {
      writeFileSync(join(dir, "pnpm-workspace.yaml"), ["overrides:", "  esbuild@>=0.17.0 <0.28.1: 0.28.1", ""].join("\n"));
      writeFileSync(join(dir, "pnpm-lock.yaml"), ["packages:", "", "  esbuild@0.28.1: {}", ""].join("\n"));

      await normalizeWorkspace(dir);
      const second = await normalizeWorkspace(dir);
      assert.deepEqual(second, { changed: false, droppedExcludes: [], droppedOverrides: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Writes a fake `pnpm` binary that drives lockfile-audit-fix.mjs's main()
 * through a real subprocess (main() writes real files and reads/writes
 * them relative to cwd, so this is easier to verify honestly than mocking
 * child_process). Behavior is controlled entirely through env vars read by
 * the fake binary itself:
 *
 *   FAKE_PNPM_AUDIT_JSON_<n>       - stdout for the n-th `pnpm audit --json`
 *                                    call (1-indexed: 1 = before any fix,
 *                                    2 = after)
 *   FAKE_PNPM_AUDIT_JSON_DEFAULT   - fallback when a specific call isn't set
 *   FAKE_PNPM_FIX_<MODE>_LOCKFILE     - if set, overwrites pnpm-lock.yaml on
 *                                       `pnpm audit --fix <mode>`
 *   FAKE_PNPM_FIX_<MODE>_WORKSPACE    - same, for pnpm-workspace.yaml
 *                                       (creating it if absent)
 *   FAKE_PNPM_FIX_<MODE>_PACKAGE_JSON - same, for package.json
 *   FAKE_PNPM_INSTALL_FAIL_<n>     - "1" makes the n-th `pnpm install` call
 *                                    (1-indexed: 1 = after update,
 *                                    2 = after override) fail
 *   FAKE_PNPM_STATE                - directory for the call counters
 */
function writeFakePnpm(fakeBinDir) {
  const script = [
    "#!/usr/bin/env node",
    'import { readFileSync, writeFileSync, existsSync } from "node:fs";',
    "const args = process.argv.slice(2);",
    "",
    "function nextCount(name) {",
    "  const counterPath = `${process.env.FAKE_PNPM_STATE}/${name}-count`;",
    "  let n = 0;",
    '  if (existsSync(counterPath)) n = parseInt(readFileSync(counterPath, "utf8"), 10);',
    "  n += 1;",
    "  writeFileSync(counterPath, String(n));",
    "  return n;",
    "}",
    "",
    'if (args[0] === "audit" && args.includes("--json")) {',
    '  const n = nextCount("audit");',
    "  const json = process.env[`FAKE_PNPM_AUDIT_JSON_${n}`] ?? process.env.FAKE_PNPM_AUDIT_JSON_DEFAULT ?? '{\"advisories\":{}}';",
    "  process.stdout.write(json);",
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "audit" && args.includes("--fix")) {',
    "  const mode = args[2].toUpperCase();",
    "  const lockfile = process.env[`FAKE_PNPM_FIX_${mode}_LOCKFILE`];",
    "  const workspace = process.env[`FAKE_PNPM_FIX_${mode}_WORKSPACE`];",
    "  const packageJson = process.env[`FAKE_PNPM_FIX_${mode}_PACKAGE_JSON`];",
    '  if (lockfile !== undefined) writeFileSync("pnpm-lock.yaml", lockfile);',
    '  if (workspace !== undefined) writeFileSync("pnpm-workspace.yaml", workspace);',
    '  if (packageJson !== undefined) writeFileSync("package.json", packageJson);',
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "install") {',
    '  const n = nextCount("install");',
    '  if (process.env[`FAKE_PNPM_INSTALL_FAIL_${n}`] === "1") {',
    '    process.stderr.write("install failed\\n");',
    "    process.exit(1);",
    "  }",
    "  process.exit(0);",
    "}",
    "",
    "process.exit(0);",
    "",
  ].join("\n");
  writeFileSync(join(fakeBinDir, "pnpm"), script);
  chmodSync(join(fakeBinDir, "pnpm"), 0o755);
}

function parseGithubOutput(text) {
  const result = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const multilineMatch = line.match(/^([A-Za-z0-9_-]+)<<(\S+)$/);
    if (multilineMatch) {
      const [, name, delim] = multilineMatch;
      const valueLines = [];
      i++;
      while (i < lines.length && lines[i] !== delim) {
        valueLines.push(lines[i]);
        i++;
      }
      result[name] = valueLines.join("\n");
      continue;
    }
    const simpleMatch = line.match(/^([A-Za-z0-9_-]+)=(.*)$/);
    if (simpleMatch) result[simpleMatch[1]] = simpleMatch[2];
  }
  return result;
}

describe("main() end-to-end via a fake pnpm binary", () => {
  let repoDir;
  let fakeBinDir;
  let outputFile;
  let stateDir;

  before(() => {
    repoDir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-e2e-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-fake-pnpm-"));
    stateDir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-state-"));
    writeFakePnpm(fakeBinDir);
  });

  after(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  const runMain = (env) => {
    outputFile = join(stateDir, `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(outputFile, "");
    execFileSync("node", [join(__dirname, "lockfile-audit-fix.mjs")], {
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        FAKE_PNPM_STATE: stateDir,
        GITHUB_OUTPUT: outputFile,
        ...env,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    return parseGithubOutput(readFileSync(outputFile, "utf8"));
  };

  test("no advisories: reports no changes and doesn't touch the lockfile", () => {
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "clean\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({ FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}' });

    assert.equal(outputs.changed, "false");
    assert.equal(outputs["runtime-deps-changed"], "false");
    assert.equal(outputs["changed-names"], "");
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), "clean\n");
  });

  test("update mode fixes the advisory: reports the runtime-dependency change and a fixed-advisory summary", () => {
    const before = [
      "importers:",
      "  .:",
      "    dependencies:",
      "      vulnerable-pkg:",
      "        specifier: ^1.0.0",
    ].join("\n");
    const fixed = [
      "importers:",
      "  .:",
      "    dependencies:",
      "      vulnerable-pkg:",
      "        specifier: ^1.0.1",
    ].join("\n");
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_1: JSON.stringify({
        advisories: {
          1: {
            github_advisory_id: "GHSA-xxxx-yyyy-zzzz",
            title: "Vulnerable pkg",
            module_name: "vulnerable-pkg",
            severity: "high",
          },
        },
      }),
      FAKE_PNPM_AUDIT_JSON_2: '{"advisories":{}}',
      FAKE_PNPM_FIX_UPDATE_LOCKFILE: fixed,
    });

    assert.equal(outputs.changed, "true");
    assert.equal(outputs["runtime-deps-changed"], "true");
    assert.equal(outputs["changed-names"], "my-pkg");
    assert.match(outputs.summary, /Fixed advisories:/);
    assert.match(outputs.summary, /GHSA-xxxx-yyyy-zzzz/);
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), fixed);
  });

  test("update-mode install itself fails: rolls back to the pristine original before trying override", () => {
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    const brokenUpdate = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: broken"].join(
      "\n",
    );
    const overrideFixed = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^2.0.0"].join(
      "\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_UPDATE_LOCKFILE: brokenUpdate,
      FAKE_PNPM_INSTALL_FAIL_1: "1", // the install right after update mode fails
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideFixed,
      // install #2 (after override) is left to succeed
    });

    assert.equal(outputs.changed, "true");
    assert.equal(
      readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"),
      overrideFixed,
      "override mode should still be attempted from the restored original, not skipped",
    );
  });

  test("override fallback left the result uninstallable: rolls back to the update-only result", () => {
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    const updateOnly = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.1"].join(
      "\n",
    );
    const overrideBroken = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^2.0.0"].join(
      "\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_UPDATE_LOCKFILE: updateOnly,
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideBroken,
      FAKE_PNPM_INSTALL_FAIL_2: "1", // the install right after override fails
    });

    assert.equal(outputs.changed, "true");
    assert.equal(
      readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"),
      updateOnly,
      "should roll back to the update-only snapshot, not keep the broken override result",
    );
  });

  test("override mode creates pnpm-workspace.yaml from scratch, then its install fails: rollback deletes the file entirely", () => {
    // Regression test: a naive rollback that only restores pnpm-lock.yaml
    // (or only writes pnpm-workspace.yaml when a prior snapshot had one)
    // leaves a newly-created pnpm-workspace.yaml in place, committing
    // exactly the broken override config the rollback exists to discard.
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    const overrideBroken = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^2.0.0"].join(
      "\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    assert.equal(existsSync(join(repoDir, "pnpm-workspace.yaml")), false, "precondition: no workspace file yet");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      // update mode makes no changes (e.g. an exact-pinned dependency it
      // can't bump) — install #1 (a no-op) succeeds trivially.
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideBroken,
      FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: "overrides:\n  vulnerable-pkg@<2.0.0: '>=2.0.0'\n",
      FAKE_PNPM_INSTALL_FAIL_2: "1",
    });

    assert.equal(outputs.changed, "false");
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), before);
    assert.equal(
      existsSync(join(repoDir, "pnpm-workspace.yaml")),
      false,
      "the workspace file override mode created should be removed on rollback, not left behind",
    );
  });

  test("override mode creates pnpm-workspace.yaml from scratch and its install succeeds: the file is kept", () => {
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    const overrideFixed = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^2.0.0"].join(
      "\n",
    );
    const workspaceContent = "overrides:\n  vulnerable-pkg@<2.0.0: '>=2.0.0'\n";
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideFixed,
      FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: workspaceContent,
    });

    assert.equal(outputs.changed, "true");
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), overrideFixed);
    assert.equal(readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"), workspaceContent);
  });

  test("no advisories but two overlapping minimumReleaseAgeExclude entries exist for the same package: pruning alone flips changed=true", () => {
    const lockfile = ["importers:", "  .:", "    dependencies:", "      hono:", "        specifier: ^4.13.3"].join("\n");
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), lockfile);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(
      join(repoDir, "pnpm-workspace.yaml"),
      ["minimumReleaseAgeExclude:", "  - hono@4.12.27", "  - hono@4.13.3", ""].join("\n"),
    );
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({ FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}' });

    assert.equal(outputs.changed, "true");
    assert.equal(
      readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"),
      "minimumReleaseAgeExclude:\n  - hono@4.13.3\n",
    );
    assert.match(outputs.summary, /Removed `minimumReleaseAgeExclude` entries/);
    assert.match(outputs.summary, /hono@4\.12\.27/);
  });

  test("no advisories but an override targets a package no longer in the dependency tree: it gets pruned", () => {
    const lockfile = [
      "importers:",
      "  .:",
      "    dependencies:",
      "      live-pkg:",
      "        specifier: ^2.0.0",
      "packages:",
      "",
      "  live-pkg@2.0.0:",
      "    resolution: {integrity: sha512-x}",
      "",
    ].join("\n");
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), lockfile);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(repoDir, "pnpm-workspace.yaml"), ["overrides:", "  ghost-pkg@1: 2.0.0", ""].join("\n"));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");

    const outputs = runMain({ FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}' });

    assert.equal(outputs.changed, "true");
    assert.equal(
      readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"),
      "",
      "the overrides key emptied out entirely, leaving nothing else in the file",
    );
    assert.match(outputs.summary, /Removed `overrides` entries/);
    assert.match(outputs.summary, /ghost-pkg@1/);
  });
});
