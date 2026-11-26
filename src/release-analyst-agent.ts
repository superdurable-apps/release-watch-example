import type { AgentSessionFlow } from "@superdurable/dex-agents";
import { createBuiltinAgentSessionFlow, functionTool, type BuiltinLoopAgentRunner, type ModelClient } from "@superdurable/dex-agents/builtin-loop";

import type { DexClientHolder } from "./dex-client-holder.ts";
import { TEAM_PROFILE, PRIORITY_RUBRIC, TIER_RUBRIC } from "./team-profile.ts";
import type { ReleaseDigestFlow } from "./release-digest-flow.ts";
import { ACTIONABILITY, RELEASE_CATEGORIES, PRIORITIES } from "./release-types.ts";
import { REASONING_EFFORT } from "./release-model.ts";

/**
 * The session Flow type and Action permission of the analyst. They are also
 * flow-definitions/release-analyst-agent.json, which
 * `npx --no-install dex-agents-session-graph --flow-type ReleaseAnalystAgentFlow --permission release-watch.operate`
 * writes: change both together, and never rename a Flow type with open runs.
 */
export const ANALYST_FLOW_TYPE = "ReleaseAnalystAgentFlow";
export const RELEASE_WATCH_PERMISSION = "release-watch.operate";

const INSTRUCTIONS = `You are the release analyst of Release Watch. Each session is one digest: the first message lists every
candidate the digest's sources found since the last digest, one per line with its key in brackets.

${TEAM_PROFILE}

Your job:
1. Decide which candidates are releases or announcements of the watched libraries that the team may need to act
   on: new versions, breaking changes, security fixes, deprecations, and discussions that report a real problem
   with one of them.
2. Drop noise: releases that only change docs, examples, CI or internal tooling, dependency bumps with no effect
   on users, and discussions that only mention a library in passing. When in doubt about a small patch, drop it.
3. Merge candidates about the same release into one release that lists every candidate key and every source URL
   (a GitHub release and its Hacker News thread are one release; so are the Python and TypeScript releases of
   one SDK when they ship the same change).
${TIER_RUBRIC}
   - category: what kind of change it is, exactly one of ${RELEASE_CATEGORIES.join(", ")};
   - relevance 0-100 to the application, within its tier: 80-100 it changes code the application runs; 50-79 it
     affects a part of the library the application likely uses; 20-49 minor; below 20 do not report it;
   - summary: one or two plain sentences on what changed, with the version number;
   - impact: one or two plain sentences on what it means for the application, concrete (what to change, what to
     test, or why nothing);
   - suggestedPriority: ${PRIORITY_RUBRIC}. must-fix may be P0-P3, recommend P1-P3, no-change is always P3
     (no-change releases do not become issues unless a person asks);
   - library: the library from the candidate, lowercase.
5. Call submit_report exactly once with every release worth reporting, most urgent first. If it answers with an
   error, fix the report and call it again. Cite only keys from the brief. Report nothing you did not see in a
   candidate.
6. Then answer with one line: how many releases you reported and the most urgent one.
Write plainly, without hype. Never invent version numbers, dates, CVE IDs or changes.`;

/** The JSON Schema of the report, which the RPC validates again. */
const REPORT_SCHEMA = {
  type: "object",
  required: ["releases"],
  properties: {
    releases: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "library", "url", "candidateKeys", "actionability", "category", "relevance", "summary", "impact", "suggestedPriority", "sources"],
        properties: {
          title: { type: "string" },
          library: { type: "string" },
          url: { type: "string" },
          candidateKeys: { type: "array", items: { type: "string" } },
          actionability: { type: "string", enum: [...ACTIONABILITY] },
          category: { type: "string", enum: [...RELEASE_CATEGORIES] },
          relevance: { type: "number", minimum: 0, maximum: 100 },
          summary: { type: "string" },
          impact: { type: "string" },
          suggestedPriority: { type: "string", enum: [...PRIORITIES] },
          sources: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

/** The digest an analyst session belongs to: its session ID is `<digest ID>-analyst`. */
export function digestIdOfAnalystSession(sessionId: string): string {
  return sessionId.replace(/-analyst$/, "");
}

/** Builds the analyst's session Flow: Dex runs the loop, each model call and tool call is its own Step. */
export function createAnalystAgent(model: ModelClient, clients: DexClientHolder, digestFlow: () => ReleaseDigestFlow): AgentSessionFlow<BuiltinLoopAgentRunner> {
  const submitReport = functionTool<Record<string, unknown>>({
    name: "submit_report",
    description: "Submit the digest's report: every release worth posting, judged. Call it once; on an error, fix the report and call it again.",
    parameters: REPORT_SCHEMA,
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async (report, context) => {
      const result = await clients.get().invokeRPC(digestFlow().submitAnalystReport, digestIdOfAnalystSession(context.flowId), report);
      return result.accepted ? "Report accepted; the digest will post it." : `Report refused: ${result.error}`;
    },
  });
  return createBuiltinAgentSessionFlow(
    {
      name: "release-analyst",
      instructions: INSTRUCTIONS,
      model,
      modelSettings: { reasoningEffort: REASONING_EFFORT },
      tools: [submitReport],
      maxModelCallsPerTurn: 12,
    },
    ANALYST_FLOW_TYPE,
  );
}
