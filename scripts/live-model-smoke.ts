// One real model call through the agents' model client, with the settings of
// a local mode-0600 env file: RELEASE_WATCH_LOCAL_SETTINGS=<file> node scripts/live-model-smoke.ts
// It prints the reply and token usage, never a setting's value.
import { configuredModelClient, localSettingsFile, REASONING_EFFORT } from "../src/release-model.ts";

const path = process.env.RELEASE_WATCH_LOCAL_SETTINGS;
if (!path) {
  throw new Error("set RELEASE_WATCH_LOCAL_SETTINGS to the local settings file");
}
const client = configuredModelClient(localSettingsFile(path));
const started = Date.now();
const response = await client.callModel(
  {
    instructions: "You are a terse assistant.",
    inputItems: [{ type: "user_text", text: "Reply with exactly: release watch ready" }],
    tools: [],
    toolChoice: "auto",
    settings: { reasoningEffort: REASONING_EFFORT },
    metadata: { flowId: "live-smoke", turnId: "t1", stepExecutionId: "s1", attempt: 1 },
    cancellationSignal: AbortSignal.timeout(120_000),
  },
  { writeTextDelta() {}, writeReasoningDelta() {} },
);
console.log(JSON.stringify({ text: response.text.slice(0, 200), usage: response.usage, ms: Date.now() - started }));
