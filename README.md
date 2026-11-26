# Release Watch

A Dex example application that watches the libraries your application depends
on. Every weekday it reads their GitHub releases and a few community searches,
has an LLM analyst judge each release against the versions you run, posts a
digest to Slack, and lets your team triage it by replying in the thread.
Releases the team tracks become GitHub issues.

It shows, in one application:

- a scheduled Flow that starts one digest Flow per day;
- connector Steps that read many sources, where one failing source never
  stops the digest;
- an AI agent session (the analyst) whose every model call and tool call is
  its own durable Step, with a deadline that falls back to an unranked digest;
- a second agent (triage) driven by Slack thread replies, limited to the
  members you choose;
- an outbox that files, relabels, comments on and closes GitHub issues one at
  a time, and picks up where it stopped after a Worker restart.

## How it works

- **ReleaseWatchScheduleFlow** (`release-watch`) starts a digest weekdays at
  08:00 America/Los_Angeles, or on demand (`POST /api/digests`, or "run it
  again" in a thread). It also holds the watchlist edits.
- **ReleaseDigestFlow** (`release-digest-<date>[-run-N]`) reads every watched
  source, drops links an earlier digest already reported, hands the rest to
  the analyst, posts the result to Slack, and runs the outbox for GitHub issue
  creates, closes, relabels and comments.
- **ReleaseAnalystAgentFlow** judges the candidates and submits one report.
- **ReleaseTriageAgentFlow** answers replies in the digest thread (one session
  per thread): track, dismiss, untrack, reprioritize, re-tier, comment, search,
  read release notes, rerun, edit the watchlist.

### Tiers

Every reported release has a tier, which decides where the digest shows it and
whether a plain "track" files it:

| Tier | Meaning | Issue on "track" |
|---|---|---|
| A · must-fix | Your application must change to keep working or stay safe: removed or changed APIs, a new runtime minimum, a new major past your pin, a fixed vulnerability | yes, P0-P3 |
| B · recommend | Everything still works, and the release adds a substantial feature worth adopting | yes, P1-P3 |
| C · no-change | Everything still works and there is nothing to do: small fixes, prereleases, roadmap posts | only if confirmed |

Docs-only and internal releases are not reported, only counted.

Nothing is filed without a person. The digest itself never files an issue: an
issue exists only after a member allowed to triage says so in the thread, such
as `track 1 P1`. Every filed issue can be undone with `untrack 1`.

## Make it yours

- **`src/watchlist.ts`**: the libraries to watch. Each GitHub source takes
  `pinned`, the version range you run, which the analyst compares each release
  with, and `tagPattern` for monorepos that tag every package (for example
  `^@mastra/core@`). The list is an example, matching the example application
  of `src/team-profile.ts`.
- **`src/team-profile.ts`**: a few factual lines about your application, which
  both agents read. The more concrete, the better the impact lines.

The triage members can also change the watchlist from Slack: "watch
fastapi/fastapi, we run 0.115", "stop watching gh-mcp-python".

## Connections and settings

The application uses five connections, with these names:

| Connection | Connector | Sign-in | Used for |
| --- | --- | --- | --- |
| `release-watch-slack` | Slack | bot token and app-level token | posting the digest, and the reply Trigger |
| `release-watch-github` | GitHub | `github-oauth`, public read is enough | sources with a `tagPattern`, read through the API |
| `release-watch-github-issues` | GitHub | `github-oauth-repository`, Issues read and write | filing, labelling, commenting on and closing issues |
| `release-watch-hacker-news` | Hacker News | none | the Hacker News sources |
| `release-watch-web-feed` | Web feed | none | feed and sitemap sources, and pages the triage agent reads |

The Slack connection has one Trigger binding, `release-watch-replies`. It names
the digest channel and the members who may triage; replies from anyone else
are ignored.

The Slack app needs:

- the bot scopes `chat:write`, `channels:history`, `groups:history`,
  `channels:read`, `groups:read` and `users:read`;
- Socket Mode on, with an app-level token that has `connections:write`;
- the bot events `message.channels` and `message.groups`;
- the bot invited to the digest channel.

The settings:

| Setting | Meaning |
| --- | --- |
| `ISSUE_REPOSITORY` | the repository that tracks releases, as `owner/name`; the Worker refuses to start without it |
| `LLM_BASE_URL`, `LLM_MODEL`, secret `LLM_API_KEY` | any OpenAI-compatible Chat Completions endpoint |
| secret `ANTHROPIC_API_KEY` | Claude instead, when the three above are not set |
| `LIST_RELEASES_THROUGH_API` | `true` reads every GitHub source through the API, not only those with a `tagPattern` |

Issues carry the labels `release-watch`, the priority (`P0` to `P3`),
`tier:`, `category:` and `library:`.

## Run it on Dex Cloud

Create a Project from this repository. In its Setup, connect the five
connections above, choose the digest channel and the members who may triage
for `release-watch-replies`, and set `ISSUE_REPOSITORY` and the model settings
in Configuration. Then publish it. The schedule starts with the web process.

## Run it locally

You need Node.js 22.19 or later (or 24), `dexcli`, and the Slack app above.

1. Start Dex, and keep it running:

   ```sh
   dexcli dev --dex-port 8961 --web-port 8962 --open=false --connectors-mcp=false \
     --connector-config-dir ~/.dex-dev/release-watch/connectors \
     --zd-data-dir ~/.dex-dev/release-watch/zd \
     --server-log-folder ~/.dex-dev/release-watch/logs
   ```

2. In Dex Web (http://127.0.0.1:8962), open **Connectors** and add the five
   connections with the names above, and the `release-watch-replies` binding.
   Dex Web writes them to `connections.json` in the connector directory.
3. Write the runtime file both processes read, `/tmp/superverse-app/runtime.yaml`
   (the path Dex Cloud uses):

   ```yaml
   worker:
     mode: pull
     readinessAddress: '127.0.0.1:54025'
     maxConcurrentTasks: 4
     idleStreamsPerQueue: 1
     stopDrainTimeout: 5s
   ```

4. Write the settings to a file of mode 0600, one `NAME=value` per line, and
   never commit it:

   ```sh
   ISSUE_REPOSITORY=your-org/your-repo
   LLM_BASE_URL=https://your-endpoint/v1
   LLM_MODEL=your-model
   LLM_API_KEY=...
   ```

5. Build, then start the Worker and the web process:

   ```sh
   npm ci && npm run build
   export DEX_FLOW_SERVICE_ADDRESS=127.0.0.1:8961
   export DEX_CONNECTOR_CONFIG_FILE=~/.dex-dev/release-watch/connectors/connections.json
   RELEASE_WATCH_LOCAL_SETTINGS=path/to/settings.env node . worker
   PORT=8971 node . web
   ```

6. Start a digest with `curl -X POST http://127.0.0.1:8971/api/digests`. It
   runs as `release-digest-<date>-run-1`; watch it in Dex Web, and reply in its
   Slack thread.

More:

- GitHub releases are read from `https://github.com/<repo>/releases.atom`,
  which lists the newest ten. Sources with a `tagPattern` read the newest 40
  through the GitHub API instead.
- `RELEASE_WATCH_LOCAL_SETTINGS=<file> node scripts/live-model-smoke.ts` makes
  one model call with your settings, to check them before a digest.
- `node scripts/send-triage-message.ts <session> "<@U…>: text"`, with the
  environment of `node . web`, sends a reply to a triage session without
  Slack.
- After changing an agent's Flow type or permission, write its graph again
  with the command `python3 scripts/render-flow-definitions.py` prints.
- `make test-app` runs the unit tests of the parsing, filtering and rendering
  code.
