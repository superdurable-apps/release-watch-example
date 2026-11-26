import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** One request of the API: the path parameters its route names and the decoded JSON body. */
export interface ApiRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** One answer of the API: its status and the JSON body, if any. */
export interface ApiResponse {
  readonly status: number;
  readonly body?: unknown;
}

/** One operation of openapi/openapi.yaml: its method, its path with {parameters}, and its handler. */
export interface Route {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  handle(request: ApiRequest): Promise<ApiResponse>;
}

/** One raw HTTP handler at an exact path, such as a connector's Trigger relay, which reads its own body. */
export interface RawRoute {
  readonly path: string;
  handle(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void>;
}

/** A refusal the handler decided, answered with its status and message. */
export class HttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAXIMUM_BODY_BYTES = 64 * 1024;

/**
 * Serves GET /api/health, the routes and, for every other GET, the page. A
 * response with a 5xx status is logged with its method and route, never a
 * body.
 */
export function createHttpServer(routes: readonly Route[], page: string, rawRoutes: readonly RawRoute[] = []): Server {
  return createServer((incoming, outgoing) => {
    const path = new URL(incoming.url ?? "/", "http://application").pathname;
    const raw = rawRoutes.find((route) => route.path === path);
    (raw !== undefined ? raw.handle(incoming, outgoing) : serve(routes, page, incoming, outgoing)).catch((error: unknown) => {
      console.error(JSON.stringify({ msg: "HTTP request failed", method: incoming.method, error: String(error) }));
      if (!outgoing.headersSent) {
        send(outgoing, 500, { error: "internal error" });
      } else {
        outgoing.destroy();
      }
    });
  });
}

async function serve(routes: readonly Route[], page: string, incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
  const path = new URL(incoming.url ?? "/", "http://application").pathname;
  if (path === "/api/health") {
    send(outgoing, 200, { status: "ok" });
    return;
  }
  if (!path.startsWith("/api/")) {
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      send(outgoing, 405, { error: "method not allowed" });
      return;
    }
    outgoing.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    outgoing.end(incoming.method === "HEAD" ? undefined : page);
    return;
  }
  for (const route of routes) {
    const params = match(route.path, path);
    if (params === undefined || route.method !== incoming.method) {
      continue;
    }
    let answer: ApiResponse;
    try {
      answer = await route.handle({ params, body: await readBody(incoming) });
    } catch (error) {
      if (!(error instanceof HttpError)) {
        throw error;
      }
      answer = { status: error.status, body: { error: error.message } };
    }
    if (answer.status >= 500) {
      console.error(JSON.stringify({ msg: "HTTP request failed", method: incoming.method, route: route.path, status: answer.status }));
    }
    send(outgoing, answer.status, answer.body);
    return;
  }
  send(outgoing, 404, { error: "not found" });
}

/** The parameters of path when it matches template, such as /api/items/{id}; undefined otherwise. */
function match(template: string, path: string): Record<string, string> | undefined {
  const expected = template.split("/");
  const actual = path.split("/");
  if (expected.length !== actual.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index] ?? "";
    if (segment.startsWith("{") && segment.endsWith("}")) {
      const decoded = decodeSegment(value);
      if (decoded === undefined || decoded === "") {
        return undefined;
      }
      params[segment.slice(1, -1)] = decoded;
    } else if (segment !== value) {
      return undefined;
    }
  }
  return params;
}

function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** The JSON body, at most 64 KiB; undefined for an empty body. */
async function readBody(incoming: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > MAXIMUM_BODY_BYTES) {
      throw new HttpError(413, "the request body exceeds 64 KiB");
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "the request body is not JSON");
  }
}

function send(outgoing: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    outgoing.writeHead(status);
    outgoing.end();
    return;
  }
  outgoing.writeHead(status, { "content-type": "application/json" });
  outgoing.end(JSON.stringify(body));
}
