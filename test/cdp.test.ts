import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { CdpCommandError, evaluateJavascript } from "../src/cdp.js";

const realWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = realWebSocket;
});

test("evaluateJavascript sends Runtime.evaluate with awaitPromise by default", async () => {
  const sockets = useFakeWebSocket((socket, message) => {
    assert.deepEqual(message, {
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression: "Promise.resolve(42)",
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
    });
    socket.message({ id: 1, result: { result: { type: "number", value: 42 } } });
  });

  const result = await evaluateJavascript("ws://target", "Promise.resolve(42)");

  assert.deepEqual(result, { kind: "value", value: 42, description: undefined });
  assert.equal(sockets[0]?.isClosed, true);
});

test("evaluateJavascript can disable awaitPromise", async () => {
  useFakeWebSocket((socket, message) => {
    assert.equal(message.params.awaitPromise, false);
    socket.message({ id: 1, result: { result: { type: "boolean", value: true } } });
  });

  await evaluateJavascript("ws://target", "true", { awaitPromise: false });
});

test("evaluateJavascript throws on exceptionDetails", async () => {
  const details = { text: "boom" };
  useFakeWebSocket((socket) => {
    socket.message({ id: 1, result: { result: { type: "object" }, exceptionDetails: details } });
  });

  await assert.rejects(
    evaluateJavascript("ws://target", "throw new Error('boom')"),
    (error) =>
      error instanceof CdpCommandError &&
      error.message === "JavaScript evaluation failed" &&
      JSON.stringify(error.details) === JSON.stringify(details),
  );
});

test("evaluateJavascript throws on CDP error response", async () => {
  useFakeWebSocket((socket) => {
    socket.message({ id: 1, error: { message: "No target" } });
  });

  await assert.rejects(
    evaluateJavascript("ws://target", "1"),
    (error) => error instanceof CdpCommandError && error.message === "No target",
  );
});

test("evaluateJavascript throws when Runtime result is missing", async () => {
  useFakeWebSocket((socket) => {
    socket.message({ id: 1, result: {} });
  });

  await assert.rejects(evaluateJavascript("ws://target", "1"), /did not include a Runtime result/);
});

test("evaluateJavascript preserves unserializableValue", async () => {
  useFakeWebSocket((socket) => {
    socket.message({ id: 1, result: { result: { type: "number", unserializableValue: "NaN" } } });
  });

  assert.deepEqual(await evaluateJavascript("ws://target", "NaN"), {
    kind: "unserializable",
    value: "NaN",
    description: undefined,
  });
});

test("evaluateJavascript ignores unrelated response ids until timeout", async () => {
  useFakeWebSocket((socket) => {
    socket.message({ id: 99, result: { result: { value: "wrong" } } });
  });

  await assert.rejects(
    evaluateJavascript("ws://target", "1", { timeoutMs: 5 }),
    /timed out after 5ms/,
  );
});

test("evaluateJavascript rejects when socket closes with pending call", async () => {
  useFakeWebSocket((socket) => {
    socket.closeFromServer();
  });

  await assert.rejects(
    evaluateJavascript("ws://target", "1", { timeoutMs: 100 }),
    /socket closed before response/,
  );
});

type CdpRequest = {
  id: number;
  method: string;
  params: Record<string, unknown>;
};

class FakeWebSocket extends EventTarget {
  isClosed = false;

  constructor(
    readonly url: string,
    private readonly onSend: (socket: FakeWebSocket, message: CdpRequest) => void,
  ) {
    super();
    setTimeout(() => this.dispatchEvent(new Event("open")), 0);
  }

  send(data: string): void {
    this.onSend(this, JSON.parse(data) as CdpRequest);
  }

  close(): void {
    this.isClosed = true;
    this.dispatchEvent(new Event("close"));
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  }

  closeFromServer(): void {
    this.dispatchEvent(new Event("close"));
  }
}

function useFakeWebSocket(
  onSend: (socket: FakeWebSocket, message: CdpRequest) => void,
): FakeWebSocket[] {
  const sockets: FakeWebSocket[] = [];
  globalThis.WebSocket = class extends FakeWebSocket {
    constructor(url: string) {
      super(url, onSend);
      sockets.push(this);
    }
  } as unknown as typeof WebSocket;
  return sockets;
}
