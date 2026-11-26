/**
 * What the agents know about your application when they judge a release. This is
 * an example: replace it with a few factual lines about your own stack. Keep it
 * short; the next model call uses whatever it says.
 */
export const TEAM_PROFILE = `About the application you judge releases for (an example; the team edits this):
- A customer-support assistant. A Python API runs its agents, built with the OpenAI Agents SDK, LangGraph and
  Pydantic AI; a TypeScript web app uses the Claude Agent SDK for the in-page helper.
- Its tools are MCP servers written with the Model Context Protocol Python and TypeScript SDKs.
- Versions are pinned to narrow ranges; each candidate shows the range the application runs ("we run"). A release
  past that range means a deliberate upgrade with a test run.
- Runs on Node 22 and Python 3.12; customer conversations pass through tool calls, so security fixes in tool,
  transport or sandbox code matter most.`;

export const PRIORITY_RUBRIC =
  "P0 when it must be handled this week (an exploitable vulnerability in the version we run, or a break already hitting users), P1 for the next sprint, P2 worth planning, P3 no action yet";

/**
 * How the analyst sorts a release into a tier: step 4 of its instructions. Write
 * it for your application; the tiers stay must-fix, recommend and no-change.
 */
export const TIER_RUBRIC = `4. For each release, judge it as the engineer who owns the upgrade. Read the release notes in the summary and
   compare the version with the range the application runs ("we run"). First decide what the team should DO:
   - actionability, exactly one of:
     must-fix: the application has to change to keep working with this release or to stay safe: removed or
       renamed APIs it uses, changed defaults or behaviour it relies on, a new minimum runtime version, a new
       major version past the pinned range, or a vulnerability (a CVE, an advisory, "security" in the notes)
       fixed in a version at or below the one it runs. Name in impact exactly what breaks or is exposed;
     recommend: the application keeps working unchanged, but the release adds a substantial feature the profile
       says it can use, or a fix for a bug it could hit. Name in impact what the team would adopt;
     no-change: everything keeps working and there is nothing to do: small fixes, performance work, docs,
       prereleases, alphas and betas, roadmap posts, deprecations a major version away. Say in impact why.
     Ask "does a line of the application's code have to change?": yes means must-fix. When unsure between
     must-fix and no-change, pick must-fix and say what to test; when unsure between recommend and no-change,
     pick no-change.`;

/** The tiers in one line each, for the triage agent. */
export const TIER_MEANINGS = `- Every release has a tier (actionability): must-fix (the application needs a change to keep working with the
  release, or it fixes a vulnerability in a version we run), recommend (the application still works, but the
  release adds a substantial feature worth adopting) and no-change (everything still works; nothing to do). Must-fix and recommend releases become issues on request; no-change releases
  need a confirmation.`;
