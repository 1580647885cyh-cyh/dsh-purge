import assert from "node:assert/strict";
import test from "node:test";
import { attachPromptRequest, buildRequestMessages } from "../../lib/verify/host-entry.js";

/**
 * 受控请求的证据组装：消息顺序照 dsh-agent-loop，端点摘要决定 request 通过与否。
 * 这里只测纯函数；真实宿主加载与提示词渲染在 host-admin 集成测试里。
 */

test("buildRequestMessages 按 agent-loop 顺序给出系统提示词、本轮消息与运行上下文", () => {
  const messages = buildRequestMessages({ promptText: "SYSTEM", contextText: "Current working directory: \"D:/dsh\"." });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].role, "system");
  assert.deepEqual(messages[0].content, [{ type: "text", text: "SYSTEM" }], "系统消息必须是内容块，字符串会让适配器丢掉整次请求");
  assert.equal(messages[1].role, "user");
  assert.equal(messages[1].content[0].text, "call the tool");
  assert.equal(messages[2].role, "user");
  assert.equal(messages[2].content[0].text, "Current working directory: \"D:/dsh\".");
});

test("buildRequestMessages 没有运行上下文时只发两条消息", () => {
  const messages = buildRequestMessages({ promptText: "SYSTEM", contextText: "" });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].content[0].text, "call the tool");
});

function round(ok, messages, system = { length: 0, hasInject: false }) {
  return { ok, endpoint: { requests: [{ messages, system }] }, error: ok ? "" : "没有 tool-call" };
}

test("attachPromptRequest 命中系统正文与工作目录上下文时通过", () => {
  const preset = { ok: true, passes: [], injectHead: "WHO YOU ARE" };
  attachPromptRequest(preset, round(true, [
    { role: "system", length: 10, hasInject: true },
    { role: "user", length: 13 },
    { role: "user", length: 40, hasWorkingDirectory: true },
  ]));
  assert.equal(preset.ok, true);
  assert.equal(preset.passes.at(-1).id, "request");
  assert.equal(preset.passes.at(-1).ok, true);
});

test("attachPromptRequest 在系统正文或上下文缺失时判失败，并保留端点摘要", () => {
  const noContext = { ok: true, passes: [], injectHead: "WHO YOU ARE" };
  attachPromptRequest(noContext, round(true, [{ role: "system", length: 10, hasInject: true }, { role: "user", length: 13 }]));
  assert.equal(noContext.ok, false);
  assert.match(noContext.passes.at(-1).detail, /未命中/);

  const noInject = { ok: true, passes: [], injectHead: "WHO YOU ARE" };
  attachPromptRequest(noInject, round(true, [{ role: "system", length: 10, hasInject: false }]));
  assert.equal(noInject.ok, false);

  const noRound = { ok: true, passes: [], injectHead: "" };
  attachPromptRequest(noRound, { ok: false, endpoint: { requests: [] }, error: "模型端点没有产出 tool-call" });
  assert.equal(noRound.ok, false);
  assert.match(noRound.passes.at(-1).detail, /tool-call/);
});

test("attachPromptRequest 允许适配器把系统消息折进 systemPrompt", () => {
  const preset = { ok: true, passes: [], injectHead: "WHO YOU ARE" };
  attachPromptRequest(preset, round(true, [
    { role: "user", length: 13 },
    { role: "user", length: 40, hasWorkingDirectory: true },
  ], { length: 10, hasInject: true }));
  assert.equal(preset.ok, true);
});
