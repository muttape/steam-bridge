import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  makeTransportError,
  parseTransportMessage,
  stringifyTransportMessage,
  type TransportMessage,
} from "./transport-protocol.js";

export const MAX_TRANSPORT_MESSAGE_BYTES = 16 * 1024;

export type TransportRoute = (...args: unknown[]) => Promise<unknown> | unknown;

export type TransportServer = {
  port: number;
  token: string;
  emit(event: string, ...args: unknown[]): void;
  close(): Promise<void>;
};

export type TransportServerOptions = {
  host?: string;
  port?: number;
  routes?: Map<string, TransportRoute>;
  token?: string;
  onRequest?: (request: IncomingMessage, response: ServerResponse) => boolean;
};

export async function startTransportServer(
  options: TransportServerOptions = {},
): Promise<TransportServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("Transport server must bind to 127.0.0.1");
  }

  const token = options.token ?? randomBytes(32).toString("base64url");
  const routes = options.routes ?? new Map<string, TransportRoute>();
  const clients = new Set<WebSocket>();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TRANSPORT_MESSAGE_BYTES,
  });
  const httpServer = createServer((request, response) => {
    if (options.onRequest?.(request, response)) return;
    response.writeHead(404).end();
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", `http://${host}`);
    if (requestUrl.pathname !== "/ws" || requestUrl.searchParams.get("token") !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });

  webSocketServer.on("connection", (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => clients.delete(client));
    client.on("message", async (data) => {
      await handleTransportMessage(client, routes, data.toString());
    });
  });

  const port = await listen(httpServer, host, options.port ?? 0);
  return {
    port,
    token,
    emit(event, ...args) {
      for (const client of clients) {
        send(client, { v: 1, type: "event", event, args });
      }
    },
    async close() {
      for (const client of clients) client.close();
      await closeWebSocketServer(webSocketServer);
      await closeHttpServer(httpServer);
    },
  };
}

async function handleTransportMessage(
  client: WebSocket,
  routes: Map<string, TransportRoute>,
  data: string,
): Promise<void> {
  const message = parseTransportMessage(data);
  if (message.type !== "call") {
    send(
      client,
      message.type === "error"
        ? message
        : makeTransportError(undefined, "invalid_message", "Only call messages are accepted"),
    );
    return;
  }

  const route = routes.get(message.route);
  if (!route) {
    send(
      client,
      makeTransportError(message.id, "route_not_found", `Route ${message.route} not found`),
    );
    return;
  }

  try {
    send(client, { v: 1, type: "reply", id: message.id, result: await route(...message.args) });
  } catch {
    send(client, makeTransportError(message.id, "handler_error", "Route handler failed"));
  }
}

function send(client: WebSocket, message: TransportMessage): void {
  if (client.readyState === client.OPEN) {
    client.send(stringifyTransportMessage(message));
  }
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
