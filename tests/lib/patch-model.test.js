import assert from "node:assert/strict";
import test from "node:test";
import {
  EFFECT_STATES,
  OBSERVE_STATES,
  STATUS_WORDS,
  applyReplacementsToText,
  effectOf,
  isLayoutSoftPatch,
  observe,
  readyStatus,
  resultSoftOk,
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
  assert.deepEqual(STATUS_WORDS, ["applied", "already", "pending", "skipped", "missing_file", "na"]);
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
