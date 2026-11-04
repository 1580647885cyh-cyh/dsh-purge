/**
 * 预设声明状态的唯一口径（`$DSH_HOME/redteam/preset-declare.json`）。
 *
 * 这份文件是「红队模式到底挂上没有」的现场证据，A8 直接拿它下结论，所以它不能假绿：
 *   · `registry.list()` 抛错时不能说 registered —— 那时我们根本没读到 `broken`，
 *     记成 registered 等于把「没核对」冒充成「核对过」；
 *   · 成功写入必须把上一阶段留下的 `error` 清掉（writeStatus 是合并写，
 *     不清就会留下「ok:true + 旧错误」的自相矛盾记录）。
 *
 * @param {{ broken?: string|null, workerBroken?: string|null, listError?: string|null }} input
 * @returns {{ ok: boolean, phase: string, broken: string|null, workerBroken: string|null, listError: string|null, error: null }}
 */
export function presetDeclareOutcome({ broken = null, workerBroken = null, listError = null } = {}) {
  const brokenText = broken ? String(broken) : null
  const workerText = workerBroken ? String(workerBroken) : null
  const listFailure = listError ? String(listError) : null
  const ok = !brokenText && !workerText && !listFailure
  const phase = brokenText || workerText
    ? 'registered-broken'
    : listFailure
      ? 'registered-unverified'
      : 'registered'
  return { ok, phase, broken: brokenText, workerBroken: workerText, listError: listFailure, error: null }
}
