# steam-bridge

Standalone TypeScript/Node primitives for Steam desktop CEF/CDP discovery, injection, reinjection,
authenticated loopback transport, and Steam Library app mounting.

Requires Node 24.

## Public entrypoints

- `steam-bridge`: Node-side CDP, injection, reinjection, and transport server APIs.
- `steam-bridge/transport-client`: browser-safe WebSocket protocol client.
- `steam-bridge/library-app-mount`: browser-safe Steam Library custom-element lifecycle.

See [Transport](docs/transport.md) and [Library App mount lifecycle](docs/library-app-mount.md).

## Verification

```sh
npm install
npm test
npm run smoke:steam
```

`npm test` covers deterministic logic and sanitized real-Steam fixture regressions.

`npm run smoke:steam` is an explicit live integration check. It requires a running Steam desktop
client launched with CEF debugging enabled. Open a Library app page to include mount and remount
coverage. No external Consumer App is required.

`npm run steam-cef -- probe|targets|eval|inject|diagnose|watch` provides lower-level diagnostics.
