import assert from "node:assert/strict";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "../../lib/core.js";
import { EXIT_LEDGER_MAX_BYTES, EXIT_LEDGER_MAX_ENTRIES } from "../../lib/exit-ledger.js";
import { DESKTOP_EXIT_TRACE_SOURCES_CODE, EXIT_TRACE_CLOSE_MARKER, EXIT_TRACE_SOURCES_BEGIN } from "../../lib/desktop-exit-trace.js";
import * as model from "../../lib/patch-model.js";
import { tempDir, withIsolatedHome } from "../verify/helpers.js";

/**
 * 接线检查（issue #15 复盘）。
 *
 * 第一刀把判定搬进 patch-model.js 之后，core.js 里漏导入一个名字不会在启动时炸：
 * 它藏在函数体里，只有真跑 apply/status 才报 "filePatchOutcome is not defined"。
 * 这条测试把那种漏接在秒级发现，而不是等 npm run verify 的整轮真宿主。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const coreSrc = readFileSync(path.join(repoRoot, "lib", "core.js"), "utf8");
const modelSrc = readFileSync(path.join(repoRoot, "lib", "patch-model.js"), "utf8");

/**
 * 只看真正会执行的代码：
 * - 去掉补丁表那段数据（里面嵌着要写进宿主的代码字符串，会把 observe 这类名字算成引用）；
 * - 去掉注释与 re-export 块（re-export 不产生本地绑定）。
 */
function executableBody(src) {
  const dataStart = src.indexOf("const PATCHES = [");
  const dataEnd = src.indexOf("export const ALL_PATCHES");
  const sliced = dataStart >= 0 && dataEnd > dataStart;
  // 切片锚点改名时不许静默退化：真的切掉了一段才继续。
  assert.ok(sliced && dataEnd - dataStart > 1000, "补丁表切片锚点失效（const PATCHES = [ … export const ALL_PATCHES），接线检查会误报为通过");
  const logic = sliced ? src.slice(0, dataStart) + src.slice(dataEnd) : src;
  return logic
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/export\s*\{[\s\S]*?\}\s*from\s*"\.\/patch-model\.js";/g, "");
}

function importedNames(src) {
  const out = new Set();
  const re = /import\s*\{([^}]+)\}\s*from\s*"\.\/patch-model\.js"/g;
  for (const m of src.matchAll(re)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim();
      if (name) out.add(name);
    }
  }
  return out;
}

test("接线：core 用到的补丁语义都必须从 patch-model 导入", () => {
  const imported = importedNames(coreSrc);
  const body = executableBody(coreSrc);
  const declared = [...modelSrc.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  assert.ok(declared.length > 10, "应该从 patch-model 里读出函数清单");
  const missing = declared.filter((name) => new RegExp("\\b" + name + "\\b").test(body) && !imported.has(name));
  assert.deepEqual(missing, [], "core 引用了 patch-model 的函数却没导入：" + missing.join(", "));
});

test("接线：校验器的生产调用点在（删掉调用点这条会红）", () => {
  const body = executableBody(coreSrc);
  assert.match(body, /assertPatchTable\(ALL_PATCHES\)/, "core 加载期必须调用 assertPatchTable(ALL_PATCHES)");
  assert.match(body, /assertTargetKeys\(Object\.keys\(files\)\)/, "targetFiles 必须比对键集合");
});

test("接线：core 的公开面仍然保留旧的导出名（verify 与老调用点靠它）", () => {
  for (const name of [
    "patchOwnMarkPresent",
    "patchEffectState",
    "missingAnchors",
    "isSelfMarkedPatch",
    "isLayoutSoftPatch",
    "applyReplacementsToText",
    "collapseDuplicateLegacyApplyPath",
    "yamlJsCommentsToHash",
  ]) {
    assert.equal(typeof core[name], "function", "core 应该继续导出 " + name);
  }
});

test("接线：A2 的漂移判定必须接在生产路径上（拔掉任何一处都要红）", () => {
  const body = executableBody(coreSrc);
  // 状态聚合必须把 drifted 传进去，否则 filePatchOutcome 判出来也会被丢掉。
  assert.match(body, /rollupPatchStatus\(\{[\s\S]{0,120}drifted/, "rollupPatchStatus 的调用必须传 drifted");
  // 生产路径必须真的算出「漂在哪」并写进报告行。
  assert.match(body, /missingAnchors\(text, p, fp\)/, "apply 循环必须记录没命中的锚点");
  assert.match(body, /driftAnchors\.push/, "漂移锚点必须进报告行");
  // 自标记型补丁要单独放行，不能被算成漂移。
  assert.match(body, /isSelfMarkedPatch\(p\)/, "apply 循环必须用自标记判定放行撤销型补丁");
  // patchStatus 必须能产出 drifted 这个词（面板与 purge_status 都读它）。
  assert.match(body, /status\[p\.id\] = "drifted"/, "patchStatus 必须产出 drifted 状态");
  const targetsSrc = readFileSync(path.join(repoRoot, "lib", "verify", "targets.js"), "utf8");
  assert.match(targetsSrc, /core\.missingAnchors\(/, "验证侧必须调用 missingAnchors 才有「漂在哪」");
  assert.match(targetsSrc, /const drifted = rows/, "验证侧必须交出一份漂移清单（不是只有计数）");
});

test("接线：A1 的宿主版本必须读、必须进状态（不阻断也要看得见）", () => {
  const body = executableBody(coreSrc);
  assert.match(body, /readHostVersion\(path\.join\(resources, "app"\)\)|readInstalledHostVersion/, "必须读宿主壳版本");
  assert.match(body, /host_adaptation: hostState\.state/, "gatherState 必须写出适配状态");
  assert.match(body, /host_version: hostRead \? hostRead\.version : ""/, "gatherState 必须写出宿主版本");
  const targetsSource = readFileSync(path.join(repoRoot, "lib", "verify", "target-entry.js"), "utf8");
  assert.match(targetsSource, /readHostVersion\(/, "验证侧必须从宿主壳 package.json 读版本（隔离环境没有 PATH，不能靠 exe 发现）");
  const indexSrc = readFileSync(path.join(repoRoot, "lib", "index.js"), "utf8");
  assert.match(indexSrc, /describeHostAdaptation\(/, "status 输出必须用同一套适配描述");
  assert.equal(typeof core.readInstalledHostVersion, "function", "core 必须导出读版本入口");
  assert.equal(typeof core.hostAdaptation, "function", "core 必须导出适配判定");
});

test("接线：patchStatus 走生产路径必须产出 drifted（把分支改回 skipped 这条会红）", async () => {
  const saved = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  try {
    await withIsolatedHome(async () => {
      const dir = tempDir("drift-status-");
      try {
        const file = path.join(dir, "dsh-base", "cordis.patch.yml");
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // 宿主把这段改成了别的写法：既不是原文，也没有我们的产物。
        fs.writeFileSync(file, "# fixture：这一段被官方改掉了\n", "utf8");
        const patch = core.ALL_PATCHES.find((item) => {
          const keys = core.fileKeysOf(item);
          if (keys.length !== 1 || keys[0] !== "base") return false;
          if (item.optional || item.strictFiles) return false;
          if (core.isLayoutSoftPatch(item)) return false;
          if (typeof item.settledWhen === "function") return false;
          const reps = Array.isArray(item.replacements)
            ? item.replacements
            : (item.patterns || []).map((pattern) => ({ pattern, replace: item.replace }));
          if (reps.length === 0) return false;
          return reps.every((rep) => typeof rep.pattern === "string" && typeof rep.replace === "string" && rep.replace.length > 0);
        });
        assert.ok(patch, "补丁表里应有一条落在 base 的普通补丁，否则这条接线检查会退化成空跑");
        const status = await core.patchStatus(dir);
        assert.equal(status[patch.id], "drifted", "#" + patch.id + " 在宿主原文不在时必须报 drifted，不能被压成 skipped");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    if (saved === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = saved;
  }
});

test("接线：适配状态与漂移都不进通过/重启条件（用户口径：不阻断）", () => {
  const targetSrc = readFileSync(path.join(repoRoot, "lib", "verify", "target-entry.js"), "utf8");
  const okBlock = /record\.ok = Boolean\(([\s\S]*?)\);/.exec(targetSrc);
  assert.ok(okBlock, "target-entry 的 record.ok 计算必须还在");
  assert.equal(/host/i.test(okBlock[1]), false, "宿主适配状态不许进 record.ok（未适配≠验证失败）");

  const indexSrc = readFileSync(path.join(repoRoot, "lib", "index.js"), "utf8");
  const restart = /applyShouldRestart\(\{([\s\S]*?)\}\);/.exec(indexSrc);
  assert.ok(restart, "面板 Apply 的重启判定必须还在");
  assert.equal(/drift/i.test(restart[1]), false, "漂移不许进重启条件（只影响文案，不影响是否重启）");

  const settleSrc = readFileSync(path.join(repoRoot, "lib", "reapply.js"), "utf8");
  assert.equal(/hostAdaptation|host_adaptation/.test(settleSrc), false, "换包判定不许看适配状态");
});

test("接线：每个状态词都必须在合并排序里登记（漏登记会静默降级成最差/最好）", () => {
  const rank = core.APPLY_STATUS_RANK;
  assert.ok(rank && typeof rank === "object", "core 必须导出 APPLY_STATUS_RANK");
  const missing = model.STATUS_WORDS.filter((word) => rank[word] === undefined);
  assert.deepEqual(missing, [], "状态词漏登记合并排序：" + missing.join(", "));
  const values = Object.values(rank);
  assert.equal(new Set(values).size, values.length, "排序值必须唯一，否则谁更差说不清");
  assert.ok(rank.read_error < rank.drifted, "读错误必须比漂移更差");
  assert.ok(rank.drifted < rank.missing_file, "漂移必须比文件缺失更差（文件在、但补丁没生效）");
  assert.ok(rank.drifted < rank.applied, "漂移必须比已应用更差");
});

test("接线：状态词表里只有 pending 允许挡重启（不新增阻断的机械底线）", () => {
  for (const word of model.STATUS_WORDS) {
    const facts = model.statusFacts(word);
    assert.equal(
      facts.soft,
      word !== "pending",
      "状态词 " + word + " 的 soft 语义变了：新增阻断面必须是一次显式决定，不是顺手加上",
    );
  }
});

test("接线：多宿主合并时漂移不能盖掉更差的硬状态（APPLY_STATUS_RANK 必须登记 drifted）", () => {
  const merged = core.mergeApplyReports([
    [{ patch_id: 1, status: "read_error" }],
    [{ patch_id: 1, status: "drifted" }],
  ]);
  assert.equal(merged[0].status, "read_error", "另一宿主的读错误不能被软漂移盖掉");
  const vsMissing = core.mergeApplyReports([
    [{ patch_id: 2, status: "missing_file" }],
    [{ patch_id: 2, status: "drifted" }],
  ]);
  assert.equal(vsMissing[0].status, "drifted", "漂移比文件缺失更需要人看");
  const vsApplied = core.mergeApplyReports([
    [{ patch_id: 3, status: "applied" }],
    [{ patch_id: 3, status: "drifted" }],
  ]);
  assert.equal(vsApplied[0].status, "drifted", "一宿主漂移、另一宿主成功 → 整体报漂移");
});

test("接线：必需补丁缺原文仍走硬词，普通补丁才是 drifted", async () => {
  const saved = process.env.DSH_SURFACE;
  process.env.DSH_SURFACE = "desktop";
  try {
    await withIsolatedHome(async () => {
      const dir = tempDir("strict-drift-");
      try {
        const base = path.join(dir, "dsh-base", "cordis.patch.yml");
        const preset = path.join(dir, "dsh-agent-presets", "presets", "standard", "agent.cordis.yml");
        fs.mkdirSync(path.dirname(base), { recursive: true });
        fs.mkdirSync(path.dirname(preset), { recursive: true });
        fs.writeFileSync(base, "# fixture：这一段被官方改掉了\n", "utf8");
        fs.writeFileSync(preset, "# fixture：身份句被官方改掉了\n", "utf8");
        const status = await core.patchStatus(dir);
        assert.equal(status[7], "drifted", "普通补丁缺原文 → drifted（软）");
        assert.equal(status[43], "unmatched", "必需补丁（#43）缺原文仍走硬词，不能降成 drifted");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  } finally {
    if (saved === undefined) delete process.env.DSH_SURFACE;
    else process.env.DSH_SURFACE = saved;
  }
});

test("接线：桌面退出留痕必须接在生产路径上（拔掉任何一处都要红）", () => {
  // 写：补丁表里的留痕片段落在 close 回调上（#90），且排在 #83/#84 之后应用。
  const patches = core.ALL_PATCHES;
  const indexOf = (id) => patches.findIndex((item) => item.id === id);
  assert.ok(indexOf(90) > indexOf(83) && indexOf(90) > indexOf(84), "#90 必须排在整块改写 close 回调的 #83/#84 之后");
  // 读：gatherState 必须真的去读留痕文件，renderStatus 必须真的把它写出来。
  const gather = executableBody(coreSrc);
  assert.match(gather, /desktop_exit: readLatestDesktopExit/, "gatherState 必须带出最近一次桌面退出");
  assert.ok(gather.includes("readLatestDesktopExit({ home: dshHome })"), "读侧必须读隔离 DSH_HOME 那一份留痕");
  const indexSrc = readFileSync(path.join(repoRoot, "lib", "index.js"), "utf8");
  assert.match(indexSrc, /describeDesktopExit\(state\.desktop_exit\)/, "purge_status 必须渲染最近一次桌面退出");
  // 证明：入口五必须跑 harness，且拔痕对照必须拔的是 close 回调里那一段。
  const targetSrc = readFileSync(path.join(repoRoot, "lib", "verify", "target-entry.js"), "utf8");
  assert.match(targetSrc, /proveExitTrace\(\{/, "入口五必须调用留痕证明");
  const okBlocks = [...targetSrc.matchAll(/record\.ok = Boolean\(([\s\S]*?)\);/g)];
  const entryOk = okBlocks.find((item) => item[1].includes("runtime.completePrompt.ok"));
  assert.ok(entryOk, "入口五的 record.ok 计算必须还在");
  assert.match(entryOk[1], /runtime\.exitTrace\.ok/, "留痕证明失败必须让入口五变红");
  const exitSrc = readFileSync(path.join(repoRoot, "lib", "verify", "exit-trace.js"), "utf8");
  const strip = /const stripped = stripExitTrace\(body\);/.exec(exitSrc);
  assert.ok(strip, "对照必须从 close 回调体里摘掉生产路径上的那一段，而不是直调写入器");
});

test("接线：test:unit 必须覆盖除真宿主电池外的每个测试文件（清单不得静默变短）", () => {
  // 2026-11-03 retro：test:unit 长期只列 3 个文件，新增的 tests/lib/* 一个都不在里面，
  // 信它就会得到假绿。清单本身要有一条机械断言，否则它会继续漂。
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const script = String(pkg.scripts["test:unit"] || "");
  const HOST_BATTERY = new Set(["tests/verify/host-admin.test.js"]);
  const all = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.js")) all.push(path.relative(repoRoot, full).split(path.sep).join("/"));
    }
  };
  walk(path.join(repoRoot, "tests"));
  assert.ok(all.length >= 20, "tests/ 下应当有二十多个测试文件，文件枚举失效会让这条退化成空跑");
  const missing = all.filter((rel) => !HOST_BATTERY.has(rel) && !script.includes(rel));
  assert.deepEqual(missing, [], "这些测试只在 test:ci 里跑，test:unit 的清单漏了它们：" + missing.join(", "));
});

test("接线：宿主内联的留痕上界必须与 exit-ledger 的常量同口径（改上限只改一处）", () => {
  // 宿主 main.js 不能 import 插件，所以 #91 这段是内联副本；常量漂了要在单测里当场红。
  const code = DESKTOP_EXIT_TRACE_SOURCES_CODE;
  assert.equal((code.match(/lines = lines\.slice\(-/g) || []).length, 1, "内联副本只留一处条数上界");
  assert.ok(code.includes("lines = lines.slice(-" + EXIT_LEDGER_MAX_ENTRIES + ")"), "条数上界必须等于 EXIT_LEDGER_MAX_ENTRIES(" + EXIT_LEDGER_MAX_ENTRIES + ")");
  assert.ok(code.includes("Buffer.byteLength(") && code.includes("> " + EXIT_LEDGER_MAX_BYTES + ")"), "字节上界必须按 UTF-8（Buffer.byteLength）等于 EXIT_LEDGER_MAX_BYTES(" + EXIT_LEDGER_MAX_BYTES + ")");
  assert.equal((code.match(/dshPurgeExitEpisode/g) || []).length >= 3, true, "episode 合并规则必须在宿主内联副本里");
  assert.ok(code.includes('"render-crash"') && code.includes('"uncaught"'), "来源词表必须写进宿主副本");

  // #90 只保留 close 的接线：两段签名各接一次共享写入器，不再各带一份滚动实现。
  const closePatch = core.ALL_PATCHES.find((item) => item.id === 90);
  assert.ok(closePatch, "找不到补丁 #90");
  assert.deepEqual(closePatch.markers, [EXIT_TRACE_CLOSE_MARKER], "#90 的标记必须换成共享调用");
  const callReplacements = closePatch.replacements.filter((item) => String(item.replace).includes("dshPurgeRecordExit(\"close\""));
  assert.equal(callReplacements.length, 3, "旧块迁移 + 两种 close 回调签名各一条调用");
  assert.equal(closePatch.replacements.filter((item) => String(item.pattern).includes('child.once("close"')).length, 2, "只钉 close 回调的两条签名");
  assert.equal(callReplacements.every((item) => String(item.replace).includes("desktop exit trace never blocks exit")), true, "每条调用都带不挡退出的兜底 catch");

  // #91 必须排在 #90 之前：先有模块作用域写入器，close 才接得上。
  const ids = core.ALL_PATCHES.map((item) => item.id);
  assert.ok(ids.indexOf(91) > ids.indexOf(84), "#91 必须排在改写 close 回调的 #84 之后");
  assert.ok(ids.indexOf(91) < ids.indexOf(90), "#91 必须排在 #90 之前（写入器先落地）");
  const sourcesPatch = core.ALL_PATCHES.find((item) => item.id === 91);
  assert.deepEqual(sourcesPatch.markers, [EXIT_TRACE_SOURCES_BEGIN], "#91 的标记必须是多来源块起点");
});

test("接线：core 的 apply/status 依赖的模型函数确实可调用", () => {
  for (const name of ["asLf", "isYamlPath", "filePatchSettled", "filePatchOutcome", "patchHasRemainingWork", "rollupPatchStatus", "resultSoftOk", "readyStatus", "observe", "missingAnchors", "isSelfMarkedPatch"]) {
    assert.equal(typeof model[name], "function", "patch-model 应该导出 " + name);
  }
});

test("接线：A7 三条换包路径都必须先 main、确认消失、再挪 asar，失败时拉起原版", () => {
  const desktopSrc = readFileSync(path.join(repoRoot, "lib", "desktop.js"), "utf8");
  const ps1 = desktopSrc.slice(desktopSrc.indexOf("const ASAR_SWAP_PS1 = ["), desktopSrc.indexOf("const ASAR_RENAME_WHEN_IDLE_PS1 = ["));
  const wscript = desktopSrc.slice(desktopSrc.indexOf("function officialRestartScript("), desktopSrc.indexOf("function systemPromptFiles("));

  // wscript：mainPids 的等待/全清必须早于 MoveFile，失败分支必须重新拉起原版。
  assert.ok(wscript.indexOf("var mains = mainPids();") >= 0, "wscript 必须显式找 main");
  assert.ok(wscript.indexOf("var mains = mainPids();") < wscript.indexOf("fso.MoveFile(asar, bak)"), "wscript 必须在挪 asar 前处理 main");
  assert.ok(wscript.indexOf("main left") < wscript.indexOf("fso.MoveFile(asar, bak)"), "wscript 必须在挪 asar 前确认 main 消失");
  assert.ok(wscript.includes("rename failed; relaunching original"), "wscript 的失败分支必须拉起原版");
  assert.match(wscript, /sh\.Run\('\\"' \+ exe \+ '\\"', 1, false\)/, "wscript 的失败分支必须真的启动 exe");
  assert.equal((wscript.match(/sh\.Run\(/g) || []).length >= 3, true, "wscript 的失败/成功两条启动路径都要在");

  // PowerShell：先 main，确认全清，再挪；Move-Item 必须让 catch 真正可到达。
  assert.ok(ps1.indexOf("Get-MainProcs") >= 0, "PS1 必须显式找 main");
  assert.ok(ps1.indexOf("Get-MainProcs") < ps1.indexOf("Move-Item -LiteralPath $AsarPath"), "PS1 必须在挪 asar 前处理 main");
  assert.ok(ps1.includes("Move-Item -LiteralPath $AsarPath -Destination $bak -Force -ErrorAction Stop"), "PS1 的 Move-Item 必须 -ErrorAction Stop，否则失败分支永远走不到");
  assert.equal((ps1.match(/Start-Process -FilePath \$ExePath/g) || []).length, 2, "PS1 的成功与失败分支都要启动 exe（失败=原版）");
  assert.ok(ps1.includes("挪不动 / 进程没退干净"), "PS1 的失败分支要说明原版还在原位");

  // helper：杀完 main 要等桌面消失；失败分支从 not relaunching 改成 relaunch original。
  const helperSrc = readFileSync(path.join(repoRoot, "lib", "restart-desktop.js"), "utf8");
  assert.ok(helperSrc.indexOf("waitDesktopGone(info.execPath, 8000)") >= 0, "helper 杀完 main 必须确认桌面消失");
  assert.ok(helperSrc.indexOf("waitDesktopGone(info.execPath, 8000)") < helperSrc.indexOf("releaseSealedAsar(info.asar"), "确认消失必须早于挪 asar");
  assert.ok(helperSrc.includes("asar still sealed; relaunching original"), "helper 的失败分支必须拉起原版");
  assert.equal(helperSrc.includes("asar still sealed; not relaunching"), false, "helper 不能再留 not relaunching");
});
