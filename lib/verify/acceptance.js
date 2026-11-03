import fs from "node:fs";
import path from "node:path";
import { assertDriveDPath } from "./isolate.js";
import { describeHostAdaptation, hostAdaptation, hostTargets } from "../host-version.js";

/**
 * 验收与兼容修订记录（#8）。
 *
 * 把一次隔离验证的报告收敛成一份可复核的记录：宿主指纹、插件版本与本地锁、
 * 各入口的实际结果、不适用项、未执行的检查，以及独立恢复材料（保护基线快照）。
 * 只收结构性事实，不收提示词正文、凭据或会话内容。
 */

/** 入口清单：每项给出「报告里的哪个字段算通过」和未通过时的说明来源。 */
export const ACCEPTANCE_ENTRIES = [
  { id: "host-entry", label: "宿主加载（cordis 真实加载 + 工具注册）", passed: (report) => report.hostEntry && report.hostEntry.ok },
  { id: "template", label: "提示词模板渲染契约", passed: (report) => report.hostEntry && report.hostEntry.templateContract && report.hostEntry.templateContract.ok },
  { id: "prompt-preset", label: "完整提示词预设运行", passed: (report) => report.hostEntry && report.hostEntry.promptPreset && report.hostEntry.promptPreset.ok },
  { id: "tool-bridge", label: "宿主依赖解析（工具桥接）", passed: (report) => report.hostEntry && report.hostEntry.toolBridge && report.hostEntry.toolBridge.ok },
  { id: "preset-entry", label: "预设注册与组合（含迁移）", passed: (report) => report.presetEntry && report.presetEntry.ok },
  { id: "model-call", label: "受控模型端点 → 无害工具调用", passed: (report) => report.modelToolCall && report.modelToolCall.ok },
  { id: "model-reject", label: "工具集外调用被拒绝", passed: (report) => report.modelToolCallRejected && report.modelToolCallRejected.executed && report.modelToolCallRejected.executed.isError === true },
  { id: "admin", label: "管理生命周期（应用/重复应用/恢复）", passed: (report) => report.admin && report.admin.ok },
  { id: "backup-faults", label: "备份/恢复故障注入", passed: (report) => report.admin && report.admin.backupFaults && report.admin.backupFaults.ok },
  { id: "targets", label: "目标定位与适配状态", passed: (report) => report.targets && report.targets.ok },
];

/**
 * 兼容修订目录：每项改动的故障、修复与回归证据（对应规格 #1 的子任务）。
 * 只在记录里引用结构性事实与文档锚点，不复制提示词正文。
 */
const REVISIONS = [
  { id: "R1", issue: "#3", fault: "桌面布局下解析不到 @deepseek-ai/dsh-tools；备份占位 fd 未关闭导致 rename EPERM", fix: "宿主依赖锚点候选 + 包根身份核对；hostFs 补齐 fd 方法", evidence: "docs/verification/README.md「本票验收对应（#3）」" },
  { id: "R2", issue: "#4", fault: "宿主 0.2.1-rc.5 拒绝 toolFilter，预设行挂不上", fix: "toolFilter → agentPreset + redteam-worker 组合裁剪（保留原 deny 语义）", evidence: "docs/verification/README.md「本票验收对应（#4）」" },
  { id: "R3", issue: "#5", fault: "宿主只注册 provider/model，{{cwd}} 让整份提示词渲染失败", fix: "apply 时用 SystemPrompt.variable 补 cwd（缺失给空串）", evidence: "docs/verification/README.md「回归记录（#5）」" },
  { id: "R4", issue: "#6", fault: "rc.5 的等价分支/编译形式识别不到（#40/#84）；通用标记把官方文案当成功（#24）", fix: "补等价形式匹配 + settledWhen/patchEffectState/patchOwnMarkPresent；新增目标定位与适配状态入口", evidence: "docs/verification/README.md「回归记录（#6）」" },
  { id: "R5", issue: "#7", fault: "过期 bak 未刷新（目标态/官方标记误判）导致旧宿主内容写回；0 字节 bak 清空目标", fix: "looksPatchedAlready 改用自证标记 + provenance；revert 前刷新过期 bak、拒绝空备份", evidence: "docs/verification/README.md「回归记录（#7）」" },
];

/** 这份记录明确没有执行的检查：不能因为「没报错」就当成通过。 */
export const NOT_EXECUTED = [
  "真实 Electron 桌面进程内的插件加载（验证用宿主包以模块方式只读加载）",
  "真实模型网络请求（受控端点只在本机回环，不写真实凭据）",
  "Web / macOS / Linux 以及其他 DSH 版本",
];

function entryRows(report) {
  return ACCEPTANCE_ENTRIES.map((entry) => {
    let ok = false;
    let error = "";
    try {
      ok = Boolean(entry.passed(report));
    } catch (evaluateError) {
      error = String(evaluateError && evaluateError.message ? evaluateError.message : evaluateError);
    }
    return { id: entry.id, label: entry.label, ok, error };
  });
}

/** 从报告里收集「已确认不适用」的项（逐条带搜索位置或落点）。 */
function notApplicableRows(report) {
  const rows = [];
  const targets = report.targets || {};
  for (const item of (targets.isolated && targets.isolated.notApplicable) || []) {
    rows.push({
      id: "#" + item.id,
      label: item.name,
      optional: item.optional,
      evidence: (item.keys || []).flatMap((entry) => entry.searched || []).slice(0, 3),
    });
  }
  for (const item of (targets.isolated && targets.isolated.unresolvedKeys) || []) {
    rows.push({ id: item.key, label: "未定位键", optional: true, evidence: (item.searched || []).slice(0, 3) });
  }
  return rows;
}

/**
 * 汇成记录对象。
 * @param report 验证报告（writeReport 的 JSON 形状）
 * @param lock   { assertError, status }（本地锁的实际行为）
 * @param plugin { version, localVersionLock, dshTarget }
 * @param host   { shellVersion, runtimeVersion, buildCommit, asar: { size, mtime } }
 * @param baseline { file, treeHash, fileCount }
 */
export function collectAcceptance({ report, lock = {}, plugin = {}, host = {}, baseline = {}, commands = [], environment = {}, dependencies = null } = {}) {
  const entries = entryRows(report || {});
  const failed = entries.filter((entry) => !entry.ok);
  const lockOk = Boolean(lock.assertError === "ERR_DSH_PURGE_LOCAL_VERSION_LOCK" && lock.status && lock.status.locked === true && lock.status.pinned === true);
  const versionOk = plugin.version === "1.1.71" && plugin.localVersionLock && plugin.localVersionLock.remoteUpdates === false && plugin.localVersionLock.editable === true;
  // A1：宿主适配状态是记录，不是通过条件 —— 未适配不会让兼容记录判失败，但会写在记录里。
  const targets = hostTargets(plugin);
  const adaptation = hostAdaptation(host.shellVersion || "", targets);
  return {
    kind: "dsh-purge-acceptance",
    generatedAt: new Date().toISOString(),
    ok: Boolean(report && report.ok === true && failed.length === 0 && lockOk && versionOk),
    plugin: {
      version: plugin.version || "",
      localVersionLock: plugin.localVersionLock || null,
      dshTarget: plugin.dshTarget || "",
      dshTargets: targets,
      versionOk,
      dependencies,
      editable: lock.writable === true,
    },
    revisions: REVISIONS,
    host: { ...host, adaptation },
    baseline,
    lock: {
      ok: lockOk,
      error: lock.assertError || "",
      status: lock.status ? { locked: lock.status.locked, pinned: lock.status.pinned, channel: lock.status.channel, updateTarget: lock.status.updateTarget } : null,
    },
    entries,
    unmatched: ((report && report.targets && report.targets.isolated && report.targets.isolated.unmatched) || []).map((item) => ({
      id: "#" + item.id,
      label: item.name,
      keys: item.keys || [],
      optional: item.optional,
    })),
    notApplicable: notApplicableRows(report || {}),
    notExecuted: NOT_EXECUTED,
    commands,
    environment,
    report: report ? { ok: report.ok, knownFailures: (report.knownFailures || []).map((item) => item.id) } : null,
  };
}

function cell(value) {
  return String(value == null ? "" : value).replace(/\|/g, "\\|");
}

export function renderAcceptanceMarkdown(record) {
  const lines = [];
  lines.push("# 兼容修订记录（Windows 官方桌面 DSH " + (record.host.shellVersion || "unknown") + "）");
  lines.push("");
  lines.push("- 生成时间：" + record.generatedAt);
  lines.push("- 结论：" + (record.ok ? "通过（范围见「未执行的检查」）" : "未通过"));
  lines.push("- 插件版本：" + record.plugin.version + "（本地锁 " + JSON.stringify(record.plugin.localVersionLock) + "）");
  lines.push("- 宿主：shell " + record.host.shellVersion + " / runtime " + record.host.runtimeVersion + " / build " + (record.host.buildCommit || "").slice(0, 12));
  if (record.host.adaptation) lines.push("- 宿主适配：" + describeHostAdaptation(record.host.adaptation));
  if (record.host.asar) {
    const asar = record.host.asar;
    const when = asar.mtime || (asar.mtimeMs ? new Date(asar.mtimeMs).toISOString() : "");
    lines.push("- app.asar：" + asar.size + " 字节" + (when ? " / mtime " + when : ""));
  }
  lines.push("- 本地锁实际行为：" + (record.lock.ok ? "远程更新/切换/回滚被拒绝（" + record.lock.error + "），状态 pinned" : "未按预期拒绝：" + record.lock.error));
  lines.push("- 本地依赖来源：" + (record.plugin.dependencies && Object.keys(record.plugin.dependencies).length === 0 ? "无远程依赖（dependencies 为空，保持本地可编辑）" : JSON.stringify(record.plugin.dependencies)));
  lines.push("- 手动编辑：" + (record.plugin.editable ? "插件源码可写（editable:true 且文件可写）" : "文件不可写"));
  lines.push("");
  lines.push("## 验收入口");
  lines.push("");
  lines.push("| 入口 | 结果 |");
  lines.push("| --- | --- |");
  for (const entry of record.entries) lines.push("| " + cell(entry.label) + " | " + (entry.ok ? "通过" : "失败" + (entry.error ? "：" + cell(entry.error) : "")) + " |");
  lines.push("");
  lines.push("## 兼容修订");
  lines.push("");
  lines.push("| 修订 | 任务 | 故障 | 修复 | 回归证据 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const item of record.revisions) lines.push("| " + item.id + " | " + item.issue + " | " + cell(item.fault) + " | " + cell(item.fix) + " | " + cell(item.evidence) + " |");
  lines.push("");
  lines.push("## 补丁对不上但不是失败（逐条带落点）");
  lines.push("");
  if (record.unmatched.length === 0) lines.push("- 无");
  else for (const item of record.unmatched) lines.push("- " + item.id + "（" + (item.optional ? "可选" : "非可选") + "）" + item.label + " · 落点 " + item.keys.join(", ") + "：当前宿主里没有可改的原文（可选补丁或布局差异，见目标定位段）");
  lines.push("");
  lines.push("## 已确认不适用");
  lines.push("");
  if (record.notApplicable.length === 0) lines.push("- 无");
  else for (const item of record.notApplicable) lines.push("- " + item.id + "（" + (item.optional ? "可选" : "非可选") + "）" + item.label + (item.evidence.length ? " · 搜索过 " + item.evidence.join(" ; ") : ""));
  lines.push("");
  lines.push("## 未执行的检查（不标记为通过）");
  lines.push("");
  for (const item of record.notExecuted) lines.push("- " + item);
  lines.push("");
  lines.push("## 独立恢复材料");
  lines.push("");
  lines.push("- 保护基线快照：" + record.baseline.file);
  lines.push("- treeHash：" + record.baseline.treeHash + "（" + record.baseline.fileCount + " 个文件）");
  lines.push("- 校验：`npm run verify -- --no-seal` 会用快照逐文件比对当前源码；快照只在本机 D 盘，不进仓库。");
  lines.push("");
  lines.push("## 执行记录");
  lines.push("");
  for (const command of record.commands) lines.push("- " + command);
  if (record.environment && Object.keys(record.environment).length > 0) {
    lines.push("- 环境：" + Object.entries(record.environment).map(([key, value]) => key + "=" + value).join(" / "));
  }
  if (record.report) {
    lines.push("");
    lines.push("## 报告摘要");
    lines.push("");
    lines.push("- 结论：" + (record.report.ok ? "通过" : "未通过"));
    lines.push("- 已知故障：" + (record.report.knownFailures.length ? record.report.knownFailures.join(", ") : "无"));
  }
  lines.push("");
  return lines.join("\n");
}

export function writeAcceptance({ outDir, record }) {
  // 与验证入口同一条边界：记录也是验证产物，只落 D 盘。
  assertDriveDPath(outDir, "验收记录目录");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = record.generatedAt.replace(/[:.]/g, "-");
  const md = path.join(outDir, "compat-" + stamp + ".md");
  const json = path.join(outDir, "compat-" + stamp + ".json");
  fs.writeFileSync(md, renderAcceptanceMarkdown(record) + "\n", "utf8");
  fs.writeFileSync(json, JSON.stringify(record, null, 2) + "\n", "utf8");
  return { md, json };
}
