import assert from "node:assert/strict";
import { test } from "node:test";

test("public API exports stable runtime primitives", async () => {
  const api = await import("steam-bridge");

  for (const name of [
    "CdpCommandError",
    "MAX_TRANSPORT_MESSAGE_BYTES",
    "buildRuntimeDiagnosticsRead",
    "buildRuntimeInjection",
    "evaluateJavascript",
    "initialReinjectionLoopState",
    "makeCdpReinjectionDeps",
    "probeCdp",
    "rankSharedContextTargets",
    "runReinjectionTick",
    "selectSharedContextTarget",
    "startTransportServer",
    "watchReinjectionLoop",
  ]) {
    assert.equal(name in api, true, `Missing public export ${name}`);
  }

  assert.equal("startTransportSpikeServer" in api, false);
  assert.equal("startLibraryAppMountLifecycle" in api, false);
  assert.equal("TransportClient" in api, false);
  assert.match(api.buildRuntimeDiagnosticsRead(), /__steamBridge/);
});

test("TransportClient has an isolated browser-safe entrypoint", async () => {
  const api = await import("steam-bridge/transport-client");

  assert.equal(typeof api.TransportClient, "function");
});

test("Library App lifecycle has an isolated browser-safe entrypoint", async () => {
  const api = await import("steam-bridge/library-app-mount");

  assert.equal(typeof api.readSteamLibraryAppContext, "function");
  assert.equal(typeof api.startLibraryAppMountLifecycle, "function");
});
