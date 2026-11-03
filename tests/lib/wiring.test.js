import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "../../lib/core.js";
import * as model from "../../lib/patch-model.js";

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
  const logic = dataStart >= 0 && dataEnd > dataStart ? src.slice(0, dataStart) + src.slice(dataEnd) : src;
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

test("接线：core 的公开面仍然保留旧的导出名（verify 与老调用点靠它）", () => {
  for (const name of [
    "patchOwnMarkPresent",
    "patchEffectState",
    "isLayoutSoftPatch",
    "applyReplacementsToText",
    "collapseDuplicateLegacyApplyPath",
    "yamlJsCommentsToHash",
  ]) {
    assert.equal(typeof core[name], "function", "core 应该继续导出 " + name);
  }
});

test("接线：core 的 apply/status 依赖的模型函数确实可调用", () => {
  for (const name of ["asLf", "isYamlPath", "filePatchSettled", "filePatchOutcome", "patchHasRemainingWork", "rollupPatchStatus", "resultSoftOk", "readyStatus", "observe"]) {
    assert.equal(typeof model[name], "function", "patch-model 应该导出 " + name);
  }
});
