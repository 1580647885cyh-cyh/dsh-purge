import path from "node:path";
import { planWorkspace, ensureWorkspace, isolatedEnvironment, applyProcessEnvironment, stampNow } from "./isolate.js";
import { DEFAULT_BASELINE_DIR, hostFingerprint, pluginFingerprint, readJson, sealBaseline, verifyBaseline } from "./baseline.js";
import { auditPresets, captureRequestPreparation, createHostContext, probeToolBridge, resolveHostInstall } from "./host-entry.js";
import { prepareFixtureHost, runAdminCase } from "./admin-entry.js";
import { buildReport, writeReport } from "./report.js";

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
  logger = () => {},
} = {}) {
  const pluginRoot = path.resolve(root);
  const workspace = ensureWorkspace(planWorkspace({ root: outRoot, stamp }));
  const realDshHome = process.env.DSH_HOME || "";
  const presetRoot = realDshHome ? path.join(realDshHome, ".agent-presets") : "";
  const commands = ["node scripts/verify.mjs --stamp " + stamp];

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
  const fixture = prepareFixtureHost({
    hostBase: hostInstall.hostBase,
    installDir: workspace.install,
    shellVersion: hostInfo.shellVersion || "0.2.1-rc.5",
    asarPath: path.join(hostInstall.resourcesDir, "app.asar"),
  });
  logger("fixture", fixture.source + " / " + fixture.copied.join(","));

  // 3. 切到隔离环境，用真实宿主包加载插件；任何管理操作前都先做宿主预检。
  const isolated = isolatedEnvironment(workspace, { installDir: workspace.install, hostBase: workspace.hostBase });
  const restore = applyProcessEnvironment(isolated);
  let bundle = null;
  let hostEntry = null;
  let admin = null;
  try {
    bundle = await createHostContext({ hostBase: hostInstall.hostBase, pluginRoot });
    const request = await captureRequestPreparation({
      ctx: bundle.ctx,
      host: bundle.host,
      hostInfo,
      workspace,
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
    admin = await runAdminCase({ ctx: bundle.ctx, pluginRoot, workspace, liveHostBase: hostInstall.hostBase });
    logger("admin", admin.ok ? "ok" : "failed");
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    hostEntry = hostEntry || { ok: false, error: message, tools: [], toolErrors: [], sections: [], variables: [] };
    admin = admin || { ok: false, error: message, steps: [], knownFailures: [] };
    logger("error", message);
  } finally {
    if (bundle) bundle.dispose();
    restore();
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
    admin,
    commands,
  });
  const files = writeReport(workspace, report);
  return { report, files, workspace, hostInstall, sealed, drift };
}