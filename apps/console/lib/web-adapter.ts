import {
  handleApiRequest,
  type ApiOptions,
  type ApiRequest,
  type ApiResponse,
} from "@shipbash/control-plane/api";

type ApiHandler = (
  request: ApiRequest,
  response: ApiResponse,
) => Promise<boolean>;

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

class WebApiRequest implements ApiRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(private readonly request: Request) {
    const url = new URL(request.url);
    this.url = `${url.pathname}${url.search}`;
    this.method = request.method;
    this.headers = Object.fromEntries(request.headers.entries());
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    if (!this.request.body) return;
    yield* this.request.body;
  }
}

class WebApiResponse implements ApiResponse {
  writableEnded = false;

  private readonly readable: ReadableStream<Uint8Array>;
  private readonly encoder = new TextEncoder();
  private readonly closeListeners = new Set<() => void>();
  private readonly responsePromise: Promise<Response | null>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private resolveResponse!: (response: Response | null) => void;
  private rejectResponse!: (reason: unknown) => void;
  private headersWritten = false;
  private closeEmitted = false;
  private responseStatus = 200;

  constructor(private readonly signal: AbortSignal) {
    this.responsePromise = new Promise<Response | null>((resolve, reject) => {
      this.resolveResponse = resolve;
      this.rejectResponse = reject;
    });
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.closeFromReader();
      },
    });
    if (signal.aborted) this.abortFromRequest();
    else signal.addEventListener("abort", this.abortFromRequest, { once: true });
  }

  result(): Promise<Response | null> {
    return this.responsePromise;
  }

  writeHead(
    statusCode: number,
    values: Record<string, string | number | string[] | undefined> = {},
  ): this {
    if (this.headersWritten) throw new Error("Response headers were already written.");
    this.headersWritten = true;
    this.responseStatus = statusCode;
    const headers = new Headers();
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) headers.append(name, entry);
      } else {
        headers.set(name, String(value));
      }
    }
    this.resolveResponse(new Response(NULL_BODY_STATUSES.has(statusCode) ? null : this.readable, {
      status: statusCode,
      headers,
    }));
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    if (this.writableEnded) return false;
    this.controller.enqueue(typeof chunk === "string" ? this.encoder.encode(chunk) : chunk);
    return true;
  }

  end(chunk?: string | Uint8Array): this {
    if (this.writableEnded) return this;
    if (!this.headersWritten) this.writeHead(200);
    if (chunk !== undefined && !NULL_BODY_STATUSES.has(this.responseStatus)) this.write(chunk);
    this.writableEnded = true;
    this.signal.removeEventListener("abort", this.abortFromRequest);
    this.controller.close();
    this.emitClose();
    return this;
  }

  once(event: "close", listener: () => void): this {
    if (event !== "close") return this;
    if (this.closeEmitted) queueMicrotask(listener);
    else this.closeListeners.add(listener);
    return this;
  }

  finish(handled: boolean): void {
    if (!handled) {
      if (this.headersWritten) {
        this.fail(new Error("The API wrote a response for an unhandled request."));
      } else {
        this.resolveResponse(null);
      }
      return;
    }
    if (!this.headersWritten) this.writeHead(204);
    if (!this.writableEnded) this.end();
  }

  fail(error: unknown): void {
    if (!this.headersWritten) {
      this.rejectResponse(error);
      return;
    }
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.signal.removeEventListener("abort", this.abortFromRequest);
    this.controller.error(error);
    this.emitClose();
  }

  private readonly abortFromRequest = (): void => {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.signal.removeEventListener("abort", this.abortFromRequest);
    if (this.headersWritten) this.controller.error(this.signal.reason);
    else this.rejectResponse(this.signal.reason);
    this.emitClose();
  };

  private closeFromReader(): void {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.signal.removeEventListener("abort", this.abortFromRequest);
    this.emitClose();
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }
}

export async function invokeWebHandler(
  request: Request,
  handler: ApiHandler,
): Promise<Response | null> {
  const response = new WebApiResponse(request.signal);
  void handler(new WebApiRequest(request), response).then(
    (handled) => response.finish(handled),
    (error: unknown) => response.fail(error),
  );
  return response.result();
}

export function handleWebRequest(
  request: Request,
  options: ApiOptions,
): Promise<Response | null> {
  return invokeWebHandler(
    request,
    (adaptedRequest, adaptedResponse) =>
      handleApiRequest(adaptedRequest, adaptedResponse, options),
  );
}

/** The request headers a proxied call carries on: content negotiation, the body's type, a stream's resume point, and a byte range. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "last-event-id",
  "range",
] as const;

export function forwardedRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** A proxied call's body: none for a GET or a HEAD, its bytes otherwise. */
export async function requestBody(request: Request): Promise<ArrayBuffer | null> {
  const method = request.method.toUpperCase();
  return method === "GET" || method === "HEAD" ? null : await request.arrayBuffer();
}

/** The API's answer for a route nothing serves. */
export function routeNotFound(): Response {
  return Response.json(
    { ok: false, error: "NOT_FOUND", message: "Route not found." },
    { status: 404 },
  );
}
