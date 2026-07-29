# Transport

`steam-bridge` provides an authenticated local WebSocket transport between injected browser code and
a Node host.

The server binds only to `127.0.0.1`, requires a random session token, limits messages to 16 KiB,
and exposes only explicitly registered routes. Protocol version `1` supports `call`, `reply`,
`error`, and server-initiated `event` messages.

```ts
import { startTransportServer } from "steam-bridge";

const server = await startTransportServer({
  routes: new Map([["system.ping", () => "pong"]]),
});
```

Browser code uses the isolated, Node-free entrypoint:

```ts
import { TransportClient } from "steam-bridge/transport-client";

const client = await TransportClient.connect(
  `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
);
await client.call("system.ping");
```

Consumer Apps own application-specific routes and authorization policy.
