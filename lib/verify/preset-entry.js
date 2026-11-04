import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleUrl } from "./host-entry.js";
import { readCompositionRows } from "../redteam/preset-composition.js";
import { deriveWorkerRows, findToolFilterKeys, LEGACY_DENIED_ROWS, migrateToolFilter, WORKER_PRESET_ID } from "../redteam/preset-migration.js";

/**
 * 预设与工具注册入口（#4）。
 *
 * 复现路径：宿主 0.2.1-rc.5 的预设是把 `agent.cordis.yml` 的每一行交给 cordis
 * `ctx.plugin(模块, 行 config)` 挂载（registry 的 mountPreset → EntryTree → Entry.init）。
 * 丢弃 `toolFilter` 后，挂载就断在 `tool-subagent` 这一行的 apply 上，
 * registry 把该行记为 `broken`（真实状态文件 DSH_HOME/redteam/preset-declare.json
 * 记录的就是这句）。
 *
 * 所以本入口的做法与真实挂载同一条路径：读真实预设文本 → 迁移 → 用真实宿主包
 * 按行 config 挂载该行。负向（旧 toolFilter）应当复现宿主报错；正向（迁移后）应当挂上；
 * worker 组合应当只少那三行工具。
 *
 * 已知局限：不启动 profile 的 Loader 与整条服务图，因此“整份预设一次挂载成功”
 * 由真实桌面运行（#7）兜底；这里证明的是失败单元本身与组合等价性。
 */

const ROW_MODULES = {
  "tool-subagent": { kind: "host", pkg: "dsh-tool-subagent", entry: "lib/index.js" },
};

/** 自研工具行的模块（预设里写的是包内子路径，不是宿主包）。 */
const LOCAL_TOOLS_FILE = fileURLToPath(new URL("../redteam/tools.js", import.meta.url));

/**
 * 行名里能认出的自研行：`./xxx.mjs`（预设目录内）或 `dsh-purge/xxx`（插件包内）。
 * 宿主行不在这里——它们用自己的包与 Config，隔离探针不越权替宿主挂载。
 */
export function ownRowIds(rows, presetDir = "") {
  const out = [];
  const walk = (list) => {
    for (const row of list || []) {
      if (!row || typeof row !== "object") continue;
      if (row.group === true && Array.isArray(row.config)) {
        walk(row.config);
        continue;
      }
      const name = typeof row.name === "string" ? row.name : "";
      const localFile = name.startsWith("file:") && withinDirectory(fileURLToPath(name), presetDir);
      if (name.startsWith("./") || name.startsWith("dsh-purge/") || localFile) out.push({ id: row.id, name });
    }
  };
  walk(rows);
  return out;
}

/** 文件是否落在预设目录里（presetDir 为空时不判定）。 */
function withinDirectory(file, presetDir) {
  if (!presetDir) return false;
  const rel = path.relative(path.resolve(presetDir), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** 行 → 可导入的模块目标；宿主行查表，自研行按包内路径解析。 */
export function rowTarget(row, presetDir) {
  const fixed = ROW_MODULES[row.id];
  if (fixed) return fixed;
  const name = typeof row.name === "string" ? row.name : "";
  if (name.startsWith("file:")) {
    const file = fileURLToPath(name);
    return fs.existsSync(file) ? { kind: "local", file } : null;
  }
  if (name.startsWith("./")) {
    const file = path.join(presetDir, name.slice(2));
    return fs.existsSync(file) ? { kind: "local", file } : null;
  }
  if (name === "dsh-purge/redteam/tools") return { kind: "local", file: LOCAL_TOOLS_FILE };
  return null;
}

/** 读宿主包；与 host-entry 一样按桌面布局的 @deepseek-ai 根解析。 */
async function loadHostPackages(hostBase) {
  const cordis = await import(moduleUrl(hostBase, "cordis/lib/index.js"));
  const systemPrompt = await import(moduleUrl(hostBase, "dsh-system-prompt/lib/index.js"));
  const tools = await import(moduleUrl(hostBase, "dsh-tools/lib/index.js"));
  const registry = await import(moduleUrl(hostBase, "dsh-agent-preset-registry/lib/index.js"));
  const scope = await import(moduleUrl(hostBase, "dsh-scope/lib/index.js"));
  const preset = await import(moduleUrl(hostBase, "dsh-agent-preset/lib/index.js"));
  return {
    Context: cordis.Context,
    SystemPrompt: systemPrompt.default,
    ToolRuntime: tools.default,
    entryListProblem: registry.entryListProblem,
    createScope: scope.createScope,
    AgentPreset: preset.default,
  };
}

/** 组合校验：宿主 registry 在挂载前对行列表做的同一检查。 */
export function compositionProblem(entryListProblem, rows) {
  return entryListProblem(rows) || "";
}

/**
 * 声明校验：插件行 `@deepseek-ai/dsh-agent-preset` 声明 preset 时用的同一份 Config。
 * 这是 registry.register() 收到的对象形状契约（id/name/description/order/plugins）。
 */
export function declarationProblem(AgentPreset, definition) {
  try {
    AgentPreset.Config(definition);
    return "";
  } catch (error) {
    return String(error && error.message ? error.message : error);
  }
}

/**
 * 按真实行 config 挂载一个插件行。
 * 服务用最小替身：本入口只关心这一行自己的配置契约与它注册进 tools 的东西，
 * 替身不参与断言；tool-subagent 需要的 agentPresets/subagents/sessionProjections
 * 与真实宿主同名同形。
 */
async function mountRow({ host, hostBase, row, agentPresetId, presetDir }) {
  const ctx = new host.Context();
  await ctx.plugin(host.SystemPrompt, {}).await();
  await ctx.plugin(host.ToolRuntime, {}).await();
  ctx.provide("sessionProjections", { register() {}, stateOf() {}, stateOfSession() {} });
  // 宿主常驻组合里的两个伴生服务：模型选择设置与 Agent 注册表。行 config 需要它们存在。
  ctx.provide("subagentModelSelection", { current: () => ({ enabled: false }), on() { return () => {}; } });
  ctx.provide("agents", { list: () => [] });
  ctx.provide("subagents", {
    getProvider: (name) => (name === "spawn"
      ? {
        name: "spawn",
        capabilities: { agentPreset: true, depthLimit: true, agentOptions: true },
        inheritsParentContext: false,
        prepareContinuable: true,
      }
      : undefined),
    resolveMaxDepth: (value) => (value === "provider-managed" ? undefined : value),
    startActivation: async () => ({ childId: "verify-child" }),
  });
  ctx.provide("agentPresets", {
    readDocument: async (id) => ({ agentPreset: id, content: "", description: id === agentPresetId ? "verify fixture" : undefined }),
    list: async () => [],
    composedPreset: () => agentPresetId,
  });
  const target = rowTarget(row, presetDir || "");
  if (!target) return { ok: false, error: "找不到该行的模块：" + row.id + "（" + (row.name || "") + "）", tools: [] };
  let module;
  try {
    module = target.kind === "host"
      ? await import(moduleUrl(hostBase, target.pkg + "/" + target.entry))
      : await import(pathToFileURL(target.file).href);
  } catch (error) {
    return { ok: false, error: "导入失败：" + String(error && error.message ? error.message : error), tools: [] };
  }
  const plugin = typeof module.default === "function" || (module.default && module.default.apply)
    ? module.default
    : { name: module.name, inject: module.inject, apply: module.apply, Config: module.Config };
  const config = row.config === undefined || row.config === null ? {} : row.config;
  // 真实挂载发生在预设 scope 里（registry.mountPreset 的 createScope）；行在常驻组合下
  // 按 Agent 安装工具，需要 scope 才能走那条分支。
  const scopeKey = {};
  const scope = host.createScope(ctx, scopeKey);
  const scoped = scope.ctx || ctx;
  try {
    const fiber = scoped.plugin(plugin, config);
    await fiber.await();
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), tools: ctx.tools.schemas().map((tool) => tool.name) };
  }
  // 行是在 scope 里挂的：工具也注册在那一层，父 ctx 的 schemas() 看不到它们。
  let tools = [];
  try {
    const runtime = typeof scoped.get === "function" ? scoped.get("tools") : undefined;
    if (runtime && typeof runtime.schemas === "function") tools = runtime.schemas(scopeKey);
  } catch { /* 拿不到就当没注册，交给调用方判失败 */ }
  return { ok: true, error: "", tools: tools.map((tool) => tool.name) };
}

/** 读 preset.yml 的展示字段；读不到就只用 id。 */
function readPresetMeta(presetDir) {
  try {
    const text = fs.readFileSync(path.join(presetDir, "preset.yml"), "utf8");
    const meta = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^(name|description|order):\s*(.+)$/.exec(line);
      if (!match) continue;
      const value = match[2].trim();
      meta[match[1]] = match[1] === "order" ? Number(value) : value;
    }
    return meta;
  } catch {
    return {};
  }
}

/** 从行列表里递归找一行（穿透 group）。 */
export function findRow(rows, id) {
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    if (row.id === id) return row;
    if (row.group === true && Array.isArray(row.config)) {
      const nested = findRow(row.config, id);
      if (nested) return nested;
    }
  }
  return null;
}

/** 反向构造旧配置：把 1.1.71 的 toolFilter.deny 加回迁移后的那一行。 */
export function withLegacyToolFilter(rows, deny = LEGACY_DENIED_ROWS.map((entry) => entry.tool)) {
  const clone = (list) => list.map((row) => {
    if (!row || typeof row !== "object") return row;
    const copy = { ...row };
    if (row.group === true && Array.isArray(row.config)) copy.config = clone(row.config);
    return copy;
  });
  const out = clone(rows);
  const target = findRow(out, "tool-subagent");
  if (target) target.config = { ...(target.config || {}), toolFilter: { deny: [...deny] } };
  return out;
}

/**
 * 预设入口是否成立：组合/迁移/worker 全对，每个自研行都挂上，且工具行真的注册出工具。
 * 自研行少挂一行就是失败——报告不能把「只挂了一行」渲染成整份预设通过。
 */
export function presetEntryOk(record) {
  const coverage = record.coverage || {};
  const toolsRow = record.toolsRow;
  return Boolean(
    record.composition
    && record.composition.problem === ""
    && record.composition.declaration === ""
    && record.worker
    && record.worker.declaration === ""
    && record.worker.mount
    && record.worker.mount.ok
    && record.worker.problem === ""
    && Array.isArray(record.worker.removed)
    && record.worker.removed.length === LEGACY_DENIED_ROWS.length
    && record.worker.agentPreset === WORKER_PRESET_ID
    && Array.isArray(record.toolFilter)
    && record.toolFilter.length === 0
    && record.migration
    && record.migration.changed === false
    && record.legacy
    && record.legacy.rejected === true
    && record.migrated
    && record.migrated.ok === true
    && Array.isArray(coverage.unmountedOwn)
    && coverage.unmountedOwn.length === 0
    && toolsRow
    && toolsRow.ok === true
    && Array.isArray(toolsRow.tools)
    && toolsRow.tools.length > 0
  );
}

/**
 * 预设入口探针。
 * @param options.hostBase 宿主 @deepseek-ai 包根（桌面 resources/app/dsh/node_modules/@deepseek-ai）。
 * @param options.presetDir 被检查的预设目录（随包模板或隔离副本）。
 * @returns 结构化记录：负向复现、正向挂载、worker 组合与工具集差异。
 */
export async function probePresetEntry({ hostBase, presetDir } = {}) {
  const record = {
    kind: "verify.preset-entry",
    ok: false,
    dir: presetDir || "",
    toolFilter: [],
    migration: null,
    legacy: null,
    migrated: null,
    worker: null,
    composition: null,
    ownRows: [],
    coverage: null,
    toolsRow: null,
    error: "",
  };
  if (!presetDir || !fs.existsSync(path.join(presetDir, "agent.cordis.yml"))) {
    record.error = "预设目录里没有 agent.cordis.yml：" + (presetDir || "(空)");
    return record;
  }
  const host = await loadHostPackages(hostBase);
  const text = fs.readFileSync(path.join(presetDir, "agent.cordis.yml"), "utf8");
  record.toolFilter = findToolFilterKeys(text);
  const migration = migrateToolFilter(text);
  record.migration = { changed: migration.changed, skipped: migration.skipped, reason: migration.reason };
  if (migration.skipped) {
    record.error = "预设里仍有未迁移的 toolFilter：" + migration.reason;
    return record;
  }
  const migratedRows = readCompositionRows(migration.text, presetDir);
  const legacyRows = withLegacyToolFilter(migratedRows);
  const definitionMeta = { id: path.basename(presetDir), ...readPresetMeta(presetDir) };

  record.composition = {
    problem: compositionProblem(host.entryListProblem, migratedRows),
    rows: migratedRows.length,
    declaration: declarationProblem(host.AgentPreset, { ...definitionMeta, plugins: migratedRows }),
  };

  const legacyRow = findRow(legacyRows, "tool-subagent");
  record.legacy = legacyRow
    ? await mountRow({ host, hostBase, row: legacyRow, agentPresetId: WORKER_PRESET_ID, presetDir })
    : { ok: false, error: "没找到 tool-subagent 行", tools: [] };
  // 负向必须复现宿主对废弃字段的拒绝，否则这条证据没有意义。
  record.legacy.rejected = /toolFilter is no longer supported/.test(record.legacy.error || "");

  const migratedRow = findRow(migratedRows, "tool-subagent");
  record.migrated = migratedRow
    ? await mountRow({ host, hostBase, row: migratedRow, agentPresetId: WORKER_PRESET_ID, presetDir })
    : { ok: false, error: "迁移后没有 tool-subagent 行", tools: [] };

  const derived = deriveWorkerRows(migratedRows);
  const workerRow = findRow(derived.rows, "tool-subagent");
  record.worker = {
    removed: derived.removed,
    problem: compositionProblem(host.entryListProblem, derived.rows),
    declaration: declarationProblem(host.AgentPreset, { ...definitionMeta, id: WORKER_PRESET_ID, plugins: derived.rows }),
    rows: derived.rows.length,
    mount: workerRow
      ? await mountRow({ host, hostBase, row: workerRow, agentPresetId: WORKER_PRESET_ID, presetDir })
      : { ok: false, error: "worker 组合里没有 tool-subagent 行", tools: [] },
    // 子级组合与父级组合的差异只应是那三行。
    differsFromParent: JSON.stringify(derived.rows) !== JSON.stringify(migratedRows),
    agentPreset: workerRow && workerRow.config ? workerRow.config.agentPreset || "" : "",
  };
  record.worker.ok = Boolean(record.worker.mount && record.worker.mount.ok && record.worker.problem === "");
  record.worker.error = record.worker.mount ? record.worker.mount.error || "" : "";

  // 自研行必须真挂：工具行由宿主自己的 defineTool 编译，A8 那类
  // 「object 参数没 seal → 整份预设 broken」只有走这条路径才能在构建期撞到。
  const own = ownRowIds(migratedRows, presetDir);
  for (const item of own) {
    const row = findRow(migratedRows, item.id);
    const mounted = row
      ? await mountRow({ host, hostBase, row, agentPresetId: WORKER_PRESET_ID, presetDir })
      : { ok: false, error: "没找到自研行：" + item.id, tools: [] };
    record.ownRows.push({ id: item.id, name: item.name, ok: mounted.ok, error: mounted.error, tools: mounted.tools });
  }
  const mountedIds = record.migrated.ok ? ["tool-subagent"] : [];
  for (const row of record.ownRows) if (row.ok) mountedIds.push(row.id);
  record.coverage = {
    rows: migratedRows.length,
    mounted: mountedIds,
    own: own.map((item) => item.id),
    unmountedOwn: record.ownRows.filter((row) => !row.ok).map((row) => row.id),
  };
  record.toolsRow = record.ownRows.find((row) => row.name === "dsh-purge/redteam/tools") || null;

  record.ok = presetEntryOk(record);
  return record;
}

/** 迁移幂等核对：同一份文本连续迁移两次，第二次不得改动。 */
export function migrationIdempotent(text) {
  const first = migrateToolFilter(text);
  const second = migrateToolFilter(first.text);
  return {
    firstChanged: first.changed,
    secondChanged: second.changed,
    skipped: first.skipped || second.skipped,
    stable: second.text === first.text,
    text: second.text,
  };
}

export function summarizePresetEntry(record) {
  if (!record) return null;
  return {
    ok: record.ok,
    dir: record.dir,
    toolFilter: record.toolFilter,
    legacy: record.legacy ? { rejected: record.legacy.rejected, error: record.legacy.error } : null,
    migrated: record.migrated ? { ok: record.migrated.ok, error: record.migrated.error } : null,
    worker: record.worker
      ? { removed: record.worker.removed, ok: record.worker.mount ? record.worker.mount.ok : false, error: record.worker.mount ? record.worker.mount.error : "", agentPreset: record.worker.agentPreset }
      : null,
    composition: record.composition,
    error: record.error || "",
  };
}
/**
 * 把一份已安装预设复制到隔离工作区并执行插件启动时同样的迁移。
 *
 * 真实 DSH_HOME 只读：迁移只发生在副本上，用来证明“已安装旧副本”能被就地修好、
 * 用户其余内容一个字节不动、重复执行不再改动。
 *
 * @param options.from 已安装预设目录（只读）。
 * @param options.to 隔离副本目录（必须可写，位于 D 盘工作区）。
 * @returns 迁移前后的文本差异摘要与第二次迁移是否稳定。
 */
export function migratePresetCopy({ from, to } = {}) {
  const out = { from: from || "", to: to || "", files: [], changed: false, idempotent: false, skipped: false, reason: "", addedLines: [], removedLines: [] };
  if (!from || !fs.existsSync(from)) {
    out.reason = "没有已安装的预设副本";
    return out;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    out.files.push(entry.name);
  }
  const file = path.join(to, "agent.cordis.yml");
  if (!fs.existsSync(file)) {
    out.reason = "副本里没有 agent.cordis.yml";
    return out;
  }
  const before = fs.readFileSync(file, "utf8");
  const first = migrateToolFilter(before);
  const second = migrateToolFilter(first.text);
  out.changed = first.changed;
  out.skipped = first.skipped;
  out.reason = first.reason || "";
  out.idempotent = second.changed === false && second.text === first.text;
  const beforeLines = before.split(/\r?\n/);
  const afterLines = first.text.split(/\r?\n/);
  const remaining = [...afterLines];
  for (const line of beforeLines) {
    const at = remaining.indexOf(line);
    if (at >= 0) remaining.splice(at, 1);
    else out.removedLines.push(line);
  }
  out.addedLines = remaining;
  if (first.changed) fs.writeFileSync(file, first.text, "utf8");
  return out;
}
