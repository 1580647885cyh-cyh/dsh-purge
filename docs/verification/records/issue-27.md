# #27 验证记录

> 票级记录按票分文件（#22 复盘）；本文件只记 A7（asar 换包顺序：先结束 Electron main，挪不动把原版拉起来）。

## 故障（本机可复现的那一半）

- **wscript**（`officialRestartScript`）：先按镜像名一次枚举、逐个 `taskkill`，等 20s 后 `left` 只 log 不中止；
  `MoveFile` 失败时 `if (!renamed) { log('rename failed; not starting'); WScript.Quit(1); }` —— 桌面已经被杀，
  失败分支既不重开也不写 pending。
- **PowerShell**（`ASAR_SWAP_PS1`）：`Stop-HarnessInstall` 一次枚举全部进程批量杀；`Move-Item` 没写
  `-ErrorAction Stop`，被锁时错误是非终止的 —— 执行继续落到 `$moved = $true`，于是 `Start-Process` 把原版拉起来，
  但 **asar 根本没挪**：桌面回来了、补丁没生效（另一种半死）。
- **helper**（`lib/restart-desktop.js`）：`if (info.asar && !asarReleased) { log("asar still sealed; not relaunching"); process.exit(1); }`
  —— 显式不留现场；win32 的进程枚举按镜像名，跨安装也会误杀。
- **额外发现（本票前置）**：`officialRestartScript` 的生成体里有一条中文注释，`isWshAscii()` 恒为 false，
  所以生产上 `planOfficialRestart` **永远回落到 PowerShell**，audit 里说的「官方默认 wscript」实际不可达。
  本机又实测 `spawn("powershell.exe", { detached: true })` 直接 exit 0、不执行脚本（cmd / wscript / node
  的 detached 都正常），也就是说 fallback 路径在本机也不会真正换包。A7 的顺序要生效，先把这条注释改成 ASCII，
  恢复 intended 的 wscript 选择；成功/失败两条路径由下面的 harness 证明。

## 修前红（同一套 harness，不是复述）

harness：`lib/verify/desktop-swap.js`。假安装树里的 exe 是编译出来的桩（启动时记录 `pid + app.asar=present|absent`，
并独占 app.asar）；失败案例额外用一个 PowerShell 进程把 app.asar 锁住。生产入口
`restartOfficialHarness({ exit:false })` 真起脚本；脚本只按假安装根路径杀进程。

- **红 A（PowerShell 路径，修前手工探针）**：锁住 asar 后 `Move-Item` 报
  `The process cannot access the file because it is being used by another process`，但脚本继续执行到
  `$moved = $true` 并 `Start-Process`：`asar=True bak=False pending=False launches=2` —— 桌面回来了，
  换包被静默跳过。这一条是上票审计之外新发现的；现在由 `-ErrorAction Stop` + 无条件启动 + pending 修掉。
- **红 B（wscript 失败分支，拔掉生产路径上的 relaunch）**：把 `officialRestartScript` 的失败分支退回
  `rename failed; not starting`，同一 harness 结果：
  - `failure` 组：`relaunched=false`（超时没有第二次启动）、`old-main-gone=true`、`asar-kept=true`
    （app.asar 在位、.bak 不存在）——正是「桌面被关掉且无进程回来」；
  - `success` 组行为仍绿（`asar-moved=true`、新进程看到 `present/absent` 的判定不变），
    只有 `script-failure-relaunch=false`，因为对照脚本里没有 relaunch。
- 两次红的对照拔的都是生产路径上的失败分支（生成脚本 / 生产产物），不是直调校验器或测试自拼判定。

## 实现

- **wscript**（`officialRestartScript`）：
  - `procs()` 取 `ProcessId / ParentProcessId / ExecutablePath`，`mainPids()` 取「父进程不在本安装进程集里」的根；
  - 先 `taskkill /F /T` main，等 `mainPids()` 为空（20s 上界）；再按 pid 清 host / renderer / runner，
    等 `pids()` 为空（10s 上界）；只有 `allGone` 且 asar 还在时才 overlay + `MoveFile`；
  - `!renamed` 分支改成「失败也把原版拉回来」：清 `ELECTRON_RUN_AS_NODE` / `DSH_BASE`，按 home 设
    `DSH_HOME`，`startExe('relaunched original')`；`startExe` 启动后等 1.5s 再用 `pids()` 核对，
    不活重试一次；
  - asar 本来就不存在（unpacked 形态）时直接记 `renamed`，不把「没有 asar 可挪」误报成失败；
  - 注释改 ASCII，`isWshAscii` 恢复为 true，生产回到 intended 的 wscript 路径。
- **PowerShell**（`ASAR_SWAP_PS1`）：
  - `Get-HarnessProcs` / `Get-MainProcs` / `Stop-HarnessProcs`；先 main、等 main 空，再清其余、等全空，
    只有 `$allGone` 且 asar 还在时才 `Move-Item`；
  - `Move-Item ... -ErrorAction Stop`，失败才进 catch 重试；
  - 失败时保留 `.rename-pending`（下一次 Apply 会重试；本票不后台拉起 watcher），成功时清掉；
  - 尾部无条件 `Start-Process`：挪动了=新布局，没挪动=原版；启动后 1.2s 用 `Get-HarnessProcs` 核对，不活重试一次；
  - 去掉不再使用的 `-WaitPid` 参数（host 先退出的竞态不再参与判定）。
- **helper**（`lib/restart-desktop.js`）：
  - `listDesktopProcs` 按安装路径过滤：win32 用 CIM 的 `ExecutablePath`（不再 `tasklist` 按镜像名），
    POSIX / macOS 用 `ps -Ao pid=,ppid=,command=`；
  - `mainProcPids` 取本安装进程树的根；`killOtherDesktopProcesses` 先 main、等它消失，再清 host / renderer，
    最后 SIGKILL 兜底；
  - `asar still sealed` 分支从 `not relaunching / exit(1)` 改成 `relaunching original` + `relaunchDesktop()`；
    `relaunchDesktop` 启动后等 1.2s 核对新 main 是否还活着（`respawn:false` 是调用方显式要求不重启，
    仍按原语义退出，不属于失败分支）。
- **host 退出顺序**：`gracefulExit` 的 1500/2000ms 固定 timer 删除。PowerShell / helper 会先结束 main、
  确认消失，再结束 host；不再让 host 抢跑。保留 `runtime.requestRestart()` 的 ack（若宿主提供）。
- **不动**：`lib/core.js` 的 `sealedAsarHandoff` / `openSealedDesktopHost`；真实安装的 apply/revert；补丁文案与能力面。

## 通过证据

- `node --test tests/verify/desktop-swap.test.js`：通过。failure 组
  `engine-wscript / relaunched / old-main-gone / new-pid / relaunch-layout=present / asar-kept /
  script-failure-relaunch / main-gone-before-move / failure-branch` 全绿；success 组
  `asar-moved / relaunch-layout=absent / script-failure-relaunch / main-gone-before-move / success-branch` 全绿。
  `main-gone-before-move` 读的是脚本日志的公开输出（`main left 0` / `procs left 0` 早于 rename），
  不是断言内部函数。
- 入口五已接 `proveAsarSwapRestart`：`npm run verify` 通过，报告
  `D:\dsh\tmp\dsh-purge-verify\20261103-224803\out\report.md`；
  `targets.runtime.desktopSwap.ok=true`，逐案例在 `targets.runtime.desktopSwap.cases`；
  `targets.audit` 的假成功 / 超前 / 落后均为空。报告 Markdown 新增「桌面换包顺序（A7）」一行。
- `npm run check`：通过。
- `tests/lib/wiring.test.js` 新增 A7 接线断言：三条路径都要显式找 main、保留失败分支的启动、
  `Move-Item -ErrorAction Stop`、pending 标记、helper 的路径过滤与启动核对；不再断言调用次数/内部位置。

## 两轴 review 后收紧

- **Spec**：helper 原来仍是「批量枚举后等待」→ 已改路径过滤 + `mainProcPids` 先 main；
  三条路径都补了启动结果核对（wscript / PS1 看安装进程是否回来，helper 看新 main 是否存活）；
  host 的固定退出 timer 删除；wscript 在 asar 本来不存在时不再误入失败分支；
  PS1 失败时保留 pending，成功才清。
- **Standards**：harness 已接进入口五/报告（不再只在测试里读）；wiring 断言去掉计数与内部索引；
  记录里的手抄单点计数/耗时删除；harness 头注释改成「跑 wscript，PS1 由接线断言覆盖」；
  README 的隔离边界补了「只按 fixture 根路径匹配进程」与首版误杀真实桌面的边界事件。
- **保留的判断题**：ASCII 注释改动是生产引擎从 PowerShell 切回 wscript，属于本票的前置修复
  （否则 wscript 失败分支在生产上不可达）；记录明写，不把它伪装成「只补失败分支」。
- **未做**：PowerShell 的 `detached` spawn 在本机 exit 0、不执行脚本；改成非 detached 可能让脚本随 host
  退出一起死，本票没有改 spawn 形态，只保证 wscript 主路径可用、PS fallback 的失败分支本身正确。

## 边界（不冒充真机）

- harness 不启动真实 Electron：断言的是「生产脚本 + 真实进程/文件锁」的行为，不是 Electron 窗口生命周期。
- wscript 是 Windows-only；非 win32 的 helper 路径没有在本机 E2E（helper 已按路径过滤，但 macOS / Linux
  需要各自的真机验证）。helper 的失败分支由接线断言覆盖，行为模式与 wscript 的失败分支相同。
- 失败分支的重试窗口没有改：wscript 80×300ms、PS1 80×400ms。桌面在失败前仍有一段无窗口期；
  本票只保证窗口期结束后原版一定回来，不把「挪不动」冒成功。
- `--only targets` 现在包含换包 harness，本机约 70s；整轮 verify 约 135s。

## 边界事件（2026-11-03）

首轮原型探针的 fixture 漏了 app.asar（前一步锁测试把它改名了），`restartOfficialHarness` 因此落到
`unpacked-helper` 分支；旧版 `restart-desktop.js` 在 win32 按镜像名 `DeepSeek Harness.exe` 枚举进程，
把真实桌面一起杀了。真实桌面随后已重启，真实安装的 apply/revert 未被触碰。
正式 harness 加了两道防护：调用生产入口前断言 app.asar 在位（避免 unpacked-helper），
且只走 wscript 的路径过滤；helper 的 win32 枚举本票已改成按安装根路径过滤，harness 仍不在假安装树上跑 helper
（它的重试窗口与本票的 E2E 时间是两件事）。
