# steam-bridge

`steam-bridge` is a standalone TypeScript/Node library for integrating with Steam desktop through
CEF and the Chrome DevTools Protocol (CDP).

## Domain

- **Steam desktop / CEF / CDP**: Steam exposes CEF targets through a local CDP endpoint.
- **SharedJSContext**: the target containing Steam desktop globals and the injection boundary.
- **Runtime Marker**: `window.__steamBridge`, the compatibility marker for injected runtime state.
  Its camelCase spelling is preserved because it is a runtime protocol identifier, not project
  branding.
- **Transport**: the authenticated loopback WebSocket protocol between browser code and a Node host.
- **Reinjection**: restoring the runtime after Steam replaces or reloads `SharedJSContext`.
- **Library App Mount Lifecycle**: browser-side discovery, mounting, remounting, and cleanup for
  custom elements on active Steam Library app pages.
- **Consumer App**: any application using public `steam-bridge` entrypoints. Product behavior,
  persistence, and application-specific routes remain outside this repository.
