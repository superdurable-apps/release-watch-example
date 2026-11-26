import { ACTIONABILITY, ISSUE_TIERS, tierOf, type Actionability, type AnalystReport, type Candidate, type DigestRelease, type ReportedRelease } from "./release-types.ts";

/** How many releases the top-level message highlights. */
export const HIGHLIGHT_COUNT = 5;
/** A release below this relevance is listed in the thread, never highlighted. */
export const HIGHLIGHT_MIN_RELEVANCE = 60;
/** Slack allows 40,000 characters; shorter messages stay readable on a phone. */
const MAX_MESSAGE_CHARS = 3_500;
/** At most this many candidates go to the analyst; the rest are the least likely releases. */
export const MAX_ANALYST_CANDIDATES = 150;

/** How each tier is headed in the digest. */
export const TIER_HEADINGS: Readonly<Record<Actionability, string>> = {
  "must-fix": "A · Must fix: the application needs a change to keep working or stay safe",
  recommend: "B · Recommended: a substantial new feature worth adopting",
  "no-change": "C · No change: everything still works",
};

/** Numbers the report's releases, most actionable tier first, then most relevant, and marks the highlights. */
export function numberReleases(report: AnalystReport): DigestRelease[] {
  const rank = (release: ReportedRelease) => ACTIONABILITY.indexOf(tierOf(release));
  const sorted = [...report.releases].sort((a, b) => rank(a) - rank(b) || b.relevance - a.relevance || a.title.localeCompare(b.title));
  let highlights = 0;
  return sorted.map((release, index) => {
    const highlighted = highlights < HIGHLIGHT_COUNT && ISSUE_TIERS.includes(tierOf(release)) && release.relevance >= HIGHLIGHT_MIN_RELEVANCE;
    if (highlighted) {
      highlights += 1;
    }
    return { ...release, number: index + 1, highlighted, status: "open" };
  });
}

/**
 * The top-level Slack message: the must-fix and recommended highlights in full, then
 * one line per tier for the rest, and how to triage.
 */
export function renderHeadline(digestDate: string, releases: readonly DigestRelease[], sourceCount: number, failedSources: number, unanalyzed: boolean, skippedCandidates = 0): string {
  const highlights = releases.filter((release) => release.highlighted);
  const lines = [`*Release Watch · ${digestDate}*  ${releases.length} item${releases.length === 1 ? "" : "s"} from ${sourceCount} sources${failedSources > 0 ? ` (${failedSources} unavailable)` : ""}${skippedCandidates > 0 ? `, ${skippedCandidates} skipped as noise` : ""}`];
  if (unanalyzed) {
    lines.push(
      `_The analyst did not finish in time: the thread lists ${releases.length} unranked candidates as no-change. Move one to another tier, or confirm it, to file it._`,
    );
  } else if (highlights.length === 0) {
    lines.push("", "Nothing to change today.");
  }
  for (const tier of ISSUE_TIERS) {
    const inTier = highlights.filter((release) => tierOf(release) === tier);
    if (inTier.length > 0) {
      lines.push("", `*${TIER_HEADINGS[tier]}*`);
    }
    for (const release of inTier) {
      lines.push(`*${release.number}. ${link(release.url, release.title)}*`, `${meta(release)}`, `> ${escape(release.summary)}`, `> *Impact:* ${escape(release.impact)}`);
    }
  }
  const counts = ACTIONABILITY.map((tier) => [tier, releases.filter((release) => !release.highlighted && tierOf(release) === tier).length] as const).filter(([, count]) => count > 0);
  if (counts.length > 0) {
    lines.push("", `In the thread: ${counts.map(([tier, count]) => `${count} ${tier}`).join(" · ")}.`);
  }
  lines.push(`Reply in the thread, e.g. \`track 1 P1\`, \`dismiss 2, we don't use that API\` or \`move 3 to must-fix\`. No-change items become issues only if you confirm.`);
  return lines.join("\n");
}

/** The thread messages: the releases that are not highlighted, grouped by tier, each at most MAX_MESSAGE_CHARS. */
export function renderDetails(releases: readonly DigestRelease[]): string[] {
  const lines: string[] = [];
  for (const tier of ACTIONABILITY) {
    const rest = releases.filter((release) => !release.highlighted && tierOf(release) === tier);
    if (rest.length === 0) {
      continue;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`*${TIER_HEADINGS[tier]}*`);
    for (const release of rest) {
      if (tier === "no-change") {
        lines.push(`*${release.number}.* ${link(release.url, release.title)} · \`${release.library}\`: ${escape(release.summary)}`);
      } else {
        lines.push(`*${release.number}.* ${link(release.url, release.title)} · ${meta(release)}`, `      ${escape(release.summary)}`, `      _Impact:_ ${escape(release.impact)}`);
      }
    }
  }
  return chunk(lines);
}

/** The message of a digest that found nothing new. */
export function renderQuietDigest(digestDate: string, sourceCount: number, failedSources: number): string {
  return `*Release Watch · ${digestDate}*  No new releases from ${sourceCount} sources${failedSources > 0 ? ` (${failedSources} unavailable)` : ""}.`;
}

/** The analyst's first message: every candidate, with the key the report cites. */
export function renderAnalystBrief(digestDate: string, windowStart: string, candidates: readonly Candidate[], sourceErrors: readonly string[]): string {
  const lines = [
    `Digest ${digestDate}. Candidates published or found since ${windowStart}: ${candidates.length}.`,
    sourceErrors.length > 0 ? `Sources that failed this run: ${sourceErrors.join("; ")}.` : "Every source answered.",
    "",
    "Each candidate: [key] tier | library | we run | source | published | engagement | title | url | summary",
  ];
  for (const candidate of candidates) {
    lines.push(
      `[${candidate.key}] T${candidate.sourceTier} | ${candidate.library ?? "-"} | ${candidate.pinned ?? "-"} | ${candidate.sourceId} | ${candidate.publishedAt ?? "-"} | ${candidate.engagement ?? "-"} | ${oneLine(candidate.title)} | ${candidate.url}${candidate.discussionUrl ? ` (discussion ${candidate.discussionUrl})` : ""} | ${oneLine(candidate.summary ?? "").slice(0, 280)}`,
    );
  }
  lines.push("", "Judge every candidate, then call submit_report once with the releases worth posting.");
  return lines.join("\n");
}

/** The thread note that confirms a filed issue. */
export function renderIssueFiled(release: DigestRelease, issueUrl: string, issueNumber: number): string {
  return `Tracking *${release.number}. ${escape(release.title)}* as ${release.priority}: ${link(issueUrl, `#${issueNumber}`)}`;
}

/** The GitHub issue of a tracked release. */
export function renderIssue(release: DigestRelease, digestId: string, slackLink: string | undefined): { title: string; body: string; labels: string[] } {
  const body = [
    `**${release.library}**${release.pinned ? ` (we run ${release.pinned})` : ""} · ${tierOf(release)} · ${release.category} · relevance ${release.relevance}/100`,
    "",
    `**What changed:** ${release.summary}`,
    "",
    `**What it means for us:** ${release.impact}`,
    "",
    "**Sources**",
    ...[release.url, ...release.sources.filter((source) => source !== release.url)].map((source) => `- ${source}`),
    "",
    slackLink ? `From the Release Watch digest ${digestId} ([Slack thread](${slackLink})).` : `From the Release Watch digest ${digestId}.`,
  ].join("\n");
  return { title: `[${release.library}] ${release.title}`.slice(0, 250), body, labels: ["release-watch", release.priority ?? release.suggestedPriority, `tier:${tierOf(release)}`, `category:${release.category}`, `library:${release.library}`.slice(0, 50)] };
}

/** A report of the collected candidates when the analyst did not finish: unranked, unassessed. */
export function fallbackReport(candidates: readonly Candidate[]): AnalystReport {
  const releases: ReportedRelease[] = candidates.slice(0, 15).map((candidate) => ({
    title: candidate.title,
    library: candidate.library ?? "other",
    ...(candidate.pinned ? { pinned: candidate.pinned } : {}),
    url: candidate.url,
    candidateKeys: [candidate.key],
    category: candidate.sourceKind === "github-releases" ? "new-feature" : "discussion",
    actionability: "no-change",
    relevance: 0,
    summary: candidate.summary?.slice(0, 280) || candidate.title,
    impact: "Not assessed: the analyst did not finish.",
    suggestedPriority: "P3",
    sources: [candidate.url],
  }));
  return { releases };
}

function meta(release: DigestRelease): string {
  const priority =
    release.status === "tracked" && release.priority ? ` · tracked ${release.priority}` : ISSUE_TIERS.includes(tierOf(release)) ? ` · suggested ${release.suggestedPriority}` : "";
  return `\`${release.library}\` · ${release.category} · relevance ${release.relevance}${priority}`;
}

function link(url: string, text: string): string {
  return `<${url.replace(/[<>|]/g, "")}|${escape(text)}>`;
}

/** Escapes Slack's control characters in user-visible text. */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function chunk(lines: readonly string[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > MAX_MESSAGE_CHARS && current !== "") {
      messages.push(current);
      current = "";
    }
    current = current === "" ? line : `${current}\n${line}`;
  }
  if (current.trim() !== "") {
    messages.push(current);
  }
  return messages;
}
