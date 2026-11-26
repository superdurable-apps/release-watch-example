// Unit tests of the parsing, filtering and rendering code; they need no engine.
// Run: node --test apptest/*.unit.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { fallbackReport, numberReleases, renderHeadline, renderIssue } from "../src/digest-render.ts";
import { parseIssueRepository } from "../src/release-digest-flow.ts";
import { decodeAnalystReport, tierOf } from "../src/release-types.ts";
import { feedCandidates, githubReleaseCandidates } from "../src/source-candidates.ts";
import { keepsTag, tagOfReleaseUrl, validateWatchedSource, WATCHLIST, type WatchedSource } from "../src/watchlist.ts";

const mastra: WatchedSource = { id: "gh-mastra", kind: "github-releases", tier: 1, library: "mastra", pinned: "@mastra/core 1.81.0", repository: "mastra-ai/mastra", tagPattern: "^@mastra/core@" };
const windowStart = "2026-11-20T00:00:00Z";

test("tag of a release URL is decoded", () => {
  assert.equal(tagOfReleaseUrl("https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fcore%401.85.0"), "@mastra/core@1.85.0");
  assert.equal(tagOfReleaseUrl("https://github.com/x/y/releases/tag/langchain-core%3D%3D1.8.0"), "langchain-core==1.8.0");
  assert.equal(tagOfReleaseUrl("https://example.com/post"), undefined);
});

test("tagPattern keeps only the packages named", () => {
  assert.equal(keepsTag(mastra, "@mastra/core@1.85.0"), true);
  assert.equal(keepsTag(mastra, "@mastra/turso@0.1.23"), false);
  assert.equal(keepsTag({ ...mastra, tagPattern: undefined }, "anything"), true);
});

test("release feed items are filtered by tag and carry the pinned range", () => {
  const items = [
    { id: "1", title: "@mastra/core@1.85.0", link: "https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fcore%401.85.0", publishedAt: "2026-11-21T10:00:00Z" },
    { id: "2", title: "@mastra/turso@0.1.23", link: "https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fturso%400.1.23", publishedAt: "2026-11-21T10:00:00Z" },
    { id: "3", title: "@mastra/core@1.80.0", link: "https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fcore%401.80.0", publishedAt: "2026-11-01T10:00:00Z" },
  ];
  const found = feedCandidates(mastra, items, windowStart);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.title, "mastra-ai/mastra @mastra/core@1.85.0");
  assert.equal(found[0]!.pinned, "@mastra/core 1.81.0");
  assert.equal(found[0]!.library, "mastra");
});

test("API releases are filtered by tag too", () => {
  const releases = [
    { tagName: "@mastra/core@1.85.0", url: "https://github.com/mastra-ai/mastra/releases/tag/a", isDraft: false, isPrerelease: false, createdAt: "2026-11-21T00:00:00Z" },
    { tagName: "mastracode@0.50.2", url: "https://github.com/mastra-ai/mastra/releases/tag/b", isDraft: false, isPrerelease: false, createdAt: "2026-11-21T00:00:00Z" },
    { tagName: "@mastra/core@1.86.0", url: "https://github.com/mastra-ai/mastra/releases/tag/c", isDraft: true, isPrerelease: false, createdAt: "2026-11-21T00:00:00Z" },
  ];
  assert.deepEqual(githubReleaseCandidates(mastra, releases, windowStart).map((candidate) => candidate.url), ["https://github.com/mastra-ai/mastra/releases/tag/a"]);
});

test("a watched source added from Slack keeps its pin and tag filter, and a bad pattern is refused", () => {
  const source = validateWatchedSource({ id: "gh-fastapi", kind: "github-releases", repository: "fastapi/fastapi", pinned: "0.115.x", tagPattern: "^\\d" });
  assert.equal(source.pinned, "0.115.x");
  assert.equal(source.tagPattern, "^\\d");
  assert.throws(() => validateWatchedSource({ id: "gh-bad", kind: "github-releases", repository: "a/b", tagPattern: "(" }));
});

test("every example watchlist entry is valid", () => {
  for (const source of WATCHLIST) {
    assert.deepEqual(validateWatchedSource(source), source, source.id);
  }
});

const release = (title: string, actionability: string, relevance: number, suggestedPriority = "P1") => ({
  title,
  library: "openai-agents",
  url: `https://github.com/openai/openai-agents-python/releases/tag/${encodeURIComponent(title)}`,
  candidateKeys: ["gh-openai-agents-python:abc"],
  actionability,
  category: "new-major-version",
  relevance,
  summary: `${title} released.`,
  impact: "Outside the pinned range; the upgrade needs a test run.",
  suggestedPriority,
  sources: [],
});

test("the report takes the three tiers and refuses others", () => {
  const report = decodeAnalystReport({ releases: [release("v0.25.0", "recommend", 80, "P0")] });
  assert.equal(report.releases[0]!.suggestedPriority, "P1", "recommend is capped at P1");
  assert.throws(() => decodeAnalystReport({ releases: [release("v0.25.0", "upgrade", 80)] }), /actionability/);
});

test("a release without a known tier counts as recommended, and an old tier as its replacement", () => {
  assert.equal(tierOf({}), "recommend");
  assert.equal(tierOf({ actionability: "unknown" }), "recommend");
  assert.equal(tierOf({ actionability: "watch" }), "no-change");
  assert.equal(tierOf({ actionability: "security" }), "must-fix");
});

test("digest orders by tier and the issue carries pin and labels", () => {
  const report = decodeAnalystReport({
    releases: [release("v0.25.0", "recommend", 80), release("v1.0.0-alpha.1", "no-change", 40, "P3"), release("v0.24.9", "must-fix", 90, "P0")],
  });
  const numbered = numberReleases(report);
  assert.deepEqual(numbered.map((item) => [item.number, item.actionability]), [[1, "must-fix"], [2, "recommend"], [3, "no-change"]]);
  const headline = renderHeadline("2026-11-23", numbered, 13, 0, false);
  assert.match(headline, /A · Must fix/);
  assert.match(headline, /B · Recommended/);
  const issue = renderIssue({ ...numbered[1]!, pinned: ">=0.24,<0.25" }, "release-digest-2026-11-23", undefined);
  assert.match(issue.body, /we run >=0.24,<0.25/);
  assert.deepEqual(issue.labels, ["release-watch", "P1", "tier:recommend", "category:new-major-version", "library:openai-agents"]);
});

test("the issue repository is owner/name, or nothing", () => {
  assert.deepEqual(parseIssueRepository(" your-org/your-repo "), { owner: "your-org", repository: "your-repo" });
  assert.equal(parseIssueRepository(undefined), undefined);
  assert.equal(parseIssueRepository("your-repo"), undefined);
  assert.equal(parseIssueRepository("a/b/c"), undefined);
});

test("a digest the analyst did not finish says how to file its unranked candidates", () => {
  const candidates = feedCandidates(mastra, [{ id: "1", title: "@mastra/core@1.85.0", link: "https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fcore%401.85.0", publishedAt: "2026-11-21T10:00:00Z" }], windowStart);
  const numbered = numberReleases(fallbackReport(candidates));
  assert.equal(numbered[0]!.actionability, "no-change");
  const headline = renderHeadline("2026-11-23", numbered, 13, 0, true);
  assert.match(headline, /did not finish in time: the thread lists 1 unranked candidates as no-change/);
  assert.doesNotMatch(headline, /Nothing to change today/);
});
