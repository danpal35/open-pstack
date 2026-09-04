import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { invocationCommand, preflightCommand, type CommandSpec } from "./commands.ts";
import { parseProviderOutput, reportedModelMatches } from "./parse-output.ts";
import type {
  Provider,
  ReceiptStatus,
  RunnerOptions,
  RunnerReceipt,
} from "./types.ts";
import { UsageError } from "./types.ts";

const ERROR_EVIDENCE_LIMIT = 4_000;
const GROK_PREFLIGHT_RETRY_DELAY_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelledBy: CancellationSignal | null;
}

type CancellationSignal = "SIGINT" | "SIGTERM";

interface RunCancellation {
  readonly promise: Promise<CancellationSignal>;
  readonly signal: CancellationSignal | null;
  dispose(): void;
}

type RetryWaitResult = "ready" | "cancelled" | "timed-out";

export interface RunResult {
  readonly exitCode: number;
  readonly receipt: RunnerReceipt;
}

function evidence(value: string): string {
  return value.trim().slice(0, ERROR_EVIDENCE_LIMIT);
}

function removeIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function reserve(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, "wx", 0o600);
  closeSync(descriptor);
}

function reserveOutputs(options: RunnerOptions): void {
  if (options.outputPath === options.receiptPath) {
    throw new UsageError("output and receipt paths must differ");
  }
  reserve(options.outputPath);
  try {
    reserve(options.receiptPath);
  } catch (error) {
    removeIfExists(options.outputPath);
    throw error;
  }
}

function writeReceipt(path: string, receipt: RunnerReceipt): void {
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function installRunCancellation(): RunCancellation {
  let signal: CancellationSignal | null = null;
  let resolveCancellation!: (value: CancellationSignal) => void;
  const promise = new Promise<CancellationSignal>((resolve) => {
    resolveCancellation = resolve;
  });

  const receive = (next: CancellationSignal): void => {
    if (signal === null) {
      signal = next;
      resolveCancellation(next);
    }
  };
  const onInterrupt = (): void => receive("SIGINT");
  const onTerminate = (): void => receive("SIGTERM");
  globalThis.process.on("SIGINT", onInterrupt);
  globalThis.process.on("SIGTERM", onTerminate);

  return {
    promise,
    get signal() {
      return signal;
    },
    dispose() {
      globalThis.process.off("SIGINT", onInterrupt);
      globalThis.process.off("SIGTERM", onTerminate);
    },
  };
}

const CODEX_IDENTITY = [
  "CODEX_THREAD_ID",
  "CODEX_SESSION_ID",
  "CODEX_CI",
  "CODEX_SHELL",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
] as const;

const CLAUDE_IDENTITY = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS",
] as const;

export function childEnvironment(
  provider: Provider,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result = { ...source };
  const remove = provider === "claude"
    ? CODEX_IDENTITY
    : provider === "codex"
      ? CLAUDE_IDENTITY
      : [...CODEX_IDENTITY, ...CLAUDE_IDENTITY];
  for (const key of remove) delete result[key];
  return result;
}

interface PreparedChildEnvironment {
  readonly env: NodeJS.ProcessEnv;
  dispose(): void;
}

function sourceGrokHome(source: NodeJS.ProcessEnv): string | null {
  if (source.GROK_HOME !== undefined && source.GROK_HOME.length > 0) {
    return source.GROK_HOME;
  }
  return source.HOME === undefined || source.HOME.length === 0
    ? null
    : join(source.HOME, ".grok");
}

function grokIsolationConfig(shellHome: string | undefined): string {
  const lines = [
    "[cli]",
    "use_leader = false",
    "auto_update = false",
    "",
    "[compat.claude]",
    "agents = false",
    "hooks = false",
    "mcps = false",
    "rules = false",
    "skills = false",
    "",
    "[compat.cursor]",
    "agents = false",
    "hooks = false",
    "mcps = false",
    "rules = false",
    "skills = false",
    "",
    "[compat.codex]",
    "hooks = false",
    "skills = false",
  ];
  if (shellHome !== undefined && shellHome.length > 0) {
    lines.push(
      "",
      "[shell_environment_policy.set]",
      `HOME = ${JSON.stringify(shellHome)}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function prepareChildEnvironment(
  provider: Provider,
  source: NodeJS.ProcessEnv = process.env
): PreparedChildEnvironment {
  const env = childEnvironment(provider, source);
  if (provider !== "grok") return { env, dispose() {} };

  const isolatedHome = mkdtempSync(join(tmpdir(), "pstack-grok-home-"));
  try {
    chmodSync(isolatedHome, 0o700);
    const originalHome = sourceGrokHome(source);
    const originalAuth = originalHome === null ? null : join(originalHome, "auth.json");
    if (originalAuth !== null && existsSync(originalAuth)) {
      const isolatedAuth = join(isolatedHome, "auth.json");
      copyFileSync(originalAuth, isolatedAuth);
      chmodSync(isolatedAuth, 0o600);
    }
    const isolatedConfig = join(isolatedHome, "config.toml");
    writeFileSync(isolatedConfig, grokIsolationConfig(source.HOME), { mode: 0o600 });

    env.HOME = isolatedHome;
    env.GROK_HOME = isolatedHome;
    delete env.GROK_CONFIG;
    delete env.GROK_CONFIG_PATH;
    env.GROK_CLAUDE_AGENTS_ENABLED = "0";
    env.GROK_CLAUDE_HOOKS_ENABLED = "0";
    env.GROK_CLAUDE_MCPS_ENABLED = "0";
    env.GROK_CLAUDE_RULES_ENABLED = "0";
    env.GROK_CLAUDE_SKILLS_ENABLED = "0";
    env.GROK_CURSOR_AGENTS_ENABLED = "0";
    env.GROK_CURSOR_HOOKS_ENABLED = "0";
    env.GROK_CURSOR_MCPS_ENABLED = "0";
    env.GROK_CURSOR_RULES_ENABLED = "0";
    env.GROK_CURSOR_SKILLS_ENABLED = "0";
    env.GROK_CODEX_HOOKS_ENABLED = "0";
    env.GROK_CODEX_MCPS_ENABLED = "0";
    env.GROK_CODEX_SKILLS_ENABLED = "0";
    env.GROK_MANAGED_CONFIG = "0";
    env.GROK_MANAGED_MCPS_ENABLED = "0";

    return {
      env,
      dispose() {
        rmSync(isolatedHome, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(isolatedHome, { recursive: true, force: true });
    throw error;
  }
}

async function terminate(
  child: Bun.Subprocess,
  signal: CancellationSignal = "SIGTERM"
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  child.kill(signal);
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let exited: boolean;
  try {
    exited = await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    if (graceTimer !== null) clearTimeout(graceTimer);
  }
  if (!exited) {
    child.kill("SIGKILL");
    await child.exited;
  }
  return true;
}

interface StreamCapture {
  readonly result: Promise<string>;
  cancel(): Promise<void>;
}

function captureStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (bytes: number) => void
): StreamCapture {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let cancellationRequested = false;

  const result = (async (): Promise<string> => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        onChunk(next.value.byteLength);
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
      return text;
    } catch (error) {
      text += decoder.decode();
      if (!cancellationRequested) throw error;
      return text;
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    result,
    async cancel() {
      cancellationRequested = true;
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed and its reader released.
      }
    },
  };
}

type ProcessEvent =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "cancelled"; readonly signal: CancellationSignal }
  | { readonly kind: "timed-out" };

interface RunProgress {
  readonly heartbeatMs: number;
  emit(value: string): void;
}

const DEFAULT_RUN_PROGRESS: RunProgress = {
  heartbeatMs: 30_000,
  emit: (value) => process.stderr.write(value),
};

async function runProcess(
  executable: string,
  spec: CommandSpec,
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  deadlineAt: number | null,
  cancellation: RunCancellation,
  progressLabel: string,
  progress: RunProgress
): Promise<ProcessResult> {
  const processStarted = Date.now();
  const child = Bun.spawn([executable, ...spec.args], {
    cwd,
    env,
    stdin: spec.stdin === "prompt" ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutCapture = captureStream(child.stdout, (bytes) => {
    stdoutBytes += bytes;
  });
  const stderrCapture = captureStream(child.stderr, (bytes) => {
    stderrBytes += bytes;
  });
  const heartbeatTimer = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - processStarted) / 1_000);
    progress.emit(
      `[pstack-runner] ${progressLabel} still running after ${elapsedSeconds}s; `
      + `received ${stdoutBytes} stdout bytes and ${stderrBytes} stderr bytes\n`
    );
  }, progress.heartbeatMs);
  const streams = Promise.all([stdoutCapture.result, stderrCapture.result]);
  const exited = child.exited.then((exitCode): ProcessEvent => ({
    kind: "exited",
    exitCode,
  }));
  const cancelled = cancellation.promise.then((signal): ProcessEvent => ({
    kind: "cancelled",
    signal,
  }));
  const deadline: Promise<ProcessEvent> | null = deadlineAt === null
    ? null
    : new Promise((resolve) => {
      const arm = (): void => {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          resolve({ kind: "timed-out" });
          return;
        }
        deadlineTimer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
      };
      arm();
    });
  try {
    if (spec.stdin === "prompt") {
      const stdin = child.stdin;
      if (stdin === undefined) throw new Error("child stdin pipe was not created");
      stdin.write(prompt);
      stdin.end();
    }

    const completions = [exited, cancelled];
    if (deadline !== null) completions.push(deadline);
    const first = await Promise.race(completions);

    let outcome = first;
    let captured: readonly [string, string] | null = null;
    let signalSent: CancellationSignal | null = null;

    if (first.kind === "exited") {
      const drains: Array<Promise<
        | { readonly kind: "drained"; readonly captured: readonly [string, string] }
        | ProcessEvent
      >> = [
        streams.then((value) => ({ kind: "drained" as const, captured: value })),
        cancelled,
      ];
      if (deadline !== null) drains.push(deadline);
      const drain = await Promise.race(drains);
      if (drain.kind === "drained") {
        captured = drain.captured;
        if (deadlineAt !== null && Date.now() >= deadlineAt) {
          outcome = { kind: "timed-out" };
        }
      } else {
        outcome = drain;
      }
    }

    const cancelledBy = cancellation.signal;
    const timedOut = cancelledBy === null && outcome.kind === "timed-out";
    if (cancelledBy !== null) {
      if (await terminate(child, cancelledBy)) signalSent = cancelledBy;
    } else if (timedOut) {
      if (await terminate(child)) signalSent = "SIGTERM";
    }
    if (captured === null) {
      await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
      captured = await streams;
    }

    return {
      exitCode: await child.exited,
      signal: signalSent,
      stdout: captured[0],
      stderr: captured[1],
      timedOut,
      cancelledBy,
    };
  } catch (error) {
    await terminate(child, cancellation.signal ?? "SIGTERM");
    await Promise.all([stdoutCapture.cancel(), stderrCapture.cancel()]);
    await Promise.allSettled([stdoutCapture.result, stderrCapture.result]);
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

async function waitForGrokPreflightRetry(
  deadlineAt: number | null,
  cancellation: RunCancellation
): Promise<RetryWaitResult> {
  if (cancellation.signal !== null) return "cancelled";

  const now = Date.now();
  if (deadlineAt !== null && now >= deadlineAt) return "timed-out";

  const retryAt = now + GROK_PREFLIGHT_RETRY_DELAY_MS;
  const wakeAt = deadlineAt === null ? retryAt : Math.min(retryAt, deadlineAt);
  const timerResult: RetryWaitResult = wakeAt < retryAt ? "timed-out" : "ready";
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const result = await Promise.race([
      cancellation.promise.then((): RetryWaitResult => "cancelled"),
      new Promise<RetryWaitResult>((resolve) => {
        timer = setTimeout(() => resolve(timerResult), wakeAt - now);
      }),
    ]);
    if (cancellation.signal !== null) return "cancelled";
    if (deadlineAt !== null && Date.now() >= deadlineAt) return "timed-out";
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function preflightPassed(provider: Provider, model: string, result: ProcessResult): boolean {
  if (result.exitCode !== 0 || result.timedOut) return false;
  const combined = `${result.stdout}\n${result.stderr}`;
  switch (provider) {
    case "claude": {
      try {
        const value: unknown = JSON.parse(result.stdout);
        return (
          value !== null &&
          typeof value === "object" &&
          (value as { loggedIn?: unknown }).loggedIn === true
        );
      } catch {
        return false;
      }
    }
    case "codex":
      return /logged in/i.test(combined);
    case "grok":
      return /logged in/i.test(combined) && combined.includes(model);
    case "openrouter":
      return /logged in/i.test(combined);
  }
}

function successfulPreflightEvidence(provider: Provider, model: string): string {
  return provider === "grok"
    ? `authenticated; model ${model} available`
    : "authenticated";
}

function unavailableStatus(value: string): ReceiptStatus {
  if (/not logged in|unauthenticated|authentication|sign in|login required/i.test(value)) {
    return "unauthenticated";
  }
  if (/model.{0,40}(not found|unknown|unavailable|unsupported|not supported|invalid)|invalid.{0,20}model/i.test(value)) {
    return "unavailable-model";
  }
  return "child-failed";
}

function preflightFailureStatus(
  provider: Provider,
  model: string,
  value: string
): ReceiptStatus {
  const status = unavailableStatus(value);
  if (status !== "child-failed") return status;
  return provider === "grok" && !value.includes(model)
    ? "unavailable-model"
    : "unauthenticated";
}

function retriedPreflightEvidence(
  first: string,
  second: string,
  secondPassed: boolean
): string {
  const firstLabel = "attempt 1 failed:\n";
  const secondLabel = `\n\nattempt 2 ${secondPassed ? "passed" : "failed"}:\n`;
  const payloadLimit = ERROR_EVIDENCE_LIMIT - firstLabel.length - secondLabel.length;
  const firstLimit = Math.floor(payloadLimit / 2);
  const secondLimit = payloadLimit - firstLimit;
  return `${firstLabel}${first.slice(0, firstLimit)}${secondLabel}${second.slice(0, secondLimit)}`;
}

function statusExitCode(status: ReceiptStatus): number {
  switch (status) {
    case "complete":
      return 0;
    case "cancelled":
      return 130;
    case "malformed-output":
      return 65;
    case "unavailable-cli":
    case "unavailable-model":
      return 69;
    case "child-failed":
      return 70;
    case "unauthenticated":
      return 77;
    case "timed-out":
      return 124;
  }
}

function modelProof(
  provider: Provider,
  requested: string,
  reported: string | null
): {
  readonly reportedModel: string | null;
  readonly modelVerified: boolean;
  readonly modelEvidence: "provider-report" | "pinned-argv" | null;
} {
  if (reportedModelMatches(requested, reported)) {
    return {
      reportedModel: reported,
      modelVerified: true,
      modelEvidence: "provider-report",
    };
  }
  if (provider === "codex" && reported === null) {
    return {
      reportedModel: null,
      modelVerified: false,
      modelEvidence: "pinned-argv",
    };
  }
  return {
    reportedModel: reported,
    modelVerified: false,
    modelEvidence: null,
  };
}

function completeReceipt(
  options: RunnerOptions,
  partial: Omit<RunnerReceipt, "schemaVersion" | "parent" | "provider" | "model" | "effort" | "mode" | "cwd" | "promptPath" | "outputPath">
): RunnerReceipt {
  return {
    schemaVersion: 1,
    parent: options.parent,
    provider: options.provider,
    model: options.model,
    effort: options.effort,
    mode: options.mode,
    cwd: options.cwd,
    promptPath: options.promptPath,
    outputPath: options.outputPath,
    ...partial,
  };
}

export function validateOptions(options: RunnerOptions): void {
  if (options.parent !== "grok" && options.parent === options.provider) {
    throw new UsageError(
      `provider ${options.provider} is native to parent ${options.parent}; use the parent subagent primitive`
    );
  }
  if (options.provider === "openrouter" && options.mode === "isolated-write") {
    throw new UsageError(
      "openrouter is a one-shot API lane with no tools; only read-only mode is supported"
    );
  }
  if (options.model.trim().length === 0) throw new UsageError("model must not be empty");
  if (
    options.timeoutMs !== null &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new UsageError("timeout must be greater than zero");
  }
  if (!existsSync(options.promptPath) || !statSync(options.promptPath).isFile()) {
    throw new UsageError(`prompt is not a file: ${options.promptPath}`);
  }
  if (!existsSync(options.cwd) || !statSync(options.cwd).isDirectory()) {
    throw new UsageError(`cwd is not a directory: ${options.cwd}`);
  }
  if (
    options.promptPath === options.outputPath ||
    options.promptPath === options.receiptPath
  ) {
    throw new UsageError("prompt, output, and receipt paths must be distinct");
  }
}

interface LaneProgress {
  executable: string | null;
  preflight: RunnerReceipt["preflight"];
  argv: readonly string[];
}

async function executeLane(
  options: RunnerOptions,
  cancellation: RunCancellation,
  started: number,
  deadlineAt: number | null,
  invocation: CommandSpec,
  preflight: CommandSpec,
  progress: LaneProgress,
  env: NodeJS.ProcessEnv,
  runProgress: RunProgress
): Promise<RunResult> {
  const startedAt = new Date(started).toISOString();
  const prompt = readFileSync(options.promptPath, "utf8");
  const executable = Bun.which(invocation.command, {
    PATH: env.PATH,
    cwd: options.cwd,
  });
  progress.executable = executable;
  progress.argv = [executable ?? invocation.command, ...invocation.args];

  let preflightState = progress.preflight;
  let receipt: RunnerReceipt;

  const finishWithoutChild = (
    status: "cancelled" | "timed-out",
    phase: string
  ): RunResult => {
    const completed = Date.now();
    const receivedSignal = status === "cancelled" ? cancellation.signal : null;
    const terminalPreflight = preflightState.status === "not-run"
      ? { ...preflightState, status }
      : preflightState;
    receipt = completeReceipt(options, {
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: terminalPreflight,
      argv: [executable ?? invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: receivedSignal === null
          ? `explicit deadline elapsed ${phase}`
          : `launcher received ${receivedSignal} ${phase}`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  };

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before authentication preflight");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before authentication preflight");
  }

  if (executable === null) {
    const completed = Date.now();
    receipt = completeReceipt(options, {
      status: "unavailable-cli",
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable: null,
      preflight: preflightState,
      argv: [invocation.command, ...invocation.args],
      exitCode: null,
      signal: null,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: `${invocation.command} executable not found`,
        evidence: "",
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(receipt.status), receipt };
  }

  const preflightExecutable = executable;
  let preflightResult = await runProcess(
    preflightExecutable,
    preflight,
    options.cwd,
    env,
    "",
    deadlineAt,
    cancellation,
    `${options.provider} preflight`,
    runProgress
  );
  let rawPreflightEvidence = evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`);
  let passed = preflightPassed(options.provider, options.model, preflightResult);
  let preflightEvidence = passed
    ? successfulPreflightEvidence(options.provider, options.model)
    : rawPreflightEvidence;

  if (
    options.provider === "grok" &&
    !passed &&
    preflightResult.cancelledBy === null &&
    !preflightResult.timedOut &&
    preflightFailureStatus(options.provider, options.model, rawPreflightEvidence) ===
      "unauthenticated"
  ) {
    preflightState = {
      argv: [preflightExecutable, ...preflight.args],
      status: "failed",
      evidence: rawPreflightEvidence,
    };
    progress.preflight = preflightState;

    const retryWait = await waitForGrokPreflightRetry(deadlineAt, cancellation);
    if (retryWait !== "ready") {
      preflightState = {
        ...preflightState,
        status: retryWait === "cancelled" ? "cancelled" : "timed-out",
      };
      progress.preflight = preflightState;
      return finishWithoutChild(
        retryWait === "cancelled" ? "cancelled" : "timed-out",
        "during authentication preflight retry delay"
      );
    }

    const firstPreflightEvidence = rawPreflightEvidence;
    preflightResult = await runProcess(
      preflightExecutable,
      preflight,
      options.cwd,
      env,
      "",
      deadlineAt,
      cancellation,
      `${options.provider} preflight retry`,
      runProgress
    );
    rawPreflightEvidence = evidence(`${preflightResult.stdout}\n${preflightResult.stderr}`);
    passed = preflightPassed(options.provider, options.model, preflightResult);
    preflightEvidence = retriedPreflightEvidence(
      firstPreflightEvidence,
      passed
        ? successfulPreflightEvidence(options.provider, options.model)
        : rawPreflightEvidence,
      passed
    );
  }

  preflightState = {
    argv: [preflightExecutable, ...preflight.args],
    status: preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : passed
          ? "passed"
          : "failed",
    evidence: preflightEvidence,
  };
  progress.preflight = preflightState;

  if (preflightState.status !== "passed") {
    const completed = Date.now();
    const preflightFailure = preflightFailureStatus(
      options.provider,
      options.model,
      rawPreflightEvidence
    );
    const status: ReceiptStatus = preflightResult.cancelledBy !== null
      ? "cancelled"
      : preflightResult.timedOut
        ? "timed-out"
        : preflightFailure;
    receipt = completeReceipt(options, {
      status,
      startedAt,
      completedAt: new Date(completed).toISOString(),
      elapsedMs: completed - started,
      executable,
      preflight: preflightState,
      argv: [executable, ...invocation.args],
      exitCode: preflightResult.exitCode,
      signal: preflightResult.signal,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: preflightResult.cancelledBy !== null
          ? `launcher received ${preflightResult.cancelledBy} during preflight`
          : preflightResult.timedOut
            ? "authentication preflight timed out"
            : "authentication or model preflight failed",
        evidence: preflightEvidence,
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  if (cancellation.signal !== null) {
    return finishWithoutChild("cancelled", "before model execution");
  }
  if (deadlineAt !== null && Date.now() >= deadlineAt) {
    return finishWithoutChild("timed-out", "before model execution");
  }

  const result = await runProcess(
    executable,
    invocation,
    options.cwd,
    env,
    prompt,
    deadlineAt,
    cancellation,
    `${options.provider} model`,
    runProgress
  );
  const completed = Date.now();
  const base = {
    startedAt,
    completedAt: new Date(completed).toISOString(),
    elapsedMs: completed - started,
    executable,
    preflight: preflightState,
    argv: [executable, ...invocation.args],
    exitCode: result.exitCode,
    signal: result.signal,
  } as const;

  if (result.cancelledBy !== null || result.timedOut || result.exitCode !== 0) {
    const rawFailureEvidence = `${result.stderr}\n${result.stdout}`;
    const failureEvidence = evidence(rawFailureEvidence);
    const status: ReceiptStatus = result.cancelledBy !== null
      ? "cancelled"
      : result.timedOut
        ? "timed-out"
        : unavailableStatus(rawFailureEvidence);
    receipt = completeReceipt(options, {
      ...base,
      status,
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message: result.cancelledBy !== null
          ? result.signal === result.cancelledBy
            ? `launcher received ${result.cancelledBy}; signal was sent to child`
            : `launcher received ${result.cancelledBy} after child exited`
          : result.timedOut
            ? `launcher exceeded the explicit ${options.timeoutMs}ms deadline`
            : `child exited with status ${result.exitCode}`,
        evidence: failureEvidence,
      },
    });
    removeIfExists(options.outputPath);
    writeReceipt(options.receiptPath, receipt);
    return { exitCode: statusExitCode(status), receipt };
  }

  try {
    const parsed = parseProviderOutput(
      options.provider,
      result.stdout,
      result.stderr,
      options.model
    );
    const proof = modelProof(
      options.provider,
      options.model,
      parsed.reportedModel
    );
    if (!proof.modelVerified && proof.modelEvidence !== "pinned-argv") {
      throw new Error(
        `requested model ${options.model} was not reported by ${options.provider}`
      );
    }
    writeFileSync(options.outputPath, parsed.text, { encoding: "utf8", mode: 0o600 });
    receipt = completeReceipt(options, {
      ...base,
      status: "complete",
      ...proof,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
      costUsd: parsed.costUsd,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    removeIfExists(options.outputPath);
    receipt = completeReceipt(options, {
      ...base,
      status: "malformed-output",
      reportedModel: null,
      modelVerified: false,
      modelEvidence: null,
      sessionId: null,
      usage: null,
      costUsd: null,
      error: {
        message,
        evidence: evidence(`${result.stderr}\n${result.stdout}`),
      },
    });
  }

  writeReceipt(options.receiptPath, receipt);
  return { exitCode: statusExitCode(receipt.status), receipt };
}

export async function runLane(
  options: RunnerOptions,
  started: number = Date.now(),
  runProgress: RunProgress = DEFAULT_RUN_PROGRESS
): Promise<RunResult> {
  validateOptions(options);
  if (!Number.isFinite(runProgress.heartbeatMs) || runProgress.heartbeatMs <= 0) {
    throw new UsageError("heartbeat interval must be greater than zero");
  }
  const deadlineAt = options.timeoutMs === null ? null : started + options.timeoutMs;
  const invocation = invocationCommand(options);
  const preflight = preflightCommand(options.provider);
  const progress: LaneProgress = {
    executable: null,
    preflight: {
      argv: [preflight.command, ...preflight.args],
      status: "not-run",
      evidence: "",
    },
    argv: [invocation.command, ...invocation.args],
  };
  const cancellation = installRunCancellation();
  let child: PreparedChildEnvironment | null = null;
  try {
    reserveOutputs(options);
    try {
      child = prepareChildEnvironment(options.provider);
      return await executeLane(
        options,
        cancellation,
        started,
        deadlineAt,
        invocation,
        preflight,
        progress,
        child.env,
        runProgress
      );
    } catch (error) {
      const completed = Date.now();
      const signal = cancellation.signal;
      const status: ReceiptStatus = signal !== null
        ? "cancelled"
        : deadlineAt !== null && completed >= deadlineAt
          ? "timed-out"
          : "child-failed";
      const message = error instanceof Error ? error.message : String(error);
      const terminalPreflight = progress.preflight.status === "not-run" && status !== "child-failed"
        ? { ...progress.preflight, status }
        : progress.preflight;
      const receipt = completeReceipt(options, {
        status,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        elapsedMs: completed - started,
        executable: progress.executable,
        preflight: terminalPreflight,
        argv: progress.argv,
        exitCode: null,
        signal: null,
        reportedModel: null,
        modelVerified: false,
        modelEvidence: null,
        sessionId: null,
        usage: null,
        costUsd: null,
        error: {
          message: status === "cancelled"
            ? `launcher received ${signal} after reserving output paths`
            : status === "timed-out"
              ? "explicit deadline elapsed after reserving output paths"
              : "launcher failed after reserving output paths",
          evidence: evidence(message),
        },
      });
      removeIfExists(options.outputPath);
      writeReceipt(options.receiptPath, receipt);
      return { exitCode: statusExitCode(status), receipt };
    }
  } finally {
    child?.dispose();
    cancellation.dispose();
  }
}

export function resolvedOptions(options: RunnerOptions): RunnerOptions {
  return {
    ...options,
    promptPath: resolve(options.promptPath),
    cwd: resolve(options.cwd),
    outputPath: resolve(options.outputPath),
    receiptPath: resolve(options.receiptPath),
  };
}
