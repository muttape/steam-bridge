import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { parseTransportMessage } from "../src/transport-protocol.js";
import { TransportClient } from "../src/transport-client.js";
import { startTransportServer } from "../src/transport-server.js";
import { MAX_TRANSPORT_MESSAGE_BYTES } from "../src/transport-server.js";

test("protocol rejects invalid JSON without id", () => {
  assert.deepEqual(parseTransportMessage("{"), {
    v: 1,
    type: "error",
    error: { code: "invalid_message", message: "Message is not valid JSON" },
  });
});

test("protocol preserves numeric id on invalid message errors", () => {
  assert.deepEqual(
    parseTransportMessage(JSON.stringify({ v: 1, type: "call", id: 7, route: "x", args: "no" })),
    {
      v: 1,
      type: "error",
      id: 7,
      error: { code: "invalid_message", message: "Invalid call message" },
    },
  );
});

test("protocol rejects unsupported version and invalid message shapes", () => {
  assert.equal(
    parseTransportMessage(JSON.stringify({ v: 2, type: "call", id: 1, route: "x", args: [] })).type,
    "error",
  );

  for (const message of [
    { v: 1, type: "call", id: 1, route: "x", args: "bad" },
    { v: 1, type: "reply", id: "bad", result: null },
    { v: 1, type: "error", id: 1, error: { code: "bad", message: "bad" } },
    { v: 1, type: "event", event: 1, args: [] },
  ]) {
    assert.deepEqual(parseTransportMessage(JSON.stringify(message)), {
      v: 1,
      type: "error",
      ...(message.id === 1 ? { id: 1 } : {}),
      error: { code: "invalid_message", message: `Invalid ${message.type} message` },
    });
  }
});

test("transport call returns reply", async () => {
  const server = await startTransportServer({
    port: 0,
    routes: new Map([["system.ping", () => "pong"]]),
  });
  try {
    assert.notEqual(server.port, 0);
    const client = await TransportClient.connect(wsUrl(server));

    assert.equal(await client.call("system.ping"), "pong");

    client.close();
  } finally {
    await server.close();
  }
});

test("transport missing route rejects with route_not_found", async () => {
  const server = await startTransportServer({
    port: 0,
    routes: new Map([["system.ping", () => "pong"]]),
  });
  try {
    const client = await TransportClient.connect(wsUrl(server));

    await assert.rejects(client.call("missing.route"), { name: "route_not_found" });

    client.close();
  } finally {
    await server.close();
  }
});

test("transport emits events with args", async () => {
  const server = await startTransportServer({ port: 0 });
  try {
    const client = await TransportClient.connect(wsUrl(server));
    const event = new Promise<unknown[]>((resolve) =>
      client.on("system.ready", (...args) => resolve(args)),
    );

    server.emit("system.ready", 1, "ok");

    assert.deepEqual(await event, [1, "ok"]);
    client.close();
  } finally {
    await server.close();
  }
});

test("transport rejects missing or wrong token", async () => {
  const server = await startTransportServer({ port: 0 });
  try {
    await assert.rejects(connectRaw(`ws://127.0.0.1:${server.port}/ws`));
    await assert.rejects(connectRaw(`ws://127.0.0.1:${server.port}/ws?token=wrong`));
  } finally {
    await server.close();
  }
});

test("transport rejects non-loopback host", async () => {
  await assert.rejects(startTransportServer({ host: "0.0.0.0", port: 0 }), /127\.0\.0\.1/);
});

test("transport rejects oversized messages", async () => {
  const server = await startTransportServer({ port: 0 });
  try {
    const socket = await connectRaw(wsUrl(server));
    const close = new Promise<void>((resolve) => socket.once("close", () => resolve()));

    socket.send("x".repeat(MAX_TRANSPORT_MESSAGE_BYTES + 1));

    await close;
    socket.close();
  } finally {
    await server.close();
  }
});

test("server returns invalid_message for malformed call", async () => {
  const server = await startTransportServer({
    port: 0,
    routes: new Map([["system.ping", () => "pong"]]),
  });
  try {
    const socket = await connectRaw(wsUrl(server));
    const response = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    );

    socket.send(JSON.stringify({ v: 1, type: "call", id: 9, route: "system.ping", args: "bad" }));

    assert.deepEqual(JSON.parse(await response), {
      v: 1,
      type: "error",
      id: 9,
      error: { code: "invalid_message", message: "Invalid call message" },
    });
    socket.close();
  } finally {
    await server.close();
  }
});

test("server returns handler_error without stack for thrown route", async () => {
  const server = await startTransportServer({
    port: 0,
    routes: new Map([
      [
        "broken.route",
        () => {
          throw new Error("boom");
        },
      ],
    ]),
  });
  try {
    const socket = await connectRaw(wsUrl(server));
    const response = new Promise<string>((resolve) =>
      socket.once("message", (data) => resolve(data.toString())),
    );

    socket.send(JSON.stringify({ v: 1, type: "call", id: 11, route: "broken.route", args: [] }));

    assert.deepEqual(JSON.parse(await response), {
      v: 1,
      type: "error",
      id: 11,
      error: { code: "handler_error", message: "Route handler failed" },
    });
    socket.close();
  } finally {
    await server.close();
  }
});

test("client rejects pending calls when socket closes", async () => {
  const server = await startTransportServer({
    port: 0,
    routes: new Map([["system.ping", () => "pong"]]),
  });
  try {
    const socket = await connectRaw(wsUrl(server));
    const client = new TransportClient(socket as unknown as globalThis.WebSocket);
    const pending = client.call("system.ping");

    socket.close();

    await assert.rejects(pending, /closed|failed/);
  } finally {
    await server.close();
  }
});

test("client rejects call when socket is not open", async () => {
  const socket = new ThrowingSocketStub(3);
  const client = new TransportClient(socket as unknown as globalThis.WebSocket);

  await assert.rejects(client.call("system.ping"), /not open/);
});

test("client rejects call when socket send fails", async () => {
  const socket = new ThrowingSocketStub(1);
  const client = new TransportClient(socket as unknown as globalThis.WebSocket);

  await assert.rejects(client.call("system.ping"), /send failed/);
});

test("transport server close closes clients and pending calls", async () => {
  const server = await startTransportServer({
    port: 0,
    routes: new Map([["slow.route", () => new Promise(() => {})]]),
  });
  const socket = await connectRaw(wsUrl(server));
  const client = new TransportClient(socket as unknown as globalThis.WebSocket);
  const pending = client.call("slow.route");

  await server.close();

  await assert.rejects(pending, /closed|failed/);
});

test("client rejects pending calls on invalid backend message", async () => {
  const socket = new ThrowingSocketStub(1, false);
  const client = new TransportClient(socket as unknown as globalThis.WebSocket);
  const pending = client.call("system.ping");

  socket.dispatchEvent(new MessageEvent("message", { data: "{" }));

  await assert.rejects(pending, /Invalid transport message/);
});

type StartedServer = {
  port: number;
  token: string;
};

function wsUrl(server: StartedServer): string {
  return `ws://127.0.0.1:${server.port}/ws?token=${server.token}`;
}

function connectRaw(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", () => reject(new Error("Unexpected response")));
  });
}

class ThrowingSocketStub extends EventTarget {
  constructor(
    readonly readyState: number,
    private readonly shouldThrow = true,
  ) {
    super();
  }

  send(_data: string): void {
    if (this.shouldThrow) throw new Error("send failed");
  }

  close(): void {}
}
