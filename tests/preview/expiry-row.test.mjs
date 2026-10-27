import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expiryRow } from "../../preview-comment/expiry.mjs";

const execFile = promisify(execFileCallback);
const expiresAt = "2026-10-27T12:00:00Z";

test("expiryRow: gives no row when expires-at is empty", () => {
  assert.deepEqual(expiryRow({ expiresAt: "", timezones: "UTC", status: "success" }), { row: "", warnings: [] });
});

test("expiryRow: gives no row once the workspace is cleaned up", () => {
  assert.equal(expiryRow({ expiresAt, timezones: "UTC", status: "deleted" }).row, "");
});

test("expiryRow: shows the expiry in each timezone, one under the other in the order given", () => {
  const { row, warnings } = expiryRow({
    expiresAt,
    timezones: "UTC,Asia/Tokyo,America/Los_Angeles",
    status: "success",
  });
  assert.equal(
    row,
    "| Expires | 2026-10-27 12:00 UTC<br>2026-10-27 21:00 Asia/Tokyo<br>2026-10-27 05:00 America/Los_Angeles |",
  );
  assert.deepEqual(warnings, []);
});

test("expiryRow: shows the expiry for a failed deployment because the workspace still exists", () => {
  assert.equal(expiryRow({ expiresAt, timezones: "UTC", status: "failure" }).row, "| Expires | 2026-10-27 12:00 UTC |");
});

test("expiryRow: accepts timezones separated by newlines and surrounding spaces", () => {
  const { row } = expiryRow({ expiresAt, timezones: " UTC \n Asia/Tokyo ,\n\n", status: "success" });
  assert.equal(row, "| Expires | 2026-10-27 12:00 UTC<br>2026-10-27 21:00 Asia/Tokyo |");
});

test("expiryRow: carries the date across midnight in a timezone ahead of UTC", () => {
  const { row } = expiryRow({ expiresAt: "2026-10-27T20:00:00Z", timezones: "Asia/Tokyo", status: "success" });
  assert.equal(row, "| Expires | 2026-10-28 05:00 Asia/Tokyo |");
});

for (const [value, shown] of [
  ["2026-10-27T12:00:00.000Z", "2026-10-27 12:00 UTC"],
  ["2026-10-27T12:00:00.123456Z", "2026-10-27 12:00 UTC"],
  ["2026-10-27T12:00:00+00:00", "2026-10-27 12:00 UTC"],
  ["2026-10-27T21:00:00+09:00", "2026-10-27 12:00 UTC"],
  ["2026-10-27T05:00:00-07:00", "2026-10-27 12:00 UTC"],
  ["2026-10-27T21:30:00.250+09:30", "2026-10-27 12:00 UTC"],
  ["2026-10-28T01:00:00+13:00", "2026-10-27 12:00 UTC"],
]) {
  test(`expiryRow: reads ${value} as the instant it denotes`, () => {
    const { row, warnings } = expiryRow({ expiresAt: value, timezones: "UTC", status: "success" });
    assert.equal(row, `| Expires | ${shown} |`);
    assert.deepEqual(warnings, []);
  });
}

for (const value of ["next tuesday", "2026-10-27", "2026-10-27T21:00:00+9", "2026-10-27T12:00:00", "2026-13-27T12:00:00Z"]) {
  test(`expiryRow: skips the malformed expires-at ${JSON.stringify(value)} with a warning`, () => {
    const { row, warnings } = expiryRow({ expiresAt: value, timezones: "UTC", status: "success" });
    assert.equal(row, "");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^Ignoring expires-at /);
  });
}

test("expiryRow: skips an unknown timezone with a warning and keeps the valid ones", () => {
  const { row, warnings } = expiryRow({ expiresAt, timezones: "UTC,Mars/Olympus,Asia/Tokyo", status: "success" });
  assert.equal(row, "| Expires | 2026-10-27 12:00 UTC<br>2026-10-27 21:00 Asia/Tokyo |");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Mars\/Olympus/);
});

for (const timezones of ["Mars/Olympus", ""]) {
  test(`expiryRow: falls back to UTC when timezones is ${JSON.stringify(timezones)}`, () => {
    assert.equal(expiryRow({ expiresAt, timezones, status: "success" }).row, "| Expires | 2026-10-27 12:00 UTC |");
  });
}

for (const directory of ["America", "Etc"]) {
  test(`expiryRow: skips ${directory}, a region that is not a timezone`, () => {
    const { row, warnings } = expiryRow({ expiresAt, timezones: directory, status: "success" });
    assert.equal(row, "| Expires | 2026-10-27 12:00 UTC |");
    assert.equal(warnings.length, 1);
  });
}

test("expiryRow: cannot be made to emit a workflow command through a malformed value", () => {
  const { warnings } = expiryRow({
    expiresAt: "x\n::set-output name=pwn::1",
    timezones: "UTC",
    status: "success",
  });
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], /\n/);
});

const runCli = async (env) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "expiry-cli-"));
  const outputFile = path.join(directory, "output");
  await writeFile(outputFile, "");
  try {
    const { stdout } = await execFile(process.execPath, [fileURLToPath(new URL("../../preview-comment/expiry.mjs", import.meta.url))], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, ...env },
    });
    return { stdout, output: await readFile(outputFile, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("expiry.mjs: writes the row as the step output and the warnings as workflow commands", async () => {
  const { stdout, output } = await runCli({
    EXPIRES_AT: expiresAt,
    TIMEZONES: "UTC,Mars/Olympus",
    STATUS: "success",
  });
  assert.equal(output, "row=| Expires | 2026-10-27 12:00 UTC |\n");
  assert.match(stdout, /^::warning::Skipping timezone 'Mars\/Olympus'/);
});

test("expiry.mjs: writes an empty row without failing when expires-at is empty", async () => {
  const { stdout, output } = await runCli({ EXPIRES_AT: "", TIMEZONES: "UTC", STATUS: "success" });
  assert.equal(output, "row=\n");
  assert.equal(stdout, "");
});
