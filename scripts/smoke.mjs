import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function startProcess(args) {
  const child = spawn(pnpm, args, {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";

  const capture = (chunk) => {
    output += chunk.toString();
    if (output.length > 12_000) {
      output = output.slice(-12_000);
    }
  };

  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  return {
    child,
    getOutput: () => output,
  };
}

async function waitForService(name, url, validate, processInfo) {
  const deadline = Date.now() + 30_000;
  let lastError = new Error(`${name} has not responded yet`);

  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null) {
      throw new Error(`${name} exited before becoming ready:\n${processInfo.getOutput()}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok && (await validate(response))) {
        return;
      }
      lastError = new Error(`${name} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    await delay(300);
  }

  throw new Error(`${name} did not become ready: ${lastError.message}\n${processInfo.getOutput()}`);
}

function stopProcess(processInfo) {
  if (processInfo.child.exitCode === null) {
    processInfo.child.kill("SIGTERM");
  }
}

await Promise.all([
  access(join(root, "apps/portal/dist/index.html")),
  access(join(root, "workers/api/dist/index.js")),
  access(join(root, "packages/widget/dist/index.js")),
]);

const portal = startProcess([
  "--filter",
  "@santo/portal",
  "exec",
  "vite",
  "preview",
  "--host",
  "127.0.0.1",
  "--port",
  "4173",
  "--strictPort",
]);
const worker = startProcess([
  "--filter",
  "@santo/api",
  "exec",
  "wrangler",
  "dev",
  "--local",
  "--ip",
  "127.0.0.1",
  "--port",
  "8787",
]);

try {
  await Promise.all([
    waitForService(
      "portal",
      "http://127.0.0.1:4173",
      async (response) => (await response.text()).includes('id="root"'),
      portal,
    ),
    waitForService(
      "worker",
      "http://127.0.0.1:8787/health",
      async (response) => {
        const body = await response.json();
        return body.service === "santo-api" && body.status === "ok";
      },
      worker,
    ),
  ]);

  console.log("Bootstrap smoke checks passed");
} finally {
  stopProcess(portal);
  stopProcess(worker);
  await delay(500);
}
