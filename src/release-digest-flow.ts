import {
  Attribute,
  Channel,
  FlowNotActiveOrNotFoundError,
  StepList,
  Timer,
  Wait,
  deadEnd,
  declareRPCMethod,
  booleanCodec,
  doubleCodec,
  StepMovement,
  StepRef,
  goTo,
  gracefulComplete,
  jsonCodec,
  type AsyncContext,
  type Context,
  type Flow,
  type PersistenceSchema,
  type RPCResult,
  type Step,
  type StepDecision,
  type StepOptions,
} from "@superdurable/dex";
import type { QueryResult, MutationResult } from "@superdurable/connectors-sdk";
import { IssueStateClosed, IssueStateReasonNotPlanned, newCreateIssueStep, newListReleasesStep, newSetIssueStateStep, newReplaceIssueLabelsStep, newCreateIssueCommentStep, type UpdatedIssueState, type ReplacedIssueLabels, type CreatedIssueComment, type Connection as GitHubConnection, type CreatedIssue, type ReleasePage } from "@superdurable/connector-github";
import { newGetItemStep, newListStoryIDsStep, newSearchStoriesStep, type Connection as HackerNewsConnection, type StorySearchPage } from "@superdurable/connector-hackernews";
import { newReadFeedStep, newReadSitemapStep, type Connection as WebFeedConnection, type Feed, type Sitemap } from "@superdurable/connector-web-feed";
import {
  defineThreadReplyCreatedTriggerBinding,
  newPostChannelMessageStep,
  newPostThreadReplyStep,
  type Connection as SlackConnection,
} from "@superdurable/connector-slack";
import { startAgentSession, type AgentSessionFlow } from "@superdurable/dex-agents";
import type { BuiltinLoopAgentRunner } from "@superdurable/dex-agents/builtin-loop";

import type { DexClientHolder } from "./dex-client-holder.ts";
import {
  MAX_ANALYST_CANDIDATES,
  fallbackReport,
  numberReleases,
  renderAnalystBrief,
  renderDetails,
  renderHeadline,
  renderIssue,
  renderIssueFiled,
  renderQuietDigest,
} from "./digest-render.ts";
import { ACTIONABILITY, ISSUE_TIERS, canonicalUrl, capPriority, decodeAnalystReport, tierOf, type Actionability, type AnalystReport, type Candidate, type DigestRelease, type Priority } from "./release-types.ts";
import type { ReleaseWatchScheduleFlow, ReportedReleaseRecord } from "./release-watch-schedule-flow.ts";
import { SCHEDULE_FLOW_ID } from "./release-watch-schedule-flow.ts";
import {
  feedCandidates,
  hackerNewsCandidate,
  mergeCandidates,
  githubReleaseCandidates,
  sitemapCandidates,
  storySearchCandidates,
  type HackerNewsItemLike,
} from "./source-candidates.ts";
import { WATCHLIST, type WatchedSource } from "./watchlist.ts";

/** The connection names the Project's Configuration binds; dex-app.yaml declares each. */
export const SLACK_CONNECTION = "release-watch-slack";
export const GITHUB_CONNECTION = "release-watch-github";
export const HACKER_NEWS_CONNECTION = "release-watch-hacker-news";
export const WEB_FEED_CONNECTION = "release-watch-web-feed";
/** The GitHub connection that files issues: its repository sign-in grants issue writes. */
export const GITHUB_ISSUES_CONNECTION = "release-watch-github-issues";
/** The repository where tracked releases become issues. */
export interface IssueRepository {
  readonly owner: string;
  readonly repository: string;
}

/** Parses the ISSUE_REPOSITORY setting, owner/name; undefined when it is missing or malformed. */
export function parseIssueRepository(setting: string | undefined): IssueRepository | undefined {
  const [owner, repository, ...rest] = (setting ?? "").trim().split("/");
  return owner && repository && rest.length === 0 ? { owner, repository } : undefined;
}
/** The reply Trigger binding: its channel is where the digest posts, its members may triage. */
export const SLACK_REPLY_BINDING = "release-watch-replies";

/**
 * Releases read per repository through the API. GitHub returns each release's full notes, and a page of 100
 * from a busy monorepo goes past the connector's 2 MB response limit.
 */
const RELEASE_PAGE_SIZE = 40;
/** How long the analyst may work before the digest posts the candidates unranked. */
const ANALYST_DEADLINE_MS = 40 * 60_000;
/** How long a digest thread accepts triage replies. */
const TRIAGE_WINDOW_MS = 14 * 86_400_000;
/** Request keys remembered for de-duplicating agent tool calls. */
const HANDLED_REQUEST_LIMIT = 500;

/** What starts one digest. */
export interface DigestStartInput {
  readonly digestId: string;
  /** The local calendar date of the digest, YYYY-MM-DD. */
  readonly digestDate: string;
  /** RFC 3339: the digest reports what appeared after this time. */
  readonly windowStart: string;
  readonly startedAt: string;
  /** The sources to read; the built-in watchlist when absent. */
  readonly sources?: readonly WatchedSource[];
}

export type DigestStatus = "collecting" | "analyzing" | "posting" | "open" | "closed" | "failed";

/** The digest's own record, which the API, the page and the agents read. */
export interface DigestState {
  readonly digestId: string;
  readonly digestDate: string;
  readonly windowStart: string;
  readonly status: DigestStatus;
  readonly sourceCount: number;
  readonly sourceErrors: readonly string[];
  readonly skippedSources: readonly string[];
  readonly candidateCount: number;
  readonly analystSessionId?: string;
  readonly triageSessionId?: string;
  readonly unanalyzed?: boolean;
  readonly slackChannelId?: string;
  readonly slackThreadTs?: string;
  readonly failure?: string;
}

/** One queued effect of a triage decision, run one at a time. */
export type OutboxEntry =
  | { readonly kind: "issue"; readonly releaseNumber: number }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "close"; readonly releaseNumber: number; readonly reason: string }
  | { readonly kind: "relabel"; readonly releaseNumber: number }
  | { readonly kind: "comment"; readonly releaseNumber: number; readonly text: string };

/** A Hacker News scan in progress: the feed's story IDs still to read. */
interface StoryQueue {
  readonly sourceIndex: number;
  readonly ids: readonly number[];
}

export const digestState = new Attribute("digest-state", jsonCodec<DigestState>({ typeName: "DigestState" }));
export const digestCandidates = new Attribute("digest-candidates", jsonCodec<Candidate[]>({ typeName: "Candidates" }));
export const digestReleases = new Attribute("digest-releases", jsonCodec<DigestRelease[]>({ typeName: "DigestReleases" }));
export const analystReport = new Attribute("analyst-report", jsonCodec<AnalystReport>({ typeName: "AnalystReport", decode: decodeAnalystReport }));
const sourceCursor = new Attribute("source-cursor", doubleCodec);
const storyQueue = new Attribute("hacker-news-queue", jsonCodec<StoryQueue>({ typeName: "StoryQueue" }));
const detailMessages = new Attribute("detail-messages", jsonCodec<string[]>({ typeName: "DetailMessages" }));
const detailCursor = new Attribute("detail-cursor", doubleCodec);
export const outbox = new Attribute("outbox", jsonCodec<OutboxEntry[]>({ typeName: "Outbox" }));
const outboxCurrent = new Attribute("outbox-current", jsonCodec<OutboxEntry>({ typeName: "OutboxEntry" }));
const outboxActive = new Attribute("outbox-active", booleanCodec);
const digestSources = new Attribute("digest-sources", jsonCodec<WatchedSource[]>({ typeName: "WatchedSources" }));
const handledRequests = new Attribute("handled-requests", jsonCodec<string[]>({ typeName: "HandledRequests" }));
const reportSubmitted = new Channel("analyst-report-submitted", jsonCodec<AnalystReport>({ typeName: "AnalystReport", decode: decodeAnalystReport }));

const startCodec = jsonCodec<DigestStartInput>({ typeName: "DigestStartInput" });
const repositoryCodec = jsonCodec<{ readonly owner: string; readonly repository: string; readonly pageSize?: number }>({ typeName: "Repository" });
const feedCodec = jsonCodec<{ readonly feed: string; readonly limit: number }>({ typeName: "HackerNewsFeed" });
const feedRequestCodec = jsonCodec<{ readonly url: string }>({ typeName: "FeedRequest" });
const sitemapRequestCodec = jsonCodec<{ readonly url: string; readonly pathPrefix: string; readonly since: string }>({ typeName: "SitemapRequest" });
const searchRequestCodec = jsonCodec<{ readonly query: string; readonly since: string }>({ typeName: "StorySearchRequest" });
const storyCodec = jsonCodec<{ readonly id: number }>({ typeName: "HackerNewsStory" });
const messageCodec = jsonCodec<{ readonly text: string }>({ typeName: "SlackText" });
const threadMessageCodec = jsonCodec<ThreadMessage>({ typeName: "SlackThreadText" });

/** One GitHub issue to file for a tracked release. */
interface IssueRequest {
  readonly releaseNumber: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

const issueRequestCodec = jsonCodec<IssueRequest>({ typeName: "IssueRequest" });
const relabelRequestCodec = jsonCodec<{ readonly releaseNumber: number; readonly issueNumber: number; readonly labels: readonly string[] }>({ typeName: "RelabelIssueRequest" });
const commentRequestCodec = jsonCodec<{ readonly releaseNumber: number; readonly issueNumber: number; readonly body: string }>({ typeName: "CommentIssueRequest" });
const closeRequestCodec = jsonCodec<{ readonly releaseNumber: number; readonly issueNumber: number }>({ typeName: "CloseIssueRequest" });

/** A thread reply's text and the digest message it answers. */
interface ThreadMessage {
  readonly text: string;
  readonly threadTs: string;
}

/** The services and connections a digest needs, injected once per process. */
export interface DigestDependencies {
  readonly clients: DexClientHolder;
  /** The Slack channel the digest posts to: the channel of the reply Trigger binding. */
  readonly slackChannelId: string;
  readonly slack: SlackConnection;
  readonly github: GitHubConnection;
  readonly githubIssues: GitHubConnection;
  /** Where tracked releases are filed; only the Worker files, so the web process may leave it empty. */
  readonly issueRepository: IssueRepository;
  readonly hackerNews: HackerNewsConnection;
  readonly webFeed: WebFeedConnection;
  readonly analystFlow: () => AgentSessionFlow<BuiltinLoopAgentRunner>;
  readonly triageFlow: () => AgentSessionFlow<BuiltinLoopAgentRunner>;
  readonly scheduleFlow: () => ReleaseWatchScheduleFlow;
}

/** The analyst session of a digest. */
export function analystSessionId(digestId: string): string {
  return `${digestId}-analyst`;
}

/** The triage session of a digest's Slack thread; the reply Trigger resolves the same ID from a reply. */
export function triageSessionId(channelId: string, threadTs: string): string {
  return `release-triage-${channelId}-${threadTs.replace(/\./g, "-")}`;
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Record the digest window and start reading the watched sources."
class StartDigestRun implements Step<DigestStartInput> {
  public readonly inputCodec = startCodec;

  public getStepType(): string {
    return "StartDigestRun";
  }

  public execute(context: Context, input: DigestStartInput): StepDecision {
    digestState.set(context, {
      digestId: input.digestId,
      digestDate: input.digestDate,
      windowStart: input.windowStart,
      status: "collecting",
      sourceCount: (input.sources ?? WATCHLIST).length,
      sourceErrors: [],
      skippedSources: [],
      candidateCount: 0,
    });
    digestCandidates.set(context, []);
    digestSources.set(context, [...(input.sources ?? WATCHLIST)]);
    sourceCursor.set(context, 0);
    return goTo(CollectNextSource, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Read the next watched source with the connector of its kind, or merge once every source is read."
class CollectNextSource implements Step<Record<string, never>> {
  private readonly flow: ReleaseDigestFlow;

  public constructor(flow: ReleaseDigestFlow) {
    this.flow = flow;
  }

  public getStepType(): string {
    return "CollectNextSource";
  }

  public execute(context: Context): StepDecision {
    const index = sourceCursor.get(context);
    const source = sourcesOf(context)[index];
    if (source === undefined) {
      return goTo(this.flow.mergeCandidatesStep, {});
    }
    if (source.kind === "github-releases" && source.repository) {
      // GitHub's public release feed needs no sign-in but lists only the newest ten releases of the repository,
      // across all its packages. A source with a tagPattern is usually a monorepo whose other packages push the
      // ones you watch out of those ten, so it reads a page of RELEASE_PAGE_SIZE, or the source's pageSize, through the API and its GitHub connection.
      // LIST_RELEASES_THROUGH_API=true sends every repository through the API.
      if (source.tagPattern || process.env.LIST_RELEASES_THROUGH_API === "true") {
        const [owner, repository] = source.repository.split("/") as [string, string];
        return goTo(this.flow.listReleases, { owner, repository, ...(source.pageSize ? { pageSize: source.pageSize } : {}) });
      }
      return goTo(this.flow.readFeed, { url: `https://github.com/${source.repository}/releases.atom` });
    }
    if (source.kind === "feed" && source.url) {
      return goTo(this.flow.readFeed, { url: source.url });
    }
    if (source.kind === "sitemap" && source.url) {
      return goTo(this.flow.readSitemap, { url: source.url, pathPrefix: source.pathPrefix ?? "/", since: digestState.get(context)?.windowStart ?? "" });
    }
    if (source.kind === "hacker-news" && source.query) {
      return goTo(this.flow.searchStories, { query: source.query, since: digestState.get(context)?.windowStart ?? "" });
    }
    if (source.kind === "hacker-news-feed" && source.feed) {
      return goTo(this.flow.listStoryIds, { feed: source.feed, limit: source.limit ?? 100 });
    }
    return goTo(this.flow.recordSourceSkipped, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Keep the releases of the digest window as candidates, then read the next source."
class RecordGitHubReleases implements Step<QueryResult<ReleasePage>> {
  public getStepType(): string {
    return "RecordGitHubReleases";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestCandidates.lock(), sourceCursor.lock()] };
  }

  public execute(context: Context, result: QueryResult<ReleasePage>): StepDecision {
    const index = sourceCursor.get(context);
    const state = digestState.get(context)!;
    const found = githubReleaseCandidates(sourcesOf(context)[index]!, result.value.releases ?? [], state.windowStart);
    digestCandidates.set(context, [...(digestCandidates.get(context) ?? []), ...found]);
    sourceCursor.set(context, index + 1);
    return goTo(CollectNextSource, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Keep the feed's posts of the digest window as candidates, then read the next source."
class RecordFeedItems implements Step<QueryResult<Feed>> {
  public getStepType(): string {
    return "RecordFeedItems";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestCandidates.lock(), sourceCursor.lock()] };
  }

  public execute(context: Context, result: QueryResult<Feed>): StepDecision {
    const index = sourceCursor.get(context);
    const state = digestState.get(context)!;
    const found = result.branch === "read" ? feedCandidates(sourcesOf(context)[index]!, result.value.items ?? [], state.windowStart) : [];
    digestCandidates.set(context, [...(digestCandidates.get(context) ?? []), ...found]);
    sourceCursor.set(context, index + 1);
    return goTo(CollectNextSource, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Keep the blog posts the sitemap shows as changed in the window, then read the next source."
class RecordSitemapEntries implements Step<QueryResult<Sitemap>> {
  public getStepType(): string {
    return "RecordSitemapEntries";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestCandidates.lock(), sourceCursor.lock()] };
  }

  public execute(context: Context, result: QueryResult<Sitemap>): StepDecision {
    const index = sourceCursor.get(context);
    const state = digestState.get(context)!;
    const found = result.branch === "read" ? sitemapCandidates(sourcesOf(context)[index]!, result.value.entries ?? [], state.windowStart) : [];
    digestCandidates.set(context, [...(digestCandidates.get(context) ?? []), ...found]);
    sourceCursor.set(context, index + 1);
    return goTo(CollectNextSource, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Keep the Hacker News stories the search found in the window, then read the next source."
class RecordStorySearch implements Step<QueryResult<StorySearchPage>> {
  public getStepType(): string {
    return "RecordStorySearch";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestCandidates.lock(), sourceCursor.lock()] };
  }

  public execute(context: Context, result: QueryResult<StorySearchPage>): StepDecision {
    const index = sourceCursor.get(context);
    const found = storySearchCandidates(sourcesOf(context)[index]!, result.value.stories ?? []);
    digestCandidates.set(context, [...(digestCandidates.get(context) ?? []), ...found]);
    sourceCursor.set(context, index + 1);
    return goTo(CollectNextSource, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Queue the Hacker News feed's stories to read one at a time."
class QueueHackerNewsStories implements Step<QueryResult<{ readonly ids: number[] | null }>> {
  public getStepType(): string {
    return "QueueHackerNewsStories";
  }

  public execute(context: Context, result: QueryResult<{ readonly ids: number[] | null }>): StepDecision {
    storyQueue.set(context, { sourceIndex: sourceCursor.get(context), ids: result.value.ids ?? [] });
    return goTo(ReadNextHackerNewsStory, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Read the next queued Hacker News story, or move to the next source when the queue is empty."
class ReadNextHackerNewsStory implements Step<Record<string, never>> {
  private readonly flow: ReleaseDigestFlow;

  public constructor(flow: ReleaseDigestFlow) {
    this.flow = flow;
  }

  public getStepType(): string {
    return "ReadNextHackerNewsStory";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [storyQueue.lock(), sourceCursor.lock()] };
  }

  public execute(context: Context): StepDecision {
    const queue = storyQueue.get(context);
    const [next, ...rest] = queue?.ids ?? [];
    if (queue === undefined || next === undefined) {
      sourceCursor.set(context, sourceCursor.get(context) + 1);
      return goTo(CollectNextSource, {});
    }
    storyQueue.set(context, { sourceIndex: queue.sourceIndex, ids: rest });
    return goTo(this.flow.getStory, { id: next });
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Keep the story as a candidate when it is recent and mentions the watched topic."
class RecordHackerNewsStory implements Step<QueryResult<HackerNewsItemLike>> {
  public getStepType(): string {
    return "RecordHackerNewsStory";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestCandidates.lock()] };
  }

  public execute(context: Context, result: QueryResult<HackerNewsItemLike>): StepDecision {
    const state = digestState.get(context)!;
    const source = sourcesOf(context)[storyQueue.get(context)?.sourceIndex ?? sourceCursor.get(context)]!;
    const candidate = result.branch === "found" ? hackerNewsCandidate(source, result.value, state.windowStart) : undefined;
    if (candidate !== undefined) {
      digestCandidates.set(context, [...(digestCandidates.get(context) ?? []), candidate]);
    }
    return goTo(ReadNextHackerNewsStory, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Record that the source failed with its branch, then read the next source."
class RecordSourceFailure implements Step<QueryResult<unknown>> {
  public getStepType(): string {
    return "RecordSourceFailure";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestState.lock(), sourceCursor.lock()] };
  }

  public execute(context: Context, result: QueryResult<unknown>): StepDecision {
    const index = sourceCursor.get(context);
    const state = digestState.get(context)!;
    const reason = `${sourcesOf(context)[index]?.id ?? index}: ${result.branch}${result.failure ? ` (${result.failure.kind})` : ""}`;
    digestState.set(context, { ...state, sourceErrors: [...state.sourceErrors, reason] });
    sourceCursor.set(context, index + 1);
    return goTo(CollectNextSource, {});
  }
}

// dex:group group-id:collect group-label:"Collect"
// dex:explanation text:"Skip a source whose connector is not available yet, then read the next source."
class RecordSourceSkipped implements Step<Record<string, never>> {
  public getStepType(): string {
    return "RecordSourceSkipped";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestState.lock(), sourceCursor.lock()] };
  }

  public execute(context: Context): StepDecision {
    const index = sourceCursor.get(context);
    const state = digestState.get(context)!;
    digestState.set(context, { ...state, skippedSources: [...state.skippedSources, sourcesOf(context)[index]?.id ?? String(index)] });
    sourceCursor.set(context, index + 1);
    return goTo(CollectNextSource, {});
  }
}

// dex:group group-id:analyze group-label:"Analyze"
// dex:explanation text:"Merge duplicate candidates, leave out releases earlier digests posted, and keep the most likely ones."
class MergeCandidates implements Step<Record<string, never>> {
  private readonly dependencies: DigestDependencies;

  public constructor(dependencies: DigestDependencies) {
    this.dependencies = dependencies;
  }

  public getStepType(): string {
    return "MergeCandidates";
  }

  public getStepOptions(): StepOptions {
    return { executeMethodTimeoutMs: 30_000, executeRetry: { maximumAttempts: 3 }, executeLockAttributes: [digestState.lock(), digestCandidates.lock()] };
  }

  public async execute(context: AsyncContext): Promise<StepDecision> {
    const reported = await readReportedReleases(this.dependencies);
    const reportedUrls = new Set(reported.map((record) => canonicalUrl(record.url)));
    const merged = mergeCandidates(digestCandidates.get(context) ?? [], reportedUrls, MAX_ANALYST_CANDIDATES);
    digestCandidates.set(context, merged);
    const state = digestState.get(context)!;
    digestState.set(context, { ...state, candidateCount: merged.length, status: merged.length > 0 ? "analyzing" : "posting" });
    if (merged.length === 0) {
      return goTo(new StepRef("PostDigestHeadline"), { text: renderQuietDigest(state.digestDate, state.sourceCount, state.sourceErrors.length) });
    }
    return goTo(StartAnalystSession, {});
  }
}

// dex:group group-id:analyze group-label:"Analyze"
// dex:explanation text:"Start the analyst agent's session with every candidate, once, by its session ID."
class StartAnalystSession implements Step<Record<string, never>> {
  private readonly dependencies: DigestDependencies;

  public constructor(dependencies: DigestDependencies) {
    this.dependencies = dependencies;
  }

  public getStepType(): string {
    return "StartAnalystSession";
  }

  public getStepOptions(): StepOptions {
    return { executeMethodTimeoutMs: 30_000, executeRetry: { maximumAttempts: 5 }, executeLockAttributes: [digestState.lock()] };
  }

  public async execute(context: AsyncContext): Promise<StepDecision> {
    const state = digestState.get(context)!;
    const sessionId = analystSessionId(state.digestId);
    const brief = renderAnalystBrief(state.digestDate, state.windowStart, digestCandidates.get(context) ?? [], state.sourceErrors);
    await startAgentSession(
      this.dependencies.clients.get(),
      this.dependencies.analystFlow(),
      sessionId,
      { initialMessage: brief, sessionSettings: { digestId: state.digestId } },
      { requestId: `start-${sessionId}`, ignoreAlreadyStarted: true },
    );
    digestState.set(context, { ...state, analystSessionId: sessionId });
    return goTo(AwaitAnalystReport, {});
  }
}

// dex:group group-id:analyze group-label:"Analyze"
// dex:explanation text:"Wait for the analyst's report, or post the candidates unranked when the analyst runs out of time."
class AwaitAnalystReport implements Step<Record<string, never>> {
  public getStepType(): string {
    return "AwaitAnalystReport";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestState.lock(), digestReleases.lock()] };
  }

  public waitFor(): Wait {
    return Wait.anyOf(reportSubmitted.forOne(), Timer.byDuration(ANALYST_DEADLINE_MS, "analyst-deadline"));
  }

  public execute(context: Context): StepDecision {
    // The report is read before the Timer, so a report that lands with the deadline is kept.
    const [submitted] = reportSubmitted.results(context);
    const state = digestState.get(context)!;
    const report = submitted ?? fallbackReport(digestCandidates.get(context) ?? []);
    analystReport.set(context, report);
    const releases = numberReleases(report);
    digestReleases.set(context, releases);
    detailMessages.set(context, renderDetails(releases));
    detailCursor.set(context, 0);
    digestState.set(context, { ...state, status: "posting", unanalyzed: submitted === undefined });
    if (releases.length === 0) {
      return goTo(new StepRef("PostDigestHeadline"), { text: renderQuietDigest(state.digestDate, state.sourceCount, state.sourceErrors.length) });
    }
    return goTo(new StepRef("PostDigestHeadline"), {
      text: renderHeadline(
        state.digestDate,
        releases,
        state.sourceCount - state.skippedSources.length,
        state.sourceErrors.length,
        submitted === undefined,
        submitted === undefined ? 0 : skippedCandidateCount(digestCandidates.get(context) ?? [], releases),
      ),
    });
  }
}

// dex:group group-id:post group-label:"Post"
// dex:explanation text:"Keep the Slack timestamp of the digest message, then post the rest of the digest in its thread."
class RecordDigestHeadline implements Step<MutationResult<{ readonly message: { readonly channelId: string; readonly timestamp: string } }>> {
  public getStepType(): string {
    return "RecordDigestHeadline";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestState.lock()] };
  }

  public execute(context: Context, result: MutationResult<{ readonly message: { readonly channelId: string; readonly timestamp: string } }>): StepDecision {
    const state = digestState.get(context)!;
    const posted = { ...state, slackChannelId: result.value.message.channelId, slackThreadTs: result.value.message.timestamp };
    if ((digestReleases.get(context) ?? []).length === 0) {
      // Nothing to triage: the digest is done once Slack has the message.
      digestState.set(context, { ...posted, status: "closed" });
      return gracefulComplete();
    }
    digestState.set(context, posted);
    return goTo(PostNextDetail, {});
  }
}

// dex:group group-id:post group-label:"Post"
// dex:explanation text:"Post the next thread message of the digest, or open triage once every message is posted."
class PostNextDetail implements Step<Record<string, never>> {
  private readonly flow: ReleaseDigestFlow;

  public constructor(flow: ReleaseDigestFlow) {
    this.flow = flow;
  }

  public getStepType(): string {
    return "PostNextDetail";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [detailCursor.lock()] };
  }

  public execute(context: Context): StepDecision {
    const index = detailCursor.get(context);
    const text = (detailMessages.get(context) ?? [])[index];
    if (text === undefined) {
      return goTo(StartTriageSession, {});
    }
    detailCursor.set(context, index + 1);
    return goTo(this.flow.postDigestDetail, { text, threadTs: digestState.get(context)?.slackThreadTs ?? "" });
  }
}

// dex:group group-id:post group-label:"Post"
// dex:explanation text:"Continue with the next thread message after Slack accepted one."
class RecordDigestDetail implements Step<MutationResult<unknown>> {
  public getStepType(): string {
    return "RecordDigestDetail";
  }

  public execute(): StepDecision {
    return goTo(PostNextDetail, {});
  }
}

// dex:group group-id:post group-label:"Post"
// dex:explanation text:"Record that Slack refused or may not have posted a digest message, and stop the digest."
class RecordSlackFailure implements Step<MutationResult<unknown>> {
  public getStepType(): string {
    return "RecordSlackFailure";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestState.lock()] };
  }

  public execute(context: Context, result: MutationResult<unknown>): StepDecision {
    const state = digestState.get(context)!;
    digestState.set(context, { ...state, status: "failed", failure: `Slack: ${result.branch}${result.failure ? ` (${result.failure.kind}: ${result.failure.message})` : ""}` });
    return gracefulComplete();
  }
}

// dex:group group-id:triage group-label:"Triage"
// dex:explanation text:"Start the triage agent on the digest's Slack thread and remember the posted releases for later digests."
class StartTriageSession implements Step<Record<string, never>> {
  private readonly dependencies: DigestDependencies;

  public constructor(dependencies: DigestDependencies) {
    this.dependencies = dependencies;
  }

  public getStepType(): string {
    return "StartTriageSession";
  }

  public getStepOptions(): StepOptions {
    return { executeMethodTimeoutMs: 30_000, executeRetry: { maximumAttempts: 5 }, executeLockAttributes: [digestState.lock()] };
  }

  public async execute(context: AsyncContext): Promise<StepDecision> {
    const state = digestState.get(context)!;
    const sessionId = triageSessionId(state.slackChannelId!, state.slackThreadTs!);
    const client = this.dependencies.clients.get();
    await startAgentSession(
      client,
      this.dependencies.triageFlow(),
      sessionId,
      { initialMessage: null, sessionSettings: { digestId: state.digestId, channelId: state.slackChannelId ?? "", threadTs: state.slackThreadTs ?? "" } },
      { requestId: `start-${sessionId}`, ignoreAlreadyStarted: true },
    );
    const records: ReportedReleaseRecord[] = (digestReleases.get(context) ?? []).map((release) => ({
      key: canonicalUrlKey(release.url),
      title: release.title,
      library: release.library,
      url: release.url,
      digestId: state.digestId,
      reportedAt: new Date().toISOString(),
    }));
    await recordReported(this.dependencies, records);
    digestState.set(context, { ...state, status: "open", triageSessionId: sessionId });
    return goTo(AwaitTriageWindow, {});
  }
}

// dex:group group-id:triage group-label:"Triage"
// dex:explanation text:"Keep the digest open for triage replies until its window ends."
class AwaitTriageWindow implements Step<Record<string, never>> {
  public getStepType(): string {
    return "AwaitTriageWindow";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestState.lock()] };
  }

  public waitFor(): Wait {
    return Wait.anyOf(Timer.byDuration(TRIAGE_WINDOW_MS, "triage-window"));
  }

  public execute(context: Context): StepDecision {
    const state = digestState.get(context)!;
    digestState.set(context, { ...state, status: "closed" });
    return gracefulComplete();
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Take the next queued triage effect, a GitHub issue or a thread note, or stop when the queue is empty."
class ProcessOutbox implements Step<Record<string, never>> {
  private readonly flow: ReleaseDigestFlow;

  public constructor(flow: ReleaseDigestFlow) {
    this.flow = flow;
  }

  public getStepType(): string {
    return "ProcessOutbox";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [outbox.lock(), outboxCurrent.lock(), outboxActive.lock()] };
  }

  public execute(context: Context): StepDecision {
    const [next, ...rest] = outbox.get(context) ?? [];
    if (next === undefined) {
      outboxCurrent.delete(context);
      outboxActive.set(context, false);
      return deadEnd();
    }
    outbox.set(context, rest);
    outboxCurrent.set(context, next);
    if (next.kind === "note") {
      return goTo(this.flow.postThreadNote, { text: next.text, threadTs: digestState.get(context)?.slackThreadTs ?? "" });
    }
    const release = (digestReleases.get(context) ?? []).find((candidate) => candidate.number === next.releaseNumber);
    if (release === undefined) {
      return goTo(ProcessOutbox, {});
    }
    if (next.kind === "relabel" || next.kind === "comment") {
      if (release.issueNumber === undefined) {
        return goTo(ProcessOutbox, {});
      }
      if (next.kind === "relabel") {
        const labels = renderIssue(release, digestState.get(context)?.digestId ?? "", undefined).labels;
        return goTo(this.flow.relabelReleaseIssue, { releaseNumber: release.number, issueNumber: release.issueNumber, labels });
      }
      return goTo(this.flow.commentOnReleaseIssue, { releaseNumber: release.number, issueNumber: release.issueNumber, body: next.text });
    }
    if (next.kind === "close") {
      return release.issueNumber === undefined ? goTo(ProcessOutbox, {}) : goTo(this.flow.closeReleaseIssue, { releaseNumber: release.number, issueNumber: release.issueNumber });
    }
    const state = digestState.get(context);
    const issue = renderIssue(release, state?.digestId ?? "", undefined);
    return goTo(this.flow.createReleaseIssue, { releaseNumber: release.number, title: issue.title, body: issue.body, labels: issue.labels });
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Continue with the next queued effect after Slack accepted the thread note."
class RecordThreadNote implements Step<MutationResult<unknown>> {
  public getStepType(): string {
    return "RecordThreadNote";
  }

  public execute(): StepDecision {
    return goTo(ProcessOutbox, {});
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Mark the release tracked with its new GitHub issue, then confirm it in the digest's thread."
class RecordReleaseIssue implements Step<MutationResult<CreatedIssue>> {
  private readonly flow: ReleaseDigestFlow;

  public constructor(flow: ReleaseDigestFlow) {
    this.flow = flow;
  }

  public getStepType(): string {
    return "RecordReleaseIssue";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestReleases.lock()] };
  }

  public execute(context: Context, result: MutationResult<CreatedIssue>): StepDecision {
    const current = outboxCurrent.get(context);
    const number = current?.kind === "issue" ? current.releaseNumber : -1;
    const issue = result.value;
    let filed: DigestRelease | undefined;
    digestReleases.set(
      context,
      (digestReleases.get(context) ?? []).map((release) => {
        if (release.number !== number) {
          return release;
        }
        // A note from an earlier failure, dismissal or untrack no longer describes a filed release.
        const { note: _note, ...rest } = release;
        filed = { ...rest, status: "tracked", issueUrl: issue.url, issueNumber: issue.number };
        return filed;
      }),
    );
    const threadTs = digestState.get(context)?.slackThreadTs ?? "";
    if (filed === undefined || !issue.url) {
      return goTo(ProcessOutbox, {});
    }
    return goTo(this.flow.postThreadNote, { text: renderIssueFiled(filed, issue.url, issue.number ?? 0), threadTs });
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Mark the untracked release open again now that its GitHub issue is closed, and tell the thread."
class RecordIssueClosed implements Step<MutationResult<UpdatedIssueState>> {
  private readonly flow: ReleaseDigestFlow;

  public constructor(flow: ReleaseDigestFlow) {
    this.flow = flow;
  }

  public getStepType(): string {
    return "RecordIssueClosed";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestReleases.lock()] };
  }

  public execute(context: Context): StepDecision {
    const current = outboxCurrent.get(context);
    if (current?.kind !== "close") {
      return goTo(ProcessOutbox, {});
    }
    let closed: DigestRelease | undefined;
    digestReleases.set(
      context,
      (digestReleases.get(context) ?? []).map((release) => {
        if (release.number !== current.releaseNumber) {
          return release;
        }
        closed = release;
        const { priority: _priority, issueUrl: _issueUrl, issueNumber: _issueNumber, ...rest } = release;
        return { ...rest, status: "open" as const, note: `untracked: ${current.reason}${release.issueNumber ? ` (closed #${release.issueNumber})` : ""}` };
      }),
    );
    if (closed === undefined) {
      return goTo(ProcessOutbox, {});
    }
    const text = `Untracked *${closed.number}. ${closed.title.replace(/[*_~`<>]/g, "")}*: closed issue #${closed.issueNumber ?? "?"} as not planned.`;
    return goTo(this.flow.postThreadNote, { text, threadTs: digestState.get(context)?.slackThreadTs ?? "" });
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Tell the thread the issue's labels now carry the release's new priority."
class RecordIssueRelabeled implements Step<MutationResult<ReplacedIssueLabels>> {
  private readonly flow: ReleaseDigestFlow;

  public constructor(flow: ReleaseDigestFlow) {
    this.flow = flow;
  }

  public getStepType(): string {
    return "RecordIssueRelabeled";
  }

  public execute(context: Context): StepDecision {
    const current = outboxCurrent.get(context);
    const release = (digestReleases.get(context) ?? []).find((candidate) => current?.kind === "relabel" && candidate.number === current.releaseNumber);
    if (release === undefined) {
      return goTo(ProcessOutbox, {});
    }
    const text = `Release ${release.number} is now ${release.priority}: relabeled ${release.issueUrl ? `<${release.issueUrl}|#${release.issueNumber}>` : `#${release.issueNumber}`}.`;
    return goTo(this.flow.postThreadNote, { text, threadTs: digestState.get(context)?.slackThreadTs ?? "" });
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Tell the thread the comment is on the release's issue, with its link."
class RecordIssueComment implements Step<MutationResult<CreatedIssueComment>> {
  private readonly flow: ReleaseDigestFlow;

  public constructor(flow: ReleaseDigestFlow) {
    this.flow = flow;
  }

  public getStepType(): string {
    return "RecordIssueComment";
  }

  public execute(context: Context, result: MutationResult<CreatedIssueComment>): StepDecision {
    const current = outboxCurrent.get(context);
    const number = current?.kind === "comment" ? current.releaseNumber : -1;
    const url = result.value?.url;
    const text = url ? `Added the note to release ${number}'s issue: <${url}|comment>.` : `Added the note to release ${number}'s issue.`;
    return goTo(this.flow.postThreadNote, { text, threadTs: digestState.get(context)?.slackThreadTs ?? "" });
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Tell the thread GitHub refused or may not have applied a change to a filed issue."
class RecordIssueChangeFailure implements Step<MutationResult<unknown>> {
  public getStepType(): string {
    return "RecordIssueChangeFailure";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [outbox.lock()] };
  }

  public execute(context: Context, result: MutationResult<unknown>): StepDecision {
    const current = outboxCurrent.get(context);
    const number = current && "releaseNumber" in current ? current.releaseNumber : -1;
    const what = current?.kind === "comment" ? "add the note to" : "relabel";
    const reason = result.branch === "uncertain" ? "GitHub may have applied it; check the issue before asking again" : `GitHub answered ${result.branch}`;
    outbox.set(context, [{ kind: "note", text: `Could not ${what} release ${number}'s issue: ${reason}.` }, ...(outbox.get(context) ?? [])]);
    return goTo(ProcessOutbox, {});
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Keep the release tracked when GitHub would not close its issue, and tell the thread."
class RecordCloseFailure implements Step<MutationResult<UpdatedIssueState>> {
  public getStepType(): string {
    return "RecordCloseFailure";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestReleases.lock(), outbox.lock()] };
  }

  public execute(context: Context, result: MutationResult<UpdatedIssueState>): StepDecision {
    const current = outboxCurrent.get(context);
    const number = current?.kind === "close" ? current.releaseNumber : -1;
    digestReleases.set(
      context,
      (digestReleases.get(context) ?? []).map((release) => (release.number === number ? { ...release, status: "tracked" as const } : release)),
    );
    outbox.set(context, [{ kind: "note", text: `Could not close the issue of release ${number}: GitHub answered ${result.branch}. It stays tracked.` }, ...(outbox.get(context) ?? [])]);
    return goTo(ProcessOutbox, {});
  }
}

// dex:group group-id:outbox group-label:"Outbox"
// dex:explanation text:"Record that GitHub refused or may not have filed the issue, and tell the thread."
class RecordIssueFailure implements Step<MutationResult<CreatedIssue>> {
  public getStepType(): string {
    return "RecordIssueFailure";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [digestReleases.lock(), outbox.lock()] };
  }

  public execute(context: Context, result: MutationResult<CreatedIssue>): StepDecision {
    const current = outboxCurrent.get(context);
    const number = current?.kind === "issue" ? current.releaseNumber : -1;
    const reason = result.branch === "uncertain" ? "GitHub may have filed it; check the repository before tracking it again" : `GitHub answered ${result.branch}`;
    digestReleases.set(
      context,
      (digestReleases.get(context) ?? []).map((release) => (release.number === number ? { ...release, status: "failed", note: reason } : release)),
    );
    outbox.set(context, [{ kind: "note", text: `Could not file release ${number}: ${reason}.` }, ...(outbox.get(context) ?? [])]);
    return goTo(ProcessOutbox, {});
  }
}

/** One triage decision of the agent: track a release at a priority. */
export interface TrackRequest {
  readonly number: number;
  readonly priority?: Priority;
  /** The person confirmed filing a no-change release, which a plain "track" does not file. */
  readonly confirmed?: boolean;
}

/** Candidates the analyst reported in no release: the noise it skipped. */
function skippedCandidateCount(candidates: readonly Candidate[], releases: readonly DigestRelease[]): number {
  const covered = new Set(releases.flatMap((release) => release.candidateKeys));
  return candidates.filter((candidate) => !covered.has(candidate.key)).length;
}

/** What a triage RPC did with each release. */
export interface TriageOutcome {
  readonly applied: readonly number[];
  readonly refused: readonly { readonly number: number; readonly reason: string }[];
  readonly duplicate: boolean;
}

/** What searchCandidates answers. */
export interface CandidateSearch {
  readonly total: number;
  readonly candidates: readonly {
    readonly title: string;
    readonly url: string;
    readonly library?: string;
    readonly sourceId: string;
    readonly publishedAt?: string;
    readonly engagement?: number;
    readonly summary?: string;
    /** Whether the analyst put it in the digest. */
    readonly inDigest: boolean;
  }[];
}

/** The digest as the triage agent sees it. */
export interface TriageView {
  readonly digestId: string;
  readonly status: DigestStatus;
  /** RFC 3339: the digest covers what appeared after this. */
  readonly windowStart: string;
  /** How the collection went: sources read, sources that failed and why, sources skipped, candidates found. */
  readonly health: { readonly sourceCount: number; readonly sourceErrors: readonly string[]; readonly skippedSources: readonly string[]; readonly candidateCount: number; readonly unanalyzed: boolean };
  readonly releases: readonly Pick<DigestRelease, "number" | "title" | "library" | "actionability" | "category" | "relevance" | "suggestedPriority" | "status" | "priority" | "issueUrl" | "summary" | "impact" | "url">[];
}

/**
 * One digest: read every watched source, have the analyst agent judge the
 * candidates, post the result to Slack, then keep the thread open for the
 * triage agent, whose decisions queue GitHub issues and thread notes.
 * FlowID release-digest-<date>, from the schedule.
 */
export class ReleaseDigestFlow implements Flow<DigestStartInput> {
  private readonly startDigestRun = new StartDigestRun();
  private readonly collectNextSource: CollectNextSource;
  private readonly recordGitHubReleases = new RecordGitHubReleases();
  private readonly recordFeedItems = new RecordFeedItems();
  private readonly recordSitemapEntries = new RecordSitemapEntries();
  private readonly recordStorySearch = new RecordStorySearch();
  public readonly readFeed;
  public readonly readSitemap;
  public readonly searchStories;
  private readonly queueHackerNewsStories = new QueueHackerNewsStories();
  private readonly readNextHackerNewsStory: ReadNextHackerNewsStory;
  private readonly recordHackerNewsStory = new RecordHackerNewsStory();
  private readonly recordSourceFailure = new RecordSourceFailure();
  public readonly recordSourceSkipped = new RecordSourceSkipped();
  public readonly mergeCandidatesStep: MergeCandidates;
  private readonly startAnalystSession: StartAnalystSession;
  private readonly awaitAnalystReport = new AwaitAnalystReport();
  private readonly postDigestHeadline;
  private readonly recordDigestHeadline = new RecordDigestHeadline();
  private readonly postNextDetail: PostNextDetail;
  public readonly postDigestDetail;
  private readonly recordDigestDetail = new RecordDigestDetail();
  private readonly recordSlackFailure = new RecordSlackFailure();
  private readonly startTriageSession: StartTriageSession;
  private readonly awaitTriageWindow = new AwaitTriageWindow();
  private readonly processOutbox: ProcessOutbox;
  public readonly postThreadNote;
  private readonly recordThreadNote = new RecordThreadNote();
  private readonly recordReleaseIssue: RecordReleaseIssue;
  private readonly recordIssueFailure = new RecordIssueFailure();
  private readonly recordIssueClosed: RecordIssueClosed;
  private readonly recordCloseFailure = new RecordCloseFailure();
  public readonly closeReleaseIssue;
  private readonly recordIssueRelabeled: RecordIssueRelabeled;
  private readonly recordIssueComment: RecordIssueComment;
  private readonly recordIssueChangeFailure = new RecordIssueChangeFailure();
  public readonly relabelReleaseIssue;
  public readonly commentOnReleaseIssue;
  public readonly createReleaseIssue;
  public readonly listReleases;
  public readonly listStoryIds;
  public readonly getStory;

  public constructor(dependencies: DigestDependencies) {
    this.collectNextSource = new CollectNextSource(this);
    this.readNextHackerNewsStory = new ReadNextHackerNewsStory(this);
    this.mergeCandidatesStep = new MergeCandidates(dependencies);
    this.startAnalystSession = new StartAnalystSession(dependencies);
    this.postNextDetail = new PostNextDetail(this);
    this.startTriageSession = new StartTriageSession(dependencies);
    this.processOutbox = new ProcessOutbox(this);
    this.recordReleaseIssue = new RecordReleaseIssue(this);
    this.recordIssueClosed = new RecordIssueClosed(this);
    this.recordIssueRelabeled = new RecordIssueRelabeled(this);
    this.recordIssueComment = new RecordIssueComment(this);
    this.relabelReleaseIssue = newReplaceIssueLabelsStep<{ readonly releaseNumber: number; readonly issueNumber: number; readonly labels: readonly string[] }>({
      stepType: "RelabelReleaseIssue",
      annotations: { groupId: "outbox", groupLabel: "Outbox", explanation: "Replace the issue's labels so its priority label matches the release's new priority." },
      connectionName: GITHUB_ISSUES_CONNECTION,
      connection: dependencies.githubIssues,
      inputCodec: relabelRequestCodec,
      mapToOperationInput: (input) => ({ ...dependencies.issueRepository, issueNumber: input.issueNumber, labels: [...input.labels] }),
      replaced: this.recordIssueRelabeled,
      insufficientScope: this.recordIssueChangeFailure,
      authorizationRevoked: this.recordIssueChangeFailure,
      notFound: this.recordIssueChangeFailure,
      providerRejected: this.recordIssueChangeFailure,
      invalidResponse: this.recordIssueChangeFailure,
      defect: this.recordIssueChangeFailure,
    });
    this.commentOnReleaseIssue = newCreateIssueCommentStep<{ readonly releaseNumber: number; readonly issueNumber: number; readonly body: string }>({
      stepType: "CommentOnReleaseIssue",
      annotations: { groupId: "outbox", groupLabel: "Outbox", explanation: "Add a note from the thread to the release's issue as a comment." },
      connectionName: GITHUB_ISSUES_CONNECTION,
      connection: dependencies.githubIssues,
      inputCodec: commentRequestCodec,
      mapToOperationInput: (input) => ({ ...dependencies.issueRepository, issueNumber: input.issueNumber, body: input.body }),
      created: this.recordIssueComment,
      insufficientScope: this.recordIssueChangeFailure,
      authorizationRevoked: this.recordIssueChangeFailure,
      notFound: this.recordIssueChangeFailure,
      providerRejected: this.recordIssueChangeFailure,
      uncertain: this.recordIssueChangeFailure,
      defect: this.recordIssueChangeFailure,
    });
    this.closeReleaseIssue = newSetIssueStateStep<{ readonly releaseNumber: number; readonly issueNumber: number }>({
      stepType: "CloseReleaseIssue",
      annotations: { groupId: "outbox", groupLabel: "Outbox", explanation: "Close the GitHub issue of an untracked release as not planned." },
      connectionName: GITHUB_ISSUES_CONNECTION,
      connection: dependencies.githubIssues,
      inputCodec: closeRequestCodec,
      mapToOperationInput: (input) => ({ ...dependencies.issueRepository, issueNumber: input.issueNumber, state: IssueStateClosed, stateReason: IssueStateReasonNotPlanned }),
      updated: this.recordIssueClosed,
      insufficientScope: this.recordCloseFailure,
      authorizationRevoked: this.recordCloseFailure,
      notFound: this.recordCloseFailure,
      providerRejected: this.recordCloseFailure,
      invalidResponse: this.recordCloseFailure,
      defect: this.recordCloseFailure,
    });
    this.createReleaseIssue = newCreateIssueStep<IssueRequest>({
      stepType: "CreateReleaseIssue",
      annotations: { groupId: "outbox", groupLabel: "Outbox", explanation: "File the tracked release as an issue with its priority, category and library labels." },
      connectionName: GITHUB_ISSUES_CONNECTION,
      connection: dependencies.githubIssues,
      inputCodec: issueRequestCodec,
      mapToOperationInput: (input) => ({ ...dependencies.issueRepository, title: input.title, body: input.body, labels: [...input.labels] }),
      created: this.recordReleaseIssue,
      insufficientScope: this.recordIssueFailure,
      authorizationRevoked: this.recordIssueFailure,
      notFound: this.recordIssueFailure,
      providerRejected: this.recordIssueFailure,
      uncertain: this.recordIssueFailure,
      defect: this.recordIssueFailure,
    });
    this.listReleases = newListReleasesStep<{ readonly owner: string; readonly repository: string; readonly pageSize?: number }>({
      stepType: "ListGitHubReleases",
      annotations: { groupId: "collect", groupLabel: "Collect", explanation: "Read the newest releases of one watched repository through the GitHub API, 40 unless the source asks for fewer." },
      connectionName: GITHUB_CONNECTION,
      connection: dependencies.github,
      inputCodec: repositoryCodec,
      mapToOperationInput: (input) => ({ owner: input.owner, repository: input.repository, pageSize: input.pageSize ?? RELEASE_PAGE_SIZE, maxBodyCharacters: 2_000 }),
      listed: this.recordGitHubReleases,
      notFound: this.recordSourceFailure,
      insufficientScope: this.recordSourceFailure,
      authorizationRevoked: this.recordSourceFailure,
      providerRejected: this.recordSourceFailure,
      invalidResponse: this.recordSourceFailure,
      defect: this.recordSourceFailure,
    });
    this.readFeed = newReadFeedStep<{ readonly url: string }>({
      stepType: "ReadBlogFeed",
      annotations: { groupId: "collect", groupLabel: "Collect", explanation: "Read the newest posts of one watched blog feed." },
      connectionName: WEB_FEED_CONNECTION,
      connection: dependencies.webFeed,
      inputCodec: feedRequestCodec,
      mapToOperationInput: (input) => ({ url: input.url, limit: 30, maxSummaryCharacters: 800 }),
      read: this.recordFeedItems,
      notModified: this.recordFeedItems,
      notFound: this.recordSourceFailure,
      providerRejected: this.recordSourceFailure,
      unreachable: this.recordSourceFailure,
      invalidResponse: this.recordSourceFailure,
      defect: this.recordSourceFailure,
    });
    this.readSitemap = newReadSitemapStep<{ readonly url: string; readonly pathPrefix: string; readonly since: string }>({
      stepType: "ReadBlogSitemap",
      annotations: { groupId: "collect", groupLabel: "Collect", explanation: "Read the blog posts a watched sitemap lists as changed in the digest window." },
      connectionName: WEB_FEED_CONNECTION,
      connection: dependencies.webFeed,
      inputCodec: sitemapRequestCodec,
      mapToOperationInput: (input) => ({ url: input.url, pathPrefix: input.pathPrefix, lastModifiedAfter: input.since || null, limit: 50 }),
      read: this.recordSitemapEntries,
      notModified: this.recordSitemapEntries,
      notFound: this.recordSourceFailure,
      providerRejected: this.recordSourceFailure,
      unreachable: this.recordSourceFailure,
      invalidResponse: this.recordSourceFailure,
      defect: this.recordSourceFailure,
    });
    this.searchStories = newSearchStoriesStep<{ readonly query: string; readonly since: string }>({
      stepType: "SearchHackerNews",
      annotations: { groupId: "collect", groupLabel: "Collect", explanation: "Search Hacker News stories of the digest window for one watched term." },
      connectionName: HACKER_NEWS_CONNECTION,
      connection: dependencies.hackerNews,
      inputCodec: searchRequestCodec,
      mapToOperationInput: (input) => ({ query: input.query, sortBy: "date", createdAfter: input.since || undefined, hitsPerPage: 30 }),
      searched: this.recordStorySearch,
      providerRejected: this.recordSourceFailure,
      invalidResponse: this.recordSourceFailure,
      defect: this.recordSourceFailure,
    });
    this.listStoryIds = newListStoryIDsStep<{ readonly feed: string; readonly limit: number }>({
      stepType: "ListHackerNewsStories",
      annotations: { groupId: "collect", groupLabel: "Collect", explanation: "Read the story IDs at the top of one Hacker News feed." },
      connectionName: HACKER_NEWS_CONNECTION,
      connection: dependencies.hackerNews,
      inputCodec: feedCodec,
      mapToOperationInput: (input) => ({ feed: input.feed, limit: input.limit }),
      listed: this.queueHackerNewsStories,
      providerRejected: this.recordSourceFailure,
      invalidResponse: this.recordSourceFailure,
      defect: this.recordSourceFailure,
    });
    this.getStory = newGetItemStep<{ readonly id: number }>({
      stepType: "GetHackerNewsStory",
      annotations: { groupId: "collect", groupLabel: "Collect", explanation: "Read one queued Hacker News story." },
      connectionName: HACKER_NEWS_CONNECTION,
      connection: dependencies.hackerNews,
      inputCodec: storyCodec,
      mapToOperationInput: (input) => ({ id: input.id }),
      found: this.recordHackerNewsStory,
      notFound: this.recordHackerNewsStory,
      providerRejected: this.recordHackerNewsStory,
      invalidResponse: this.recordHackerNewsStory,
      defect: this.recordHackerNewsStory,
    });
    this.postDigestHeadline = newPostChannelMessageStep<{ readonly text: string }>({
      stepType: "PostDigestHeadline",
      annotations: { groupId: "post", groupLabel: "Post", explanation: "Post the digest's top-level message with the highlights." },
      connectionName: SLACK_CONNECTION,
      connection: dependencies.slack,
      inputCodec: messageCodec,
      mapToOperationInput: (input) => ({ channelId: dependencies.slackChannelId, text: input.text }),
      sent: this.recordDigestHeadline,
      providerRejected: this.recordSlackFailure,
      uncertain: this.recordSlackFailure,
      defect: this.recordSlackFailure,
    });
    this.postDigestDetail = newPostThreadReplyStep<ThreadMessage>({
      stepType: "PostDigestDetail",
      annotations: { groupId: "post", groupLabel: "Post", explanation: "Post one message of the rest of the digest in its thread." },
      connectionName: SLACK_CONNECTION,
      connection: dependencies.slack,
      inputCodec: threadMessageCodec,
      mapToOperationInput: (input) => ({ channelId: dependencies.slackChannelId, threadTimestamp: input.threadTs, text: input.text }),
      sent: this.recordDigestDetail,
      providerRejected: this.recordSlackFailure,
      uncertain: this.recordSlackFailure,
      defect: this.recordSlackFailure,
    });
    this.postThreadNote = newPostThreadReplyStep<ThreadMessage>({
      stepType: "PostThreadNote",
      annotations: { groupId: "outbox", groupLabel: "Outbox", explanation: "Post a triage note in the digest's thread." },
      connectionName: SLACK_CONNECTION,
      connection: dependencies.slack,
      inputCodec: threadMessageCodec,
      mapToOperationInput: (input) => ({ channelId: dependencies.slackChannelId, threadTimestamp: input.threadTs, text: input.text }),
      sent: this.recordThreadNote,
      providerRejected: this.recordThreadNote,
      uncertain: this.recordThreadNote,
      defect: this.recordThreadNote,
    });
  }

  public getFlowType(): string {
    return "ReleaseDigestFlow";
  }

  public getSteps(): StepList<DigestStartInput> {
    return StepList.startStep(this.startDigestRun).otherSteps(
      this.collectNextSource,
      this.listReleases,
      this.recordGitHubReleases,
      this.readFeed,
      this.recordFeedItems,
      this.readSitemap,
      this.recordSitemapEntries,
      this.searchStories,
      this.recordStorySearch,
      this.listStoryIds,
      this.queueHackerNewsStories,
      this.readNextHackerNewsStory,
      this.getStory,
      this.recordHackerNewsStory,
      this.recordSourceFailure,
      this.recordSourceSkipped,
      this.mergeCandidatesStep,
      this.startAnalystSession,
      this.awaitAnalystReport,
      this.postDigestHeadline,
      this.recordDigestHeadline,
      this.postNextDetail,
      this.postDigestDetail,
      this.recordDigestDetail,
      this.recordSlackFailure,
      this.startTriageSession,
      this.awaitTriageWindow,
      this.processOutbox,
      this.postThreadNote,
      this.recordThreadNote,
      this.createReleaseIssue,
      this.recordReleaseIssue,
      this.recordIssueFailure,
      this.closeReleaseIssue,
      this.recordIssueClosed,
      this.recordCloseFailure,
      this.relabelReleaseIssue,
      this.recordIssueRelabeled,
      this.commentOnReleaseIssue,
      this.recordIssueComment,
      this.recordIssueChangeFailure,
    );
  }

  public getPersistenceSchema(): PersistenceSchema {
    return {
      attributes: [
        digestState,
        digestCandidates,
        digestReleases,
        analystReport,
        sourceCursor,
        storyQueue,
        detailMessages,
        detailCursor,
        outbox,
        outboxCurrent,
        outboxActive,
        handledRequests,
        digestSources,
      ],
      channels: [reportSubmitted],
    };
  }

  /** The Slack binding Dex Web configures: the digest channel and who may triage in its threads. */
  public getConnectorTriggerBindings() {
    return [
      defineThreadReplyCreatedTriggerBinding({
        connectionName: SLACK_CONNECTION,
        bindingName: SLACK_REPLY_BINDING,
        configurationUI: {
          units: [
            {
              id: "channel",
              unitId: "channelPicker",
              label: "Digest channel",
              description: "Select the joined Slack channel where Release Watch posts each digest and reads triage replies in its threads.",
              required: true,
              bindings: [{ port: "channelId", jsonPointer: "/channelId" }],
            },
            {
              id: "triagers",
              unitId: "memberPicker",
              label: "Members who may triage",
              description: "Select the workspace members whose thread replies can track or dismiss releases; replies from anyone else are ignored.",
              required: true,
              bindings: [{ port: "memberIds", jsonPointer: "/threadReplyMatcher/posterUserIds" }],
            },
          ],
        },
      }),
    ];
  }

  /** The analyst's report: validated here so the agent sees what to fix. */
  public submitAnalystReport(context: Context, report: unknown): RPCResult<{ readonly accepted: boolean; readonly error?: string }> {
    let decoded: AnalystReport;
    try {
      decoded = decodeAnalystReport(report);
    } catch (error) {
      return { output: { accepted: false, error: String(error) } };
    }
    if (digestState.get(context)?.status !== "analyzing") {
      return { output: { accepted: false, error: "the digest stopped waiting for a report: it has already posted; stop and do not submit again" } };
    }
    const candidates = new Set((digestCandidates.get(context) ?? []).map((candidate) => candidate.key));
    const unknown = decoded.releases.flatMap((release) => release.candidateKeys.filter((key) => !candidates.has(key)));
    if (unknown.length > 0) {
      return { output: { accepted: false, error: `unknown candidate keys: ${unknown.slice(0, 10).join(", ")}; cite only keys from the brief` } };
    }
    const pinnedByKey = new Map((digestCandidates.get(context) ?? []).map((candidate) => [candidate.key, candidate.pinned] as const));
    const withPins: AnalystReport = {
      releases: decoded.releases.map((release) => {
        const pinned = release.candidateKeys.map((key) => pinnedByKey.get(key)).find((value) => value !== undefined);
        return pinned ? { ...release, pinned } : release;
      }),
    };
    reportSubmitted.publish(context, withPins);
    return { output: { accepted: true } };
  }

  /** The digest's releases and their triage status. */
  public getTriageView(context: Context): RPCResult<TriageView> {
    const state = digestState.get(context);
    const releases = (digestReleases.get(context) ?? []).map(({ number, title, library, actionability, category, relevance, suggestedPriority, status, priority, issueUrl, summary, impact, url }) => ({
      number,
      title,
      library,
      actionability: actionability ?? tierOf({}),
      category,
      relevance,
      suggestedPriority,
      status,
      priority,
      issueUrl,
      summary,
      impact,
      url,
    }));
    return {
      output: {
        digestId: state?.digestId ?? "",
        status: state?.status ?? "failed",
        windowStart: state?.windowStart ?? "",
        health: {
          sourceCount: state?.sourceCount ?? 0,
          sourceErrors: state?.sourceErrors ?? [],
          skippedSources: state?.skippedSources ?? [],
          candidateCount: state?.candidateCount ?? 0,
          unanalyzed: state?.unanalyzed ?? false,
        },
        releases,
      },
    };
  }

  /** Queues a GitHub issue for each release at its priority; requestKey de-duplicates a retried tool call. */
  public trackReleases(context: Context, request: { readonly requestKey: string; readonly releases: readonly TrackRequest[] }): RPCResult<TriageOutcome> {
    const handled = handledRequests.get(context) ?? [];
    if (handled.includes(request.requestKey)) {
      return { output: { applied: [], refused: [], duplicate: true } };
    }
    const releases = digestReleases.get(context) ?? [];
    const applied: number[] = [];
    const refused: { number: number; reason: string }[] = [];
    const updated = [...releases];
    const queued: OutboxEntry[] = [];
    for (const item of request.releases) {
      const index = updated.findIndex((release) => release.number === item.number);
      const release = updated[index];
      if (release === undefined) {
        refused.push({ number: item.number, reason: "no release has this number" });
      } else if (release.status === "tracking" || release.status === "tracked") {
        refused.push({ number: item.number, reason: `already ${release.status}${release.issueUrl ? ` (${release.issueUrl})` : ""}` });
      } else if (!ISSUE_TIERS.includes(tierOf(release)) && item.confirmed !== true) {
        refused.push({
          number: item.number,
          reason: `it is a ${tierOf(release)} item, which does not become an issue by default; ask the person to confirm, then track it again with confirmed, or move it to another tier`,
        });
      } else {
        updated[index] = { ...release, status: "tracking", priority: item.priority ?? release.suggestedPriority };
        queued.push({ kind: "issue", releaseNumber: item.number });
        applied.push(item.number);
      }
    }
    digestReleases.set(context, updated);
    handledRequests.set(context, [...handled, request.requestKey].slice(-HANDLED_REQUEST_LIMIT));
    return this.enqueue(context, queued, { applied, refused, duplicate: false });
  }

  /** Marks releases dismissed with a reason; nothing is filed. */
  public dismissReleases(context: Context, request: { readonly requestKey: string; readonly numbers: readonly number[]; readonly reason: string }): RPCResult<TriageOutcome> {
    const handled = handledRequests.get(context) ?? [];
    if (handled.includes(request.requestKey)) {
      return { output: { applied: [], refused: [], duplicate: true } };
    }
    const applied: number[] = [];
    const refused: { number: number; reason: string }[] = [];
    const updated = (digestReleases.get(context) ?? []).map((release) => {
      if (!request.numbers.includes(release.number)) {
        return release;
      }
      if (release.status === "tracking" || release.status === "tracked") {
        refused.push({ number: release.number, reason: `already ${release.status}; untrack it first to close its issue` });
        return release;
      }
      applied.push(release.number);
      return { ...release, status: "dismissed" as const, note: request.reason };
    });
    for (const number of request.numbers) {
      if (!updated.some((release) => release.number === number)) {
        refused.push({ number, reason: "no release has this number" });
      }
    }
    digestReleases.set(context, updated);
    handledRequests.set(context, [...handled, request.requestKey].slice(-HANDLED_REQUEST_LIMIT));
    return { output: { applied, refused, duplicate: false } };
  }

  /**
   * Every candidate the digest collected, whether or not the analyst put it in
   * the digest, matching each word of the query in title, library, source, URL or
   * summary; newest first.
   */
  public searchCandidates(context: Context, request: { readonly query?: string; readonly limit?: number }): RPCResult<CandidateSearch> {
    const reported = new Set((digestReleases.get(context) ?? []).flatMap((release) => release.candidateKeys));
    const words = (request.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (digestCandidates.get(context) ?? [])
      .filter((candidate) => {
        const text = `${candidate.title} ${candidate.library ?? ""} ${candidate.sourceId} ${candidate.url} ${candidate.summary ?? ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    const limit = Math.min(Math.max(1, Math.trunc(request.limit ?? 15)), 40);
    return {
      output: {
        total: matches.length,
        candidates: matches.slice(0, limit).map((candidate) => ({
          title: candidate.title,
          url: candidate.url,
          library: candidate.library,
          sourceId: candidate.sourceId,
          publishedAt: candidate.publishedAt,
          engagement: candidate.engagement,
          summary: candidate.summary?.slice(0, 300),
          inDigest: reported.has(candidate.key),
        })),
      },
    };
  }

  /** Closes the GitHub issues of tracked releases as not planned and puts the releases back to open. */
  public untrackReleases(context: Context, request: { readonly requestKey: string; readonly numbers: readonly number[]; readonly reason: string }): RPCResult<TriageOutcome> {
    const handled = handledRequests.get(context) ?? [];
    if (handled.includes(request.requestKey)) {
      return { output: { applied: [], refused: [], duplicate: true } };
    }
    const applied: number[] = [];
    const refused: { number: number; reason: string }[] = [];
    const queued: OutboxEntry[] = [];
    const releases = digestReleases.get(context) ?? [];
    const updated = releases.map((release) => {
      if (!request.numbers.includes(release.number)) {
        return release;
      }
      if (release.status === "tracking") {
        refused.push({ number: release.number, reason: "its issue is still being filed; ask again in a moment" });
        return release;
      }
      if (release.status !== "tracked" || release.issueNumber === undefined) {
        refused.push({ number: release.number, reason: `it is ${release.status}, not tracked` });
        return release;
      }
      applied.push(release.number);
      queued.push({ kind: "close", releaseNumber: release.number, reason: request.reason });
      return { ...release, status: "untracking" as const };
    });
    for (const number of request.numbers) {
      if (!releases.some((release) => release.number === number)) {
        refused.push({ number, reason: "no release has this number" });
      }
    }
    digestReleases.set(context, updated);
    handledRequests.set(context, [...handled, request.requestKey].slice(-HANDLED_REQUEST_LIMIT));
    return this.enqueue(context, queued, { applied, refused, duplicate: false });
  }

  /** Changes the priority of tracked releases and relabels their issues. */
  public setReleasePriority(context: Context, request: { readonly requestKey: string; readonly releases: readonly TrackRequest[] }): RPCResult<TriageOutcome> {
    const handled = handledRequests.get(context) ?? [];
    if (handled.includes(request.requestKey)) {
      return { output: { applied: [], refused: [], duplicate: true } };
    }
    const applied: number[] = [];
    const refused: { number: number; reason: string }[] = [];
    const queued: OutboxEntry[] = [];
    const updated = [...(digestReleases.get(context) ?? [])];
    for (const item of request.releases) {
      const index = updated.findIndex((release) => release.number === item.number);
      const release = updated[index];
      if (release === undefined || item.priority === undefined) {
        refused.push({ number: item.number, reason: release === undefined ? "no release has this number" : "no priority given" });
      } else if (release.status !== "tracked" || release.issueNumber === undefined) {
        refused.push({ number: item.number, reason: release.status === "tracking" ? "its issue is still being filed; ask again in a moment" : `it is ${release.status}; track it with the priority instead` });
      } else if (release.priority === item.priority) {
        refused.push({ number: item.number, reason: `already ${item.priority}` });
      } else {
        updated[index] = { ...release, priority: item.priority };
        queued.push({ kind: "relabel", releaseNumber: item.number });
        applied.push(item.number);
      }
    }
    digestReleases.set(context, updated);
    handledRequests.set(context, [...handled, request.requestKey].slice(-HANDLED_REQUEST_LIMIT));
    return this.enqueue(context, queued, { applied, refused, duplicate: false });
  }

  /**
   * Moves releases to another tier when the person disagrees with the analyst.
   * The suggested priority is lowered to the new tier's cap; a tracked release keeps its issue and priority.
   */
  public setReleaseTier(context: Context, request: { readonly requestKey: string; readonly releases: readonly { readonly number: number; readonly actionability: Actionability }[] }): RPCResult<TriageOutcome> {
    const handled = handledRequests.get(context) ?? [];
    if (handled.includes(request.requestKey)) {
      return { output: { applied: [], refused: [], duplicate: true } };
    }
    const applied: number[] = [];
    const refused: { number: number; reason: string }[] = [];
    const updated = [...(digestReleases.get(context) ?? [])];
    for (const item of request.releases) {
      const index = updated.findIndex((release) => release.number === item.number);
      const release = updated[index];
      if (release === undefined) {
        refused.push({ number: item.number, reason: "no release has this number" });
      } else if (!(ACTIONABILITY as readonly string[]).includes(item.actionability)) {
        refused.push({ number: item.number, reason: `the tier must be one of ${ACTIONABILITY.join(", ")}` });
      } else if (tierOf(release) === item.actionability) {
        refused.push({ number: item.number, reason: `already ${item.actionability}` });
      } else {
        updated[index] = { ...release, actionability: item.actionability, suggestedPriority: capPriority(release.suggestedPriority, item.actionability) };
        applied.push(item.number);
      }
    }
    digestReleases.set(context, updated);
    handledRequests.set(context, [...handled, request.requestKey].slice(-HANDLED_REQUEST_LIMIT));
    return { output: { applied, refused, duplicate: false } };
  }

  /** Adds a note from the thread to a tracked release's issue as a comment. */
  public commentOnIssue(context: Context, request: { readonly requestKey: string; readonly number: number; readonly text: string; readonly author: string }): RPCResult<TriageOutcome> {
    const handled = handledRequests.get(context) ?? [];
    if (handled.includes(request.requestKey)) {
      return { output: { applied: [], refused: [], duplicate: true } };
    }
    const release = (digestReleases.get(context) ?? []).find((candidate) => candidate.number === request.number);
    handledRequests.set(context, [...handled, request.requestKey].slice(-HANDLED_REQUEST_LIMIT));
    if (release === undefined || release.status !== "tracked" || release.issueNumber === undefined || request.text.trim() === "") {
      const reason = release === undefined ? "no release has this number" : request.text.trim() === "" ? "the note is empty" : `it is ${release.status}, so it has no open issue`;
      return { output: { applied: [], refused: [{ number: request.number, reason }], duplicate: false } };
    }
    // A Slack mention such as <@U123> means nothing on GitHub; keep only a plain name.
    const author = /^<@[A-Z0-9]+>$/.test(request.author.trim()) ? "" : request.author.trim();
    const body = `${request.text.trim().slice(0, 4_000)}\n\n_From the Release Watch Slack thread${author ? `, ${author}` : ""}._`;
    return this.enqueue(context, [{ kind: "comment", releaseNumber: release.number, text: body }], { applied: [release.number], refused: [], duplicate: false });
  }

  /** Puts dismissed or failed releases back to open, so they can be tracked. */
  public reopenReleases(context: Context, request: { readonly requestKey: string; readonly numbers: readonly number[] }): RPCResult<TriageOutcome> {
    const handled = handledRequests.get(context) ?? [];
    if (handled.includes(request.requestKey)) {
      return { output: { applied: [], refused: [], duplicate: true } };
    }
    const applied: number[] = [];
    const refused: { number: number; reason: string }[] = [];
    const releases = digestReleases.get(context) ?? [];
    const updated = releases.map((release) => {
      if (!request.numbers.includes(release.number)) {
        return release;
      }
      if (release.status !== "dismissed" && release.status !== "failed") {
        refused.push({ number: release.number, reason: `it is ${release.status}` });
        return release;
      }
      applied.push(release.number);
      const { note: _note, ...rest } = release;
      return { ...rest, status: "open" as const };
    });
    for (const number of request.numbers) {
      if (!releases.some((release) => release.number === number)) {
        refused.push({ number, reason: "no release has this number" });
      }
    }
    digestReleases.set(context, updated);
    handledRequests.set(context, [...handled, request.requestKey].slice(-HANDLED_REQUEST_LIMIT));
    return { output: { applied, refused, duplicate: false } };
  }

  /** Queues a note in the digest's thread, such as a question or a confirmation. */
  public postNote(context: Context, request: { readonly requestKey: string; readonly text: string }): RPCResult<TriageOutcome> {
    const handled = handledRequests.get(context) ?? [];
    if (handled.includes(request.requestKey)) {
      return { output: { applied: [], refused: [], duplicate: true } };
    }
    handledRequests.set(context, [...handled, request.requestKey].slice(-HANDLED_REQUEST_LIMIT));
    return this.enqueue(context, [{ kind: "note", text: request.text.slice(0, 3_000) }], { applied: [], refused: [], duplicate: false });
  }

  /** The digest's state for the API and the page. */
  public getDigestStatus(context: Context): RPCResult<{ readonly state: DigestState | null; readonly releases: readonly DigestRelease[] }> {
    return { output: { state: digestState.get(context) ?? null, releases: digestReleases.get(context) ?? [] } };
  }

  /** Appends effects to the outbox and starts its chain when it is idle. */
  private enqueue<Output extends TriageOutcome>(context: Context, entries: readonly OutboxEntry[], output: Output): RPCResult<Output> {
    outbox.set(context, [...(outbox.get(context) ?? []), ...entries]);
    if (outboxActive.get(context) || entries.length === 0) {
      return { output };
    }
    outboxActive.set(context, true);
    return { output, nextSteps: [StepMovement.of(ProcessOutbox, {})] };
  }
}

/** Releases earlier digests posted; none when the schedule Flow does not exist, such as for a digest started by hand. */
async function readReportedReleases(dependencies: DigestDependencies): Promise<readonly ReportedReleaseRecord[]> {
  try {
    return await dependencies.clients.get().invokeRPC(dependencies.scheduleFlow().listReportedReleases, SCHEDULE_FLOW_ID);
  } catch (error) {
    if (error instanceof FlowNotActiveOrNotFoundError) {
      return [];
    }
    throw error;
  }
}

/** Remembers the posted releases on the schedule Flow, when there is one. */
async function recordReported(dependencies: DigestDependencies, records: readonly ReportedReleaseRecord[]): Promise<void> {
  try {
    await dependencies.clients.get().invokeRPC(dependencies.scheduleFlow().recordReportedReleases, SCHEDULE_FLOW_ID, records);
  } catch (error) {
    if (!(error instanceof FlowNotActiveOrNotFoundError)) {
      throw error;
    }
  }
}

function canonicalUrlKey(url: string): string {
  return canonicalUrl(url).replace(/[^a-zA-Z0-9.-]+/g, "_").slice(0, 200);
}

declareRPCMethod(ReleaseDigestFlow, "submitAnalystReport", {});
declareRPCMethod(ReleaseDigestFlow, "getTriageView", {});
declareRPCMethod(ReleaseDigestFlow, "trackReleases", { lockAttributes: [digestReleases.lock(), handledRequests.lock(), outbox.lock(), outboxActive.lock()] });
declareRPCMethod(ReleaseDigestFlow, "dismissReleases", { lockAttributes: [digestReleases.lock(), handledRequests.lock()] });
declareRPCMethod(ReleaseDigestFlow, "searchCandidates", {});
declareRPCMethod(ReleaseDigestFlow, "untrackReleases", { lockAttributes: [digestReleases.lock(), handledRequests.lock(), outbox.lock(), outboxActive.lock()] });
declareRPCMethod(ReleaseDigestFlow, "setReleasePriority", { lockAttributes: [digestReleases.lock(), handledRequests.lock(), outbox.lock(), outboxActive.lock()] });
declareRPCMethod(ReleaseDigestFlow, "setReleaseTier", { lockAttributes: [digestReleases.lock(), handledRequests.lock()] });
declareRPCMethod(ReleaseDigestFlow, "commentOnIssue", { lockAttributes: [handledRequests.lock(), outbox.lock(), outboxActive.lock()] });
declareRPCMethod(ReleaseDigestFlow, "reopenReleases", { lockAttributes: [digestReleases.lock(), handledRequests.lock()] });
declareRPCMethod(ReleaseDigestFlow, "postNote", { lockAttributes: [handledRequests.lock(), outbox.lock(), outboxActive.lock()] });
declareRPCMethod(ReleaseDigestFlow, "getDigestStatus", {});

/** The sources of this digest run; a digest started without its own sources reads the built-in watchlist. */
function sourcesOf(context: Context): readonly WatchedSource[] {
  return digestSources.get(context) ?? WATCHLIST;
}
