/**
 * 提示词装配变量兼容层。
 *
 * 保护基线（1.1.71）里 `{{cwd}}` 是宿主提供的装配变量：用户模板与 prompt-inject
 * 写 `{{cwd}}`，由宿主在装配时渲染成真实目录。目标宿主的 dsh-agent-loop 只注册
 * provider/model，遇到未注册变量直接抛错，整份提示词渲染失败——那一轮请求发不出去。
 *
 * 这里在插件侧补回 cwd，让旧模板、自定义模板按原契约渲染。插件自己的段仍然不写
 * `{{cwd}}`：目录由宿主必需运行上下文提供（见 lib/identity.js 的 CWD_ONLY_SUFFIX），
 * 不在两处重复表达同一事实。
 */

export const PROMPT_CWD_VARIABLE = "cwd";

/**
 * 从宿主装配上下文读会话工作目录。
 * 宿主 ctx/context 是 Proxy，未注入的服务被点属性会抛；缺失一律按空串处理，
 * 因为变量求值返回 undefined 会让整份渲染失败。
 * @param context 宿主传给 SystemPrompt 变量 provider 的装配上下文。
 * @returns 去掉首尾空白的工作目录，或空串。
 */
export function readPromptCwd(context) {
  let value;
  try {
    value = context && context.agent && context.agent.session && context.agent.session.header
      ? context.agent.session.header.cwd
      : "";
  } catch {
    return "";
  }
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 要注册到的宿主对象：服务自身的 ctx 是全局层，插件 ctx 可能是 scope 层，两处都试。
 * 注册 section 与注册 variable 共用这一处，避免两份同构查找。
 */
export function promptHosts(ctx) {
  const hosts = [];
  const push = (host) => {
    if (host && !hosts.includes(host)) hosts.push(host);
  };
  try { push(ctx && ctx.systemPrompt ? ctx.systemPrompt.ctx : null); } catch { /* 代理未注入 */ }
  push(ctx);
  return hosts;
}

/**
 * 注册 cwd 装配变量。
 *
 * 幂等：宿主或更新版本已经注册同名变量时按「已存在」跳过（宿主原文含 already registered）。
 * 不可抛：老宿主没有 variable() 时只记账，不能让 apply 挂掉。
 * @param ctx 插件上下文。
 * @returns { ok, names, errors }，ok 表示 cwd 可用。
 */
export function registerPromptVariables(ctx) {
  const names = new Set();
  const errors = [];
  for (const host of promptHosts(ctx)) {
    let service = null;
    try {
      service = host.systemPrompt;
    } catch (error) {
      errors.push(String(error && error.message ? error.message : error));
      continue;
    }
    if (!service || typeof service.variable !== "function") {
      errors.push("宿主 SystemPrompt 没有 variable()，无法注册 " + PROMPT_CWD_VARIABLE);
      continue;
    }
    try {
      service.variable(PROMPT_CWD_VARIABLE, readPromptCwd);
      names.add(PROMPT_CWD_VARIABLE);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (message.includes("already registered")) continue;
      errors.push(message);
    }
  }
  return { ok: names.size > 0 || errors.length === 0, names: [...names], errors };
}
