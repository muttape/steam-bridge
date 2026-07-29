import assert from "node:assert/strict";
import { test } from "node:test";
import { transitionReinjection, type ReinjectionState } from "../src/reinjection.js";

test("reinjection resets attempts after success", () => {
  assert.deepEqual(
    transitionReinjection({ attempts: 3, nextDelayMs: 8000, status: "injecting" }, "injected", {
      baseDelayMs: 1000,
    }),
    { attempts: 0, nextDelayMs: 1000, status: "idle" },
  );
});

test("reinjection does not mutate input state", () => {
  const state: ReinjectionState = { attempts: 1, nextDelayMs: 1000, status: "waiting" };
  const copy = { ...state };

  transitionReinjection(state, "target-missing");

  assert.deepEqual(state, copy);
});

test("reinjection uses cooldown after detach", () => {
  assert.deepEqual(
    transitionReinjection({ attempts: 0, nextDelayMs: 1000, status: "idle" }, "detached"),
    { attempts: 1, nextDelayMs: 1000, status: "cooldown" },
  );
});

test("reinjection backs off after injection failure", () => {
  assert.deepEqual(
    transitionReinjection(
      { attempts: 2, nextDelayMs: 4000, status: "injecting" },
      "injection-failed",
      { baseDelayMs: 1000, maxDelayMs: 5000 },
    ),
    { attempts: 3, nextDelayMs: 4000, status: "waiting" },
  );
});
