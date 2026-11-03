import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ALL_PATCHES, applyReplacementsToText, isLayoutSoftPatch, isSelfMarkedPatch, missingAnchors, patchEffectState, presetToolWebFetchEnabled } from "../../lib/core.js";
import { auditTargetStatus, inspectPatchTargets, searchedPathsFor } from "../../lib/verify/targets.js";
import { extractCloseHandler, runCloseHandler } from "../../lib/verify/target-entry.js";
import { tempDir } from "./helpers.js";

/**
 * 目标定位与适配状态（#6）。
 *
 * 这里固定的是「当前宿主（0.2.1-rc.5）的等价表达形式」：
 * 补丁必须认出它、改出来的结果必须与基线同义，并且重复应用不再追加内容。
 */

const TAB = String.fromCharCode(9);
const pad = (n) => TAB.repeat(n);

function patchOf(id) {
  const patch = ALL_PATCHES.find((item) => item.id === id);
  assert.ok(patch, "找不到补丁 #" + id);
  return patch;
}

/** 0.2.1-rc.5 的 close 回调：不收 signal，把 null 并进同一个 if。 */
const RC5_CLOSE = [
  pad(2) + 'child.once("close", (code) => {',
  pad(3) + 'const suffix = this.stderr.trim() === "" ? "" : `: ${this.stderr.trim()}`;',
  pad(4) + "if (code !== 0 && code !== null) this.fail(/* @__PURE__ */ new Error(`dsh desktop host exited with ${String(code)}${suffix}`));",
  pad(4) + "else this.fail(/* @__PURE__ */ new Error(`dsh desktop host stopped${suffix}`));",
  pad(4) + "resolve();",
  pad(2) + "});",
].join("\n");

/** 旧形态（0.1.x）：close 回调收 signal，先单独处理 null/signal。 */
const LEGACY_CLOSE = [
  pad(2) + 'child.once("close", (code, signal) => {',
  pad(3) + 'const suffix = this.stderr.trim() === "" ? "" : `: ${this.stderr.trim()}`;',
  pad(4) + "if (code === null || signal) { resolve(); return; }",
  pad(4) + "if (code !== 0) this.fail(/* @__PURE__ */ new Error(`dsh desktop host exited with ${String(code)}${suffix}`));",
  pad(4) + "else this.fail(/* @__PURE__ */ new Error(`dsh desktop host stopped${suffix}`));",
  pad(4) + "resolve();",
  pad(2) + "});",
].join("\n");

/** 0.2.1-rc.5 的 assemble：complete 分支前多了 requiredContexts 过滤。 */
const RC5_ASSEMBLE = [
  pad(2) + 'const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));',
  pad(2) + "if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;",
  pad(2) + "const requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));",
  pad(2) + "return {",
  pad(3) + "...transformed,",
  pad(3) + "sections: completeSection === void 0 ? transformed.sections : [completeSection],",
  pad(3) + "contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts",
  pad(2) + "};",
].join("\n");

test("桌面壳 close 回调：rc.5 的等价形式被认出，code=0 不再 fail", () => {
  const patch = patchOf(84);
  const first = applyReplacementsToText(RC5_CLOSE, patch, "main.js");
  assert.equal(first.changed, true, "rc.5 形式的 close 回调必须被识别");
  assert.ok(first.text.includes("[dsh-purge] close no-fail v2"), "要留下标记");
  assert.ok(!first.text.includes("dsh desktop host stopped"), "code=0 的 stopped 分支必须去掉");
  assert.equal(patchEffectState(first.text, patch), "applied");

  const body = extractCloseHandler(first.text);
  assert.ok(body.length > 0, "要能取出 close 回调");
  const clean = runCloseHandler(body, 0);
  assert.deepEqual(clean.failed, [], "code=0 不得报错");
  assert.equal(clean.resolved, true);
  const real = runCloseHandler(body, 3);
  assert.equal(real.failed.length, 1, "真正非 0 退出仍要报错");

  const again = applyReplacementsToText(first.text, patch, "main.js");
  assert.equal(again.changed, false, "重复应用不得再改");
});

test("桌面壳 close 回调：旧形态仍然按基线处理（对照案例不被新匹配挤掉）", () => {
  const patch = patchOf(84);
  const applied = applyReplacementsToText(LEGACY_CLOSE, patch, "main.js");
  assert.equal(applied.changed, true);
  assert.ok(applied.text.includes("if (code === null || signal) { resolve(); return; }"), "旧的 null/signal 分支要保留");
  assert.ok(!applied.text.includes("dsh desktop host stopped"));
  const body = extractCloseHandler(applied.text);
  assert.equal(runCloseHandler(body, 0).failed.length, 0);
});

test("完整提示词：rc.5 分支被认出，且 required 上下文过滤不被替换掉", () => {
  const patch = patchOf(40);
  const first = applyReplacementsToText(RC5_ASSEMBLE, patch, "index.js");
  assert.equal(first.changed, true, "rc.5 的 assemble 分支必须被识别");
  assert.ok(first.text.includes("[dsh-purge] complete prompt keeps inject"), "complete 分支要保留注入段");
  assert.ok(
    first.text.includes("contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts"),
    "requiredContexts 过滤属于当前宿主语义，必须原样保留",
  );
  assert.equal(patchEffectState(first.text, patch), "applied");
  assert.equal(applyReplacementsToText(first.text, patch, "index.js").changed, false, "重复应用不得再改");
});

test("preset fetch：只看 tool-web 这一块的 fetch，官方已有的值算目标态，别处的不算", () => {
  const indented = (fetch) => [
    "- insert:",
    "    - id: preset-standard",
    "      config:",
    "          - id: tool-web",
    "            name: '@deepseek-ai/dsh-tool-web'",
    "            config:",
    "              fetch: " + fetch,
    "              searchTimeoutMs: 60000",
    "          - id: present",
    "            name: '@deepseek-ai/dsh-tool-present'",
    "              fetch: true",
  ].join("\n");

  assert.equal(presetToolWebFetchEnabled(indented("true")), true);
  assert.equal(presetToolWebFetchEnabled(indented("false")), false, "同块里关着时不能算已开");
  assert.equal(
    presetToolWebFetchEnabled([
      "          - id: tool-web",
      "            name: '@deepseek-ai/dsh-tool-web'",
      "            config:",
      "              fetch: false",
      "          - id: other",
      "            fetch: true",
    ].join("\n")),
    false,
    "块外/别的行的 fetch: true 不能当成目标态",
  );

  const patch = patchOf(24);
  assert.equal(patchEffectState(indented("true"), patch, "preset.yml"), "applied");
  assert.equal(patchEffectState(indented("false"), patch, "preset.yml"), "pending");
  assert.ok(!(patch.markers || []).includes("fetch: true"), "通用字符串不能再当完成标记");

  const applied = applyReplacementsToText(indented("false"), patch, "preset.yml");
  assert.equal(applied.changed, true, "rc.5 缩进下的 fetch: false 也要能打开");
  assert.ok(applied.text.includes("[dsh-purge] preset fetch enabled"));
  assert.equal(applyReplacementsToText(applied.text, patch, "preset.yml").changed, false);
});

test("目标定位：缺席的键给出搜索过的位置，不混进失败", () => {
  const searched = searchedPathsFor("hooks-claude-code", { aiBase: "D:/fixture/@deepseek-ai" });
  assert.ok(searched.length > 0);
  assert.ok(searched.every((item) => item.includes("dsh-hooks-claude-code")));

  const dir = tempDir("targets-");
  const present = path.join(dir, "present.js");
  fs.writeFileSync(present, "official text" + "\n", "utf8");
  try {
    const core = {
      ALL_PATCHES: [
        { id: 901, name: "MISSING_TARGET", file: "hooks-codex", markers: ["x"] },
        { id: 902, name: "PRESENT_TARGET", file: "present", markers: ["x"] },
      ],
      patchAppliesHere: () => true,
      fileKeysOf: (patch) => (Array.isArray(patch.file) ? patch.file : [patch.file]),
      targetFiles: () => ({ present }),
      observe: () => ({ state: "foreign", ownMark: false }),
      effectOf: () => "unmatched",
      isLayoutSoftPatch: () => false,
      isSelfMarkedPatch: () => false,
      missingAnchors: () => [],
    };
    const inspected = inspectPatchTargets({ core, aiBase: dir, dshHome: dir });
    const missing = inspected.rows.find((row) => row.id === 901);
    const unmatched = inspected.rows.find((row) => row.id === 902);
    assert.equal(missing.evidence, "not-applicable");
    assert.ok(missing.targets[0].searched.length > 0, "不适用条目必须带搜索位置");
    assert.equal(unmatched.evidence, "unmatched");
    assert.equal(inspected.summary["not-applicable"], 1);
    assert.equal(inspected.notApplicable[0].id, 901);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("目标定位：副本里没有的键可以按同源文件核对（桌面壳入口）", () => {
  const dir = tempDir("targets-extra-");
  const file = path.join(dir, "main.js");
  fs.writeFileSync(file, "patched // [dsh-purge] marker" + "\n", "utf8");
  try {
    const core = {
      ALL_PATCHES: [{ id: 903, name: "SHELL", file: "desktop-shell", markers: ["[dsh-purge] marker"] }],
      patchAppliesHere: () => true,
      fileKeysOf: (patch) => (Array.isArray(patch.file) ? patch.file : [patch.file]),
      targetFiles: () => ({}),
      observe: () => ({ state: "foreign", ownMark: false }),
      effectOf: () => "unmatched",
      isLayoutSoftPatch: () => false,
      isSelfMarkedPatch: () => false,
      missingAnchors: () => [],
    };
    const without = inspectPatchTargets({ core, aiBase: dir, dshHome: dir });
    assert.equal(without.rows[0].evidence, "not-applicable");
    const withExtra = inspectPatchTargets({ core, aiBase: dir, dshHome: dir, extraTargets: { "desktop-shell": [file] } });
    assert.equal(withExtra.rows[0].evidence, "unmatched", "有同源文件后按文件事实判定，不再算不适用");
    assert.equal(withExtra.rows[0].targets[0].path, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("适配状态：状态说成功但文件里没有事实，按假成功报出来", () => {
  const rows = [
    { id: 1, name: "A", evidence: "unmatched", targets: [{ key: "a" }] },
    { id: 2, name: "B", evidence: "unmatched", targets: [{ key: "b" }] },
    { id: 3, name: "C", evidence: "pending", targets: [{ key: "c" }] },
  ];
  const audit = auditTargetStatus({ rows, status: { 1: "applied", 2: "already", 3: "applied" }, softIds: [2] });
  assert.deepEqual(audit.falseSuccess.map((item) => item.id), [1]);
  assert.deepEqual(audit.settledByLayout.map((item) => item.id), [2]);
  assert.deepEqual(audit.ahead.map((item) => item.id), [3]);
  assert.ok(isLayoutSoftPatch(patchOf(4)) && isLayoutSoftPatch(patchOf(5)), "身份句/审批句属于布局软补丁");
});
test("适配状态：原文对不上、也没写过 → 漂移清单带锚点；布局软不混进来（A2）", () => {
  const dir = tempDir("targets-drift-");
  const file = path.join(dir, "drift.js");
  fs.writeFileSync(file, "宿主改成别的写法" + "\n", "utf8");
  try {
    const core = {
      ALL_PATCHES: [
        { id: 904, name: "DRIFT", file: "present", replacements: [{ pattern: "official anchor", replace: "patched" }], markers: ["patched"] },
        { id: 905, name: "LAYOUT", file: "present", replacements: [{ pattern: "another anchor", replace: "x" }] },
      ],
      patchAppliesHere: () => true,
      fileKeysOf: (patch) => [patch.file],
      targetFiles: () => ({ present: file }),
      observe: () => ({ state: "foreign", ownMark: false }),
      effectOf: () => "unmatched",
      // 用真实实现，不在 stub 里自造 head —— 否则断言的是测试自己的 fixture（CODING_STANDARDS #6）。
      missingAnchors: (text, patch, fp) => missingAnchors(text, patch, fp),
      isLayoutSoftPatch: (patch) => patch.id === 905,
      isSelfMarkedPatch: (patch) => isSelfMarkedPatch(patch),
    };
    const inspected = inspectPatchTargets({ core, aiBase: dir, dshHome: dir });
    assert.deepEqual(inspected.drifted.map((row) => row.id), [904], "布局软补丁按设计可能本来就没这句，不进漂移清单");
    assert.equal(inspected.drifted[0].keys[0].path, file, "漂移项要指到具体文件");
    assert.equal(inspected.drifted[0].keys[0].anchors[0].head, "official anchor", "漂移项要带没命中的锚点");
    assert.equal(inspected.rows.find((row) => row.id === 905).layoutSoft, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("适配状态：自标记型补丁找不到痕迹不算漂移（与 patchStatus 的 skipped 对齐）", () => {
  const dir = tempDir("targets-selfmark-");
  const file = path.join(dir, "trace.js");
  fs.writeFileSync(file, "宿主原文" + "\n", "utf8");
  try {
    const core = {
      ALL_PATCHES: [{ id: 906, name: "UNDO", file: "present", replacements: [{ pattern: "x // [dsh-purge] marker", replace: "x" }] }],
      patchAppliesHere: () => true,
      fileKeysOf: (patch) => [patch.file],
      targetFiles: () => ({ present: file }),
      observe: () => ({ state: "foreign", ownMark: false }),
      effectOf: () => "unmatched",
      missingAnchors: (text, patch, fp) => missingAnchors(text, patch, fp),
      isLayoutSoftPatch: () => false,
      isSelfMarkedPatch: (patch) => isSelfMarkedPatch(patch),
    };
    const inspected = inspectPatchTargets({ core, aiBase: dir, dshHome: dir });
    assert.equal(inspected.rows[0].selfMarked, true, "pattern 全是本插件痕迹 → 自标记型");
    assert.deepEqual(inspected.drifted, [], "本来就没写过，不进漂移清单");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});