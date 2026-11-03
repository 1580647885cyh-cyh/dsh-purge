# #29 验证记录

> 票级记录按票分文件（#22 复盘）；本文件只记 A6-1（web 启动前回收孤儿 server：记录 pid/端口 + boot 前 preflight + 防 PID 复用 + 等进程退出）。

## 故障（#28 已复现）

- **留孤儿**：`lib/restart-web.js` 用 `spawn(..., {detached:true})` + `unref()` 拉起新 server，helper 自己退出；
  新 server 的 pid 只存在于 payload 的 `DSH_PURGE_RESTART` 里，helper 一退就没人知道它。隔离复现：helper exit 0 后
  端口上仍有监听者，`DSH_HOME/dsh-purge` 下没有任何记录。
- **EADDRINUSE fatal**：0.2.1-rc.5 的 `dsh-host-webserver` 在 `listen` 出错时 reject，`bin.js` 走 startup failure
  → exit 1。隔离复现：下一次同端口 `dsh web` 得到
  `listen EADDRINUSE: address already in use 127.0.0.1:<port>`，插件 `ctx.inject(["webServer"])` 那时还轮不到。
  复现命令、退出码与端口占用者见 #28 的评论。

## 实现

- **记录**（`lib/web-reclaim.js` + `lib/restart-web.js`）：
  `<DSH_HOME>/dsh-purge/web-server-<port>.json`，字段 `pid / port / host / url / startedAt / execPath / argv / state`。
  helper spawn 后立刻写 `starting`，拿到 URL 写 `listening`；`openBrowser:false` 的 1.5s 路径写 `spawned`；
  `openBrowser:true` 20s 没拿到 URL 写 `unconfirmed` 并 exit 1（不冒充成功）；child error 删除记录。
- **boot 前 preflight**（`webReclaimEntrySource`）：
  宿主 `bin.js` 顶部 `import "./dsh-purge-web-reclaim.js"`（与 hide-console 同一套 sidecar + 顶部 import 约定）。
  自包含 ESM + 顶层 await：只认 `web`/`--profile web`，从 argv 取 `--port`（缺省 3080），
  依次尝试 `DSH_HOME`、`resolveDshHome()`、`~/.dsh` 找记录。
- **决策**（`decideWebReclaim` 纯函数，sidecar 里序列化同一份）：
  - 记录 pid 活着且在监听记录端口 → 看命令行；命令行不可读（确认占着端口）或识别为 dsh web 才杀；
  - 记录 pid 活着但监听者是别的 pid → 不杀记录 pid（PID 复用）；监听者若识别为 dsh web 才杀监听者；
  - 记录 pid 已死 → 监听者识别为 dsh web 才杀；否则清记录；
  - 无记录 → 只杀命令行能认出 `bin.js` / `dsh.cmd` / `dsh.exe` + `web` 的端口监听者；陌生进程不动；
  - 只处理本次 argv 端口对应的记录，不碰别的端口。
- **杀后等待**：`taskkill /T /F`（win32）或 SIGTERM→SIGKILL（POSIX）后轮询 pid 消失 + 端口空；
  杀不掉保留记录下次重试，不阻塞 boot。总预算 5s，所有异常吞掉（绝不抛错）。
- **注入/还原**：`installWebReclaimIntoBin` / `revertWebReclaimFromBin` 复用 `resolveDshBinRoot` /
  `looksLikeSourceCliRoot` / asar 判定；`core.silenceCmdFlash` 安装，`revertCmdFlash` 还原；
  源码 cli、sealed asar、missing bin 都按软状态处理，不挡 Apply。
- **不动**：补丁文案、能力面、真实安装的 apply/revert。

## 通过证据

- `node --test tests/verify/web-reclaim.test.js`：全部通过。覆盖：
  - 决策矩阵（记录 pid/监听者/命令行/PID 复用；kill 失败策略）；
  - 记录读写/坏 JSON/删除；
  - 注入/还原幂等 + 源码 cli 跳过；
  - 端到端：记录里的 dsh web 监听者被回收、pid 消失、端口释放、记录删除；
  - PID 复用：记录 pid 活着但没监听该端口 → 不杀、清 stale 记录；
  - 陌生端口：无记录 + 非 dsh web 监听者 → 不动；
  - 只回收本次端口：另一个端口的记录 server 不受影响；
  - helper：`openBrowser:false` 写 pid/port/state，不冒充 listening；
  - 杀不掉：伪造 `taskkill.exe` 失败 → 进程仍在、记录保留、sidecar exit 0。
- `npm run check`：通过。
- `npm run verify`：通过，报告 `D:\dsh\tmp\dsh-purge-verify\20261103-233605\out\report.md`；入口五不回退。

## 边界（不冒充真机）

- 端到端测试用真实 Node 进程/端口与真实 `netstat` / `taskkill` / `PowerShell`，但没有在测试里启动真实
  `dsh web` profile；它证明的是「preflight 在绑端口前把记录里的监听者杀掉并释放端口」，
  boot 级的 EADDRINUSE fatal 由 #28 的真实复现兜底。
- win32 的回收路径在本机实测；POSIX 走 `lsof` / `ss` / `ps` 的 best-effort，未在本机 E2E。
- 杀不掉用伪造 taskkill 模拟权限失败，不是真的 ACL/权限拒绝；记录保留策略与不阻塞 boot 的行为已覆盖。
- preflight 预算 5s；它会让每次 `dsh web` boot 多一次记录/端口检查（无记录时只有一次 netstat/端口检查）。
