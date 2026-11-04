# 探针常见坑（桌面 / 重启 / PowerShell）

> 只在写临时探针、调试桌面重启路径时读；常驻规则见 `AGENTS.md` 的「验证入口」与「桌面/重启探针」。

## 硬安全

- **asar 在位是前置断言**：调用 `restartOfficialHarness` / `restart-desktop.js` 前，先断言传入的 `app.asar` 是文件。
  缺失时生产会走 `unpacked-helper`（asar 已挪走的形态），不是换包失败；在假安装树上会让 helper 按镜像名枚举，
  可能误杀真实桌面（2026-11-03 A7 会话的边界事件）。
- **只按 fixture 根路径匹配进程**：假安装树的 exe 可以叫 `DeepSeek Harness.exe`，但不要用镜像名 / `tasklist`
  批量杀；生产脚本按 `ExecutablePath` + 安装根过滤，fixture 也必须。
- **优先复用 `lib/verify/desktop-swap.js`**：它已带 asar 前置断言、路径过滤、假 exe 桩、外部锁和启动布局核对；
  不要另写一套“差不多”的 restart 探针。

## 本机事实

- **detached PowerShell 不执行**：`spawn("powershell.exe", { detached: true })` 在本机 exit 0、不跑脚本
  （cmd / wscript / node 的 detached 正常）。验证 PowerShell 路径时用前台 / `execFileSync`，或直接走 wscript。
- **`glob` 只覆盖工作区**：对工作区外的绝对路径（宿主安装目录、`C:\…`）返回空数组且不报错；列宿主目录用 `Get-ChildItem`。
- **PowerShell 会把模块缓存写到 cwd**：`Microsoft\Windows\PowerShell\ModuleAnalysisCache` 落在进程 cwd。
  探针 / helper 的 PowerShell 调用显式 `cwd` 到 `os.tmpdir()` 或 fixture 的 tmp 目录。
- **`job_output` 单次 wait 上限 120s**：pre-commit 钩子可能 120–135s；先 `wait:false` 再分段 `wait`，
  或后台跑完再做别的。

## 写探针

- 复杂 PowerShell 写到 `D:\dsh\tmp\*.ps1` / `*.mjs`（用 `write` 工具），再 `pwsh -File` / `node file`；
  不要把 here-string / 反引号嵌进 `run_code` 的模板字符串（本机会连续 ParserError）。
- 任何 import `lib/core.js` 的探针走 `npm run probe <file>`；桌面 / 重启探针同样走它，并先读本节。
- 记录证据：命令、退出码、关键输出、端口 / 进程 PID、真实安装未改动；不要手抄单点计数（规则 9）。
