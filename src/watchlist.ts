import type { SourceKind, SourceTier } from "./release-types.ts";

/**
 * One source the digest reads on every run. A source that stops answering fails
 * only its own read, and the digest says so.
 */
export interface WatchedSource {
  /** Stable ID, part of each candidate's key; never reuse one for another source. */
  readonly id: string;
  readonly kind: SourceKind;
  readonly tier: SourceTier;
  /** The watched library, lowercase, or undefined for a topic search. */
  readonly library?: string;
  /** The version range your application is on, such as "<0.25" or "1.2.x", so the analyst can tell an upgrade from a patch. */
  readonly pinned?: string;
  /** feed: the feed URL. sitemap: the sitemap URL. */
  readonly url?: string;
  /** sitemap: the path prefix of the posts, such as /blog/. */
  readonly pathPrefix?: string;
  /** github-releases: owner/repository. */
  readonly repository?: string;
  /**
   * github-releases: a regular expression the release tag must match. Monorepos tag every package, so this keeps
   * only the packages you use, such as ^@mastra/core@ in a repository that also releases dozens of integrations.
   */
  readonly tagPattern?: string;
  /**
   * github-releases with tagPattern: releases per page, 40 when absent. GitHub returns each release's full notes
   * and the connector refuses a response over 2 MB, so a repository with very long notes reads fewer.
   */
  readonly pageSize?: number;
  /** hacker-news: the search query. */
  readonly query?: string;
  /** hacker-news-feed: which feed to scan (top, new, best, ask, show) and how many of its stories. */
  readonly feed?: "top" | "new" | "best" | "ask" | "show";
  readonly limit?: number;
  /** Broad feeds mention many things: keep only items that mention one of these. */
  readonly mustMention?: readonly string[];
}

/**
 * An example watchlist: the libraries of the example application in team-profile.ts. Replace it with the
 * libraries in your own lockfiles, and set pinned to the range you run so the analyst can judge each release.
 * A source without tagPattern reads GitHub's public release feed, which needs no sign-in and lists the newest
 * ten releases. A source with tagPattern, for a repository that releases many packages, reads 40 through the
 * GitHub API instead, so it needs the GitHub connection that reads releases.
 */
export const WATCHLIST: readonly WatchedSource[] = [
  // Tier 1: releases of the libraries the application depends on.
  { id: "gh-openai-agents-python", kind: "github-releases", tier: 1, library: "openai-agents", pinned: ">=0.25,<0.27", repository: "openai/openai-agents-python" },
  { id: "gh-langgraph", kind: "github-releases", tier: 1, library: "langgraph", pinned: ">=1.2,<2", repository: "langchain-ai/langgraph", tagPattern: "^(\\d|prebuilt==)" },
  { id: "gh-pydantic-ai", kind: "github-releases", tier: 1, library: "pydantic-ai", pinned: ">=2.60,<3", repository: "pydantic/pydantic-ai" },
  { id: "gh-claude-agent-sdk-ts", kind: "github-releases", tier: 1, library: "claude-agent-sdk", pinned: "^0.3", repository: "anthropics/claude-agent-sdk-typescript" },
  { id: "gh-mcp-python", kind: "github-releases", tier: 1, library: "mcp", pinned: ">=2.3,<3", repository: "modelcontextprotocol/python-sdk" },
  { id: "gh-mcp-typescript", kind: "github-releases", tier: 1, library: "mcp", pinned: "^1.29", repository: "modelcontextprotocol/typescript-sdk" },
  // Tier 2: community discussion, where breaking changes and security issues often surface first.
  { id: "hn-agent-sdks", kind: "hacker-news", tier: 2, query: "agents sdk" },
  { id: "hn-mcp", kind: "hacker-news", tier: 2, library: "mcp", query: "model context protocol" },
];

/** True when an item of a filtered feed mentions one of the source's terms. */
export function mentionsTopic(source: WatchedSource, text: string): boolean {
  if (source.mustMention === undefined) {
    return true;
  }
  const lower = text.toLowerCase();
  return source.mustMention.some((term) => lower.includes(term));
}

const SOURCE_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Checks a source someone added in Slack before any digest reads it: a stable
 * ID, a kind this application reads, and the field that kind needs.
 */
export function validateWatchedSource(value: unknown): WatchedSource {
  const source = value as Partial<WatchedSource> | null;
  if (source === null || typeof source !== "object") {
    throw new TypeError("a source is an object");
  }
  if (typeof source.id !== "string" || !SOURCE_ID.test(source.id)) {
    throw new TypeError("id must be 2 to 63 lowercase letters, digits or dashes");
  }
  const tier = source.tier === 2 ? 2 : 1;
  const library = typeof source.library === "string" && source.library.trim() !== "" ? source.library.trim().toLowerCase() : undefined;
  const mustMention = Array.isArray(source.mustMention) ? source.mustMention.filter((term): term is string => typeof term === "string" && term.trim() !== "").map((term) => term.toLowerCase()) : undefined;
  const pinned = typeof source.pinned === "string" && source.pinned.trim() !== "" ? source.pinned.trim().slice(0, 80) : undefined;
  const base = { id: source.id, tier, ...(library ? { library } : {}), ...(pinned ? { pinned } : {}), ...(mustMention && mustMention.length > 0 ? { mustMention } : {}) } as const;
  switch (source.kind) {
    case "feed":
      return { ...base, kind: "feed", url: httpsUrl(source.url) };
    case "sitemap":
      return { ...base, kind: "sitemap", url: httpsUrl(source.url), pathPrefix: typeof source.pathPrefix === "string" && source.pathPrefix.startsWith("/") ? source.pathPrefix : "/" };
    case "github-releases":
      if (typeof source.repository !== "string" || !REPOSITORY.test(source.repository)) {
        throw new TypeError("repository must be owner/name");
      }
      if (source.tagPattern !== undefined) {
        if (typeof source.tagPattern !== "string" || source.tagPattern.length > 200) {
          throw new TypeError("tagPattern must be a regular expression of at most 200 characters");
        }
        new RegExp(source.tagPattern);
      }
      if (source.pageSize !== undefined && (!Number.isInteger(source.pageSize) || source.pageSize < 1 || source.pageSize > 100)) {
        throw new TypeError("pageSize must be a whole number from 1 to 100");
      }
      return {
        ...base,
        kind: "github-releases",
        repository: source.repository,
        ...(source.tagPattern ? { tagPattern: source.tagPattern } : {}),
        ...(source.pageSize ? { pageSize: source.pageSize } : {}),
      };
    case "hacker-news":
      if (typeof source.query !== "string" || source.query.trim().length < 2) {
        throw new TypeError("query must be at least two characters");
      }
      return { ...base, kind: "hacker-news", query: source.query.trim() };
    default:
      throw new TypeError("kind must be feed, sitemap, github-releases or hacker-news");
  }
}

function httpsUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("url is required");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("url must be http or https");
  }
  return url.toString();
}

/** True when a github-releases source keeps this tag: every tag without a tagPattern, else the matching ones. */
export function keepsTag(source: WatchedSource, tag: string): boolean {
  if (!source.tagPattern) {
    return true;
  }
  try {
    return new RegExp(source.tagPattern).test(tag);
  } catch {
    return true;
  }
}

/** The tag of a GitHub release page URL, such as @mastra/core@1.81.0 for .../releases/tag/%40mastra%2Fcore%401.81.0. */
export function tagOfReleaseUrl(url: string): string | undefined {
  const match = /\/releases\/tag\/([^?#]+)/.exec(url);
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return match[1];
  }
}
