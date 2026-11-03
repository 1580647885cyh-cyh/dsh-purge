# DSH 适配清单（1.1.71 冻结版）

上游 `YuJunZhiXue/dsh-purge` 的 1.1.71 已被删除（Releases / tags 都是 404，tag 从 `v1.1.73` 起），
所以宿主适配只能本地自研。约束见 [ADR-0002](adr/0002-local-only-adaptation-after-upstream-removal.md)：
**只改机制，不改能力面**。

- 上游审计基线：`v1.1.73...v1.1.90` = **33 commits / 58 文件**（2026-11-02 止）。
- 上游克隆（只读、仓库外）：`D:\dsh\tmp\upstream-audit`；用完可删。
- 能力面守卫：`tests/archive/original-1.1.71.test.js` + `docs/original-1.1.71.capability.json`。
- 判定规则：**一项适配值得做，当且仅当它能消掉一次我们在本机真的复现过的宿主缺陷。** 上游改了什么只作线索，不作依据。

## A. 要做的适配（按顺序）

### A1 · 宿主版本门禁

**状态：已落地（#18）**。改名「宿主版本报告」更准：三态（已适配 / 未适配 / 未知）只进报告与状态，
**不阻断** Apply —— 阻断会把冻结版锁在门外，而宿主升级恰恰是最需要「还能跑 + 说清楚哪里没适配」的时刻。
③ 按版本给补丁分支变体**不做**：本 fork 只为本机服务，没有第二个宿主可对照，造出来的变体是投机（#17 已确认）。

- **宿主侧**：0.2.1-rc.2 → rc.5 之间宿主文件继续变形；上游把 `dshTarget` 扩成
  `dshTargets: ["0.2.1-rc.2", "0.2.1-rc.5"]`，并加 `HOST_TARGETS` / `hostCompat()` /
  `parseHostVersion()` / `readHostVersion(aiBase)`（上游 `d1eff01` 1.1.88、`6f9c500` 1.1.84）。
- **历史现状（A1 前）**：`package.json` 的 `dshTarget` 曾是 `0.2.0-rc.2`；当时全仓只有 baseline/acceptance
  **记录**这个字段（`lib/verify/baseline.js:182`、`lib/verify/acceptance.js:97`），没有任何门禁。
- **要做**：① `dshTarget` 改成实测宿主（当前 0.2.1-rc.5），并列 `dshTargets`；
  ② 读到不支持的宿主版本时，报告里明确写"未适配 <版本>"而不是假装绿；③ 同一补丁按版本给分支变体。
- **红线**：变体只许改**锚点/匹配式/是否适用**，不许改补丁要写进去的文案。

### A2 · drifted（漂移）状态

**状态：已落地（#19）**。判定 = 文件在、既非目标态、也没有可改原文、且不属于布局软结算；自标记型补丁
（pattern 本身就是本插件痕迹）仍算 skipped，不误报。逐条给出「补丁 → 文件 → 没命中的补丁锚点」。
**漂移一律不阻断 Apply**：上游 1.1.87 起 drifted 也是软的，本 fork 与本机用法一致。
另：本节原先对 `6f9c500` 的描述有两处失真 —— ① `pattern_not_found` 不是「一律当阻断项」（那次是删掉
`ensureHostClean` 的预过滤，改由 `isPatchResultSoftOk` 分级：strict 挡、optional / 布局软仍软）；
② 「漂移压过已完成」是**优先级**（drifted 排在 applied 之前），不是严重度。已按实测口径落地。

- **宿主侧**：补丁对不上官方原文时，既非 applied 也非 pending。上游新增 `drifted` 词，
  "漂移压过已完成"，并把 `pattern_not_found` 一律当阻断项（`6f9c500`）。
- **我们现状**：`drifted` 全仓 0 命中；判定词表在 `lib/patch-model.js` 的 `statusFacts()`
  —— 现在 `pattern_not_found` 在 `optional` / 布局软时算 soft（不挡 Apply）。
- **要做**：把"漂移"从"跳过"里拆出来，报告里逐条写"哪条补丁漂了、漂在哪个锚点"。
- **默认口径（待 grilling 确认）**：**阻断只针对必需补丁**（`strictFiles` 一类），
  布局软 / `optional` 的漂移降级为"警告 + 报告标红"，不阻断 Apply —— 否则宿主改一行就能把
  整个冻结版锁在门外。

### A3 · 窗口锚点（补丁健壮性）

**状态：#21 / #22 已落地**——#21 把 web 身份句的落点从 `web-app-lib` 改到 `dev-context`（#32/#53），
#22 把回滚 `append()` 换成窗口锚点（#77，复用 #56 已插进同一个文件的 `isRewindMarker`）。
本机漂移清单 `targets.isolated.drifted` 已清零（诊断 3 条 → #21 后 1 条 → 本轮 0 条，口径见
`docs/verification/records/issue-21.md` 与 `docs/verification/records/issue-22.md`）。

- **宿主侧**：官方改函数时**在中间加行**（rc.2 → rc.3 又改一次），整段写死就永远失配。
- **上游对策**：只锚方法头 + event 取值 + 去重判断 + 结尾 `set`，中间用非贪婪窗口
  `[\s\S]*?` 吃掉并原样搬回；窗口里排除自己的 marker，防二次注入（`6f9c500` 注释原文）。
- **我们现状**：75 条补丁用整段 exact string（`replacements`）。
- **要做**：只挑**最容易随宿主变形**的几条（身份句、bash/pwsh justification、agent-loop、
  web-app 身份）改成窗口式。**不做全量重写**。

### A4 · DSH NEXT 识别

**状态：已落地（#24）**。形态 / 是否解 asar / 壳入口拆成三件独立事实，名单只有一份
`lib/desktop-forms.js`；NEXT 落在「认得出、不换包、壳入口照常定位」这一格，
fixture 在入口五逐项落报告（`targets.desktop`）。「不解包」= 不在名单的解包格里，不是黑名单；
认不出的 exe 保留老兜底（差异与取舍见 `docs/verification/records/issue-24.md`）。

- **宿主侧**：出现第三个发行形态 `DSH NEXT.exe`（**不解 asar**）。
- **我们现状（A4 前）**：`lib/desktop.js` 只认 `DeepSeek Harness.exe` 与 `DSH Desktop.exe`，无 NEXT；
  「解不解包」与「壳入口在哪」都从 `isOfficialHarnessExecutable` 那一个布尔推。
- **要做**：加 exe 名 + "不解包"分支；`lib/surface.js` 同步。

### A5 · 桌面静默退出的退出码留痕

**状态：close 一路已落地（#25）**。补丁 #90 在 close 回调里旁听 code/signal，写一条有上界的记录到
`<DSH_HOME>/dsh-purge/exit-ledger.jsonl`；`purge_status` 与验证报告都能读到「最近一次桌面退出」。
**只旁听**：不改退出行为、不改 exit code、不写官方更新 journal。
其余生命周期（before-quit / will-quit / quit(exitCode) / 渲染进程崩溃 / 信号 / 未捕获异常）**尚未落**——
它们要么没复现过缺陷，要么需要新的补丁锚点；按判定规则，先复现再动。

- **宿主侧**：dir 模式静默退出时，只有 host 的 close 回调知道真实退出码（上游 `c63ba4a`，#207）。
- **我们现状（A5 前）**：#83/#84 把两个分支都改成静默 `resolve()`，code/signal 读完就丢。
- **要做**：挂生命周期日志（before-quit / will-quit / quit(exitCode) / 渲染进程崩溃 / 信号 /
  未捕获异常）。**只 monitor，不挂 uncaughtException 本体**（会把崩溃吞成继续跑）。

### A6 · web 重启的孤儿 server 与 EADDRINUSE

**状态：已落地（#28 复现 / #29 实现）**。helper 把 detached server 的 pid / port / host / url /
startedAt / execPath / argv 写到 `<DSH_HOME>/dsh-purge/web-server-<port>.json`；宿主 `bin.js` 顶部
新增自包含 preflight sidecar，在 profile boot / webserver 绑端口之前按「记录 pid → 端口监听者 →
命令行」核对并回收。PID 复用/陌生端口不误杀，杀后等 pid 消失 + 端口空；有界 ≤5s、绝不抛错。
测试 `tests/verify/web-reclaim.test.js`；票级记录 `docs/verification/records/issue-29.md`。

- **宿主侧**：`dsh web` detached 重启会留孤儿 server，下次启动绑端口失败在 0.2.x 是 **fatal**
  （等插件层处理就晚了）（上游 `8d237ba`、`1bdf239`）。
- **我们现状（A6 前）**：`lib/restart-web.js` 有 `killOldServer()`（taskkill /F + SIGTERM），
  但**没有**"启动前回收孤儿 + 防 PID 复用 + 等端口释放"。
- **前置（已做）**：#28 在本机隔离环境复现到「helper 退出后留下监听者」与「下一次 `dsh web`
  `EADDRINUSE` exit 1」；复现评论见 #28。

### A7 · asar 换包顺序

**状态：已落地（#27）**。三条路径（wscript / PowerShell / helper）都先结束 main、确认消失，再清其余、
全部消失后才挪 asar；失败分支在 asar 仍密封时按原版布局重新拉起 exe，并核对启动结果。helper 的 win32
进程选择从「镜像名枚举」改成「安装根路径过滤」。入口五已接 `proveAsarSwapRestart`（报告
`targets.runtime.desktopSwap`）。`core.js` 的交接层与真实安装 apply/revert 未动。
修前红/修后绿见 `docs/verification/records/issue-27.md`。

- **宿主侧**：桌面点"应用"时 host 被杀而 Electron main 还活 → 弹 "host stopped"、asar 没挪动 = 半死
  （上游 `7fddfe3`）。顺序约束：先杀 main；挪不动就把原版拉起来。
- **我们现状（A7 前）**：换包交接在 `core.js`（`swapAsar` handoff / `openSealedDesktopHost`），
  它只做文件交接、不做进程动作（这是对的）；进程动作在下游 `lib/desktop.js` 与 `lib/restart-desktop.js`。
  审计发现三条失败分支都不拉起原版，且 wscript 脚本因注释含中文导致 `isWshAscii=false`、生产一直回落到
  PowerShell（本机 detached PowerShell 还会直接 exit 0 不执行）。
- **要做（已做）**：三条路径补失败分支；wscript 注释改 ASCII 恢复 intended 引擎选择；
  顺序与失败分支由 `lib/verify/desktop-swap.js` 的假安装树 harness 证明（`tests/verify/desktop-swap.test.js`）。

### A8 · preset schema 校验

- **宿主侧**：0.2.1 的 preset schema 校验更严（上游 `6cb2ac3` 把 object 型参数 seal 住，
  否则 redteam 预设加载失败）。
- **我们现状**：`additionalProperties` 0 命中，未做。
- **要做**：**先核对**宿主是否真的拒绝我们的 preset；拒绝了再改（改名/加 seal 属于机制面）。

## B. 不需要跟的（只跟上游自己的新功能绑定）

| 上游 | 为什么不需要 |
| --- | --- |
| allowBuilds / pnpm-workspace URL 键（#180/#185） | 1.1.71 不写 `allowBuilds`（全仓 0 命中）；不引入那套 pnpm 安装流程就不会撞 `ERR_PNPM_INVALID_VERSION_UNION` |
| profile-insert 系列（#191 `[]` 处理、#162 命令撞名、#159 insert 自愈） | 那是"往用户 `profiles/` 写插件行"的功能，我们没有；我们只改 packages 自带的 `cordis.patch.yml` |
| 停用/卸载清 `selectedDefault=redteam`（#108） | 那是"默认红队模式"功能的副作用；我们没有这个开关 |
| 1.1.76 pnpm 安装适配（codeload + postinstall） | 同上，属于安装流程，不属于宿主契约 |

## C. 不碰（能力面 / UI / 内容）

`presets/**`、`skills/**`、内嵌提示词（`lib/asset-table.js` 的 SLOT_ROWS）、
`lib/default-prompt-inject*`、`capability-protocol` 正文、`client.js` 与演练台面板文案、README/docs。

上游的 1.1.84「红队模式中文化」、1.1.85「深色模式」、1.1.87「全仓审计/死代码清理」、
1.1.90「撤销按钮移出 composer 子树」都在这一类：不是适配，或者只碰 UI。

守卫：`tests/archive/original-1.1.71.test.js` 会拦住任何"顺手改了能力面"的提交。

## D. 顺序与验收

1. **A1 + A2**（同一片：补丁状态与宿主版本）→ 一个 session。**已完成**（#17 / #18 / #19）。
2. **A3**（窗口锚点，挑几条）→ 一个 session。
3. **A4 + A5**（低风险）→ 一个 session。
4. **A6 + A7**（先复现再动）→ 按复现结果排期。
5. **A8** 随宿主升级顺带核对。

每项的验收：
- 能在本机隔离验证里**先红后绿**（CODING_STANDARDS #6：对照要拔掉**生产路径上的那一处**）。
- `npm run check` + `npm run test:ci` 全绿，且 `tests/archive` 四条守卫仍绿。
- `npm run verify` 通过，入口五（目标定位与适配状态；旧文档写的「入口三」是管理生命周期，编号已统一）仍 0 假成功 / 0 超前 / 0 落后。
- 报告里能读到"宿主版本 + 哪些补丁漂了 + 漂在哪"。

## 附：上游出处

| 条目 | 上游 commit | 日期 | 标题 |
| --- | --- | --- | --- |
| A1 | `d1eff01` | 2026-11-01 | fix: 补丁 rc.2/rc.5 双版本适配，版本 1.1.88 |
| A1/A2/A3 | `6f9c500` | 2026-10-30 | fix: 补丁失配判定加 drifted，宿主版本门禁与 expect 命中数契约（#188 通用部分） |
| A4 | `ca7cd47` | 2026-10-31 | fix: 收录 DSH NEXT 识别与单测（#174 #175） |
| A5 | `c63ba4a` | 2026-11-02 | fix: 工作目录字面量恢复 + 桌面退出留痕，版本 1.1.89（#202/#204/#207） |
| A6 | `8d237ba` `1bdf239` | 2026-10-31 | web 回收 / 防 PID 复用误杀并等待端口释放（#197） |
| A7 | `7fddfe3` | 2026-10-31 | fix(desktop): 换包先杀 Electron main，挪不动时把原版拉起来 (#197) |
| A8 | `6cb2ac3` | 2026-10-31 | fix: seal object JSON schemas so redteam preset loads on DSH 0.2.1 |
