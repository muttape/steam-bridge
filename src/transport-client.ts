import {
  parseTransportMessage,
  stringifyTransportMessage,
  type EventMessage,
} from "./transport-protocol.js";

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const OPEN_SOCKET_STATE = 1;

export class TransportClient {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.handleMessage(String(event.data)));
    socket.addEventListener("close", () => this.rejectPending("Transport socket closed"));
    socket.addEventListener("error", () => this.rejectPending("Transport socket failed"));
  }

  static connect(url: string): Promise<TransportClient> {
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(new TransportClient(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("Transport socket failed")), {
        once: true,
      });
    });
  }

  call(route: string, ...args: unknown[]): Promise<unknown> {
    if (this.socket.readyState !== OPEN_SOCKET_STATE) {
      return Promise.reject(new Error("Transport socket is not open"));
    }
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.socket.send(stringifyTransportMessage({ v: 1, type: "call", id, route, args }));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(event: string, listener: (...args: unknown[]) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(data: string): void {
    const message = parseTransportMessage(data);
    if (message.type === "reply") {
      this.pending.get(message.id)?.resolve(message.result);
      this.pending.delete(message.id);
      return;
    }

    if (message.type === "error") {
      const error = new Error(message.error.message);
      error.name = message.error.code;
      if (message.id === undefined) {
        this.rejectPending("Invalid transport message");
      } else {
        this.pending.get(message.id)?.reject(error);
        this.pending.delete(message.id);
      }
      return;
    }

    if (message.type === "event") {
      this.emit(message);
    }
  }

  private emit(message: EventMessage): void {
    for (const listener of this.listeners.get(message.event) ?? []) {
      listener(...message.args);
    }
  }

  private rejectPending(message: string): void {
    for (const call of this.pending.values()) {
      call.reject(new Error(message));
    }
    this.pending.clear();
  }
}
