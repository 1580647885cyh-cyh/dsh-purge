import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolveHostModule } from "../host-deps.js";
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
export async function createHostContext({ hostBase, pluginRoot, config = {} } = {}) {
  const host = await loadHostModules(hostBase);
  const ctx = new host.Context();
  await ctx.plugin(host.SystemPrompt, {}).await();
  await ctx.plugin(host.ToolRuntime, {}).await();
  // 与 dsh-agent-loop 一致：宿主只注册 provider/model 两个装配变量。
  ctx.systemPrompt.variable("provider", (context) => context && context.agent && context.agent.options ? context.agent.options.provider : undefined);
  ctx.systemPrompt.variable("model", (context) => context && context.agent && context.agent.options ? context.agent.options.model : undefined);
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
    dispose() {
      try { if (fiber.dispose) fiber.dispose(); } catch { /* ignore */ }
    },
  };
}

function testAgentContext(cwd) {
  return {
    agent: {
      options: { provider: "verify-provider", model: "verify-model" },
      session: { header: { cwd: cwd || "D:/dsh/tmp/dsh-purge-verify/workspace" }, events: [] },
    },
  };
}

function sha256(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

/**
 * 捕获请求准备结果：系统提示词、动态上下文快照、工具契约与装配变量。
 * 提示词全文只落在 D 盘工作区；报告里保留长度、哈希和段名。
 */
export async function captureRequestPreparation({ ctx, host, hostInfo, workspace } = {}) {
  const record = {
    kind: "host-entry.request",
    ok: false,
    host: hostInfo || null,
    prompt: null,
    context: null,
    tools: [],
    toolErrors: [],
    variables: [],
    cwdTemplate: null,
    sections: [],
    error: "",
  };
  let assembly;
  try {
    assembly = await ctx.systemPrompt.assemble(testAgentContext());
  } catch (error) {
    record.error = "系统提示词装配失败：" + String(error && error.message ? error.message : error);
    return record;
  }
  record.variables = Object.keys(assembly.variables || {});
  record.sections = (assembly.sections || []).map((section) => ({ name: section.name, length: String(section.text || "").length }));
  try {
    const text = host.renderPrompt(assembly);
    record.prompt = { length: text.length, sha256: sha256(text), head: text.slice(0, 120) };
    if (workspace) {
      fs.writeFileSync(path.join(workspace.out, "prompt.txt"), text, "utf8");
    }
  } catch (error) {
    record.error = "系统提示词渲染失败：" + String(error && error.message ? error.message : error);
  }
  try {
    const contextText = host.renderContextSnapshot(assembly);
    record.context = { length: contextText.length, sha256: sha256(contextText) };
  } catch (error) {
    record.context = { length: 0, sha256: "", error: String(error && error.message ? error.message : error) };
  }
  try {
    const schemas = ctx.tools.schemas();
    const contracts = [];
    for (const schema of schemas) {
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
      } catch (error) {
        item.schemaOk = false;
        item.error = String(error && error.message ? error.message : error);
      }
      // 参数契约：用宿主自己的校验器跑四类案例（有效 / 无效 / 额外属性 / 默认值），不只看 schema 文本。
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
      } catch (error) {
        item.contract = { validAccepted: false, invalidRejected: false, extraRejected: false, error: String(error && error.message ? error.message : error) };
      }
      (item.schemaOk ? record.tools : record.toolErrors).push(item);
      contracts.push({ name: schema.name, description: schema.description, parameters: schema.parameters });
    }
    if (workspace) {
      fs.writeFileSync(path.join(workspace.out, "tool-contracts.json"), JSON.stringify(contracts, null, 2) + "\n", "utf8");
    }
  } catch (error) {
    record.error = record.error || ("工具契约读取失败：" + String(error && error.message ? error.message : error));
  }
  // 宿主只注册 provider/model；自定义模板里的 {{cwd}} 仍会让渲染失败（已知故障，保留记录）。
  try {
    host.renderPrompt({
      sections: [{ name: "verify:custom-cwd", text: "cwd = {{cwd}}", interpolate: true }],
      contexts: [],
      tools: [],
      variables: assembly.variables || {},
    });
    record.cwdTemplate = { ok: true, error: "" };
  } catch (error) {
    record.cwdTemplate = { ok: false, error: String(error && error.message ? error.message : error) };
  }
  record.ok = Boolean(record.prompt && record.prompt.length > 0);
  return record;
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
    cwdTemplate: record.cwdTemplate,
    error: record.error || "",
  };
}
