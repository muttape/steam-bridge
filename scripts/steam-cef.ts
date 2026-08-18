import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
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

type CliOptions = ReturnType<typeof parseOptions>;

function parseOptions(argsList: string[]) {
  const { values } = parseArgs({
    args: argsList,
    options: {
      entrypoint: { type: "string" },
      "exact-title": { type: "string" },
      expression: { type: "string" },
      "no-await-promise": { type: "boolean" },
      out: { type: "string" },
      "poll-interval-ms": { type: "string" },
      port: { type: "string" },
      "target-id": { type: "string" },
      "timeout-ms": { type: "string" },
      version: { type: "string" },
    },
  });
  const pollIntervalMs = Number(values["poll-interval-ms"] ?? 5000);

  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error("--poll-interval-ms must be a finite number >= 1000");
  }

  return {
    awaitPromise: values["no-await-promise"] !== true,
    entrypoint: values.entrypoint,
    exactTitle: values["exact-title"],
    expression: values.expression,
    out: values.out,
    pollIntervalMs,
    port: Number(values.port ?? 8080),
    targetId: values["target-id"],
    timeoutMs: Number(values["timeout-ms"] ?? 5000),
    version: values.version,
  };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
