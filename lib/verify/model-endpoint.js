import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 受控模型端点 + 无害工具调用（#4 的最后一条验收）。
 *
 * 用真实宿主 LLM 适配器（dsh-llm + dsh-llm-pi-ai，openai-completions 协议）连本机
 * 127.0.0.1 上的假端点：端点只回 tool_call，不发真实模型请求、不碰外网。
 * 模型产出的调用再交给真实 ToolRuntime 的公开执行入口（ctx.tools.execute），
 * 走宿主自己的参数校验与工具主体——不是只读 schema 文本。
 */

const FAKE_KEY_ENV = "DSH_VERIFY_ENDPOINT_KEY";
const PROVIDER = "verify-endpoint";
const MODEL = "verify-model";

/** 每个宿主上下文一套端点与适配器：适配器重复 apply 会重复声明内置 provider。 */
const sessions = new WeakMap();
const closed = new Set();

function moduleUrl(hostBase, rel) {
  return pathToFileURL(path.join(hostBase, rel)).href;
}

/** 一个按请求顺序回 tool_call 的 OpenAI 兼容端点（SSE）。 */
function startEndpoint() {
  const state = { requests: [], queue: [] };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let parsed = null;
      try { parsed = JSON.parse(body || "{}"); } catch { parsed = null; }
      const toolNames = Array.isArray(parsed && parsed.tools)
        ? parsed.tools.map((tool) => tool.function && tool.function.name).filter(Boolean)
        : [];
      state.requests.push({ method: request.method || "", url: request.url || "", toolNames });
      const call = state.queue.length > 0 ? state.queue.shift() : { id: "verify-call", name: "purge_status", arguments: {} };
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      const chunk = (payload) => response.write("data: " + JSON.stringify(payload) + "\n\n");
      chunk({
        id: "chatcmpl-verify",
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL,
        choices: [{
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            }],
          },
          finish_reason: null,
        }],
      });
      chunk({ id: "chatcmpl-verify", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });
  return { server, state, listening: new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port))) };
}

/** 收尾：关掉本进程起过的假端点，避免测试进程因为监听句柄不退出。 */
export function stopModelEndpoints() {
  for (const session of closed) {
    try { session.endpoint.server.close(); } catch { /* ignore */ }
  }
  closed.clear();
}

/** 首次使用时把假端点与适配器装进宿主上下文；之后复用同一端口。 */
async function ensureEndpoint(ctx, hostBase) {
  const existing = sessions.get(ctx);
  if (existing) return existing;
  const endpoint = startEndpoint();
  const port = await endpoint.listening;
  const llm = await import(moduleUrl(hostBase, "dsh-llm/lib/index.js"));
  const piAi = await import(moduleUrl(hostBase, "dsh-llm-pi-ai/lib/index.js"));
  if (typeof ctx.llm === "undefined") await ctx.plugin(llm.default, {}).await();
  process.env[FAKE_KEY_ENV] = "verify-endpoint-key";
  await ctx.plugin({ name: piAi.name, inject: piAi.inject, apply: piAi.apply, Config: piAi.Config }, {
    providers: {
      [PROVIDER]: {
        displayName: "verify endpoint",
        api: "openai-completions",
        baseURL: "http://127.0.0.1:" + port + "/v1",
        apiKeyEnv: FAKE_KEY_ENV,
        models: [{ id: MODEL }],
      },
    },
  }).await();
  const session = { endpoint, port };
  sessions.set(ctx, session);
  closed.add(session);
  return session;
}

/**
 * 跑一轮“模型端点 -> tool_call -> 工具执行”。
 * @param options.hostBase 宿主 @deepseek-ai 包根。
 * @param options.ctx 已加载插件的宿主上下文（ToolRuntime 在 ctx.tools）。
 * @param options.call 假端点要回的调用 `{ id, name, arguments }`。
 * @returns 端点请求、模型块与工具执行结果的结构化记录。
 */
export async function runToolCallRound({ hostBase, ctx, call } = {}) {
  const record = {
    kind: "verify.model-tool-call",
    ok: false,
    call: { name: call.name, arguments: call.arguments },
    endpoint: null,
    blocks: [],
    executed: null,
    error: "",
  };
  try {
    const session = await ensureEndpoint(ctx, hostBase);
    session.endpoint.state.queue.push(call);
    const seen = session.endpoint.state.requests.length;
    const chunks = [];
    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER,
      model: MODEL,
      messages: [{ role: "user", content: [{ type: "text", text: "call the tool" }] }],
      tools: ctx.tools.schemas(),
    })) chunks.push(chunk);
    record.endpoint = { port: session.port, requests: session.endpoint.state.requests.slice(seen) };
    record.blocks = chunks
      .filter((chunk) => chunk.type === "block-end" && chunk.block)
      .map((chunk) => ({ type: chunk.block.type, name: chunk.block.name || "", arguments: chunk.block.arguments || "" }));
    const toolCall = chunks.find((chunk) => chunk.type === "block-end" && chunk.block && chunk.block.type === "tool-call");
    if (!toolCall) {
      record.error = "模型端点没有产出 tool-call";
      return record;
    }
    let args = {};
    let parseError = "";
    try { args = JSON.parse(toolCall.block.arguments || "{}"); } catch (error) { parseError = String(error && error.message ? error.message : error); }
    if (parseError) {
      record.error = "tool-call 参数不是合法 JSON：" + parseError;
      return record;
    }
    const result = await ctx.tools.execute({
      name: toolCall.block.name,
      arguments: args,
      callId: toolCall.block.id || "verify-call",
      signal: AbortSignal.timeout(60000),
    });
    const text = Array.isArray(result && result.content)
      ? result.content.filter((block) => block && block.type === "text").map((block) => String(block.text || "")).join("\n")
      : "";
    record.executed = {
      isError: Boolean(result && result.isError),
      textLength: text.length,
      textHead: text.slice(0, 120),
      contentTypes: Array.isArray(result && result.content) ? result.content.map((block) => block && block.type).filter(Boolean) : [],
    };
    record.ok = record.executed.isError === false && text.length > 0;
    return record;
  } catch (error) {
    record.error = "受控模型端点探针失败：" + String(error && error.message ? error.message : error);
    return record;
  }
}
