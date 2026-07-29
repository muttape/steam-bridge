import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  initialReinjectionLoopState,
  runReinjectionTick,
  watchReinjectionLoop,
  type ReinjectionLoopDeps,
} from "../src/reinjection-loop.js";
import type { CdpTarget } from "../src/cdp.js";

const targetA = target("a");
const targetB = target("b");

test("reinjection loop waits with backoff when target is missing", async () => {
  const result = await runReinjectionTick(
    deps({ targets: [] }),
    initialReinjectionLoopState(),
    options(),
  );

  assert.equal(result.action, "wait");
  assert.equal(result.reason, "target-missing");
  assert.equal(result.state.nextAttemptAtMs, 1000);
  assert.equal(result.state.selectedTargetId, undefined);
});

test("reinjection loop injects when target appears", async () => {
  let injects = 0;
  const result = await runReinjectionTick(
    deps({
      targets: [targetA],
      onInject: () => {
        injects += 1;
      },
    }),
    initialReinjectionLoopState(),
    options(),
  );

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "target-found");
  assert.equal(injects, 1);
});

test("reinjection loop skips when first target is already loaded", async () => {
  let injects = 0;
  const result = await runReinjectionTick(
    deps({
      targets: [targetA],
      diagnostics: {
        markerPresent: true,
        injected: true,
        version: "1.0.0",
        entrypointHash: hashEntrypoint("http://127.0.0.1:7331/entry.js?token=one"),
      },
      onInject: () => {
        injects += 1;
      },
    }),
    initialReinjectionLoopState(),
    options(),
  );

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "already-loaded");
  assert.equal(injects, 0);
});

test("reinjection loop injects when first target marker is missing", async () => {
  const result = await runReinjectionTick(
    deps({ targets: [targetA], diagnostics: { markerPresent: false } }),
    initialReinjectionLoopState(),
    options(),
  );

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "target-found");
});

test("reinjection loop injects first target when diagnostics fails", async () => {
  const result = await runReinjectionTick(
    deps({
      targets: [targetA],
      readDiagnostics: async () => {
        throw new Error("closed");
      },
    }),
    initialReinjectionLoopState(),
    options(),
  );

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "target-found");
});

test("reinjection loop injects when target appears after missing", async () => {
  const missing = await runReinjectionTick(
    deps({ targets: [] }),
    initialReinjectionLoopState(),
    options(),
  );
  const result = await runReinjectionTick(
    deps({ targets: [targetA] }),
    missing.state,
    options({ nowMs: 1000 }),
  );

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "target-found");
});

test("reinjection loop reinjects when target id changes", async () => {
  const state = { ...initialReinjectionLoopState(), selectedTargetId: "old" };
  const result = await runReinjectionTick(deps({ targets: [targetB] }), state, options());

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "target-changed");
  assert.equal(result.state.selectedTargetId, "b");
});

test("reinjection loop reinjects when marker is missing", async () => {
  const state = { ...initialReinjectionLoopState(), selectedTargetId: "a" };
  const result = await runReinjectionTick(
    deps({ targets: [targetA], diagnostics: { markerPresent: false } }),
    state,
    options(),
  );

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "marker-missing");
});

test("reinjection loop reinjects when marker is not loaded", async () => {
  const state = { ...initialReinjectionLoopState(), selectedTargetId: "a" };
  const result = await runReinjectionTick(
    deps({ targets: [targetA], diagnostics: { markerPresent: true, injected: false } }),
    state,
    options(),
  );

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "marker-not-loaded");
});

test("reinjection loop skips same version and entrypoint hash", async () => {
  let injects = 0;
  const state = { ...initialReinjectionLoopState(), selectedTargetId: "a" };
  const result = await runReinjectionTick(
    deps({
      targets: [targetA],
      diagnostics: {
        markerPresent: true,
        injected: true,
        version: "1.0.0",
        entrypointHash: hashEntrypoint("http://127.0.0.1:7331/entry.js?token=one"),
      },
      onInject: () => {
        injects += 1;
      },
    }),
    state,
    options(),
  );

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "already-loaded");
  assert.equal(injects, 0);
});

test("reinjection loop reinjects when version changes", async () => {
  const state = { ...initialReinjectionLoopState(), selectedTargetId: "a" };
  const result = await runReinjectionTick(
    deps({
      targets: [targetA],
      diagnostics: {
        markerPresent: true,
        injected: true,
        version: "old",
        entrypointHash: hashEntrypoint("http://127.0.0.1:7331/entry.js?token=one"),
      },
    }),
    state,
    options(),
  );

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "version-changed");
});

test("reinjection loop reinjects when entrypoint token changes", async () => {
  const state = { ...initialReinjectionLoopState(), selectedTargetId: "a" };
  const result = await runReinjectionTick(
    deps({
      targets: [targetA],
      diagnostics: {
        markerPresent: true,
        injected: true,
        version: "1.0.0",
        entrypointHash: hashEntrypoint("http://127.0.0.1:7331/entry.js?token=old"),
      },
    }),
    state,
    options(),
  );

  assert.equal(result.action, "inject");
  assert.equal(result.reason, "entrypoint-changed");
});

test("reinjection loop backs off after injection failure", async () => {
  const result = await runReinjectionTick(
    deps({
      targets: [targetA],
      onInject: () => {
        throw new Error("boom");
      },
    }),
    initialReinjectionLoopState(),
    options(),
  );

  assert.equal(result.action, "wait");
  assert.equal(result.reason, "injection-failed");
  assert.equal(result.state.nextAttemptAtMs, 1000);
});

test("reinjection loop does not leave token in marker after reinjection", async () => {
  const module = await createEmptyModuleFile();
  const window: { __steamBridge?: unknown } = {};
  try {
    await runReinjectionTick(
      deps({
        targets: [targetA],
        onInject: async (_target, script) => {
          await new Function("window", `return ${script}`)(window);
        },
      }),
      initialReinjectionLoopState(),
      options({ entrypointUrl: `${module.url}?token=secret` }),
    );

    assert.equal(JSON.stringify(window.__steamBridge).includes("secret"), false);
  } finally {
    await module.remove();
  }
});

test("watch loop cleans up abort listeners after timeout", async () => {
  const signal = new CountingAbortSignal();
  let ticks = 0;

  await watchReinjectionLoop(
    deps({ targets: [] }),
    {
      ...options(),
      pollIntervalMs: 1,
      onTick() {
        ticks += 1;
        if (ticks === 2) signal.abort();
      },
    },
    signal as unknown as AbortSignal,
  );

  assert.equal(signal.adds, signal.removes);
});

function deps(config: {
  targets: CdpTarget[];
  diagnostics?: Record<string, unknown>;
  readDiagnostics?: ReinjectionLoopDeps["readDiagnostics"];
  onInject?: (target: CdpTarget, script: string) => void | Promise<void>;
}): ReinjectionLoopDeps {
  return {
    async probeTargets() {
      return config.targets;
    },
    async readDiagnostics() {
      if (config.readDiagnostics) return config.readDiagnostics(targetA);
      return config.diagnostics ?? { markerPresent: false };
    },
    async inject(target, script) {
      await config.onInject?.(target, script);
    },
  };
}

class CountingAbortSignal extends EventTarget {
  aborted = false;
  adds = 0;
  removes = 0;

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    if (type === "abort") this.adds += 1;
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    if (type === "abort") this.removes += 1;
    super.removeEventListener(type, listener, options);
  }

  abort(): void {
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
  }
}

function options(
  overrides: Partial<Parameters<typeof runReinjectionTick>[2]> = {},
): Parameters<typeof runReinjectionTick>[2] {
  return {
    entrypointUrl: "http://127.0.0.1:7331/entry.js?token=one",
    version: "1.0.0",
    nowMs: 0,
    ...overrides,
  };
}

function target(id: string): CdpTarget {
  return {
    id,
    title: "SharedJSContext",
    url: "https://steamloopback.host/index.html",
    webSocketDebuggerUrl: `ws://127.0.0.1:8080/devtools/page/${id}`,
  };
}

function hashEntrypoint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function createEmptyModuleFile(): Promise<{ url: string; remove(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "steam-bridge-reinjection-"));
  const filePath = join(directory, "entry.mjs");
  await writeFile(filePath, "", "utf8");
  return {
    url: pathToFileURL(filePath).toString(),
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
