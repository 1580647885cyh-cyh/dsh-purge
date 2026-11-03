import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { diffSnapshots, snapshotTree } from "./isolate.js";
import { asarHasHostPackages, extractAsarSubtree } from "./asar.js";
import { beginLiveHostGuard, callTool, checkLiveHostGuard, enumerateHosts } from "./admin-entry.js";
import { auditTargetStatus, firstTargetPath, inspectPatchTargets } from "./targets.js";
import { proveNextRecognition } from "./desktop-next.js";
import { proveAsarSwapRestart } from "./desktop-swap.js";
import { extractCloseHandler, proveExitTrace, runCloseHandler } from "./exit-trace.js";

/**
 * 目标定位与适配状态（#6，入口五）。
 *
 * 三件事：
 * 1. 只读地看真实安装：每个补丁要处理的文件落在哪、哪些键在 0.2.1-rc.5 里已经不存在；
 * 2. 在隔离副本上走公开的 purge_status / purge_apply：应用前后逐文件核对目标态，
 *    重复应用不得再改文件；
 * 3. 用宿主的公开运行结果证明处理生效：完整提示词装配里注入段仍在、
 *    桌面壳 close 回调在 code=0 时不再 fail —— 不是只看字符串命中。
 */

const SHELL_KEY = "desktop-shell";

function shellPatches(core) {
  return core.ALL_PATCHES.filter((patch) => core.fileKeysOf(patch).includes(SHELL_KEY));
}

/** 从 app.asar 取出未打补丁的桌面壳入口，供文件级效果证明使用。 */
function prepareShellFixture({ asarPath, outDir }) {
  const file = path.join(outDir, "main.js");
  if (!asarPath || !fs.existsSync(asarPath) || !asarHasHostPackages(asarPath)) {
    return { ok: false, file, error: "拿不到 app.asar 里的桌面壳入口" };
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  try {
    extractAsarSubtree(asarPath, "lib", outDir);
  } catch (error) {
    return { ok: false, file, error: String(error && error.message ? error.message : error) };
  }
  return { ok: fs.existsSync(file), file, error: "" };
}

/**
 * 桌面壳：把补丁按与 applyPatches 相同的替换函数打到解出的入口上，
 * 再核对行为与重复应用稳定性。
 */
function proveDesktopShell({ core, shell }) {
  const record = { kind: "target-entry.shell", ok: false, file: shell.file, error: shell.error || "", cases: [], repeatChanged: 0 };
  const result = { record, originalText: "", patchedText: "" };
  if (!shell.ok) return result;
  const patches = shellPatches(core);
  try {
    let text = fs.readFileSync(shell.file, "utf8");
    // 未打补丁的同源入口留给留痕证明当故障对照（本来就不该有记录）。
    const originalText = text;
    result.originalText = originalText;
    result.patchedText = text;
    // 故障对照：未打补丁的同源入口上跑同一个回调，code=0 必须仍然 fail ——
    // 证明下面的「不报错」来自补丁，而不是用例本身不成立。
    const controlBody = extractCloseHandler(text);
    const control = controlBody ? runCloseHandler(controlBody, 0) : null;
    record.cases.push({
      id: "control-unpatched",
      ok: Boolean(control && control.failed.length > 0),
      detail: control ? "未打补丁：code=0 → " + (control.failed.length ? "fail" : "未报错") : "未打补丁的入口里取不到 close 回调",
    });
    let changed = 0;
    for (const patch of patches) {
      if (!core.patchAppliesHere(patch)) continue;
      const applied = core.applyReplacementsToText(text, patch, shell.file);
      if (applied.text !== text) {
        text = applied.text;
        changed += 1;
      }
    }
    if (changed > 0) fs.writeFileSync(shell.file, text, "utf8");
    result.patchedText = text;
    // 重复应用：同一批补丁再走一遍，文件不得再变（不追加重复内容）。
    let second = text;
    for (const patch of patches) {
      if (!core.patchAppliesHere(patch)) continue;
      const applied = core.applyReplacementsToText(second, patch, shell.file);
      if (applied.text !== second) {
        second = applied.text;
        record.repeatChanged += 1;
      }
    }
    const body = extractCloseHandler(text);
    record.cases.push({ id: "close-handler-found", ok: body.length > 0, detail: body.length > 0 ? "取到 close 回调" : "没有 close 回调" });
    if (body.length > 0) {
      const clean = runCloseHandler(body, 0);
      const failed = runCloseHandler(body, 3);
      record.cases.push({ id: "clean-exit", ok: clean.failedClean && clean.resolved, detail: "code=0 → " + (clean.failed.length ? "fail(" + clean.failed.join(";") + ")" : "resolve") });
      record.cases.push({ id: "real-exit", ok: failed.failed.length > 0, detail: "code=3 → " + (failed.failed.length ? "fail" : "未报错") });
    }
    record.cases.push({ id: "repeat-apply", ok: record.repeatChanged === 0, detail: "重复应用改动 " + record.repeatChanged + " 处" });
    record.ok = record.cases.every((item) => item.ok);
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return result;
}

/** 完整提示词装配：complete 段存在时，插件注入段与 required 上下文都要留下。 */
async function assembleCompletePrompt(base) {
  const cordis = await import(pathToFileURL(path.join(base, "cordis", "lib", "index.js")).href);
  const systemPrompt = await import(pathToFileURL(path.join(base, "dsh-system-prompt", "lib", "index.js")).href);
  const ctx = new cordis.Context();
  await ctx.plugin(systemPrompt.default, {}).await();
  const disposers = [
    ctx.systemPrompt.section({ name: "verify:complete", order: 10, text: "COMPLETE-SECTION", complete: true }),
    ctx.systemPrompt.section({ name: "dsh-purge", order: 20, text: "PURGE-INJECT" }),
    ctx.systemPrompt.context({ name: "working-directory", order: 10, required: true, text: "CWD" }),
    ctx.systemPrompt.context({ name: "verify:optional-context", order: 20, text: "OPT" }),
  ];
  const agentContext = () => ({ agent: { options: { provider: "verify-provider", model: "verify-model" }, session: { header: { cwd: "D:/dsh/tmp/dsh-purge-verify/workspace" }, events: [] } } });
  try {
    const assembly = await ctx.systemPrompt.assemble(agentContext());
    const names = (assembly.sections || []).map((section) => section.name);
    const text = String(systemPrompt.renderPrompt(assembly));
    let suppressedContexts = null;
    if (typeof ctx.systemPrompt.suppressRuntimeContext === "function") {
      const release = ctx.systemPrompt.suppressRuntimeContext();
      try {
        const suppressed = await ctx.systemPrompt.assemble(agentContext());
        suppressedContexts = (suppressed.contexts || []).map((item) => item.name);
      } finally {
        if (typeof release === "function") release();
      }
    }
    return {
      sections: names,
      hasInject: names.includes("dsh-purge") && text.includes("PURGE-INJECT"),
      hasComplete: names.includes("verify:complete") && text.includes("COMPLETE-SECTION"),
      suppressedContexts,
    };
  } finally {
    for (const dispose of disposers) {
      if (typeof dispose === "function") {
        try { dispose(); } catch { /* 已撤 */ }
      }
    }
  }
}

/**
 * 完整提示词装配：complete 段存在时，插件注入段与 required 上下文都要留下。
 * controlBase 用来做故障对照：未打补丁的真实宿主在同一装配里应当丢掉注入段。
 */
async function proveCompletePromptInject({ aiBase, controlBase } = {}) {
  const record = { kind: "target-entry.complete-prompt", ok: false, error: "", detail: {}, control: null };
  try {
    const patched = await assembleCompletePrompt(aiBase);
    record.detail = patched;
    record.ok = Boolean(
      patched.hasInject
      && patched.hasComplete
      && Array.isArray(patched.suppressedContexts)
      && patched.suppressedContexts.includes("working-directory")
      && !patched.suppressedContexts.includes("verify:optional-context"),
    );
    if (controlBase) {
      try {
        const control = await assembleCompletePrompt(controlBase);
        record.control = { base: controlBase, sections: control.sections, hasInject: control.hasInject };
      } catch (error) {
        // 对照跑不起来不影响主判定，但事实照记。
        record.control = { base: controlBase, error: String(error && error.message ? error.message : error) };
      }
    }
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
}

function countByEvidence(rows) {
  const out = {};
  for (const row of rows) out[row.evidence] = (out[row.evidence] || 0) + 1;
  return out;
}

/**
 * 把 preset 里 tool-web 的 fetch 关掉（并清掉我们写过的注释），
 * 模拟「官方或用户把这行关着」的形态，供公开 purge_apply 的落地证明使用。
 */
function seedPresetFetchOff(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((line) => !line.includes("[dsh-purge] preset fetch enabled"));
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^[ \t]*- id: tool-web\b/.test(lines[i])) continue;
    if (!/^[ \t]*name: '@deepseek-ai\/dsh-tool-web'\s*$/.test(lines[i + 1] || "")) continue;
    const indent = (/^[ \t]*/.exec(lines[i]) || [""])[0].length;
    for (let j = i + 2; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) continue;
      if ((/^[ \t]*/.exec(line) || [""])[0].length <= indent) break;
      if (/^[ \t]*fetch:\s*true\s*$/.test(line)) {
        lines[j] = line.replace(/fetch:\s*true\s*$/, "fetch: false");
        return lines.join("\n");
      }
    }
  }
  return "";
}

/** preset fetch：在隔离副本上把 fetch 关掉，再用公开的 purge_apply 证明处理真的会落地。 */
async function provePresetFetchTreatment({ ctx, core, aiBase }) {
  const record = { kind: "target-entry.preset-fetch", ok: false, file: "", error: "", cases: [] };
  try {
    const files = core.targetFiles(aiBase);
    const file = firstTargetPath(files, "preset-standard");
    if (!file) {
      record.error = "隔离副本里没有 preset-standard";
      return record;
    }
    record.file = file;
    const seeded = seedPresetFetchOff(fs.readFileSync(file, "utf8"));
    if (!seeded) {
      record.error = "preset 里找不到 tool-web 的 fetch: true，无法构造对照";
      return record;
    }
    fs.writeFileSync(file, seeded, "utf8");
    record.cases.push({ id: "seed-fetch-off", ok: true, detail: "把 tool-web 的 fetch 改成 false" });
    await callTool(ctx, "purge_apply");
    const applied = fs.readFileSync(file, "utf8");
    const opened = core.presetToolWebFetchEnabled(applied) && applied.includes("[dsh-purge] preset fetch enabled");
    record.cases.push({ id: "apply-opens-fetch", ok: opened, detail: "公开 purge_apply 后 fetch=" + (core.presetToolWebFetchEnabled(applied) ? "true" : "false") });
    await callTool(ctx, "purge_apply");
    record.cases.push({ id: "repeat-apply", ok: fs.readFileSync(file, "utf8") === applied, detail: "重复应用不追加内容" });
    record.ok = record.cases.every((item) => item.ok);
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
}

/** 入口五：只读定位 + 隔离副本应用 + 运行结果证明。 */
export async function runTargetCase({ ctx, pluginRoot, workspace, liveHostBase, resourcesDir, realDshHome, asarPath, liveGuard, skipSwap = false } = {}) {
  const { core, hosts } = await enumerateHosts(pluginRoot, workspace);
  const aiBase = process.env.DSH_BASE || hosts[0] || "";
  const guard = liveGuard || await beginLiveHostGuard(pluginRoot, liveHostBase, process.env.DSH_HOME);
  const record = {
    kind: "target-entry",
    ok: false,
    aiBase,
    hosts,
    live: null,
    isolated: { statusBefore: {}, statusAfter: {}, summary: {}, applied: null, notApplicable: [], drifted: [], diffs: {} },
    host: null,
    audit: null,
    runtime: {},
    desktop: null,
    liveHost: null,
    error: "",
  };
  try {
    // 0) A1：宿主版本与适配状态。只报告，**不参与 record.ok** —— 未适配不等于验证失败。
    // 隔离环境清空了 PATH，桌面 exe 发现按设计不回落到真实安装：有 resourcesDir 就直接读它。
    const hostAppDir = resourcesDir ? path.join(resourcesDir, "app") : "";
    const hostVersion = (hostAppDir ? core.readHostVersion(hostAppDir) : null) || core.readInstalledHostVersion();
    const adaptation = core.hostAdaptation(hostVersion ? hostVersion.version : "", core.PLUGIN_HOST_TARGETS);
    record.host = { ...adaptation, path: hostVersion ? hostVersion.path : "" };
    // 1) 只读定位：真实安装里每个键落在哪、哪些键在当前版本不存在。
    // 用户预设键要用真实 DSH_HOME 才能定位（只读；与入口一的预设静态审计同一条边界）。
    if (liveHostBase) {
      // 隔离环境清空了 PATH，桌面 exe 发现按设计不回落到真实安装，所以桌面壳入口
      // 直接用安装树的 resources 目录核对，不假装是 targetFiles 解析出来的。
      const shellCandidates = resourcesDir
        ? [path.join(resourcesDir, "app", "lib", "main.js"), path.join(resourcesDir, "app", "main.js")]
        : [];
      const liveShell = shellCandidates.find((file) => fs.existsSync(file)) || "";
      // 用 extraTargets 把真实壳入口交给逐文件核对：否则 desktop-shell 在副本/真机都解析不到，
      // #90 的真实状态只剩一个「不适用」，报告里就没有 pending → applied 的证据（#25 SPEC 复核）。
      const live = inspectPatchTargets({
        core,
        aiBase: liveHostBase,
        dshHome: realDshHome || process.env.DSH_HOME,
        extraTargets: liveShell ? { [SHELL_KEY]: [liveShell] } : {},
      });
      const exitRow = live.rows.find((row) => row.id === 90);
      const exitSourcesRow = live.rows.find((row) => row.id === 91);
      record.live = {
        aiBase: liveHostBase,
        summary: live.summary,
        notApplicable: live.notApplicable.map((row) => ({ id: row.id, name: row.name, keys: row.keys.map((item) => item.key) })),
        unmatched: live.rows.filter((row) => row.evidence === "unmatched").map((row) => ({ id: row.id, name: row.name, keys: row.targets.map((item) => item.key) })),
        drifted: live.drifted || [],
        unresolvedKeys: live.unresolvedKeys,
        shellFile: liveShell,
        shellCandidates,
        // A5：新补丁在真实安装上的目标态（pending = 还没写进宿主；Apply 后应变成 effective）。
        exitPatch: exitRow ? { id: exitRow.id, evidence: exitRow.evidence } : null,
        // A5-2（#26）：多来源块也走同一条「真实安装 → 逐文件核对」的路（pending 表示还没写进宿主）。
        exitSourcesPatch: exitSourcesRow ? { id: exitSourcesRow.id, evidence: exitSourcesRow.evidence } : null,
      };
    }
    // 2) 隔离副本：公开状态 → 应用 → 逐文件核对 → 重复应用。
    const before = snapshotTree(aiBase);
    record.isolated.statusBefore = await core.patchStatus(aiBase);
    const shell = prepareShellFixture({ asarPath, outDir: path.join(workspace.out, "shell") });
    // 桌面壳在隔离副本里没有 exe（避免触发重启路径），用解出的入口单独证明。
    const shellProof = proveDesktopShell({ core, shell });
    const apply = await callTool(ctx, "purge_apply");
    const afterApply = snapshotTree(aiBase);
    record.isolated.statusAfter = await core.patchStatus(aiBase);
    const inspected = inspectPatchTargets({
      core,
      aiBase,
      dshHome: process.env.DSH_HOME,
      extraTargets: shell.ok ? { [SHELL_KEY]: [shell.file] } : {},
    });
    record.isolated.summary = inspected.summary;
    record.isolated.applied = inspected.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: record.isolated.statusAfter[row.id],
      evidence: row.evidence,
      targets: row.targets.map((item) => item.key),
    }));
    record.isolated.notApplicable = inspected.notApplicable;
    record.isolated.unmatched = inspected.unmatched;
    // A2：漂移清单（补丁 → 文件 → 没命中的锚点）。不挡 ok，但必须在报告里逐条看见。
    record.isolated.drifted = inspected.drifted || [];
    record.isolated.unresolvedKeys = inspected.unresolvedKeys;
    record.isolated.diffs.apply = diffSnapshots(before, afterApply).changed.length;
    const softIds = core.ALL_PATCHES.filter((patch) => core.isLayoutSoftPatch(patch)).map((patch) => patch.id);
    record.audit = auditTargetStatus({ rows: inspected.rows, status: record.isolated.statusAfter, softIds });
    const reapply = await callTool(ctx, "purge_apply");
    const afterSecond = snapshotTree(aiBase);
    const second = diffSnapshots(afterApply, afterSecond);
    record.isolated.diffs.reapply = second.changed.length + second.added.length + second.removed.length;
    record.isolated.diffs.added = second.added.slice(0, 10);
    record.isolated.diffs.changed = second.changed.slice(0, 10);
    // 3) 运行结果证明。
    record.runtime.completePrompt = await proveCompletePromptInject({ aiBase, controlBase: liveHostBase });
    record.runtime.shell = shellProof.record;
    // A5（#25 / #26）：桌面退出留痕 —— close 与四个生命周期来源在真 fs 作用域下各落一条、
    // 多来源合成一条原因链，再用公开的 purge_status 读回「最近一次桌面退出」；把 close 那段拔掉必须重新变红。
    record.runtime.exitTrace = await proveExitTrace({
      patchedText: shellProof.patchedText,
      unpatchedText: shellProof.originalText,
      home: process.env.DSH_HOME || "",
      scratchDir: path.join(workspace.out, "exit-trace"),
      readStatus: async () => {
        const value = await callTool(ctx, "purge_status");
        return String(value && value.text ? value.text : "");
      },
    });
    // A4（#24）：fixture 的 NEXT 安装树，四项事实各落一条。
    record.desktop = proveNextRecognition({
      core,
      root: path.join(workspace.root, "desktop-next"),
      shellSource: shell.ok ? shell.file : "",
    });
    // A7 / #27：假安装树里跑生产换包脚本（wscript），核对「先 main、确认消失、再挪 asar」与失败拉起原版。
    // --skip-swap 只服务 --only targets 的迭代；完整 verify 永远跑 harness。
    record.runtime.desktopSwap = skipSwap
      ? { kind: "desktop-swap", ok: true, skipped: true, reason: "--skip-swap（仅 --only targets 迭代用；完整 verify 仍跑）", cases: [] }
      : await proveAsarSwapRestart({
        pluginRoot,
        root: path.join(workspace.root, "desktop-swap"),
      });
    // preset fetch：把隔离副本上的 tool-web 关掉，再走公开的 purge_apply，看处理是否真的落地。
    record.runtime.presetFetch = await provePresetFetchTreatment({ ctx, core, aiBase });
    record.liveHost = await checkLiveHostGuard(guard);
    record.ok = Boolean(
      apply
      && afterApply.size > 0
      && record.isolated.diffs.apply > 0
      && record.isolated.diffs.reapply === 0
      && record.audit.falseSuccess.length === 0
      && record.audit.ahead.length === 0
      && record.audit.behind.length === 0
      && record.runtime.completePrompt.ok
      && record.runtime.shell.ok
      && record.runtime.exitTrace.ok
      && record.runtime.desktopSwap.ok
      && record.desktop
      && record.desktop.ok
      && record.liveHost.ok,
    );
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
}
