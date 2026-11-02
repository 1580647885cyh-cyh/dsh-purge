import assert from "node:assert/strict";
import test from "node:test";
import { PROMPT_CWD_VARIABLE, readPromptCwd, registerPromptVariables } from "../../lib/prompt-variables.js";

/**
 * 提示词装配变量兼容层的公开边界：
 *   - readPromptCwd：从宿主装配上下文取工作目录，缺失不抛；
 *   - registerPromptVariables：往宿主 SystemPrompt 注册 cwd，模板里的 {{cwd}} 才能渲染。
 * 断言只走宿主公开的 variable(name, provider) 与 assemble(context) 语义，不读替身内部状态。
 */

/** 与宿主 SystemPrompt.variable 同语义的最小替身：重名抛错，变量按装配上下文求值。 */
function fakeHost() {
  const registered = new Map();
  const systemPrompt = {
    variable(name, provider) {
      if (registered.has(name)) throw new Error(`prompt variable "${name}" is already registered`);
      registered.set(name, provider);
      return () => registered.delete(name);
    },
    /** 模拟宿主 assemble：变量表就是注册表按上下文求值。 */
    assemble(context) {
      const variables = {};
      for (const [name, provider] of registered) variables[name] = provider(context);
      return { sections: [], contexts: [], tools: [], variables };
    },
  };
  const ctx = { systemPrompt, ctx: undefined };
  ctx.systemPrompt.ctx = ctx;
  return { ctx };
}

function agentContext(cwd) {
  return { agent: { options: { provider: "verify-provider", model: "verify-model" }, session: { header: cwd === undefined ? {} : { cwd } } } };
}

test("readPromptCwd 取会话工作目录并去掉首尾空白，缺失时返回空串", () => {
  assert.equal(readPromptCwd(agentContext("D:\\dsh")), "D:\\dsh");
  assert.equal(readPromptCwd(agentContext("  D:\\dsh\\work  ")), "D:\\dsh\\work");
  assert.equal(readPromptCwd(agentContext(undefined)), "");
  assert.equal(readPromptCwd(agentContext("")), "");
  assert.equal(readPromptCwd(undefined), "");
});

test("readPromptCwd 容忍宿主代理在装配上下文上抛错", () => {
  const throwing = new Proxy({}, {
    get() { throw new Error("cannot get property without inject"); },
  });
  assert.equal(readPromptCwd(throwing), "");
});

test("registerPromptVariables 让模板里的 {{cwd}} 取到真实工作目录", () => {
  const { ctx } = fakeHost();
  const result = registerPromptVariables(ctx);
  assert.equal(result.ok, true);
  assert.deepEqual(result.names, [PROMPT_CWD_VARIABLE]);
  assert.equal(ctx.systemPrompt.assemble(agentContext("D:\\dsh\\work")).variables.cwd, "D:\\dsh\\work");
  assert.equal(ctx.systemPrompt.assemble(agentContext("  D:/dsh  ")).variables.cwd, "D:/dsh");
  assert.equal(ctx.systemPrompt.assemble(agentContext("D:/other")).variables.cwd, "D:/other", "变量按装配上下文求值，不缓存第一次的目录");
});

test("registerPromptVariables 缺工作目录时给出空串而不是 undefined", () => {
  const { ctx } = fakeHost();
  registerPromptVariables(ctx);
  assert.equal(ctx.systemPrompt.assemble(agentContext(undefined)).variables.cwd, "");
});

test("registerPromptVariables 重复调用不叠加、不抛错", () => {
  const { ctx } = fakeHost();
  assert.equal(registerPromptVariables(ctx).ok, true);
  assert.equal(registerPromptVariables(ctx).ok, true);
  const variables = ctx.systemPrompt.assemble(agentContext("D:/dsh")).variables;
  assert.deepEqual(Object.keys(variables), [PROMPT_CWD_VARIABLE], "重复注册后变量表仍只有一份 cwd");
  assert.equal(variables.cwd, "D:/dsh");
});

test("registerPromptVariables 在缺少 variable 接口的老宿主上不抛错", () => {
  const legacy = { systemPrompt: { section() {} } };
  const result = registerPromptVariables(legacy);
  assert.equal(result.ok, false);
  assert.equal(result.names.length, 0);
  assert.ok(result.errors.length > 0);
});
