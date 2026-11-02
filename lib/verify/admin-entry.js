import fs from "node:fs";
import nodeFs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertHostsIsolated, diffSnapshots, snapshotTree } from "./isolate.js";
import { asarHasHostPackages, extractAsarSubtree } from "./asar.js";

/**
 * 插件管理生命周期入口（补充入口）。
 *
 * 在 D 盘隔离宿主副本上，通过插件公开注册的 purge_status / purge_apply / purge_revert
 * 观察实际文件结果；任何操作前先确认插件枚举到的宿主都在隔离区内。
 */

/** 隔离副本只保留定位宿主与代表性补丁需要的包，不复制整个桌面安装。 */
export const FIXTURE_PACKAGES = ["dsh-agent-instructions", "dsh-system-prompt", "dsh-tools"];

export function prepareFixtureHost({ hostBase, installDir, shellVersion = "0.2.1-rc.5", asarPath } = {}) {
  const fixtureBase = path.join(installDir, "resources", "app", "dsh", "node_modules", "@deepseek-ai");
  const appDir = path.join(installDir, "resources", "app");
  fs.mkdirSync(appDir, { recursive: true });
  const copied = [];
  const fromAsar = Boolean(asarPath && fs.existsSync(asarPath) && asarHasHostPackages(asarPath));
  for (const pkg of FIXTURE_PACKAGES) {
    const target = path.join(fixtureBase, pkg);
    if (fromAsar) {
      try {
        extractAsarSubtree(asarPath, "dsh/node_modules/@deepseek-ai/" + pkg, target);
        copied.push(pkg);
        continue;
      } catch { /* 回退到安装目录 */ }
    }
    const source = path.join(hostBase, pkg);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, target, { recursive: true });
    copied.push(pkg);
  }
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: shellVersion, private: true }, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(appDir, "dsh", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-desktop-runtime", version: shellVersion, private: true }, null, 2) + "\n",
    "utf8",
  );
  return { fixtureBase, appDir, copied, source: fromAsar ? "asar" : "install" };
}

function toolText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value.text || "");
}

function parseCounts(text) {
  const applied = /applied=(\d+)/.exec(text);
  const already = /already=(\d+)/.exec(text);
  const reverted = /reverted=(\d+)/.exec(text);
  return {
    applied: applied ? Number(applied[1]) : null,
    already: already ? Number(already[1]) : null,
    reverted: reverted ? Number(reverted[1]) : null,
  };
}

/** 调用插件在 ToolRuntime 注册的公开定义；不经过 agent loop 的 pre-execute 瀑布。 */
export async function callTool(ctx, name, args = {}) {
  const definition = ctx.tools.get(name);
  if (!definition) throw new Error("插件未注册工具：" + name);
  const value = await definition.execute(args, {
    name,
    callId: "verify-" + name,
    arguments: args,
    signal: new AbortController().signal,
  });
  return value;
}

function flattenTargets(files) {
  const out = [];
  for (const value of Object.values(files || {})) {
    if (Array.isArray(value)) out.push(...value);
    else if (value) out.push(value);
  }
  return [...new Set(out.filter((item) => item && typeof item === "string"))];
}

/** 真实安装的只读守护：记录目标文件 stat，操作结束后确认没有任何一个被写过。 */
export async function beginLiveHostGuard(pluginRoot, liveHostBase, dshHome) {
  if (!liveHostBase) return null;
  const core = await import(pathToFileURL(path.join(pluginRoot, "lib", "core.js")).href);
  const paths = flattenTargets(core.targetFiles(liveHostBase, dshHome || process.env.DSH_HOME));
  const before = new Map();
  for (const file of paths) {
    try {
      const stat = nodeFs.statSync(file);
      before.set(file, { mtimeMs: Math.round(stat.mtimeMs), size: stat.size });
    } catch { /* 不存在就不守护 */ }
  }
  return { base: liveHostBase, core, before };
}

export async function checkLiveHostGuard(guard) {
  if (!guard) return { ok: true, checked: 0, changed: [] };
  const changed = [];
  for (const [file, prev] of guard.before) {
    let stat = null;
    try { stat = nodeFs.statSync(file); } catch { stat = null; }
    const now = stat ? { mtimeMs: Math.round(stat.mtimeMs), size: stat.size } : null;
    if (!now || now.mtimeMs !== prev.mtimeMs || now.size !== prev.size) changed.push(file);
  }
  try {
    const current = flattenTargets(guard.core.targetFiles(guard.base, process.env.DSH_HOME));
    for (const file of current) {
      if (!guard.before.has(file) && nodeFs.existsSync(file)) changed.push(file);
    }
  } catch { /* 枚举失败时保留已有证据 */ }
  return { ok: changed.length === 0, checked: guard.before.size, changed };
}

/** 公开枚举：插件实际会写入哪些宿主。预检失败即中止。 */
export async function enumerateHosts(pluginRoot, workspace) {
  const core = await import(pathToFileURL(path.join(pluginRoot, "lib", "core.js")).href);
  const hosts = core.enumeratePatchAiBases({ discover: true });
  assertHostsIsolated(hosts, workspace);
  return { core, hosts };
}

/**
 * hostFs 文件描述符代理探针：备份占位符由 openSync 创建，closeSync 缺失时会泄漏 fd，
 * 随后的 rename 在 Windows 上返回 EPERM，最终没有 .dshpurge.bak、revert 无法回滚。
 */
export async function backupFdProbe(hostFs, workspace) {
  const dir = path.join(workspace.out, "fd-probe");
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, "source.txt");
  const bak = path.join(dir, "source.txt.dshpurge.bak");
  const tmp = bak + ".copytmp";
  nodeFs.writeFileSync(src, "verify-fd-probe\n", "utf8");
  try { nodeFs.rmSync(bak, { force: true }); } catch { /* ignore */ }
  try { nodeFs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  const methods = ["openSync", "closeSync", "readSync", "fstatSync", "fsyncSync"];
  const present = methods.filter((name) => typeof hostFs[name] === "function");
  const missing = methods.filter((name) => typeof hostFs[name] !== "function");
  const result = { present, missing, fdLeaked: false, closeError: "", renameError: "", placeholderCreated: false };
  let fd = null;
  try {
    fd = hostFs.openSync(bak, "wx");
    result.placeholderCreated = true;
  } catch (error) {
    result.renameError = "openSync 失败：" + String(error && error.message ? error.message : error);
    return result;
  }
  try {
    hostFs.closeSync(fd);
  } catch (error) {
    // 复刻插件 backupAll：closeSync 缺失时占位 fd 仍打开，rename 在 Windows 上返回 EPERM。
    result.fdLeaked = true;
    result.closeError = String(error && error.message ? error.message : error);
  }
  try {
    await hostFs.promises.copyFile(src, tmp);
    await hostFs.promises.rename(tmp, bak);
    if (result.fdLeaked) result.renameError = result.renameError || "";
  } catch (error) {
    result.renameError = String(error && error.code ? error.code + ": " : "") + String(error && error.message ? error.message : error);
  } finally {
    try { nodeFs.closeSync(fd); } catch { /* 已关闭 */ }
    try { nodeFs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    try { nodeFs.rmSync(bak, { force: true }); } catch { /* ignore */ }
  }
  return result;
}

function summarizeDiff(diff) {
  return { added: diff.added.length, removed: diff.removed.length, changed: diff.changed.length, addedFiles: diff.added.slice(0, 20), changedFiles: diff.changed.slice(0, 20) };
}

/**
 * 跑一个最小隔离管理案例：status → apply → apply（重复）→ revert，逐步快照并记录差异。
 */
export async function runAdminCase({ ctx, pluginRoot, workspace, liveHostBase } = {}) {
  const { core, hosts } = await enumerateHosts(pluginRoot, workspace);
  const liveGuard = await beginLiveHostGuard(pluginRoot, liveHostBase, process.env.DSH_HOME);
  const aiBase = process.env.DSH_BASE || (hosts[0] || "");
  const hostFs = (await import(pathToFileURL(path.join(pluginRoot, "lib", "extract-asar.js")).href)).hostFs;
  const record = {
    kind: "admin-entry",
    ok: false,
    hosts,
    aiBase,
    steps: [],
    diffs: {},
    backupsCreated: 0,
    fdProbe: null,
    liveHost: null,
    revertRestored: false,
    knownFailures: [],
    error: "",
  };
  const runStep = async (name, tool) => {
    try {
      const value = await callTool(ctx, tool);
      const text = toolText(value);
      const failed = /^\s*ERROR[:：]/.test(text);
      record.steps.push({ name, ok: !failed, text: text.slice(0, 500), counts: parseCounts(text) });
      return { ok: !failed, text };
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      record.steps.push({ name, ok: false, text: message });
      return { ok: false, text: message };
    }
  };
  try {
    const before = snapshotTree(aiBase);
    await runStep("status", "purge_status");
    const apply1 = await runStep("apply", "purge_apply");
    const afterApply = snapshotTree(aiBase);
    record.diffs.apply = summarizeDiff(diffSnapshots(before, afterApply));
    const apply2 = await runStep("apply-again", "purge_apply");
    const afterSecond = snapshotTree(aiBase);
    record.diffs.reapply = summarizeDiff(diffSnapshots(afterApply, afterSecond));
    const revert = await runStep("revert", "purge_revert");
    const afterRevert = snapshotTree(aiBase);
    record.diffs.revert = summarizeDiff(diffSnapshots(afterSecond, afterRevert));
    record.backupsCreated = [...afterApply.keys()].filter((rel) => rel.endsWith(".dshpurge.bak")).length;
    record.revertRestored = Boolean(revert.ok && record.diffs.revert.changed > 0);
    if (!record.revertRestored) {
      record.knownFailures.push({
        id: "revert-without-backup",
        summary: "revert 报告成功但没有还原文件：隔离副本里没有 .dshpurge.bak。",
        evidence: { backupsCreated: record.backupsCreated, revertStep: record.steps[record.steps.length - 1] },
      });
    }
    record.liveHost = await checkLiveHostGuard(liveGuard);
    record.fdProbe = await backupFdProbe(hostFs, workspace);
    if (record.fdProbe.missing.length > 0 || record.fdProbe.renameError) {
      record.knownFailures.push({
        id: "hostfs-fd-methods",
        summary: "hostFs 缺少 " + record.fdProbe.missing.join(",") + "；备份占位 fd 无法关闭，rename 返回 " + (record.fdProbe.renameError || "成功") + "，apply 不产生备份。",
        evidence: record.fdProbe,
      });
    }
    record.ok = Boolean(apply1.ok && apply1.text.length > 0 && record.diffs.apply.changed > 0 && record.liveHost.ok);
    if (!record.liveHost.ok) {
      record.knownFailures.push({
        id: "live-host-write",
        summary: "管理操作期间真实安装的目标文件发生变化，隔离失败。",
        evidence: record.liveHost.changed.slice(0, 20),
      });
    }
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
}