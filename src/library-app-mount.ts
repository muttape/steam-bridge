const LIBRARY_APP_ROUTE = /^\/(?:routes\/)?library\/app\/(\d+)(?:\/|$)/;
const DESKTOP_POPUP_NAME = "SP Desktop_uid0";
const SETTINGS_CONTROL_SELECTOR = "svg.SVGIcon_Settings";
const PLAY_CONTROL_SELECTOR = "svg.SVGIcon_Play, svg.SVGIcon_Download";
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_WARNING_INTERVAL_MS = 60_000;
// Compatibility key shared by injected runtime versions; preserve its original identifier.
const LIFECYCLE_REGISTRY_KEY = Symbol.for("steamBridge.libraryAppMountLifecycles");

type SteamLocation = {
  pathname?: unknown;
};

type SteamBrowserManager = {
  m_lastLocation?: SteamLocation;
};

type SteamAppOverview = {
  display_name?: unknown;
};

type SteamAppStore = {
  GetAppOverviewByAppID?: (appId: number) => SteamAppOverview | null | undefined;
};

type SteamPopupManager = {
  GetExistingPopup?: (name: string) => {
    window?: {
      document?: Document;
    };
  } | null;
};

type MountedElement = {
  contextKey: string;
  element: HTMLElement;
};

/** Identifies the current Steam Library app. */
export type LibraryAppContext = {
  appId: number;
  displayName?: string;
};

/** A safe warning emitted when a volatile Steam or DOM boundary fails. */
export type LibraryAppMountWarning = {
  code: "library-app-mount-degraded";
  message: string;
};

/** Configures one Consumer App's Library custom-element lifecycle. */
export type LibraryAppMountOptions = {
  consumerId: string;
  createElement: (context: LibraryAppContext, document: Document) => HTMLElement;
  onWarning?: (warning: LibraryAppMountWarning) => void;
  pollIntervalMs?: number;
  warningIntervalMs?: number;
};

/** Controls a running Library App mount lifecycle. */
export type LibraryAppMountLifecycle = {
  stop(): void;
};

/**
 * Reads the current supported Steam Library app route and optional display name.
 *
 * @remarks Volatile Steam globals are contained here. App identity remains
 * available when optional app-store metadata cannot be read.
 * @returns The Library app context, or `null` for unsupported routes and
 * unreadable Steam route state.
 */
export function readSteamLibraryAppContext(): LibraryAppContext | null {
  try {
    return readSteamLibraryAppContextUnsafe();
  } catch {
    return null;
  }
}

function readSteamLibraryAppContextUnsafe(): LibraryAppContext | null {
  const browserManager = readGlobal<SteamBrowserManager>("MainWindowBrowserManager");
  const pathname = browserManager?.m_lastLocation?.pathname;
  if (typeof pathname !== "string") return null;

  const match = LIBRARY_APP_ROUTE.exec(pathname);
  if (!match) return null;

  const appId = Number(match[1]);
  if (!Number.isSafeInteger(appId) || appId <= 0) return null;

  const displayName = readSteamDisplayName(appId);
  return displayName ? { appId, displayName } : { appId };
}

/**
 * Starts and immediately synchronizes one Consumer App's Library mount lifecycle.
 *
 * @remarks Starting the same `consumerId` again stops its previous lifecycle,
 * which makes versioned frontend reinjection idempotent. The factory is called
 * once per compatible action host and again whenever app identity or metadata
 * changes. Call `stop()` to disconnect observation and remove owned elements.
 * @throws {TypeError} When `consumerId` is empty.
 */
export function startLibraryAppMountLifecycle(
  options: LibraryAppMountOptions,
): LibraryAppMountLifecycle {
  if (options.consumerId.trim().length === 0) {
    throw new TypeError("consumerId must not be empty");
  }

  const registry = getLifecycleRegistry();
  registry.get(options.consumerId)?.stop();

  const mountedByHost = new Map<Element, MountedElement>();
  let observedDocument: Document | null = null;
  let observer: MutationObserver | null = null;
  let isStopped = false;
  let lastWarningAt = Number.NEGATIVE_INFINITY;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  const removeOwnedElements = () => {
    for (const mounted of mountedByHost.values()) {
      safelyRemove(mounted.element);
    }
    mountedByHost.clear();
  };

  const warn = () => {
    const now = Date.now();
    if (now - lastWarningAt < (options.warningIntervalMs ?? DEFAULT_WARNING_INTERVAL_MS)) return;
    lastWarningAt = now;

    const warning: LibraryAppMountWarning = {
      code: "library-app-mount-degraded",
      message: "Steam Library integration boundary failed",
    };
    try {
      if (options.onWarning) options.onWarning(warning);
      else console.warn("[steam-bridge] Library App mount lifecycle degraded", warning);
    } catch {
      // Warning consumers must not take down the injected runtime.
    }
  };

  const synchronize = () => {
    if (isStopped) return;
    try {
      const context = readSteamLibraryAppContextUnsafe();
      const document = readSteamDesktopDocument();
      bindDocumentObserver(document);

      if (!context || !document) {
        removeOwnedElements();
        return;
      }

      const hosts = findCompatibleActionHosts(document);
      const currentHosts = new Set(hosts);
      const contextKey = JSON.stringify([context.appId, context.displayName ?? null]);

      for (const [host, mounted] of mountedByHost) {
        if (
          !currentHosts.has(host) ||
          mounted.contextKey !== contextKey ||
          mounted.element.parentElement !== host
        ) {
          safelyRemove(mounted.element);
          mountedByHost.delete(host);
        }
      }

      for (const host of hosts) {
        if (mountedByHost.has(host)) continue;
        const element = options.createElement(context, document);
        host.appendChild(element);
        mountedByHost.set(host, { contextKey, element });
      }
    } catch {
      removeOwnedElements();
      warn();
    }
  };

  const bindDocumentObserver = (document: Document | null) => {
    if (document === observedDocument) return;
    observer?.disconnect();
    observer = null;
    observedDocument = document;
    if (!document || typeof MutationObserver !== "function") return;

    observer = new MutationObserver(synchronize);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };

  const lifecycle: LibraryAppMountLifecycle = {
    stop() {
      if (isStopped) return;
      isStopped = true;
      if (intervalId !== null) clearInterval(intervalId);
      observer?.disconnect();
      observer = null;
      observedDocument = null;
      removeOwnedElements();
      if (registry.get(options.consumerId) === lifecycle) {
        registry.delete(options.consumerId);
      }
    },
  };

  registry.set(options.consumerId, lifecycle);
  synchronize();
  if (!isStopped) {
    intervalId = setInterval(synchronize, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
  return lifecycle;
}

function readSteamDisplayName(appId: number): string | undefined {
  try {
    const appStore = readGlobal<SteamAppStore>("appStore");
    const displayName = appStore?.GetAppOverviewByAppID?.(appId)?.display_name;
    return typeof displayName === "string" && displayName.length > 0 ? displayName : undefined;
  } catch {
    return undefined;
  }
}

function readSteamDesktopDocument(): Document | null {
  const popupManager = readGlobal<SteamPopupManager>("g_PopupManager");
  return popupManager?.GetExistingPopup?.(DESKTOP_POPUP_NAME)?.window?.document ?? null;
}

function findCompatibleActionHosts(document: Document): Element[] {
  const hosts = new Set<Element>();
  for (const settingsIcon of document.querySelectorAll(SETTINGS_CONTROL_SELECTOR)) {
    const host = findActionHostForSettingsControl(settingsIcon);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

function findActionHostForSettingsControl(settingsIcon: Element): Element | null {
  // Steam exposes no public Library action hook. The observed stable structure is
  // Settings button -> wrapper -> action host -> wrapper -> play bar; requiring a
  // nearby Play/Download icon rejects unrelated Settings controls without hashes.
  const manageButton = settingsIcon.closest('[role="button"]');
  const actionHost = manageButton?.parentElement?.parentElement;
  const playBar = actionHost?.parentElement?.parentElement;
  return actionHost && playBar?.querySelector(PLAY_CONTROL_SELECTOR) ? actionHost : null;
}

function getLifecycleRegistry(): Map<string, LibraryAppMountLifecycle> {
  const globalRegistry = globalThis as typeof globalThis & {
    [LIFECYCLE_REGISTRY_KEY]?: Map<string, LibraryAppMountLifecycle>;
  };
  globalRegistry[LIFECYCLE_REGISTRY_KEY] ??= new Map();
  return globalRegistry[LIFECYCLE_REGISTRY_KEY];
}

function readGlobal<T>(name: string): T | undefined {
  return Reflect.get(globalThis, name) as T | undefined;
}

function safelyRemove(element: HTMLElement): void {
  try {
    element.remove();
  } catch {
    // Cleanup is best-effort after a volatile DOM boundary changes.
  }
}
