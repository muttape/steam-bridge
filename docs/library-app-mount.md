# Library App Mount Lifecycle

`steam-bridge/library-app-mount` provides the browser-side lifecycle used by Consumer Apps to
integrate custom elements into Steam Library app pages.

```ts
import { startLibraryAppMountLifecycle } from "steam-bridge/library-app-mount";

const lifecycle = startLibraryAppMountLifecycle({
  consumerId: "my-consumer",

  createElement(context, document) {
    const element = document.createElement("my-element");
    element.appContext = context;
    return element;
  },
});

// Consumer shutdown
lifecycle.stop();
```

`context.appId` is the stable Steam app identity. `context.displayName` is optional metadata.

The lifecycle owns host discovery, navigation changes, DOM replacement, reinjection safety, and
cleanup. Starting another lifecycle with the same `consumerId` replaces the previous one.

Consumer code must not depend on Steam React internals or hashed CSS classes.
