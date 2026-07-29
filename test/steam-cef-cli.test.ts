import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("eval command requires explicit expression", async () => {
  const result = await runCli("eval", "--no-await-promise");

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing expression/);
});

test("watch command rejects aggressive poll interval", async () => {
  const result = await runCli(
    "watch",
    "--entrypoint",
    "http://127.0.0.1:7331/entry.js?token=secret",
    "--poll-interval-ms",
    "999",
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--poll-interval-ms must be a finite number >= 1000/);
});

function runCli(...args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const scriptPath = fileURLToPath(new URL("../scripts/steam-cef.js", import.meta.url));
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}
