import type { AgentSessionFlow } from "@superdurable/dex-agents";
import { ConnectorToolSource, connectorTool } from "@superdurable/dex-agents/connectors";
import { DiscoverFeedsInputSchema, ReadPageInputSchema, type Connection as WebFeedConnection } from "@superdurable/connector-web-feed";
import webFeedManifest from "@superdurable/connector-web-feed/dex-connector.json" with { type: "json" };
import { createBuiltinAgentSessionFlow, functionTool, type BuiltinLoopAgentRunner, type ModelClient, type ModelOutputWriter, type ModelRequest, type ModelResponse } from "@superdurable/dex-agents/builtin-loop";

import type { DexClientHolder } from "./dex-client-holder.ts";
import { PRIORITY_RUBRIC, TIER_MEANINGS } from "./team-profile.ts";
import { RELEASE_WATCH_PERMISSION } from "./release-analyst-agent.ts";
import type { ReleaseDigestFlow } from "./release-digest-flow.ts";
import { MAX_WINDOW_DAYS, SCHEDULE_FLOW_ID, type ReleaseWatchScheduleFlow } from "./release-watch-schedule-flow.ts";
import { ACTIONABILITY, PRIORITIES } from "./release-types.ts";
import { REASONING_EFFORT } from "./release-model.ts";

/**
 * The session Flow type of the triage agent, one session per digest thread.
 * Also flow-definitions/release-triage-agent.json:
 * `npx --no-install dex-agents-session-graph --flow-type ReleaseTriageAgentFlow --permission release-watch.operate`.
 */
export const TRIAGE_FLOW_TYPE = "ReleaseTriageAgentFlow";
export { RELEASE_WATCH_PERMISSION };

const INSTRUCTIONS = `You are the triage assistant of a Release Watch digest posted in Slack. Each user message is one reply
in the digest's thread, prefixed with who wrote it, such as "<@U123>: track 1 and 3 as P1".

Your tools are the ones listed with this request. They change as the app gains abilities, so never rely on
what you said earlier in this thread about what you cannot do: check your current tools and act.

Start every turn with list_digest_releases, even when you think you know the answer: the numbered releases with their status and issue links, the digest's window, and its health (sources read, sources that failed and why, candidates).

What people ask, and what to do:
${TIER_MEANINGS}
- Track, file, "open an issue", "put it on the board", or a priority next to a number: track_releases with each
  number and its priority. Priorities are ${PRIORITIES.join(", ")}: ${PRIORITY_RUBRIC}. With no priority given,
  use the release's suggested priority and say so. A no-change release is refused unless confirmed: tell the person
  its tier and ask whether to file it anyway or move it to another tier. Only when they say yes in a later reply,
  track it with confirmed true.
- Change a release's tier ("move 3 to must-fix", "that's only a prerelease", "this breaks our build"):
  set_release_tier. Say the new tier; changing the tier does not file it, they still say track.
- Dismiss, skip, ignore, not relevant: dismiss_releases with the numbers and their reason.
- Change a tracked release's priority ("make 2 a P1"): set_release_priority. It relabels the issue.
- Add a note, comment or context to a tracked release's issue: comment_on_issue with the person's words, lightly
  cleaned up but not rewritten.
- Undo tracking, untrack, close the issue, "undo the issues": untrack_releases with the numbers and the reason.
  It closes each issue on GitHub as not planned and puts the release back to open.
- Undo a dismissal, bring one back: reopen_releases.
- Questions about a release: answer from the summary, impact and note; for details, read its release notes page.
- Why something is missing, what else was seen, anything about a library or topic in this digest: search_candidates
  (every item collected, with inDigest telling whether the analyst kept it). If it is not among the candidates,
  say so and check health: the source may have failed or may not be watched.
- What an article or post actually says, details beyond the summary: read the page with the web-feed read page
  tool (maxTextCharacters about 12000) and answer from it, quoting at most a short phrase.
- Did this come up before, earlier digests: search_past_releases.
- Why sources failed, how many were read: answer from health. "insufficientScope" means the GitHub connection
  lacks access; "skipped" means the source kind is not read yet.
- Run it again, rerun with a longer window: run_digest_now, with windowDays when they name a period
  (1 to ${MAX_WINDOW_DAYS}). It posts a new digest in the channel.
- Which sources are watched, watch or stop watching a blog, feed, repository or search term: list_watchlist,
  add_watched_source, remove_watched_source. Changes apply from the next digest. Add only sources the person
  named. For a GitHub repository, add a github-releases source, with tagPattern when the repository
  releases many packages and the person names one. For a blog or changelog, find its feed with the web-feed discover feeds tool on the site's URL; use a
  sitemap source only when there is no feed. Ask when you cannot tell which source they mean.
Releases named by title or library instead of number: match them to numbers; if two could match, ask.

End the turn with your answer as plain text: what you did or found, briefly. The app posts that answer in the
thread, and posts each issue's link itself once GitHub creates it, so do not promise links. track_releases,
untrack_releases, set_release_priority and comment_on_issue only queue the GitHub change, and the app posts in the
thread whether GitHub took it. So say what you asked for ("Filing 2 at P2."), never that the issue is filed,
tracked, closed or relabelled. When the request is
ambiguous or names a number that does not exist, do nothing else and ask one short question instead. Never act on
releases the person did not ask about. Never make up numbers, priorities, sources or facts: say what you could not
find. Keep answers to one to five short lines, plain text, no headings.`;

/** The digest a triage session belongs to, from the session settings the digest started it with. */
async function digestIdOf(clients: DexClientHolder, triageFlow: () => AgentSessionFlow<BuiltinLoopAgentRunner>, sessionId: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(sessionId);
  if (cached !== undefined) {
    return cached;
  }
  const snapshot = await clients.get().invokeRPC(triageFlow().getAgentSnapshot, sessionId);
  const digestId = (snapshot.sessionSettings as { digestId?: unknown } | null | undefined)?.digestId;
  if (typeof digestId !== "string" || digestId === "") {
    throw new Error("this triage session has no digest in its session settings");
  }
  cache.set(sessionId, digestId);
  return digestId;
}

/** Builds the triage agent's session Flow; its tools call the digest's triage RPCs. */
export function createTriageAgent(
  model: ModelClient,
  clients: DexClientHolder,
  digestFlow: () => ReleaseDigestFlow,
  scheduleFlow: () => ReleaseWatchScheduleFlow,
  webFeed: WebFeedConnection,
): AgentSessionFlow<BuiltinLoopAgentRunner> {
  const digests = new Map<string, string>();
  let self: AgentSessionFlow<BuiltinLoopAgentRunner> | undefined;
  const triageFlow = () => self!;
  const listDigestReleases = functionTool<Record<string, never>>({
    name: "list_digest_releases",
    description: "List the digest's releases: number, title, library, tier (actionability), category, relevance, suggested priority, status, and the issue link once tracked.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    execute: async (_arguments, context) => {
      const view = await clients.get().invokeRPC(digestFlow().getTriageView, await digestIdOf(clients, triageFlow, context.flowId, digests));
      return view;
    },
  });
  const trackReleases = functionTool<{ releases: { number: number; priority?: string; confirmed?: boolean }[] }>({
    name: "track_releases",
    description:
      "Track releases: the app files one GitHub issue per release with its priority label and posts its link in the thread. No-change releases need confirmed true, set only after the person confirmed.",
    parameters: {
      type: "object",
      required: ["releases"],
      properties: {
        releases: {
          type: "array",
          items: {
            type: "object",
            required: ["number"],
            properties: { number: { type: "number" }, priority: { type: "string", enum: [...PRIORITIES] }, confirmed: { type: "boolean" } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async ({ releases }, context) => {
      const digestId = await digestIdOf(clients, triageFlow, context.flowId, digests);
      const outcome = await clients.get().invokeRPC(digestFlow().trackReleases, digestId, {
        requestKey: context.idempotencyKey,
        releases: releases.map((release) => ({ number: release.number, priority: release.priority as never, confirmed: release.confirmed === true })),
      });
      return { ...outcome, next: "applied means queued: the app now asks GitHub for each issue and posts its link, or why it failed, in the thread" };
    },
  });
  const dismissReleases = functionTool<{ numbers: number[]; reason: string }>({
    name: "dismiss_releases",
    description: "Dismiss releases the person does not want tracked, with their reason. Nothing is filed.",
    parameters: {
      type: "object",
      required: ["numbers", "reason"],
      properties: { numbers: { type: "array", items: { type: "number" } }, reason: { type: "string" } },
      additionalProperties: false,
    },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async ({ numbers, reason }, context) =>
      clients.get().invokeRPC(digestFlow().dismissReleases, await digestIdOf(clients, triageFlow, context.flowId, digests), {
        requestKey: context.idempotencyKey,
        numbers,
        reason,
      }),
  });
  const searchCandidates = functionTool<{ query?: string; limit?: number }>({
    name: "search_candidates",
    description:
      "Search every item this digest collected from its sources, kept by the analyst or not. Each word of the query must appear in the title, library, source ID, URL or summary; an empty query lists the newest. inDigest tells whether it made the digest.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 40 } },
      additionalProperties: false,
    },
    effect: "read",
    execute: async ({ query, limit }, context) =>
      clients.get().invokeRPC(digestFlow().searchCandidates, await digestIdOf(clients, triageFlow, context.flowId, digests), { query, limit }),
  });
  const searchPastReleases = functionTool<{ query: string }>({
    name: "search_past_releases",
    description: "Search the releases earlier digests posted in the last 90 days, by words in the title, library or URL. Newest first.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string" } }, additionalProperties: false },
    effect: "read",
    execute: async ({ query }) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const records = await clients.get().invokeRPC(scheduleFlow().listReportedReleases, SCHEDULE_FLOW_ID);
      const matches = records
        .filter((record) => words.every((word) => `${record.title} ${record.library} ${record.url}`.toLowerCase().includes(word)))
        .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt));
      return { total: matches.length, releases: matches.slice(0, 20) };
    },
  });
  const untrackReleases = functionTool<{ numbers: number[]; reason: string }>({
    name: "untrack_releases",
    description: "Untrack tracked releases: the app closes each one's GitHub issue as not planned, posts that in the thread, and puts the release back to open.",
    parameters: {
      type: "object",
      required: ["numbers", "reason"],
      properties: { numbers: { type: "array", items: { type: "number" } }, reason: { type: "string" } },
      additionalProperties: false,
    },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async ({ numbers, reason }, context) =>
      clients.get().invokeRPC(digestFlow().untrackReleases, await digestIdOf(clients, triageFlow, context.flowId, digests), {
        requestKey: context.idempotencyKey,
        numbers,
        reason,
      }),
  });
  const setReleasePriority = functionTool<{ releases: { number: number; priority: string }[] }>({
    name: "set_release_priority",
    description: "Change the priority of tracked releases; the app relabels each GitHub issue and confirms in the thread.",
    parameters: {
      type: "object",
      required: ["releases"],
      properties: {
        releases: {
          type: "array",
          items: {
            type: "object",
            required: ["number", "priority"],
            properties: { number: { type: "number" }, priority: { type: "string", enum: [...PRIORITIES] } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async ({ releases }, context) =>
      clients.get().invokeRPC(digestFlow().setReleasePriority, await digestIdOf(clients, triageFlow, context.flowId, digests), {
        requestKey: context.idempotencyKey,
        releases: releases.map((release) => ({ number: release.number, priority: release.priority as never })),
      }),
  });
  const setReleaseTier = functionTool<{ releases: { number: number; actionability: string }[] }>({
    name: "set_release_tier",
    description: "Move releases to another tier (must-fix, recommend, no-change) when the person disagrees with the analyst. Nothing is filed.",
    parameters: {
      type: "object",
      required: ["releases"],
      properties: {
        releases: {
          type: "array",
          items: {
            type: "object",
            required: ["number", "actionability"],
            properties: { number: { type: "number" }, actionability: { type: "string", enum: [...ACTIONABILITY] } },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async ({ releases }, context) =>
      clients.get().invokeRPC(digestFlow().setReleaseTier, await digestIdOf(clients, triageFlow, context.flowId, digests), {
        requestKey: context.idempotencyKey,
        releases: releases.map((release) => ({ number: release.number, actionability: release.actionability as never })),
      }),
  });
  const commentOnIssue = functionTool<{ number: number; text: string; author?: string }>({
    name: "comment_on_issue",
    description: "Add a note to a tracked release's GitHub issue as a comment. author is the Slack mention of who asked, such as <@U123>.",
    parameters: {
      type: "object",
      required: ["number", "text"],
      properties: { number: { type: "number" }, text: { type: "string" }, author: { type: "string" } },
      additionalProperties: false,
    },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async ({ number, text, author }, context) =>
      clients.get().invokeRPC(digestFlow().commentOnIssue, await digestIdOf(clients, triageFlow, context.flowId, digests), {
        requestKey: context.idempotencyKey,
        number,
        text,
        author: author ?? "",
      }),
  });
  const reopenReleases = functionTool<{ numbers: number[] }>({
    name: "reopen_releases",
    description: "Put dismissed releases back to open, so they can be tracked later.",
    parameters: { type: "object", required: ["numbers"], properties: { numbers: { type: "array", items: { type: "number" } } }, additionalProperties: false },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async ({ numbers }, context) =>
      clients.get().invokeRPC(digestFlow().reopenReleases, await digestIdOf(clients, triageFlow, context.flowId, digests), {
        requestKey: context.idempotencyKey,
        numbers,
      }),
  });
  const runDigestNow = functionTool<{ reason: string; windowDays?: number }>({
    name: "run_digest_now",
    description: `Start a new digest now; it posts in the channel when done. windowDays (1 to ${MAX_WINDOW_DAYS}) reads that many days back instead of since the last digest.`,
    parameters: {
      type: "object",
      required: ["reason"],
      properties: { reason: { type: "string" }, windowDays: { type: "integer", minimum: 1, maximum: MAX_WINDOW_DAYS } },
      additionalProperties: false,
    },
    effect: "non_idempotent_write",
    requiresApproval: false,
    execute: async ({ reason, windowDays }) =>
      clients.get().invokeRPC(scheduleFlow().requestDigestNow, SCHEDULE_FLOW_ID, JSON.stringify(windowDays ? { reason, windowDays } : { reason })),
  });
  const listWatchlist = functionTool<Record<string, never>>({
    name: "list_watchlist",
    description: "List the sources the next digest reads: id, kind (feed, sitemap, github-releases, hacker-news), library, the version range we run, and URL, repository with its tag filter, or query.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    effect: "read",
    execute: async () => clients.get().invokeRPC(scheduleFlow().getWatchlist, SCHEDULE_FLOW_ID),
  });
  const addWatchedSource = functionTool<{ id: string; kind: string; library?: string; url?: string; pathPrefix?: string; repository?: string; tagPattern?: string; pinned?: string; query?: string; mustMention?: string[] }>({
    name: "add_watched_source",
    description:
      "Watch a new source from the next digest on. kind feed needs url (RSS or Atom); sitemap needs url and pathPrefix such as /blog/; github-releases needs repository owner/name, optional tagPattern (a regular expression the tag must match) and pinned (the version range we run); hacker-news needs query. id is a short lowercase slug such as gh-fastapi. mustMention keeps only items mentioning one of the terms, for broad feeds.",
    parameters: {
      type: "object",
      required: ["id", "kind"],
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["feed", "sitemap", "github-releases", "hacker-news"] },
        library: { type: "string" },
        url: { type: "string" },
        pathPrefix: { type: "string" },
        repository: { type: "string" },
        tagPattern: { type: "string" },
        pinned: { type: "string" },
        query: { type: "string" },
        mustMention: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async (source) => clients.get().invokeRPC(scheduleFlow().addWatchedSource, SCHEDULE_FLOW_ID, { ...source, tier: 1 } as never),
  });
  const removeWatchedSource = functionTool<{ id: string }>({
    name: "remove_watched_source",
    description: "Stop watching a source, by its id from list_watchlist, from the next digest on.",
    parameters: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false },
    effect: "idempotent_write",
    requiresApproval: false,
    execute: async ({ id }) => clients.get().invokeRPC(scheduleFlow().removeWatchedSource, SCHEDULE_FLOW_ID, id),
  });
  self = createBuiltinAgentSessionFlow(
    {
      name: "release-triage",
      instructions: INSTRUCTIONS,
      model: postingFinalAnswers(model, async (sessionId, requestKey, text) => {
        await clients.get().invokeRPC(digestFlow().postNote, await digestIdOf(clients, triageFlow, sessionId, digests), { requestKey, text });
      }),
      modelSettings: { reasoningEffort: REASONING_EFFORT },
      tools: [
        listDigestReleases,
        searchCandidates,
        searchPastReleases,
        trackReleases,
        dismissReleases,
        untrackReleases,
        setReleasePriority,
        setReleaseTier,
        commentOnIssue,
        reopenReleases,
        runDigestNow,
        listWatchlist,
        addWatchedSource,
        removeWatchedSource,
      ],
      // Public pages only: reading an article and finding a site's feeds, for questions and for watching a new blog.
      toolSources: [
        new ConnectorToolSource([
          connectorTool(webFeed.operations.readPage(), webFeed.reference, { manifest: webFeedManifest as never, inputValidator: ReadPageInputSchema as never }),
          connectorTool(webFeed.operations.discoverFeeds(), webFeed.reference, { manifest: webFeedManifest as never, inputValidator: DiscoverFeedsInputSchema as never }),
        ]),
      ],
      maxModelCallsPerTurn: 12,
    },
    TRIAGE_FLOW_TYPE,
  );
  return self;
}

/**
 * Wraps the model so each turn's final answer reaches the thread: a response with
 * no tool calls is the answer, and it is posted before the RunModel attempt ends.
 * The request key is the turn's, so a retried attempt posts nothing more.
 */
function postingFinalAnswers(model: ModelClient, post: (sessionId: string, requestKey: string, text: string) => Promise<void>): ModelClient {
  return {
    estimateInputTokens: (request) => model.estimateInputTokens(request),
    callModel: async (request: ModelRequest, output: ModelOutputWriter): Promise<ModelResponse> => {
      const response = await model.callModel(request, output);
      const answer = response.text.trim();
      if (response.toolCalls.length === 0 && answer !== "") {
        await post(request.metadata.flowId, `answer:${request.metadata.turnId}`, answer);
      }
      return response;
    },
  };
}
