import assert from "node:assert/strict";
import test from "node:test";
import { toolCallVerdict } from "../../lib/verify/tool-call-verdict.js";

/**
 * 判定词的语义（2026-11-04）：
 * record.ok 只说明「这一轮正常结束」，不说明「结果符合预期」。
 * 反向案例（调用不存在的工具）里 ok 就该是 false，但那一轮是通过的。
 */
const record = (executed, extra = {}) => ({ ok: false, executed, error: "", ...extra });

test("toolCallVerdict：正向案例", () => {
  assert.equal(toolCallVerdict(record({ isError: false, textLength: 10 }), "accept"), "accepted");
  assert.equal(toolCallVerdict(record({ isError: true }), "accept"), "unexpected-error");
});

test("toolCallVerdict：反向案例（期望宿主拒绝）", () => {
  assert.equal(toolCallVerdict(record({ isError: true }), "reject"), "rejected");
  assert.equal(toolCallVerdict(record({ isError: false }), "reject"), "unexpected-success",
    "本该被拒绝却执行成功了 —— 这是反向案例的失败形态");
});

test("toolCallVerdict：没跑 / 没执行 / 没记录", () => {
  assert.equal(toolCallVerdict(null, "reject"), "missing");
  assert.equal(toolCallVerdict(undefined), "missing");
  assert.equal(toolCallVerdict(record(null), "reject"), "no-call");
  assert.equal(toolCallVerdict(record(null), "accept"), "no-call");
});

test("toolCallVerdict：报告里已算好的判定优先（run.js 会写进 verdict）", () => {
  assert.equal(toolCallVerdict(record({ isError: true }, { verdict: "rejected" }), "accept"), "rejected",
    "已写入的判定不被 want 覆盖 —— 否则同一份报告在两处读出不同结论");
});

test("toolCallVerdict：旧报告没有 verdict 字段也能判定（向后兼容）", () => {
  const legacy = { ok: false, executed: { isError: true }, error: "" };
  assert.equal(toolCallVerdict(legacy, "reject"), "rejected");
  assert.equal("verdict" in legacy, false);
});
