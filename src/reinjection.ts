export type ReinjectionState = {
  attempts: number;
  nextDelayMs: number;
  status: "idle" | "waiting" | "injecting" | "cooldown";
};

export type ReinjectionEvent =
  | "target-found"
  | "target-missing"
  | "injected"
  | "injection-failed"
  | "detached"
  | "marker-missing";

export function transitionReinjection(
  state: ReinjectionState,
  event: ReinjectionEvent,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {},
): ReinjectionState {
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;

  if (event === "target-found" || event === "marker-missing") {
    return { ...state, status: "injecting" };
  }

  if (event === "injected") {
    return { attempts: 0, nextDelayMs: baseDelayMs, status: "idle" };
  }

  const attempts = state.attempts + 1;
  const nextDelayMs = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));

  return {
    attempts,
    nextDelayMs,
    status: event === "detached" ? "cooldown" : "waiting",
  };
}
