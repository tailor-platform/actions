import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  licenseGroups,
  LicenseCheckError,
  parseLicenseList,
  resolveGroups,
  buildAllowSet,
  parsePackageExceptions,
  globToRegExp,
  matchesPattern,
  isOrderedSubsequence,
  collectDependencyPaths,
  isPackageException,
  splitMembers,
  isLicenseAllowed,
} from "./check-licenses.mjs";

describe("parseLicenseList", () => {
  test("empty/undefined input yields no entries", () => {
    assert.deepEqual(parseLicenseList(undefined), []);
    assert.deepEqual(parseLicenseList(""), []);
  });

  test("splits on comma when no newline is present", () => {
    assert.deepEqual(parseLicenseList("MIT, Apache-2.0 ,ISC"), ["MIT", "Apache-2.0", "ISC"]);
  });

  test("splits on newline when present, ignoring commas", () => {
    assert.deepEqual(parseLicenseList("MIT\nApache-2.0\n\nISC"), ["MIT", "Apache-2.0", "ISC"]);
  });
});

describe("resolveGroups", () => {
  test("defaults to every known group", () => {
    assert.deepEqual(resolveGroups(undefined), Object.keys(licenseGroups));
  });

  test("returns only the requested groups", () => {
    assert.deepEqual(resolveGroups("reciprocal,unencumbered"), ["reciprocal", "unencumbered"]);
  });

  test("throws LicenseCheckError on an unknown group", () => {
    assert.throws(() => resolveGroups("bogus"), LicenseCheckError);
  });
});

describe("buildAllowSet", () => {
  test("unions the selected groups' licenses", () => {
    const set = buildAllowSet(["unencumbered"], undefined, undefined);
    assert.ok(set.has("CC0-1.0"));
    assert.ok(!set.has("MIT")); // notice group not selected
  });

  test("additional licenses are added on top of the groups", () => {
    const set = buildAllowSet(["unencumbered"], "BlueOak-1.0.0,WTFPL", undefined);
    assert.ok(set.has("BlueOak-1.0.0"));
    assert.ok(set.has("WTFPL"));
  });

  test("denied licenses are removed even if part of a selected group", () => {
    const set = buildAllowSet(["notice"], undefined, "MIT");
    assert.ok(!set.has("MIT"));
    assert.ok(set.has("Apache-2.0"));
  });
});

describe("isLicenseAllowed", () => {
  const allowSet = new Set(["MIT", "Apache-2.0"]);

  test("single allowed license", () => {
    assert.equal(isLicenseAllowed("MIT", allowSet), true);
  });

  test("single disallowed license", () => {
    assert.equal(isLicenseAllowed("GPL-3.0", allowSet), false);
  });

  test("OR expression: allowed if any member is allowed", () => {
    assert.equal(isLicenseAllowed("(GPL-3.0 OR MIT)", allowSet), true);
  });

  test("OR expression: disallowed if no member is allowed", () => {
    assert.equal(isLicenseAllowed("(GPL-3.0 OR LGPL-3.0)", allowSet), false);
  });

  test("AND expression requires every member to be allowed", () => {
    assert.equal(isLicenseAllowed("(MIT AND Apache-2.0)", allowSet), true);
    assert.equal(isLicenseAllowed("(MIT AND GPL-3.0)", allowSet), false);
  });

  test("mixed AND/OR requires every member to be allowed (no precedence parsing)", () => {
    assert.equal(isLicenseAllowed("(MIT OR GPL-3.0 AND Apache-2.0)", allowSet), false);
  });
});

describe("parsePackageExceptions", () => {
  test("empty/undefined input yields an empty object", () => {
    assert.deepEqual(parsePackageExceptions(undefined), {});
    assert.deepEqual(parsePackageExceptions(""), {});
  });

  test("parses a valid chains object", () => {
    const raw = '{"LGPL-3.0-or-later": [["nextjs-app", "next"]]}';
    assert.deepEqual(parsePackageExceptions(raw), {
      "LGPL-3.0-or-later": [["nextjs-app", "next"]],
    });
  });

  test("throws on invalid JSON", () => {
    assert.throws(() => parsePackageExceptions("not json"), LicenseCheckError);
  });

  test("throws when the top level isn't a plain object", () => {
    assert.throws(() => parsePackageExceptions("[]"), LicenseCheckError);
    assert.throws(() => parsePackageExceptions("null"), LicenseCheckError);
    assert.throws(() => parsePackageExceptions('"MIT"'), LicenseCheckError);
  });

  test("throws when a chain list isn't an array of string arrays", () => {
    assert.throws(() => parsePackageExceptions('{"MIT": ["not-an-array"]}'), LicenseCheckError);
    assert.throws(() => parsePackageExceptions('{"MIT": [[1, 2]]}'), LicenseCheckError);
  });
});

describe("matchesPattern / globToRegExp", () => {
  test("exact match with no glob", () => {
    assert.equal(matchesPattern("next", "next"), true);
    assert.equal(matchesPattern("next-router", "next"), false);
  });

  test("* glob matches any suffix", () => {
    assert.equal(matchesPattern("@img/sharp-libvips-darwin-arm64", "@img/sharp-libvips-*"), true);
    assert.equal(matchesPattern("@img/sharp-darwin-arm64", "@img/sharp-libvips-*"), false);
  });

  test("regex special characters in the pattern are escaped", () => {
    const regexp = globToRegExp("a.b+c");
    assert.equal(regexp.test("a.b+c"), true);
    assert.equal(regexp.test("axbyc"), false); // '.' and '+' must be literal, not regex metacharacters
  });
});

describe("isOrderedSubsequence", () => {
  test("matches when chain elements appear in order with gaps", () => {
    assert.equal(
      isOrderedSubsequence(["app-a", "gpl-leaf"], ["app-a", "mid-pkg", "gpl-leaf"]),
      true,
    );
  });

  test("does not match when order is reversed", () => {
    assert.equal(
      isOrderedSubsequence(["mid-pkg", "app-a"], ["app-a", "mid-pkg", "gpl-leaf"]),
      false,
    );
  });

  test("does not match when an element is missing entirely", () => {
    assert.equal(isOrderedSubsequence(["app-a", "nope"], ["app-a", "mid-pkg", "gpl-leaf"]), false);
  });

  test("supports globs on chain elements", () => {
    assert.equal(isOrderedSubsequence(["app-a", "gpl-*"], ["app-a", "mid-pkg", "gpl-leaf"]), true);
  });

  test("empty chain trivially matches (vacuous truth)", () => {
    assert.equal(isOrderedSubsequence([], ["app-a", "mid-pkg"]), true);
  });
});

describe("collectDependencyPaths", () => {
  test("builds a workspace-project-first path from a pnpm why dependents node", () => {
    const node = {
      name: "mid-pkg",
      dependents: [{ name: "app-a", version: "", depField: "dependencies" }],
    };
    assert.deepEqual(collectDependencyPaths(node, ["gpl-leaf"]), [["app-a", "mid-pkg", "gpl-leaf"]]);
  });

  test("branches fan out into multiple paths", () => {
    const node = {
      name: "mid-pkg",
      dependents: [
        { name: "app-a", depField: "dependencies" },
        { name: "app-c", depField: "dependencies" },
      ],
    };
    assert.deepEqual(collectDependencyPaths(node, ["gpl-leaf"]), [
      ["app-a", "mid-pkg", "gpl-leaf"],
      ["app-c", "mid-pkg", "gpl-leaf"],
    ]);
  });

  test("a deduped dead-end (no dependents, no depField) contributes no path", () => {
    const node = { name: "sharp", deduped: true };
    assert.deepEqual(collectDependencyPaths(node, ["gpl-leaf"]), []);
  });
});

describe("isPackageException", () => {
  const exceptions = { "GPL-3.0": [["app-a", "mid-pkg"]] };

  test("excused when the only route matches", () => {
    const getPaths = () => [["app-a", "mid-pkg", "gpl-leaf"]];
    assert.equal(isPackageException("gpl-leaf", "GPL-3.0", exceptions, getPaths), true);
  });

  test("not excused when no chain is declared for this license", () => {
    const getPaths = () => [["app-a", "mid-pkg", "gpl-leaf"]];
    assert.equal(isPackageException("gpl-leaf", "MPL-2.0", exceptions, getPaths), false);
  });

  test("not excused when no route could be resolved at all", () => {
    const getPaths = () => [];
    assert.equal(isPackageException("gpl-leaf", "GPL-3.0", exceptions, getPaths), false);
  });

  test("not excused unless EVERY route matches — one approved route doesn't cover another", () => {
    const getPaths = () => [
      ["app-a", "mid-pkg", "gpl-leaf"], // matches the declared chain
      ["app-b", "gpl-leaf"], // does not
    ];
    assert.equal(isPackageException("gpl-leaf", "GPL-3.0", exceptions, getPaths), false);
  });

  test("excused once every route is covered", () => {
    const bothRoutesExceptions = {
      "GPL-3.0": [["app-a", "mid-pkg"], ["app-b", "gpl-leaf"]],
    };
    const getPaths = () => [
      ["app-a", "mid-pkg", "gpl-leaf"],
      ["app-b", "gpl-leaf"],
    ];
    assert.equal(isPackageException("gpl-leaf", "GPL-3.0", bothRoutesExceptions, getPaths), true);
  });
});

describe("splitMembers", () => {
  test("splits an AND/OR expression on either keyword, case-insensitively", () => {
    assert.deepEqual(splitMembers("MIT or Apache-2.0"), ["MIT", "Apache-2.0"]);
    assert.deepEqual(splitMembers("MIT AND Apache-2.0"), ["MIT", "Apache-2.0"]);
  });

  test("a plain single license is returned as-is", () => {
    assert.deepEqual(splitMembers("MIT"), ["MIT"]);
  });
});
