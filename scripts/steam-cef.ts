import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { evaluateJavascript, probeCdp } from "../src/cdp.js";
import { buildRuntimeDiagnosticsRead, buildRuntimeInjection } from "../src/injection.js";
import { makeCdpReinjectionDeps, watchReinjectionLoop } from "../src/reinjection-loop.js";
import { rankSharedContextTargets, selectSharedContextTarget } from "../src/target-selector.js";

const [command, ...args] = process.argv.slice(2);

try {
  await run(command, args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function run(commandName: string | undefined, argsList: string[]): Promise<void> {
  const options = parseOptions(argsList);
  if (commandName === "probe") {
    const result = await probeCdp({ port: options.port, timeoutMs: options.timeoutMs });
    if (options.out) {
      await writeJson(options.out, result);
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (commandName === "targets") {
    const { targets } = await probeCdp({ port: options.port, timeoutMs: options.timeoutMs });
    const ranked = rankSharedContextTargets(targets);
    console.log(JSON.stringify({ targets, ranked }, null, 2));
    return;
  }

  if (commandName === "eval") {
    if (!options.expression) throw new Error("Missing expression");
    const target = await findTarget(options);
    const result = await evaluateJavascript(target.webSocketDebuggerUrl!, options.expression, {
      awaitPromise: options.awaitPromise,
      timeoutMs: options.timeoutMs,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (commandName === "inject") {
    if (!options.entrypoint) throw new Error("Missing --entrypoint <url>");
    const target = await findTarget(options);
    const script = buildRuntimeInjection({
      entrypointUrl: options.entrypoint,
      version: options.version ?? "0.0.0-manual",
    });
    const result = await evaluateJavascript(target.webSocketDebuggerUrl!, script, {
      awaitPromise: true,
      timeoutMs: options.timeoutMs,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (commandName === "diagnose") {
    const target = await findTarget(options);
    const result = await evaluateJavascript(
      target.webSocketDebuggerUrl!,
      buildRuntimeDiagnosticsRead(),
      {
        awaitPromise: true,
        timeoutMs: options.timeoutMs,
      },
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (commandName === "watch") {
    if (!options.entrypoint) throw new Error("Missing --entrypoint <url>");
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    await watchReinjectionLoop(
      makeCdpReinjectionDeps({ port: options.port, timeoutMs: options.timeoutMs }),
      {
        entrypointUrl: options.entrypoint,
        version: options.version ?? "0.0.0-manual",
        pollIntervalMs: options.pollIntervalMs,
        onTick(result) {
          console.log(
            JSON.stringify({ action: result.action, reason: result.reason, state: result.state }),
          );
        },
      },
      controller.signal,
    );
    return;
  }

  console.log(
    "Usage: npm run build && npm run steam-cef -- probe|targets|eval|inject|diagnose|watch [options]",
  );
}

async function findTarget(options: CliOptions) {
  const { targets } = await probeCdp({ port: options.port, timeoutMs: options.timeoutMs });
  const target = options.targetId
    ? targets.find((candidate) => candidate.id === options.targetId)
    : selectSharedContextTarget(
        targets,
        options.exactTitle ? { exactTitles: [options.exactTitle] } : undefined,
      )?.target;

  if (!target?.webSocketDebuggerUrl) {
    throw new Error(
      "No target with webSocketDebuggerUrl found. Run `targets` and pass --target-id.",
    );
  }

  return target;
}

type CliOptions = {
  awaitPromise: boolean;
  entrypoint?: string;
  exactTitle?: string;
  expression?: string;
  out?: string;
  port: number;
  pollIntervalMs: number;
  targetId?: string;
  timeoutMs: number;
  version?: string;
};

function parseOptions(argsList: string[]): CliOptions {
  const options: CliOptions = {
    awaitPromise: true,
    port: 8080,
    pollIntervalMs: 5000,
    timeoutMs: 5000,
  };

  for (let index = 0; index < argsList.length; index += 1) {
    const arg = argsList[index];
    const next = argsList[index + 1];
    if (arg === "--no-await-promise") {
      options.awaitPromise = false;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    if (!next) throw new Error(`Missing value for ${arg}`);

    if (arg === "--port") options.port = Number(next);
    else if (arg === "--poll-interval-ms") options.pollIntervalMs = Number(next);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(next);
    else if (arg === "--out") options.out = next;
    else if (arg === "--target-id") options.targetId = next;
    else if (arg === "--exact-title") options.exactTitle = next;
    else if (arg === "--expression") options.expression = next;
    else if (arg === "--entrypoint") options.entrypoint = next;
    else if (arg === "--version") options.version = next;
    else throw new Error(`Unknown option ${arg}`);

    index += 1;
  }

  if (!Number.isFinite(options.pollIntervalMs) || options.pollIntervalMs < 1000) {
    throw new Error("--poll-interval-ms must be a finite number >= 1000");
  }

  return options;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
