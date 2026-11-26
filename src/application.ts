import { loadFromEnvironment, type LoadedProject } from "@superdurable/connectors-sdk/projectconfig";
import { newProjectConnection as newGitHubConnection } from "@superdurable/connector-github";
import { newProjectConnection as newHackerNewsConnection } from "@superdurable/connector-hackernews";
import { newProjectConnection as newSlackConnection } from "@superdurable/connector-slack";
import { newProjectConnection as newWebFeedConnection } from "@superdurable/connector-web-feed";
import type { ModelClient } from "@superdurable/dex-agents/builtin-loop";

import { DexClientHolder } from "./dex-client-holder.ts";
import { releaseRoutes } from "./release-api.ts";
import { createAnalystAgent } from "./release-analyst-agent.ts";
import { GITHUB_CONNECTION, GITHUB_ISSUES_CONNECTION, HACKER_NEWS_CONNECTION, parseIssueRepository, ReleaseDigestFlow, SLACK_CONNECTION, WEB_FEED_CONNECTION, type DigestDependencies, type IssueRepository } from "./release-digest-flow.ts";
import { configuredModelClient, localSettingsFile, unconfiguredModel, type SettingLookup } from "./release-model.ts";
import { createTriageAgent } from "./release-triage-agent.ts";
import { ReleaseWatchScheduleFlow, SCHEDULE_FLOW_ID } from "./release-watch-schedule-flow.ts";
import { page } from "./page.ts";
import type { Application, ApplicationMode } from "./runtime.ts";
import { DEFAULT_SCHEDULE } from "./schedule-time.ts";
import { readReplyBinding, startSlackReplyTrigger } from "./slack-triggers.ts";

/** What the application loads with: the mode, and in API tests what the test replaces. */
export interface ApplicationOptions {
  readonly mode: ApplicationMode;
  /** The model both agents call instead of the configured one; API tests pass a ScriptedModelClient. */
  readonly model?: ModelClient;
  /** The Project configuration; API tests pass one with mock connections. */
  readonly project?: LoadedProject;
}

/**
 * The four Flows (schedule, digest, analyst session, triage session), the API
 * and the page. Only the Worker calls the model, so only the Worker reads its
 * settings; only the web process runs the Slack reply Trigger.
 */
export async function loadApplication(options: ApplicationOptions): Promise<Application> {
  const project = options.project ?? (await loadFromEnvironment());
  const clients = new DexClientHolder();
  // Only the Worker calls the model and files issues, so only the Worker reads the settings.
  const settings = options.mode === "worker" ? await applicationSettings(project) : undefined;
  const model = options.model ?? (settings ? configuredModelClient(settings) : unconfiguredModel);
  const issueRepository = settings ? issueRepositoryOf(settings) : { owner: "", repository: "" };
  let digestFlow: ReleaseDigestFlow | undefined;
  const digest = () => digestFlow!;
  const analystFlow = createAnalystAgent(model, clients, digest);
  let scheduleFlow: ReleaseWatchScheduleFlow | undefined;
  const webFeed = newWebFeedConnection(project as never, WEB_FEED_CONNECTION);
  const triageFlow = createTriageAgent(model, clients, digest, () => scheduleFlow!, webFeed);
  scheduleFlow = new ReleaseWatchScheduleFlow(clients, digest);
  const dependencies: DigestDependencies = {
    clients,
    slackChannelId: readReplyBinding(project).channelId,
    // The GitHub and Hacker News packages are typed against another Connector SDK version;
    // their project loaders read the same configuration shape.
    slack: newSlackConnection(project, SLACK_CONNECTION),
    github: newGitHubConnection(project as never, GITHUB_CONNECTION),
    githubIssues: newGitHubConnection(project as never, GITHUB_ISSUES_CONNECTION),
    issueRepository,
    hackerNews: newHackerNewsConnection(project as never, HACKER_NEWS_CONNECTION),
    webFeed,
    analystFlow: () => analystFlow,
    triageFlow: () => triageFlow,
    scheduleFlow: () => scheduleFlow,
  };
  digestFlow = new ReleaseDigestFlow(dependencies);
  return {
    flows: [scheduleFlow, digestFlow, analystFlow, triageFlow],
    routes: (client) => releaseRoutes(client, scheduleFlow, digestFlow!),
    page,
    bindClient: (client) => clients.set(client),
    startWebServices: async (client) => {
      // The one schedule starts with the application; a later start finds it running.
      await client.startFlow(scheduleFlow, SCHEDULE_FLOW_ID, DEFAULT_SCHEDULE, { requestId: `start-${SCHEDULE_FLOW_ID}`, ignoreAlreadyStarted: true });
      const trigger = startSlackReplyTrigger(project, client, triageFlow);
      return { rawRoutes: [{ path: trigger.relayPath, handle: trigger.serveRelay }], stop: trigger.stop };
    },
  };
}

/**
 * The settings of the Project's Configuration. A local run against a Dex Web
 * connections file has none; RELEASE_WATCH_LOCAL_SETTINGS then names a
 * mode-0600 env file that holds them, and the process environment holds
 * the other settings.
 */
async function applicationSettings(project: LoadedProject): Promise<SettingLookup> {
  const environment = await project.resolveApplicationEnvironment();
  if (environment.size > 0) {
    return (name) => environment.lookup(name);
  }
  const localFile = process.env.RELEASE_WATCH_LOCAL_SETTINGS;
  const fromFile = localFile ? localSettingsFile(localFile) : () => undefined;
  return (name) => fromFile(name) ?? process.env[name];
}

/** The issue repository; the Worker refuses to start without one, since every "track" would fail. */
function issueRepositoryOf(settings: SettingLookup): IssueRepository {
  const setting = settings("ISSUE_REPOSITORY");
  const parsed = parseIssueRepository(setting);
  if (parsed === undefined) {
    throw new Error(`ISSUE_REPOSITORY must name the repository that tracks releases, as owner/name; it is ${setting ? `"${setting}"` : "not set"}`);
  }
  return parsed;
}
