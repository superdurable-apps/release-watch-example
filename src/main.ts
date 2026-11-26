import { createServer, type Server } from "node:http";

import { loadApplication } from "./application.ts";
import { openDex } from "./dex.ts";
import { createHttpServer } from "./http.ts";
import { loadRuntime, type Application, type RuntimeSettings } from "./runtime.ts";

// The entry of package.json's main: `node . web` serves the API and the page
// on PORT, `node . worker` runs the Dex Worker with its readiness on the
// runtime's address. Node.js runs as PID 1 in a container, which ignores SIGTERM
// without a handler, so each mode stops itself on SIGTERM and SIGINT: the web
// process finishes its requests, the Worker drains its running tasks. Each
// mode first loads what src/application.ts gives it, such as the Worker's
// settings from the Project configuration.
const SERVER_STOP_GRACE_MS = 10_000;

const settings = loadRuntime(process.argv);
const application = await loadApplication({ mode: settings.mode });
if (settings.mode === "web") {
  await runWeb(application, settings);
} else {
  await runWorker(application, settings);
}

async function runWeb(application: Application, settings: RuntimeSettings): Promise<void> {
  const stop = stopSignal();
  const dex = openDex(application.flows, settings);
  application.bindClient?.(dex.client!);
  const services = await application.startWebServices?.(dex.client!);
  const server = createHttpServer(application.routes(dex.client!), application.page, services?.rawRoutes ?? []);
  await listen(server, Number(process.env.PORT || "8080"), "");
  await stop;
  await close(server);
  await services?.stop();
  await dex.close();
  process.exit(0);
}

async function runWorker(application: Application, settings: RuntimeSettings): Promise<void> {
  const stop = stopSignal();
  const dex = openDex(application.flows, settings);
  application.bindClient?.(dex.client!);
  const worker = dex.worker!;
  let ready = false;
  let stopping = false;
  // Readiness drops as soon as the stop begins; the drain follows.
  const readiness = createServer((incoming, outgoing) => {
    const isReady = ready && !stopping && worker.pullRegistrationState().isReady;
    outgoing.writeHead(incoming.url === "/readyz" && isReady ? 200 : 503);
    outgoing.end();
  });
  await listen(readiness, settings.readinessPort, settings.readinessHost);
  worker.run().then(
    () => stopping || fail("the Dex Worker stopped", undefined),
    (error: unknown) => stopping || fail("run the Dex Worker", error),
  );
  worker.waitPullRegistered({ timeoutMs: 60_000 }).then(
    () => {
      ready = true;
    },
    (error: unknown) => stopping || fail("register the pull Worker", error),
  );
  await stop;
  stopping = true;
  await dex.close();
  await close(readiness);
  process.exit(0);
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host || undefined, () => resolve());
  });
}

/** Stops accepting connections and waits for the open requests, at most SERVER_STOP_GRACE_MS. */
function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    const grace = setTimeout(() => server.closeAllConnections(), SERVER_STOP_GRACE_MS);
    server.close(() => {
      clearTimeout(grace);
      resolve();
    });
    server.closeIdleConnections();
  });
}

function stopSignal(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGTERM", () => resolve());
    process.once("SIGINT", () => resolve());
  });
}

function fail(what: string, error: unknown): never {
  console.error(JSON.stringify({ msg: "application stopped", error: `${what}: ${String(error)}` }));
  process.exit(1);
}
