#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const auditLevel = process.env.AUDIT_LEVEL || "moderate";

try {
  execFileSync("pnpm", ["audit", `--audit-level=${auditLevel}`], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} catch {
  console.error("::error::Lockfile audit failed. See pnpm output above for vulnerabilities or audit errors.");
  process.exit(1);
}
