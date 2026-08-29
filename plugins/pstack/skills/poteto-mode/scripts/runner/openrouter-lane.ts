#!/usr/bin/env bun
/** One-shot OpenRouter lane child for pstack-runner.
 *
 * Modes:
 *   --preflight            verify the API key against GET /api/v1/key
 *   --model X --effort E   read the prompt from stdin, run one chat completion,
 *                          print a single JSON envelope on stdout
 *
 * API lanes have no tools, no filesystem, no iteration — read-only by
 * construction. Key sources: $OPENROUTER_API_KEY, then ~/.config/openrouter/key.
 * OpenRouter's unified reasoning parameter tops out at "high"; xhigh/max clamp
 * to "high" (the envelope records the clamp).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "https://openrouter.ai/api/v1";

function apiKey(): string | null {
  const env = process.env.OPENROUTER_API_KEY;
  if (env !== undefined && env.trim().length > 0) return env.trim();
  const file = join(homedir(), ".config", "openrouter", "key");
  if (existsSync(file)) {
    const value = readFileSync(file, "utf8").trim();
    if (value.length > 0) return value;
  }
  return null;
}

function argValue(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

const CLAMPED: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

async function preflight(key: string | null): Promise<number> {
  if (key === null) {
    process.stderr.write(
      "not logged in: no OpenRouter key in $OPENROUTER_API_KEY or ~/.config/openrouter/key\n"
    );
    return 1;
  }
  const response = await fetch(`${BASE}/key`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    process.stderr.write(`not logged in: key check returned HTTP ${response.status}\n`);
    return 1;
  }
  process.stdout.write("logged in (openrouter key valid)\n");
  return 0;
}

async function invoke(key: string | null, argv: readonly string[]): Promise<number> {
  const model = argValue(argv, "--model");
  const effort = argValue(argv, "--effort");
  if (model === null || effort === null) {
    process.stderr.write("openrouter-lane: --model and --effort are required\n");
    return 64;
  }
  if (key === null) {
    process.stderr.write("not logged in: no OpenRouter key configured\n");
    return 77;
  }
  const prompt = await new Response(Bun.stdin.stream()).text();
  if (prompt.trim().length === 0) {
    process.stderr.write("openrouter-lane: empty prompt on stdin\n");
    return 64;
  }
  const applied = CLAMPED[effort] ?? "high";
  const response = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      reasoning: { effort: applied },
      usage: { include: true },
    }),
  });
  const raw: unknown = await response.json().catch(() => null);
  const body = (raw ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    const error = (body.error ?? {}) as Record<string, unknown>;
    const message = typeof error.message === "string" ? error.message : `HTTP ${response.status}`;
    const mapped = /model/i.test(message) && /(invalid|not.{0,10}found|unknown)/i.test(message)
      ? `model not found: ${model} (${message})`
      : message;
    process.stderr.write(`openrouter request failed: ${mapped}\n`);
    return response.status === 401 || response.status === 403 ? 77 : 70;
  }
  const choices = body.choices as Array<Record<string, unknown>> | undefined;
  const messageObj = (choices?.[0]?.message ?? {}) as Record<string, unknown>;
  const text = typeof messageObj.content === "string" ? messageObj.content : "";
  if (text.length === 0) {
    process.stderr.write("openrouter returned an empty completion\n");
    return 70;
  }
  const usage = (body.usage ?? {}) as Record<string, unknown>;
  const details = (usage.completion_tokens_details ?? {}) as Record<string, unknown>;
  const envelope = {
    kind: "openrouter-lane.v1",
    result: text,
    model: typeof body.model === "string" ? body.model : model,
    requested_effort: effort,
    applied_effort: applied,
    usage: {
      input_tokens: usage.prompt_tokens ?? null,
      output_tokens: usage.completion_tokens ?? null,
      reasoning_tokens: details.reasoning_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
    },
    cost_usd: typeof usage.cost === "number" ? usage.cost : null,
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return 0;
}

const argv = process.argv.slice(2);
const key = apiKey();
process.exitCode = argv.includes("--preflight")
  ? await preflight(key)
  : await invoke(key, argv);
