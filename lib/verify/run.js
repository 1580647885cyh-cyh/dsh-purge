import fs from "node:fs";
import path from "node:path";
import { planWorkspace, ensureWorkspace, isolatedEnvironment, applyProcessEnvironment, stampNow } from "./isolate.js";
import { DEFAULT_BASELINE_DIR, hostFingerprint, pluginFingerprint, readJson, sealBaseline, verifyBaseline } from "./baseline.js";
import { WORKING_DIRECTORY_PREFIX, attachPromptRequest, auditPresets, captureRequestPreparation, createHostContext, probeToolBridge, resolveHostInstall } from "./host-entry.js";
import { migratePresetCopy, probePresetEntry } from "./preset-entry.js";
import { runToolCallRound, stopModelEndpoints } from "./model-endpoint.js";
import { prepareFixtureHost, runAdminCase } from "./admin-entry.js";
import { fixtureCacheRoot } from "./fixture-cache.js";
import { DEFAULT_RETENTION_KEEP, pruneWorkspaces } from "./retention.js";
import { runTargetCase } from "./target-entry.js";
import { buildReport, describeRetention, writeReport } from "./report.js";

/**
 * 工作区清理：--no-prune 记成「已关闭」，清理本身失败也只记原因——这两件事都不能让验证失败（#13）。
 */
function resolveRetention({ prune, keep, workspace }) {
  const window = Number.isFinite(keep) ? keep : DEFAULT_RETENTION_KEEP;
  const empty = { root: workspace.base, keep: window, kept: [], removed: [], freedBytes: 0, skipped: [] };
  if (!prune) return { ...empty, enabled: false };
  try {
    return { ...empty, ...pruneWorkspaces({ root: workspace.base, keep: window, protect: [workspace.root] }), enabled: true };
  } catch (error) {
    return { ...empty, enabled: true, error: String(error && error.message ? error.message : error) };
  }
}

/**
 * 完整验证流程：封存/比对保护基线 → 隔离宿主加载与请求准备 → 隔离副本管理生命周期。
 * 所有写入都在 D 盘工作区；真实安装只读，真实 DSH_HOME 只读（预设审计）。
 */
export async function runVerification({
  root,
  outRoot,
  baselineDir = DEFAULT_BASELINE_DIR,
  installDir,
  stamp = stampNow(),
  seal = true,
  prune = true,
  retentionKeep = DEFAULT_RETENTION_KEEP,
  logger = () => {},
} = {}) {
  const pluginRoot = path.resolve(root);
  const workspace = ensureWorkspace(planWorkspace({ root: outRoot, stamp }));
  // 工作区只增不减会吃掉磁盘（#13）：建好本轮工作区之后清掉旧的那批，本轮永不清、在跑的不清。
  const retention = resolveRetention({ prune, keep: retentionKeep, workspace });
  logger("retention", describeRetention(retention));
  const realDshHome = process.env.DSH_HOME || "";
  const presetRoot = realDshHome ? path.join(realDshHome, ".agent-presets") : "";
  const commands = ["node scripts/verify.mjs --stamp " + stamp];
  // 预设入口：真实 DSH_HOME 只读，迁移只在隔离副本上执行。
  const installedPresetDir = realDshHome ? path.join(realDshHome, ".agent-presets", "redteam") : "";
  const bundledPresetDir = path.join(pluginRoot, "presets", "redteam");

  const hostInstall = resolveHostInstall({ installDir });
  const hostInfo = hostFingerprint(hostInstall.installDir);
  const pluginInfo = pluginFingerprint(pluginRoot);
  logger("host", hostInfo.shellVersion + " / runtime " + hostInfo.runtimeVersion);

  // 1. 保护基线：先与上一次快照比对（漂移证据），再封存本次快照。真实环境执行，git 可用。
  const previous = baselineDir ? readJson(path.join(baselineDir, "latest.json"), null) : null;
  const drift = previous ? verifyBaseline({ root: pluginRoot, baseline: previous }) : null;
  const sealed = seal && baselineDir
    ? sealBaseline({ root: pluginRoot, outDir: baselineDir, installDir: hostInstall.installDir, stamp })
    : null;
  const sealCheck = sealed ? verifyBaseline({ root: pluginRoot, baseline: sealed.baseline }) : null;
  logger("baseline", sealed ? sealed.file : "未封存");

  // 2. 隔离副本：只复制定位宿主与代表性补丁需要的包。
  //    #11：副本按 asar 身份缓存到验证根目录旁边，命中时整棵复制，不再逐包重解归档。
  const fixture = prepareFixtureHost({
    hostBase: hostInstall.hostBase,
    installDir: workspace.install,
    shellVersion: hostInfo.shellVersion || "0.2.1-rc.5",
    asarPath: path.join(hostInstall.resourcesDir, "app.asar"),
    cacheRoot: fixtureCacheRoot(path.dirname(workspace.root)),
  });
  logger("fixture", fixture.source
    + (fixture.cache ? " / 缓存 " + (fixture.cache.hit ? "命中 " : "重建 ") + fixture.cache.key : " / 未用缓存")
    + " / " + fixture.durationMs + " ms / " + fixture.copied.join(","));

  // 3. 切到隔离环境，用真实宿主包加载插件；任何管理操作前都先做宿主预检。
  const isolated = isolatedEnvironment(workspace, { installDir: workspace.install, hostBase: workspace.hostBase });
  const restore = applyProcessEnvironment(isolated);
  let bundle = null;
  let hostEntry = null;
  let admin = null;
  let targets = null;
  let modelToolCall = null;
  let modelToolCallRejected = null;
  try {
    bundle = await createHostContext({ hostBase: hostInstall.hostBase, pluginRoot, presetDir: bundledPresetDir });
    const request = await captureRequestPreparation({
      ctx: bundle.ctx,
      host: bundle.host,
      hostInfo,
      workspace,
      persona: bundle.persona,
    });
    const presetAudit = auditPresets(presetRoot);
    // 工具桥接：隔离桌面布局解析 + 只读加载真实宿主包（预设行 dsh-purge/redteam/tools 的前置条件）。
    const toolBridge = await probeToolBridge({ pluginRoot, hostInstall });
    hostEntry = {
      ...request,
      ok: Boolean(request.ok && !bundle.loadError && toolBridge.ok),
      loadError: bundle.loadError || "",
      toolBridge,
      presetAudit,
    };
    logger("host-entry", hostEntry.ok ? "ok" : "failed");
    // 受控模型端点：假 OpenAI 端点 → 真实适配器 → 模型产出的 tool_call → 真实工具执行路径。
    // 请求体用组装好的系统提示词与运行上下文快照，所以端点侧看到的就是真实准备结果（#5）。
    const markers = { hasWorkingDirectory: WORKING_DIRECTORY_PREFIX };
    if (hostEntry.promptPreset && hostEntry.promptPreset.injectHead) markers.hasInject = hostEntry.promptPreset.injectHead;
    modelToolCall = await runToolCallRound({
      hostBase: hostInstall.hostBase,
      ctx: bundle.ctx,
      call: { id: "verify-call-ok", name: "purge_status", arguments: {} },
      messages: request.requestMessages,
      markers,
    });
    hostEntry.promptPreset = attachPromptRequest(hostEntry.promptPreset, modelToolCall);
    // 反向案例：模型点名一个不存在的工具，宿主注册表必须拒绝，而不是静默执行。
    modelToolCallRejected = await runToolCallRound({
      hostBase: hostInstall.hostBase,
      ctx: bundle.ctx,
      call: { id: "verify-call-unknown", name: "purge_nonexistent", arguments: {} },
    });
    logger("model-endpoint", modelToolCall.ok ? "ok" : "failed");
    admin = await runAdminCase({ ctx: bundle.ctx, pluginRoot, workspace, liveHostBase: hostInstall.hostBase });
    logger("admin", admin.ok ? "ok" : "failed");
    // 入口五（#6）：目标定位 + 逐文件核对 + 运行结果证明。放在管理生命周期之后，
    // 让副本先由 revert 回到未打补丁状态，再看应用到底改了什么。
    targets = await runTargetCase({
      ctx: bundle.ctx,
      pluginRoot,
      workspace,
      liveHostBase: hostInstall.hostBase,
      resourcesDir: hostInstall.resourcesDir,
      realDshHome,
      asarPath: path.join(hostInstall.resourcesDir, "app.asar"),
    });
    logger("targets", targets.ok ? "ok" : "failed");
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    hostEntry = hostEntry || { ok: false, error: message, tools: [], toolErrors: [], sections: [], variables: [] };
    admin = admin || { ok: false, error: message, steps: [], knownFailures: [] };
    targets = targets || { ok: false, error: message, audit: null, runtime: {}, isolated: {} };
    logger("error", message);
  } finally {
    if (bundle) bundle.dispose();
    stopModelEndpoints();
    restore();
  }

  // 预设入口（#4）：已安装副本 → 隔离迁移 → 迁移后挂载；随包模板同样要成立。
  let presetMigration = null;
  let presetEntry = null;
  try {
    presetMigration = installedPresetDir && fs.existsSync(installedPresetDir)
      ? migratePresetCopy({ from: installedPresetDir, to: path.join(workspace.out, "preset-copy") })
      : null;
    const copyDir = path.join(workspace.out, "preset-copy");
    const primaryDir = presetMigration && presetMigration.files.length > 0 ? copyDir : bundledPresetDir;
    presetEntry = await probePresetEntry({ hostBase: hostInstall.hostBase, presetDir: primaryDir });
    const bundled = await probePresetEntry({ hostBase: hostInstall.hostBase, presetDir: bundledPresetDir });
    const installed = installedPresetDir && fs.existsSync(installedPresetDir)
      ? await probePresetEntry({ hostBase: hostInstall.hostBase, presetDir: installedPresetDir })
      : null;
    presetEntry.bundled = { ok: bundled.ok, dir: bundled.dir, toolFilter: bundled.toolFilter };
    presetEntry.installedLegacy = installed && installed.toolFilter.length > 0 ? installed.toolFilter : null;
    presetEntry.ok = Boolean(presetEntry.ok && bundled.ok);
    logger("preset-entry", presetEntry.ok ? "ok" : "failed");
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    presetEntry = { ok: false, dir: "", legacy: null, migrated: null, worker: null, composition: null, error: message };
    logger("preset-entry", "error: " + message);
  }

  const report = buildReport({
    workspace,
    baselineFile: sealed ? sealed.file : previous ? path.join(baselineDir, "latest.json") : "",
    seal: sealed,
    drift,
    sealCheck,
    hostInfo,
    pluginInfo,
    hostEntry,
    presetAudit: hostEntry ? hostEntry.presetAudit : null,
    presetEntry,
    presetMigration,
    modelToolCall,
    modelToolCallRejected,
    admin,
    targets,
    fixture,
    retention,
    commands,
  });
  const files = writeReport(workspace, report);
  return { report, files, workspace, hostInstall, sealed, drift };
}