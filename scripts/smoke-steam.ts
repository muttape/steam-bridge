import { build } from "esbuild";
import { evaluateJavascript, probeCdp, type EvaluationResult } from "../src/cdp.js";
import { buildRuntimeDiagnosticsRead, buildRuntimeInjection } from "../src/injection.js";
import { selectSharedContextTarget } from "../src/target-selector.js";
import { startTransportServer } from "../src/transport-server.js";

const timeoutMs = 10_000;
let server: Awaited<ReturnType<typeof startTransportServer>> | undefined;
let debuggerUrl: string | undefined;

try {
  const bundle = await boundary("bundle smoke consumer", async () => {
    const result = await build({
      bundle: true,
      entryPoints: ["scripts/smoke-entrypoint.ts"],
      format: "esm",
      platform: "browser",
      write: false,
    });
    return result.outputFiles[0]!.text;
  });

  server = await boundary("start loopback transport", () =>
    startTransportServer({
      port: 0,
      routes: new Map([["system.ping", () => "pong"]]),
      onRequest(request, response) {
        if (new URL(request.url ?? "/", "http://127.0.0.1").pathname !== "/entry.js") return false;
        response.writeHead(200, {
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(bundle);
        return true;
      },
    }),
  );

  const probe = await boundary("reach Steam CDP and read targets", () => probeCdp({ timeoutMs }));
  const target = await boundary("find SharedJSContext", async () => {
    const selected = selectSharedContextTarget(probe.targets)?.target;
    if (!selected?.webSocketDebuggerUrl) throw new Error("No debuggable SharedJSContext target");
    return selected;
  });
  debuggerUrl = target.webSocketDebuggerUrl;

  await boundary("evaluate JavaScript", () => evaluateValue(debuggerUrl!, "1 + 1"));
  const entrypointUrl = `http://127.0.0.1:${server.port}/entry.js?token=${server.token}`;
  await boundary("inject smoke entrypoint", () =>
    evaluateValue(
      debuggerUrl!,
      buildRuntimeInjection({ entrypointUrl, version: "steam-bridge-smoke" }),
    ),
  );
  await boundary("authenticate transport and ping", () =>
    waitFor(debuggerUrl!, "window.__steamBridge?.transport?.lastPingAt"),
  );

  server.emit("smoke.event");
  await boundary("deliver backend event", () =>
    waitFor(debuggerUrl!, "window.__steamBridge?.transport?.lastEvent?.event === 'smoke.event'"),
  );

  const diagnostics = await boundary("read healthy runtime diagnostics", () =>
    evaluateValue(debuggerUrl!, buildRuntimeDiagnosticsRead()),
  );
  const transport = (diagnostics as { transport?: { connected?: boolean; lastError?: unknown } })
    .transport;
  if (!transport?.connected || transport.lastError) {
    throw new Error("runtime diagnostics are not healthy");
  }

  const context = await boundary("resolve Library app context", () =>
    evaluateValue(debuggerUrl!, "window.__steamBridge?.smoke?.context ?? null"),
  );
  if (context) {
    await boundary("mount generic Library element", () =>
      waitFor(debuggerUrl!, "window.__steamBridge?.smoke?.mountCount > 0"),
    );
    await boundary("remount after DOM replacement", async () => {
      await evaluateValue(debuggerUrl!, "window.__steamBridge.smoke.removeMount()");
      await waitFor(debuggerUrl!, "window.__steamBridge?.smoke?.mountCount > 0");
    });
  } else {
    console.log("SKIP Library mount: open a Steam Library app page to exercise this boundary.");
  }

  console.log("PASS steam-bridge live Steam smoke");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (debuggerUrl) {
    try {
      await evaluateValue(
        debuggerUrl,
        "window.__steamBridge?.smoke?.cleanup?.(); delete window.__steamBridge",
      );
      if (await evaluateValue(debuggerUrl, "'__steamBridge' in window")) {
        throw new Error("Runtime Marker remains after cleanup");
      }
      console.log("PASS cleanup injected runtime");
    } catch (error) {
      console.error(
        `FAIL cleanup injected runtime: ${error instanceof Error ? error.message : error}`,
      );
      process.exitCode = 1;
    }
  }
  try {
    await server?.close();
    if (server) console.log("PASS close loopback transport");
  } catch (error) {
    console.error(
      `FAIL close loopback transport: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  }
}

async function boundary<T>(name: string, action: () => Promise<T>): Promise<T> {
  try {
    const result = await action();
    console.log(`PASS ${name}`);
    return result;
  } catch (error) {
    throw new Error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

async function evaluateValue(debuggerUrl: string, expression: string): Promise<unknown> {
  const result: EvaluationResult = await evaluateJavascript(debuggerUrl, expression, { timeoutMs });
  if (result.kind !== "value") throw new Error(`Unexpected ${result.kind} evaluation result`);
  return result.value;
}

async function waitFor(debuggerUrl: string, expression: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluateValue(debuggerUrl, `Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
