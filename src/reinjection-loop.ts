import type { CdpTarget } from "./cdp.js";
import { evaluateJavascript, probeCdp, type EvaluationResult } from "./cdp.js";
import { buildRuntimeDiagnosticsRead, buildRuntimeInjection } from "./injection.js";
import { transitionReinjection, type ReinjectionState } from "./reinjection.js";
import { selectSharedContextTarget } from "./target-selector.js";

export type RuntimeDiagnostics = {
  markerPresent?: boolean;
  injected?: boolean;
  version?: unknown;
  entrypointHash?: unknown;
};

export type ReinjectionLoopState = {
  reinjection: ReinjectionState;
  selectedTargetId?: string;
  nextAttemptAtMs: number;
};

export type ReinjectionTickResult = {
  action: "wait" | "inject" | "skip";
  reason: string;
  state: ReinjectionLoopState;
};

export type ReinjectionLoopOptions = {
  entrypointUrl: string;
  version: string;
  nowMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type ReinjectionLoopDeps = {
  probeTargets(): Promise<CdpTarget[]>;
  readDiagnostics(target: CdpTarget): Promise<RuntimeDiagnostics>;
  inject(target: CdpTarget, script: string): Promise<void>;
};

export function initialReinjectionLoopState(): ReinjectionLoopState {
  return {
    reinjection: { attempts: 0, nextDelayMs: 1000, status: "idle" },
    nextAttemptAtMs: 0,
  };
}

export async function runReinjectionTick(
  deps: ReinjectionLoopDeps,
  state: ReinjectionLoopState,
  options: ReinjectionLoopOptions,
): Promise<ReinjectionTickResult> {
  const nowMs = options.nowMs ?? Date.now();
  if (nowMs < state.nextAttemptAtMs) {
    return { action: "wait", reason: "rate-limited", state };
  }

  let target: CdpTarget | undefined;
  try {
    target = selectSharedContextTarget(await deps.probeTargets())?.target;
  } catch {
    return waitAfter(state, "target-missing", "cdp-unavailable", nowMs, options);
  }

  if (!target?.webSocketDebuggerUrl) {
    return waitAfter(state, "target-missing", "target-missing", nowMs, options);
  }

  const targetChanged =
    state.selectedTargetId !== undefined && state.selectedTargetId !== target.id;
  const targetFound = state.selectedTargetId === undefined;
  let reason = targetChanged ? "target-changed" : "";

  if (!reason) {
    let diagnostics: RuntimeDiagnostics | null = null;
    try {
      diagnostics = await deps.readDiagnostics(target);
    } catch {
      if (targetFound) {
        reason = "target-found";
      } else {
        return waitAfter(state, "detached", "diagnostics-failed", nowMs, options);
      }
    }
    if (!reason) {
      reason = diagnostics ? reinjectionReason(diagnostics, options) : "";
    }
    if (!reason) {
      return {
        action: "skip",
        reason: "already-loaded",
        state: { ...state, selectedTargetId: target.id },
      };
    }
    if (targetFound && reason === "marker-missing") {
      reason = "target-found";
    }
  }

  try {
    await deps.inject(
      target,
      buildRuntimeInjection({ entrypointUrl: options.entrypointUrl, version: options.version }),
    );
  } catch {
    return waitAfter(state, "injection-failed", "injection-failed", nowMs, options);
  }

  return {
    action: "inject",
    reason,
    state: {
      reinjection: transitionReinjection(state.reinjection, "injected", options),
      selectedTargetId: target.id,
      nextAttemptAtMs: nowMs,
    },
  };
}

export function makeCdpReinjectionDeps(
  options: { port?: number; timeoutMs?: number } = {},
): ReinjectionLoopDeps {
  return {
    async probeTargets() {
      return (await probeCdp({ port: options.port, timeoutMs: options.timeoutMs })).targets;
    },
    async readDiagnostics(target) {
      const result = await evaluateJavascript(
        target.webSocketDebuggerUrl!,
        buildRuntimeDiagnosticsRead(),
        {
          awaitPromise: true,
          timeoutMs: options.timeoutMs,
        },
      );
      return valueResult(result);
    },
    async inject(target, script) {
      await evaluateJavascript(target.webSocketDebuggerUrl!, script, {
        awaitPromise: true,
        timeoutMs: options.timeoutMs,
      });
    },
  };
}

export async function watchReinjectionLoop(
  deps: ReinjectionLoopDeps,
  options: ReinjectionLoopOptions & {
    pollIntervalMs?: number;
    onTick?: (result: ReinjectionTickResult) => void;
  },
  signal?: AbortSignal,
): Promise<void> {
  let state = initialReinjectionLoopState();
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  while (!signal?.aborted) {
    const result = await runReinjectionTick(deps, state, options);
    state = result.state;
    options.onTick?.(result);
    await delay(Math.max(pollIntervalMs, state.nextAttemptAtMs - Date.now()), signal);
  }
}

function reinjectionReason(
  diagnostics: RuntimeDiagnostics,
  options: ReinjectionLoopOptions,
): string {
  if (diagnostics.markerPresent !== true) return "marker-missing";
  if (diagnostics.injected !== true) return "marker-not-loaded";
  if (diagnostics.version !== options.version) return "version-changed";
  if (diagnostics.entrypointHash !== hashEntrypoint(options.entrypointUrl))
    return "entrypoint-changed";
  return "";
}

function waitAfter(
  state: ReinjectionLoopState,
  event: Parameters<typeof transitionReinjection>[1],
  reason: string,
  nowMs: number,
  options: ReinjectionLoopOptions,
): ReinjectionTickResult {
  const reinjection = transitionReinjection(state.reinjection, event, options);
  return {
    action: "wait",
    reason,
    state: {
      reinjection,
      selectedTargetId:
        event === "target-missing" || event === "detached" ? undefined : state.selectedTargetId,
      nextAttemptAtMs: nowMs + reinjection.nextDelayMs,
    },
  };
}

function valueResult(result: EvaluationResult): RuntimeDiagnostics {
  if (result.kind !== "value" || !result.value || typeof result.value !== "object") {
    return { markerPresent: false, injected: false };
  }
  return result.value as RuntimeDiagnostics;
}

function hashEntrypoint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener("abort", finish, { once: true });
  });
}
