import { describe, expect, it } from "bun:test";
import { parseProviderOutput, reportedModelMatches } from "./parse-output.ts";

describe("parseProviderOutput", () => {
  it("extracts Claude text, model, usage, cost, and session", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        session_id: "claude-session",
        usage: { input_tokens: 10, output_tokens: 3 },
        total_cost_usd: 0.05,
        modelUsage: { "claude-fable-5": { inputTokens: 10 } },
      }),
      "",
      "claude-fable-5"
    );
    expect(parsed).toMatchObject({
      text: "CLAUDE_OK",
      reportedModel: "claude-fable-5",
      sessionId: "claude-session",
      usage: { inputTokens: 10, outputTokens: 3 },
      costUsd: 0.05,
    });
  });

  it("extracts Codex JSONL without inventing a provider-reported model", () => {
    const parsed = parseProviderOutput(
      "codex",
      [
        JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "CODEX_OK" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 20,
            cached_input_tokens: 4,
            output_tokens: 5,
            reasoning_output_tokens: 2,
          },
        }),
      ].join("\n"),
      "model: gpt-5.6-sol\nreasoning effort: max\n",
      "gpt-5.6-sol"
    );
    expect(parsed).toMatchObject({
      text: "CODEX_OK",
      reportedModel: null,
      sessionId: "codex-session",
      usage: {
        inputTokens: 20,
        cachedInputTokens: 4,
        outputTokens: 5,
        reasoningTokens: 2,
      },
    });
  });

  it("accepts Grok's reported build suffix", () => {
    const parsed = parseProviderOutput(
      "grok",
      [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "text", text: "progress" }] },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "GROK_OK",
          session_id: "grok-session",
          usage: {
            input_tokens: 30,
            cache_read_input_tokens: 6,
            output_tokens: 7,
            reasoning_tokens: 3,
            total_tokens: 43,
          },
          total_cost_usd: 0.02,
          modelUsage: { "grok-4.6-build": {} },
        }),
      ].join("\n"),
      "",
      "grok-4.6"
    );
    expect(parsed.text).toBe("GROK_OK");
    expect(parsed.reportedModel).toBe("grok-4.6-build");
    expect(reportedModelMatches("grok-4.6", parsed.reportedModel)).toBe(
      true
    );
  });

  it("selects the requested Claude model when usage includes a side model", () => {
    const parsed = parseProviderOutput(
      "claude",
      JSON.stringify({
        result: "CLAUDE_OK",
        modelUsage: {
          "claude-haiku-4-5-20251001": {},
          "claude-fable-5": {},
        },
      }),
      "",
      "claude-fable-5"
    );
    expect(parsed.reportedModel).toBe("claude-fable-5");
  });

  it("rejects malformed or textless responses", () => {
    expect(() =>
      parseProviderOutput("claude", "not-json", "", "claude-fable-5")
    ).toThrow("valid JSON");
    expect(() =>
      parseProviderOutput(
        "codex",
        JSON.stringify({ type: "turn.completed" }),
        "",
        "gpt-5.6-sol"
      )
    ).toThrow("final agent message");
  });
});

describe("openrouter envelope", () => {
  it("extracts text, reported model, usage, and cost from the lane envelope", () => {
    const parsed = parseProviderOutput(
      "openrouter",
      JSON.stringify({
        kind: "openrouter-lane.v1",
        result: "OPENROUTER_OK",
        model: "x-ai/grok-4.6",
        requested_effort: "xhigh",
        applied_effort: "high",
        usage: { input_tokens: 221, output_tokens: 147, reasoning_tokens: 137, total_tokens: 368 },
        cost_usd: 0.001132,
      }),
      "",
      "x-ai/grok-4.6"
    );
    expect(parsed).toMatchObject({
      text: "OPENROUTER_OK",
      reportedModel: "x-ai/grok-4.6",
      sessionId: null,
      usage: { inputTokens: 221, outputTokens: 147, reasoningTokens: 137, totalTokens: 368 },
      costUsd: 0.001132,
    });
  });

  it("rejects output that is not the lane envelope", () => {
    expect(() =>
      parseProviderOutput("openrouter", JSON.stringify({ result: "x" }), "", "m")
    ).toThrow("unexpected envelope");
  });
});
