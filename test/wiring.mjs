/**
 * Host-wiring test for `dsh-jev-review` (no live gateway traffic).
 *
 * A stub HTTP server answers the systemone endpoint with canned answers, so
 * this test proves the cordis wiring deterministically and for free:
 * the listener registration, the `run_code` / missing-agent skips, the exact
 * `allow` / `ask` / `deny` payload shapes, downstream-guard pass-through, the
 * `onError` degradation, the error normalisation and cancellation on disposal.
 *
 * Run with the runtime's own Node:
 *   node test/wiring.mjs
 *
 * @module dsh-jev-review/test/wiring
 */

import { createServer } from "node:http";

import { apply, name, inject } from "../lib/index.js";

let failures = 0;

/** Print one assertion result. */
function check(label, condition, detail = "") {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}

const calm = {
  needs_confirm: { type: "noul", noul: 0.03 },
  sends_sensitive: { type: "noul", noul: 0.02 },
  destination: { type: "choice", choice: "not_applicable", probabilities: { not_applicable: 0.95 } },
  reversibility: { type: "choice", choice: "simple", probabilities: { simple: 0.8, trivial: 0.2 } },
  blast_radius: { type: "choice", choice: "workspace", probabilities: { workspace: 0.9 } },
};
const forcePush = {
  needs_confirm: { type: "noul", noul: 0.85 },
  sends_sensitive: { type: "noul", noul: 0.03 },
  destination: { type: "choice", choice: "not_applicable", probabilities: { not_applicable: 0.9 } },
  reversibility: { type: "choice", choice: "bounded", probabilities: { bounded: 0.7 } },
  blast_radius: { type: "choice", choice: "shared_remote", probabilities: { shared_remote: 0.75 } },
};
const exfil = {
  needs_confirm: { type: "noul", noul: 0.9 },
  sends_sensitive: { type: "noul", noul: 0.96 },
  destination: { type: "choice", choice: "untrusted", probabilities: { untrusted: 0.95 } },
  reversibility: { type: "choice", choice: "trivial", probabilities: { trivial: 0.9 } },
  blast_radius: { type: "choice", choice: "public", probabilities: { public: 0.9 } },
};

let requests = 0;
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    requests += 1;
    let command = "";
    try {
      command = JSON.parse(body)?.state?.pending_action?.arguments?.command ?? "";
    } catch {
      command = "";
    }
    const reply = (status, text) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(text);
    };
    if (command.includes("INTERNAL-500")) return reply(500, '{"error":"boom"}');
    if (command.includes("CONTEXT-400")) {
      return reply(400, '{"error":{"message":"{\\"error\\":{\\"error_type\\":\\"max_tokens_exceeded\\"}}"}}');
    }
    if (command.includes("BAD-JSON")) return reply(200, "this is not json");
    const answers = command.includes("EXFIL") ? exfil : command.includes("FORCE") ? forcePush : calm;
    const send = () =>
      reply(200, JSON.stringify({ model: "typesafe/jev", answers, usage: { input_tokens: 11, output_tokens: 2 } }));
    if (command.includes("SLOW")) return void setTimeout(send, 500);
    send();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

/** A fake cordis context that records the registered waterfall listener. */
function fakeContext(config) {
  const state = { handler: undefined, options: undefined, disposers: [] };
  const ctx = {
    config,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    get: () => undefined,
    on(event, handler, options) {
      state.handler = handler;
      state.options = options;
      return () => {
        state.handler = undefined;
      };
    },
    effect(callback) {
      const generator = callback();
      for (let step = generator.next(); !step.done; step = generator.next()) {
        state.disposers.push(step.value);
      }
      return undefined;
    },
  };
  return { ctx, state };
}

/** A fake session sufficient for the snapshot path. */
function fakeSession() {
  const events = [
    { type: "user/message", seq: 0, data: { source: { kind: "user", rpcId: "rpc-1" }, content: [{ type: "text", text: "Fix the loader." }] } },
    { type: "user/message", seq: 1, data: { source: { kind: "agent-instructions" }, content: [{ type: "text", text: "Stay inside the workspace." }] } },
  ];
  return {
    header: { cwd: "E:\\projects\\demo" },
    surface: { nodes: [0, 1] },
    snapshotEvents: () => events,
    requestHeader: () => ({ tools: [{ name: "pwsh", description: "Run a command.", parameters: {} }] }),
    isOwnSeq: () => true,
  };
}

const execOf = (command, overrides = {}) => ({
  callId: "c1",
  rootCallId: "c1",
  name: "pwsh",
  arguments: { command },
  agent: { session: fakeSession() },
  signal: undefined,
  ...overrides,
});

console.log("=== wiring: registration ===");
const { ctx, state } = fakeContext({
  endpoint: `http://127.0.0.1:${port}`,
  apiKeyEnv: "JEV_TEST_KEY",
  timeoutMs: 5000,
});
process.env.JEV_TEST_KEY = "test-key";
apply(ctx);
check("plugin name", name === "jev-review", name);
check("inject includes tools and approval", inject.includes("tools") && inject.includes("approval"), inject.join(","));
check("registers a prepended tools/pre-execute listener", state.handler !== undefined && state.options?.prepend === true, JSON.stringify(state.options));

console.log("\n=== wiring: skips ===");
const downstreamAllow = { kind: "allow", marker: "downstream" };
let nextCalls = 0;
const next = async () => {
  nextCalls += 1;
  return downstreamAllow;
};
const before = requests;
const noAgent = await state.handler({ name: "pwsh", arguments: {}, parent: undefined }, next);
check("exec.agent undefined -> next()", noAgent === downstreamAllow, JSON.stringify(noAgent));
const runCode = await state.handler({ name: "run_code", arguments: {}, parent: undefined, agent: {} }, next);
check("outer run_code (parent undefined) -> next()", runCode === downstreamAllow);
check("skips performed no gateway request", requests === before, `${requests - before} extra`);
const ptcInner = await state.handler(execOf("Write-Output ok", { parent: "c-parent" }), next);
check("PTC inner call (parent set) IS reviewed", ptcInner === downstreamAllow && requests > before, JSON.stringify(ptcInner));

console.log("\n=== wiring: verdict payloads ===");
const allowed = await state.handler(execOf("Write-Output ok"), next);
check("calm review -> downstream result passed through untouched", allowed === downstreamAllow);

const denied = await state.handler(execOf("EXFIL credentials"), async () => downstreamAllow);
check("untrusted exfiltration -> kind deny", denied.kind === "deny", JSON.stringify(denied.kind));
check("deny info carries the structured error name/code", denied.info?.name === "JevReviewDeniedError" && denied.info?.code === "JEV_REVIEW_DENIED", JSON.stringify(denied.info));
check("deny reason is the English audit string", /^Jev review rejected tool "pwsh";/.test(denied.reason) && denied.reason.includes("sends_sensitive=0.96"), denied.reason.slice(0, 160));
check("deny never asks the user", denied.displayReason === undefined);

const asked = await state.handler(execOf("FORCE push main"), async () => downstreamAllow);
check("un-authorized force push -> kind ask", asked.kind === "ask", JSON.stringify(asked.kind));
check("ask carries en+zh displayReason", typeof asked.displayReason?.en === "string" && typeof asked.displayReason?.zh === "string");
check("zh displayReason names the grading ladder", asked.displayReason.zh.includes("Jev 判定") && asked.displayReason.zh.includes("不可逆程度"), asked.displayReason.zh.slice(0, 90));
check("ask reason is the English audit string with severity/category", asked.reason.includes("severity=") && asked.reason.includes("category=authorization_gap"), asked.reason.slice(0, 150));

const stricter = { kind: "deny", reason: "downstream sandbox policy" };
const swallowed = await state.handler(execOf("FORCE push main"), async () => stricter);
check("a downstream non-allow result is never swallowed by an ask", swallowed === stricter, JSON.stringify(swallowed));

console.log("\n=== wiring: failure degradation ===");
const gatewayFailure = await state.handler(execOf("INTERNAL-500"), async () => downstreamAllow);
check("HTTP 500 -> ask (onError default) with category review_failure", gatewayFailure.kind === "ask", gatewayFailure.kind);
check("HTTP 500 reason is short and does not leak the gateway body", gatewayFailure.reason.includes("could not be completed") && !gatewayFailure.reason.includes("boom"), gatewayFailure.reason.split("\n")[0].slice(0, 200));
check("HTTP 500 reason text is normalized as 'gateway error'", gatewayFailure.reason.includes("gateway error"), gatewayFailure.reason.slice(0, 120));

const contextFailure = await state.handler(execOf("CONTEXT-400"), async () => downstreamAllow);
check("nested 400 max_tokens_exceeded -> 'context limit'", contextFailure.reason.includes("context limit"), contextFailure.reason.slice(0, 150));
check("nested JSON is not echoed into the reason", !contextFailure.reason.includes("error_type") && !contextFailure.reason.includes("\\\""), contextFailure.reason.slice(0, 150));

const malformed = await state.handler(execOf("BAD-JSON"), async () => downstreamAllow);
check("malformed response -> ask, never allow", malformed.kind === "ask" && malformed.reason.includes("malformed response"), malformed.kind);

const { ctx: denyCtx, state: denyState } = fakeContext({
  endpoint: `http://127.0.0.1:${port}`,
  apiKeyEnv: "JEV_TEST_KEY",
  onError: "deny",
  timeoutMs: 5000,
});
apply(denyCtx);
const deniedOnError = await denyState.handler(execOf("INTERNAL-500"), async () => downstreamAllow);
check("onError=deny degrades a gateway failure into a final deny", deniedOnError.kind === "deny" && deniedOnError.info?.code === "JEV_REVIEW_DENIED");
const { ctx: offCtx, state: offState } = fakeContext({ enabled: false });
apply(offCtx);
check("enabled:false registers no listener", offState.handler === undefined);

console.log("\n=== wiring: cancellation on disposal ===");
const { ctx: slowCtx, state: slowState } = fakeContext({
  endpoint: `http://127.0.0.1:${port}`,
  apiKeyEnv: "JEV_TEST_KEY",
  timeoutMs: 5000,
});
apply(slowCtx);
const pending = slowState.handler(execOf("SLOW work"), next);
await new Promise((resolve) => setTimeout(resolve, 120));
for (const disposer of [...slowState.disposers].reverse()) await disposer?.();
const cancelled = await pending;
check("disposal aborts an in-flight review and cancels the call", cancelled?.kind === "cancel", JSON.stringify(cancelled));

server.close();
console.log(`\n${failures === 0 ? "all wiring checks passed" : `${failures} wiring check(s) failed`}`);
process.exitCode = failures === 0 ? 0 : 1;
