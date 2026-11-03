# #6 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 回归记录（#6 恢复 rc.5 目标定位并让适配状态反映实际结果）

- 故障一（状态落后于结果，#84）：0.2.1-rc.5 的 close 回调写成
  `if (code !== 0 && code !== null) … else fail(stopped)`。#83 会先把它改写成旧形态、#84 再消掉 code=0 的
  stopped 分支 —— 应用链路本来就能生效（链式探针：只保留旧形态的 #84 也能改写）。但 patchStatus 按原文
  直接匹配时不认这条链：未打补丁的副本上报 skipped，和「点应用会改文件」对不上。修法是给 #84 补一条直接
  匹配 rc.5 形态的等价形式（替换语义与旧形态完全一致），状态回到 pending → applied。
- 故障二（等价分支）：system-prompt 的 assemble 在 complete 分支前多了 requiredContexts 过滤，contexts
  表达也换了形态。#40 只认旧形态，complete 预设下注入段会被整段丢掉；同一处若按旧替换写回，还会把 #5
  要求的 required 运行上下文一起清空。
- 故障三（标记造成的假成功）：#24 把通用字符串 `fetch: true` 当完成标记，而官方 preset 本来就写着
  fetch: true —— 状态报成功，实际处理一次都没跑。现在由 presetToolWebFetchEnabled 按行缩进判定 tool-web
  自己那一块，块外/别的行的 fetch 不算。
- 修复：#84/#40 各补一条等价形式的匹配（替换语义不变）；#24 换成目标态判定，并补 rc.5 缩进下的
  fetch: false → true 形；core 新增 settledWhen（补丁自带的目标态判定）与 patchEffectState（只看文件事实）。
- 通过证据（本次报告）：隔离副本应用改了 47 个文件，重复应用 0 改动；应用后逐文件核对「写进文件 69 /
  宿主本就满足 1 / 待改 0 / 对不上 5（#21/#80/#32/#53/#77，逐条带落点）/ 不适用 7（逐条带搜索位置）」；
  状态一致：假成功 0 / 状态超前 0 / 状态落后 0。
- 通过证据（运行结果）：完整提示词装配里 dsh-purge 段与 complete 段共存、抑制运行上下文后仍是
  working-directory，而未打补丁的真实宿主在同一装配里丢掉注入段；桌面壳 close 回调未打补丁时 code=0 报错、
  打补丁后不报错、code=3 仍报错、重复应用 0 改动；副本上关掉 preset 的 fetch 后，公开 purge_apply 重新打开
  并写回标记，重复应用不追加。

## 本票验收对应（#6 目标定位与适配状态）

- 通过公开管理入口复现失配/假成功：#40 在修复前对 rc.5 的 complete 分支一次都命中不了（状态与应用都
  skipped，注入段在 complete 预设下丢失）；#24 在未做任何处理的副本上一路报 applied，标记却是官方自己的
  `fetch: true`；#84 则是状态落后于结果（应用链会改文件，状态报 skipped）。
- 定位当前宿主实际模块与分支：只读定位列出每个键解析到的路径；#84 落在 `<install>/resources/app/lib/main.js`
  的 close 回调，#40 落在 dsh-system-prompt 的 assemble complete 分支。桌面布局没有 npm 嵌套层，嵌套键在本轮
  保持不适用并列出搜索位置，不做「反正有就用」的重复处理。
- 保持基线语义、不整段替换：两条新匹配只补「等价表达形式」，替换文本与基线一致；#40 的替换保留 rc.5 的
  requiredContexts 过滤，没有把上游新行为删掉或搬进来。
- 状态与文件结果一致：patchEffectState 只看文件事实，patchOwnMarkPresent 再把「写进文件」与「宿主本就满足」
  分开（#24 属于后者）；假成功 0 / 状态超前 0 / 状态落后 0；#21 这类布局软补丁单独列为「按布局结算」，
  不计入成功证据。
- 用隔离副本的应用与运行结果证明：入口五在 asar 解出的副本上走 purge_apply，再用宿主自己的 system-prompt
  与桌面壳 close 回调整体跑分支，而不是断言 marker 出现。
- 重复应用不追加、对照不被误命中：#84 的旧形态仍有专门用例；#24 的块外 fetch、tool-web 块内 fetch: false
  都有反例；重复 purge_apply 与重复替换都是 0 改动。
- 未复现/不适用项保留实现并提供证据：hooks-claude-code/codex、liangshen、unrestricted、user-approval 的
  invariant.js 这些键在当前安装里不存在，报告逐条列出搜索过的位置（真实 DSH_HOME 与隔离副本分开列），
  非可选的 #71 也标注「非可选」而不是当作成功；#32/#53/#77/#80 保持实现，状态是 skipped/对不上，
  并在报告里逐条带落点，不用宽泛匹配放行。
