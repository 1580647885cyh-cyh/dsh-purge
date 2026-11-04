/**
 * 一轮受控工具调用的判定词（2026-11-04）。
 *
 * `record.ok` 只说明「这一轮正常结束」，不说明「结果符合预期」：反向案例（调用不存在的工具）
 * 里 ok 就该是 false，但那一轮是**通过**的。过去 report / acceptance / markdown 三处各写一遍
 * `executed.isError === true`，报告 JSON 里于是留下一个看着像失败的 `ok: false`。
 * 现在判定统一走这里：report 与 acceptance 读同一个词，md 里也把它打出来。
 *
 * want = "accept"：期望工具正常执行；want = "reject"：期望宿主拒绝这次调用。
 *
 * 判定词：
 * - accepted / rejected —— 符合预期；
 * - unexpected-success —— 本该被拒绝却执行成功了（反向案例的失败形态）；
 * - unexpected-error —— 本该成功却报错；
 * - no-call —— 端点或宿主没给出工具执行结果；
 * - missing —— 这一轮根本没跑。
 */
export function toolCallVerdict(record, want = "accept") {
  if (!record) return "missing";
  // 记录里已经算好的话直接用（run.js 会把判定写进报告）。
  if (typeof record.verdict === "string" && record.verdict) return record.verdict;
  const executed = record.executed;
  if (!executed) return "no-call";
  if (want === "reject") return executed.isError === true ? "rejected" : "unexpected-success";
  return executed.isError === true ? "unexpected-error" : "accepted";
}
