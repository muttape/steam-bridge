export type CdpTarget = {
  id: string;
  title: string;
  type?: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export type CdpVersion = {
  Browser?: string;
  Protocol_Version?: string;
  "User-Agent"?: string;
  "V8-Version"?: string;
  webSocketDebuggerUrl?: string;
};

type CdpResponse = {
  id?: number;
  result?: {
    result?: {
      type?: string;
      value?: unknown;
      unserializableValue?: string;
      description?: string;
    };
    exceptionDetails?: unknown;
  };
  error?: { message?: string };
};

export type EvaluationResult =
  | { kind: "value"; value: unknown; description?: string }
  | { kind: "unserializable"; value: string; description?: string };

export class CdpCommandError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CdpCommandError";
  }
}

export async function probeCdp(
  options: { host?: string; port?: number; timeoutMs?: number } = {},
): Promise<{ version: CdpVersion; targets: CdpTarget[] }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8080;
  const timeoutMs = options.timeoutMs ?? 2000;

  const [version, targets] = await Promise.all([
    getJson<CdpVersion>(`http://${host}:${port}/json/version`, timeoutMs),
    getJson<CdpTarget[]>(`http://${host}:${port}/json/list`, timeoutMs),
  ]);

  return { version, targets };
}

export async function evaluateJavascript(
  webSocketDebuggerUrl: string,
  expression: string,
  options: { awaitPromise?: boolean; timeoutMs?: number } = {},
): Promise<EvaluationResult> {
  const awaitPromise = options.awaitPromise ?? true;
  const timeoutMs = options.timeoutMs ?? 5000;
  const response = await sendCdpCommand(
    webSocketDebuggerUrl,
    {
      method: "Runtime.evaluate",
      params: {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      },
    },
    timeoutMs,
  );

  if (response.result?.exceptionDetails) {
    throw new CdpCommandError("JavaScript evaluation failed", response.result.exceptionDetails);
  }

  const result = response.result?.result;
  if (!result) {
    throw new CdpCommandError("CDP response did not include a Runtime result", response);
  }

  if (result.unserializableValue !== undefined) {
    return {
      kind: "unserializable",
      value: result.unserializableValue,
      description: result.description,
    };
  }

  return {
    kind: "value",
    value: result.value,
    description: result.description,
  };
}

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function sendCdpCommand(
  webSocketDebuggerUrl: string,
  command: { method: string; params?: Record<string, unknown> },
  timeoutMs: number,
): Promise<CdpResponse> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map<number, (response: CdpResponse) => void>();
    const id = 1;
    let isSettled = false;
    const settle = (action: () => void) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timeout);
      pending.clear();
      action();
      closeSocket(socket);
    };
    const timeout = setTimeout(() => {
      settle(() => reject(new CdpCommandError(`CDP command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    pending.set(id, (response) => {
      const error = response.error;
      if (error) {
        settle(() => reject(new CdpCommandError(error.message ?? "CDP command failed", error)));
      } else {
        settle(() => resolve(response));
      }
    });

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id, ...command }));
    });

    socket.addEventListener("message", (event) => {
      const response = parseSocketMessage(event.data);
      if (response?.id === undefined) return;
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    });

    socket.addEventListener("error", (event) => {
      settle(() => reject(new CdpCommandError("CDP socket error", event)));
    });

    socket.addEventListener("close", () => {
      if (isSettled || pending.size === 0) return;
      settle(() => reject(new CdpCommandError("CDP socket closed before response")));
    });
  });
}

function parseSocketMessage(data: unknown): CdpResponse | null {
  try {
    return JSON.parse(typeof data === "string" ? data : String(data)) as CdpResponse;
  } catch {
    return null;
  }
}

function closeSocket(socket: WebSocket): void {
  try {
    socket.close();
  } catch {
    // Best-effort cleanup only.
  }
}
