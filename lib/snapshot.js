/**
 * Session snapshot construction for `dsh-jev-review`.
 *
 * Produces the exact `state` value sent to the Jev decision model:
 * `{ policy, environment, project_instructions, filtered_history,
 * pending_action }`, plus an explicit `truncated_history` marker when the
 * pre-send budget pass had to drop history.
 *
 * Every session access is defensive: the DSH session APIs used here
 * (`snapshotEvents()`, `surface.nodes`, `requestHeader()`, `header.cwd`) are
 * optional and can throw, so a failure degrades to a minimal state instead of
 * failing the tool call. The pending action itself is never dropped; only its
 * over-long string values are clipped.
 *
 * @module dsh-jev-review/snapshot
 */

import { REVIEW_POLICY } from "./policy.js";

/** Source-role labels every retained history entry carries. */
export const ROLES = Object.freeze({
  HUMAN: "human-instruction",
  PARENT: "direct-parent-instruction",
  CONSTRAINT: "constraint",
  CHECKPOINT: "checkpoint",
  FACT: "fact",
});

/** Run a getter, returning `undefined` instead of throwing. */
function read(getter) {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

/** Whether a value is a plain object record. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Clip every string inside a JSON value so one oversized argument (a file body,
 * an image payload) cannot blow the context window.
 *
 * @param value - any JSON value.
 * @param maxChars - the per-string cap.
 * @param depth - internal recursion guard.
 * @returns a structurally equal value with every string clipped.
 */
export function clip(value, maxChars, depth = 0) {
  if (typeof value === "string") {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}…[clipped ${value.length - maxChars} chars]`;
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= 12) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => clip(item, maxChars, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = clip(item, maxChars, depth + 1);
  return out;
}

/** Keep only the identifying fields of a message source. */
function compactSource(source) {
  if (!isRecord(source)) return undefined;
  const out = {};
  for (const key of ["kind", "rpcId", "senderSessionId", "sessionId", "name"]) {
    if (typeof source[key] === "string") out[key] = source[key];
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Whether a message source is a durable human instruction from the shipped Web. */
function isHumanInstruction(source) {
  return source?.kind === "user" && typeof source.rpcId === "string";
}

/**
 * Classify one text block into its source role.
 *
 * Only `human-instruction` and `direct-parent-instruction` can authorize an
 * action; constraints narrow, checkpoints restore, facts only report.
 */
export function textRole(source, seq, initialPromptSeq, parentSession) {
  if (isHumanInstruction(source)) return ROLES.HUMAN;
  if (initialPromptSeq !== undefined && seq === initialPromptSeq) return ROLES.PARENT;
  if (
    source?.kind === "agent-message" &&
    parentSession !== undefined &&
    source.senderSessionId === parentSession
  ) {
    return ROLES.PARENT;
  }
  if (source?.kind === "agent-instructions") return ROLES.CONSTRAINT;
  if (source?.kind === "compact-checkpoint") return ROLES.CHECKPOINT;
  return ROLES.FACT;
}

/**
 * Find the visible sequence of the in-process child's creation prompt, so the
 * direct parent's instruction is labelled as such rather than as a fact.
 *
 * @returns the sequence number, or `undefined` for non-subagent sessions.
 */
function directParentInitialPromptSeq(session, ordered) {
  const header = read(() => session.header);
  if (!isRecord(header) || header.origin !== "subagent" || header.parentSession === undefined) {
    return undefined;
  }
  let passedCreationBoundary = false;
  for (const { seq, event } of ordered) {
    if (read(() => session.isOwnSeq(event?.seq)) === false) continue;
    if (event?.type === "subagent/descriptor") {
      passedCreationBoundary = true;
      continue;
    }
    if (
      passedCreationBoundary &&
      event?.type === "user/message" &&
      event?.data?.source?.kind === "user" &&
      !isHumanInstruction(event.data.source)
    ) {
      return seq;
    }
  }
  return undefined;
}

/** Parse a logged raw argument string back into JSON when possible. */
function parseArguments(raw) {
  if (typeof raw !== "string") return raw;
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Build the `pending_action` section. Never returns `undefined`. */
function pendingAction(exec, config) {
  const action = {
    mode: read(() => exec.parent) === undefined ? "native" : "ptc-inner",
    name: typeof read(() => exec.name) === "string" ? exec.name : "unknown",
    arguments: clip(read(() => exec.arguments) ?? null, config.maxStringChars),
  };
  const schema = read(() => exec.schema);
  if (isRecord(schema)) {
    action.schema = clip({ name: schema.name, description: schema.description }, config.maxStringChars);
  }
  const callId = read(() => exec.callId);
  if (typeof callId === "string") action.call_id = callId;
  return action;
}

/** Best-effort tool description from the session's last request header. */
function headerToolDescription(session, name) {
  const header = read(() => session.requestHeader());
  const tools = read(() => (isRecord(header) ? header.tools : undefined));
  if (!Array.isArray(tools)) return undefined;
  const matches = tools.filter((tool) => isRecord(tool) && tool.name === name);
  if (matches.length !== 1) return undefined;
  const description = matches[0].description;
  return typeof description === "string" ? description : undefined;
}

/** Collect the retained project instructions and history from one session. */
function collectSections(session, exec, config, degraded) {
  const projectInstructions = [];
  const history = [];
  const events = read(() => session.snapshotEvents());
  const nodes = read(() => [...session.surface.nodes]);
  if (!Array.isArray(events)) {
    degraded.push("session.snapshotEvents() unavailable: the retained history may be incomplete");
  }
  if (!Array.isArray(nodes)) {
    degraded.push("session.surface.nodes unavailable: the retained history order is unknown");
  }
  const eventList = Array.isArray(events) ? events : [];
  const ordered = Array.isArray(nodes) && nodes.length > 0
    ? nodes.map((seq) => ({ seq, event: eventList[seq] })).filter((item) => item.event !== undefined)
    : eventList.map((event, seq) => ({ seq, event }));

  const parentSession = read(() => session.header?.parentSession);
  const initialPromptSeq = directParentInitialPromptSeq(session, ordered);
  const pendingRootId = read(() => exec.rootCallId);
  const pendingCallId = read(() => exec.callId);

  for (const { seq, event } of ordered) {
    if (!isRecord(event)) continue;
    if (event.type === "user/message") {
      const data = event.data;
      const source = read(() => data.source);
      if (!isRecord(data)) continue;
      if (read(() => source.kind) === "tool") continue;
      const content = Array.isArray(data.content) ? data.content : [];
      if (read(() => source.kind) === "agent-instructions") {
        if (content.length > 0) {
          projectInstructions.push({
            kind: "user-message",
            role: ROLES.CONSTRAINT,
            source: compactSource(source),
            content,
          });
        }
        continue;
      }
      for (const block of content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          history.push({
            kind: "user-message",
            role: textRole(source, seq, initialPromptSeq, parentSession),
            source: compactSource(source),
            content: [{ type: "text", text: block.text }],
          });
        } else {
          history.push({
            kind: "user-message",
            role: ROLES.FACT,
            source: compactSource(source),
            content: [
              {
                type: isRecord(block) && typeof block.type === "string" ? block.type : "unknown",
                note: "non-text content (fact); its data is omitted from this review",
              },
            ],
          });
        }
      }
      continue;
    }
    if (event.type === "assistant/message") {
      const blocks = read(() => event.data.message.content);
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (!isRecord(block) || block.type !== "tool-call") continue;
        if (block.id === pendingRootId || block.id === pendingCallId) continue;
        history.push({
          kind: "tool-call",
          role: ROLES.FACT,
          mode: "native",
          name: typeof block.name === "string" ? block.name : "unknown",
          arguments: parseArguments(block.arguments),
        });
      }
      continue;
    }
    if (event.type === "tool/ptc-dispatch-start") {
      const data = read(() => event.data);
      if (!isRecord(data)) continue;
      if (data.subCallId === pendingCallId) continue;
      history.push({
        kind: "tool-call",
        role: ROLES.FACT,
        mode: "ptc-inner",
        name: typeof data.name === "string" ? data.name : "unknown",
        arguments: parseArguments(data.arguments),
      });
    }
  }

  if (history.length > config.maxHistoryEntries) {
    const before = history.length;
    let excess = history.length - config.maxHistoryEntries;
    // The entry-count cap never discards a human instruction: those are the
    // only records that can authorize anything.
    for (let index = 0; index < history.length && excess > 0; ) {
      if (history[index]?.role === ROLES.HUMAN) {
        index += 1;
        continue;
      }
      history.splice(index, 1);
      excess -= 1;
    }
    if (history.length > config.maxHistoryEntries) {
      history.splice(0, history.length - config.maxHistoryEntries);
    }
    degraded.push(`history capped at ${config.maxHistoryEntries} entries (dropped ${before - history.length})`);
  }
  return { projectInstructions, history };
}

/** Index of the most recent human instruction, which the budget pass protects. */
function lastHumanIndex(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === ROLES.HUMAN) return index;
  }
  return -1;
}

/**
 * Machine-generated runs long enough that the prose divisor under-counts them.
 *
 * Measured against the gateway: English prose is ~4.8 chars/token while a
 * hexadecimal dump is ~1.0 char/token. A single divisor therefore under-counts a
 * hex-heavy state by ~5x; such a request exceeds the model's window and then
 * fails closed on every call, which is exactly how a whole session locked itself
 * out once.
 */
const DENSE_RUN = /[A-Za-z0-9+/=_-]{24,}/g;

/**
 * Estimate the tokens of one serialized state, charging dense machine-generated
 * runs at their own rate.
 *
 * @param text - the serialized state.
 * @param config - resolved configuration (`charsPerToken`, `denseCharsPerToken`).
 * @returns the estimated token count.
 */
export function estimateTokens(text, config) {
  let dense = 0;
  for (const match of text.matchAll(DENSE_RUN)) dense += match[0].length;
  const plain = Math.max(0, text.length - dense);
  const tokens = plain / config.charsPerToken + dense / config.denseCharsPerToken;
  return Math.ceil(tokens);
}

/** Estimated token count of the serialized state. */
function measure(state, config) {
  const text = JSON.stringify(state);
  return { text, bytes: text.length, estimatedTokens: estimateTokens(text, config) };
}

/**
 * Estimated tokens reserved for the markers added after the fit pass
 * (`truncated_history` and the final `review_notes` line), so the state that is
 * actually sent still fits the configured budget.
 */
const BUDGET_RESERVE_TOKENS = 256;

/**
 * Drop history until the serialized state fits the estimated-token budget.
 *
 * Drop order, oldest first inside each tier: (0) retained tool calls, (1) other
 * facts and checkpoints, (2) remaining entries except the most recent human
 * instruction. `policy`, `environment`, `project_instructions` and
 * `pending_action` are never dropped; a drop is recorded in
 * `state.truncated_history` so the decision model knows it did not see
 * everything.
 */
function fitBudget(state, config, droppedBefore) {
  const budget = Math.max(1, config.stateBudgetTokens - BUDGET_RESERVE_TOKENS);
  // A hard character ceiling as well as a token estimate: 24k dense characters
  // still fit a 32k window even if the estimator were wrong by every factor.
  const charCap = Math.max(1000, Number.isFinite(config.maxStateChars) ? config.maxStateChars : 24000);
  const overBudget = (measured) => measured.estimatedTokens > budget || measured.bytes > charCap;
  let dropped = droppedBefore;
  if (dropped > 0) {
    state.truncated_history = { dropped, reason: "budget", budget_tokens: config.stateBudgetTokens };
  }
  let measured = measure(state, config);
  if (!overBudget(measured)) return { ...measured, dropped };

  const droppable = (entry, tier) => {
    if (tier === 0) return entry?.kind === "tool-call";
    if (tier === 1) return entry?.role === ROLES.FACT || entry?.role === ROLES.CHECKPOINT;
    return true;
  };

  for (const tier of [0, 1, 2]) {
    while (overBudget(measured)) {
      const history = state.filtered_history;
      const protectedIndex = lastHumanIndex(history);
      let index = -1;
      for (let candidate = 0; candidate < history.length; candidate += 1) {
        if (candidate === protectedIndex) continue;
        if (!droppable(history[candidate], tier)) continue;
        index = candidate;
        break;
      }
      if (index < 0) break;
      history.splice(index, 1);
      dropped += 1;
      measured = measure(state, config);
    }
    if (!overBudget(measured)) break;
  }

  if (dropped > droppedBefore) {
    state.truncated_history = { dropped, reason: "budget", budget_tokens: config.stateBudgetTokens };
  }
  return { ...measure(state, config), dropped };
}

/**
 * Build the complete state for one pending execution.
 *
 * @param agent - the agent owning the call; its `session` is optional.
 * @param exec - the pending tool execution.
 * @param config - resolved configuration (`maxStringChars`, `maxHistoryEntries`,
 *   `stateBudgetTokens`, `charsPerToken`).
 * @returns `{ state, degraded, dropped, bytes, estimatedTokens, text }`. Always
 *   succeeds: a missing or throwing session yields a minimal state that still
 *   carries the policy, the environment, a compaction note and the pending
 *   action.
 */
export function buildState(agent, exec, config) {
  const degraded = [];
  const session = read(() => agent?.session);

  let cwd;
  try {
    cwd = read(() => session?.header?.cwd);
  } catch {
    cwd = undefined;
  }
  if (typeof cwd !== "string" || cwd === "") {
    cwd = read(() => process.cwd()) ?? "unknown";
  }

  const state = {
    policy: REVIEW_POLICY,
    environment: {
      cwd,
      os: `${read(() => process.platform) ?? "unknown"}/${read(() => process.arch) ?? "unknown"}`,
    },
    project_instructions: [],
    filtered_history: [],
    pending_action: pendingAction(exec, config),
  };

  if (session === undefined || session === null) {
    degraded.push("no session available: only the pending action and environment were reviewed");
  } else {
    try {
      const { projectInstructions, history } = collectSections(session, exec, config, degraded);
      state.project_instructions = clip(projectInstructions, config.maxStringChars);
      state.filtered_history = clip(history, config.maxStringChars);
    } catch (error) {
      degraded.push(`session snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const description = session === undefined ? undefined : read(() => headerToolDescription(session, state.pending_action.name));
  if (typeof description === "string" && description !== "") {
    state.pending_action.description = clip(description, config.maxStringChars);
  }

  if (degraded.length > 0) state.review_notes = degraded;
  const fitted = fitBudget(state, config, 0);
  if (fitted.dropped > 0) {
    degraded.push(`history trimmed to fit the ${config.stateBudgetTokens}-token budget (dropped ${fitted.dropped})`);
    state.review_notes = degraded;
    // Re-measure: adding the note may push the state marginally over; the note is tiny.
    const remeasured = measure(state, config);
    return { state, ...remeasured, degraded, dropped: fitted.dropped };
  }
  return { state, ...fitted, degraded, dropped: 0 };
}
