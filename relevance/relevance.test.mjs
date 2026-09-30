import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ZERO_SHA,
  parseRelevantPaths,
  parsePathPatterns,
  matchesPathPatterns,
  determineRelevance,
} from "./relevance.mjs";

describe("parseRelevantPaths", () => {
  test("empty input yields no entries", () => {
    assert.deepEqual(parseRelevantPaths(""), []);
  });

  test("splits on newline and trims, dropping blank lines", () => {
    assert.deepEqual(parseRelevantPaths("a/\n b \n\nc.ts"), ["a/", "b", "c.ts"]);
  });
});

describe("determineRelevance", () => {
  const compareCommits = (files, mergeBaseSha = "merge-base-sha") => async () => ({
    files,
    merge_base_commit: { sha: mergeBaseSha },
  });

  test("all-zero sha-base is always relevant, without calling compareCommits", async () => {
    const result = await determineRelevance({
      shaBase: ZERO_SHA,
      shaHead: "head",
      relevantPaths: [],
      compareCommits: () => {
        throw new Error("should not be called");
      },
    });
    assert.equal(result.relevant, true);
    assert.equal(result.forkSha, undefined);
  });

  test("a full 300-entry page is treated as possibly truncated and relevant", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `file-${i}.ts` }));
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: [],
      compareCommits: compareCommits(files),
    });
    assert.equal(result.relevant, true);
    assert.equal(result.forkSha, "merge-base-sha");
  });

  test("matches an exact path", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: ["config.ts"],
      compareCommits: compareCommits([{ filename: "config.ts" }]),
    });
    assert.equal(result.relevant, true);
  });

  test("does not match a partial filename as an exact path", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: ["config.ts"],
      compareCommits: compareCommits([{ filename: "src/config.ts" }]),
    });
    assert.equal(result.relevant, false);
  });

  test("matches a prefix ending in /", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: ["src/"],
      compareCommits: compareCommits([{ filename: "src/config.ts" }]),
    });
    assert.equal(result.relevant, true);
  });

  test("no relevant path present yields relevant=false with the fork sha still set", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: ["src/"],
      compareCommits: compareCommits([{ filename: "docs/readme.md" }]),
    });
    assert.equal(result.relevant, false);
    assert.equal(result.forkSha, "merge-base-sha");
  });

  test("no files at all in the compare yields relevant=false", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: ["src/"],
      compareCommits: compareCommits(undefined),
    });
    assert.equal(result.relevant, false);
  });

  test("a file renamed out of a relevant path is still relevant", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: ["src/"],
      compareCommits: compareCommits([
        { filename: "docs/moved.ts", previous_filename: "src/moved.ts" },
      ]),
    });
    assert.equal(result.relevant, true);
  });
});

describe("parsePathPatterns", () => {
  test("empty input yields no patterns", () => {
    assert.deepEqual(parsePathPatterns(""), []);
  });

  test("rejects negated patterns without a positive one, as GitHub's paths filter does", () => {
    assert.throws(() => parsePathPatterns("!docs/**"), /at least one pattern without "!"/);
  });

  test("rejects a pattern that is not a valid filter pattern", () => {
    assert.throws(() => parsePathPatterns("[abc.md"), /Invalid path pattern "\[abc\.md"/);
  });
});

describe("matchesPathPatterns", () => {
  const matches = (patterns, file) => matchesPathPatterns(file, parsePathPatterns(patterns));

  test("* does not cross a slash", () => {
    assert.equal(matches("*.js", "app.js"), true);
    assert.equal(matches("*.js", "js/app.js"), false);
  });

  test("** crosses slashes", () => {
    assert.equal(matches("**.js", "src/js/app.js"), true);
  });

  test("a leading **/ also matches at the repository root", () => {
    assert.equal(matches("**/README.md", "README.md"), true);
    assert.equal(matches("**/README.md", "js/README.md"), true);
  });

  test("** between directories matches zero or more of them", () => {
    assert.equal(matches("docs/**/*.md", "docs/README.md"), true);
    assert.equal(matches("docs/**/*.md", "docs/a/markdown/file.md"), true);
  });

  test("? makes the preceding character optional", () => {
    assert.equal(matches("*.jsx?", "page.js"), true);
    assert.equal(matches("*.jsx?", "page.jsx"), true);
    assert.equal(matches("*.jsx?", "page.jsxx"), false);
  });

  test("+ repeats the preceding character one or more times", () => {
    assert.equal(matches("a+.txt", "aaa.txt"), true);
    assert.equal(matches("a+.txt", ".txt"), false);
  });

  test("[] matches one listed character or range", () => {
    assert.equal(matches("[CB]at.md", "Cat.md"), true);
    assert.equal(matches("[CB]at.md", "Hat.md"), false);
    assert.equal(matches("[1-2]00.md", "200.md"), true);
  });

  test("other characters match literally", () => {
    assert.equal(matches("a.b", "a.b"), true);
    assert.equal(matches("a.b", "aXb"), false);
  });

  test("a backslash makes a special character literal", () => {
    assert.equal(matches("\\*.md", "*.md"), true);
    assert.equal(matches("\\*.md", "a.md"), false);
  });

  test("** matches file names containing a newline, which git allows", () => {
    assert.equal(matches("src/**", "src/a\nb.ts"), true);
    assert.equal(matches("**", "a\nb.ts"), true);
  });

  test("repeated **/ segments do not make a non-matching path slow to reject", { timeout: 1000 }, () => {
    const pattern = `${"**/".repeat(30)}X`;
    assert.equal(matches(pattern, `${"a/".repeat(40)}Y`), false);
    assert.equal(matches(pattern, `${"a/".repeat(40)}X`), true);
  });

  test("a pattern must match the whole path", () => {
    assert.equal(matches("docs", "docs/readme.md"), false);
    assert.equal(matches("docs", "my-docs"), false);
  });

  test("a later ! pattern excludes a path an earlier pattern included", () => {
    assert.equal(matches("*.md\n!README.md", "hello.md"), true);
    assert.equal(matches("*.md\n!README.md", "README.md"), false);
  });

  test("a positive pattern after a ! pattern includes the path again", () => {
    assert.equal(matches("*.md\n!README.md\nREADME*", "README.md"), true);
    assert.equal(matches("*.md\n!README.md\nREADME*", "README.doc"), true);
  });
});

describe("determineRelevance with path patterns", () => {
  const compareCommits = (files) => async () => ({
    files,
    merge_base_commit: { sha: "merge-base-sha" },
  });

  test("a changed file matching a path pattern is relevant", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: [],
      pathPatterns: parsePathPatterns("apps/*/frontend/**"),
      compareCommits: compareCommits([{ filename: "apps/erp/frontend/src/main.tsx" }]),
    });
    assert.equal(result.relevant, true);
  });

  test("a changed file excluded by a ! pattern is not relevant", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: [],
      pathPatterns: parsePathPatterns("apps/erp/backend/**\n!apps/erp/backend/**/*.md"),
      compareCommits: compareCommits([{ filename: "apps/erp/backend/docs/README.md" }]),
    });
    assert.equal(result.relevant, false);
  });

  test("a match in either relevant paths or path patterns is relevant", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: ["pnpm-lock.yaml"],
      pathPatterns: parsePathPatterns("apps/**"),
      compareCommits: compareCommits([{ filename: "pnpm-lock.yaml" }]),
    });
    assert.equal(result.relevant, true);
  });

  test("a file renamed out of a path pattern is still relevant", async () => {
    const result = await determineRelevance({
      shaBase: "base",
      shaHead: "head",
      relevantPaths: [],
      pathPatterns: parsePathPatterns("modules/**"),
      compareCommits: compareCommits([
        { filename: "archive/users.ts", previous_filename: "modules/users.ts" },
      ]),
    });
    assert.equal(result.relevant, true);
  });
});
