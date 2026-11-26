// One side of a JSON-RPC 2.0 connection over a line stream: frames end at LF only.

import type { Readable } from "node:stream";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const ErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  unsupported: -32001,
  runFailed: -32002,
  cancelled: -32003,
  overloaded: -32004,
  unknownRun: -32005,
  interrupted: -32006,
} as const;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** A JSON-RPC error: one the other side answered with, or one to answer with. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: Json | undefined;

  constructor(code: number, message: string, data?: Json) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

type RequestHandler = (params: JsonObject) => Promise<JsonObject>;
type Output = { write(frame: string): unknown };
type NotificationHandler = (params: JsonObject) => void;

/**
 * Reads frames from `input` and writes them to `output`.
 *
 * Node's `readline` also ends lines at CR, U+2028 and U+2029, which JSON strings may hold
 * unescaped, so this splits on LF itself.
 */
export class Peer {
  #output: Output;
  #ended = false;
  #next = 1;
  #pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void }>();
  #requests = new Map<string, RequestHandler>();
  #notifications = new Map<string, NotificationHandler>();
  #closed: ((error: Error) => void)[] = [];
  #observers: ((message: JsonObject) => void)[] = [];

  constructor(input: Readable, output: Output) {
    this.#output = output;
    let buffered = "";
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => {
      if (this.#ended) return;
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (line.trim()) this.#receive(line);
        if (this.#ended) return;
      }
      // Spec section 2: a frame over the limit ends the connection.
      if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) this.#fail(new Error("Kedi sent a frame over 8 MiB"));
    });
    input.on("end", () => this.#fail(new Error("Kedi closed the connection")));
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.#requests.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.#notifications.set(method, handler);
  }

  /** Sees every frame Kedi sends, before it is handled. */
  onMessage(listener: (message: JsonObject) => void): void {
    this.#observers.push(listener);
  }

  onClose(listener: (error: Error) => void): void {
    this.#closed.push(listener);
  }

  get ended(): boolean {
    return this.#ended;
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.#ended) return Promise.reject(new Error("the connection to Kedi has ended"));
    const id = this.#next++;
    this.#send({ id, method, params });
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: JsonObject): void {
    this.#send({ method, params });
  }

  #send(message: JsonObject): void {
    if (this.#ended) return;
    this.#output.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  #receive(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line);
    } catch {
      // Spec section 2: a line that is not a JSON-RPC object ends the connection.
      this.#send({ id: null, error: { code: ErrorCode.parseError, message: "not JSON" } });
      this.#fail(new Error("Kedi sent a line that is not JSON"));
      return;
    }
    for (const observe of this.#observers) observe(message);
    const method = message.method;
    if (typeof method === "string") {
      const params = (message.params ?? {}) as JsonObject;
      if (message.id === undefined) {
        this.#notifications.get(method)?.(params);
        return;
      }
      void this.#answer(message.id as number | string, method, params);
      return;
    }
    const waiter = this.#pending.get(message.id as number);
    if (!waiter) return;
    this.#pending.delete(message.id as number);
    const error = message.error as JsonObject | undefined;
    if (error) waiter.reject(new RpcError(error.code as number, String(error.message ?? ""), error.data));
    else waiter.resolve((message.result ?? {}) as JsonObject);
  }

  async #answer(id: number | string, method: string, params: JsonObject): Promise<void> {
    const handler = this.#requests.get(method);
    if (!handler) {
      this.#send({ id, error: { code: ErrorCode.methodNotFound, message: `unknown method ${method}` } });
      return;
    }
    try {
      this.#send({ id, result: await handler(params) });
    } catch (error) {
      this.#send({ id, error: errorFrame(error) });
    }
  }

  #fail(error: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
    for (const listener of this.#closed) listener(error);
  }
}

/** An error as a JSON-RPC error object; a harness's own error goes in `data.harness`. */
export function errorFrame(error: unknown): JsonObject {
  if (error instanceof RpcError) {
    const frame: JsonObject = { code: error.code, message: error.message };
    if (error.data !== undefined) frame.data = error.data;
    return frame;
  }
  return { code: ErrorCode.runFailed, message: String((error as Error)?.message ?? error), data: { harness: harnessError(error) } };
}

/** A harness error as `{type, message, cause?}`, its cause chain included. */
export function harnessError(error: unknown, depth = 0): JsonObject {
  const value = error as { name?: string; message?: string; cause?: unknown } | undefined;
  const frame: JsonObject = {
    type: value?.name ?? typeof error,
    message: value?.message ?? String(error),
  };
  if (value?.cause !== undefined && depth < 4) frame.cause = harnessError(value.cause, depth + 1);
  return frame;
}
