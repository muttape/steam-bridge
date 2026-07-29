import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { buildRuntimeDiagnosticsRead, buildRuntimeInjection } from "../src/injection.js";

test("runtime injection does not reload same version", async () => {
  const window: RuntimeWindow = {};
  const entrypointUrl = entrypointDataUrl(
    "globalThis.__injectionCount = (globalThis.__injectionCount ?? 0) + 1;",
  );

  await runInjection(window, {
    entrypointUrl,
    version: "1.0.0",
  });

  const result = await runInjection(window, {
    entrypointUrl,
    version: "1.0.0",
  });

  assert.equal(result.status, "already-loaded");
  assert.equal(globalThis.__injectionCount, 1);
  delete globalThis.__injectionCount;
});

test("runtime injection reloads different version and updates marker", async () => {
  const window = {
    __steamBridge: { loaded: true, version: "1.0.0", injectedAt: "old" },
  };

  const result = await runInjection(window, {
    entrypointUrl: entrypointDataUrl("globalThis.__injectionRan = true;"),
    version: "2.0.0",
  });

  assert.equal(result.status, "loaded");
  assert.equal((window.__steamBridge as unknown as RuntimeMarker).loaded, true);
  assert.equal(window.__steamBridge.version, "2.0.0");
  assert.equal(globalThis.__injectionRan, true);

  delete globalThis.__injectionRan;
});

test("runtime injection cache-busts non-data entrypoint imports by version", () => {
  const script = buildRuntimeInjection({
    entrypointUrl: "http://127.0.0.1:7331/entry.js?token=secret",
    version: "2.0.0",
  });

  assert.match(script, /runtimeVersion/);
  assert.match(script, /importEntrypointUrl/);
});

test("runtime injection does not save token query parameter", async () => {
  const module = await createEmptyModuleFile();
  const window: RuntimeWindow = {};
  try {
    await runInjection(window, {
      entrypointUrl: `${module.url}?token=secret`,
      version: "1.0.0",
    });

    const marker = window.__steamBridge as RuntimeMarker;
    assert.equal(marker.entrypointUrl, module.url);
  } finally {
    await module.remove();
  }
});

test("runtime injection reloads same version when entrypoint changes", async () => {
  const firstModule = await createEmptyModuleFile();
  const secondModule = await createEmptyModuleFile();
  const window: RuntimeWindow = {};
  try {
    await runInjection(window, {
      entrypointUrl: `${firstModule.url}?token=first`,
      version: "1.0.0",
    });

    const result = await runInjection(window, {
      entrypointUrl: `${secondModule.url}?token=second`,
      version: "1.0.0",
    });

    const marker = window.__steamBridge as RuntimeMarker;
    assert.equal(result.status, "loaded");
    assert.equal(marker.entrypointUrl, secondModule.url);
    assert.notEqual(marker.entrypointHash, undefined);
    assert.equal(JSON.stringify(marker).includes("second"), false);
  } finally {
    await firstModule.remove();
    await secondModule.remove();
  }
});

test("runtime injection replaces corrupt marker", async () => {
  const window = { __steamBridge: "corrupt" };

  const result = await runInjection(window, {
    entrypointUrl: entrypointDataUrl(""),
    version: "1.0.0",
  });

  assert.equal(result.status, "loaded");
  assert.equal((window.__steamBridge as unknown as RuntimeMarker).loaded, true);
});

test("runtime injection safely embeds quotes and backticks", () => {
  const script = buildRuntimeInjection({
    entrypointUrl: `http://127.0.0.1:7331/entry.js?x='"\`);globalThis.pwned=true;//`,
    version: `1.0.0'"\``,
  });

  assert.doesNotThrow(() => new Function("window", script));
  assert.equal(script.includes("globalThis.pwned=true;//\n"), false);
});

test("runtime diagnostics reports missing marker", () => {
  assert.deepEqual(runDiagnostics({}), {
    markerPresent: false,
    injected: false,
    version: null,
    injectedAt: null,
    entrypointLoadedAt: null,
    entrypointUrl: null,
    entrypointHash: null,
    transport: {
      connected: false,
      connectedAt: null,
      lastPingAt: null,
      lastEvent: null,
      lastError: null,
    },
  });
});

test("runtime diagnostics reports stable allowlisted shape", () => {
  const result = runDiagnostics({
    __steamBridge: {
      loaded: true,
      version: "1.0.0",
      injectedAt: "now",
      entrypointLoadedAt: "later",
      entrypointUrl: "http://127.0.0.1/entry.js",
      entrypointHash: "abc",
      transport: {
        connected: true,
        connectedAt: "connect-time",
        lastPingAt: "ping-time",
        lastEvent: { event: "system.ready", receivedAt: "event-time" },
        lastError: null,
        token: "secret",
      },
    },
  });

  assert.deepEqual(result, {
    markerPresent: true,
    injected: true,
    version: "1.0.0",
    injectedAt: "now",
    entrypointLoadedAt: "later",
    entrypointUrl: "http://127.0.0.1/entry.js",
    entrypointHash: "abc",
    transport: {
      connected: true,
      connectedAt: "connect-time",
      lastPingAt: "ping-time",
      lastEvent: { event: "system.ready", receivedAt: "event-time" },
      lastError: null,
    },
  });
});

test("runtime diagnostics does not expose raw marker fields", () => {
  const result = runDiagnostics({
    __steamBridge: {
      loaded: true,
      version: "1.0.0",
      injectedAt: "now",
      entrypointUrl: "http://127.0.0.1/entry.js",
      token: "secret",
      privateRuntime: { socket: true },
    },
  });

  assert.equal(result.markerPresent, true);
  assert.equal("marker" in result, false);
  assert.equal("error" in result, false);
  assert.equal("token" in result, false);
  assert.equal("privateRuntime" in result, false);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("runtime diagnostics does not expose transport token", () => {
  const result = runDiagnostics({
    __steamBridge: {
      loaded: true,
      version: "1.0.0",
      injectedAt: "now",
      entrypointUrl: "http://127.0.0.1/entry.js",
      transport: { connected: false, lastError: "failed", token: "secret" },
    },
  });

  assert.equal(JSON.stringify(result).includes("secret"), false);
});

type RuntimeMarker = {
  loaded: boolean;
  version: string;
  injectedAt: string;
  entrypointLoadedAt?: string;
  entrypointHash?: string;
  entrypointUrl?: string;
  transport?: unknown;
  token?: string;
  privateRuntime?: unknown;
};

type RuntimeWindow = {
  __steamBridge?: RuntimeMarker | string;
};

type RuntimeDiagnostics = {
  injected: boolean;
  markerPresent: boolean;
  transport: unknown;
  version: string | null;
};

async function runInjection(
  window: RuntimeWindow,
  options: { entrypointUrl: string; version: string },
): Promise<{ status: string; marker: RuntimeMarker }> {
  const script = buildRuntimeInjection(options);
  return (await new Function("window", `return ${script}`)(window)) as {
    status: string;
    marker: RuntimeMarker;
  };
}

function runDiagnostics(window: RuntimeWindow): RuntimeDiagnostics {
  return new Function("window", `return ${buildRuntimeDiagnosticsRead()}`)(
    window,
  ) as RuntimeDiagnostics;
}

function entrypointDataUrl(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function createEmptyModuleFile(): Promise<{ url: string; remove(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "steam-bridge-injection-"));
  const filePath = join(directory, "entry.mjs");
  await writeFile(filePath, "", "utf8");
  return {
    url: pathToFileURL(filePath).toString(),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __injectionCount: number | undefined;
  // eslint-disable-next-line no-var
  var __injectionRan: boolean | undefined;
}
