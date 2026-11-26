import { readFileSync, statSync } from "node:fs";

import type { Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { ModelClient } from "@superdurable/dex-agents/builtin-loop";
import { createPiAiModelClient } from "@superdurable/dex-agents-pi";

/**
 * The model both agents call, chosen from the Project's Configuration:
 *
 * - LLM_BASE_URL, LLM_MODEL and the secret LLM_API_KEY select an
 *   OpenAI-compatible Chat Completions endpoint;
 * - otherwise the secret ANTHROPIC_API_KEY selects Claude Opus 5.5.
 *
 * Every call asks for high reasoning effort. On an OpenAI-compatible endpoint
 * pi-ai sends it as the request field "reasoning_effort": "high".
 */
export const REASONING_EFFORT = "high";

/** The application settings the model reads; dex-app.yaml declares each one. */
export const MODEL_SETTING_NAMES = ["LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "ANTHROPIC_API_KEY"] as const;

/** Looks up one setting by name; undefined when it is not configured. */
export type SettingLookup = (name: string) => string | undefined;

export const MISSING_MODEL_MESSAGE =
  "No model is configured: set LLM_BASE_URL, LLM_MODEL and the secret LLM_API_KEY, or the secret ANTHROPIC_API_KEY, in the Project's Configuration";

const ANTHROPIC_MODEL_ID = "claude-opus-5-5";

/** The pi-ai client of the configured model, or the client that explains what to configure. */
export function configuredModelClient(lookup: SettingLookup): ModelClient {
  const baseUrl = lookup("LLM_BASE_URL");
  const modelId = lookup("LLM_MODEL");
  const apiKey = lookup("LLM_API_KEY");
  if (baseUrl && modelId && apiKey) {
    return createPiAiModelClient(openAICompatibleModel(baseUrl, modelId), { apiKey });
  }
  const anthropicKey = lookup("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    return createPiAiModelClient(getModel("anthropic", ANTHROPIC_MODEL_ID), { apiKey: anthropicKey });
  }
  return unconfiguredModel;
}

/**
 * An OpenAI-compatible Chat Completions model that pi-ai's catalog does not
 * know. reasoning and supportsReasoningEffort make pi-ai send the session's
 * reasoning effort as "reasoning_effort"; thinkingFormat "openai" keeps it to
 * that one field (other thinking formats send provider-specific fields instead).
 */
export function openAICompatibleModel(baseUrl: string, modelId: string): Model<"openai-completions"> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl: baseUrl.replace(/\/+$/, ""),
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: {
      thinkingFormat: "openai",
      supportsReasoningEffort: true,
      supportsDeveloperRole: false,
    },
  };
}

/** The model of a process without a configured model: every call fails with what to configure. */
export const unconfiguredModel: ModelClient = {
  async callModel() {
    throw new Error(MISSING_MODEL_MESSAGE);
  },
  estimateInputTokens: () => 0,
};

/**
 * Reads the settings of a local run from a mode-0600 env file, for a Worker
 * that runs against a local Dex Web connections file, whose Project
 * Configuration holds no application settings. The values stay in memory; they never enter process.env, a Flow or a log.
 */
export function localSettingsFile(path: string): SettingLookup {
  const status = statSync(path);
  if (!status.isFile() || (status.mode & 0o077) !== 0) {
    throw new Error("the local settings file must be a regular file of mode 0600");
  }
  const values = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) {
      continue;
    }
    values.set(match[1]!, match[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return (name) => values.get(name) || undefined;
}
