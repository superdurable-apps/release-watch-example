// Sends one message to a digest's triage session, as a thread reply would, for a local check of the agent.
// Usage: node scripts/send-triage-message.ts <triage session ID> "<@U123>: question"
import { loadApplication } from "../src/application.ts";
import { openDex } from "../src/dex.ts";

const [sessionId, text] = process.argv.slice(2);
if (!sessionId || !text) {
  throw new Error("usage: send-triage-message.ts <triage session ID> <text>");
}
const application = await loadApplication({ mode: "web" });
const dex = openDex(application.flows, { mode: "web" } as never);
try {
  const triage = application.flows.find((flow) => flow.getFlowType() === "ReleaseTriageAgentFlow") as never as { sendUserMessage: never };
  const queued = await dex.client.invokeRPC(triage.sendUserMessage, sessionId, { text, images: [], plan_mode: false } as never);
  console.log(JSON.stringify({ queued }));
} finally {
  await dex.close();
}
