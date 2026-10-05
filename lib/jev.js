/**
 * Command Code "systemone" client for the `typesafe/jev` decision model.
 *
 * The model is not a chat model: it takes one `state` value plus a record of
 * typed questions and returns calibrated answers. This module owns the
 * transport, the API-key lookup, the timeout and the error normalization; all
 * grading lives in `./rule.js`.
 *
 * The API key is read from `process.env[config.apiKeyEnv]` first and from
 * `refs.<config.apiKeyEnv>` in `~/.dsh/.credentials.yaml` second. The key is
 * never logged, echoed or embedded in an error message.
 *
 * @module dsh-jev-review/jev
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { QUESTIONS } from "./policy.js";

/** One transport or response failure of a Jev review request. */
export class JevReviewError extends Error {
  /**
   * @param message - a short, already-normalized message safe to show a user.
   * @param options - standard error options; `cause` retains the raw failure.
   */
  constructor(message, options) {
    super(message, options);
    this.name = "JevReviewError";
  }
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The default credentials file, resolved lazily so imports never touch it. */
function defaultCredentialsFile() {
  return join(homedir(), ".dsh", ".credentials.yaml");
}

/**
 * Resolve the gateway API key without ever exposing it to logs.
 *
 * @param options - `env` (defaults to `process.env`), `envName` (defaults to
 *   `JEV_API_KEY`) and `credentialsFile` (defaults to
 *   `~/.dsh/.credentials.yaml`).
 * @returns the key, or `undefined` when neither source has one.
 */
export function loadApiKey(options = {}) {
  const env = options.env ?? process.env ?? {};
  const envName = options.envName ?? "JEV_API_KEY";
  const direct = env[envName];
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim();

  let file;
  try {
    file = options.credentialsFile ?? defaultCredentialsFile();
  } catch {
    /* v8 ignore next -- homedir() does not throw in supported runtimes */
    return undefined;
  }
  let contents = "";
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(envName)}[ \\t]*:[ \\t]*(\\S+)[ \\t]*$`, "m");
  const match = pattern.exec(contents);
  if (match === null) return undefined;
  const value = match[1].trim();
  return value === "" ? undefined : value;
}

/**
 * Combine abort signals, tolerating runtimes without `AbortSignal.any`.
 *
 * @param signals - possibly `undefined` signals.
 * @returns one combined signal, or `undefined` when nothing can abort.
 */
export function anySignal(signals) {
  const list = (signals ?? []).filter((signal) => signal !== undefined && signal !== null);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal.any === "function") {
    try {
      return AbortSignal.any(list);
    } catch {
      /* fall through to the manual combinator */
    }
  }
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const signal of list) {
    if (signal.aborted) {
      abort(signal.reason);
      break;
    }
    try {
      signal.addEventListener("abort", () => abort(signal.reason), { once: true });
    } catch {
      /* a non-standard signal object cannot abort us */
    }
  }
  return controller.signal;
}

/**
 * Build a timeout signal for one request, tolerating runtimes without
 * `AbortSignal.timeout`.
 *
 * @param milliseconds - the timeout in milliseconds.
 * @returns `{ signal, cancel }`: the signal and a cleanup function that clears
 *   the underlying timer.
 */
export function timeoutSignal(milliseconds) {
  if (typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(milliseconds), cancel: () => {} };
  }
  /* v8 ignore start -- Node >= 18 has AbortSignal.timeout; kept for portability */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), milliseconds);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
  /* v8 ignore stop */
}

/**
 * Compress a gateway failure into one short, user-safe sentence.
 *
 * A context-window rejection arrives as nested JSON (sometimes doubly nested),
 * so the raw body is never passed through: only a short classification is
 * returned, and the raw text stays in the caller's log if it wants it.
 *
 * @param status - the HTTP status code.
 * @param body - the raw response body.
 * @returns a short classification such as `"context limit"` or `"HTTP 500"`.
 */
export function classifyGatewayFailure(status, body) {
  const text = typeof body === "string" ? body : "";
  if (/max_tokens_exceeded|context[_ ]length|too many tokens|token limit|context window/i.test(text)) {
    return "context limit";
  }
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "endpoint or model not found";
  if (status === 429) return "rate limited";
  if (status === 400 && /typesafe|unsupported_model|invalid/i.test(text)) return "invalid request";
  if (status >= 500) return "gateway error";
  return `HTTP ${status}`;
}

/** Normalize the usage record of one response. */
function normalizeUsage(usage) {
  const record = usage !== null && typeof usage === "object" ? usage : {};
  const input = Number(record.input_tokens);
  const output = Number(record.output_tokens);
  return {
    inputTokens: Number.isFinite(input) ? input : 0,
    outputTokens: Number.isFinite(output) ? output : 0,
  };
}

/**
 * Run one review against the systemone endpoint.
 *
 * @param state - the JSON state to judge; already budgeted by the caller.
 * @param config - resolved configuration (`endpoint`, `model`, `apiKeyEnv`,
 *   `timeoutMs`, plus test-only `env` / `credentialsFile` overrides).
 * @param signal - the caller's abort signal, if any.
 * @returns `{ answers, usage, latencyMs, model }`.
 * @throws {JevReviewError} with a short, normalized message on any failure.
 */
export async function review(state, config, signal) {
  const endpoint = `${String(config.endpoint ?? "").replace(/\/+$/, "")}/systemone`;
  const key = loadApiKey({
    env: config.env ?? process.env,
    envName: config.apiKeyEnv,
    credentialsFile: config.credentialsFile,
  });
  if (key === undefined) {
    throw new JevReviewError(
      `no API key: set ${config.apiKeyEnv ?? "JEV_API_KEY"} or refs.${config.apiKeyEnv ?? "JEV_API_KEY"} in ~/.dsh/.credentials.yaml`,
    );
  }

  const { signal: timer, cancel } = timeoutSignal(config.timeoutMs);
  const combined = anySignal([signal, timer]);
  const started = Date.now();
  let response;
  let body = "";
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: config.model, state, questions: QUESTIONS }),
      signal: combined,
    });
    body = await response.text();
  } catch (error) {
    if (signal !== undefined && signal.aborted) {
      throw new JevReviewError("jev review aborted", { cause: error });
    }
    if (timer.aborted) {
      throw new JevReviewError(`jev review unavailable (timeout after ${config.timeoutMs}ms)`, { cause: error });
    }
    throw new JevReviewError("jev review unavailable (network error)", { cause: error });
  } finally {
    cancel();
  }
  const latencyMs = Date.now() - started;

  if (!response.ok) {
    throw new JevReviewError(`jev review unavailable (${classifyGatewayFailure(response.status, body)})`);
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new JevReviewError("jev review unavailable (malformed response)", { cause: error });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new JevReviewError("jev review unavailable (malformed response)");
  }
  const answers = payload.answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw new JevReviewError("jev review unavailable (response has no answers)");
  }
  return {
    answers,
    usage: normalizeUsage(payload.usage),
    latencyMs,
    model: typeof payload.model === "string" ? payload.model : config.model,
  };
}
