export type RuntimeInjectionOptions = {
  entrypointUrl: string;
  version: string;
  markerName?: string;
};

export function buildRuntimeInjection(options: RuntimeInjectionOptions): string {
  const markerName = options.markerName ?? "__steamBridge";
  const markerKey = JSON.stringify(markerName);
  const version = JSON.stringify(options.version);
  const entrypointUrl = JSON.stringify(options.entrypointUrl);

  return `(() => {
  const markerName = ${markerKey};
  const entrypointUrl = ${entrypointUrl};
  const version = ${version};
  const hashEntrypoint = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  };
  const entrypointHash = hashEntrypoint(entrypointUrl);
  const importEntrypointUrl = (() => {
    try {
      const url = new URL(entrypointUrl);
      if (url.protocol !== "data:") url.searchParams.set("runtimeVersion", version);
      return url.toString();
    } catch {
      return entrypointUrl;
    }
  })();
  const publicEntrypointUrl = (() => {
    try {
      const url = new URL(entrypointUrl);
      url.searchParams.delete("token");
      return url.toString();
    } catch {
      return "";
    }
  })();
  const existing = window[markerName];
  if (existing && existing.loaded === true && existing.version === version && existing.entrypointHash === entrypointHash) {
    return { status: "already-loaded", marker: existing };
  }
  window[markerName] = { loaded: false, version, entrypointHash, injectedAt: new Date().toISOString(), entrypointUrl: publicEntrypointUrl };
  return import(importEntrypointUrl).then(
    () => {
      window[markerName].loaded = true;
      return { status: "loaded", marker: window[markerName] };
    },
    (error) => {
      window[markerName] = { ...window[markerName], loaded: false, error: String(error) };
      throw error;
    },
  );
})()`;
}

export function buildRuntimeDiagnosticsRead(markerName = "__steamBridge"): string {
  const markerKey = JSON.stringify(markerName);
  return `(() => {
  const valueOrNull = (value) => value === undefined ? null : value;
  const marker = window[${markerKey}];
  const emptyTransport = { connected: false, connectedAt: null, lastPingAt: null, lastEvent: null, lastError: null };
  if (!marker || typeof marker !== "object") {
    return {
      markerPresent: false,
      injected: false,
      version: null,
      injectedAt: null,
      entrypointLoadedAt: null,
      entrypointUrl: null,
      entrypointHash: null,
      transport: emptyTransport,
    };
  }
  const transport = marker.transport && typeof marker.transport === "object" ? marker.transport : {};
  return {
    markerPresent: true,
    injected: marker.loaded === true,
    version: valueOrNull(marker.version),
    injectedAt: valueOrNull(marker.injectedAt),
    entrypointLoadedAt: valueOrNull(marker.entrypointLoadedAt),
    entrypointUrl: valueOrNull(marker.entrypointUrl),
    entrypointHash: valueOrNull(marker.entrypointHash),
    transport: {
      connected: transport.connected === true,
      connectedAt: valueOrNull(transport.connectedAt),
      lastPingAt: valueOrNull(transport.lastPingAt),
      lastEvent: valueOrNull(transport.lastEvent),
      lastError: valueOrNull(transport.lastError),
    },
  };
})()`;
}
