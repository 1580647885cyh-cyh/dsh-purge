# #25 验证记录

> 票级记录按票分文件（#22 复盘）；本文件只记 A5-1（桌面退出留痕：close 退出码 + purge_status 读侧 + 入口五 harness）。

## 回归记录（#25 close 退出码留痕）

- **故障（本机可复现的那一半）**：#83/#84 把 close 回调的 signal 分支与 code=0 分支都改成静默 `resolve()`，
  真实退出码读完就丢；`<DSH_HOME>/dsh-purge/` 下没有任何退出记录，`purge_status` 也没有可读的一行。
  dir 形态（宿主跑 `resources/app`）下这是**唯一**还知道真实 code/signal 的地方。
- **修前红（同一套 harness 跑出来的，不是复述）**：
  - 未打补丁的同源 close 回调：harness 跑完没有任何记录（报告 `targets.runtime.exitTrace.cases` 的
    `control-unpatched`）；
  - 把补丁产物里那段留痕摘掉（拔的是生产路径上的那一段，不是直调写入器）：同一套断言读不到记录
    （`control-trace-removed`）；单测 `tests/verify/exit-trace.test.js` 里同样的对照组；
  - 读侧拿到「无」时 `read-side` 必须红（单测 `proveExitTrace 故障对照：读侧读不到记录时必须红`）；
  - 把 `typeof` 守卫与兜底 `catch` 两层都拆掉后，无 fs 作用域那一趟必须炸
    （单测 `故障对照：把 typeof 守卫与兜底 catch 都拆掉…`）。
- **实现**：
  - 补丁 #90 `DESKTOP_EXIT_TRACE`（`desktop-shell`）：在 close 回调里插一段旁听代码。
    锚点是**方法头 + suffix 两行**（rc.5 的 `(code)` 与 #83 之后的 `(code, signal)` 各一条）——
    只钉 suffix 会被宿主里任何一处同形句误伤（patch-model 用 split/join 全量替换）。
    状态先报 `pending`、应用后报 `applied`（`skipIfMarked` 保证重复应用不叠加），补丁排 #83/#84 之后。
  - 记录文件：`<DSH_HOME>/dsh-purge/exit-ledger.jsonl`，一行一条
    `{ at, code, signal, source: "close" }`；**条数上界 20、字节上界 8192（UTF-8，两侧同口径）**；
    不可解析的行在写侧丢弃、字段不合法的记录在写侧保留、读侧跳过（读侧是唯一判定者）；
    写失败只吞掉、不挡退出。
  - 两份实现、一份契约：宿主 main.js 不能 import 插件，所以规则在补丁里是**内联副本**；
    `lib/exit-ledger.js` 是同一套规则的读侧与插件内写入器。入口五的 harness 用真 fs 跑内联副本，
    再用 `lib/exit-ledger.js` 读回（条数/字节上界也在 harness 里复测）。
  - **依赖核对**：harness 从留痕代码本身读出它依赖的名字（`typeof X === "function"`），
    逐个核对它们确实是宿主 main.js 的模块级 import（fs 四件套 → `node:fs`，`homedir` → `node:os`）。
    只注入不核对的话，「注入了所以能写」证明不了真机上也能写。
  - 读侧：`core.gatherState()` 带出 `desktop_exit`，`purge_status` 输出
    「最近一次桌面退出 / desktop exit: code=… · signal=… · 时间 · 来源=close」；没有记录时是一句明确的「无」，
    读不了文件时把那句「无」带上原因（`unreadable` 不再被压成 `missing`）。
  - 入口五：`lib/verify/exit-trace.js` 的 `proveExitTrace` 跑
    `module-scope`（依赖核对）、三路退出（code=0 / 非 0 / signal）、上界、`home-fallback`（没有 DSH_HOME 时落到
    `homedir()/.dsh`）、`scope-fallback`（没有 fs 作用域时不写不炸）、`write-blocked`（目标不可写时不炸）、
    读侧（真的写进隔离 DSH_HOME，再用公开 `purge_status` 读回，要求状态行与
    `describeDesktopExit` 的输出逐字相同），以及两条拔痕对照。
- **通过证据（`npm run verify`；报告字段 `targets.runtime.exitTrace` / `targets.live.exitPatch`）**：
  - `targets.runtime.exitTrace.ok = true`：上面每个案例都 ok；`bound` 给出写 30 次后留下的条数与字节；
    `read-side` 的判定用状态行与 `describeDesktopExit` 逐字比对（不是手抄字段）；
    `targets.runtime.exitTrace.statusLine` 是**公开工具的真实输出**，报告原样引用。
  - `targets.live.exitPatch`：真实安装的壳入口被 `extraTargets` 交给逐文件核对，所以 #90 在报告里有
    明确的 `pending`（还没写进宿主）；Apply 之后同一格应为 `effective`。这条补上了「报告级 pending → applied」
    的证据（此前 desktop-shell 在真机与副本都解析不到，只剩「不适用」）。
  - 入口五 `targets.audit`：假成功 / 状态超前 / 状态落后均为 0；`targets.isolated.drifted` 为空
    （新增的 #90 没有把漂移清单顶上去）。
  - `tests` 侧：`exit-ledger`（读写/上界/损坏/读不了/写失败/读侧两态）、`exit-trace`（三路 + 上界 +
    homedir 兜底 + 无作用域 + 目标不可写 + 依赖核对 + 两条拔痕对照 + 读侧红绿）、`targets`（pending → applied、
    重复应用 0 改动）、`wiring`（读侧/证明/出口判定三处接线）、`report`（md 行原样来自状态输出）。
- **边界（不冒充真机）**：
  - `lib/verify/acceptance.js` 的 `NOT_EXECUTED` 明确写「真实桌面退出」未跑：验证只跑 close 回调 harness
    与隔离副本上的留痕读写，**没有**关掉一次真实 Electron 进程去读它自己的 code/signal。
  - `signal` 只有在 #83 之后才拿得到（rc.5 原文的回调签名不收 signal）：只打 #90 时记录里的 signal 恒为 null，
    这是宿主回调签名决定的，不是留痕的取舍。
  - 本票只落 close 一路。`before-quit` / `will-quit` / `quit(exitCode)` / 渲染进程崩溃 / 信号 / 未捕获异常
    **都没有挂**（A5 其余部分留待后续票；判定规则是先复现再动）。
  - 只 monitor：不改宿主退出行为、不改 exit code、不挡退出、不挂 `uncaughtException` 本体、
    不写官方更新 journal（那是官方升级资格的证据）。
  - 隔离验证不启动 Electron，所以「宿主进程退出时真的调用 close 回调」仍由真实桌面运行兜底；
    harness 证明的是回调整体在真实 fs 作用域下的行为，不是 Electron 的进程生命周期。
- **取舍**：
  - 记录写在 `dsh-purge/` 自建目录，不碰 `update` journal 与用户会话目录。
  - 条数上界取 20、字节上界取 8192：一次桌面退出一条（约 80 字节），20 条足够回答「上次怎么退的」，
    再多也只是把同一个信息复制得更久。
  - 来源词表当前只有 `close`。其余来源不预埋：写进去却永远不产生，会让「最近一次退出」看起来比实际更全。
  - 两份写入实现（宿主内联 / 插件内）是这条链上唯一的重复：宿主 main.js 不能 import 插件，
    只能靠入口五的 harness 把它们钉在一起（同一组案例、同一份读侧、同一套上界）。
