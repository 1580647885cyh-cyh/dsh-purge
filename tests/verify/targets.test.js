import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ALL_PATCHES, applyReplacementsToText, isLayoutSoftPatch, isSelfMarkedPatch, missingAnchors, patchEffectState, presetToolWebFetchEnabled, targetFiles } from "../../lib/core.js";
import { auditTargetStatus, fixtureKeyGaps, inspectPatchTargets, searchedPathsFor } from "../../lib/verify/targets.js";
import { extractCloseHandler, runCloseHandler } from "../../lib/verify/exit-trace.js";
import { LEGACY_CLOSE, RC5_CLOSE } from "./desktop-close-fixture.js";
import { tempDir } from "./helpers.js";
import { HOST_TEXT_FIXTURES } from "./host-text-fixtures.js";

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

test("桌面退出留痕：未打补丁的 close 回调报 pending，应用后落一条留痕调用且不叠加", () => {
  const patch = patchOf(90);
  assert.equal(patchEffectState(RC5_CLOSE, patch), "pending", "宿主原文还在时必须报 pending，不能一上来就 drifted");

  const applied = applyReplacementsToText(RC5_CLOSE, patch, "main.js");
  assert.equal(applied.changed, true, "rc.5 的 close 回调必须被认出");
  const text = applied.text;
  assert.ok(text.includes("[dsh-purge] desktop exit trace"), "要留下我们的标记");
  assert.ok(text.includes("exit-ledger.jsonl"), "落点必须是 DSH_HOME/dsh-purge 下的留痕文件");
  assert.ok(text.includes('source: "close"'), "来源词要写死在记录里");
  assert.equal(patchEffectState(text, patch), "applied");
  assert.equal(applyReplacementsToText(text, patch, "main.js").changed, false, "重复应用不得叠加第二份留痕");

  // 留痕必须在两条早退/失败分支之前：signal 分支 return 掉之后就没有下一句了。
  const traceAt = text.indexOf("[dsh-purge] desktop exit trace");
  const failAt = text.indexOf("this.fail(");
  const signalAt = text.indexOf("if (code === null || signal)");
  assert.ok(traceAt > 0 && failAt > traceAt, "留痕必须落在 fail 之前");
  assert.ok(signalAt < 0 || signalAt > traceAt, "留痕必须落在 signal 早退之前");

  // 旧形态（收 signal 的 0.1.x close 回调）同样能落留痕。
  const legacy = applyReplacementsToText(LEGACY_CLOSE, patch, "main.js");
  assert.equal(legacy.changed, true, "旧形态也要能落留痕");
  assert.ok(legacy.text.indexOf("[dsh-purge] desktop exit trace") < legacy.text.indexOf("if (code === null || signal)"));
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

test("隔离副本漏包检查：真机解析得到、副本里解析不到的键要被点出来（#21 复盘）", () => {
  // 故障对照：FIXTURE_PACKAGES 漏了 dsh-harness-dev-context 时，dev-context 在真机解析得到、
  // 副本里没有；这一条必须把它点出来，而不是让整轮 verify 保持绿色。
  assert.deepEqual(
    fixtureKeyGaps(["dev-context", "desktop-shell", "hooks-codex"], ["hooks-codex"], ["desktop-shell"]),
    ["dev-context"],
    "漏包的键要被点出来；桌面壳是显式例外",
  );
  assert.deepEqual(fixtureKeyGaps(["hooks-codex"], ["hooks-codex"], ["desktop-shell"]), [], "两边都在就不报");
  assert.deepEqual(fixtureKeyGaps([], [], ["desktop-shell"]), [], "真机什么都没解析到时不该凭空造告警");
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
/**
 * rc.5 的 dsh-harness-dev-context/lib/index.js：真正来自宿主的那几段从 host-text-fixtures 取
 * （那里的每一条都由 host-text-fixtures.test.js 回真机核对子串），这里只拼装成一份最小文件。
 *
 * 中间那几行（HARNESS_SOURCE_PROMPT / 对象括号 / apply 骨架）是**胶水**，不是宿主原文，
 * 只为了让窗口锚点周围有同形的邻句：checkout 那句与身份句长得像，用来证明窗口不跨语句。
 */
const RC5 = HOST_TEXT_FIXTURES.find((entry) => entry.id === "dev-context").texts;
const RC5_DEV_CONTEXT = [
  RC5.webSurfacePrompt,
  "const HARNESS_SOURCE_PROMPT = `The runtime context names the DeepSeek Harness implementation checkout.`;",
  "const LEGACY_SOURCE = {",
  RC5.legacySourcePrefix,
  RC5.legacySourceSuffix,
  "};",
  "const LEGACY_WEB_SURFACE = {",
  RC5.legacyWebSurfacePrefix,
  RC5.legacyWebSurfaceSuffix,
  "};",
  "const LEGACY_PROMPT = \"harnessDevLegacyPrompt\";",
  "function apply(ctx) {",
  "\tctx.systemPrompt.context({",
  RC5.contextCheckout,
  "\t});",
  "\tctx.systemPrompt.context({",
  RC5.contextUrl,
  "\t});",
  "}",
].join("\n");

/** LEGACY_WEB_SURFACE 那一段：宿主冻结的旧文案，任何补丁都不许动它。 */
function legacyBlock(text) {
  const start = text.indexOf("const LEGACY_WEB_SURFACE");
  const end = text.indexOf("};", start);
  return start < 0 || end < 0 ? "" : text.slice(start, end + 2);
}

function countOf(text, needle) {
  return text.split(needle).length - 1;
}

test("web 身份句：rc.5 的掉包落点由窗口锚点认出，重复应用不再追加（#21）", () => {
  const identity = patchOf(32);
  const prohibition = patchOf(53);
  assert.deepEqual(identity.file, ["dev-context"], "#32 必须改指 rc.5 的落点");
  assert.deepEqual(prohibition.file, ["dev-context"], "#53 必须改指 rc.5 的落点");

  const legacyBefore = legacyBlock(RC5_DEV_CONTEXT);
  assert.ok(legacyBefore.length > 0, "fixture 必须带 LEGACY_WEB_SURFACE，否则「不许动它」无从证明");

  const first = applyReplacementsToText(RC5_DEV_CONTEXT, identity, "index.js");
  assert.equal(first.changed, true, "身份句必须被认出（旧的整句写法在 rc.5 一次都命中不了）");
  assert.ok(first.text.includes("through the local Web GUI whose URL the runtime context names."), "产品名换成 local，句尾原样搬回");
  assert.equal(first.text.includes("DeepSeek Harness Web GUI whose URL"), false, "产品名不许留在身份句里");
  assert.ok(first.text.includes("[dsh-purge] web surface identity neutralized"), "要留下标记");
  assert.ok(first.text.includes("Current local Web GUI URL: "), "URL 描述那句同样去掉产品名");
  assert.equal(countOf(first.text, "[dsh-purge] web surface identity neutralized"), 2, "两条锚点各自留标记：只命中一条时也看得见");
  assert.ok(first.text.includes("Current DeepSeek Harness implementation checkout"), "checkout 那句不是身份句，不许被顺手改掉");
  assert.equal(patchEffectState(first.text, identity), "applied");
  assert.equal(applyReplacementsToText(first.text, identity, "index.js").changed, false, "重复应用不得再改");

  const second = applyReplacementsToText(first.text, prohibition, "index.js");
  assert.equal(second.changed, true, "#53 要在 #32 之后仍然认得出这两句");
  assert.ok(second.text.includes("[dsh-purge] web surface identity sentence dropped"), "要留下自己的标记");
  assert.equal(countOf(second.text, "You are interacting with the user through"), 1, "当前提示词的身份句删掉，冻结的 legacy 前缀必须还在");
  assert.equal(countOf(second.text, "Do not start a replacement server"), 1, "禁止另开服务器那句只在当前提示词里删，legacy 那份必须还在");
  assert.equal(countOf(second.text, "DeepSeek Harness Web GUI"), 1, "产品名只剩 LEGACY_WEB_SURFACE 前缀里那一处");
  assert.equal(legacyBlock(second.text), legacyBefore, "LEGACY_WEB_SURFACE 一个字节都不许动");
  assert.equal(patchEffectState(second.text, prohibition), "applied");
  assert.equal(applyReplacementsToText(second.text, prohibition, "index.js").changed, false, "重复应用不得再删");
  // 两条补丁的顺序表里 #32 在前；但 #53 的锚点钉的是宿主声明行，不依赖 #32 先跑。
  // 两者都跑完时 #32 改名的那句已被 #53 整句删掉，它自己的标记还在行尾 —— 这是「更强的目标态」，
  // 不是假成功：最终文件里产品名一处不剩，两条补丁各自的标记各记各的一步。
  const soloProhibition = applyReplacementsToText(RC5_DEV_CONTEXT, prohibition, "index.js");
  assert.equal(soloProhibition.changed, true, "#53 单独应用也必须命中（不存在隐式的先后约定）");
  assert.equal(countOf(soloProhibition.text, "Do not start a replacement server"), 1);
  assert.equal(patchEffectState(second.text, identity), "applied", "跑完两步后 #32 的标记仍在（它记录的是「改写跑过」）");
});

test("窗口有界：宿主把句尾改写/换引号时宁可失配，也不吃掉正文（#21）", () => {
  const identity = patchOf(32);
  const prohibition = patchOf(53);

  // ① 句尾被拉长：#53 的右界钉住下一句开头，只删到 "…reflects it. " 为止，正文一句不少。
  const stretched = RC5_DEV_CONTEXT.replace(
    "whose URL the runtime context names.",
    "whose URL the runtime context names, and the browser reflects it.",
  );
  const stretchedOut = applyReplacementsToText(stretched, prohibition, "index.js");
  assert.equal(stretchedOut.changed, true, "长一点的同一句仍然认得出");
  assert.equal(countOf(stretchedOut.text, "When the user refers to"), 2, "正文两句都还在（当前提示词 + legacy）");
  assert.equal(countOf(stretchedOut.text, "You are interacting with the user through"), 1, "整句 delete 的只有身份句");

  // ② 句号被吃掉（宿主把两句连写）：右界对不上 → 宁可失配，也不把正文一起删掉。
  const noPeriod = RC5_DEV_CONTEXT.replace("names. When", "names When");
  const noPeriodOut = applyReplacementsToText(noPeriod, prohibition, "index.js");
  assert.equal(countOf(noPeriodOut.text, "When the user refers to"), 2, "正文不许被窗口吃掉");

  // ③ 上下文行换成普通字符串（没有反引号边界）：#32 两条锚点都失配，而不是跨语句吞掉 checkout 那行。
  const plainStrings = RC5_DEV_CONTEXT
    .replace("text: `Current DeepSeek Harness implementation checkout: ${JSON.stringify(SOURCE_ROOT)}.`", "text: \"Current DeepSeek Harness implementation checkout: \" + JSON.stringify(SOURCE_ROOT)")
    .replace("text: () => `Current DeepSeek Harness Web GUI URL: ${JSON.stringify(ctx.webApp.getAdvertisedUrl())}.`", "text: () => \"Current DeepSeek Harness Web GUI URL: \" + JSON.stringify(ctx.webApp.getAdvertisedUrl())");
  assert.notEqual(plainStrings, RC5_DEV_CONTEXT, "fixture 必须真的换成了普通字符串");
  const plainOut = applyReplacementsToText(plainStrings, identity, "index.js");
  assert.equal(plainOut.text.includes("Current DeepSeek Harness implementation checkout"), true, "checkout 那行不许被吃掉");
  assert.equal(plainOut.text.includes("Current DeepSeek Harness Web GUI URL"), true, "普通字符串形态认不出就保持原样（失配进漂移，不是改错）");
});

test("故障对照：把锚点改回旧 web-app-lib 写法，这一组必须红（#21）", () => {
  // 旧 #32：整句写死 + 指向 web-app-lib。rc.5 里那句早就不长这样了。
  const oldIdentity = {
    ...patchOf(32),
    file: ["web-app-lib"],
    replacements: [
      {
        pattern: "You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}.",
        replace: "You are interacting with the user through the local web GUI at ${webUrl}.",
      },
      {
        pattern: 'description: "Canonical local URL of the DeepSeek Harness Web GUI serving this session."',
        replace: 'description: "Canonical local URL of the web GUI serving this session." /* [dsh-purge] web surface identity neutralized */',
      },
    ],
    markersAny: true,
    markers: ["[dsh-purge] web surface identity neutralized", "through the local web GUI at ${webUrl}."],
  };
  assert.deepEqual(oldIdentity.file, ["web-app-lib"]);
  assert.equal(applyReplacementsToText(RC5_DEV_CONTEXT, oldIdentity, "index.js").changed, false, "旧整句锚点在 rc.5 命中不了——这就是 #21 的故障现象");
  assert.equal(patchEffectState(RC5_DEV_CONTEXT, oldIdentity, "index.js"), "unmatched");

  // 旧 #53 的第二句仍然字面存在，但它不认边界：会把 LEGACY 里冻结的那份一起删掉。
  const oldProhibition = {
    ...patchOf(53),
    file: ["web-app-lib"],
    replacements: [
      { pattern: "You are interacting with the user through the local web GUI at ${webUrl}.", replace: "Local web GUI: ${webUrl}. // [dsh-purge] web surface identity neutralized" },
      { pattern: "Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.", replace: "" },
    ],
    markersAny: true,
    markers: ["[dsh-purge] web surface identity neutralized", "Local web GUI: ${webUrl}."],
  };
  const legacyBefore = legacyBlock(RC5_DEV_CONTEXT);
  const changed = applyReplacementsToText(RC5_DEV_CONTEXT, oldProhibition, "index.js");
  assert.equal(changed.changed, true, "旧字面锚点仍然命中——所以它必须被故障对照钉住");
  assert.notEqual(legacyBlock(changed.text), legacyBefore, "旧锚点把 LEGACY 里冻结的那份也删了：这正是要窗口里排除边界的原因");
});

test("目标定位：dev-context 键覆盖桌面布局、npm 嵌套与源码仓库（#21）", () => {
  const dirs = [];
  try {
    // 桌面布局：<aiBase>/dsh-harness-dev-context/lib/index.js
    const flatRoot = tempDir("dev-context-flat-");
    dirs.push(flatRoot);
    const flatBase = path.join(flatRoot, "node_modules", "@deepseek-ai");
    const flat = path.join(flatBase, "dsh-harness-dev-context", "lib", "index.js");
    fs.mkdirSync(path.dirname(flat), { recursive: true });
    fs.writeFileSync(flat, "// flat\n", "utf8");
    assert.equal(targetFiles(flatBase, path.join(flatRoot, "home"))["dev-context"], flat, "桌面布局要解析到包内的 lib/index.js");

    // npm 嵌套布局：<aiBase>/dsh/node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js
    const nestedRoot = tempDir("dev-context-nested-");
    dirs.push(nestedRoot);
    const nestedBase = path.join(nestedRoot, "node_modules", "@deepseek-ai");
    const nested = path.join(nestedBase, "dsh", "node_modules", "@deepseek-ai", "dsh-harness-dev-context", "lib", "index.js");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "// nested\n", "utf8");
    const nestedPrompt = path.join(nestedBase, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js");
    fs.mkdirSync(path.dirname(nestedPrompt), { recursive: true });
    fs.writeFileSync(nestedPrompt, "// nested prompt\n", "utf8");
    const nestedFiles = targetFiles(nestedBase, path.join(nestedRoot, "home"));
    assert.equal(nestedFiles["dev-context"], nested, "npm 嵌套布局要落回 dsh/node_modules 里的副本");
    assert.equal(nestedFiles["system-prompt-nested"], nestedPrompt, "备用布局键在这里本来就该出现，不许被键集合比对判成「解析器多出」");

    // 源码仓库布局：<root>/packages/context/harness-dev-context/lib/index.js
    const sourceRoot = tempDir("dev-context-source-");
    dirs.push(sourceRoot);
    const sourceBase = path.join(sourceRoot, "node_modules", "@deepseek-ai");
    fs.mkdirSync(path.join(sourceBase, "dsh-base"), { recursive: true });
    const source = path.join(sourceRoot, "packages", "context", "harness-dev-context", "lib", "index.js");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, "// source\n", "utf8");
    assert.equal(targetFiles(sourceBase, path.join(sourceRoot, "home"))["dev-context"], source, "源码仓库布局由 dsh-base 反推根目录");
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * rc.5 的 ConversationNodeAssembler.append（#22）：整段方法体逐字节来自 host-text-fixtures
 * （由 host-text-fixtures.test.js 回真机核对子串）。外面只包一层类头/类尾，让窗口两侧有同形的邻句。
 */
const CLIENT_TEXTS = HOST_TEXT_FIXTURES.find((entry) => entry.id === "conversation-client").texts;
const APPEND_METHOD = CLIENT_TEXTS.append;
const CLASS_TAIL = pad(2) + "};";
const RC5_CLIENT = [pad(2) + "var ConversationNodeAssembler = class {", APPEND_METHOD, CLASS_TAIL].join("\n");
/** rc.5 改写的那句（方法体里出现两次，窗口内是第一处）。 */
const REVISED_LINE = APPEND_METHOD.split("\n").find((line) => line.includes("this.revised.clear();"));
/** 右界之后的一切：断言拿宿主原字节比，不用手写串。 */
const TAIL_AFTER_SET = APPEND_METHOD.slice(APPEND_METHOD.indexOf("this.inputs.set(event.seq, record);"));

test("回滚 append：rc.5 的 append 由窗口锚点认出，宿主新插的段原样搬回（#22）", () => {
  const patch = patchOf(77);
  assert.deepEqual(patch.file, ["conversation-client"], "#77 的落点不变");
  assert.equal(patchEffectState(RC5_CLIENT, patch, "client.js"), "pending", "rc.5 的 append 应被认成「还有待改」");

  const first = applyReplacementsToText(RC5_CLIENT, patch, "client.js");
  assert.equal(first.changed, true, "rc.5 的 append 必须被认出（旧的整段锚点一次都命中不了）");
  assert.ok(first.text.includes("[dsh-purge] rewind drops sent messages in this conversation"), "要留下标记");
  // 复用 #56 已经插进这个文件的 isRewindMarker：判「这是不是回退标记」只许有一份实现。
  assert.ok(first.text.includes("isRewindMarker(event)"), "插入逻辑要调宿主文件里已有的 isRewindMarker");
  assert.equal(first.text.includes("function isRewindMarker"), false, "不许在这个替换文案里另造一个 isRewindMarker");
  // #56 漂了时只退回「不丢消息」，不让 append 抛 ReferenceError 打死面板 —— 守卫本身要能被测试盯住。
  assert.ok(first.text.includes('typeof isRewindMarker === "function"'), "守卫必须写进被改写的文件");
  // 插入点在 revised.clear 之前：命中回退标记时早退，不白清临时集。
  assert.ok(
    first.text.indexOf("return this.replaceWindow(entries, this.hasMore);") < first.text.indexOf(REVISED_LINE),
    "插入必须落在 rc.5 的 revised.clear 那句之前",
  );
  assert.ok(first.text.includes(REVISED_LINE), "rc.5 改写的 revised.clear 那句要原样搬回");
  // 右界之后逐字节等于宿主原文：locationIndex 那段（含 rc.5 新加的分支）一个字都不许动。
  assert.equal(
    first.text.slice(first.text.indexOf("this.inputs.set(event.seq, record);")),
    TAIL_AFTER_SET + "\n" + CLASS_TAIL,
    "窗口右侧钉住 inputs.set，后面 locationIndex 那段一个字都不许动",
  );
  assert.equal(patchEffectState(first.text, patch, "client.js"), "applied");
  assert.equal(applyReplacementsToText(first.text, patch, "client.js").changed, false, "重复应用不得再改");
  // 关掉 skipIfMarked 也照样不叠加：窗口本身跨不过自己写的 marker（A3 的口径）。
  const forced = applyReplacementsToText(first.text, { ...patch, skipIfMarked: false }, "client.js");
  assert.equal(forced.changed, false, "窗口里排除本插件 marker，二次应用不叠加");
  assert.equal(forced.text.split("return this.replaceWindow(entries, this.hasMore);").length - 1, 1, "插入只有一份");
});

test("故障对照：把 #77 的锚点改回整段写法，这一组必须红（#22）", () => {
  // 旧 #77 的锚点 = 宿主原文里把 rc.5 改写的那句换回旧写法，再连同 inputs.set 一起写死。
  const legacyPattern = (
    APPEND_METHOD.slice(0, APPEND_METHOD.indexOf("this.inputs.set(event.seq, record);")) +
    "this.inputs.set(event.seq, record);\n"
  ).replace(REVISED_LINE, pad(4) + "this.revised.clear();");
  const legacy = {
    ...patchOf(77),
    replacements: [{ pattern: legacyPattern, replace: "legacy" }],
  };
  assert.equal(legacyPattern.includes("if (this.revised.size > 0)"), false, "旧写法里没有 rc.5 那句");
  assert.equal(applyReplacementsToText(RC5_CLIENT, legacy, "client.js").changed, false, "整段锚点在 rc.5 命中不了——这就是 #22 的故障现象");
  assert.equal(patchEffectState(RC5_CLIENT, legacy, "client.js"), "unmatched");
});

test("窗口有界：append 里多插一大段时宁可失配，也不跨语句吃正文（#22）", () => {
  const patch = patchOf(77);
  const widened = RC5_CLIENT.replace(REVISED_LINE, pad(4) + "// " + "x".repeat(600) + "\n" + REVISED_LINE);
  assert.notEqual(widened, RC5_CLIENT, "fixture 必须真的多插了一段");
  const out = applyReplacementsToText(widened, patch, "client.js");
  assert.equal(out.changed, false, "超过窗口上限就失配（进漂移），不许一路吃到 inputs.set");
  assert.equal(out.text, widened, "失配时一个字都不许改");
});

test("#77 的插入依赖 #56 写进同一文件的 isRewindMarker（顺序 + 归属，机械判定）", () => {
  // 守卫兜住「#56 漂了」的运行时后果（退回不丢消息），但那条分支会静默失效；
  // 所以依赖本身要能被测试盯住：同落点、先应用、只由 #56 定义。
  const hide = patchOf(56);
  const drop = patchOf(77);
  assert.deepEqual(drop.file, hide.file, "两条补丁必须落在同一个文件");
  assert.ok(
    ALL_PATCHES.findIndex((item) => item.id === 56) < ALL_PATCHES.findIndex((item) => item.id === 77),
    "#56 必须先应用：isRewindMarker 由它写进同一个文件",
  );
  const hideText = hide.replacements.map((item) => item.replace).join("\n");
  assert.ok(hideText.includes("function isRewindMarker"), "#56 负责定义 isRewindMarker");
  const dropText = drop.replacements.map((item) => item.replace).join("\n");
  assert.equal(dropText.includes("function isRewindMarker"), false, "#77 只调用，不定义");
});
