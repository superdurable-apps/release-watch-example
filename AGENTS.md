# Notes for coding agents

Release Watch is a Dex application in TypeScript on Node.js 22. Read
`README.md` first: it explains the Flows, the settings and how to run it.

## Where things live

| Change | File |
| --- | --- |
| The libraries to watch and their pinned ranges | `src/watchlist.ts` |
| What the agents know about the application | `src/team-profile.ts` |
| The analyst agent: instructions, report schema, `submit_report` | `src/release-analyst-agent.ts` |
| The triage agent: instructions and tools | `src/release-triage-agent.ts` |
| Tiers, categories, priorities, report validation | `src/release-types.ts` |
| The digest Flow: sources, analyst wait, Slack posts, outbox | `src/release-digest-flow.ts` |
| The schedule Flow: the weekday digest, manual runs, watchlist edits | `src/release-watch-schedule-flow.ts` |
| Slack and issue text | `src/digest-render.ts` |
| The HTTP API | `openapi/openapi.yaml`, then `src/release-api.ts` |
| Connections, operations and settings | `dex-app.yaml` |

## Rules

- Every connector operation the code calls must be listed under its
  connection's `operations` in `dex-app.yaml`.
- Only the Worker reads the settings (`ISSUE_REPOSITORY` and the model). Never
  put a key in source, Flow state, logs or responses, and never copy one into
  `process.env`.
- A tool that writes declares its effect (`idempotent_write` or
  `non_idempotent_write`). The triage tools change a digest only through the
  digest Flow's RPCs, with the tool call's idempotency key as `requestKey`.
- GitHub writes go through the outbox (`ProcessOutbox`), one at a time.
- Never rename a Flow type or Step type of a Flow with open runs.
- `package-lock.json` pins every dependency: change dependencies with
  `npm install --save-exact`, and never commit `node_modules` or `dist`.

## Flow graphs

`src/release-digest-flow.ts` and `src/release-watch-schedule-flow.ts` declare a
`dex:group` and a `dex:explanation` for every Step. The two agent session
graphs in `flow-definitions/` are generated, never edited by hand. After a
`@superdurable/dex-agents` update, or a change of an agent's Flow type or
permission, write them again with the command that
`python3 scripts/render-flow-definitions.py` prints when one differs.

## Commands

- `make bootstrap` restores `node_modules`.
- `make check-static` checks the Flow graphs, the types and the build.
- `make test-app` runs the unit tests in `apptest/`.
