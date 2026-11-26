import { jsonCodec } from "@superdurable/dex";

/** What kind of change a release is, as the analyst labels it; the GitHub label is `category:<value>`. */
export const RELEASE_CATEGORIES = [
  "breaking-change",
  "security-fix",
  "deprecation",
  "new-major-version",
  "new-feature",
  "performance",
  "bug-fix",
  "prerelease",
  "discussion",
] as const;
export type ReleaseCategory = (typeof RELEASE_CATEGORIES)[number];

/**
 * What the team should do about a release, which decides where the digest shows it and
 * whether it can become an issue. Patch releases with nothing to act on are not reported.
 * - must-fix: the application must change to keep working with the release (it removes or changes an API or
 *   behaviour the application relies on, or raises a runtime minimum), or the release fixes a vulnerability in
 *   the version the application runs;
 * - recommend: the application keeps working, but the release adds a substantial feature worth adopting;
 * - no-change: everything keeps working and there is nothing to do yet.
 */
export const ACTIONABILITY = ["must-fix", "recommend", "no-change"] as const;
export type Actionability = (typeof ACTIONABILITY)[number];
/** Tiers that become GitHub issues on a plain "track"; no-change needs the person to confirm. */
export const ISSUE_TIERS: readonly Actionability[] = ["must-fix", "recommend"];

/** The priorities; each is a GitHub label of the issue repository. */
export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** The highest priority the analyst may suggest for each tier; a person may still set any priority. */
export const TIER_PRIORITY_CAP: Readonly<Record<Actionability, Priority>> = { "must-fix": "P0", recommend: "P1", "no-change": "P3" };

/** Other names for a tier that a stored digest or a model may use, read as that tier. */
const LEGACY_TIERS: Readonly<Record<string, Actionability>> = { security: "must-fix", breaking: "must-fix", upgrade: "recommend", watch: "no-change" };

/** The tier of a release; another name counts as its tier, and an unknown one as recommend. */
export function tierOf(release: { readonly actionability?: string }): Actionability {
  const tier = release.actionability ?? "recommend";
  return (ACTIONABILITY as readonly string[]).includes(tier) ? (tier as Actionability) : (LEGACY_TIERS[tier] ?? "recommend");
}

/** The suggested priority, lowered to the tier's cap. */
export function capPriority(priority: Priority, tier: Actionability): Priority {
  const cap = TIER_PRIORITY_CAP[tier];
  return PRIORITIES.indexOf(priority) < PRIORITIES.indexOf(cap) ? cap : priority;
}

/** Where a candidate came from; tier 1 outranks tier 2 when the analyst weighs sources. */
export type SourceKind = "feed" | "sitemap" | "github-releases" | "hacker-news" | "hacker-news-feed";
export type SourceTier = 1 | 2;

/** One item a source returned, before the analyst judges it. */
export interface Candidate {
  /** Stable key: the source kind plus the canonical URL. */
  readonly key: string;
  readonly title: string;
  readonly url: string;
  /** Discussion link, such as the Hacker News thread, when it differs from url. */
  readonly discussionUrl?: string;
  readonly summary?: string;
  /** RFC 3339 publication time when the source gives one. */
  readonly publishedAt?: string;
  readonly sourceId: string;
  readonly sourceKind: SourceKind;
  readonly sourceTier: SourceTier;
  /** The watched library the source belongs to, or undefined for a topic search. */
  readonly library?: string;
  /** The version range the application is on, from the watchlist. */
  readonly pinned?: string;
  /** Points, score or comments, when the source reports them. */
  readonly engagement?: number;
}

/** One release of the analyst's report, which may merge several candidates. */
export interface ReportedRelease {
  readonly title: string;
  readonly library: string;
  /** The version range the application is on, copied from the cited candidates' watchlist entry. */
  readonly pinned?: string;
  readonly url: string;
  /** Every candidate key the release covers. */
  readonly candidateKeys: readonly string[];
  readonly category: ReleaseCategory;
  /** What the team should do about it. */
  readonly actionability?: Actionability;
  /** 0 to 100: how much the release matters to the application. */
  readonly relevance: number;
  /** One or two sentences: what changed. */
  readonly summary: string;
  /** One or two sentences: what it means for the application: what to change, or why nothing. */
  readonly impact: string;
  readonly suggestedPriority: Priority;
  readonly sources: readonly string[];
}

/** The analyst's report, which the digest posts. */
export interface AnalystReport {
  readonly releases: readonly ReportedRelease[];
}

/** What happened to one posted release. */
export type ReleaseStatus = "open" | "tracking" | "tracked" | "untracking" | "dismissed" | "failed";

/** One release as the digest posted it, numbered as Slack shows it. */
export interface DigestRelease extends ReportedRelease {
  /** 1-based number in the Slack digest. */
  readonly number: number;
  readonly highlighted: boolean;
  readonly status: ReleaseStatus;
  readonly priority?: Priority;
  readonly issueUrl?: string;
  readonly issueNumber?: number;
  readonly note?: string;
}

export const candidatesCodec = jsonCodec<readonly Candidate[]>({ typeName: "Candidates", decode: decodeCandidates });
export const analystReportCodec = jsonCodec<AnalystReport>({ typeName: "AnalystReport", decode: decodeAnalystReport });

function decodeCandidates(value: unknown): readonly Candidate[] {
  if (!Array.isArray(value)) {
    throw new TypeError("candidates must be an array");
  }
  return value as Candidate[];
}

/** Validates a report the model wrote, so a malformed one never reaches Slack or GitHub. */
export function decodeAnalystReport(value: unknown): AnalystReport {
  const report = value as Partial<AnalystReport> | null;
  if (typeof report !== "object" || report === null || !Array.isArray(report.releases)) {
    throw new TypeError("the report needs a releases array");
  }
  const releases = report.releases.map((release, index) => decodeRelease(release, index));
  return { releases };
}

function decodeRelease(value: unknown, index: number): ReportedRelease {
  const release = value as Record<string, unknown>;
  const where = `releases[${index}]`;
  const text = (field: string): string => {
    const found = release[field];
    if (typeof found !== "string" || found.trim() === "") {
      throw new TypeError(`${where}.${field} must be a non-empty string`);
    }
    return found.trim();
  };
  const category = text("category");
  if (!(RELEASE_CATEGORIES as readonly string[]).includes(category)) {
    throw new TypeError(`${where}.category must be one of ${RELEASE_CATEGORIES.join(", ")}`);
  }
  const priority = text("suggestedPriority");
  if (!(PRIORITIES as readonly string[]).includes(priority)) {
    throw new TypeError(`${where}.suggestedPriority must be one of ${PRIORITIES.join(", ")}`);
  }
  const actionability = text("actionability");
  if (!(ACTIONABILITY as readonly string[]).includes(actionability)) {
    throw new TypeError(`${where}.actionability must be one of ${ACTIONABILITY.join(", ")}`);
  }
  const relevance = release.relevance;
  if (typeof relevance !== "number" || !Number.isFinite(relevance) || relevance < 0 || relevance > 100) {
    throw new TypeError(`${where}.relevance must be a number from 0 to 100`);
  }
  const keys = release.candidateKeys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== "string")) {
    throw new TypeError(`${where}.candidateKeys must list at least one candidate key`);
  }
  const sources = Array.isArray(release.sources) ? release.sources.filter((source): source is string => typeof source === "string") : [];
  return {
    title: text("title"),
    library: text("library").toLowerCase(),
    url: text("url"),
    candidateKeys: keys as string[],
    category: category as ReleaseCategory,
    actionability: actionability as Actionability,
    relevance: Math.round(relevance),
    summary: text("summary"),
    impact: text("impact"),
    suggestedPriority: capPriority(priority as Priority, actionability as Actionability),
    sources,
  };
}

/** The canonical form of a URL for de-duplication: no fragment, tracking parameters or trailing slash. */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (/^(utm_|ref$|ref_|source$|fbclid$|gclid$)/i.test(name)) {
        url.searchParams.delete(name);
      }
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const text = url.toString();
    return text.endsWith("/") ? text.slice(0, -1) : text;
  } catch {
    return raw.trim();
  }
}
