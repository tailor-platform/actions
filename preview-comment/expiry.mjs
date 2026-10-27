#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// A value is echoed inside a `::warning::` workflow command, so anything that could end the line or start another command is replaced.
const printable = (value) => value.replace(/[^A-Za-z0-9_ /+:.-]/g, "?");

const formatIn = (date, timeZone) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);

const isKnownZone = (zone) => {
  try {
    formatIn(new Date(0), zone);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {object} params
 * @param {string} params.expiresAt - ISO 8601 instant, empty for no row
 * @param {string} params.timezones - comma- or newline-separated IANA names
 * @param {string} params.status - the deployment status; a deleted workspace has no expiry
 * @returns {{ row: string, warnings: string[] }}
 */
export function expiryRow({ expiresAt, timezones, status }) {
  const warnings = [];
  if (!expiresAt || status === "deleted") return { row: "", warnings };

  const instant = ISO_8601.test(expiresAt) ? new Date(expiresAt) : new Date(NaN);
  if (Number.isNaN(instant.getTime())) {
    warnings.push(
      `Ignoring expires-at '${printable(expiresAt)}': expected ISO 8601 such as 2026-10-27T12:00:00Z (fractional seconds and a +hh:mm offset are accepted)`,
    );
    return { row: "", warnings };
  }

  const zones = [];
  for (const zone of timezones.split(/[,\n]/).map((name) => name.trim())) {
    if (!zone) continue;
    if (isKnownZone(zone)) zones.push(zone);
    else warnings.push(`Skipping timezone '${printable(zone)}': not a known IANA timezone name`);
  }
  if (zones.length === 0) zones.push("UTC");

  return { row: `| Expires | ${zones.map((zone) => `${formatIn(instant, zone)} ${zone}`).join("<br>")} |`, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { row, warnings } = expiryRow({
    expiresAt: process.env.EXPIRES_AT ?? "",
    timezones: process.env.TIMEZONES ?? "",
    status: process.env.STATUS ?? "",
  });
  for (const warning of warnings) console.log(`::warning::${warning}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `row=${row}\n`);
}
