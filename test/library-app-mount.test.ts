import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  readSteamLibraryAppContext,
  startLibraryAppMountLifecycle,
  type LibraryAppContext,
} from "steam-bridge/library-app-mount";

type FakeElement = {
  active: boolean;
  parentElement: FakeElement | null;
  children: FakeElement[];
  isConnected: boolean;
  checkVisibility: () => boolean;
  closest: (selector: string) => FakeElement | null;
  contains: (element: FakeElement) => boolean;
  getBoundingClientRect: () => Pick<DOMRect, "height" | "left" | "top" | "width">;
  matches: (selector: string) => boolean;
  querySelector: (selector: string) => FakeElement | null;
  appendChild: (element: FakeElement) => FakeElement;
  remove: () => void;
};

type FakeDocument = {
  documentElement: FakeElement;
  mountedElements: FakeElement[];
  settingsIcons: FakeElement[];
  elementsFromPoint: () => FakeElement[];
  querySelectorAll: (selector: string) => FakeElement[];
  replaceCompatibleHosts: (count: number) => void;
};

const originalGlobals = new Map<PropertyKey, PropertyDescriptor | undefined>();

afterEach(() => {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

test("reads supported Library routes with optional display-name metadata", () => {
  setGlobal("MainWindowBrowserManager", {
    m_lastLocation: { pathname: "/routes/library/app/570/details" },
  });
  setGlobal("appStore", {
    GetAppOverviewByAppID: (appId: number) => ({
      appid: appId,
      display_name: "Dota 2",
    }),
  });

  assert.deepEqual(readSteamLibraryAppContext(), {
    appId: 570,
    displayName: "Dota 2",
  });

  setGlobal("appStore", {
    GetAppOverviewByAppID: () => {
      throw new Error("Steam store unavailable");
    },
  });
  assert.deepEqual(readSteamLibraryAppContext(), { appId: 570 });

  setGlobal("MainWindowBrowserManager", {
    m_lastLocation: { pathname: "/library/home" },
  });
  assert.equal(readSteamLibraryAppContext(), null);
});

test("context reads contain Steam route boundary exceptions", () => {
  setGlobal("MainWindowBrowserManager", {
    get m_lastLocation() {
      throw new Error("Steam route unavailable");
    },
  });

  assert.doesNotThrow(() => readSteamLibraryAppContext());
  assert.equal(readSteamLibraryAppContext(), null);
});

test("mounts one custom element in every compatible host and ignores lookalikes", () => {
  const environment = installFakeSteamEnvironment({
    compatibleHostCount: 2,
    unrelatedSettingsCount: 40,
  });
  const contexts: LibraryAppContext[] = [];

  const lifecycle = startLibraryAppMountLifecycle({
    consumerId: "test-consumer",
    createElement: (context) => {
      contexts.push(context);
      return createFakeElement() as unknown as HTMLElement;
    },
  });

  assert.equal(environment.document.mountedElements.length, 2);
  assert.deepEqual(contexts, [
    { appId: 570, displayName: "Dota 2" },
    { appId: 570, displayName: "Dota 2" },
  ]);

  lifecycle.stop();
});

test("mounts only active compatible hosts and follows Steam branch transitions", () => {
  const environment = installFakeSteamEnvironment({ compatibleHostCount: 2 });
  environment.document.settingsIcons[1].active = false;

  const lifecycle = startLibraryAppMountLifecycle({
    consumerId: "test-consumer",
    createElement: () => createFakeElement() as unknown as HTMLElement,
  });

  assert.equal(environment.document.mountedElements.length, 1);
  const firstElement = environment.document.mountedElements[0];

  environment.document.settingsIcons[0].active = false;
  environment.document.settingsIcons[1].active = true;
  environment.tick();

  assert.equal(firstElement.isConnected, false);
  assert.equal(environment.document.mountedElements.length, 1);
  assert.notEqual(environment.document.mountedElements[0], firstElement);

  lifecycle.stop();
});

test("recreates mounts for route and metadata changes without stale elements", () => {
  const environment = installFakeSteamEnvironment();
  const contexts: LibraryAppContext[] = [];
  const lifecycle = startLibraryAppMountLifecycle({
    consumerId: "test-consumer",
    createElement: (context) => {
      contexts.push(context);
      return createFakeElement() as unknown as HTMLElement;
    },
  });
  const firstElement = environment.document.mountedElements[0];

  environment.displayName = undefined;
  environment.tick();
  const missingNameElement = environment.document.mountedElements[0];
  assert.notEqual(missingNameElement, firstElement);
  assert.equal(firstElement.isConnected, false);

  environment.displayName = "Dota 2 Reloaded";
  environment.tick();
  const changedNameElement = environment.document.mountedElements[0];
  assert.notEqual(changedNameElement, missingNameElement);

  environment.pathname = "/library/app/730";
  environment.displayName = "Counter-Strike 2";
  environment.tick();
  assert.deepEqual(contexts.at(-1), {
    appId: 730,
    displayName: "Counter-Strike 2",
  });

  environment.pathname = "/library/home";
  environment.tick();
  assert.equal(environment.document.mountedElements.length, 0);

  lifecycle.stop();
});

test("remounts after Steam replaces compatible hosts", () => {
  const environment = installFakeSteamEnvironment();
  const lifecycle = startLibraryAppMountLifecycle({
    consumerId: "test-consumer",
    createElement: () => createFakeElement() as unknown as HTMLElement,
  });
  const firstElement = environment.document.mountedElements[0];

  environment.document.replaceCompatibleHosts(1);
  environment.mutate();

  assert.equal(firstElement.isConnected, false);
  assert.equal(environment.document.mountedElements.length, 1);
  assert.notEqual(environment.document.mountedElements[0], firstElement);

  lifecycle.stop();
});

test("reinjection replaces the previous lifecycle for the same consumer", () => {
  const environment = installFakeSteamEnvironment();
  const firstLifecycle = startLibraryAppMountLifecycle({
    consumerId: "test-consumer",
    createElement: () => createFakeElement() as unknown as HTMLElement,
  });
  const firstElement = environment.document.mountedElements[0];

  const secondLifecycle = startLibraryAppMountLifecycle({
    consumerId: "test-consumer",
    createElement: () => createFakeElement() as unknown as HTMLElement,
  });

  assert.equal(firstElement.isConnected, false);
  assert.equal(environment.document.mountedElements.length, 1);
  assert.equal(environment.clearedIntervals.includes(1), true);

  firstLifecycle.stop();
  assert.equal(environment.document.mountedElements.length, 1);
  secondLifecycle.stop();
});

test("stop disconnects observers and removes every lifecycle mount", () => {
  const environment = installFakeSteamEnvironment({ compatibleHostCount: 2 });
  const lifecycle = startLibraryAppMountLifecycle({
    consumerId: "test-consumer",
    createElement: () => createFakeElement() as unknown as HTMLElement,
  });

  lifecycle.stop();

  assert.equal(environment.document.mountedElements.length, 0);
  assert.deepEqual(environment.clearedIntervals, [1]);
  assert.equal(environment.observerDisconnectCount, 1);
});

test("Steam-boundary failures degrade safely with sanitized rate-limited warnings", () => {
  const environment = installFakeSteamEnvironment();
  const warnings: string[] = [];
  environment.throwFromPopupManager = true;

  const lifecycle = startLibraryAppMountLifecycle({
    consumerId: "test-consumer",
    createElement: () => createFakeElement() as unknown as HTMLElement,
    onWarning: (warning) => warnings.push(warning.message),
  });

  environment.tick();
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], "Steam Library integration boundary failed");

  environment.now = 60_000;
  environment.tick();
  assert.equal(warnings.length, 2);

  lifecycle.stop();
});

function installFakeSteamEnvironment({
  compatibleHostCount = 1,
  unrelatedSettingsCount = 0,
}: { compatibleHostCount?: number; unrelatedSettingsCount?: number } = {}) {
  const document = createFakeDocument(compatibleHostCount, unrelatedSettingsCount);
  const environment = {
    clearedIntervals: [] as number[],
    displayName: "Dota 2" as string | undefined,
    document,
    now: 0,
    observerDisconnectCount: 0,
    pathname: "/library/app/570",
    throwFromPopupManager: false,
    tick: () => {},
    mutate: () => {},
  };
  let nextIntervalId = 0;

  setGlobal("MainWindowBrowserManager", {
    m_lastLocation: {
      get pathname() {
        return environment.pathname;
      },
    },
  });
  setGlobal("appStore", {
    GetAppOverviewByAppID: (appId: number) => ({
      appid: appId,
      display_name: environment.displayName,
    }),
  });
  setGlobal("g_PopupManager", {
    GetExistingPopup: () => {
      if (environment.throwFromPopupManager) {
        throw new Error("token=private https://example.test/private");
      }
      return { window: { document } };
    },
  });
  setGlobal("setInterval", (callback: () => void) => {
    environment.tick = callback;
    nextIntervalId += 1;
    return nextIntervalId;
  });
  setGlobal("clearInterval", (intervalId: number) => {
    environment.clearedIntervals.push(intervalId);
  });
  setGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        environment.mutate = callback;
      }

      observe() {}

      disconnect() {
        environment.observerDisconnectCount += 1;
      }
    },
  );
  setGlobal(
    "Date",
    class extends Date {
      static override now() {
        return environment.now;
      }
    },
  );

  return environment;
}

function createFakeDocument(
  compatibleHostCount: number,
  unrelatedSettingsCount: number,
): FakeDocument {
  const document = {
    documentElement: createFakeElement(),
    mountedElements: [] as FakeElement[],
    settingsIcons: [] as FakeElement[],
    elementsFromPoint() {
      return this.settingsIcons.filter((element) => element.active);
    },
    querySelectorAll(selector: string) {
      if (selector === "svg.SVGIcon_Settings") return this.settingsIcons;
      return [];
    },
    replaceCompatibleHosts(count: number) {
      for (const element of this.mountedElements) {
        element.isConnected = false;
        element.parentElement = null;
      }
      this.mountedElements = [];
      this.settingsIcons = Array.from({ length: count }, () => createSettingsIcon(this, true));
    },
  };

  document.settingsIcons = [
    ...Array.from({ length: compatibleHostCount }, () => createSettingsIcon(document, true)),
    ...Array.from({ length: unrelatedSettingsCount }, () => createSettingsIcon(document, false)),
  ];
  return document;
}

function createSettingsIcon(
  document: FakeDocument & { settingsIcons: FakeElement[] },
  isCompatible: boolean,
): FakeElement {
  const template = createFakeElement();
  const playBar = createFakeElement();
  playBar.querySelector = (selector) =>
    isCompatible && selector === "svg.SVGIcon_Play, svg.SVGIcon_Download"
      ? createFakeElement()
      : null;
  const container = createFakeElement();
  container.children = [template];
  container.parentElement = { ...createFakeElement(), parentElement: playBar };
  container.appendChild = (element) => {
    element.parentElement = container;
    element.isConnected = true;
    element.remove = () => {
      element.isConnected = false;
      element.parentElement = null;
      document.mountedElements = document.mountedElements.filter(
        (candidate) => candidate !== element,
      );
    };
    document.mountedElements.push(element);
    return element;
  };
  const wrapper = { ...createFakeElement(), parentElement: container };
  const manageButton = { ...createFakeElement(), parentElement: wrapper };
  return {
    ...createFakeElement(),
    closest: (selector) => (selector === '[role="button"]' ? manageButton : null),
  };
}

function createFakeElement(): FakeElement {
  return {
    active: true,
    parentElement: null,
    children: [],
    isConnected: false,
    checkVisibility() {
      return this.active;
    },
    closest: () => null,
    contains(element) {
      return element === this || this.children.some((child) => child.contains(element));
    },
    getBoundingClientRect: () => ({ height: 10, left: 0, top: 0, width: 10 }),
    matches: () => true,
    querySelector: () => null,
    appendChild(element) {
      this.children.push(element);
      element.parentElement = this;
      return element;
    },
    remove() {
      this.isConnected = false;
      this.parentElement = null;
    },
  };
}

function setGlobal(key: PropertyKey, value: unknown): void {
  if (!originalGlobals.has(key)) {
    originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value,
    writable: true,
  });
}
