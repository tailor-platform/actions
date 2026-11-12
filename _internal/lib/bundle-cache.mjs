// Usage:
//   bundle-cache.mjs restore                   Print the SDK bundle cache's `path` and the key `prefix` to restore it by.
//   bundle-cache.mjs save-key <prefix> <path>  Print the `key` to save it under, or nothing when the SDK wrote no manifest.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// Mirrors the SDK's lockfile lookup, whose hash invalidates the whole cache.
const lockfileNames = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"];

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function findUp(name, directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    const candidate = path.join(current, name);
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    if (path.dirname(current) === current) return undefined;
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function readManifest(cachePath) {
  try {
    return JSON.parse(readFileSync(path.join(cachePath, "manifest.json"), "utf8"));
  } catch {
    return undefined;
  }
}

const [command, ...args] = process.argv.slice(2);

if (command === "restore") {
  const lockfile = lockfileNames.map((name) => findUp(name, process.cwd())).find(Boolean);
  const lockfileHash = lockfile ? sha256(readFileSync(lockfile)) : "none";
  console.log(`path=${path.resolve(process.env.TAILOR_BUILD_OUTPUT_DIR || ".tailor", "cache")}`);
  console.log(`prefix=tailor-bundle-${lockfileHash}-`);
} else if (command === "save-key") {
  const [prefix, cachePath] = args;
  const manifest = readManifest(cachePath);
  if (manifest !== undefined) console.log(`key=${prefix}${sha256(JSON.stringify(sortKeys(manifest)))}`);
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
