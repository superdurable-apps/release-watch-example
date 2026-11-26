import {
  Attribute,
  AttributeMap,
  Channel,
  ExecuteFailure,
  StepList,
  StepMovement,
  StepRef,
  Timer,
  Wait,
  deadEnd,
  declareRPCMethod,
  forceFail,
  goTo,
  goToMany,
  jsonCodec,
  stringCodec,
  type AsyncContext,
  type Context,
  type Flow,
  type PersistenceSchema,
  type RPCResult,
  type Step,
  type StepDecision,
  type StepOptions,
} from "@superdurable/dex";

import type { DexClientHolder } from "./dex-client-holder.ts";
import type { ReleaseDigestFlow, DigestStartInput } from "./release-digest-flow.ts";
import { DEFAULT_SCHEDULE, localDate, nextOccurrence, validateSchedule, type DigestSchedule } from "./schedule-time.ts";
import { WATCHLIST, validateWatchedSource, type WatchedSource } from "./watchlist.ts";

/** The one schedule of the application. */
export const SCHEDULE_FLOW_ID = "release-watch";

/** How long a reported release keeps a later digest from reporting it again. */
const REPORTED_RETENTION_DAYS = 90;
/** How far back the first digest, which has no earlier one, looks. */
const FIRST_DIGEST_LOOKBACK_HOURS = 72;

/** What the schedule keeps between runs. */
export interface ScheduleState {
  readonly schedule: DigestSchedule;
  /** The next scheduled run, RFC 3339. */
  readonly nextDigestAt?: string;
  /** When the latest digest started, RFC 3339; the next digest reads from here. */
  readonly lastDigestStartedAt?: string;
  readonly lastDigestId?: string;
  /** Manual runs so far, which number the manual digests' Flow IDs. */
  readonly manualRuns: number;
  /** Why the latest digest could not start, if it could not. */
  readonly lastStartError?: string;
}

/** One release an earlier digest posted, so a later one never posts it again. */
export interface ReportedReleaseRecord {
  readonly key: string;
  readonly title: string;
  readonly library: string;
  readonly url: string;
  readonly digestId: string;
  /** RFC 3339. */
  readonly reportedAt: string;
}

/** What StartDigest needs: the Client and the digest Flow, both bound after construction. */
interface ScheduleDependencies {
  readonly clients: DexClientHolder;
  readonly digestFlow: () => ReleaseDigestFlow;
}

/** A start of one digest the schedule decided. */
interface DigestOccurrence {
  readonly digestId: string;
  readonly digestDate: string;
  readonly windowStart: string;
  readonly startedAt: string;
  /** The watchlist when the digest was decided. */
  readonly sources?: readonly WatchedSource[];
}

/** Changes to the built-in watchlist that people made in Slack. */
export interface WatchlistChanges {
  readonly added: readonly WatchedSource[];
  readonly removedIds: readonly string[];
}

/** What a manual run asks for: why, and optionally how many days back to read instead of since the last digest. */
export interface DigestRunRequest {
  readonly reason: string;
  readonly windowDays?: number;
}

/** The longest window a manual run may ask for, well inside the reported-release retention. */
export const MAX_WINDOW_DAYS = 30;

export const scheduleState = new Attribute("schedule-state", jsonCodec<ScheduleState>({ typeName: "ScheduleState" }));
export const reportedReleases = new AttributeMap("reported-releases", jsonCodec<ReportedReleaseRecord>({ typeName: "ReportedReleaseRecord" }));
/** Serializes writers of reported-releases, which a whole-map RPC rewrites. */
const reportedReleasesVersion = new Attribute("reported-releases-version", stringCodec);
const runDigestNow = new Channel("run-digest-now", stringCodec);
const watchlistChanges = new Attribute("watchlist-changes", jsonCodec<WatchlistChanges>({ typeName: "WatchlistChanges" }));

const scheduleCodec = jsonCodec<DigestSchedule>({
  typeName: "DigestSchedule",
  decode: (value) => {
    const candidate = { ...DEFAULT_SCHEDULE, ...(value as Partial<DigestSchedule> | null ?? {}) };
    return { timeZone: String(candidate.timeZone), localTime: String(candidate.localTime), weekdaysOnly: candidate.weekdaysOnly !== false };
  },
});
const occurrenceCodec = jsonCodec<DigestOccurrence>({ typeName: "DigestOccurrence" });

// dex:group group-id:schedule group-label:"Schedule"
// dex:explanation text:"Validate the digest schedule and keep it for every later run."
class StartSchedule implements Step<DigestSchedule> {
  public readonly inputCodec = scheduleCodec;

  public getStepType(): string {
    return "StartSchedule";
  }

  public execute(context: Context, schedule: DigestSchedule): StepDecision {
    try {
      validateSchedule(schedule);
    } catch (error) {
      return forceFail(String(error));
    }
    scheduleState.set(context, { schedule, manualRuns: 0 });
    return goTo(AwaitNextDigest, schedule);
  }
}

// dex:group group-id:schedule group-label:"Schedule"
// dex:explanation text:"Wait for the next scheduled digest time, or for a request to run a digest now."
class AwaitNextDigest implements Step<DigestSchedule> {
  public readonly inputCodec = scheduleCodec;

  public getStepType(): string {
    return "AwaitNextDigest";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [scheduleState.lock()] };
  }

  public waitFor(_context: Context, schedule: DigestSchedule): Wait {
    return Wait.anyOf(runDigestNow.forOne(), Timer.byDuration(msUntilNextDigest(schedule), "next-digest"));
  }

  public execute(context: Context, schedule: DigestSchedule): StepDecision {
    const state = scheduleState.get(context) ?? { schedule, manualRuns: 0 };
    const now = new Date();
    // A manual request that arrived with the Timer still counts: the Channel is checked first.
    const requests = runDigestNow.results(context);
    const manual = requests.length > 0;
    const request = manual ? decodeRunRequest(requests[requests.length - 1]!) : undefined;
    const date = localDate(now, schedule.timeZone);
    const manualRuns = manual ? state.manualRuns + 1 : state.manualRuns;
    const digestId = manual ? `release-digest-${date}-run-${manualRuns}` : `release-digest-${date}`;
    const lookback = new Date(now.getTime() - FIRST_DIGEST_LOOKBACK_HOURS * 3_600_000).toISOString();
    const occurrence: DigestOccurrence = {
      digestId,
      digestDate: date,
      windowStart: request?.windowDays ? new Date(now.getTime() - request.windowDays * 86_400_000).toISOString() : state.lastDigestStartedAt ?? lookback,
      startedAt: now.toISOString(),
      sources: effectiveWatchlist(watchlistChanges.get(context)),
    };
    scheduleState.set(context, {
      ...state,
      manualRuns,
      lastDigestId: digestId,
      lastDigestStartedAt: occurrence.startedAt,
      nextDigestAt: nextOccurrence(now, schedule).at.toISOString(),
    });
    return goToMany(StepMovement.of(StartDigest, occurrence), StepMovement.of(AwaitNextDigest, schedule));
  }
}

// dex:group group-id:digest group-label:"Digest"
// dex:explanation text:"Start the digest run of this occurrence, once, by its Flow ID."
class StartDigest implements Step<DigestOccurrence> {
  public readonly inputCodec = occurrenceCodec;

  private readonly dependencies: ScheduleDependencies;

  public constructor(dependencies: ScheduleDependencies) {
    this.dependencies = dependencies;
  }

  public getStepType(): string {
    return "StartDigest";
  }

  public getStepOptions(): StepOptions {
    return {
      executeMethodTimeoutMs: 30_000,
      executeRetry: { maximumAttempts: 5 },
      executeFailure: ExecuteFailure.proceedTo(new StepRef("RecordDigestStartFailure")),
    };
  }

  public async execute(_context: AsyncContext, occurrence: DigestOccurrence): Promise<StepDecision> {
    const input: DigestStartInput = {
      digestId: occurrence.digestId,
      digestDate: occurrence.digestDate,
      windowStart: occurrence.windowStart,
      startedAt: occurrence.startedAt,
      ...(occurrence.sources ? { sources: occurrence.sources } : {}),
    };
    await this.dependencies.clients.get().startFlow(this.dependencies.digestFlow(), occurrence.digestId, input, {
      requestId: `start-${occurrence.digestId}`,
      ignoreAlreadyStarted: true,
    });
    return deadEnd();
  }
}

// dex:group group-id:digest group-label:"Digest"
// dex:explanation text:"Record why the digest could not start, so the schedule status shows it."
class RecordDigestStartFailure implements Step<DigestOccurrence> {
  public readonly inputCodec = occurrenceCodec;

  public getStepType(): string {
    return "RecordDigestStartFailure";
  }

  public getStepOptions(): StepOptions {
    return { executeLockAttributes: [scheduleState.lock()] };
  }

  public execute(context: Context, occurrence: DigestOccurrence): StepDecision {
    const state = scheduleState.get(context);
    if (state !== undefined) {
      scheduleState.set(context, { ...state, lastStartError: `${occurrence.digestId}: ${context.recoveryError?.detail ?? "start failed"}` });
    }
    return deadEnd();
  }
}

/** Whole seconds until the next scheduled digest, at least one: Timer durations are whole seconds. */
function msUntilNextDigest(schedule: DigestSchedule): number {
  const next = nextOccurrence(new Date(), schedule);
  return Math.max(1, Math.ceil((next.at.getTime() - Date.now()) / 1_000)) * 1_000;
}

/** What runDigestNow answers. */
export interface RunNowResult {
  readonly queued: boolean;
}

/**
 * The one long-lived schedule: it starts a ReleaseDigestFlow on every weekday
 * morning (or on request) and remembers which releases earlier digests posted.
 * FlowID release-watch.
 */
export class ReleaseWatchScheduleFlow implements Flow<DigestSchedule> {
  private readonly startSchedule = new StartSchedule();
  private readonly awaitNextDigest = new AwaitNextDigest();
  private readonly startDigest: StartDigest;
  private readonly recordDigestStartFailure = new RecordDigestStartFailure();

  public constructor(clients: DexClientHolder, digestFlow: () => ReleaseDigestFlow) {
    this.startDigest = new StartDigest({ clients, digestFlow });
  }

  public getFlowType(): string {
    return "ReleaseWatchScheduleFlow";
  }

  public getSteps(): StepList<DigestSchedule> {
    return StepList.startStep(this.startSchedule).otherSteps(this.awaitNextDigest, this.startDigest, this.recordDigestStartFailure);
  }

  public getPersistenceSchema(): PersistenceSchema {
    return { attributes: [scheduleState, reportedReleases, reportedReleasesVersion, watchlistChanges], channels: [runDigestNow] };
  }

  /** Runs a digest now, besides the scheduled ones; the reason is plain text or a JSON DigestRunRequest. */
  public requestDigestNow(context: Context, reason: string): RPCResult<RunNowResult> {
    runDigestNow.publish(context, reason || "manual");
    return { output: { queued: true } };
  }

  /** The sources the next digest reads: the built-in watchlist with the changes people made. */
  public getWatchlist(context: Context): RPCResult<readonly WatchedSource[]> {
    return { output: effectiveWatchlist(watchlistChanges.get(context)) };
  }

  /** Adds a source to every later digest; a source with an existing ID replaces it. */
  public addWatchedSource(context: Context, source: WatchedSource): RPCResult<{ readonly added: boolean; readonly error?: string }> {
    let checked: WatchedSource;
    try {
      checked = validateWatchedSource(source);
    } catch (error) {
      return { output: { added: false, error: error instanceof Error ? error.message : String(error) } };
    }
    const changes = watchlistChanges.get(context) ?? { added: [], removedIds: [] };
    watchlistChanges.set(context, {
      added: [...changes.added.filter((entry) => entry.id !== checked.id), checked],
      removedIds: changes.removedIds.filter((id) => id !== checked.id),
    });
    return { output: { added: true } };
  }

  /** Stops reading a source in later digests. */
  public removeWatchedSource(context: Context, id: string): RPCResult<{ readonly removed: boolean }> {
    const changes = watchlistChanges.get(context) ?? { added: [], removedIds: [] };
    if (!effectiveWatchlist(changes).some((source) => source.id === id)) {
      return { output: { removed: false } };
    }
    watchlistChanges.set(context, {
      added: changes.added.filter((entry) => entry.id !== id),
      removedIds: WATCHLIST.some((source) => source.id === id) ? [...new Set([...changes.removedIds, id])] : changes.removedIds,
    });
    return { output: { removed: true } };
  }

  /** The schedule, the next run and the latest digest. */
  public getScheduleStatus(context: Context): RPCResult<ScheduleState | null> {
    return { output: scheduleState.get(context) ?? null };
  }

  /** Every release posted in the retention window, which a new digest leaves out. */
  public listReportedReleases(context: Context): RPCResult<readonly ReportedReleaseRecord[]> {
    const records: ReportedReleaseRecord[] = [];
    for (const key of reportedReleases.getAllInstanceKeys(context)) {
      const record = reportedReleases.get(context, key);
      if (record !== undefined) {
        records.push(record);
      }
    }
    return { output: records };
  }

  /** Adds the releases a digest posted and drops records past the retention window. */
  public recordReportedReleases(context: Context, records: readonly ReportedReleaseRecord[]): RPCResult<number> {
    const oldest = Date.now() - REPORTED_RETENTION_DAYS * 86_400_000;
    for (const key of reportedReleases.getAllInstanceKeys(context)) {
      const record = reportedReleases.get(context, key);
      if (record === undefined || Date.parse(record.reportedAt) < oldest) {
        reportedReleases.delete(context, key);
      }
    }
    for (const record of records) {
      reportedReleases.set(context, record.key, record);
    }
    reportedReleasesVersion.set(context, new Date().toISOString());
    return { output: records.length };
  }
}

declareRPCMethod(ReleaseWatchScheduleFlow, "requestDigestNow", { inputCodec: stringCodec });
declareRPCMethod(ReleaseWatchScheduleFlow, "getScheduleStatus", {});
declareRPCMethod(ReleaseWatchScheduleFlow, "getWatchlist", {});
declareRPCMethod(ReleaseWatchScheduleFlow, "addWatchedSource", { lockAttributes: [watchlistChanges.lock()] });
declareRPCMethod(ReleaseWatchScheduleFlow, "removeWatchedSource", { inputCodec: stringCodec, lockAttributes: [watchlistChanges.lock()] });
declareRPCMethod(ReleaseWatchScheduleFlow, "listReportedReleases", { loadAttributeMaps: [reportedReleases] });
declareRPCMethod(ReleaseWatchScheduleFlow, "recordReportedReleases", {
  loadAttributeMaps: [reportedReleases],
  lockAttributes: [reportedReleasesVersion.lock()],
});

/** The built-in watchlist without removed sources, then the added ones. */
export function effectiveWatchlist(changes: WatchlistChanges | undefined): readonly WatchedSource[] {
  if (changes === undefined) {
    return WATCHLIST;
  }
  const removed = new Set(changes.removedIds);
  const added = new Set(changes.added.map((source) => source.id));
  return [...WATCHLIST.filter((source) => !removed.has(source.id) && !added.has(source.id)), ...changes.added];
}

/** A run request from the Channel: plain text is a reason; JSON may also ask for a window. */
export function decodeRunRequest(message: string): DigestRunRequest {
  try {
    const value = JSON.parse(message) as Partial<DigestRunRequest> | null;
    if (value !== null && typeof value === "object" && typeof value.reason === "string") {
      const days = Number(value.windowDays);
      return Number.isInteger(days) && days >= 1 && days <= MAX_WINDOW_DAYS ? { reason: value.reason, windowDays: days } : { reason: value.reason };
    }
  } catch {
    // Not JSON: the whole message is the reason.
  }
  return { reason: message };
}
