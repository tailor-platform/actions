import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolveBaseSha,
  extractAdvisoryIds,
  findNewAdvisoryIds,
  findAdvisoryById,
  formatAdvisoryLine,
  formatAdvisoryLines,
} from "./lockfile-audit.mjs";

const ZERO_SHA = "0000000000000000000000000000000000000000";

describe("resolveBaseSha", () => {
  test("an explicit base-sha input always wins", () => {
    assert.equal(
      resolveBaseSha({ baseShaInput: "abc123", eventName: "pull_request", prBaseSha: "def456" }),
      "abc123",
    );
  });

  test("pull_request uses the PR's base sha", () => {
    assert.equal(
      resolveBaseSha({ eventName: "pull_request", prBaseSha: "abc123", pushBeforeSha: "def456" }),
      "abc123",
    );
  });

  test("push (or any other event) uses the ref's previous tip", () => {
    assert.equal(
      resolveBaseSha({ eventName: "push", prBaseSha: "abc123", pushBeforeSha: "def456" }),
      "def456",
    );
  });

  test("returns null when the resolved sha is empty", () => {
    assert.equal(resolveBaseSha({ eventName: "push", pushBeforeSha: "" }), null);
    assert.equal(resolveBaseSha({ eventName: "push", pushBeforeSha: undefined }), null);
  });

  test("returns null for the all-zero sha (new branch / workflow_dispatch)", () => {
    assert.equal(resolveBaseSha({ eventName: "push", pushBeforeSha: ZERO_SHA }), null);
  });
});

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

  test("tolerates an array shape too", () => {
    const auditJson = { advisories: [{ github_advisory_id: "GHSA-aaaa-bbbb-cccc" }] };
    assert.deepEqual(extractAdvisoryIds(auditJson), new Set(["GHSA-aaaa-bbbb-cccc"]));
  });

  test("ignores entries with a missing or empty ID", () => {
    const auditJson = { advisories: { 1: { github_advisory_id: "" }, 2: {} } };
    assert.deepEqual(extractAdvisoryIds(auditJson), new Set());
  });

  test("returns an empty set when there are no advisories", () => {
    assert.deepEqual(extractAdvisoryIds({ advisories: {} }), new Set());
    assert.deepEqual(extractAdvisoryIds({}), new Set());
  });
});

describe("findNewAdvisoryIds", () => {
  test("returns IDs present in head but not base", () => {
    const head = new Set(["GHSA-a", "GHSA-b", "GHSA-c"]);
    const base = new Set(["GHSA-a"]);
    assert.deepEqual(findNewAdvisoryIds(head, base), ["GHSA-b", "GHSA-c"]);
  });

  test("returns an empty array when nothing new was introduced", () => {
    const head = new Set(["GHSA-a"]);
    const base = new Set(["GHSA-a", "GHSA-b"]);
    assert.deepEqual(findNewAdvisoryIds(head, base), []);
  });

  test("sorts the result", () => {
    const head = new Set(["GHSA-c", "GHSA-a", "GHSA-b"]);
    const base = new Set();
    assert.deepEqual(findNewAdvisoryIds(head, base), ["GHSA-a", "GHSA-b", "GHSA-c"]);
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
      2: {
        github_advisory_id: "GHSA-w5p7-h5w8-2hfq",
        title: "Regular Expression Denial of Service in trim",
        module_name: "trim",
        severity: "high",
      },
    },
  };

  test("findAdvisoryById finds the matching advisory", () => {
    assert.equal(findAdvisoryById(auditJson, "GHSA-w5p7-h5w8-2hfq")?.module_name, "trim");
  });

  test("findAdvisoryById returns undefined for an unknown ID", () => {
    assert.equal(findAdvisoryById(auditJson, "GHSA-nope"), undefined);
  });

  test("formatAdvisoryLine formats id/title/module/severity", () => {
    assert.equal(
      formatAdvisoryLine(auditJson.advisories[2]),
      "- GHSA-w5p7-h5w8-2hfq: Regular Expression Denial of Service in trim (module: trim, severity: high)",
    );
  });

  test("formatAdvisoryLine returns null for a missing advisory", () => {
    assert.equal(formatAdvisoryLine(undefined), null);
  });

  test("formatAdvisoryLines formats each new ID in order, skipping unresolvable ones", () => {
    assert.deepEqual(formatAdvisoryLines(auditJson, ["GHSA-whgm-jr23-g3j9", "GHSA-nope", "GHSA-w5p7-h5w8-2hfq"]), [
      "- GHSA-whgm-jr23-g3j9: Uncontrolled Resource Consumption in ansi-html (module: ansi-html, severity: high)",
      "- GHSA-w5p7-h5w8-2hfq: Regular Expression Denial of Service in trim (module: trim, severity: high)",
    ]);
  });
});
