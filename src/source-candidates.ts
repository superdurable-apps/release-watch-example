import { canonicalUrl, type Candidate } from "./release-types.ts";
import { keepsTag, mentionsTopic, tagOfReleaseUrl, type WatchedSource } from "./watchlist.ts";

/** The fields of a GitHub release this module reads; the connector's Release has more. */
export interface GitHubReleaseLike {
  readonly tagName: string;
  readonly name?: string;
  readonly url?: string;
  readonly body?: string;
  readonly isDraft: boolean;
  readonly isPrerelease: boolean;
  readonly createdAt: string;
  readonly publishedAt?: string | null;
}

/** The fields of a Hacker News item this module reads. */
export interface HackerNewsItemLike {
  readonly id: number;
  readonly type: string;
  readonly title?: string;
  readonly url?: string;
  readonly text?: string;
  readonly discussionUrl: string;
  readonly time?: number;
  readonly score?: number;
  readonly descendants?: number;
  readonly dead?: boolean;
  readonly deleted?: boolean;
}

/** Published releases of the window; drafts never, prereleases only when they name a major feature. */
export function githubReleaseCandidates(source: WatchedSource, githubReleases: readonly GitHubReleaseLike[], windowStart: string): Candidate[] {
  const since = Date.parse(windowStart);
  const candidates: Candidate[] = [];
  for (const githubRelease of githubReleases) {
    const published = githubRelease.publishedAt ?? githubRelease.createdAt;
    if (githubRelease.isDraft || Date.parse(published) < since || !githubRelease.url || !keepsTag(source, githubRelease.tagName)) {
      continue;
    }
    candidates.push({
      key: candidateKey(source, githubRelease.url),
      title: `${source.repository} ${githubRelease.name?.trim() || githubRelease.tagName}${githubRelease.isPrerelease ? " (prerelease)" : ""}`,
      url: githubRelease.url,
      summary: plainText(githubRelease.body ?? "").slice(0, 1_200),
      publishedAt: published,
      sourceId: source.id,
      sourceKind: source.kind,
      sourceTier: source.tier,
      library: source.library,
      ...(source.pinned ? { pinned: source.pinned } : {}),
    });
  }
  return candidates;
}

/** A Hacker News story of the window whose title or text mentions the source's terms; undefined otherwise. */
export function hackerNewsCandidate(source: WatchedSource, item: HackerNewsItemLike, windowStart: string): Candidate | undefined {
  if (item.type !== "story" || item.dead || item.deleted || !item.title || item.time === undefined) {
    return undefined;
  }
  const publishedAt = new Date(item.time * 1_000).toISOString();
  const text = `${decodeEntities(item.title)} ${item.url ?? ""} ${plainText(item.text ?? "")}`;
  if (Date.parse(publishedAt) < Date.parse(windowStart) - 48 * 3_600_000 || !mentionsTopic(source, text)) {
    return undefined;
  }
  const url = item.url || item.discussionUrl;
  return {
    key: candidateKey(source, url),
    title: decodeEntities(item.title),
    url,
    discussionUrl: item.discussionUrl !== url ? item.discussionUrl : undefined,
    summary: plainText(item.text ?? "").slice(0, 600) || undefined,
    publishedAt,
    sourceId: source.id,
    sourceKind: source.kind,
    sourceTier: source.tier,
    library: source.library,
    ...(source.pinned ? { pinned: source.pinned } : {}),
    engagement: (item.score ?? 0) + (item.descendants ?? 0),
  };
}

/**
 * Merges candidates of several sources that point at one URL, keeping the
 * highest-tier source, and leaves out URLs an earlier digest reported. The
 * result is ordered for the analyst: tier, then engagement, then recency.
 */
export function mergeCandidates(candidates: readonly Candidate[], reportedUrls: ReadonlySet<string>, limit: number): Candidate[] {
  const byUrl = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const url = canonicalUrl(candidate.url);
    if (reportedUrls.has(url)) {
      continue;
    }
    const seen = byUrl.get(url);
    if (seen === undefined || candidate.sourceTier < seen.sourceTier || (candidate.engagement ?? 0) > (seen.engagement ?? 0)) {
      byUrl.set(url, seen === undefined ? candidate : { ...candidate, discussionUrl: candidate.discussionUrl ?? seen.discussionUrl, library: candidate.library ?? seen.library });
    }
  }
  return [...byUrl.values()]
    .sort((a, b) => a.sourceTier - b.sourceTier || (b.engagement ?? 0) - (a.engagement ?? 0) || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, limit);
}

/** A stable key without "/": the source ID and a short digest of the canonical URL. */
export function candidateKey(source: WatchedSource, url: string): string {
  return `${source.id}:${shortHash(canonicalUrl(url))}`;
}

/** FNV-1a, 32-bit, base 36: short, stable and dependency-free; collisions only cost a merged candidate. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The fields of a feed item this module reads. */
export interface FeedItemLike {
  readonly id: string;
  readonly title?: string;
  readonly link?: string;
  readonly publishedAt?: string | null;
  readonly updatedAt?: string | null;
  readonly summary?: string;
}

/** The fields of a sitemap entry this module reads. */
export interface SitemapEntryLike {
  readonly url: string;
  readonly lastModifiedAt?: string | null;
  readonly newsTitle?: string;
}

/** The fields of a Hacker News search hit this module reads. */
export interface StoryHitLike {
  readonly id: number;
  readonly title: string;
  readonly url?: string;
  readonly discussionUrl: string;
  readonly points: number;
  readonly commentCount: number;
  readonly createdAt: string;
  readonly storyText?: string;
}

/** Feed items of the window that mention the source's terms, when it has any. */
export function feedCandidates(source: WatchedSource, items: readonly FeedItemLike[], windowStart: string): Candidate[] {
  const since = Date.parse(windowStart);
  const candidates: Candidate[] = [];
  for (const item of items) {
    const when = item.publishedAt ?? item.updatedAt ?? undefined;
    const url = item.link || item.id;
    if (!url || !/^https?:/.test(url) || (when && Date.parse(when) < since) || !when) {
      continue;
    }
    if (source.kind === "github-releases" && !keepsTag(source, tagOfReleaseUrl(url) ?? item.title ?? "")) {
      continue;
    }
    const itemTitle = item.title?.trim() || url;
    // A release feed's items are bare tags such as v1.8.1; name the repository like githubReleaseCandidates does.
    const title = source.kind === "github-releases" && source.repository ? `${source.repository} ${itemTitle}` : itemTitle;
    if (!mentionsTopic(source, `${title} ${item.summary ?? ""}`)) {
      continue;
    }
    candidates.push({
      key: candidateKey(source, url),
      title,
      url,
      summary: plainText(item.summary ?? "").slice(0, 800) || undefined,
      publishedAt: when,
      sourceId: source.id,
      sourceKind: source.kind,
      sourceTier: source.tier,
      library: source.library,
      ...(source.pinned ? { pinned: source.pinned } : {}),
    });
  }
  return candidates;
}

/** Sitemap posts changed in the window; their title comes from the news title or the URL's last segment. */
export function sitemapCandidates(source: WatchedSource, entries: readonly SitemapEntryLike[], windowStart: string): Candidate[] {
  const since = Date.parse(windowStart);
  return entries
    .filter((entry) => entry.lastModifiedAt && Date.parse(entry.lastModifiedAt) >= since)
    .filter((entry) => !/\/(tags?|categor(y|ies)|page|authors?)(\/|$)/.test(new URL(entry.url).pathname) && new URL(entry.url).pathname.replace(/\/+$/, "") !== (source.pathPrefix ?? "").replace(/\/+$/, ""))
    .map((entry) => ({
      key: candidateKey(source, entry.url),
      title: entry.newsTitle?.trim() || titleFromSlug(entry.url),
      url: entry.url,
      summary: "Blog post found through the sitemap; only its URL and update time are known.",
      publishedAt: entry.lastModifiedAt ?? undefined,
      sourceId: source.id,
      sourceKind: source.kind,
      sourceTier: source.tier,
      library: source.library,
      ...(source.pinned ? { pinned: source.pinned } : {}),
    }));
}

/** Hacker News stories of a keyword search; the search already applied the window. */
export function storySearchCandidates(source: WatchedSource, hits: readonly StoryHitLike[]): Candidate[] {
  return hits
    .filter((hit) => hit.title)
    .map((hit) => {
      const url = hit.url || hit.discussionUrl;
      return {
        key: candidateKey(source, url),
        title: decodeEntities(hit.title),
        url,
        discussionUrl: hit.discussionUrl !== url ? hit.discussionUrl : undefined,
        summary: plainText(hit.storyText ?? "").slice(0, 600) || undefined,
        publishedAt: hit.createdAt,
        sourceId: source.id,
        sourceKind: source.kind,
        sourceTier: source.tier,
        library: source.library,
        ...(source.pinned ? { pinned: source.pinned } : {}),
        engagement: hit.points + hit.commentCount,
      };
    });
}

function titleFromSlug(url: string): string {
  const segment = new URL(url).pathname.split("/").filter(Boolean).pop() ?? url;
  const words = decodeURIComponent(segment).replace(/\.[a-z]+$/, "").replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
