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
  —— 显式不留现场。
- **额外发现（本票前置）**：`officialRestartScript` 的生成体里有一条中文注释，`isWshAscii()` 恒为 false，
  所以生产上 `planOfficialRestart` **永远回落到 PowerShell**，audit 里说的「官方默认 wscript」实际不可达。
  本机又实测 `spawn("powershell.exe", { detached: true })` 直接 exit 0、不执行脚本（cmd / wscript / node
  的 detached 都正常），也就是说 fallback 路径在本机也不会真正换包。A7 的顺序要生效，先把这条注释改成 ASCII，
  恢复 intended 的 wscript 选择；成功路径由下面的 harness 证明不回退。

## 修前红（同一套 harness，不是复述）

harness：`lib/verify/desktop-swap.js`。假安装树里的 exe 是编译出来的桩（启动时记录 `pid + app.asar=present|absent`，
并独占 app.asar）；失败案例额外用一个 PowerShell 进程把 app.asar 锁住。生产入口
`restartOfficialHarness({ exit:false })` 真起脚本；脚本只按假安装根路径杀进程。

- **红 A（PowerShell 路径，修前直接实测）**：锁住 asar 后 `Move-Item` 报
  `The process cannot access the file because it is being used by another process`，但脚本继续执行到
  `$moved = $true` 并 `Start-Process`：`asar=True bak=False pending=False launches=2` —— 桌面回来了，
  换包被静默跳过。
- **红 B（wscript 失败分支，拔掉生产路径上的 relaunch）**：把 `officialRestartScript` 的失败分支退回
  `rename failed; not starting`，同一 harness 结果：
  - `failure` 组：`relaunched=false`（超时没有第二次启动）、`old-main-gone=true`、`asar-kept=true`
    （app.asar 在位、.bak 不存在）——正是「桌面被关掉且无进程回来」；
  - `success` 组仍绿（`asar-moved=true`、新进程看到 `present/absent` 的判定不变），
    只有 `script-failure-relaunch=false`，因为对照脚本里没有 relaunch。
- 两次红的对照拔的都是生产路径上的失败分支（生成脚本 / 生产产物），不是直调校验器或测试自拼判定。

## 实现

- **wscript**（`officialRestartScript`）：
  - `procs()` 取 `ProcessId / ParentProcessId / ExecutablePath`，`mainPids()` 取「父进程不在本安装进程集里」的根；
  - 先 `taskkill /F /T` main，等 `mainPids()` 为空（20s 上界）；再按 pid 清 host / renderer / runner，
    等 `pids()` 为空（10s 上界）；`allGone` 才 overlay + `MoveFile`；
  - `!renamed` 分支改成「失败也把原版拉回来」：清 `ELECTRON_RUN_AS_NODE` / `DSH_BASE`，按 home 设
    `DSH_HOME`，`sh.Run('"' + exe + '"')`，log `relaunching original` / `relaunched original`，再退出；
  - 注释改 ASCII，`isWshAscii` 恢复为 true，生产回到 intended 的 wscript 路径。
- **PowerShell**（`ASAR_SWAP_PS1`）：
  - `Get-HarnessProcs` / `Get-MainProcs` / `Stop-HarnessProcs`；先 main、等 main 空，再清其余、等全空，
    `$allGone` 才 `Move-Item`；
  - `Move-Item ... -ErrorAction Stop`，失败才进 catch 重试；
  - 失败分支不再只写 `.rename-pending`：删掉这个会毒化下一次 `scheduleAsarRenameWhenIdle` 的锁，
    清 `ELECTRON_RUN_AS_NODE`，`Start-Process` 原版；
  - 去掉不再使用的 `-WaitPid` 参数（host 先退出的竞态不再参与判定）。
- **helper**（`lib/restart-desktop.js`）：win32 kill 后 `await waitDesktopGone(info.execPath, 8000)`，确认桌面消失
  再 `releaseSealedAsar`；`asar still sealed` 分支从 `not relaunching / exit(1)` 改成
  `relaunching original` + `relaunchDesktop()`。
- **不动**：`lib/core.js` 的 `sealedAsarHandoff` / `openSealedDesktopHost`；真实安装的 apply/revert；补丁文案与能力面。

## 通过证据

- `node --test tests/verify/desktop-swap.test.js`：1 pass（本机 33.9s）。failure 组
  `engine-wscript / relaunched / old-main-gone / new-pid / relaunch-layout=present / asar-kept /
  main-gone-before-move / failure-branch` 全绿；success 组
  `asar-moved / relaunch-layout=absent / success-branch` 全绿；两组都核对生成脚本的
  `script-order`（main/allGone 在 move 之前）与 `script-failure-relaunch`（失败分支含 relaunch）。
- `npm run verify`（2026-11-03 22:15）：通过，报告
  `D:\dsh\tmp\dsh-purge-verify\20261103-221549\out\report.md`；入口五 `targets` ok。
- `npm run check`：123 个文件、2 个入口，通过。
- `tests/lib/wiring.test.js` 新增 A7 接线断言：三条路径都必须在挪 asar 前处理 main、失败分支必须拉起原版；
  `Move-Item -ErrorAction Stop`、`waitDesktopGone`、`relaunching original` 任一被拔掉都会红。

## 边界（不冒充真机）

- harness 不启动真实 Electron：断言的是「生产脚本 + 真实进程/文件锁」的行为，不是 Electron 窗口生命周期。
- wscript 是 Windows-only；非 win32 的 helper 路径没有在本机跑（helper 在 win32 仍按镜像名枚举进程，
  在假安装树上跑会误杀真实桌面 —— 见下面的边界事件）。helper 的失败分支由接线断言覆盖，
  行为模式与 wscript 的失败分支相同。
- PowerShell 的 `detached` spawn 在本机 exit 0、不执行脚本；这是本票发现的既有问题，本票没有改 spawn 形态
  （改成非 detached 可能让脚本随 host 退出一起死），只保证 wscript 主路径可用、PS fallback 的失败分支本身正确。
- 失败分支的重试窗口没有改：wscript 80×300ms、PS1 80×400ms。桌面在失败前仍有一段无窗口期；
  本票只保证窗口期结束后原版一定回来，不把「挪不动」冒成功。

## 边界事件（2026-11-03）

首轮原型探针的 fixture 漏了 app.asar（前一步锁测试把它改名了），`restartOfficialHarness` 因此落到
`unpacked-helper` 分支；`restart-desktop.js` 在 win32 按镜像名 `DeepSeek Harness.exe` 枚举进程，
把真实桌面一起杀了。真实桌面随后已重启（当前 main 13260），真实安装的 apply/revert 未被触碰。
正式 harness 加了两道防护：调用生产入口前断言 app.asar 在位（避免 unpacked-helper），
且只走 wscript 的路径过滤；helper 不在假安装树上跑。helper 的 win32 进程枚举仍是既有风险，
留作后续票（需要按安装根过滤 + 单独的真机验证）。
