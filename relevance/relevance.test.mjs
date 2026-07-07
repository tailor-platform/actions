import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ZERO_SHA, parseRelevantPaths, determineRelevance } from "./relevance.mjs";

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
});
