import { readFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import {
  ApiKeyCredential,
  Client,
  Registry,
  Worker,
  openBlobCache,
  type BlobCache,
  type Credential,
  type Flow,
} from "@superdurable/dex";

import type { RuntimeSettings } from "./runtime.ts";

/** The Dex Client of the web process, or the Worker and its Client of the worker process, with their blob cache. */
export interface DexProcess {
  readonly client: Client | undefined;
  readonly worker: Worker | undefined;
  close(): Promise<void>;
}

const BLOB_CACHE_BYTES = 256 * 1024 * 1024;

/**
 * Opens what the mode needs of Dex at DEX_FLOW_SERVICE_ADDRESS: the web
 * process a Client for its API, the worker process a pull Worker with the
 * runtime's slots and drain. On Dex Cloud it authenticates with an API key; a local Dex needs none.
 */
export function openDex(flows: readonly Flow<any>[], settings: RuntimeSettings): DexProcess {
  const registry = new Registry([...flows]);
  const cache = openBlobCache({
    directory: join(process.env.DEX_BLOB_CACHE_DIR || join(tmpdir(), "application-blobs"), settings.mode),
    maxBytes: BLOB_CACHE_BYTES,
  });
  const serverAddress = process.env.DEX_FLOW_SERVICE_ADDRESS || "127.0.0.1:8801";
  const credential = cloudCredential();
  if (settings.mode === "web") {
    const client = new Client(registry, cache, { serverAddress, credential });
    return { client, worker: undefined, close: async () => closeAll(cache, client) };
  }
  const client = new Client(registry, cache, { serverAddress, credential });
  const worker = new Worker(registry, cache, {
    serverAddress,
    credential,
    pull: {
      maxConcurrentTasks: settings.maxConcurrentTasks,
      stopDrainTimeoutMs: settings.stopDrainTimeoutMs,
      stopOnPermanentStreamRejection: true,
    },
  });
  return {
    client,
    worker,
    close: async () => {
      try {
        await worker.close();
      } finally {
        await closeAll(cache, client);
      }
    },
  };
}

async function closeAll(cache: BlobCache, closable: { close(): Promise<void> }): Promise<void> {
  try {
    await closable.close();
  } finally {
    cache.close();
  }
}

/**
 * Authenticates to a Dex Cloud server with an API key. The token exchange
 * trusts DEX_TOKEN_CA_FILE besides the bundled roots when it is set.
 */
function cloudCredential(): Credential | undefined {
  const apiKey = process.env.DEX_API_KEY;
  if (!apiKey) {
    return undefined;
  }
  const caFile = process.env.DEX_TOKEN_CA_FILE;
  return new ApiKeyCredential({
    tokenUrl: process.env.DEX_TOKEN_URL ?? "",
    serverId: process.env.DEX_SERVER_ID ?? "",
    apiKey,
    fetch: caFile ? fetchTrusting([...rootCertificates, readFileSync(caFile, "utf8")]) : undefined,
  });
}

/** A fetch over node:https that trusts exactly the certificates ca, for the token exchange. */
function fetchTrusting(ca: string[]): typeof globalThis.fetch {
  return async (input, init) => {
    const outgoing = new Request(input, init);
    const body = outgoing.body === null ? undefined : Buffer.from(await outgoing.arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      const sent = request(
        outgoing.url,
        { method: outgoing.method, headers: Object.fromEntries(outgoing.headers), ca, signal: outgoing.signal },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
              for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
                headers.append(name, item);
              }
            }
            const status = incoming.statusCode ?? 502;
            const empty = [101, 204, 205, 304].includes(status);
            resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      sent.on("error", reject);
      sent.end(body);
    });
  };
}
