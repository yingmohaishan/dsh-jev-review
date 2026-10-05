/**
 * `dsh-jev-review` — a host plugin that grades every tool call with the
 * Command Code Jev decision model before its body runs.
 *
 * Wiring mirrors the shipped experimental auto-review plugin: a `prepend`ed
 * `tools/pre-execute` waterfall listener reviews every native call and every
 * started PTC inner call, and deliberately skips the outer `run_code`
 * transport. The graded verdict then becomes:
 * - `allow`   -> the listener passes the downstream result through untouched;
 * - `ask`     -> the host asks the user, localized, with the audit reason;
 * - `deny`    -> a final `JevReviewDeniedError` denial.
 *
 * Any internal failure (timeout, HTTP error, malformed answer, unreadable
 * session) fails closed into the configured `onError` mode, which defaults to
 * `ask`; an exception from this plugin never reaches the tool pipeline.
 *
 * @module dsh-jev-review
 */

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { loadApiKey, anySignal, review } from "./jev.js";
import { decide, failureVerdict, resolveConfig } from "./rule.js";
import { buildState } from "./snapshot.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "jev-review";

/** Host services required before this plugin activates. */
export const inject = ["tools", "approval", "permissionPresets"];

/**
 * The reserved permission preset this plugin owns.
 *
 * Being loaded must not change any session by itself: registering this preset is
 * what adds the option to the session's permission picker, and selecting it is
 * what turns the gate on. A build that reviewed every mode instead locked every
 * tool call of an opted-out session out of its own recovery path.
 */
const AUTO_PRESET = "auto";

/** File-writing tools whose target can be checked before review. */
const FS_WRITE_TOOLS = new Set(["write", "edit"]);

/** Profile files that must stay editable or the plugin can never be switched off. */
const PROFILE_CONFIG_NAMES = new Set(["cordis.patch.yml", "package.json", "compatibility.json"]);

/** The outer PTC transport tool; its inner calls are reviewed, itself is not. */
const RUN_CODE_NAME = "run_code";

/** Structured error name persisted for every final reviewer denial. */
const DENIED_ERROR_NAME = "JevReviewDeniedError";

/** Structured error code persisted for every final reviewer denial. */
const DENIED_CODE = "JEV_REVIEW_DENIED";

/** Run a getter, returning `undefined` instead of throwing. */
function read(getter) {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

/** One-line description of a thrown value. */
function describeError(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/** Log through whichever level the host logger offers, never throwing. */
function log(ctx, message, level = "info") {
  try {
    const logger = ctx?.logger;
    if (logger === undefined || logger === null) return;
    const method = typeof logger[level] === "function" ? level : "info";
    if (typeof logger[method] !== "function") return;
    logger[method](`[jev-review] ${message}`);
  } catch {
    /* logging must never affect the decision */
  }
}

/** Resolve the plugin configuration from the cordis apply argument, `ctx.config`, and the environment. */
function readConfig(ctx, pluginConfig) {
  const raw = pluginConfig ?? read(() => ctx.config);
  const env = read(() => process.env) ?? {};
  return resolveConfig(raw !== null && typeof raw === "object" ? raw : {}, env);
}

/** The session's effective permission preset, or undefined when unreadable. */
function currentPreset(ctx, agent) {
  const presets = read(() => ctx.get("permissionPresets"));
  if (presets === undefined || presets === null || typeof presets.current !== "function") return undefined;
  const current = read(() => presets.current(agent.session));
  return typeof current === "string" ? current : undefined;
}

/**
 * Whether this call is inside the review scope at all.
 *
 * The gate is off unless the session's permission preset is the one this plugin
 * owns (`auto`), or an explicit `presets` allow-list names the current preset.
 * An unreadable preset is treated as out of scope on purpose: failing open on
 * *scope detection* can only mean "no review", while failing closed there would
 * lock sessions that never opted in. Once in scope, every decision fails closed.
 */
function inReviewScope(ctx, config, agent) {
  // Diagnostic mode grades every call and blocks none, so it deliberately
  // ignores the preset scope while staying non-blocking by construction.
  if (config.dryRun) return true;
  const current = currentPreset(ctx, agent);
  if (current === undefined) return false;
  if (Array.isArray(config.presets) && config.presets.length > 0) return config.presets.includes(current);
  return current === AUTO_PRESET;
}

/**
 * Whether the call writes the profile's own plugin configuration.
 *
 * This is the switch that turns the plugin off. Reviewing it produced a real
 * lockout: with approval policy `never` the confirmation became a rejection, so
 * neither the agent nor the plugin page could disable the row any more.
 */
function isProfileConfigWrite(exec) {
  if (!FS_WRITE_TOOLS.has(read(() => exec.name))) return false;
  const target = read(() => read(() => exec.arguments)?.file_path ?? read(() => exec.arguments)?.path);
  if (typeof target !== "string" || target === "") return false;
  let absolute;
  try {
    absolute = resolve(target);
  } catch {
    return false;
  }
  const root = join(homedir(), ".dsh", "profiles");
  const inside = absolute === root || absolute.startsWith(root + sep);
  return inside && PROFILE_CONFIG_NAMES.has(basename(absolute));
}

/** Whether the session's effective approval policy forbids reaching a human. */
function approvalPolicyIsNever(ctx, agent) {
  const approval = read(() => ctx.get("approval"));
  if (approval === undefined || approval === null) return false;
  const override = read(() => approval.overrideOf(agent.session));
  if (override === "never") return true;
  if (override === "ask") return false;
  return read(() => approval.config?.policy) === "never";
}

/**
 * Whether the call only writes a file on this machine or a mapped drive.
 *
 * Such a call cannot itself transmit anything off-box, so it must never be the
 * subject of an unrecoverable exfiltration denial. A network share or URL target
 * is not local and keeps the hard denial.
 */
function isLocalFileWrite(exec) {
  if (!FS_WRITE_TOOLS.has(read(() => exec.name))) return false;
  const target = read(() => read(() => exec.arguments)?.file_path ?? read(() => exec.arguments)?.path);
  if (typeof target !== "string" || target === "") return false;
  if (/^\\\\/.test(target)) return false;
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(target)) return false;
  return true;
}

/** Append one audit line when a log path is configured. Never throws. */
function writeAudit(config, record) {
  if (typeof config.logPath !== "string" || config.logPath === "") return;
  try {
    appendFileSync(config.logPath, `${JSON.stringify(record)}\n`);
  } catch {
    /* auditing must never affect a call */
  }
}

/** Human wording for each reversibility label, so the prompt says what is lost. */
const REVERSIBILITY_TEXT = Object.freeze({
  trivial: { zh: "可重复生成，没有持久副作用", en: "regenerated by rerunning it, with no persistent side effect" },
  simple: { zh: "只影响一个已知的小对象，损失可从对话、版本库或同样的输入重建", en: "one known small object is affected; it can be rebuilt from the conversation or version control" },
  bounded: { zh: "影响已知的一批既有内容（一个目录、一个分支、一组配置），只能靠外部备份恢复", en: "a known set of existing content is affected (a directory, a branch, a group of settings) and only an external backup can restore it" },
  severe: { zh: "属于大规模或无法恢复的损失：改写已推送历史、删除仓库/卷/数据库、批量删除、轮换密钥证书、改动生产数据", en: "large-scale or unrecoverable loss: rewriting pushed history, deleting a repository, volume or database, bulk deletion, rotating keys, changing production data" },
  catastrophic: { zh: "会伤及第三方或公众的数据/系统，或安全审计控制", en: "another party's or the public's data or systems, or a security control, would be damaged" },
});

/** Human wording for each blast-radius label. */
const BLAST_TEXT = Object.freeze({
  workspace: { zh: "只影响当前工作区", en: "confined to the current working tree" },
  local_machine: { zh: "影响本机其它路径或服务", en: "reaches other paths or services on this machine" },
  shared_remote: { zh: "影响共享远端（已推送分支、CI、团队设施）", en: "reaches shared remote resources (pushed branches, CI, team infrastructure)" },
  production: { zh: "影响生产数据、生产系统或客户", en: "reaches production data, systems or customers" },
  public: { zh: "影响第三方或公众", en: "reaches third parties or the general public" },
});

/** One-line description of the exact call being reviewed, for the prompt body. */
function describeAction(exec) {
  const name = typeof read(() => exec.name) === "string" ? exec.name : "tool";
  const args = read(() => exec.arguments);
  let detail = "";
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const command = args.command ?? args.cmd ?? args.script;
    const path = args.file_path ?? args.filePath ?? args.path ?? args.target;
    if (typeof command === "string" && command.trim() !== "") detail = command;
    else if (typeof path === "string" && path.trim() !== "") detail = path;
    else detail = JSON.stringify(args);
  } else if (args !== undefined && args !== null) {
    detail = String(args);
  }
  detail = String(detail).replace(/\s+/g, " ").trim();
  if (detail.length > 240) detail = `${detail.slice(0, 239)}…`;
  return detail === "" ? name : `${name} → ${detail}`;
}

/** Plain-language "why this was stopped" for one verdict. */
function explainWhy(verdict, lang, degraded = false) {
  const zh = lang === "zh";
  const revisions = REVERSIBILITY_TEXT[verdict.reversibility] ?? null;
  const blast = BLAST_TEXT[verdict.blastRadius] ?? null;
  const ladder = zh
    ? `不可逆程度：${revisions?.zh ?? "无法确定（按最严处理）"}；影响范围：${blast?.zh ?? "无法确定（按最严处理）"}；严重度 ${verdict.severity ?? "n/a"}`
    : `reversibility: ${revisions?.en ?? "not determinable (treated as the worst case)"}; blast radius: ${blast?.en ?? "not determinable (treated as the worst case)"}; severity ${verdict.severity ?? "n/a"}`;
  const byCategory = {
    sensitive_exfiltration: degraded
      ? (zh
        ? "这条调用涉及把凭据、机密或私有数据发往不可信目的地（这一档默认不授权，见下方补充）"
        : "this call involves sending credentials, secrets or private data to an untrusted destination (a class that is not authorized by default; see the note below)")
      : (zh
        ? "这条调用会把凭据、机密或私有数据发往不可信的外部目的地——这一档任何时候都不放行，即使你在这里同意"
        : "this call would send credentials, secrets or private data to an untrusted external destination — this class is never allowed, even if you agree here"),
    unverified_destination: zh
      ? "它可能把敏感数据发往一个当前无法确认的目的地，需要你确认目的地是否可信"
      : "it may send sensitive data to a destination that cannot currently be established, so the destination needs your confirmation",
    authorization_gap: zh
      ? "保留的指令里没有任何人类或父级指令明确授权这个确切的动作、目标与范围"
      : "no retained human or parent instruction explicitly authorizes this exact action, target and scope",
    irreversible_effect: zh
      ? "它的不可逆程度或影响范围达到了需要人工确认的等级"
      : "its reversibility or blast radius reaches the level that needs a human decision",
    degraded_review: zh
      ? "审查自身没有可靠完成，按最严方向兜底"
      : "the review itself could not be completed reliably, so it fails closed",
    review_failure: zh
      ? "审查未能完成，按最严方向兜底"
      : "the review could not be completed, so it fails closed",
  };
  const measured = zh
    ? `实测：需确认概率 ${verdict.needsConfirm ?? "n/a"}、明确授权概率 ${verdict.explicitGrant ?? "n/a"}、敏感外发概率 ${verdict.sendsSensitive ?? "n/a"}`
    : `measured: needs-confirm ${verdict.needsConfirm ?? "n/a"}, explicit-grant ${verdict.explicitGrant ?? "n/a"}, sends-sensitive ${verdict.sendsSensitive ?? "n/a"}`;
  const fallback = zh ? "判定为需要确认" : "graded as needing confirmation";
  const reason = byCategory[verdict.category] ?? fallback;
  return zh
    ? `${reason}（实测：需确认概率 ${verdict.needsConfirm ?? "n/a"}、明确授权概率 ${verdict.explicitGrant ?? "n/a"}、敏感外发概率 ${verdict.sendsSensitive ?? "n/a"}）。判定依据：${ladder}`
    : `${reason} (${measured}). Grading: ${ladder}`;
}

/** Extra sentence for a verdict the reviewer graded as a refusal but that was made recoverable. */
function explainDegrade(lang) {
  return lang === "zh"
    ? "补充：这次调用只是在本机写文件，本身不会把任何数据发出去，所以判定器把“直接拒绝”降级成了请你确认。"
    : "Note: this call only writes a file on this machine and transmits nothing itself, so the reviewer downgraded its refusal to a confirmation.";
}

/** Plain-language "what happens if you allow / if you refuse". */
function explainEffect(verdict, lang) {
  const zh = lang === "zh";
  const revisions = REVERSIBILITY_TEXT[verdict.reversibility] ?? null;
  const blast = BLAST_TEXT[verdict.blastRadius] ?? null;
  if (verdict.kind === "deny") {
    return zh
      ? "它不会执行，模型会收到一条错误；这一档不接受授权覆盖。"
      : "it will not run and the model receives an error; this class does not accept an override.";
  }
  return zh
    ? `立即以完全权限执行上面的动作。影响：${revisions?.zh ?? "无法确定"}；范围：${blast?.zh ?? "无法确定"}。`
    : `it runs immediately with full access. Impact: ${revisions?.en ?? "not determinable"}. Reach: ${blast?.en ?? "not determinable"}.`;
}

/** Pull the first path-looking token out of a shell command. */
function extractTarget(command) {
  const windows = command.match(/[A-Za-z]:\\[^\s"'|;>]+/);
  if (windows !== null) return windows[0];
  const posix = command.match(/(?:^|\s)(\/[^\s"'|;>]+)/);
  if (posix !== null) return posix[1];
  const relative = command.match(/(?:^|\s)(\.{1,2}[\\/][^\s"'|;>]+)/);
  return relative === null ? "" : relative[1];
}

/**
 * Shell intents, most specific first. Each turns a command line into the plain
 * sentence a person can act on: the prompt is read by a human, so it must not
 * lead with a tool name or a command line.
 */
const SHELL_INTENTS = Object.freeze([
  { re: /\bgit\s+push\b[^\n]*?(?:--force|-f\b)/i, zh: () => "强制推送，覆盖远端分支已有的历史", en: () => "force-push, overwriting the remote branch history" },
  { re: /\bgit\s+push\b/i, zh: () => "把本地提交推送到远端仓库", en: () => "push local commits to a remote repository" },
  { re: /\b(?:Remove-Item|rm|rmdir|del)\b[^\n]*?(?:-Recurse|--recursive|\s-r\b)/i, zh: (t) => `删除目录 ${t}，连同其中的全部内容`, en: (t) => `delete the directory ${t} and everything inside it` },
  { re: /\b(?:Remove-Item|rm|del|unlink)\b/i, zh: (t) => `删除文件 ${t}`, en: (t) => `delete the file ${t}` },
  { re: /\b(?:Set-Content|Add-Content|Out-File|New-Item)\b/i, zh: (t) => `写入文件 ${t}`, en: (t) => `write the file ${t}` },
  { re: /\b(?:Copy-Item|\bcp\b)\b/i, zh: (t) => `复制 ${t}`, en: (t) => `copy ${t}` },
  { re: /\b(?:Move-Item|\bmv\b|Rename-Item)\b/i, zh: (t) => `移动或重命名 ${t}`, en: (t) => `move or rename ${t}` },
  { re: /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i, zh: () => "向远端发起网络请求（发送或取回数据）", en: () => "make a network request, sending data to or fetching data from a remote host" },
  { re: /\b(?:npm|pnpm|yarn|pip|pip3)\s+(?:install|add|i)\b/i, zh: () => "安装依赖包", en: () => "install dependencies" },
  { re: /\b(?:Start-Process|Stop-Process|Restart-Computer|taskkill)\b/i, zh: () => "启动、停止或重启本机的进程", en: () => "start, stop or restart a process on this machine" },
]);

/** Tool names that run shell commands. */
const SHELL_TOOLS = new Set(["pwsh", "powershell", "bash", "sh", "zsh", "shell", "cmd", "run"]);

/** Human sentence for the reviewed action, in the given language. */
function humanAction(exec, lang) {
  const zh = lang === "zh";
  const name = typeof read(() => exec.name) === "string" ? exec.name : "tool";
  const args = read(() => exec.arguments);
  const record = args !== null && typeof args === "object" && !Array.isArray(args) ? args : {};
  const path = record.file_path ?? record.filePath ?? record.path ?? record.target ?? record.directory;
  const command = record.command ?? record.cmd ?? record.script;

  if (SHELL_TOOLS.has(name) && typeof command === "string" && command.trim() !== "") {
    const flat = command.replace(/\s+/g, " ").trim();
    for (const intent of SHELL_INTENTS) {
      if (!intent.re.test(flat)) continue;
      const target = extractTarget(flat);
      return zh
        ? intent.zh(target === "" ? "目标文件" : target)
        : intent.en(target === "" ? "the target" : target);
    }
    const clipped = flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
    return zh ? `执行一条命令（${clipped}）` : `run a command (${clipped})`;
  }

  const named = {
    read: zh ? "读取文件" : "read the file",
    write: zh ? "写入文件" : "write the file",
    edit: zh ? "修改文件" : "edit the file",
    glob: zh ? "查找文件" : "find files",
    grep: zh ? "搜索文件内容" : "search file contents",
    present: zh ? "向用户展示结果文件" : "present result files to the user",
  };
  if (named[name] !== undefined) {
    return typeof path === "string" && path !== "" ? `${named[name]} ${path}` : named[name];
  }
  return zh ? `调用工具 ${name}` : `call the tool ${name}`;
}

/** Build the host-facing payload for one non-allow verdict. */
function payloadFor(exec, verdict) {
  const tool = typeof read(() => exec.name) === "string" ? exec.name : "tool";
  const raw = describeAction(exec);
  const humanZh = humanAction(exec, "zh");
  const humanEn = humanAction(exec, "en");

  if (verdict.kind === "deny") {
    const whyEn = explainWhy(verdict, "en");
    return {
      kind: "deny",
      reason:
        `Jev review refused tool "${tool}": ${humanEn}. ${whyEn} ${explainEffect(verdict, "en")} ` +
        `[raw call: ${raw} | audit: ${verdict.reason}]`,
      info: {
        name: DENIED_ERROR_NAME,
        code: DENIED_CODE,
        reason: `${verdict.reason} | raw call: ${raw}`,
      },
    };
  }

  const headerZh = "🔒 Jev 拦下了这次工具调用，需要你确认是否放行";
  const headerEn = "Jev stopped this tool call and needs your confirmation";
  const degraded = (verdict.notes ?? []).some((note) => /degraded/i.test(String(note)));
  const zh = [
    headerZh,
    "",
    `要做什么：${humanZh}`,
    `为什么拦：${explainWhy(verdict, "zh", degraded)}`,
    ...(degraded ? ["", explainDegrade("zh")] : []),
    "",
    `放行后：${explainEffect(verdict, "zh")}`,
    "拒绝后：这次调用不会执行，模型只会收到“被拒绝”的结果。",
    "",
    `技术详情（排查用，可忽略）：${verdict.reason} ｜ 原始调用：${raw}`,
  ].join("\n");
  const en = [
    headerEn,
    "",
    `What it will do: ${humanEn}`,
    `Why: ${explainWhy(verdict, "en", degraded)}`,
    ...(degraded ? ["", explainDegrade("en")] : []),
    "",
    `If you allow: ${explainEffect(verdict, "en")}`,
    "If you refuse: the call does not run and the model only learns that it was refused.",
    "",
    `Technical details: ${verdict.reason} | raw call: ${raw}`,
  ].join("\n");
  return {
    kind: "ask",
    reason:
      `Jev review requests confirmation for tool "${tool}": ${humanEn}. ${explainWhy(verdict, "en", degraded)} ` +
      `[raw call: ${raw} | audit: ${verdict.reason}]`,
    displayReason: { en, zh },
  };
}

/**
 * Install the prepended per-call Jev review gate.
 *
 * @param ctx - the cordis context carrying the `tools` service.
 * @param pluginConfig - the loader-supplied plugin config, when cordis passes
 *   it; `ctx.config` is the fallback.
 */
export function apply(ctx, pluginConfig) {
  const config = readConfig(ctx, pluginConfig);
  if (!config.enabled) {
    log(ctx, "disabled by configuration; no pre-execute review is registered");
    return;
  }
  if (loadApiKey({ env: read(() => process.env) ?? {}, envName: config.apiKeyEnv }) === undefined) {
    log(
      ctx,
      `no API key found for ${config.apiKeyEnv} (env or refs.${config.apiKeyEnv} in ~/.dsh/.credentials.yaml); every reviewed call will fail closed into onError="${config.onError}"`,
      "warn",
    );
  }

  let accepting = true;
  const lifecycle = new AbortController();
  const active = new Set();

  /**
   * Grade one call and translate it into the plan the waterfall listener acts on.
   * Never throws: every internal failure becomes a fail-closed verdict.
   */
  async function planFor(exec) {
    const agent = read(() => exec.agent);
    if (agent === undefined || agent === null) return { kind: "passthrough" };
    if (read(() => exec.parent) === undefined && read(() => exec.name) === RUN_CODE_NAME) {
      return { kind: "passthrough" };
    }
    if (!accepting || lifecycle.signal.aborted) return { kind: "cancel" };
    // Never gate the profile's own plugin configuration: that is the switch.
    if (isProfileConfigWrite(exec)) return { kind: "passthrough" };
    if (!inReviewScope(ctx, config, agent)) return { kind: "passthrough" };

    let settle;
    const completed = new Promise((resolve) => {
      settle = resolve;
    });
    active.add(completed);
    try {
      let verdict;
      let meta = { latencyMs: undefined, inputTokens: undefined, estimatedTokens: undefined, dropped: undefined };
      const reviewSignal = anySignal([read(() => exec.signal), lifecycle.signal]);
      // A context rejection is retried with a smaller state: the estimator is a
      // heuristic, and a wrong estimate must cost one retry, never every call.
      const attempts = [config];
      for (const divisor of [2, 4]) {
        attempts.push({
          ...config,
          stateBudgetTokens: Math.max(2048, Math.floor(config.stateBudgetTokens / divisor)),
          maxStateChars: Math.max(4000, Math.floor(config.maxStateChars / divisor)),
        });
      }
      let lastError;
      for (const [attemptIndex, attempt] of attempts.entries()) {
        try {
          const built = buildState(agent, exec, attempt);
          const result = await review(built.state, attempt, reviewSignal);
          verdict = decide(result.answers, config);
          meta = {
            latencyMs: result.latencyMs,
            inputTokens: result.usage.inputTokens,
            estimatedTokens: built.estimatedTokens,
            dropped: built.dropped,
            degraded: built.degraded,
            attempt: attemptIndex + 1,
          };
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          // Only a context rejection is worth retrying smaller; anything else
          // (auth, network, shape) would fail again the same way.
          if (!/context limit|max_tokens_exceeded|too many tokens|context length/i.test(describeError(error))) break;
        }
      }
      if (lastError !== undefined) {
        verdict = failureVerdict(config, lastError);
        meta = { error: describeError(lastError) };
      }
      // A local file write cannot transmit anything itself, so an exfiltration
      // hard denial there is a false positive whose cost would be a permanent,
      // unauthorized-overridable block. Degrade it to a recoverable confirmation;
      // shell and network calls keep the hard denial.
      if (verdict.kind === "deny" && verdict.category === "sensitive_exfiltration" && isLocalFileWrite(exec)) {
        verdict = {
          ...verdict,
          kind: "ask",
          reason: `${verdict.reason} [hard denial degraded: this call only writes a local file, which transmits nothing itself]`,
          notes: [...(verdict.notes ?? []), "hard denial degraded for a local file write"],
        };
      }
      const tool = read(() => exec.name) ?? "unknown";
      writeAudit(config, {
        at: new Date().toISOString(),
        tool,
        kind: verdict.kind,
        category: verdict.category,
        severity: verdict.severity,
        reason: verdict.reason,
        ...meta,
      });
      log(
        ctx,
        `${verdict.kind.toUpperCase()} category=${verdict.category} tool=${tool} ` +
          `severity=${verdict.severity ?? "n/a"} latency=${meta.latencyMs ?? "n/a"}ms ` +
          `input_tokens=${meta.inputTokens ?? "n/a"} estimated_tokens=${meta.estimatedTokens ?? "n/a"}` +
          `${meta.dropped ? ` dropped_history=${meta.dropped}` : ""}` +
          `${meta.error ? ` error=${meta.error}` : ""} | ${verdict.reason}`,
        verdict.kind === "allow" ? "debug" : "info",
      );
      if (config.dryRun) return { kind: "passthrough" };
      if (lifecycle.signal.aborted) return { kind: "cancel" };
      if (verdict.kind === "allow") return { kind: "passthrough" };
      if (verdict.kind === "ask" && approvalPolicyIsNever(ctx, agent)) {
        // A confirmation can never reach the human under `never`; the host would
        // turn this into a bare "the user rejected tool" and hide the reason.
        return {
          kind: "deny",
          payload: {
            kind: "deny",
            reason:
              `Jev review denied tool "${tool}": the session approval policy is "never", so a confirmation could not reach you. ` +
              `${verdict.summary} (audit: ${verdict.reason})`,
            info: { name: DENIED_ERROR_NAME, code: DENIED_CODE, reason: verdict.reason },
          },
        };
      }
      return { kind: verdict.kind, payload: payloadFor(exec, verdict) };
    } finally {
      active.delete(completed);
      settle();
    }
  }

  const permissionPresets = read(() => ctx.get("permissionPresets"));

  ctx.effect(function* () {
    // Publishing the preset is what puts the option into the session's permission
    // picker. Loading the plugin intercepts nothing until it is selected.
    if (permissionPresets !== undefined && permissionPresets !== null && typeof permissionPresets.registerAuto === "function") {
      yield permissionPresets.registerAuto(() => {
        if (!accepting) throw new Error("jev-review: integration is closing");
      });
      log(ctx, `permission preset "${AUTO_PRESET}" published; select it in the session's permission picker to enable review`);
    } else {
      log(ctx, "permissionPresets.registerAuto is unavailable; selecting the review mode will not be possible", "warn");
    }
    yield ctx.on(
      "tools/pre-execute",
      async (exec, next) => {
        let plan;
        try {
          plan = await planFor(exec);
        } catch (error) {
          // Last resort: an internal fault must fail closed, never allow.
          log(ctx, `unexpected failure: ${describeError(error)}`, "warn");
          return payloadFor(exec, failureVerdict(config, error));
        }
        if (plan.kind === "passthrough") return next();
        if (plan.kind === "cancel") return { kind: "cancel" };
        if (plan.kind === "deny") return plan.payload;
        // ask: let downstream listeners decide first, so a stricter downstream
        // guard is never swallowed by the confirmation prompt.
        const downstream = await next();
        if (lifecycle.signal.aborted) return { kind: "cancel" };
        if (downstream === null || downstream === undefined || downstream.kind !== "allow") return downstream;
        return plan.payload;
      },
      { prepend: true },
    );
    yield async () => {
      accepting = false;
      try {
        lifecycle.abort(new Error("jev-review disposed"));
      } catch {
        /* an already-aborted lifecycle controller is fine */
      }
      await Promise.allSettled([...active]);
    };
  }, "jev-review lifecycle");
}
