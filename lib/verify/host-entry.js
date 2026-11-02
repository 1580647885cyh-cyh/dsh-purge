import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CWD_LEGACY_TEMPLATE, isRedteamSession } from "../identity.js";
import { resolveHostModule } from "../host-deps.js";
import { readPromptCwd } from "../prompt-variables.js";
import { realLocalAppData } from "./isolate.js";

/**
 * 宿主加载与请求准备入口（主入口）。
 *
 * 使用当前安装的 DeepSeek Harness 公开包：
 *   - @deepseek-ai/cordis 的 Context/plugin 生命周期；
 *   - @deepseek-ai/dsh-system-prompt 的 SystemPrompt 注册表与 renderPrompt；
 *   - @deepseek-ai/dsh-tools 的 ToolRuntime 注册表与 Schema 校验。
 * 插件通过 ctx.plugin() 真实加载，工具契约与提示词都从宿主公开 API 取得。
 */

export function resolveHostInstall({ installDir, env = process.env } = {}) {
  const base = installDir
    || env.DSH_VERIFY_HOST_DIR
    || path.join(realLocalAppData(env), "Programs", "DeepSeek Harness");
  const resourcesDir = path.join(base, "resources");
  const appDir = path.join(resourcesDir, "app");
  const hostBase = path.join(appDir, "dsh", "node_modules", "@deepseek-ai");
  const shellPackage = path.join(appDir, "package.json");
  const runtimePackage = path.join(appDir, "dsh", "package.json");
  if (!fs.existsSync(shellPackage) || !fs.existsSync(runtimePackage) || !fs.existsSync(hostBase)) {
    throw new Error("未找到可用的桌面宿主安装：" + base);
  }
  return { installDir: base, resourcesDir, appDir, hostBase, shellPackage, runtimePackage };
}

/** 宿主包入口的 file URL：host-entry / preset-entry / model-endpoint 共用同一套解析。 */
export function moduleUrl(base, relative) {
  return pathToFileURL(path.join(base, relative)).href;
}

export async function loadHostModules(hostBase) {
  const cordis = await import(moduleUrl(hostBase, "cordis/lib/index.js"));
  const systemPrompt = await import(moduleUrl(hostBase, "dsh-system-prompt/lib/index.js"));
  const tools = await import(moduleUrl(hostBase, "dsh-tools/lib/index.js"));
  return {
    Context: cordis.Context,
    SystemPrompt: systemPrompt.default,
    renderPrompt: systemPrompt.renderPrompt,
    renderContextSnapshot: systemPrompt.renderContextSnapshot,
    ToolRuntime: tools.default,
    assertObjectJsonSchema: tools.assertObjectJsonSchema,
    validateJsonSchemaValue: tools.validateJsonSchemaValue,
  };
}

/**
 * 用真实宿主包创建最小上下文并加载插件。
 * 调用前必须已把进程环境切到隔离工作区（见 isolate.applyProcessEnvironment）。
 */
export async function createHostContext({ hostBase, pluginRoot, config = {}, presetDir } = {}) {
  const host = await loadHostModules(hostBase);
  // 预设贡献的 persona 正文按宿主 SystemPrompt 的构造配置进入装配，与桌面选中预设时一致。
  const persona = await loadPresetPersona({ hostBase, presetDir });
  const ctx = new host.Context();
  await ctx.plugin(host.SystemPrompt, persona.loaded ? { personaPrefix: persona.prefix, personaSuffix: persona.suffix } : {}).await();
  await ctx.plugin(host.ToolRuntime, {}).await();
  // 与 dsh-agent-loop 一致：宿主只注册 provider/model 两个装配变量。
  ctx.systemPrompt.variable("provider", (context) => context && context.agent && context.agent.options ? context.agent.options.provider : undefined);
  ctx.systemPrompt.variable("model", (context) => context && context.agent && context.agent.options ? context.agent.options.model : undefined);
  installVerificationContexts(ctx);
  const pluginEntry = path.join(pluginRoot, "lib", "index.js");
  const pluginModule = await import(pathToFileURL(pluginEntry).href);
  const fiber = ctx.plugin(pluginModule.default, { autoApplyOnStart: false, autoUpdateOnStart: false, ...config });
  let loadError = null;
  try {
    await fiber.await();
  } catch (error) {
    loadError = String(error && error.message ? error.message : error);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  return {
    ctx,
    fiber,
    host,
    pluginModule,
    pluginEntry,
    loadError,
    persona,
    dispose() {
      try { if (fiber.dispose) fiber.dispose(); } catch { /* ignore */ }
    },
  };
}

const VERIFY_CWD = "D:/dsh/tmp/dsh-purge-verify/workspace";
/** 宿主 dsh-working-directory 的文本前缀；生成与断言共用一处，避免措辞改动后静默降级。 */
export const WORKING_DIRECTORY_PREFIX = "Current working directory:";

/**
 * 读随包预设的 persona 行配置：预设贡献的提示词正文就是这一段，用宿主自己的 yaml 包解析。
 * 读不到时如实返回 loaded:false，由 promptPreset 的 preset-persona 一项判失败，而不是静默跳过。
 */
async function loadPresetPersona({ hostBase, presetDir } = {}) {
  const file = presetDir ? path.join(presetDir, "agent.cordis.yml") : "";
  if (!file || !fs.existsSync(file)) return { loaded: false, prefix: "", suffix: "", source: "" };
  try {
    // yaml 与 @deepseek-ai/* 同级，位于宿主 node_modules 根。
    const yaml = await import(moduleUrl(path.dirname(hostBase), "yaml/dist/index.js"));
    const rows = yaml.parse(fs.readFileSync(file, "utf8"));
    const row = Array.isArray(rows) ? rows.find((item) => item && item.id === "persona") : null;
    const config = row && row.config ? row.config : {};
    return {
      loaded: Boolean(row),
      id: path.basename(path.dirname(file)),
      prefix: typeof config.prefix === "string" ? config.prefix : "",
      suffix: typeof config.suffix === "string" ? config.suffix : "",
      source: file,
    };
  } catch (error) {
    return { loaded: false, prefix: "", suffix: "", source: file, error: String(error && error.message ? error.message : error) };
  }
}

function testAgentContext(cwd = VERIFY_CWD, agentPreset = "") {
  const header = { cwd };
  // 载入哪份预设的 persona，就按那份预设声明会话：红队分支按预设判定，不靠文本猜。
  if (agentPreset) header.agentPreset = agentPreset;
  return {
    agent: {
      options: { provider: "verify-provider", model: "verify-model" },
      session: { header, events: [] },
    },
  };
}

/** 缺工作目录上下文：宿主没给 session.header.cwd 时，模板也不能因未解析变量渲染失败。 */
function agentContextWithoutCwd() {
  return {
    agent: {
      options: { provider: "verify-provider", model: "verify-model" },
      session: { header: {}, events: [] },
    },
  };
}

/**
 * 复刻宿主 dsh-working-directory 的公开契约：required 运行上下文、文本是 JSON 引号目录、
 * 不做插值（该包 contextText() 的原文格式）。另注册一条可选上下文，用来核对 required
 * 的生命周期：抑制可选上下文时，必需那条必须留下。
 */
function installVerificationContexts(ctx) {
  ctx.systemPrompt.context({
    name: "working-directory",
    order: ctx.systemPrompt.getContextOrder("WORKING_DIRECTORY"),
    required: true,
    text: (context) => WORKING_DIRECTORY_PREFIX + " " + JSON.stringify(readPromptCwd(context)) + ".",
  });
  ctx.systemPrompt.context({
    name: "verify:optional-context",
    order: ctx.systemPrompt.getContextOrder("SANDBOX_POLICY"),
    text: "Verify optional runtime context.",
  });
}

/** 报告只留长度与哈希：同一份摘要工具给提示词、上下文与端点消息共用。 */
export function sha256(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

/**
 * 捕获请求准备结果：系统提示词、动态上下文快照、工具契约与装配变量。
 * 提示词全文只落在 D 盘工作区；报告里保留长度、哈希和段名。
 */
export async function captureRequestPreparation({ ctx, host, hostInfo, workspace, persona } = {}) {
  const record = {
    kind: "host-entry.request",
    ok: false,
    host: hostInfo || null,
    prompt: null,
    context: null,
    tools: [],
    toolErrors: [],
    variables: [],
    templateContract: null,
    promptPreset: null,
    requestMessages: null,
    sections: [],
    error: "",
  };
  let assembly;
  let promptText = "";
  let contextText = "";
  const agentContext = () => testAgentContext(VERIFY_CWD, persona && persona.loaded ? String(persona.id || "") : "");
  try {
    assembly = await ctx.systemPrompt.assemble(agentContext());
  } catch (error) {
    record.error = "系统提示词装配失败：" + String(error && error.message ? error.message : error);
    return record;
  }
  record.variables = Object.keys(assembly.variables || {});
  record.sections = (assembly.sections || []).map((section) => ({ name: section.name, length: String(section.text || "").length }));
  try {
    promptText = host.renderPrompt(assembly);
    record.prompt = { length: promptText.length, sha256: sha256(promptText), head: promptText.slice(0, 120) };
    if (workspace) {
      fs.writeFileSync(path.join(workspace.out, "prompt.txt"), promptText, "utf8");
    }
  } catch (error) {
    record.error = "系统提示词渲染失败：" + String(error && error.message ? error.message : error);
  }
  try {
    contextText = host.renderContextSnapshot(assembly);
    record.context = { length: contextText.length, sha256: sha256(contextText) };
    if (workspace) {
      fs.writeFileSync(path.join(workspace.out, "context.txt"), contextText, "utf8");
    }
  } catch (error) {
    record.context = { length: 0, sha256: "", error: String(error && error.message ? error.message : error) };
  }
  const toolCapture = captureToolContracts({ ctx, host, workspace });
  record.tools = toolCapture.tools;
  record.toolErrors = toolCapture.toolErrors;
  if (toolCapture.error) record.error = record.error || toolCapture.error;
  // #5：模板渲染契约（旧模板/自定义模板/空与缺失后缀/正常与缺失工作目录）。
  // 变量表取自插件加载后的真实装配，所以失败就说明「插件补回的 cwd」没有生效。
  let variablesWithoutCwd = null;
  try {
    const missing = await ctx.systemPrompt.assemble(agentContextWithoutCwd());
    variablesWithoutCwd = missing.variables || null;
  } catch (error) {
    record.error = record.error || ("缺工作目录装配失败：" + String(error && error.message ? error.message : error));
  }
  record.templateContract = buildTemplateContract({ host, variables: assembly.variables || null, variablesWithoutCwd });

  // #5：完整提示词预设跑一遍新宿主的组装流程（装配 → 渲染 → 运行上下文 → 重复装配）。
  record.promptPreset = await capturePromptPreset({ ctx, host, assembly, promptText, contextText, persona, context: agentContext });
  record.requestMessages = buildRequestMessages({ promptText, contextText });
  record.ok = Boolean(record.prompt && record.prompt.length > 0 && record.templateContract.ok && record.promptPreset.ok);
  return record;
}

/**
 * 工具契约：用宿主自己的校验器跑有效 / 无效 / 额外属性 / 默认值案例，不只看 schema 文本。
 * 与提示词捕获分开，避免一个函数兼管两件互不相关的事。
 * @returns { tools, toolErrors, error }，契约全文只落隔离工作区。
 */
function captureToolContracts({ ctx, host, workspace } = {}) {
  const tools = [];
  const toolErrors = [];
  let error = "";
  try {
    const contracts = [];
    for (const schema of ctx.tools.schemas()) {
      const item = {
        name: schema.name,
        descriptionLength: String(schema.description || "").length,
        parameterKeys: Object.keys(schema.parameters || {}).sort(),
        sha256: sha256(JSON.stringify(schema.parameters || {})),
        schemaOk: true,
        error: "",
      };
      try {
        host.assertObjectJsonSchema(schema.parameters);
      } catch (schemaError) {
        item.schemaOk = false;
        item.error = String(schemaError && schemaError.message ? schemaError.message : schemaError);
      }
      try {
        const valid = host.validateJsonSchemaValue(schema.parameters, {}, "");
        const invalid = host.validateJsonSchemaValue(schema.parameters, "not-an-object", "");
        const extra = host.validateJsonSchemaValue(schema.parameters, { __verify_extra_property__: 1 }, "");
        const declared = schema.parameters && schema.parameters.properties ? schema.parameters.properties : {};
        const defaults = Object.entries(declared).filter(([, value]) => value && Object.hasOwn(value, "default"));
        item.contract = {
          validAccepted: valid.length === 0,
          invalidRejected: invalid.length > 0,
          extraRejected: extra.length > 0,
          extraViolations: extra.length,
          defaultsDeclared: defaults.length,
          // 没声明默认值的属性，省略时必须仍然合法（这也是原契约的一部分）。
          omissionAccepted: valid.length === 0,
        };
      } catch (contractError) {
        item.contract = { validAccepted: false, invalidRejected: false, extraRejected: false, error: String(contractError && contractError.message ? contractError.message : contractError) };
      }
      (item.schemaOk ? tools : toolErrors).push(item);
      contracts.push({ name: schema.name, description: schema.description, parameters: schema.parameters });
    }
    if (workspace) {
      fs.writeFileSync(path.join(workspace.out, "tool-contracts.json"), JSON.stringify(contracts, null, 2) + "\n", "utf8");
    }
  } catch (toolError) {
    error = "工具契约读取失败：" + String(toolError && toolError.message ? toolError.message : toolError);
  }
  return { tools, toolErrors, error };
}

/** 段签名：按名字与长度比较两次装配，避免把整段提示词留在记录里。 */
function sectionSignature(sections) {
  return (sections || []).map((section) => String(section && section.name) + ":" + String((section && section.text) || "").length).join("|");
}

function renderCase({ host, variables, sections, expected }) {
  try {
    const rendered = host.renderPrompt({ sections, contexts: [], tools: [], variables });
    return {
      ok: rendered === expected,
      rendered,
      expected,
      error: rendered === expected ? "" : "渲染结果与预期不一致",
    };
  } catch (error) {
    return { ok: false, rendered: "", expected, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * 模板渲染契约：旧模板、自定义模板、空/缺失后缀、正常/缺失工作目录。
 * 期望值来自保护基线的模板原文与固定目录字面量，不按当前实现反推。
 */
function buildTemplateContract({ host, variables, variablesWithoutCwd } = {}) {
  const legacy = CWD_LEGACY_TEMPLATE;
  const custom = "cwd={{cwd}}; model={{model}}";
  const body = [{ name: "dsh-purge:verify", text: "body", interpolate: false }];
  const cases = [
    { id: "cwd-present-legacy", variables, sections: [{ name: "deployment:persona-suffix", text: legacy, interpolate: true }], expected: "Working directory: " + VERIFY_CWD + ". " },
    { id: "cwd-present-custom", variables, sections: [{ name: "verify:custom", text: custom, interpolate: true }], expected: "cwd=" + VERIFY_CWD + "; model=verify-model" },
    { id: "empty-suffix", variables, sections: [{ name: "deployment:persona-suffix", text: "", interpolate: true }, ...body], expected: "body" },
    { id: "missing-suffix", variables, sections: body, expected: "body" },
    { id: "cwd-missing-legacy", variables: variablesWithoutCwd, sections: [{ name: "deployment:persona-suffix", text: legacy, interpolate: true }], expected: "Working directory: . " },
    { id: "cwd-missing-custom", variables: variablesWithoutCwd, sections: [{ name: "verify:custom", text: custom, interpolate: true }], expected: "cwd=; model=verify-model" },
  ];
  const results = cases.map((item) => ({
    id: item.id,
    ...renderCase({ host, variables: item.variables, sections: item.sections, expected: item.expected }),
  }));
  // 故障对照：同一份旧模板只给宿主自带的 provider/model 时，宿主必须拒绝——证明上面几条
  // 通过靠的是插件补回的 cwd，而不是宿主放宽了对未知变量的处理。
  const hostOnly = renderCase({
    host,
    variables: { provider: "verify-provider", model: "verify-model" },
    sections: [{ name: "deployment:persona-suffix", text: legacy, interpolate: true }],
    expected: "",
  });
  const regression = {
    rejected: hostOnly.ok === false && /unknown prompt variable/i.test(hostOnly.error),
    error: hostOnly.error,
  };
  return { ok: results.every((item) => item.ok) && regression.rejected, cases: results, regression };
}

/**
 * 真实装配里的模板：临时挂一段带 {{cwd}} 的段，走完整组装（含插件改写）再由宿主渲染器解析，
 * 证明变量不是在合成对象里自证。段用完即撤，不污染本次捕获的提示词。
 */
async function probeTemplateInAssembly({ ctx, host, context = () => testAgentContext() } = {}) {
  let dispose = null;
  try {
    const order = typeof ctx.systemPrompt.getSectionOrder === "function" ? ctx.systemPrompt.getSectionOrder("STRUCTURED_OUTPUT") : 9900;
    dispose = ctx.systemPrompt.section({
      name: "verify:template-probe",
      order: Number.isFinite(order) ? order : 9900,
      text: "cwd={{cwd}}; model={{model}}",
      interpolate: true,
    });
    const assembly = await ctx.systemPrompt.assemble(context());
    const expected = "cwd=" + VERIFY_CWD + "; model=verify-model";
    const rendered = host.renderPrompt(assembly);
    return { ok: rendered.includes(expected), detail: rendered.includes(expected) ? "真实装配渲染出 " + expected : "真实装配没有渲染出 " + expected };
  } catch (error) {
    return { ok: false, detail: "真实装配模板渲染失败：" + String(error && error.message ? error.message : error) };
  } finally {
    if (typeof dispose === "function") {
      try { dispose(); } catch { /* 段已撤 */ }
    }
  }
}

/**
 * 完整提示词预设：新宿主的组装流程跑一遍，核对基线内容保留、没有重复段、没有残留变量，
 * 以及宿主必需运行上下文在抑制/刷新下的生命周期。
 * 只记录长度、哈希、段名与逐项通过情况；提示词正文留在隔离工作区。
 */
async function capturePromptPreset({ ctx, host, assembly, promptText, contextText, persona, context = () => testAgentContext() } = {}) {
  const record = {
    kind: "host-entry.prompt-preset",
    ok: false,
    passes: [],
    prompt: { length: String(promptText || "").length, sha256: sha256(promptText) },
    context: {
      length: String(contextText || "").length,
      sha256: sha256(contextText),
      hasWorkingDirectory: String(contextText || "").includes(WORKING_DIRECTORY_PREFIX),
      names: (assembly && assembly.contexts ? assembly.contexts : []).map((context) => context.name),
    },
    sections: (assembly && assembly.sections ? assembly.sections : []).map((section) => ({ name: section.name, length: String(section.text || "").length })),
    variables: Object.keys((assembly && assembly.variables) || {}),
    stable: { repeats: 0, promptEqual: false, sectionsEqual: false, contextEqual: false },
    leftovers: [],
    duplicates: { injectSections: 0, repeatedNames: [] },
    persona: persona
      ? { loaded: Boolean(persona.loaded), prefixLength: String(persona.prefix || "").length, suffixLength: String(persona.suffix || "").length, source: persona.source || "", error: persona.error || "" }
      : null,
    // 载入哪份预设，就应当按那份预设的模式装配（红队预设会走红队分支）。
    mode: { redteam: Boolean(isRedteamSession(context())), preset: persona && persona.loaded ? String(persona.id || "") : "" },
    injectHead: "",
    request: null,
    error: "",
  };
  const passes = record.passes;
  passes.push({
    id: "assemble",
    ok: record.sections.length > 0 && record.variables.includes("cwd"),
    detail: "sections=" + record.sections.length + " variables=" + record.variables.join(","),
  });
  passes.push({ id: "render", ok: record.prompt.length > 0, detail: record.prompt.length + " 字符" });
  const templateProbe = await probeTemplateInAssembly({ ctx, host, context });
  passes.push({ id: "template-in-assembly", ok: templateProbe.ok, detail: templateProbe.detail });
  const injected = record.sections.some((section) => section.name === "dsh-purge" && section.length > 0);
  const personaSection = record.sections.find((section) => section.name === "deployment:persona-prefix");
  const personaRequired = Boolean(persona && persona.loaded);
  passes.push({
    id: "baseline-sections",
    ok: injected
      && Boolean(personaSection)
      && record.sections.some((section) => section.name === "deployment:persona-suffix")
      && !record.sections.some((section) => section.name === "harness:identity")
      && (!personaRequired || (personaSection && personaSection.length > 0)),
    detail: "基线段：" + record.sections.map((section) => section.name + "(" + section.length + ")").join(","),
  });
  const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();
  const personaNeedle = personaRequired ? normalize(persona.prefix).slice(0, 80) : "";
  const personaRendered = Boolean(personaNeedle) && normalize(promptText).includes(personaNeedle);
  passes.push({
    id: "preset-persona",
    ok: personaRequired && personaRendered,
    detail: personaRequired
      ? "随包预设 persona " + String(persona.prefix || "").length + " 字符，进装配并原样保留：" + (personaRendered ? "是" : "否")
      : "未载入随包预设 persona：" + String((persona && persona.error) || (persona && persona.source) || ""),
  });
  passes.push({
    id: "context",
    ok: record.context.hasWorkingDirectory,
    detail: record.context.names.length > 0 ? "运行上下文 " + record.context.names.join(",") : "无运行上下文",
  });
  const injectSection = (assembly && assembly.sections ? assembly.sections : []).find((section) => section && section.name === "dsh-purge" && String(section.text || "").trim());
  record.injectHead = injectSection ? String(injectSection.text).trim().slice(0, 60) : "";
  // 连续步骤各自会重新装配：连跑三次，任意一次与前一次的差异都算不稳定。
  const repeats = 3;
  try {
    const firstSignature = sectionSignature(assembly && assembly.sections);
    const results = [];
    for (let index = 1; index < repeats; index += 1) {
      const again = await ctx.systemPrompt.assemble(context());
      results.push({
        promptEqual: host.renderPrompt(again) === String(promptText || ""),
        sectionsEqual: sectionSignature(again.sections) === firstSignature,
        contextEqual: host.renderContextSnapshot(again) === String(contextText || ""),
      });
    }
    record.stable = {
      repeats,
      promptEqual: results.every((item) => item.promptEqual),
      sectionsEqual: results.every((item) => item.sectionsEqual),
      contextEqual: results.every((item) => item.contextEqual),
    };
  } catch (error) {
    record.error = "重复装配失败：" + String(error && error.message ? error.message : error);
  }
  passes.push({
    id: "stability",
    ok: Boolean(record.stable.promptEqual && record.stable.sectionsEqual && record.stable.contextEqual),
    detail: "重复装配 " + record.stable.repeats + " 次，提示词/段/上下文一致：" + (record.stable.promptEqual && record.stable.sectionsEqual && record.stable.contextEqual ? "是" : "否"),
  });
  let suppressor = null;
  if (typeof ctx.systemPrompt.suppressRuntimeContext !== "function") {
    passes.push({ id: "required-context", ok: false, detail: "宿主没有 suppressRuntimeContext()，无法核对 required 上下文生命周期" });
  } else try {
    suppressor = ctx.systemPrompt.suppressRuntimeContext();
    const suppressed = await ctx.systemPrompt.assemble(context());
    const suppressedNames = (suppressed.contexts || []).map((context) => context.name);
    const suppressedSnapshot = host.renderContextSnapshot(suppressed);
    passes.push({
      id: "required-context",
      ok: suppressedNames.includes("working-directory") && !suppressedNames.includes("verify:optional-context") && String(suppressedSnapshot).includes(WORKING_DIRECTORY_PREFIX),
      detail: "抑制可选上下文后：" + suppressedNames.join(","),
    });
    const refreshed = ctx.systemPrompt.refreshContext(suppressed, {});
    const refreshedNames = (refreshed.contexts || []).map((context) => context.name);
    passes.push({
      id: "refresh",
      ok: refreshedNames.includes("working-directory"),
      detail: "刷新后：" + refreshedNames.join(","),
    });
  } catch (error) {
    passes.push({ id: "required-context", ok: false, detail: String(error && error.message ? error.message : error) });
  } finally {
    if (typeof suppressor === "function") {
      try { suppressor(); } catch { /* 已释放 */ }
    }
  }
  try {
    const restored = await ctx.systemPrompt.assemble(context());
    const restoredNames = (restored.contexts || []).map((context) => context.name);
    passes.push({ id: "suppressor-dispose", ok: restoredNames.includes("verify:optional-context"), detail: "释放抑制后：" + restoredNames.join(",") });
  } catch (error) {
    passes.push({ id: "suppressor-dispose", ok: false, detail: String(error && error.message ? error.message : error) });
  }
  const leftoverMatches = (String(promptText || "") + "\n" + String(contextText || "")).match(/\{\{[a-z][a-z0-9_]*\}\}/g) || [];
  record.leftovers = [...new Set(leftoverMatches)];
  passes.push({ id: "no-leftovers", ok: record.leftovers.length === 0, detail: record.leftovers.length === 0 ? "0 个未解析变量" : record.leftovers.join(",") });
  const names = record.sections.map((section) => section.name);
  const repeatedNames = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];
  record.duplicates = {
    injectSections: record.sections.filter((section) => section.name === "dsh-purge" && section.length > 0).length,
    repeatedNames,
  };
  passes.push({
    id: "no-duplication",
    ok: repeatedNames.length === 0 && record.duplicates.injectSections <= 1,
    detail: "注入段 " + record.duplicates.injectSections + " 份" + (repeatedNames.length ? "，重复段：" + repeatedNames.join(",") : ""),
  });
  record.ok = passes.every((pass) => pass.ok);
  return record;
}

/**
 * 受控请求的消息：按 dsh-agent-loop 的顺序——系统提示词、本轮用户消息、运行上下文快照。
 * @returns 交给宿主 LLM 适配器的消息数组。
 */
export function buildRequestMessages({ promptText, contextText } = {}) {
  // 宿主消息模型的 content 是内容块数组；字符串会让适配器在历史校验里直接失败（只剩 finish 块）。
  const messages = [{ role: "system", content: [{ type: "text", text: String(promptText || "") }] }];
  messages.push({ role: "user", content: [{ type: "text", text: "call the tool" }] });
  if (String(contextText || "").trim()) messages.push({ role: "user", content: [{ type: "text", text: String(contextText) }] });
  return messages;
}

/**
 * 把受控请求的实际消息记进提示词预设记录：系统消息要命中插件正文，运行上下文消息要带工作目录。
 * @param promptPreset capturePromptPreset 的记录。
 * @param round runToolCallRound 的结果。
 */
export function attachPromptRequest(promptPreset, round) {
  if (!promptPreset) return promptPreset;
  const request = round && round.endpoint && Array.isArray(round.endpoint.requests) && round.endpoint.requests.length > 0
    ? round.endpoint.requests[0]
    : null;
  const messages = request && Array.isArray(request.messages) ? request.messages : [];
  // 适配器可能把系统消息折进 systemPrompt，也可能原样透传；两处任一命中插件正文即可。
  const system = messages.find((message) => message.role === "system");
  const systemText = request && request.system ? request.system : null;
  const contextMessage = messages.find((message) => message.role === "user" && message.hasWorkingDirectory === true);
  const injectOk = promptPreset.injectHead
    ? Boolean((system && system.hasInject === true) || (systemText && systemText.hasInject === true))
    : true;
  const systemSeen = Boolean((system && system.length > 0) || (systemText && systemText.length > 0));
  const ok = Boolean(round && round.ok && systemSeen && injectOk && contextMessage);
  promptPreset.request = request;
  promptPreset.passes.push({
    id: "request",
    ok,
    detail: ok
      ? "系统消息命中插件正文，运行上下文消息带工作目录"
      : ((round && round.error) || "受控请求消息未命中提示词/运行上下文"),
  });
  promptPreset.ok = Boolean(promptPreset.ok && ok);
  return promptPreset;
}

/** 预设文件静态核对：记录新宿主已废弃的配置字段，不修改预设。 */
export function auditPresets(presetRoot) {
  const out = { root: presetRoot || "", files: [] };
  if (!presetRoot || !fs.existsSync(presetRoot)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(presetRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(presetRoot, entry.name, "agent.cordis.yml");
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const deprecated = [];
    text.split(/\r?\n/).forEach((line, index) => {
      const match = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:/.exec(line);
      if (match && match[1] === "toolFilter") deprecated.push({ key: match[1], line: index + 1 });
    });
    out.files.push({ id: entry.name, file, deprecated });
  }
  return out;
}

/** 桥接模块只会在本进程导入一次：第二次调用时记录缓存命中，避免把旧结果当成本次证据。 */
const bridgeImports = new Set();

async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function bridgeSummary(result) {
  return {
    ok: result.ok,
    via: result.via,
    hostRoot: result.hostRoot,
    entry: result.entry,
    error: result.error,
    tried: result.tried.map((row) => ({ via: row.via, status: row.status })),
  };
}

/**
 * 工具桥接探针：预设行 dsh-purge/redteam/tools 在导入时就要解析 @deepseek-ai/dsh-tools。
 *
 * 三段证据：
 *   1. 隔离桌面布局：去掉 DSH_BASE 便捷锚点，按 DSH_DESKTOP_INSTALL → resources/app/dsh
 *      解析，确认候选命中且结果落在隔离副本内；
 *   2. 真实宿主解析：只读地把锚点指向真实桌面安装，记录命中的包根与候选状态；
 *   3. 真实宿主加载：在同一锚点下导入桥接模块；导入成功即说明 defineTool 拿到了
 *      （模块顶层解析失败会直接抛错）。不写真实安装，不调用任何管理操作。
 */
export async function probeToolBridge({ pluginRoot, hostInstall } = {}) {
  const specifier = "@deepseek-ai/dsh-tools";
  const record = { kind: "host-entry.tool-bridge", ok: false, specifier, isolated: null, host: null, loaded: null, error: "" };
  record.isolated = bridgeSummary(await withEnv({ DSH_BASE: undefined }, () => resolveHostModule(specifier)));
  if (!pluginRoot) {
    record.error = "缺少插件根目录，未加载工具桥接模块";
    return record;
  }
  const hostAnchors = { DSH_BASE: undefined, DSH_DESKTOP_INSTALL: hostInstall && hostInstall.installDir };
  record.host = bridgeSummary(await withEnv(hostAnchors, () => resolveHostModule(specifier)));
  const moduleUrl = pathToFileURL(path.join(pluginRoot, "lib", "redteam", "tools.js")).href;
  const cached = bridgeImports.has(moduleUrl);
  try {
    await withEnv(hostAnchors, async () => {
      const mod = await import(moduleUrl);
      record.loaded = {
        ok: true,
        apply: typeof mod.apply === "function",
        name: mod.name || "",
        cached,
      };
    });
  } catch (error) {
    record.error = "工具桥接模块加载失败：" + String(error && error.message ? error.message : error);
    record.loaded = { ok: false, apply: false, name: "", cached };
  } finally {
    bridgeImports.add(moduleUrl);
  }
  record.ok = Boolean(record.isolated.ok && record.host.ok && record.loaded && record.loaded.ok);
  return record;
}

export function summarizeHostEntry(record) {
  return {
    ok: record.ok,
    promptLength: record.prompt ? record.prompt.length : 0,
    promptSha256: record.prompt ? record.prompt.sha256 : "",
    sectionNames: (record.sections || []).map((section) => section.name),
    variables: record.variables || [],
    tools: (record.tools || []).map((tool) => tool.name),
    toolErrors: (record.toolErrors || []).map((tool) => ({ name: tool.name, error: tool.error })),
    templateContract: record.templateContract,
    promptPreset: record.promptPreset,
    error: record.error || "",
  };
}
