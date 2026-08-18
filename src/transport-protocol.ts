export const TRANSPORT_VERSION = 1;

export type TransportErrorCode =
  "invalid_message" | "route_not_found" | "handler_error" | "internal_error";

export type CallMessage = { v: 1; type: "call"; id: number; route: string; args: unknown[] };
export type ReplyMessage = { v: 1; type: "reply"; id: number; result: unknown };
export type ErrorMessage = {
  v: 1;
  type: "error";
  id?: number;
  error: { code: TransportErrorCode; message: string };
};
export type EventMessage = { v: 1; type: "event"; event: string; args: unknown[] };
export type TransportMessage = CallMessage | ReplyMessage | ErrorMessage | EventMessage;

export function parseTransportMessage(data: string): TransportMessage | ErrorMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return makeTransportError(undefined, "invalid_message", "Message is not valid JSON");
  }

  if (!isRecord(raw)) {
    return makeTransportError(undefined, "invalid_message", "Message must be an object");
  }

  const id = typeof raw.id === "number" && Number.isFinite(raw.id) ? raw.id : undefined;
  if (raw.v !== TRANSPORT_VERSION) {
    return makeTransportError(id, "invalid_message", "Unsupported protocol version");
  }

  if (raw.type === "call") {
    if (
      typeof raw.id !== "number" ||
      !Number.isFinite(raw.id) ||
      typeof raw.route !== "string" ||
      !Array.isArray(raw.args)
    ) {
      return makeTransportError(id, "invalid_message", "Invalid call message");
    }
    return { v: 1, type: "call", id: raw.id, route: raw.route, args: raw.args };
  }

  if (raw.type === "reply") {
    if (typeof raw.id !== "number" || !Number.isFinite(raw.id)) {
      return makeTransportError(id, "invalid_message", "Invalid reply message");
    }
    return { v: 1, type: "reply", id: raw.id, result: raw.result };
  }

  if (raw.type === "error") {
    if (
      !isRecord(raw.error) ||
      !isTransportErrorCode(raw.error.code) ||
      typeof raw.error.message !== "string"
    ) {
      return makeTransportError(id, "invalid_message", "Invalid error message");
    }
    return {
      v: 1,
      type: "error",
      ...(id === undefined ? {} : { id }),
      error: { code: raw.error.code, message: raw.error.message },
    };
  }

  if (raw.type === "event") {
    if (typeof raw.event !== "string" || !Array.isArray(raw.args)) {
      return makeTransportError(id, "invalid_message", "Invalid event message");
    }
    return { v: 1, type: "event", event: raw.event, args: raw.args };
  }

  return makeTransportError(id, "invalid_message", "Unknown message type");
}

export function makeTransportError(
  id: number | undefined,
  code: TransportErrorCode,
  message: string,
): ErrorMessage {
  return {
    v: 1,
    type: "error",
    ...(id === undefined ? {} : { id }),
    error: { code, message },
  };
}

export function stringifyTransportMessage(message: TransportMessage): string {
  return JSON.stringify(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTransportErrorCode(value: unknown): value is TransportErrorCode {
  return (
    value === "invalid_message" ||
    value === "route_not_found" ||
    value === "handler_error" ||
    value === "internal_error"
  );
}
