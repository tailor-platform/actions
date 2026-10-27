#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
 * @param {string} params.expiresAt - the instant the CLI reports, empty for no row
 * @param {string} params.timezones - comma- or newline-separated IANA names
 * @param {string} params.status - the deployment status; a deleted workspace has no expiry
 * @returns {{ row: string, warnings: string[] }}
 */
export function expiryRow({ expiresAt, timezones, status }) {
  const warnings = [];
  if (!expiresAt || status === "deleted") return { row: "", warnings };

  const instant = new Date(expiresAt);
  if (Number.isNaN(instant.getTime())) {
    warnings.push(`Ignoring the expiry '${printable(expiresAt)}': not a date`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { row, warnings } = expiryRow({
    expiresAt: process.env.EXPIRES_AT ?? "",
    timezones: process.env.TIMEZONES ?? "",
    status: process.env.STATUS ?? "",
  });
  for (const warning of warnings) console.log(`::warning::${warning}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `row=${row}\n`);
}
