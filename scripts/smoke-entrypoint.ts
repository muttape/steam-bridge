import {
  readSteamLibraryAppContext,
  startLibraryAppMountLifecycle,
} from "../src/library-app-mount.js";
import { TransportClient } from "../src/transport-client.js";

const entrypointUrl = new URL(import.meta.url);
const webSocketUrl = new URL("/ws", entrypointUrl);
webSocketUrl.protocol = "ws:";
webSocketUrl.searchParams.set("token", entrypointUrl.searchParams.get("token") ?? "");

const runtime = (window.__steamBridge ??= {}) as Record<string, unknown>;
const transport = {
  connected: false,
  connectedAt: null as string | null,
  lastPingAt: null as string | null,
  lastEvent: null as { event: string; receivedAt: string } | null,
  lastError: null as string | null,
};
runtime.entrypointLoadedAt = new Date().toISOString();
runtime.transport = transport;

const client = await TransportClient.connect(webSocketUrl.toString());
transport.connected = true;
transport.connectedAt = new Date().toISOString();
client.on("smoke.event", () => {
  transport.lastEvent = { event: "smoke.event", receivedAt: new Date().toISOString() };
});
await client.call("system.ping");
transport.lastPingAt = new Date().toISOString();

const context = readSteamLibraryAppContext();
let lifecycle: ReturnType<typeof startLibraryAppMountLifecycle> | null = null;
if (context) {
  lifecycle = startLibraryAppMountLifecycle({
    consumerId: "steam-bridge-smoke",
    createElement(_context, document) {
      const element = document.createElement("steam-bridge-smoke");
      element.dataset.steamBridgeSmoke = "mounted";
      return element;
    },
  });
}

runtime.smoke = {
  context,
  get mountCount() {
    return countMounts();
  },
  removeMount() {
    readDesktopDocument()?.querySelector("[data-steam-bridge-smoke]")?.remove();
  },
  cleanup() {
    lifecycle?.stop();
    client.close();
    readDesktopDocument()
      ?.querySelectorAll("[data-steam-bridge-smoke]")
      .forEach((element) => element.remove());
  },
};

function countMounts(): number {
  return readDesktopDocument()?.querySelectorAll("[data-steam-bridge-smoke]").length ?? 0;
}

function readDesktopDocument(): Document | undefined {
  const popup = Reflect.get(globalThis, "g_PopupManager") as
    | { GetExistingPopup?: (name: string) => { window?: { document?: Document } } | null }
    | undefined;
  return popup?.GetExistingPopup?.("SP Desktop_uid0")?.window?.document;
}

declare global {
  interface Window {
    __steamBridge?: Record<string, unknown>;
  }
}
