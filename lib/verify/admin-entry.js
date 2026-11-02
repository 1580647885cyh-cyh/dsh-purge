import fs from "node:fs";
import nodeFs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertHostsIsolated, diffSnapshots, snapshotTree } from "./isolate.js";
import { asarHasHostPackages, extractAsarSubtree } from "./asar.js";
import { fixtureCacheRoot, openFixtureCache } from "./fixture-cache.js";
import { probeBackupFaults } from "./backup-faults.js";

/**
 * 插件管理生命周期入口（补充入口）。
 *
 * 在 D 盘隔离宿主副本上，通过插件公开注册的 purge_status / purge_apply / purge_revert
 * 观察实际文件结果；任何操作前先确认插件枚举到的宿主都在隔离区内。
 */

/**
 * 隔离副本只保留定位宿主与补丁落点需要的包，不复制整个桌面安装。
 *
 * 前三个是管理生命周期的最小集；#6 起补齐 targetFiles 实际引用的宿主包，
 * 让「应用 → 逐文件核对目标态」有真实对象，而不是拿缺席的键充数。
 */
const FIXTURE_PACKAGES = [
  "dsh-agent-instructions",
  "dsh-system-prompt",
  "dsh-tools",
  "dsh-web-app",
  "dsh-headless",
  "dsh-base",
  "dsh-settings",
  "dsh-user-approval",
  "dsh-sandbox",
  "dsh-sandbox-local",
  "dsh-fs-sandbox",
  "dsh-fs-observation-policy",
  "dsh-repeat-tool-reminder",
  "dsh-compaction-tool-result-pruner",
  "dsh-tool-fs",
  "dsh-tool-bash",
  "dsh-tool-pwsh",
  "dsh-tool-web",
  "dsh-tool-subagent",
  "dsh-tool-todo",
  "dsh-subagent",
  "dsh-persona",
  "dsh-permission-presets",
  "dsh-session",
  "dsh-session-reference",
  "dsh-session-log-deepseek",
  "dsh-session-format-v0-to-v1",
  "dsh-agent-loop",
  "dsh-app-boot",
  "dsh-api-session-controller",
  "dsh-client-ui-conversation",
  "dsh-client-ui-deliverables",
  "dsh-experimental-auto-review",
  "dsh-llm-deepseek",
  "dsh-llm-pi-ai",
  "dsh-sandbox-policy",
  "dsh-acp-app",
  "dsh-sdk-app",
  "dsh-sdk-minimal",
  // 完整提示词装配证明要用的宿主基础包（dsh-system-prompt / cordis 的依赖）。
  "cordis",
  "cosmokit",
  "schemastery",
  "dsh-scope",
];

/** 宿主基础包之外的直接依赖（完整提示词装配证明要用）。 */
const FIXTURE_EXTRA_PATHS = [
  "dsh/node_modules/@standard-schema",
  // pi-ai 的三个 API 落点是补丁键 pi-ai-* 的目标（#47/#49/#57）。
  "dsh/node_modules/@earendil-works/pi-ai/dist/api",
];

/**
 * fixture 配方：要解哪些宿主包、哪些额外依赖。
 *
 * 缓存清单里记的就是它。键只由 asar 的 size + mtime 决定，所以往上面两张表加包时
 * asar 没变、键也不变——不比对配方的话旧缓存会静默少包（#11 审查发现）。
 */
export const FIXTURE_RECIPE = { packages: FIXTURE_PACKAGES, extras: FIXTURE_EXTRA_PATHS };

/** 副本里的两条固定路径：外壳那层与宿主包那层。 */
function fixturePaths(installDir) {
  const appDir = path.join(installDir, "resources", "app");
  return { appDir, fixtureBase: path.join(appDir, "dsh", "node_modules", "@deepseek-ai") };
}

/**
 * 往一份副本目录里填 fixture：优先从 asar 解，解不出来才复制安装目录。
 *
 * 缓存与直接构建共用这一段，所以「缓存里的副本」和「现场解出来的副本」是同一段代码的产物。
 */
function fillFixtureTree({ installDir, hostBase, shellVersion = "0.2.1-rc.5", asarPath, fromAsar }) {
  const { appDir } = fixturePaths(installDir);
  fs.mkdirSync(appDir, { recursive: true });
  const copied = [];
  for (const pkg of FIXTURE_PACKAGES) {
    const target = path.join(appDir, "dsh", "node_modules", "@deepseek-ai", pkg);
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
  // 基础包之外的直接依赖：asar 里是 dsh/node_modules/<pkg>，安装目录里对应
  // <hostBase 的父目录>/<pkg>（@deepseek-ai 目录本身就是 node_modules 下的一层）。
  const copiedExtras = [];
  for (const innerPath of FIXTURE_EXTRA_PATHS) {
    const target = path.join(appDir, ...innerPath.split("/"));
    if (fromAsar) {
      try {
        extractAsarSubtree(asarPath, innerPath, target);
        copiedExtras.push(innerPath);
        continue;
      } catch { /* 回退到安装目录 */ }
    }
    const relativeToNodeModules = innerPath.split("/").slice(2).join("/");
    const source = path.join(path.dirname(hostBase), relativeToNodeModules);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, target, { recursive: true });
    copiedExtras.push(innerPath);
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
  return { copied, copiedExtras };
}

/**
 * 建隔离宿主副本，返回 fixture 事实（来源 asar / cache / install、包清单、耗时）。
 *
 * #11：命中 fixture 缓存时走一次 cpSync，不再逐包重解 asar；缓存故障只让本轮慢回
 * 「从 asar 解」，不会让验证失败。cacheRoot 传 null 可关掉缓存（排查用）。
 */
export function prepareFixtureHost({ hostBase, installDir, shellVersion = "0.2.1-rc.5", asarPath, cacheRoot } = {}) {
  const started = Date.now();
  const { appDir, fixtureBase } = fixturePaths(installDir);
  const fromAsar = Boolean(asarPath && fs.existsSync(asarPath) && asarHasHostPackages(asarPath));
  const build = (tree) => fillFixtureTree({ installDir: tree, hostBase, shellVersion, asarPath, fromAsar });
  const cache = fromAsar && cacheRoot !== null
    ? openFixtureCache({ asarPath, shellVersion, recipe: FIXTURE_RECIPE, cacheRoot: cacheRoot || fixtureCacheRoot() })
    : null;
  const done = (filled, source) => ({
    fixtureBase,
    appDir,
    copied: filled.copied,
    copiedExtras: filled.copiedExtras,
    source,
    durationMs: Date.now() - started,
    cache: cache ? cache.summary() : null,
  });

  if (cache) {
    if (cache.manifest && cache.use(installDir)) return done(cache.manifest, "cache");
    try {
      return done(cache.rebuild(installDir, build), "asar");
    } catch { /* 缓存写不进去就用下面那条直路，验证照常跑完 */ }
  }
  return done(build(installDir), fromAsar ? "asar" : "install");
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

/**
 * 文件种类探针：管理操作写入前要先判断“这是不是一个可以注入的文本入口”。
 * 同时覆盖无害文本入口（应注入）、二进制（应跳过且字节不变）与普通文件（不参与 shim）。
 */
export async function probeFileKinds(core, workspace) {
  const dir = path.join(workspace.out, "file-kinds");
  fs.mkdirSync(dir, { recursive: true });
  const text = path.join(dir, "dsh.ps1");
  const binary = path.join(dir, "dsh");
  const plain = path.join(dir, "notes.txt");
  const binaryBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x00]);
  const plainText = "ordinary text, not a launcher\n";
  const record = { ok: false, before: null, after: null, patch: null, binaryUnchanged: false, plainUnchanged: false, error: "" };
  try {
    fs.writeFileSync(text, "# dsh launcher\nexit 0\n", "utf8");
    fs.writeFileSync(binary, binaryBytes);
    fs.writeFileSync(plain, plainText, "utf8");
    record.before = {
      text: core.shimFileStatus(text),
      binary: core.shimFileStatus(binary),
      plain: core.shimFileStatus(plain),
    };
    record.patch = await core.patchShim(dir);
    record.after = {
      text: core.shimFileStatus(text),
      binary: core.shimFileStatus(binary),
      plain: core.shimFileStatus(plain),
    };
    record.binaryUnchanged = fs.readFileSync(binary).equals(binaryBytes);
    record.plainUnchanged = fs.readFileSync(plain, "utf8") === plainText;
    record.ok = Boolean(
      record.before.text === "original"
      && record.before.binary === "binary"
      && record.after.text === "patched"
      && record.patch
      && record.patch["dsh.ps1"] === "patched"
      && record.patch.dsh === "skipped_binary"
      && !Object.prototype.hasOwnProperty.call(record.patch, "notes.txt")
      && record.binaryUnchanged
      && record.plainUnchanged,
    );
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
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
    fileProbe: null,
    backupFaults: null,
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
    // #7：备份/恢复的故障注入（完整备份 / 官方标记 / 过期备份 / 0 字节备份）。
    // 用独立小副本（从刚 revert 干净的隔离副本复制官方样本），不污染本入口的现场。
    record.backupFaults = await probeBackupFaults({ core, workspace, sourceAiBase: aiBase });
    if (!record.backupFaults.ok) {
      record.knownFailures.push({
        id: "backup-faults",
        summary: "备份/恢复的故障注入没有通过：" + (record.backupFaults.error
          || (record.backupFaults.cases || []).filter((item) => !item.ok).map((item) => item.id).join(",")),
        evidence: record.backupFaults,
      });
    }
    record.fileProbe = await probeFileKinds(core, workspace);
    if (!record.fileProbe.ok) {
      record.knownFailures.push({
        id: "file-kind-probe",
        summary: "文本入口、普通文件与二进制文件没有被正确区分（或文本入口无法注入）。",
        evidence: record.fileProbe,
      });
    }
    record.ok = Boolean(
      apply1.ok
      && apply1.text.length > 0
      && record.diffs.apply.changed > 0
      && record.liveHost.ok
      && record.fileProbe.ok
      && record.backupFaults.ok,
    );
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