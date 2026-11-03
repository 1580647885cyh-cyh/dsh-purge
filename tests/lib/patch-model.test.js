import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFECT_STATES,
  OBSERVE_STATES,
  STATUS_WORDS,
  applyReplacementsToText,
  effectOf,
  filePatchOutcome,
  isLayoutSoftPatch,
  isSelfMarkedPatch,
  missingAnchors,
  observe,
  readyStatus,
  resultSoftOk,
  rollupPatchStatus,
  statusFacts,
} from "../../lib/patch-model.js";

/**
 * 补丁模型的接口测试（issue #15）。
 *
 * 一条补丁 = 两段字符串进（原文 + 补丁）、三种事实出（target / pending / foreign）。
 * 这些断言不需要宿主、不需要 fs，也不需要 8 137 行的 core.js。
 */

/** 最小补丁：一个替换 + 一个完成标记。刻意手写，不从真实宿主导出文本。 */
function samplePatch(extra = {}) {
  return {
    id: 900,
    name: "SAMPLE",
    file: "preset-standard",
    replacements: [{ pattern: "fetch: false", replace: "fetch: true" }],
    markers: ["fetch: true"],
    ...extra,
  };
}

test("observe：三种事实与 ownMark", () => {
  const patch = samplePatch();
  const pending = observe("line\nfetch: false\nline", patch);
  assert.deepEqual(pending, { state: "pending", ownMark: false }, "还有可改原文 → pending");

  const target = observe("line\nfetch: true\nline", patch);
  assert.deepEqual(target, { state: "target", ownMark: true }, "标记命中 → target，且是我们写的");

  const foreign = observe("line\nnothing here\nline", patch);
  assert.deepEqual(foreign, { state: "foreign", ownMark: false }, "两样都不成立 → foreign");
  assert.deepEqual(OBSERVE_STATES, ["target", "pending", "foreign"]);
});

test("observe：CRLF 原文按 LF 判定（宿主文件可能是 CRLF）", () => {
  const patch = samplePatch();
  assert.equal(observe("a\r\nfetch: true\r\nb", patch).state, "target");
  assert.equal(observe("a\r\nfetch: false\r\nb", patch).state, "pending");
});

test("effectOf：把观察投影成效果词，词表受测试锁着", () => {
  assert.deepEqual(EFFECT_STATES, ["applied", "pending", "unmatched"]);
  assert.equal(effectOf({ state: "target" }), "applied");
  assert.equal(effectOf({ state: "pending" }), "pending");
  assert.equal(effectOf({ state: "foreign" }), "unmatched");
  assert.equal(effectOf(null), "unmatched", "空观察按 unmatched，不抛");
});

test("settle 字段优先于旧的 id 表：layout-soft / strict", () => {
  assert.equal(isLayoutSoftPatch({ id: 900 }), false);
  assert.equal(isLayoutSoftPatch({ id: 900, settle: "layout-soft" }), true);
  assert.equal(isLayoutSoftPatch({ id: 4 }), true, "旧表写法仍然认 id");
  assert.equal(isLayoutSoftPatch({ id: 4, settle: "strict" }), false, "显式 strict 覆盖旧 id 表");
  assert.equal(isLayoutSoftPatch({ id: 900, softSettle: true }), true, "老字段 softSettle 仍然生效");
});

test("statusFacts：soft 与 ready 是两件事（na 不挡 apply，但不算就绪）", () => {
  assert.deepEqual(statusFacts("applied"), { soft: true, ready: true });
  assert.deepEqual(statusFacts("already"), { soft: true, ready: true });
  assert.deepEqual(statusFacts("skipped"), { soft: true, ready: true });
  assert.deepEqual(statusFacts("missing_file"), { soft: true, ready: true });
  assert.deepEqual(statusFacts("na"), { soft: true, ready: false });
  assert.deepEqual(statusFacts("read_error"), { soft: false, ready: false });
  assert.deepEqual(statusFacts("off"), { soft: false, ready: false }, "死值 off 不再被优待");
});

test("statusFacts：pattern_not_found 的严格度取决于补丁（strict / optional / layout-soft）", () => {
  assert.deepEqual(statusFacts("pattern_not_found", { id: 1, strictFiles: true }), { soft: false, ready: false });
  assert.deepEqual(statusFacts("pattern_not_found", { id: 1, optional: true }), { soft: true, ready: true });
  assert.deepEqual(statusFacts("pattern_not_found", { id: 1, softSettle: true }), { soft: true, ready: false });
  assert.deepEqual(statusFacts("pattern_not_found", { id: 1 }), { soft: false, ready: false });
  // strict 优先于 optional：两个字段同时写时要按最严的算
  assert.deepEqual(statusFacts("pattern_not_found", { id: 1, strictFiles: true, optional: true }), { soft: false, ready: false });
});

test("resultSoftOk / readyStatus 是同一张事实表的两个投影", () => {
  const strict = { id: 1, strictFiles: true };
  assert.equal(resultSoftOk({ status: "pattern_not_found" }, strict), false);
  assert.equal(readyStatus("pattern_not_found", strict), false);
  assert.equal(resultSoftOk({ st: "na" }, null), true, "行里用 st 也认");
  assert.equal(readyStatus("na"), false);
  assert.deepEqual(STATUS_WORDS, ["applied", "already", "pending", "skipped", "drifted", "missing_file", "na"]);
});

test("applyReplacementsToText：改写是 observe 的另一半（幂等由内容决定）", () => {
  const patch = samplePatch();
  const once = applyReplacementsToText("a\nfetch: false\nb", patch);
  assert.equal(once.changed, true);
  assert.equal(once.text, "a\nfetch: true\nb");
  const twice = applyReplacementsToText(once.text, patch);
  assert.equal(twice.changed, false, "第二次改写不再动文本");
  assert.equal(observe(once.text, patch).state, "target");
});
test("statusFacts：读/写错误只有必需补丁才挡重启（不新增阻断）", () => {
  assert.deepEqual(statusFacts("read_error"), { soft: false, ready: false }, "不知道是哪条补丁时按最保守处理");
  assert.deepEqual(statusFacts("read_error", { id: 1 }), { soft: true, ready: false }, "可选/普通补丁的读错误不挡重启");
  assert.deepEqual(statusFacts("write_error:EACCES", { id: 1 }), { soft: true, ready: false });
  assert.deepEqual(statusFacts("write_error:EACCES", { id: 1, strictFiles: true }), { soft: false, ready: false }, "必需补丁写不进去仍然要挡");
});

test("statusFacts：drifted 看得见、不挡 Apply，也不算已就绪（A2）", () => {
  assert.deepEqual(statusFacts("drifted"), { soft: true, ready: false });
  assert.equal(resultSoftOk({ status: "drifted" }, { id: 1, strictFiles: true }), true, "必需补丁漂移也不挡 Apply");
  assert.equal(readyStatus("drifted", { id: 1 }), false, "漂移不是「已就绪」");
});

test("filePatchOutcome：原文对不上、也没写过 → drifted，不再混进 skipped（A2）", () => {
  const patch = samplePatch();
  assert.equal(filePatchOutcome("fetch: false", patch), "pending", "还能改 → pending");
  assert.equal(filePatchOutcome("fetch: true", patch), "applied", "目标态成立 → applied");
  assert.equal(filePatchOutcome("宿主把这段改掉了", patch), "drifted", "既非目标态、也没有待改原文 → drifted");
});

test("filePatchOutcome：自标记型补丁找不到痕迹仍算 skipped，不误报漂移", () => {
  const undo = {
    id: 901,
    name: "UNDO",
    file: "preset-standard",
    replacements: [{ pattern: "keep // [dsh-purge] marker", replace: "keep" }],
    markers: ["keep"],
  };
  assert.equal(isSelfMarkedPatch(undo), true, "pattern 本身就是本插件留下的痕迹");
  assert.equal(filePatchOutcome("没有痕迹", undo), "skipped");
  assert.equal(isSelfMarkedPatch(samplePatch()), false, "普通补丁认的是宿主原文");
  assert.equal(
    isSelfMarkedPatch({ id: 903, name: "TRACE", file: "base", replacements: [{ pattern: "old dsh-purge: marker", replace: "new" }] }),
    true,
    "旧脚本留下的 dsh-purge: 标记同样算自标记",
  );
});

test("rollupPatchStatus：写错误 > 必需缺原文 > drifted > applied（A2 的优先级）", () => {
  const base = {
    applied: 0, already: 0, missing: 0, notFound: 0, drifted: 0,
    lastError: null, keyCount: 1, layoutSoft: false, strictFiles: false,
  };
  assert.equal(rollupPatchStatus({ ...base, applied: 1, lastError: "write_error:EACCES" }), "write_error:EACCES", "写错误不能被 applied 吞成绿");
  assert.equal(rollupPatchStatus({ ...base, drifted: 1, applied: 1 }), "drifted", "漂移压过已完成");
  assert.equal(rollupPatchStatus({ ...base, strictFiles: true, notFound: 1, drifted: 1 }), "pattern_not_found", "必需补丁缺原文仍是硬失败");
  assert.equal(rollupPatchStatus({ ...base, applied: 1 }), "applied");
  assert.equal(rollupPatchStatus({ ...base, already: 1, notFound: 0 }), "already");
  assert.equal(rollupPatchStatus({ ...base, notFound: 0 }), "skipped");
});

test("missingAnchors：只列没命中的锚点，带定位用的头 80 字符", () => {
  const patch = samplePatch({
    replacements: [
      { pattern: "fetch: false", replace: "fetch: true" },
      { pattern: "line three", replace: "line three ok" },
    ],
  });
  assert.deepEqual(missingAnchors("fetch: false\n还好这段没变", patch).map((item) => item.head), ["line three"]);
  assert.deepEqual(missingAnchors("完全对不上", patch).map((item) => item.index), [0, 1]);
  assert.deepEqual(missingAnchors("fetch: false\nline three", patch), []);
});
