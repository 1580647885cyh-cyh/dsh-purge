# #26 验证记录

> 票级记录按票分文件（#22 复盘）；本文件只记 A5-2（桌面退出留痕：quit / 渲染崩溃 / uncaught / exit 多来源 + 一次退出一条原因链）。

## 回归记录（#26 多来源留痕）

- **故障（本机可复现的那一半）**：A5-1 只落 close 一路。`quit` 的 exitCode、渲染进程消失、
  `uncaughtExceptionMonitor`、进程 `exit` 都没有记录；如果四个来源各写一行，后到的 `exit` 会把
  `quit` 的退出码挤成一条无信息记录（或反过来把 close 的 code 当成应用退出码），读侧看不出
  「这次到底为什么退」。
- **修前红（同一套 harness 跑出来的，不是复述）**：
  - 未打补丁的同源入口：close 回调跑完没有任何记录（`control-unpatched`）。
  - 把补丁产物里 close 的共享调用摘掉（拔的是生产路径上的那一段，不是直调写入器）：同一套断言读不到
    close 记录（`control-trace-removed`）；单测里同样的对照组。
  - 把 close 调用的 `typeof` 守卫与兜底 `catch` 两层都拆掉后，无作用域那一趟必须炸
    （`故障对照：把 close 调用的 typeof 守卫与兜底 catch 都拆掉…`）。
  - 读侧拿到「无」时 `read-side` 必须红（`proveExitTrace 故障对照：读侧读不到记录时必须红`）。
- **规则（写进 `lib/exit-ledger.js` 与宿主内联副本，同一份契约）**：
  1. 一次进程运行 = 一个 episode；同一 episode 的多个来源合成**一条**记录，不追加第二行。
  2. `source` 记第一个来源（原因链起点），`chain` 按触发顺序去重。
  3. `terminal` 记第一个终结性来源（quit / exit）；退出码以终结性来源优先、先到者优先：
     quit(3) 之后的 exit(0) 不会把 3 冲成 0；quit 没给码时 exit 的码才补空位。
  4. 非终结来源（close / render-crash / uncaught）只补空位、不覆盖已有值；`detail` 保留第一条原因说明。
  5. 跨进程运行（episode 不同）各留一条；条数 20 / 字节 8192 的上界不变。
- **实现**：
  - 补丁 #91 `DESKTOP_EXIT_TRACE_SOURCES`（`desktop-shell`）：锚点是宿主 `node:fs` 那条 import，
    插在模块作用域（只求值一次、早于 app ready），挂 `app.on("quit")`、单点
    `app.on("web-contents-created")` → 每页 `render-process-gone`、
    `process.on("uncaughtExceptionMonitor")`、`process.on("exit")`。只旁听：不改退出行为、
    不改 exit code、不挂 `uncaughtException` 本体、不写官方更新 journal。
  - 补丁 #90 `DESKTOP_EXIT_TRACE`：close 回调改成调用 #91 定义的共享写入器；A5-1 的内联块
    由一条迁移正则整段换掉（升级不叠加第二份）。两种 close 签名各一条。
  - 内联代码住在 `lib/desktop-exit-trace.js`（字符串常量），上界从 `lib/exit-ledger.js` 取，
    改上限只改一处；入口五 harness 用真 fs 跑同一段代码。
  - 读侧：`describeDesktopExit` 在多来源记录上追加 `链=…`、`终结=…`、`原因=…`；
    `purge_status` 那一行仍原样来自它。
- **通过证据（`npm run verify`；报告字段 `targets.runtime.exitTrace` / `targets.live.exitPatch` /
  `targets.live.exitSourcesPatch`）**：
  - `targets.runtime.exitTrace.ok = true`：`source-quit` / `source-render-crash` /
    `source-uncaught` / `source-exit` 各落一条；`multi-source` 的 uncaught→quit→exit
    只剩一条、chain 有序、code=3；`multi-source-no-overwrite` 的 quit=5 → exit=0 仍是 5；
    `close-then-quit` 的 close→quit→exit 合成一条；`hook-single` 四个挂点各 1、每页
    render-process-gone 各 1、uncaughtException=0；`bound` 30 次退出留 20 条；
    `corrupt` 坏行不抛；`read-side` 状态行与 describe 输出逐字一致。
  - `targets.live.exitPatch` / `targets.live.exitSourcesPatch`：#90 / #91 在真实安装上
    各有明确 pending（还没写进宿主）；Apply 之后同一格应为 effective。
  - 入口五 `targets.audit`：假成功 / 状态超前 / 状态落后均为 0；`targets.isolated.drifted` 为空
    （新增 #91 没有把漂移清单顶上去）。
  - tests 侧：`exit-ledger`（五来源 / episode 合并 / 先到终结码 / 上界 / 损坏 / v1 兼容 / 状态行）、
    `exit-trace`（四来源 + 单点挂 + 合并 + close 生产路径 + 上界 + 作用域兜底 + 依赖核对 +
    故障对照 + proveExitTrace 红绿）、`targets`（#90 迁移 + #91 挂点）、`wiring`（#91 在 #90 之前、
    上界单源、标记）。
- **边界（不冒充真机）**：
  - `NOT_EXECUTED` 明确写「真实桌面退出」没跑：quit / render-process-gone /
    uncaughtExceptionMonitor / process exit 四路只在入口五用事件替身模拟，验证不启动 Electron。
  - 渲染崩溃的替身只验证「监听器收到 details 后写什么」，不证明真实 Chromium 进程崩溃的时序；
    宿主若在 `web-contents-created` 之前创建 WebContents（本版没有），会漏挂。
  - `close` 仍是子进程退出码；它先于 quit 到达时链里保留 close，但终结码以 quit/exit 为准。
  - 记录写在 `dsh-purge/` 自建目录，不碰 update journal 与用户会话目录。
- **取舍**：
  - 一个 episode 一条记录而不是每来源一行：读侧只回答「最近一次退出」，一行能解释原因；
    多行会让「最新一行」变成最后触发的那个无信息事件。
  - `source` 记首因而非终结来源：先发生的原因（uncaught / render crash）才是解释退出的那一条；
    终结来源另用 `terminal` 字段。
  - 宿主 main.js 不能 import 插件，内联副本仍是这条链上唯一的重复；入口五用同一组案例
    + 同一份读侧把它钉住。
