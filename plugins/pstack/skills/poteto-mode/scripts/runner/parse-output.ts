import type {
  NormalizedUsage,
  ParsedOutput,
  Provider,
} from "./types.ts";
import {
  concreteModelMatchesRollingAlias,
  isRollingClaudeAlias,
} from "./model-aliases.ts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizedUsage(value: unknown): NormalizedUsage | null {
  const usage = object(value);
  if (usage === null) return null;
  const result: NormalizedUsage = {
    inputTokens: finiteNumber(usage.input_tokens),
    cachedInputTokens: finiteNumber(
      usage.cached_input_tokens ?? usage.cache_read_input_tokens
    ),
    cacheCreationInputTokens: finiteNumber(
      usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens
    ),
    outputTokens: finiteNumber(usage.output_tokens),
    reasoningTokens: finiteNumber(
      usage.reasoning_tokens ?? usage.reasoning_output_tokens
    ),
    totalTokens: finiteNumber(usage.total_tokens),
  };
  return Object.values(result).some((entry) => entry !== undefined)
    ? result
    : null;
}

function modelFromUsage(
  value: unknown,
  provider: Provider,
  requestedModel: string
): string | null {
  const usage = object(value);
  if (usage === null) return null;
  const models = Object.keys(usage);
  return models.find((model) =>
    reportedModelMatches(provider, requestedModel, model)
  )
    ?? models[0]
    ?? null;
}

function parseClaude(stdout: string, requestedModel: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("claude did not emit valid JSON");
  }
  const value = object(raw);
  if (value === null) throw new Error("claude emitted a non-object result");

  const text = nullableString(value.result);
  if (text === null) throw new Error("claude result did not contain final text");
  if (value.is_error === true) throw new Error("claude reported an error result");

  return {
    text,
    reportedModel: modelFromUsage(value.modelUsage, "claude", requestedModel),
    sessionId: nullableString(value.session_id ?? value.sessionId),
    usage: normalizedUsage(value.usage),
    costUsd: finiteNumber(value.total_cost_usd) ?? null,
  };
}

function parseGrok(stdout: string, requestedModel: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("grok did not emit valid JSON");
  }
  const result = object(raw);
  if (result === null) throw new Error("grok emitted a non-object result");
  if (result.stopReason !== "end_turn") {
    throw new Error(`Grok did not complete: ${nullableString(result.stopReason) ?? "missing stopReason"}`);
  }

  const text = nullableString(result.text);
  if (text === null) throw new Error("grok result did not contain final text");

  return {
    text,
    reportedModel: modelFromUsage(result.modelUsage, "grok", requestedModel),
    sessionId: nullableString(result.sessionId),
    usage: normalizedUsage(result.usage),
    costUsd: finiteNumber(result.total_cost_usd) ?? null,
  };
}

function parseCodex(stdout: string): ParsedOutput {
  let text: string | null = null;
  let usage: NormalizedUsage | null = null;
  let sessionId: string | null = null;

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error("codex emitted a non-JSON event");
    }
    const event = object(raw);
    if (event === null) continue;
    if (event.type === "thread.started") {
      sessionId = nullableString(event.thread_id) ?? sessionId;
    }
    if (event.type === "item.completed") {
      const item = object(event.item);
      if (item?.type === "agent_message") {
        text = nullableString(item.text) ?? text;
      }
    }
    if (event.type === "turn.completed") {
      usage = normalizedUsage(event.usage) ?? usage;
    }
    if (event.type === "turn.failed") {
      const error = object(event.error);
      throw new Error(nullableString(error?.message) ?? "codex reported a failed turn");
    }
  }

  if (text === null) throw new Error("codex result did not contain a final agent message");
  return {
    text,
    reportedModel: null,
    sessionId,
    usage,
    costUsd: null,
  };
}

function parseOpenrouter(stdout: string): ParsedOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("openrouter lane did not emit valid JSON");
  }
  const value = object(raw);
  if (value === null || value.kind !== "openrouter-lane.v1") {
    throw new Error("openrouter lane emitted an unexpected envelope");
  }
  const text = nullableString(value.result);
  if (text === null) throw new Error("openrouter lane result did not contain final text");
  return {
    text,
    reportedModel: nullableString(value.model),
    sessionId: null,
    usage: normalizedUsage(value.usage),
    costUsd: finiteNumber(value.cost_usd) ?? null,
  };
}

export function parseProviderOutput(
  provider: Provider,
  stdout: string,
  stderr: string,
  requestedModel: string
): ParsedOutput {
  switch (provider) {
    case "claude":
      return parseClaude(stdout, requestedModel);
    case "codex":
      return parseCodex(stdout);
    case "grok":
      return parseGrok(stdout, requestedModel);
    case "openrouter":
      return parseOpenrouter(stdout);
  }
}

export function reportedModelMatches(
  provider: Provider,
  requested: string,
  reported: string | null
): boolean {
  if (reported === null) return false;
  if (provider === "claude" && isRollingClaudeAlias(requested)) {
    return concreteModelMatchesRollingAlias(requested, reported);
  }
  if (reported === requested || reported.startsWith(`${requested}-`)) {
    return true;
  }
  return false;
}
