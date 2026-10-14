import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function runScript(context, { script, responses, env }) {
  const requests = [];
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    requests.push(pathname);
    if (!Object.hasOwn(responses, pathname)) return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(responses[pathname]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const directory = await mkdtemp(path.join(os.tmpdir(), "run-script-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputFile = path.join(directory, "output");
  await writeFile(outputFile, "");

  await execute(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}/api/v3`,
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
    timeout: 10000,
  });
  return { requests, output: await readFile(outputFile, "utf8") };
}
