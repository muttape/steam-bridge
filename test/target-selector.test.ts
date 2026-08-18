import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildRuntimeInjection } from "../src/injection.js";
import { rankSharedContextTargets, selectSharedContextTarget } from "../src/target-selector.js";

test("selects exact SharedJSContext before fallback-looking targets", () => {
  const selected = selectSharedContextTarget([
    {
      id: "1",
      title: "Steam",
      url: "https://steamloopback.host/routes/",
      webSocketDebuggerUrl: "ws://one",
    },
    {
      id: "2",
      title: "SharedJSContext",
      url: "devtools://devtools/bundled/js_app.html",
      webSocketDebuggerUrl: "ws://two",
    },
  ]);

  assert.equal(selected?.target.id, "2");
});

test("selects SharedJSContext from a sanitized real Steam target fixture", async () => {
  const targets = JSON.parse(
    await readFile("fixtures/steam-cdp/windows-2026-07/json-list.json", "utf8"),
  );

  assert.equal(selectSharedContextTarget(targets)?.target.title, "SharedJSContext");
});

test("supports configured exact target titles", () => {
  const ranked = rankSharedContextTargets(
    [
      {
        id: "3",
        title: "Steam Client Service",
        url: "steam://desktop",
        webSocketDebuggerUrl: "ws://three",
      },
    ],
    { exactTitles: ["Steam Client Service"] },
  );

  assert.equal(ranked[0]?.target.id, "3");
  assert.ok(ranked[0]?.score);
});

test("returns null when no target matches", () => {
  assert.equal(
    selectSharedContextTarget([
      { id: "1", title: "Store", url: "https://store.steampowered.com/" },
    ]),
    null,
  );
});

test("ignores matching targets without a websocket url", () => {
  assert.equal(
    selectSharedContextTarget([
      { id: "1", title: "SharedJSContext", url: "https://steamloopback.host/" },
    ]),
    null,
  );
});

test("keeps stable order for ambiguous equal-score targets", () => {
  const ranked = rankSharedContextTargets([
    {
      id: "first",
      title: "Shared Context A",
      url: "about:blank",
      webSocketDebuggerUrl: "ws://first",
    },
    {
      id: "second",
      title: "Shared Context B",
      url: "about:blank",
      webSocketDebuggerUrl: "ws://second",
    },
  ]);

  assert.deepEqual(
    ranked.map((candidate) => candidate.target.id),
    ["first", "second"],
  );
});

test("runtime injection uses structured versioned marker", () => {
  const script = buildRuntimeInjection({
    entrypointUrl: "http://127.0.0.1:7331/entry.js",
    version: "1.2.3",
  });

  assert.match(script, /__steamBridge/);
  assert.match(script, /loaded: false/);
  assert.match(script, /version/);
  assert.match(script, /injectedAt/);
  assert.match(script, /already-loaded/);
});
