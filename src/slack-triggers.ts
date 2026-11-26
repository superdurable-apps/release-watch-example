import type { IncomingMessage, ServerResponse } from "node:http";

import type { Client } from "@superdurable/dex";
import { newConsoleTriggerLogger, newDexRPCTriggerTarget, newTriggerContext } from "@superdurable/connectors-sdk";
import { decodeTriggerConfiguration, type LoadedProject } from "@superdurable/connectors-sdk/projectconfig";
import {
  ThreadReplyCreatedTriggerConfigurationSchema,
  ThreadReplyCreatedTriggerDefinition,
  newProjectMessageTriggerRunner,
  relayedTriggerPath,
  type MessageEvent,
  type ThreadReplyCreatedTriggerConfiguration,
} from "@superdurable/connector-slack";
import type { AgentSessionFlow } from "@superdurable/dex-agents";
import type { BuiltinLoopAgentRunner } from "@superdurable/dex-agents/builtin-loop";

import { SLACK_CONNECTION, SLACK_REPLY_BINDING, triageSessionId } from "./release-digest-flow.ts";

/** The reply binding of the Project's Configuration: the digest channel and the members who may triage. */
export function readReplyBinding(project: LoadedProject): ThreadReplyCreatedTriggerConfiguration {
  return decodeTriggerConfiguration(
    project.configuration,
    { connectorId: "slack", connectionName: SLACK_CONNECTION, triggerName: ThreadReplyCreatedTriggerDefinition.trigger.triggerName, bindingName: SLACK_REPLY_BINDING },
    ThreadReplyCreatedTriggerConfigurationSchema,
  );
}

/**
 * Admits a reply only in the digest channel, only inside a thread, only from a
 * member allowed to triage, and never the bot's own posts: the triagers are
 * people, so the bot is never one of them.
 */
export function newReplyFilter(binding: ThreadReplyCreatedTriggerConfiguration): (event: { readonly id: string; readonly payload: MessageEvent }) => boolean {
  const triagers = new Set(binding.threadReplyMatcher?.posterUserIds ?? []);
  return (event) => {
    const message = event.payload;
    const isReply = message.threadTimestamp !== "" && message.threadTimestamp !== message.timestamp;
    return event.id !== "" && message.channelId === binding.channelId && isReply && triagers.has(message.userId) && message.text.trim() !== "";
  };
}

/** The triage session of the reply's thread, the same ID the digest started it with. */
export function resolveTriageSession(event: { readonly payload: MessageEvent }): string {
  return triageSessionId(event.payload.channelId, event.payload.threadTimestamp);
}

/** The reply as the triage agent reads it: who wrote it, then the text. */
export function toUserMessage(event: { readonly payload: MessageEvent }): { readonly text: string } {
  return { text: `<@${event.payload.userId}>: ${event.payload.text.trim()}` };
}

/** The running Slack reply Trigger and the HTTP handler of the events a host relays to it. */
export interface SlackReplyTrigger {
  readonly relayPath: string;
  serveRelay(request: IncomingMessage, response: ServerResponse): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts the reply Trigger: Socket Mode when the connection has an app token
 * (local runs), relayed events through serveRelay otherwise (Dex Cloud).
 * Each admitted reply becomes send_user_message on its thread's triage
 * session; the target's request ID makes a redelivery apply once.
 */
export function startSlackReplyTrigger(project: LoadedProject, client: Client, triageFlow: AgentSessionFlow<BuiltinLoopAgentRunner>): SlackReplyTrigger {
  const binding = readReplyBinding(project);
  const runner = newProjectMessageTriggerRunner(project, SLACK_CONNECTION, {
    threadReplyCreatedRoutes: [
      {
        bindingName: SLACK_REPLY_BINDING,
        target: newDexRPCTriggerTarget(client, triageFlow.sendUserMessage as never, newReplyFilter(binding), resolveTriageSession, toUserMessage, {
          logger: newConsoleTriggerLogger(),
        } as never),
      },
    ],
  });
  const abort = new AbortController();
  const running = runner.run(newTriggerContext(abort.signal) as never).catch((error: unknown) => {
    if (!abort.signal.aborted) {
      console.error(JSON.stringify({ msg: "Slack reply Trigger stopped", error: String(error) }));
      process.exitCode = 1;
    }
  });
  return {
    relayPath: relayedTriggerPath(SLACK_CONNECTION),
    serveRelay: (request, response) => runner.serveHTTP(request, response),
    stop: async () => {
      abort.abort();
      await running;
    },
  };
}
