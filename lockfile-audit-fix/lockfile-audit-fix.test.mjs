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
  parseOverrideSelector,
  parseVersionInterval,
  compareVersions,
  isIntervalSubset,
  dedupeOverrideEntries,
  parseOverrideLine,
  findOverridesBlock,
  dedupeWorkspaceOverrides,
  dedupePackageJsonOverrides,
  overrideTargetName,
  isMentioned,
  readLockfileOutsideOverrides,
  pruneOrphanedOverrideEntries,
  pruneOrphanedWorkspaceOverrides,
  pruneOrphanedPackageJsonOverrides,
  findTopLevelBlock,
  parseExcludeListItem,
  splitExcludeEntry,
  annotateMinimumReleaseAgeExclude,
  isYamlContentEmpty,
  pruneEmptyWorkspaceScaffold,
} from "./lockfile-audit-fix.mjs";

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

describe("parseOverrideSelector", () => {
  test("splits a plain name@range selector", () => {
    assert.deepEqual(parseOverrideSelector("brace-expansion@<1.1.18"), {
      name: "brace-expansion",
      range: "<1.1.18",
      nested: false,
    });
  });

  test("splits a scoped name@range selector on the second @", () => {
    assert.deepEqual(parseOverrideSelector("@faker-js/faker@<=10.4.0"), {
      name: "@faker-js/faker",
      range: "<=10.4.0",
      nested: false,
    });
  });

  test("treats a bare name (no range) as unconditional", () => {
    assert.deepEqual(parseOverrideSelector("trim"), { name: "trim", range: null, nested: false });
  });

  test("flags a nested parent>child selector so it's never deduped", () => {
    assert.deepEqual(parseOverrideSelector("foo>bar@1.0.0"), { name: "foo>bar@1.0.0", range: null, nested: true });
  });
});

describe("parseVersionInterval", () => {
  test("parses an upper-bound-only range", () => {
    assert.deepEqual(parseVersionInterval("<1.1.18"), {
      lower: null,
      lowerIncl: true,
      upper: "1.1.18",
      upperIncl: false,
    });
  });

  test("parses a lower-and-upper range", () => {
    assert.deepEqual(parseVersionInterval(">=3.0.0 <3.1.5"), {
      lower: "3.0.0",
      lowerIncl: true,
      upper: "3.1.5",
      upperIncl: false,
    });
  });

  test("parses an inclusive upper bound", () => {
    assert.deepEqual(parseVersionInterval(">=6.14.2 <=6.15.3"), {
      lower: "6.14.2",
      lowerIncl: true,
      upper: "6.15.3",
      upperIncl: true,
    });
  });

  test("parses a bare exact version as both bounds", () => {
    assert.deepEqual(parseVersionInterval("1.2.3"), { lower: "1.2.3", lowerIncl: true, upper: "1.2.3", upperIncl: true });
  });

  test("treats a null range as unconditional (unbounded both sides)", () => {
    assert.deepEqual(parseVersionInterval(null), { lower: null, lowerIncl: true, upper: null, upperIncl: true });
  });

  test("returns null for a range it doesn't recognize", () => {
    assert.equal(parseVersionInterval("1.2.3-rc.1 || 2.0.0"), null);
  });
});

describe("compareVersions", () => {
  test("compares dotted numeric versions", () => {
    assert.equal(compareVersions("1.1.16", "1.1.18"), -1);
    assert.equal(compareVersions("1.1.18", "1.1.16"), 1);
    assert.equal(compareVersions("1.1.18", "1.1.18"), 0);
  });

  test("strips a leading ^ or ~ before comparing", () => {
    assert.equal(compareVersions("^18.2.4", "^18.2.5"), -1);
    assert.equal(compareVersions("~1.2.3", "1.2.3"), 0);
  });

  test("returns null when a part isn't a plain integer", () => {
    assert.equal(compareVersions("1.2.3-rc.1", "1.2.3"), null);
  });
});

describe("isIntervalSubset", () => {
  test("a narrower upper-bounded range is a subset of a wider one", () => {
    const inner = parseVersionInterval("<1.1.16");
    const outer = parseVersionInterval("<1.1.18");
    assert.equal(isIntervalSubset(inner, outer), true);
    assert.equal(isIntervalSubset(outer, inner), false);
  });

  test("an inclusive upper bound is still a subset of a larger exclusive one", () => {
    const inner = parseVersionInterval(">=3.0.0 <=3.1.3");
    const outer = parseVersionInterval(">=3.0.0 <3.1.5");
    assert.equal(isIntervalSubset(inner, outer), true);
  });

  test("a narrower lower bound with a tighter upper bound is a subset", () => {
    const inner = parseVersionInterval(">=6.14.2 <=6.15.3");
    const outer = parseVersionInterval(">=2.2.5 <6.16.0");
    assert.equal(isIntervalSubset(inner, outer), true);
    assert.equal(isIntervalSubset(outer, inner), false);
  });

  test("an unconditional (null) range is a superset of everything", () => {
    const inner = parseVersionInterval("<1.1.18");
    const outer = parseVersionInterval(null);
    assert.equal(isIntervalSubset(inner, outer), true);
    assert.equal(isIntervalSubset(outer, inner), false);
  });
});

describe("dedupeOverrideEntries", () => {
  test("collapses brace-expansion's three accumulated upper-bound entries into the widest one", () => {
    const entries = [
      ["brace-expansion@<1.1.16", "1.1.18"],
      ["brace-expansion@<1.1.17", "1.1.18"],
      ["brace-expansion@<1.1.18", "1.1.18"],
    ];
    const { survivors, removedKeys } = dedupeOverrideEntries(entries);
    assert.deepEqual(survivors, [["brace-expansion@<1.1.18", "1.1.18"]]);
    assert.deepEqual(removedKeys.sort(), ["brace-expansion@<1.1.16", "brace-expansion@<1.1.17"]);
  });

  test("collapses fast-uri's three overlapping ranges (mixed <, <=) into the widest one", () => {
    const entries = [
      ["fast-uri@>=3.0.0 <3.1.3", "3.1.6"],
      ["fast-uri@>=3.0.0 <3.1.5", "3.1.6"],
      ["fast-uri@>=3.0.0 <=3.1.3", "3.1.6"],
    ];
    const { survivors } = dedupeOverrideEntries(entries);
    assert.deepEqual(survivors, [["fast-uri@>=3.0.0 <3.1.5", "3.1.6"]]);
  });

  test("drops the narrower-range entry even when its pinned version is older, as long as the wider entry's is newer", () => {
    const entries = [
      ["joi@>=18.0.0 <18.2.4", "^18.2.4"],
      ["joi@>=18.0.0 <18.2.5", "^18.2.5"],
    ];
    const { survivors } = dedupeOverrideEntries(entries);
    assert.deepEqual(survivors, [["joi@>=18.0.0 <18.2.5", "^18.2.5"]]);
  });

  test("drops a narrower-range entry nested inside a wider one even when the wider one was written first", () => {
    const entries = [
      ["qs@>=2.2.5 <6.16.0", "^6.16.0"],
      ["qs@>=6.14.2 <=6.15.3", "^6.16.0"],
    ];
    const { survivors } = dedupeOverrideEntries(entries);
    assert.deepEqual(survivors, [["qs@>=2.2.5 <6.16.0", "^6.16.0"]]);
  });

  test("keeps both entries when neither range is a subset of the other", () => {
    const entries = [
      ["pkg@<1.0.0", "1.0.0"],
      ["pkg@>=2.0.0 <3.0.0", "2.0.0"],
    ];
    const { survivors, removedKeys } = dedupeOverrideEntries(entries);
    assert.deepEqual(survivors, entries);
    assert.deepEqual(removedKeys, []);
  });

  test("keeps the narrower entry when its pinned version is newer than the wider entry's", () => {
    // The wider range's fix (1.0.0) wouldn't satisfy the narrower range's
    // requirement (1.0.1), so dropping the narrower entry would under-fix it.
    const entries = [
      ["pkg@<1.0.0", "1.0.1"],
      ["pkg@<2.0.0", "1.0.0"],
    ];
    const { survivors, removedKeys } = dedupeOverrideEntries(entries);
    assert.deepEqual(survivors, entries);
    assert.deepEqual(removedKeys, []);
  });

  test("keeps exactly one of two entries with an identical range and version (earlier one wins)", () => {
    const entries = [
      ["pkg@<1.0.0", "1.0.0"],
      ["pkg@<1.0.0 ", "1.0.0"], // a hypothetical differently-spaced duplicate selector
    ];
    const { survivors, removedKeys } = dedupeOverrideEntries(entries);
    assert.equal(survivors.length, 1);
    assert.deepEqual(survivors[0], entries[0]);
    assert.equal(removedKeys.length, 1);
  });

  test("leaves an unparsable range/version untouched", () => {
    const entries = [
      ["pkg@1.0.0-rc.1 || 2.0.0", "1.0.0"],
      ["pkg@<3.0.0", "3.0.0"],
    ];
    const { survivors, removedKeys } = dedupeOverrideEntries(entries);
    assert.deepEqual(survivors, entries);
    assert.deepEqual(removedKeys, []);
  });

  test("never touches nested parent>child selectors", () => {
    const entries = [
      ["foo>brace-expansion@<1.1.16", "1.1.18"],
      ["brace-expansion@<1.1.18", "1.1.18"],
    ];
    const { survivors, removedKeys } = dedupeOverrideEntries(entries);
    assert.deepEqual(survivors, entries);
    assert.deepEqual(removedKeys, []);
  });
});

describe("parseOverrideLine", () => {
  test("parses an unquoted key containing range operators", () => {
    assert.deepEqual(parseOverrideLine("  brace-expansion@<1.1.16: 1.1.18"), {
      key: "brace-expansion@<1.1.16",
      value: "1.1.18",
    });
  });

  test("unquotes a key that starts with @ (quoted because a plain scalar can't start with it)", () => {
    assert.deepEqual(parseOverrideLine('  "@faker-js/faker@<=10.4.0": ^10.5.0'), {
      key: "@faker-js/faker@<=10.4.0",
      value: "^10.5.0",
    });
  });

  test("returns null for a comment line", () => {
    assert.equal(parseOverrideLine("  # a comment: with a colon"), null);
  });

  test("returns null for a blank line", () => {
    assert.equal(parseOverrideLine("   "), null);
  });
});

describe("findOverridesBlock", () => {
  test("finds the header and end index, stopping at the next top-level key", () => {
    const lines = ["packages:", "  - packages/*", "", "overrides:", "  foo: 1.0.0", "  bar: 2.0.0", "other:", "  x: 1"];
    assert.deepEqual(findOverridesBlock(lines), { headerIdx: 3, endIdx: 6 });
  });

  test("treats a blank line inside the block as part of it, not a terminator", () => {
    const lines = ["overrides:", "  foo: 1.0.0", "", "  bar: 2.0.0"];
    assert.deepEqual(findOverridesBlock(lines), { headerIdx: 0, endIdx: 4 });
  });

  test("returns null when there's no overrides key", () => {
    assert.equal(findOverridesBlock(["packages:", "  - packages/*"]), null);
  });

  test("tolerates whitespace before the colon (valid YAML pnpm never emits, but a hand-edited file might)", () => {
    const lines = ["overrides :", "  foo: 1.0.0"];
    assert.deepEqual(findOverridesBlock(lines), { headerIdx: 0, endIdx: 2 });
  });

  test("tolerates a trailing inline comment on the header line", () => {
    const lines = ["minimumReleaseAgeExclude: # keep this list documented", "  - foo@1.0.0"];
    assert.deepEqual(findTopLevelBlock(lines, "minimumReleaseAgeExclude"), { headerIdx: 0, endIdx: 2 });
  });

  test("treats a column-0 comment between entries as part of the block, not a terminator", () => {
    // Regression test: a comment doesn't participate in YAML's indentation
    // structure, so it's valid to write one at column 0 between items of an
    // indented block. An earlier version treated any non-indented,
    // non-blank line as the next top-level key, so an entry after such a
    // comment silently fell outside the detected range and was never
    // pruned or annotated.
    const lines = [
      "overrides:",
      "  foo@<1: 1.0.0",
      "# a column-0 comment inside the block",
      "  bar@<1: 1.0.0",
      "other:",
      "  x: 1",
    ];
    assert.deepEqual(findOverridesBlock(lines), { headerIdx: 0, endIdx: 4 });
  });

  test("treats an indentationless block-sequence item (- at column 0) as part of the block", () => {
    // Regression test: YAML allows a sequence's `-` items to sit at the
    // same column as their own key (unlike a mapping's key: value
    // children, which always need deeper indentation) — e.g.
    // `minimumReleaseAgeExclude:\n- foo@1.0.0`. An earlier version treated
    // the first `-` line as ending the block, so the whole sequence was
    // invisible to annotate/prune.
    const lines = ["minimumReleaseAgeExclude:", "- foo@1.0.0", "- bar@2.0.0", "other:", "  x: 1"];
    assert.deepEqual(findTopLevelBlock(lines, "minimumReleaseAgeExclude"), { headerIdx: 0, endIdx: 3 });
  });

  test("stops before a top-level mapping key that begins with a hyphen", () => {
    const lines = ["overrides:", "  foo@<1: 1.0.0", "-feature: enabled", "other: true"];
    assert.deepEqual(findOverridesBlock(lines), { headerIdx: 0, endIdx: 2 });
  });
});

describe("findTopLevelBlock", () => {
  test("finds a block for an arbitrary top-level key, not just overrides", () => {
    const lines = [
      "minimumReleaseAge: 4320",
      "minimumReleaseAgeExclude:",
      "  - foo@1.0.0",
      "  - bar@2.0.0",
      "overrides:",
      "  baz: 1.0.0",
    ];
    assert.deepEqual(findTopLevelBlock(lines, "minimumReleaseAgeExclude"), { headerIdx: 1, endIdx: 4 });
  });

  test("returns null when the key isn't present", () => {
    assert.equal(findTopLevelBlock(["packages:", "  - packages/*"], "minimumReleaseAgeExclude"), null);
  });
});

describe("dedupeWorkspaceOverrides", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-dedupe-workspace-test-"));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("rewrites pnpm-workspace.yaml, dropping dominated entries and preserving the rest", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      [
        "packages:",
        "  - packages/*",
        "",
        "overrides:",
        "  brace-expansion@<1.1.16: 1.1.18",
        "  brace-expansion@<1.1.18: 1.1.18",
        "  nanoid@<3.3.18: 3.3.18",
        "",
      ].join("\n"),
    );

    const changed = dedupeWorkspaceOverrides(workspacePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.doesNotMatch(result, /brace-expansion@<1\.1\.16/);
    assert.match(result, /brace-expansion@<1\.1\.18: 1\.1\.18/);
    assert.match(result, /nanoid@<3\.3\.18: 3\.3\.18/);
    assert.match(result, /packages\/\*/); // untouched sections survive round-trip
  });

  test("removes a dominated entry's preceding comment along with it", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      [
        "overrides:",
        "  # a note about the narrower pin",
        "  brace-expansion@<1.1.16: 1.1.18",
        "  brace-expansion@<1.1.18: 1.1.18",
        "",
      ].join("\n"),
    );

    const changed = dedupeWorkspaceOverrides(workspacePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.doesNotMatch(result, /a note about the narrower pin/);
    assert.match(result, /brace-expansion@<1\.1\.18: 1\.1\.18/);
  });

  test("removing a dominated entry's keep-override marker doesn't leak it onto the next unrelated entry", () => {
    // Regression test for a real interaction bug: dedupeWorkspaceOverrides
    // used to delete only the dominated entry's own line, leaving its
    // preceding comment (here, a # keep-override: marker) to be read by
    // pruneOrphanedWorkspaceOverrides right after as belonging to whatever
    // entry happened to survive next instead.
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      [
        "overrides:",
        "  # keep-override: pinned ahead of the dependency landing",
        "  brace-expansion@<1.1.16: 1.1.18",
        "  brace-expansion@<1.1.18: 1.1.18",
        "  ghost-pkg@1: 2.0.0",
        "",
      ].join("\n"),
    );
    const lockfilePath = join(cwd, "pnpm-lock.yaml");
    writeFileSync(lockfilePath, ORPHAN_TEST_LOCKFILE);

    dedupeWorkspaceOverrides(workspacePath);
    const afterDedupe = readFileSync(workspacePath, "utf8");
    assert.doesNotMatch(afterDedupe, /keep-override/);

    const pruned = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(pruned, true);
    assert.doesNotMatch(
      readFileSync(workspacePath, "utf8"),
      /ghost-pkg/,
      "ghost-pkg should still be pruned as orphaned — the orphaned keep-override marker must not have attached to it",
    );
  });

  test("is a no-op when there is nothing to dedupe", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = readFileSync(workspacePath, "utf8");
    assert.equal(dedupeWorkspaceOverrides(workspacePath), false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("returns false when the file doesn't exist", () => {
    assert.equal(dedupeWorkspaceOverrides(join(cwd, "missing.yaml")), false);
  });

  test("returns false when the file has no overrides section", () => {
    const workspacePath = join(cwd, "no-overrides.yaml");
    writeFileSync(workspacePath, "packages:\n  - packages/*\n");
    assert.equal(dedupeWorkspaceOverrides(workspacePath), false);
  });
});

describe("dedupePackageJsonOverrides", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-dedupe-package-json-test-"));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("rewrites package.json's pnpm.overrides, dropping dominated entries", () => {
    const packageJsonPath = join(cwd, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify(
        {
          name: "root-pkg",
          pnpm: {
            overrides: {
              "joi@>=18.0.0 <18.2.4": "^18.2.4",
              "joi@>=18.0.0 <18.2.5": "^18.2.5",
            },
          },
        },
        null,
        2,
      ),
    );

    const changed = dedupePackageJsonOverrides(packageJsonPath);
    assert.equal(changed, true);

    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    assert.deepEqual(pkg.pnpm.overrides, { "joi@>=18.0.0 <18.2.5": "^18.2.5" });
    assert.equal(pkg.name, "root-pkg");
  });

  test("returns false when there is no pnpm.overrides object", () => {
    const packageJsonPath = join(cwd, "plain.json");
    writeFileSync(packageJsonPath, JSON.stringify({ name: "plain-pkg" }));
    assert.equal(dedupePackageJsonOverrides(packageJsonPath), false);
  });
});

// `ghost-pkg` appears only in this lockfile's own `overrides:` block — the
// trap readLockfileOutsideOverrides exists to defuse. `parent-pkg` is only
// reachable through a `parent>child` dep-path selector's parent half.
// `@scope/live` is a regular resolved dependency (its own `packages:`/
// `snapshots:` entry, reachable via a quoted `"@scope/live@<range>"`
// override key), while `linked-tool` is a workspace link, which never gets
// a `packages:` entry (so it only ever shows up as a bare importer key).
const ORPHAN_TEST_LOCKFILE = [
  "lockfileVersion: '9.0'",
  "",
  "settings:",
  "  autoInstallPeers: true",
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

describe("overrideTargetName", () => {
  test("reads the bare name from a plain name@range key", () => {
    assert.equal(overrideTargetName("brace-expansion@<1.1.18"), "brace-expansion");
  });

  test("reads the bare name from a scoped name@range key", () => {
    assert.equal(overrideTargetName("@faker-js/faker@<=10.4.0"), "@faker-js/faker");
  });

  test("resolves a nested parent>child selector to its parent", () => {
    assert.equal(overrideTargetName("parent-pkg>child-pkg"), "parent-pkg");
  });

  test("reads a bare name with no range as itself", () => {
    assert.equal(overrideTargetName("trim"), "trim");
  });
});

describe("isMentioned", () => {
  test("matches a resolved package key", () => {
    assert.equal(isMentioned("esbuild@0.28.1:\n  resolution: {}", "esbuild"), true);
  });

  test("matches a bare workspace-link key", () => {
    assert.equal(isMentioned("linked-tool:\n  specifier: workspace:*", "linked-tool"), true);
  });

  test("matches a quoted scoped bare key", () => {
    assert.equal(isMentioned("'@scope/live':\n  specifier: 1.0.0", "@scope/live"), true);
  });

  test("does not match a longer package name that merely contains it", () => {
    assert.equal(isMentioned("esbuild@0.28.1", "build"), false);
  });

  test("returns false when there is no mention at all", () => {
    assert.equal(isMentioned("some-other-pkg@1.0.0", "ghost-pkg"), false);
  });

  test("matches a pre-v6 underscore-joined peer-resolution suffix", () => {
    // Regression test: verified against a real `pnpm@7.33.7 install
    // --lockfile-only` output (lockfileVersion: 5.4), where a peer dep is
    // recorded as e.g. `eslint-plugin-react: 7.34.0_eslint@8.57.0` — the
    // peer's own name/version has no `@`/`:` of its own directly after it in
    // isolation, but is joined to the parent's version with `_`. An earlier
    // version excluded `_` from the boundary check, so `isMentioned(...,
    // "eslint")` returned false when this was the only occurrence, risking
    // deletion of a still-live override.
    assert.equal(isMentioned("  eslint-plugin-react: 7.34.0_eslint@8.57.0\n", "eslint"), true);
  });

  test("matches a pre-v6 slash-delimited package key", () => {
    // Regression test: verified against real pnpm@7.33.7 output — a v5/v6
    // lockfile's packages: section keys look like `/is-odd/3.0.1:` (leading
    // and trailing slash), not the v9 `is-odd@3.0.1:` form.
    assert.equal(isMentioned("  /is-odd/3.0.1:\n    resolution: {}\n", "is-odd"), true);
  });

  test("matches a pre-v6 scoped slash-delimited package key", () => {
    assert.equal(isMentioned("  /@scope/live/1.0.0:\n    resolution: {}\n", "@scope/live"), true);
  });
});

describe("readLockfileOutsideOverrides", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-read-lockfile-test-"));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("excludes the lockfile's own overrides: block but keeps the rest", () => {
    const lockfilePath = join(cwd, "pnpm-lock.yaml");
    writeFileSync(lockfilePath, ORPHAN_TEST_LOCKFILE);

    const text = readLockfileOutsideOverrides(lockfilePath);
    assert.doesNotMatch(text, /ghost-pkg@1: 2\.0\.0/);
    assert.match(text, /esbuild@0\.28\.1/);
  });

  test("returns null when the file doesn't exist", () => {
    assert.equal(readLockfileOutsideOverrides(join(cwd, "missing.yaml")), null);
  });

  test("accepts a lockfile whose packages: key is the inline empty-map form", () => {
    const lockfilePath = join(cwd, "empty-packages-lock.yaml");
    writeFileSync(
      lockfilePath,
      ["lockfileVersion: '9.0'", "", "importers:", "", "  .: {}", "", "packages: {}", ""].join("\n"),
    );
    const text = readLockfileOutsideOverrides(lockfilePath);
    assert.notEqual(text, null);
  });

  test("still recognizes a real lockfile with no packages: key at all (a workspace whose external dependencies have all been removed)", () => {
    // Verified against a real `pnpm install`: a workspace where every
    // importer only depends on other workspace packages gets no `packages:`
    // key in pnpm-lock.yaml whatsoever, not even an empty `packages: {}`.
    // Checking lockfileVersion: instead of packages: means pruning still
    // runs here — the exact case this feature most needs to catch, since
    // an override can only exist because its target was once in the tree,
    // and "the tree emptied out entirely" is one real way for that target
    // to have left it.
    const lockfilePath = join(cwd, "workspace-only-lock.yaml");
    writeFileSync(
      lockfilePath,
      ["lockfileVersion: '9.0'", "", "importers:", "", "  .: {}", "", "  packages/a: {}", ""].join("\n"),
    );
    const text = readLockfileOutsideOverrides(lockfilePath);
    assert.notEqual(text, null);
    assert.match(text, /packages\/a/);
  });

  test("returns null when the file doesn't look like a real lockfile", () => {
    const notALockfile = join(cwd, "not-a-lockfile.yaml");
    writeFileSync(notALockfile, "overrides:\n  foo: 1.0.0\n");
    assert.equal(readLockfileOutsideOverrides(notALockfile), null);
  });
});

describe("pruneOrphanedOverrideEntries", () => {
  // pruneOrphanedOverrideEntries takes the dependency-tree text as-is (it
  // doesn't strip an overrides: block itself — that's readLockfileOutsideOverrides's
  // job), so the fixture here must not contain one; otherwise `ghost-pkg`
  // would look "mentioned" off the back of its own override entry.
  let treeText;

  before(() => {
    const dir = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-prune-entries-test-"));
    const lockfilePath = join(dir, "pnpm-lock.yaml");
    writeFileSync(lockfilePath, ORPHAN_TEST_LOCKFILE);
    treeText = readLockfileOutsideOverrides(lockfilePath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("drops an entry whose target package isn't mentioned in the tree", () => {
    const entries = [
      ["esbuild@<0.28.1", "0.28.1"],
      ["ghost-pkg@1", "2.0.0"],
    ];
    const { survivors, removedKeys } = pruneOrphanedOverrideEntries(entries, treeText);
    assert.deepEqual(survivors, [["esbuild@<0.28.1", "0.28.1"]]);
    assert.deepEqual(removedKeys, ["ghost-pkg@1"]);
  });

  test("keeps an entry reachable through a parent>child dep-path selector", () => {
    const entries = [["parent-pkg>child-pkg", "3.0.0"]];
    const { survivors, removedKeys } = pruneOrphanedOverrideEntries(entries, treeText);
    assert.deepEqual(survivors, entries);
    assert.deepEqual(removedKeys, []);
  });

  test("keeps an entry pinning a workspace-linked package", () => {
    const entries = [["linked-tool@<1", "1.0.0"]];
    const { survivors, removedKeys } = pruneOrphanedOverrideEntries(entries, treeText);
    assert.deepEqual(survivors, entries);
    assert.deepEqual(removedKeys, []);
  });

  test("keeps a scoped entry reachable through a resolved packages: key", () => {
    // Unquoted here, matching how this function actually receives keys:
    // parseOverrideLine already strips YAML quoting before
    // pruneOrphanedWorkspaceOverrides calls overrideTargetName, and a
    // package.json key is never quote-wrapped to begin with. The quoted
    // YAML-line form is covered separately at the
    // pruneOrphanedWorkspaceOverrides level below.
    const entries = [["@scope/live@<1", "1.0.0"]];
    const { survivors, removedKeys } = pruneOrphanedOverrideEntries(entries, treeText);
    assert.deepEqual(survivors, entries);
    assert.deepEqual(removedKeys, []);
  });
});

describe("pruneOrphanedWorkspaceOverrides", () => {
  let cwd;
  let lockfilePath;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-prune-workspace-test-"));
    lockfilePath = join(cwd, "pnpm-lock.yaml");
    writeFileSync(lockfilePath, ORPHAN_TEST_LOCKFILE);
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("drops an orphaned entry and its attached comment, keeping a live entry", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      [
        "packages:",
        "  - packages/*",
        "",
        "overrides:",
        "  esbuild@<0.28.1: 0.28.1",
        "  # a note about a dead pin",
        "  ghost-pkg@1: 2.0.0",
        "",
      ].join("\n"),
    );

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.match(result, /esbuild@<0\.28\.1: 0\.28\.1/);
    assert.doesNotMatch(result, /ghost-pkg/);
    assert.doesNotMatch(result, /a note about a dead pin/);
    assert.match(result, /packages\/\*/); // untouched sections survive round-trip
  });

  test("keeps an override used by a sibling project lockfile", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const siblingDir = join(cwd, "packages", "app");
    const siblingLockfilePath = join(siblingDir, "pnpm-lock.yaml");
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(workspacePath, ["overrides:", "  is-odd: 3.0.1", ""].join("\n"));
    writeFileSync(
      siblingLockfilePath,
      ["lockfileVersion: '9.0'", "", "packages:", "", "  is-odd@3.0.1:", "    resolution: {}", ""].join("\n"),
    );

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath, [siblingLockfilePath]);

    assert.equal(changed, false);
    assert.match(readFileSync(workspacePath, "utf8"), /is-odd: 3\.0\.1/);
  });

  test("honours a keep-override opt-out comment", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["overrides:", "  # keep-override: pinned ahead of the dependency landing", "  future-pkg@<9: 9.0.0", ""].join(
        "\n",
      ),
    );

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(changed, false);
    assert.match(readFileSync(workspacePath, "utf8"), /future-pkg@<9: 9\.0\.0/);
  });

  test("keeps a plain comment attached to a live entry untouched", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["overrides:", "  # pinned for a known transitive issue", "  esbuild@<0.28.1: 0.28.1", ""].join("\n"),
    );

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(changed, false);
    const result = readFileSync(workspacePath, "utf8");
    assert.match(result, /# pinned for a known transitive issue/);
    assert.match(result, /esbuild@<0\.28\.1: 0\.28\.1/);
  });

  test("drops a quoted scoped orphaned entry (unquote -> scope-aware name -> mention check, end to end)", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["overrides:", '  "@scope/dead@<1": 1.0.0', "  esbuild@<0.28.1: 0.28.1", ""].join("\n"),
    );

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(changed, true);
    const result = readFileSync(workspacePath, "utf8");
    assert.doesNotMatch(result, /@scope\/dead/);
    assert.match(result, /esbuild@<0\.28\.1: 0\.28\.1/);
  });

  test("removes the whole overrides: key once its last entry is pruned", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(workspacePath, ["packages:", "  - packages/*", "", "overrides:", "  ghost-pkg@1: 2.0.0", ""].join("\n"));

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.doesNotMatch(result, /overrides:/);
    assert.match(result, /packages\/\*/);
  });

  test("preserves a trailing column-0 comment when removing the now-empty overrides: key", () => {
    // Regression test: when the block collapses to empty, the header-removal
    // branch used to discard the whole `kept` array (which, in this
    // situation, only ever holds comments/blanks not attached to the
    // removed entry — anything genuinely attached to it was already dropped
    // alongside it), silently deleting an unrelated trailing comment along
    // with the pointless `overrides:` key.
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      [
        "packages:",
        "  - packages/*",
        "",
        "overrides:",
        "  ghost-pkg@1: 2.0.0",
        "# a note for the section below, not for ghost-pkg",
        "other:",
        "  x: 1",
        "",
      ].join("\n"),
    );

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.doesNotMatch(result, /overrides:/);
    assert.match(result, /# a note for the section below, not for ghost-pkg/);
    assert.match(result, /other:/);
  });

  test("keeps a quoted scoped entry reachable through a resolved packages: key", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = ["overrides:", '  "@scope/live@<1": 1.0.0', ""].join("\n");
    writeFileSync(workspacePath, original);

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("is a no-op when the lockfile can't be read (abstains rather than guesses)", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = ["overrides:", "  ghost-pkg@1: 2.0.0", ""].join("\n");
    writeFileSync(workspacePath, original);

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, join(cwd, "missing-lockfile.yaml"));
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("still prunes when the lockfile has no packages: block at all (the tree emptied out entirely)", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(workspacePath, ["overrides:", "  ghost-pkg@1: 2.0.0", ""].join("\n"));
    const noPackagesLockfilePath = join(cwd, "no-packages-lock.yaml");
    writeFileSync(noPackagesLockfilePath, "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n");

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, noPackagesLockfilePath);
    assert.equal(changed, true);
    assert.doesNotMatch(readFileSync(workspacePath, "utf8"), /ghost-pkg/);
  });

  test("is idempotent: a second run makes no further changes", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["overrides:", "  esbuild@<0.28.1: 0.28.1", "  ghost-pkg@1: 2.0.0", ""].join("\n"),
    );

    assert.equal(pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath), true);
    const afterFirstRun = readFileSync(workspacePath, "utf8");
    assert.equal(pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath), false);
    assert.equal(readFileSync(workspacePath, "utf8"), afterFirstRun);
  });

  test("prunes an entry that sits after a column-0 comment inside the block", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      [
        "overrides:",
        "  esbuild@<0.28.1: 0.28.1",
        "# a column-0 comment inside the block",
        "  ghost-pkg@1: 2.0.0",
        "",
      ].join("\n"),
    );

    const changed = pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath);
    assert.equal(changed, true);
    const result = readFileSync(workspacePath, "utf8");
    assert.doesNotMatch(result, /ghost-pkg/);
    assert.match(result, /esbuild@<0\.28\.1: 0\.28\.1/);
  });

  test("returns false when the file doesn't exist", () => {
    assert.equal(pruneOrphanedWorkspaceOverrides(join(cwd, "missing.yaml"), lockfilePath), false);
  });

  test("returns false when the file has no overrides section", () => {
    const workspacePath = join(cwd, "no-overrides.yaml");
    writeFileSync(workspacePath, "packages:\n  - packages/*\n");
    assert.equal(pruneOrphanedWorkspaceOverrides(workspacePath, lockfilePath), false);
  });
});

describe("pruneOrphanedPackageJsonOverrides", () => {
  let cwd;
  let lockfilePath;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-prune-package-json-test-"));
    lockfilePath = join(cwd, "pnpm-lock.yaml");
    writeFileSync(lockfilePath, ORPHAN_TEST_LOCKFILE);
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("drops an orphaned entry from package.json's pnpm.overrides", () => {
    const packageJsonPath = join(cwd, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify(
        {
          name: "root-pkg",
          pnpm: { overrides: { "esbuild@<0.28.1": "0.28.1", "ghost-pkg@1": "2.0.0" } },
        },
        null,
        2,
      ),
    );

    const changed = pruneOrphanedPackageJsonOverrides(packageJsonPath, lockfilePath);
    assert.equal(changed, true);

    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    assert.deepEqual(pkg.pnpm.overrides, { "esbuild@<0.28.1": "0.28.1" });
    assert.equal(pkg.name, "root-pkg");
  });

  test("keeps an override used by an additional project lockfile", () => {
    const packageJsonPath = join(cwd, "package-with-sibling-lockfile.json");
    const siblingLockfilePath = join(cwd, "sibling-pnpm-lock.yaml");
    writeFileSync(packageJsonPath, JSON.stringify({ name: "root-pkg", pnpm: { overrides: { "is-odd": "3.0.1" } } }));
    writeFileSync(siblingLockfilePath, "lockfileVersion: '9.0'\n\npackages:\n\n  is-odd@3.0.1:\n    resolution: {}\n");

    const changed = pruneOrphanedPackageJsonOverrides(packageJsonPath, lockfilePath, [siblingLockfilePath]);

    assert.equal(changed, false);
    assert.deepEqual(JSON.parse(readFileSync(packageJsonPath, "utf8")).pnpm.overrides, { "is-odd": "3.0.1" });
  });

  test("drops the pnpm.overrides key entirely (and pnpm too) once every entry is orphaned", () => {
    // Regression test: unlike dedupe (which always keeps at least one
    // survivor per package), orphan-pruning can empty the overrides object
    // out completely — leaving `pnpm.overrides: {}` (or `pnpm: {}`) behind
    // is pointless clutter.
    const packageJsonPath = join(cwd, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "root-pkg", pnpm: { overrides: { "ghost-pkg@1": "2.0.0" } } }, null, 2),
    );

    const changed = pruneOrphanedPackageJsonOverrides(packageJsonPath, lockfilePath);
    assert.equal(changed, true);

    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    assert.equal(pkg.pnpm, undefined);
    assert.equal(pkg.name, "root-pkg");
  });

  test("drops only the overrides key, keeping other pnpm settings, once every entry is orphaned", () => {
    const packageJsonPath = join(cwd, "package.json");
    writeFileSync(
      packageJsonPath,
      JSON.stringify(
        { name: "root-pkg", pnpm: { overrides: { "ghost-pkg@1": "2.0.0" }, autoInstallPeers: false } },
        null,
        2,
      ),
    );

    const changed = pruneOrphanedPackageJsonOverrides(packageJsonPath, lockfilePath);
    assert.equal(changed, true);

    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    assert.equal(pkg.pnpm.overrides, undefined);
    assert.equal(pkg.pnpm.autoInstallPeers, false);
  });

  test("returns false when there is no pnpm.overrides object", () => {
    const packageJsonPath = join(cwd, "plain.json");
    writeFileSync(packageJsonPath, JSON.stringify({ name: "plain-pkg" }));
    assert.equal(pruneOrphanedPackageJsonOverrides(packageJsonPath, lockfilePath), false);
  });

  test("is a no-op when the lockfile can't be read", () => {
    const packageJsonPath = join(cwd, "unreadable-lockfile.json");
    const original = { name: "root-pkg", pnpm: { overrides: { "ghost-pkg@1": "2.0.0" } } };
    writeFileSync(packageJsonPath, JSON.stringify(original, null, 2));

    const changed = pruneOrphanedPackageJsonOverrides(packageJsonPath, join(cwd, "missing-lockfile.yaml"));
    assert.equal(changed, false);
    assert.deepEqual(JSON.parse(readFileSync(packageJsonPath, "utf8")), original);
  });
});

describe("isYamlContentEmpty", () => {
  test("treats a blank string as empty", () => {
    assert.equal(isYamlContentEmpty("\n"), true);
  });

  test("treats comment-only content as empty", () => {
    assert.equal(isYamlContentEmpty("# just a note\n\n# another\n"), true);
  });

  test("treats any real content as non-empty", () => {
    assert.equal(isYamlContentEmpty("packages:\n  - packages/*\n"), false);
  });
});

describe("pruneEmptyWorkspaceScaffold", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-prune-scaffold-test-"));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("deletes a blank file this run created (originalWorkspaceText is null)", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(workspacePath, "\n");

    const deleted = pruneEmptyWorkspaceScaffold(workspacePath, null);
    assert.equal(deleted, true);
    assert.equal(existsSync(workspacePath), false);
  });

  test("deletes a comment-only file this run created (a stray trailing comment isn't meaningful content)", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(workspacePath, "# a note for the section below, not for ghost-pkg\n");

    const deleted = pruneEmptyWorkspaceScaffold(workspacePath, null);
    assert.equal(deleted, true);
    assert.equal(existsSync(workspacePath), false);
  });

  test("leaves a blank file alone if it already existed before this run", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(workspacePath, "\n");

    const deleted = pruneEmptyWorkspaceScaffold(workspacePath, "packages:\n  - packages/*\n");
    assert.equal(deleted, false);
    assert.equal(existsSync(workspacePath), true);
  });

  test("leaves a newly created file alone if it still has meaningful content", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(workspacePath, "overrides:\n  foo@<1: 1.0.0\n");

    const deleted = pruneEmptyWorkspaceScaffold(workspacePath, null);
    assert.equal(deleted, false);
    assert.equal(existsSync(workspacePath), true);
  });

  test("returns false when the file doesn't exist", () => {
    assert.equal(pruneEmptyWorkspaceScaffold(join(cwd, "missing.yaml"), null), false);
  });
});

describe("parseExcludeListItem", () => {
  test("parses an unquoted list item", () => {
    assert.equal(parseExcludeListItem("  - fast-uri@3.1.6"), "fast-uri@3.1.6");
  });

  test("unquotes a double-quoted list item", () => {
    assert.equal(parseExcludeListItem('  - "fast-uri@3.1.6"'), "fast-uri@3.1.6");
  });

  test("unquotes a single-quoted scoped bare name (no false version from the leading @)", () => {
    // Regression test: an earlier version only stripped double quotes, so
    // `'@scope/pkg'` came back as the literal string "'@scope/pkg'" (quotes
    // included) — splitExcludeEntry then read the leading `'` as the name
    // and everything after the `@` (including the trailing `'`) as a bogus
    // version, wrongly marking a bare (unversioned) entry as version-pinned.
    assert.equal(parseExcludeListItem("  - '@scope/pkg'"), "@scope/pkg");
  });

  test("unquotes a single-quoted scoped bare name with a trailing inline comment", () => {
    // Regression test: matching to the closing quote (not to end of line)
    // means a trailing "# ..." comment is simply never included, rather
    // than defeating the value.endsWith(quote) check an earlier version
    // relied on and leaking the comment text into a later marker comment.
    assert.equal(parseExcludeListItem("  - '@scope/pkg' # kept for backward compat"), "@scope/pkg");
  });

  test("drops a trailing inline comment on an unquoted entry", () => {
    assert.equal(parseExcludeListItem("  - fast-uri@3.1.6 # kept for backward compat"), "fast-uri@3.1.6");
  });

  test("returns null for a comment line", () => {
    assert.equal(parseExcludeListItem("  # a comment"), null);
  });

  test("returns null for a blank line", () => {
    assert.equal(parseExcludeListItem("   "), null);
  });
});

describe("splitExcludeEntry", () => {
  test("splits a versioned entry", () => {
    assert.deepEqual(splitExcludeEntry("fast-uri@3.1.6"), { name: "fast-uri", version: "3.1.6" });
  });

  test("splits a scoped versioned entry on the second @", () => {
    assert.deepEqual(splitExcludeEntry("@faker-js/faker@10.5.0"), { name: "@faker-js/faker", version: "10.5.0" });
  });

  test("treats a bare name (no version) as having a null version", () => {
    assert.deepEqual(splitExcludeEntry("is-odd"), { name: "is-odd", version: null });
  });
});

describe("annotateMinimumReleaseAgeExclude", () => {
  let cwd;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "lockfile-audit-fix-annotate-exclude-test-"));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("inserts a marker comment above a versioned entry with none", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["minimumReleaseAge: 4320", "minimumReleaseAgeExclude:", "  - fast-uri@3.1.6", ""].join("\n"),
    );

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.match(result, /# Renovate security update: fast-uri@3\.1\.6\n {2}- fast-uri@3\.1\.6/);
  });

  test("does not duplicate an already-present marker comment", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = [
      "minimumReleaseAgeExclude:",
      "  # Renovate security update: fast-uri@3.1.6",
      "  - fast-uri@3.1.6",
      "",
    ].join("\n");
    writeFileSync(workspacePath, original);

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("recognizes an existing marker case-insensitively and with extra whitespace", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = [
      "minimumReleaseAgeExclude:",
      "  #   renovate security update  :   fast-uri@3.1.6",
      "  - fast-uri@3.1.6",
      "",
    ].join("\n");
    writeFileSync(workspacePath, original);

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("keeps an unrelated existing comment and adds the marker alongside it", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["minimumReleaseAgeExclude:", "  # pinned intentionally", "  - fast-uri@3.1.6", ""].join("\n"),
    );

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.match(result, /# pinned intentionally\n {2}# Renovate security update: fast-uri@3\.1\.6\n {2}- fast-uri@3\.1\.6/);
  });

  test("inserts a new marker when an existing one isn't the nearest comment (matches renovate-policy-check.mjs, which only reads the nearest one)", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      [
        "minimumReleaseAgeExclude:",
        "  # Renovate security update: fast-uri@3.1.6",
        "  # a later, unrelated note",
        "  - fast-uri@3.1.6",
        "",
      ].join("\n"),
    );

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.match(
      result,
      /# Renovate security update: fast-uri@3\.1\.6\n {2}# a later, unrelated note\n {2}# Renovate security update: fast-uri@3\.1\.6\n {2}- fast-uri@3\.1\.6/,
    );
  });

  test("leaves a bare (unversioned) entry untouched", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = ["minimumReleaseAgeExclude:", "  - is-odd", ""].join("\n");
    writeFileSync(workspacePath, original);

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("leaves a tag-pinned entry (not a numeric version) untouched", () => {
    // renovate-policy-check.mjs's own versionPinned check is /@\d/, so
    // "foo@latest" was never subject to the marker requirement — marking it
    // anyway would mislabel a tag/range exclude as an automated security
    // update.
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = ["minimumReleaseAgeExclude:", "  - is-odd@latest", ""].join("\n");
    writeFileSync(workspacePath, original);

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("leaves a range-pinned entry (not a numeric version) untouched", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = ["minimumReleaseAgeExclude:", "  - is-odd@^1.2.3", ""].join("\n");
    writeFileSync(workspacePath, original);

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("leaves a bare single-quoted scoped name untouched (no false version from the leading @)", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = ["minimumReleaseAgeExclude:", "  - '@scope/pkg'", ""].join("\n");
    writeFileSync(workspacePath, original);

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("leaves a bare single-quoted scoped name with a trailing inline comment untouched", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    const original = ["minimumReleaseAgeExclude:", "  - '@scope/pkg' # kept for backward compat", ""].join("\n");
    writeFileSync(workspacePath, original);

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, false);
    assert.equal(readFileSync(workspacePath, "utf8"), original);
  });

  test("preserves the original quoting of the list item itself", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["minimumReleaseAgeExclude:", '  - "fast-uri@3.1.6"', ""].join("\n"),
    );

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.match(result, /# Renovate security update: fast-uri@3\.1\.6\n {2}- "fast-uri@3\.1\.6"/);
  });

  test("annotates multiple independent versioned entries", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["minimumReleaseAgeExclude:", "  - fast-uri@3.1.6", "  - esbuild@0.28.1", ""].join("\n"),
    );

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.match(result, /# Renovate security update: fast-uri@3\.1\.6/);
    assert.match(result, /# Renovate security update: esbuild@0\.28\.1/);
  });

  test("annotates an indentationless block-sequence item, matching its own (lack of) indent", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(workspacePath, ["minimumReleaseAgeExclude:", "- fast-uri@3.1.6", ""].join("\n"));

    const changed = annotateMinimumReleaseAgeExclude(workspacePath);
    assert.equal(changed, true);

    const result = readFileSync(workspacePath, "utf8");
    assert.match(result, /^# Renovate security update: fast-uri@3\.1\.6\n- fast-uri@3\.1\.6/m);
  });

  test("returns false when the file doesn't exist", () => {
    assert.equal(annotateMinimumReleaseAgeExclude(join(cwd, "missing.yaml")), false);
  });

  test("returns false when there's no minimumReleaseAgeExclude section", () => {
    const workspacePath = join(cwd, "no-exclude.yaml");
    writeFileSync(workspacePath, "packages:\n  - packages/*\n");
    assert.equal(annotateMinimumReleaseAgeExclude(workspacePath), false);
  });

  test("is idempotent: a second run makes no further changes", () => {
    const workspacePath = join(cwd, "pnpm-workspace.yaml");
    writeFileSync(
      workspacePath,
      ["minimumReleaseAgeExclude:", "  - fast-uri@3.1.6", "  - esbuild@0.28.1", ""].join("\n"),
    );

    assert.equal(annotateMinimumReleaseAgeExclude(workspacePath), true);
    const afterFirstRun = readFileSync(workspacePath, "utf8");
    assert.equal(annotateMinimumReleaseAgeExclude(workspacePath), false);
    assert.equal(readFileSync(workspacePath, "utf8"), afterFirstRun);
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
 *   FAKE_PNPM_INSTALL_<n>_EXTRA_LOCKFILE - if set, writes this content to
 *                                    FAKE_PNPM_EXTRA_LOCKFILE_PATH during
 *                                    the n-th install
 *   FAKE_PNPM_DEDUPE_FAIL_<n>      - same, for the n-th `pnpm dedupe` call
 *                                    (only made when pnpm-workspace.yaml
 *                                    mentions minimumReleaseAgeExclude)
 *   FAKE_PNPM_LIST_JSON             - stdout for `pnpm list --recursive`
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
    '  writeFileSync(`${process.env.FAKE_PNPM_STATE}/install-${n}-args`, JSON.stringify(args));',
    '  const extraLockfile = process.env[`FAKE_PNPM_INSTALL_${n}_EXTRA_LOCKFILE`];',
    '  if (extraLockfile !== undefined) writeFileSync(process.env.FAKE_PNPM_EXTRA_LOCKFILE_PATH, extraLockfile);',
    '  if (process.env[`FAKE_PNPM_INSTALL_FAIL_${n}`] === "1") {',
    '    process.stderr.write("install failed\\n");',
    "    process.exit(1);",
    "  }",
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "dedupe") {',
    '  const n = nextCount("dedupe");',
    '  writeFileSync(`${process.env.FAKE_PNPM_STATE}/dedupe-${n}-args`, JSON.stringify(args));',
    '  if (process.env[`FAKE_PNPM_DEDUPE_FAIL_${n}`] === "1") {',
    '    process.stderr.write("dedupe failed\\n");',
    "    process.exit(1);",
    "  }",
    "  process.exit(0);",
    "}",
    "",
    'if (args[0] === "list") {',
    '  process.stdout.write(process.env.FAKE_PNPM_LIST_JSON ?? JSON.stringify([{ path: process.cwd() }]));',
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

  // Captures stdout to `${stateDir}/last-stdout.txt` (rather than returning
  // it directly) so existing call sites destructuring just the outputs
  // object don't need to change; only the handful of tests that care about
  // the console.log warning text read that file.
  const runMain = (env) => {
    outputFile = join(stateDir, `output-${Math.random().toString(36).slice(2)}`);
    writeFileSync(outputFile, "");
    const stdout = execFileSync("node", [join(__dirname, "lockfile-audit-fix.mjs")], {
      cwd: repoDir,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        FAKE_PNPM_STATE: stateDir,
        GITHUB_OUTPUT: outputFile,
        ...env,
      },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    writeFileSync(join(stateDir, "last-stdout.txt"), stdout);
    return parseGithubOutput(readFileSync(outputFile, "utf8"));
  };

  test("no advisories: reports no changes and doesn't touch the lockfile", () => {
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "clean\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    const outputs = runMain({ FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}' });

    assert.equal(outputs.changed, "false");
    assert.equal(outputs["runtime-deps-changed"], "false");
    assert.equal(outputs["changed-names"], "");
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), "clean\n");

    const installArgs = JSON.parse(readFileSync(join(stateDir, "install-1-args"), "utf8"));
    assert.ok(
      installArgs.includes("--config.minimum-release-age-exclude-prune=true"),
      "verifyInstallable should ask pnpm install to prune stale minimumReleaseAgeExclude entries",
    );
    assert.equal(
      existsSync(join(stateDir, "dedupe-1-args")),
      false,
      "dedupe should be skipped when the repo has no pnpm-workspace.yaml to prune",
    );
  });

  test("no advisories, pnpm-workspace.yaml exists but mentions no minimumReleaseAgeExclude: dedupe is still skipped", () => {
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "clean\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "trustPolicy: no-downgrade\n");
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    try {
      runMain({ FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}' });

      assert.equal(
        existsSync(join(stateDir, "dedupe-1-args")),
        false,
        "dedupe should be skipped when pnpm-workspace.yaml has nothing to prune",
      );
    } finally {
      // Leaving this behind would break later tests' "no pnpm-workspace.yaml yet" preconditions.
      rmSync(join(repoDir, "pnpm-workspace.yaml"), { force: true });
    }
  });

  test("no advisories, but pnpm-workspace.yaml has a minimumReleaseAgeExclude list: dedupe also gets the prune flag", () => {
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "clean\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(
      join(repoDir, "pnpm-workspace.yaml"),
      ["minimumReleaseAge: 4320", "minimumReleaseAgeExclude:", "  - foo@1.0.0", ""].join("\n"),
    );
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    try {
      runMain({ FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}' });

      const dedupeArgs = JSON.parse(readFileSync(join(stateDir, "dedupe-1-args"), "utf8"));
      assert.ok(
        dedupeArgs.includes("--config.minimum-release-age-exclude-prune=true"),
        "verifyInstallable should run pnpm dedupe with the prune flag when there's a minimumReleaseAgeExclude " +
          "list, since install skips re-resolution (and so the prune) when the lockfile is already up to date",
      );
    } finally {
      // Leaving this behind would break later tests' "no pnpm-workspace.yaml yet" preconditions.
      rmSync(join(repoDir, "pnpm-workspace.yaml"), { force: true });
    }
  });

  test("no advisories, but pnpm-workspace.yaml has a pre-existing unannotated minimumReleaseAgeExclude entry: it gets backfilled, reporting changed=true", () => {
    // annotateMinimumReleaseAgeExclude runs unconditionally (like the
    // override dedupe/prune calls it sits next to), so a legacy entry from
    // before this feature existed gets its marker comment backfilled even
    // on a run that finds no advisories to fix and makes no override
    // changes of its own.
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "clean\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(
      join(repoDir, "pnpm-workspace.yaml"),
      ["minimumReleaseAge: 4320", "minimumReleaseAgeExclude:", "  - foo@1.0.0", ""].join("\n"),
    );
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    try {
      const outputs = runMain({ FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}' });

      assert.equal(outputs.changed, "true");
      assert.match(
        readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"),
        /# Renovate security update: foo@1\.0\.0\n {2}- foo@1\.0\.0/,
      );
    } finally {
      rmSync(join(repoDir, "pnpm-workspace.yaml"), { force: true });
    }
  });

  test("install succeeds but dedupe fails: rolls back and reports dedupe (not install) as the failed step", () => {
    // The exclude entry here is pre-annotated so annotateMinimumReleaseAgeExclude
    // is a no-op and this test stays about the install/dedupe rollback path
    // only; the backfill-on-a-legacy-entry behavior itself has its own test
    // above ("...it gets backfilled, reporting changed=true").
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "clean\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(
      join(repoDir, "pnpm-workspace.yaml"),
      [
        "minimumReleaseAge: 4320",
        "minimumReleaseAgeExclude:",
        "  # Renovate security update: foo@1.0.0",
        "  - foo@1.0.0",
        "",
      ].join("\n"),
    );
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    try {
      const outputs = runMain({
        FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
        FAKE_PNPM_DEDUPE_FAIL_1: "1",
      });

      // The first dedupe call (during the update-mode verify) fails and
      // gets rolled back; the second (during the override-mode verify, a
      // no-op fix) succeeds, so the end state matches the untouched
      // original.
      assert.equal(outputs.changed, "false");
      assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), "clean\n");

      const stdout = readFileSync(join(stateDir, "last-stdout.txt"), "utf8");
      assert.match(stdout, /pnpm dedupe failed/, "the rollback warning should name dedupe as the failed step");
      assert.doesNotMatch(
        stdout,
        /pnpm install failed/,
        "the rollback warning should not blame install when dedupe was what actually failed",
      );
    } finally {
      rmSync(join(repoDir, "pnpm-workspace.yaml"), { force: true });
    }
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
    writeFileSync(join(stateDir, "dedupe-count"), "0");

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
    writeFileSync(join(stateDir, "dedupe-count"), "0");

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
    writeFileSync(join(stateDir, "dedupe-count"), "0");

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

  test("workspace lockfile discovery failure happens before any fix mutates files", () => {
    const before = "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      vulnerable-pkg:\n        specifier: ^1.0.0\n";
    const updateOnly = before.replace("^1.0.0", "^1.0.1");
    const overrideBroken = before.replace("^1.0.0", "^2.0.0");
    const workspaceBefore = "packages:\n  - packages/*\n";
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(repoDir, "pnpm-workspace.yaml"), workspaceBefore);
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    assert.throws(() => {
      runMain({
        FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
        FAKE_PNPM_FIX_UPDATE_LOCKFILE: updateOnly,
        FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideBroken,
        FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: "overrides:\n  vulnerable-pkg@<2.0.0: 2.0.0\n",
        FAKE_PNPM_LIST_JSON: "not-json",
      });
    });

    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), before);
    assert.equal(readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"), workspaceBefore);
  });

  test("failed override verification restores a sibling project lockfile", () => {
    const siblingDir = join(repoDir, "packages", "app");
    const siblingLockfilePath = join(siblingDir, "pnpm-lock.yaml");
    const siblingBefore = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n";
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "root-pkg" }));
    writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(join(siblingDir, "package.json"), JSON.stringify({ name: "app-pkg" }));
    writeFileSync(siblingLockfilePath, siblingBefore);
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    try {
      runMain({
        FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
        FAKE_PNPM_LIST_JSON: JSON.stringify([{ path: repoDir }, { path: siblingDir }]),
        FAKE_PNPM_EXTRA_LOCKFILE_PATH: siblingLockfilePath,
        FAKE_PNPM_INSTALL_2_EXTRA_LOCKFILE: siblingBefore.replace(".:", ".:\n    dependencies:\n      new-pkg: {}"),
        FAKE_PNPM_INSTALL_FAIL_2: "1",
      });

      assert.equal(readFileSync(siblingLockfilePath, "utf8"), siblingBefore);
    } finally {
      rmSync(join(repoDir, "packages"), { recursive: true, force: true });
      rmSync(join(repoDir, "pnpm-workspace.yaml"), { force: true });
    }
  });

  test("reports runtime dependency changes from a sibling project lockfile", () => {
    const siblingDir = join(repoDir, "packages", "app");
    const siblingLockfilePath = join(siblingDir, "pnpm-lock.yaml");
    const siblingBefore = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n";
    const siblingAfter = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  .:",
      "    dependencies:",
      "      new-pkg:",
      "        specifier: ^1.0.0",
      "",
    ].join("\n");
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "root-pkg" }));
    writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(join(siblingDir, "package.json"), JSON.stringify({ name: "app-pkg" }));
    writeFileSync(siblingLockfilePath, siblingBefore);
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    try {
      const outputs = runMain({
        FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
        FAKE_PNPM_LIST_JSON: JSON.stringify([{ path: repoDir }, { path: siblingDir }]),
        FAKE_PNPM_EXTRA_LOCKFILE_PATH: siblingLockfilePath,
        FAKE_PNPM_INSTALL_2_EXTRA_LOCKFILE: siblingAfter,
      });

      assert.equal(outputs.changed, "true");
      assert.equal(outputs["runtime-deps-changed"], "true");
      assert.equal(outputs["changed-names"], "app-pkg");
      assert.equal(readFileSync(siblingLockfilePath, "utf8"), siblingAfter);
    } finally {
      rmSync(join(repoDir, "packages"), { recursive: true, force: true });
      rmSync(join(repoDir, "pnpm-workspace.yaml"), { force: true });
    }
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
    writeFileSync(join(stateDir, "dedupe-count"), "0");
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
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_OVERRIDE_LOCKFILE: overrideFixed,
      FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: workspaceContent,
    });

    assert.equal(outputs.changed, "true");
    assert.equal(readFileSync(join(repoDir, "pnpm-lock.yaml"), "utf8"), overrideFixed);
    assert.equal(readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"), workspaceContent);
  });

  test("override mode writes an orphaned override alongside a live one: the orphaned one is pruned before install", () => {
    // Unlike the fixture lockfiles used elsewhere in this describe block,
    // this one has a real `packages:` block, so readLockfileOutsideOverrides
    // treats it as a real dependency tree instead of abstaining.
    const before = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  .:",
      "    dependencies:",
      "      live-pkg:",
      "        specifier: ^1.0.0",
      "",
      "packages:",
      "",
      "  live-pkg@1.0.1:",
      "    resolution: {integrity: sha512-x}",
      "",
    ].join("\n");
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      // update mode makes no changes; override mode writes an override for
      // the live dependency plus one for a package no longer in the tree.
      FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: "overrides:\n  live-pkg@<1.0.1: 1.0.1\n  ghost-pkg@<2: 2.0.0\n",
    });

    assert.equal(outputs.changed, "true");
    const workspace = readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8");
    assert.match(workspace, /live-pkg@<1\.0\.1: 1\.0\.1/);
    assert.doesNotMatch(workspace, /ghost-pkg/);

    const stdout = readFileSync(join(stateDir, "last-stdout.txt"), "utf8");
    assert.match(stdout, /Dropping orphaned override entry "ghost-pkg@<2"/);
  });

  test("keeps a root override used only by a sibling project lockfile", () => {
    const siblingDir = join(repoDir, "packages", "app");
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n");
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\noverrides:\n  is-odd: 3.0.1\n");
    writeFileSync(
      join(siblingDir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n\npackages:\n\n  is-odd@3.0.1:\n    resolution: {}\n",
    );
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    try {
      const outputs = runMain({
        FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
        FAKE_PNPM_LIST_JSON: JSON.stringify([{ path: repoDir }, { path: siblingDir }]),
      });

      assert.equal(outputs.changed, "false");
      assert.match(readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8"), /is-odd: 3\.0\.1/);
    } finally {
      rmSync(join(repoDir, "packages"), { recursive: true, force: true });
      rmSync(join(repoDir, "pnpm-workspace.yaml"), { force: true });
    }
  });

  test("override mode writes an unannotated minimumReleaseAgeExclude entry: a marker comment is inserted before install", () => {
    const before = ["importers:", "  .:", "    dependencies:", "      vulnerable-pkg:", "        specifier: ^1.0.0"].join(
      "\n",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: "minimumReleaseAgeExclude:\n  - fast-uri@3.1.6\n",
    });

    assert.equal(outputs.changed, "true");
    const workspace = readFileSync(join(repoDir, "pnpm-workspace.yaml"), "utf8");
    assert.match(workspace, /# Renovate security update: fast-uri@3\.1\.6\n {2}- fast-uri@3\.1\.6/);
  });

  test("override mode creates pnpm-workspace.yaml holding only an override that orphan-pruning then empties out: the scaffold file is removed", () => {
    // Regression test: previously the newly created file survived as an
    // empty (0-byte) pnpm-workspace.yaml, and changed=true was reported for
    // a file that ended up doing nothing.
    const before = [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  .:",
      "    dependencies:",
      "      live-pkg:",
      "        specifier: ^1.0.0",
      "",
      "packages:",
      "",
      "  live-pkg@1.0.1:",
      "    resolution: {integrity: sha512-x}",
      "",
    ].join("\n");
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), before);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-pkg" }));
    writeFileSync(join(stateDir, "audit-count"), "0");
    writeFileSync(join(stateDir, "install-count"), "0");
    writeFileSync(join(stateDir, "dedupe-count"), "0");
    // A prior test in this shared repoDir may have left a pnpm-workspace.yaml
    // behind; remove it so this run's own snapshot sees it as not existing,
    // matching the scenario being tested (this run is the one that creates it).
    rmSync(join(repoDir, "pnpm-workspace.yaml"), { force: true });

    const outputs = runMain({
      FAKE_PNPM_AUDIT_JSON_DEFAULT: '{"advisories":{}}',
      FAKE_PNPM_FIX_OVERRIDE_WORKSPACE: "overrides:\n  ghost-pkg@<2: 2.0.0\n",
    });

    assert.equal(outputs.changed, "false");
    assert.equal(
      existsSync(join(repoDir, "pnpm-workspace.yaml")),
      false,
      "a workspace file created solely to hold an override that then got pruned to nothing should be removed entirely",
    );
  });
});
