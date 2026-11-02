import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCompositionRows } from "../redteam/preset-composition.js";
import { deriveWorkerRows, findToolFilterKeys, migrateToolFilter, WORKER_PRESET_ID } from "../redteam/preset-migration.js";

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
  "tool-subagent": { pkg: "dsh-tool-subagent", entry: "lib/index.js" },
};

function moduleUrl(hostBase, rel) {
  return pathToFileURL(path.join(hostBase, rel)).href;
}

/** 读宿主包；与 host-entry 一样按桌面布局的 @deepseek-ai 根解析。 */
async function loadHostPackages(hostBase) {
  const cordis = await import(moduleUrl(hostBase, "cordis/lib/index.js"));
  const systemPrompt = await import(moduleUrl(hostBase, "dsh-system-prompt/lib/index.js"));
  const tools = await import(moduleUrl(hostBase, "dsh-tools/lib/index.js"));
  const registry = await import(moduleUrl(hostBase, "dsh-agent-preset-registry/lib/index.js"));
  const scope = await import(moduleUrl(hostBase, "dsh-scope/lib/index.js"));
  return {
    Context: cordis.Context,
    SystemPrompt: systemPrompt.default,
    ToolRuntime: tools.default,
    entryListProblem: registry.entryListProblem,
    createScope: scope.createScope,
  };
}

/** 组合校验：宿主 registry 在挂载前对行列表做的同一检查。 */
export function compositionProblem(entryListProblem, rows) {
  return entryListProblem(rows) || "";
}

/**
 * 按真实行 config 挂载一个插件行。
 * 服务用最小替身：本入口只关心这一行自己的配置契约与它注册进 tools 的东西，
 * 替身不参与断言；tool-subagent 需要的 agentPresets/subagents/sessionProjections
 * 与真实宿主同名同形。
 */
async function mountRow({ host, hostBase, row, presetDir, agentPresetId }) {
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
  const target = ROW_MODULES[row.id];
  if (!target) return { ok: false, error: "入口未登记该行：" + row.id, tools: [] };
  let module;
  try {
    module = await import(moduleUrl(hostBase, target.pkg + "/" + target.entry));
  } catch (error) {
    return { ok: false, error: "导入失败：" + String(error && error.message ? error.message : error), tools: [] };
  }
  const plugin = typeof module.default === "function" || (module.default && module.default.apply)
    ? module.default
    : { name: module.name, inject: module.inject, apply: module.apply, Config: module.Config };
  const config = row.config === undefined || row.config === null ? {} : row.config;
  // 真实挂载发生在预设 scope 里（registry.mountPreset 的 createScope）；行在常驻组合下
  // 按 Agent 安装工具，需要 scope 才能走那条分支。
  const scope = host.createScope(ctx, {});
  const scoped = scope.ctx || ctx;
  try {
    const fiber = scoped.plugin(plugin, config);
    await fiber.await();
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error), tools: ctx.tools.schemas().map((tool) => tool.name) };
  }
  return { ok: true, error: "", tools: ctx.tools.schemas().map((tool) => tool.name) };
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
export function withLegacyToolFilter(rows, deny = ["subagent_fork", "workflow", "ralph"]) {
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

  record.composition = {
    problem: compositionProblem(host.entryListProblem, migratedRows),
    rows: migratedRows.length,
  };

  const legacyRow = findRow(legacyRows, "tool-subagent");
  record.legacy = legacyRow
    ? await mountRow({ host, hostBase, row: legacyRow, presetDir, agentPresetId: WORKER_PRESET_ID })
    : { ok: false, error: "没找到 tool-subagent 行", tools: [] };
  // 负向必须复现宿主对废弃字段的拒绝，否则这条证据没有意义。
  record.legacy.rejected = /toolFilter is no longer supported/.test(record.legacy.error || "");

  const migratedRow = findRow(migratedRows, "tool-subagent");
  record.migrated = migratedRow
    ? await mountRow({ host, hostBase, row: migratedRow, presetDir, agentPresetId: WORKER_PRESET_ID })
    : { ok: false, error: "迁移后没有 tool-subagent 行", tools: [] };

  const derived = deriveWorkerRows(migratedRows);
  const workerRow = findRow(derived.rows, "tool-subagent");
  record.worker = {
    removed: derived.removed,
    problem: compositionProblem(host.entryListProblem, derived.rows),
    rows: derived.rows.length,
    mount: workerRow
      ? await mountRow({ host, hostBase, row: workerRow, presetDir, agentPresetId: WORKER_PRESET_ID })
      : { ok: false, error: "worker 组合里没有 tool-subagent 行", tools: [] },
    // 子级组合与父级组合的差异只应是那三行。
    sameAsParent: JSON.stringify(derived.rows) !== JSON.stringify(migratedRows),
    agentPreset: workerRow && workerRow.config ? workerRow.config.agentPreset || "" : "",
  };
  record.worker.ok = Boolean(record.worker.mount && record.worker.mount.ok && record.worker.problem === "");
  record.worker.error = record.worker.mount ? record.worker.mount.error || "" : "";

  record.ok = Boolean(
    record.composition.problem === ""
    && record.legacy.rejected
    && record.migrated.ok
    && record.worker.mount.ok
    && record.worker.problem === ""
    && record.worker.removed.length === 3
    && record.worker.agentPreset === WORKER_PRESET_ID
    && record.toolFilter.length === 0
    && migration.changed === false,
  );
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
