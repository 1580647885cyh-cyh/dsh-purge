# #22 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 回归记录（#22 回滚 append 改窗口式锚点）

- 故障（rc.5 实测）：`#77` 的锚点是 `append(record)` 到 `this.inputs.set(event.seq, record)` 的整段字面量，
  里面把 `this.revised.clear();` 写成无条件调用；rc.5 改成 `if (this.revised.size > 0) this.revised.clear();`，
  并在 `inputs.set` 之后插了 locationIndex 一段 → 整段锚点一次都命中不了，隔离副本里 `#77` 报 drifted。
- 实现：
  - 锚点改成窗口式（A3 口径）：`append(record) {`、`const event = record.event;`、去重判断钉死，
    右界钉在 `this.inputs.set(event.seq, record);`，中间用非贪婪窗口
    `(?:(?!\[dsh-purge\])[\s\S]){0,400}?` 吃掉并原样搬回 —— rc.5 改写的那句与宿主以后在中间加的行都跟着走。
  - 插入逻辑复用 `#56` 已经插进同一个文件的 `isRewindMarker`（`ConversationNodeAssembler` 之前那段），不另造第二份判定；
    外面套 `typeof isRewindMarker === "function"` —— `#56` 一旦漂了，`append` 保持原样，
    不会因为 ReferenceError 把整个对话面板打死。
  - 窗口排除本插件 marker：除了 `skipIfMarked`，关掉它二次 apply 也不叠加（`{ ...patch, skipIfMarked: false }` 用例钉住）。
  - 插入点仍在 `revised.clear` 之前：命中回退标记时早退，不白清临时集。
- 通过证据（本轮 `npm run verify` 报告 `20261103-171028`；对照 #21 那轮 `20261103-160023`）：
  - `targets.isolated.drifted = []`（#21 那轮同一字段是 `[77]`）、`targets.isolated.statusAfter["77"] = applied`；
    `targets.live.unmatched` 只剩 `#21`（布局软结算）与 `#80`（自标记型），这两条本来就不进漂移清单。
  - `admin.diffs`：apply.changed = 48（不变，`client.js` 本来就被 `#56` 改过）、reapply.changed = 0、
    revert.changed = 48 全部还原；报告「状态与文件一致」段：假成功 0 / 超前 0 / 落后 0 / 布局结算 1。
- 口径：报告里有两个「漂移」计数，不要混。A2 的 `targets.*.drifted` 清单是本票口径（与 #20 诊断同一份），
  已清零；`purge_apply` 回执里的 `漂移=` 是 patchStatus 的计数，还带着 `#50/#57/#62` 这类既存项。
- 退化路径：`#56` 一旦漂了、`isRewindMarker` 不在作用域，`#77` 的插入分支会静默不生效（守卫不让 `append` 崩），
  但标记仍会被写进文件、状态仍报 applied —— 所以依赖本身由 `tests/verify/targets.test.js` 的
  「#77 的插入依赖 #56」一条机械盯住（同落点、先应用、只由 #56 定义），`#56` 漂移也会同时出现在漂移清单里。
- 取舍：写进宿主的语义没变（回退标记到达时立刻把已发送消息从当前对话拿掉），只改锚点写法与函数复用方式。

## 本票验收对应（#22 回滚 append 窗口化）

- 隔离副本上该补丁 applied、重复应用不改文件：`tests/verify/targets.test.js`「回滚 append：rc.5 的 append
  由窗口锚点认出…」断言 `pending → applied`、再应用 `changed = false`、插入只有一份；真机报告
  `admin.diffs.reapply.changed = 0`。
- 故障对照：同文件「故障对照：把 #77 的锚点改回整段写法，这一组必须红」把旧整段锚点钉成 `unmatched`——
  谁把锚点改回去，前一条立刻红。
- 窗口有界 + 排除 marker：同文件「窗口有界：append 里多插一大段时宁可失配…」与第一条里的
  `{ ...patch, skipIfMarked: false }` 断言；A3 的「窗口必须写上界」惯例由 `tests/lib/patch-table.test.js` 兜底。
- 宿主原文不许手写：rc.5 的整段 `append()` 方法体登记在 `tests/verify/host-text-fixtures.js`，
  由 `host-text-fixtures.test.js` 回真机核对子串；用例里的类头/类尾只是胶水。
- 真机 `npm run verify`：通过，`targets.isolated.drifted = []`（3 → 1 → 0）；`npm run check` 通过、
  `npm run test:ci` 全绿。
