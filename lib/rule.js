/**
 * Pure grading rules for `dsh-jev-review`.
 *
 * `decide(answers, config)` turns one Jev answer set into the plugin's final
 * `allow` / `ask` / `deny` verdict. It is a pure function with no I/O, never
 * throws, and fails closed: a missing or malformed answer is graded as the
 * riskier reading, never as permission. The only hard denial requires positive,
 * non-degraded evidence (sensitive data AND an untrusted destination), so a
 * transient gateway or shape problem can only produce `ask`, never a
 * non-overridable block.
 *
 * @module dsh-jev-review/rule
 */

/** Rank of each reversibility label; higher means harder to undo. */
export const REVERSIBILITY_RANK = Object.freeze({
  trivial: 0,
  simple: 1,
  bounded: 2,
  severe: 3,
  catastrophic: 4,
});

/** Rank of each blast-radius label; higher means more parties can be affected. */
export const BLAST_RADIUS_RANK = Object.freeze({
  workspace: 0,
  local_machine: 1,
  shared_remote: 2,
  production: 3,
  public: 4,
});

/** The five legal destination labels. */
export const DESTINATION_LABELS = Object.freeze([
  "first_party",
  "trusted_third_party",
  "untrusted",
  "unknown",
  "not_applicable",
]);

/** Reversibility labels in ladder order. */
export const REVERSIBILITY_LABELS = Object.freeze(Object.keys(REVERSIBILITY_RANK));

/** Blast-radius labels in ladder order. */
export const BLAST_RADIUS_LABELS = Object.freeze(Object.keys(BLAST_RADIUS_RANK));

/** Rank used for a label the model failed to return, so the answer fails closed. */
export const UNKNOWN_RANK = 4;

/**
 * Default plugin configuration. Every value is overridable through the cordis
 * plugin config, and the scalar ones also through `JEV_REVIEW_*` environment
 * variables; see `resolveConfig`.
 */
export const DEFAULT_CONFIG = Object.freeze({
  /** Master switch. `false` registers no pre-execute listener at all. */
  enabled: true,
  /** Probability threshold tau for every `noul` question. */
  tau: 0.5,
  /** A severity at or above this always needs confirmation. */
  askSeverity: 2,
  /** Failure mode for any internal error, timeout or malformed answer. */
  onError: "ask",
  /**
   * When `grantClearsSeverityBelow > 0`, the severity gate stands down for a
   * call whose severity is strictly below this value AND whose blast radius is
   * below `grantNeverClearsBlastAtOrAbove` AND which the retained instructions
   * **explicitly name** (`explicit_grant >= tau`) AND whose confirmation signal
   * is not itself raised (`needs_confirm < tau`). Ships as `4`: an action the
   * human explicitly authorized by exact action, target and scope must not be
   * re-confirmed just because it is also irreversible — that "treat every
   * irreversible effect the same" behaviour is what this plugin exists to
   * avoid. A call of the same severity that nobody named explicitly still asks,
   * because the reviewer merely judging it routine is not a grant;
   * `catastrophic` and `production`/`public` always ask regardless.
   */
  grantClearsSeverityBelow: 4,
  /**
   * Even when `grantClearsSeverityBelow` clears the severity gate, a blast
   * radius at or above this rank still needs confirmation (default 3 =
   * `production` and `public` are never cleared by authorization alone).
   */
  grantNeverClearsBlastAtOrAbove: 3,
  /**
   * Minimum probability on the `untrusted` destination before the hard denial
   * fires. The hard denial is the one verdict a user cannot override, so it
   * requires a confident answer; a lower-probability `untrusted` degrades to
   * `ask` (recoverable) instead. `0` restores the literal rule.
   */
  denyConfidence: 0.6,
  /** Gateway request timeout in milliseconds. */
  timeoutMs: 30000,
  /** Command Code provider base URL, without the trailing `/systemone`. */
  endpoint: "https://api.commandcode.ai/provider/v1",
  /** Decision model id. */
  model: "typesafe/jev",
  /** Environment variable (or credentials ref) that holds the API key. */
  apiKeyEnv: "JEV_API_KEY",
  /** Estimated-token budget for `state`, sent before the request. */
  stateBudgetTokens: 16000,
  /** Characters-per-token divisor for ordinary prose (measured ~4.8). */
  charsPerToken: 4,
  /**
   * Characters-per-token divisor for dense machine-generated runs (hex dumps,
   * base64, hashes). Measured ~1.0 against the gateway, and getting this wrong
   * is what made every review fail closed on a session full of hex output.
   */
  denseCharsPerToken: 1,
  /** Hard character ceiling for the serialized state, independent of the estimate. */
  maxStateChars: 24000,
  /** Upper bound on retained history entries before the budget pass. */
  maxHistoryEntries: 400,
  /** A single string longer than this is clipped before sending. */
  maxStringChars: 4000,
  /** Cap on any reason string handed to the host. */
  maxReasonChars: 1200,
  /**
   * Optional preset allow-list. Empty (the default) reviews only the `auto`
   * preset this plugin publishes, so being loaded never intercepts a session
   * that did not opt in.
   */
  presets: [],
  /**
   * Grade every in-scope call, write the audit line, and then let it run.
   * Diagnostic mode: it never asks, denies or changes behaviour, so it is safe
   * to enable in a live session while investigating what the reviewer answers.
   */
  dryRun: false,
  /** Append one JSON audit line per reviewed call to this path. Empty = off. */
  logPath: "",
});

/** @returns {boolean} whether a value is a plain object record. */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Clamp a finite number into [0, 1]. */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Coerce an integer inside inclusive bounds, else keep the fallback. */
function integer(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  return Math.min(max, Math.max(min, rounded));
}

/** Coerce a number inside inclusive bounds, else keep the fallback. */
function bounded(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Coerce a boolean-ish value, else keep the fallback. */
function booleanish(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
  }
  return fallback;
}

/** Coerce a non-empty string, else keep the fallback. */
function text(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed === "" ? fallback : trimmed;
}

/** Environment variable name -> config key. */
const ENV_KEYS = Object.freeze({
  JEV_REVIEW_ENABLED: "enabled",
  JEV_REVIEW_TAU: "tau",
  JEV_REVIEW_ASK_SEVERITY: "askSeverity",
  JEV_REVIEW_ON_ERROR: "onError",
  JEV_REVIEW_GRANT_CLEARS_SEVERITY_BELOW: "grantClearsSeverityBelow",
  JEV_REVIEW_GRANT_NEVER_CLEARS_BLAST_AT_OR_ABOVE: "grantNeverClearsBlastAtOrAbove",
  JEV_REVIEW_DENY_CONFIDENCE: "denyConfidence",
  JEV_REVIEW_TIMEOUT_MS: "timeoutMs",
  JEV_REVIEW_ENDPOINT: "endpoint",
  JEV_REVIEW_MODEL: "model",
  JEV_REVIEW_API_KEY_ENV: "apiKeyEnv",
  JEV_REVIEW_STATE_BUDGET_TOKENS: "stateBudgetTokens",
  JEV_REVIEW_CHARS_PER_TOKEN: "charsPerToken",
  JEV_REVIEW_DENSE_CHARS_PER_TOKEN: "denseCharsPerToken",
  JEV_REVIEW_MAX_STATE_CHARS: "maxStateChars",
  JEV_REVIEW_MAX_HISTORY: "maxHistoryEntries",
  JEV_REVIEW_MAX_STRING_CHARS: "maxStringChars",
  JEV_REVIEW_PRESETS: "presets",
  JEV_REVIEW_DRY_RUN: "dryRun",
  JEV_REVIEW_LOG_PATH: "logPath",
});

/** Apply one already-coerced value for one known key. */
function assign(config, key, value) {
  switch (key) {
    case "enabled":
      config.enabled = booleanish(value, config.enabled);
      return;
    case "tau":
      config.tau = bounded(value, config.tau, 0, 1);
      return;
    case "askSeverity":
      config.askSeverity = integer(value, config.askSeverity, 0, UNKNOWN_RANK);
      return;
    case "onError": {
      // `allow` is intentionally unsupported: an internal failure must never be silent.
      const normalized = text(value, config.onError).toLowerCase();
      config.onError = normalized === "deny" ? "deny" : "ask";
      return;
    }
    case "grantClearsSeverityBelow":
      config.grantClearsSeverityBelow = integer(value, config.grantClearsSeverityBelow, 0, UNKNOWN_RANK);
      return;
    case "grantNeverClearsBlastAtOrAbove":
      config.grantNeverClearsBlastAtOrAbove = integer(
        value,
        config.grantNeverClearsBlastAtOrAbove,
        0,
        UNKNOWN_RANK,
      );
      return;
    case "denyConfidence":
      config.denyConfidence = bounded(value, config.denyConfidence, 0, 1);
      return;
    case "timeoutMs":
      config.timeoutMs = integer(value, config.timeoutMs, 1000, 300000);
      return;
    case "stateBudgetTokens":
      config.stateBudgetTokens = integer(value, config.stateBudgetTokens, 512, 30000);
      return;
    case "charsPerToken":
      config.charsPerToken = bounded(value, config.charsPerToken, 1, 20);
      return;
    case "denseCharsPerToken":
      config.denseCharsPerToken = bounded(value, config.denseCharsPerToken, 0.5, 20);
      return;
    case "maxStateChars":
      config.maxStateChars = integer(value, config.maxStateChars, 1000, 500000);
      return;
    case "maxHistoryEntries":
      config.maxHistoryEntries = integer(value, config.maxHistoryEntries, 0, 10000);
      return;
    case "maxStringChars":
      config.maxStringChars = integer(value, config.maxStringChars, 200, 200000);
      return;
    case "maxReasonChars":
      config.maxReasonChars = integer(value, config.maxReasonChars, 200, 8000);
      return;
    case "endpoint":
    case "model":
    case "apiKeyEnv":
      config[key] = text(value, config[key]);
      return;
    case "presets": {
      const list = Array.isArray(value)
        ? value
        : typeof value === "string"
          ? value.split(",")
          : [];
      config.presets = list.map((item) => String(item).trim()).filter((item) => item !== "");
      return;
    }
    case "dryRun":
      config.dryRun = booleanish(value, config.dryRun);
      return;
    case "logPath":
      config.logPath = typeof value === "string" ? value.trim() : config.logPath;
      return;
    /* v8 ignore next 2 -- every caller passes a key of DEFAULT_CONFIG */
    default:
  }
}

/**
 * Build the effective configuration from a raw (`ctx.config`) object and an
 * environment record. Unknown keys are ignored; every known key is coerced and
 * clamped, and the environment wins over the raw object.
 *
 * @param raw - the cordis plugin config, if any.
 * @param env - environment record; defaults to an empty record so unit tests are
 *   deterministic. `lib/index.js` passes `process.env`.
 * @returns a fresh, fully populated configuration object.
 */
export function resolveConfig(raw = {}, env = {}) {
  const config = { ...DEFAULT_CONFIG, presets: [...DEFAULT_CONFIG.presets] };
  if (isRecord(raw)) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key in raw && raw[key] !== undefined && raw[key] !== null) assign(config, key, raw[key]);
    }
  }
  if (isRecord(env)) {
    for (const [envName, key] of Object.entries(ENV_KEYS)) {
      const value = env[envName];
      if (value === undefined || value === null || value === "") continue;
      assign(config, key, value);
    }
  }
  return config;
}

/**
 * Severity of one graded call: the worse of its reversibility and its blast
 * radius.
 *
 * @param reversibility - a reversibility label, or anything else.
 * @param blastRadius - a blast-radius label, or anything else.
 * @returns `{ severity, reversibilityRank, blastRadiusRank }`, with unknown
 *   labels ranked at {@link UNKNOWN_RANK} so the result fails closed.
 */
export function severityOf(reversibility, blastRadius) {
  const reversibilityRank = Object.hasOwn(REVERSIBILITY_RANK, reversibility)
    ? REVERSIBILITY_RANK[reversibility]
    : UNKNOWN_RANK;
  const blastRadiusRank = Object.hasOwn(BLAST_RADIUS_RANK, blastRadius)
    ? BLAST_RADIUS_RANK[blastRadius]
    : UNKNOWN_RANK;
  return { severity: Math.max(reversibilityRank, blastRadiusRank), reversibilityRank, blastRadiusRank };
}

/** Read one `noul` answer. A missing or invalid value fails closed to `1`. */
function readNoul(answers, name) {
  const entry = isRecord(answers) ? answers[name] : undefined;
  const raw = isRecord(entry) ? entry.noul : entry;
  if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: clamp01(raw) };
  return { ok: false, value: 1 };
}

/**
 * Read the explicit-grant answer.
 *
 * Absence is the ordinary case and means "no grant" (`0`); it must never be
 * read as a full grant, and it must not mark the review degraded, because
 * almost no call is named explicitly by the human.
 */
function readGrant(answers) {
  const entry = isRecord(answers) ? answers.explicit_grant : undefined;
  const raw = isRecord(entry) ? entry.noul : entry;
  return typeof raw === "number" && Number.isFinite(raw) ? clamp01(raw) : 0;
}

/** Read one `choice` answer, falling back to the probabilities' argmax. */
function readChoice(answers, name, allowed) {
  const entry = isRecord(answers) ? answers[name] : undefined;
  const raw = isRecord(entry) ? entry.choice : entry;
  if (typeof raw === "string" && allowed.includes(raw)) return { ok: true, value: raw, via: "choice" };
  const probabilities = isRecord(entry) ? entry.probabilities : undefined;
  if (isRecord(probabilities)) {
    let best;
    let bestValue = -Infinity;
    for (const [label, probability] of Object.entries(probabilities)) {
      if (!allowed.includes(label)) continue;
      if (typeof probability !== "number" || !Number.isFinite(probability)) continue;
      if (probability > bestValue) {
        bestValue = probability;
        best = label;
      }
    }
    if (best !== undefined) return { ok: true, value: best, via: "argmax" };
  }
  return { ok: false, value: undefined, via: "missing" };
}

/** Render the top probabilities of one choice answer as `label:p` pairs. */
function probabilitySummary(entry, limit = 3) {
  const probabilities = isRecord(entry) ? entry.probabilities : undefined;
  if (!isRecord(probabilities)) return undefined;
  const pairs = Object.entries(probabilities)
    .filter(([, probability]) => typeof probability === "number" && Number.isFinite(probability))
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([label, probability]) => `${label}=${probability.toFixed(2)}`);
  return pairs.length === 0 ? undefined : pairs.join(",");
}

/** Format a probability for the audit string. */
function fixed(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

/** Probability of one label inside a choice answer, else the fallback. */
function probabilityOf(answers, name, label, fallback) {
  const entry = isRecord(answers) ? answers[name] : undefined;
  const probabilities = isRecord(entry) ? entry.probabilities : undefined;
  const value = isRecord(probabilities) ? probabilities[label] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : fallback;
}

/** Format a rank for the audit string. */
function rankText(rank) {
  return rank === UNKNOWN_RANK ? "unknown" : String(rank);
}

/** Clamp the final reason to the configured cap without losing the decision. */
function capReason(reason, config) {
  const cap = config.maxReasonChars;
  if (typeof reason !== "string") return "";
  return reason.length <= cap ? reason : `${reason.slice(0, Math.max(0, cap - 1))}…`;
}

/**
 * Grade one Jev answer set.
 *
 * Rules, all with configurable thresholds:
 * - hard deny: `sends_sensitive >= tau` AND `destination === "untrusted"`, from
 *   positive, non-degraded answers only;
 * - ask: `sends_sensitive >= tau` AND `destination === "unknown"`, or
 *   `needs_confirm >= tau`, or `severity >= askSeverity`;
 * - otherwise allow.
 *
 * @param answers - the `answers` object of one systemone response.
 * @param config - a full or partial configuration; `resolveConfig` fills it in.
 * @returns a verdict record with the verdict, the graded facts, the audit
 *   `reason` (English, one line, with severity/category/probabilities) and the
 *   localized `summary` / `summaryZh` sentences used for the confirmation
 *   prompt. Never throws.
 */
export function decide(answers, config = {}) {
  const settings = resolveConfig(isRecord(config) ? config : {}, {});
  const notes = [];

  const need = readNoul(answers, "needs_confirm");
  const sensitive = readNoul(answers, "sends_sensitive");
  const destination = readChoice(answers, "destination", DESTINATION_LABELS);
  const reversibility = readChoice(answers, "reversibility", REVERSIBILITY_LABELS);
  const blastRadius = readChoice(answers, "blast_radius", BLAST_RADIUS_LABELS);
  const grantValue = readGrant(answers);

  if (!need.ok) notes.push("needs_confirm unreadable -> treated as 1");
  if (!sensitive.ok) notes.push("sends_sensitive unreadable -> treated as 1");
  if (!destination.ok) notes.push("destination unreadable -> treated as unknown");
  if (!reversibility.ok) notes.push("reversibility unreadable -> worst rank");
  if (!blastRadius.ok) notes.push("blast_radius unreadable -> worst rank");
  const degraded = notes.length > 0;

  const destinationValue = destination.ok ? destination.value : "unknown";
  const { severity, reversibilityRank, blastRadiusRank } = severityOf(
    reversibility.value,
    blastRadius.value,
  );

  const sensitiveValue = sensitive.value;
  const confirmValue = need.value;
  const sensitiveSend = sensitiveValue >= settings.tau;
  const untrustedDestination = destinationValue === "untrusted";
  const unknownDestination = destinationValue === "unknown";
  // How sure the destination answer is. Without probabilities, a named
  // `untrusted` counts as fully certain.
  const untrustedProbability = probabilityOf(answers, "destination", "untrusted", untrustedDestination ? 1 : 0);

  // A hard denial needs positive evidence from BOTH answers, and it needs a
  // confident destination: this is the one verdict a user cannot override, so a
  // near-tie between `untrusted` and `unknown` degrades to `ask` instead.
  const hardDeny =
    sensitiveSend &&
    untrustedDestination &&
    sensitive.ok &&
    destination.ok &&
    untrustedProbability >= settings.denyConfidence;
  const unverifiedDestination =
    sensitiveSend && (unknownDestination || (untrustedDestination && !hardDeny));
  const authorizationGap = confirmValue >= settings.tau;
  const severityGate = severity >= settings.askSeverity;
  // The severity ladder stands down only for a call the retained instructions
  // name explicitly, and never for production/public blast or an unmet
  // confirmation signal. "The reviewer thought it was routine" is not a grant.
  const grantClearsGate =
    settings.grantClearsSeverityBelow > 0 &&
    !authorizationGap &&
    grantValue >= settings.tau &&
    severity < settings.grantClearsSeverityBelow &&
    blastRadiusRank < settings.grantNeverClearsBlastAtOrAbove;

  let kind = "allow";
  let category = "routine";
  if (hardDeny) {
    kind = "deny";
    category = "sensitive_exfiltration";
  } else if (unverifiedDestination) {
    kind = "ask";
    category = "unverified_destination";
  } else if (authorizationGap) {
    kind = "ask";
    category = "authorization_gap";
  } else if (severityGate && !grantClearsGate) {
    kind = "ask";
    category = "irreversible_effect";
  }
  if (degraded && kind === "allow") {
    // Belt and braces: a degraded answer set must never be silent permission.
    kind = "ask";
    category = "degraded_review";
  }

  const destinationProbabilities = isRecord(answers?.destination) ? answers.destination.probabilities : undefined;
  const reasons = [];
  reasons.push(`severity=${severity}`);
  reasons.push(`reversibility=${reversibility.value ?? "unknown"}(${rankText(reversibilityRank)})`);
  reasons.push(`blast_radius=${blastRadius.value ?? "unknown"}(${rankText(blastRadiusRank)})`);
  reasons.push(`needs_confirm=${fixed(confirmValue)}`);
  reasons.push(`explicit_grant=${fixed(grantValue)}`);
  reasons.push(`sends_sensitive=${fixed(sensitiveValue)}`);
  reasons.push(`destination=${destinationValue}`);
  if (untrustedDestination) reasons.push(`P(untrusted)=${fixed(untrustedProbability)}`);
  const destinationTop = probabilitySummary(answers?.destination);
  if (destinationTop !== undefined) reasons.push(`P(destination)=[${destinationTop}]`);
  const reversibilityTop = probabilitySummary(answers?.reversibility);
  if (reversibilityTop !== undefined) reasons.push(`P(reversibility)=[${reversibilityTop}]`);
  const blastTop = probabilitySummary(answers?.blast_radius);
  if (blastTop !== undefined) reasons.push(`P(blast_radius)=[${blastTop}]`);
  reasons.push(`tau=${settings.tau}`);
  reasons.push(`askSeverity=${settings.askSeverity}`);
  if (untrustedDestination) reasons.push(`denyConfidence=${settings.denyConfidence}`);
  if (grantClearsGate) {
    reasons.push(
      `grant cleared severity gate (<${settings.grantClearsSeverityBelow}, blast rank <${settings.grantNeverClearsBlastAtOrAbove})`,
    );
  } else if (settings.grantClearsSeverityBelow > 0 && !authorizationGap && severityGate) {
    reasons.push(
      `grant did not clear severity gate (severity ${severity} >= ${settings.grantClearsSeverityBelow} or blast rank ${blastRadiusRank} >= ${settings.grantNeverClearsBlastAtOrAbove})`,
    );
  }
  reasons.push(`degraded=${degraded}`);
  if (degraded) reasons.push(`notes=[${notes.join("; ")}]`);
  const reason = capReason(`Jev review: ${kind.toUpperCase()} category=${category} ${reasons.join(" ")}`, settings);

  const reversibilityLabel = reversibility.value ?? "unknown";
  const blastLabel = blastRadius.value ?? "unknown";
  const ladder = `reversibility=${reversibilityLabel}(${rankText(reversibilityRank)}) x blast_radius=${blastLabel}(${rankText(blastRadiusRank)}) -> severity ${severity}`;
  const summary = summaryFor(kind, category, {
    ladder,
    severity,
    confirmValue,
    sensitiveValue,
    destinationValue,
    notes,
  });
  const summaryZh = summaryZhFor(kind, category, {
    ladder,
    severity,
    confirmValue,
    sensitiveValue,
    destinationValue,
    notes,
    destinationProbabilities,
  });

  return {
    kind,
    category,
    severity,
    reversibilityRank,
    blastRadiusRank,
    reversibility: reversibility.value ?? null,
    blastRadius: blastRadius.value ?? null,
    destination: destinationValue,
    destinationVia: destination.via,
    untrustedProbability,
    needsConfirm: confirmValue,
    explicitGrant: grantValue,
    sendsSensitive: sensitiveValue,
    probabilities: {
      destination: destinationProbabilities ?? null,
      reversibility: isRecord(answers?.reversibility) ? (answers.reversibility.probabilities ?? null) : null,
      blastRadius: isRecord(answers?.blast_radius) ? (answers.blast_radius.probabilities ?? null) : null,
    },
    degraded,
    notes,
    reason,
    summary,
    summaryZh,
  };
}

/** English one-sentence explanation of one verdict. */
function summaryFor(kind, category, facts) {
  const { ladder, severity, confirmValue, sensitiveValue, destinationValue, notes } = facts;
  const audit = `${ladder}; needs_confirm=${fixed(confirmValue)}; sends_sensitive=${fixed(sensitiveValue)}; destination=${destinationValue}`;
  const degradedNote = notes.length > 0 ? ` (degraded: ${notes.join("; ")})` : "";
  if (kind === "deny") {
    return `sensitive data would leave this machine for an untrusted destination, which no user authorization can permit [${audit}]${degradedNote}`;
  }
  if (category === "unverified_destination") {
    return `it may send sensitive data to a destination that cannot be established, so the destination must be confirmed [${audit}]${degradedNote}`;
  }
  if (category === "authorization_gap") {
    return `no retained human or direct-parent instruction explicitly authorizes this exact action, target and scope [${audit}]${degradedNote}`;
  }
  if (category === "degraded_review") {
    return `the review could not be graded with confidence, so it fails closed [${audit}]${degradedNote}`;
  }
  if (category === "review_failure") {
    return `the review could not be completed [${audit}]${degradedNote}`;
  }
  return `its graded severity ${severity} reaches the confirmation threshold [${audit}]${degradedNote}`;
}

/** Chinese counterpart of {@link summaryFor}, carrying the grading ladder. */
function summaryZhFor(kind, category, facts) {
  const { ladder, severity, confirmValue, sensitiveValue, destinationValue, notes } = facts;
  const audit = `${ladder}；needs_confirm=${fixed(confirmValue)}；sends_sensitive=${fixed(sensitiveValue)}；destination=${destinationValue}`;
  const degradedNote = notes.length > 0 ? `（降级：${notes.join("；")}）` : "";
  if (kind === "deny") {
    return `敏感数据将离开本机前往不可信目的地，任何用户授权都不能放行【${audit}】${degradedNote}`;
  }
  if (category === "unverified_destination") {
    return `可能把敏感数据发往无法确认的目的地，必须先确认目的地【${audit}】${degradedNote}`;
  }
  if (category === "authorization_gap") {
    return `没有人类或直接父级指令明确授权这个确切动作、目标与范围【${audit}】${degradedNote}`;
  }
  if (category === "degraded_review") {
    return `审查未能可靠判定，按失败兜底处理【${audit}】${degradedNote}`;
  }
  if (category === "review_failure") {
    return `审查未能完成【${audit}】${degradedNote}`;
  }
  return `判定严重度 ${severity} 达到确认阈值【${audit}】${degradedNote}`;
}

/**
 * Build the failure verdict for any internal problem (timeout, HTTP error,
 * malformed response, unreadable session). Never returns `allow`.
 *
 * @param config - resolved configuration; `onError` selects `ask` or `deny`.
 * @param error - the thrown value.
 * @returns a verdict record shaped like {@link decide}'s.
 */
export function failureVerdict(config, error) {
  const settings = resolveConfig(isRecord(config) ? config : {}, {});
  const message = error instanceof Error ? error.message : String(error);
  const short = message.length > 300 ? `${message.slice(0, 299)}…` : message;
  const kind = settings.onError === "deny" ? "deny" : "ask";
  const reason = capReason(
    `Jev review: ${kind.toUpperCase()} category=review_failure onError=${settings.onError} detail=${short}`,
    settings,
  );
  const summary = `the review could not be completed (${short}), so the call fails closed as ${kind}`;
  const summaryZh = `审查未能完成（${short}），按 onError=${settings.onError} 兜底为${kind === "deny" ? "拒绝" : "人工确认"}`;
  return {
    kind,
    category: "review_failure",
    severity: null,
    reversibilityRank: null,
    blastRadiusRank: null,
    reversibility: null,
    blastRadius: null,
    destination: null,
    destinationVia: "missing",
    untrustedProbability: 0,
    needsConfirm: null,
    explicitGrant: null,
    sendsSensitive: null,
    probabilities: { destination: null, reversibility: null, blastRadius: null },
    degraded: true,
    notes: [short],
    reason,
    summary,
    summaryZh,
  };
}
