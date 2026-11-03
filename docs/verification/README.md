# 隔离验证入口（保护基线 + 宿主加载 + 管理生命周期）

对应任务：[#2 封存 1.1.71 保护基线并建立最小隔离验证入口](https://github.com/1580647885cyh-cyh/dsh-purge/issues/2)。

目标是用当前真实源码与当前安装的 Windows 官方桌面 DSH 0.2.1-rc.5，建立一条可重复、可核对、只写 D 盘的最小验证路径；不在本入口修复后续任务负责的兼容缺陷。

## 先选入口

| 你要做的事 | 跑哪个 | 看哪一节 |
| --- | --- | --- |
| 改补丁/适配行为，要全量取证 | npm run verify | 入口一到五（报告在 out/report.md） |
| 临时探查、跑一次性脚本、调 lib/core.js | npm run probe <file> | 隔离边界 + 文件索引（用法见 scripts/probe.mjs 头注释） |
| **verify 红了、而且只红在某一段**（某入口 / 某段模型调用） | 先用 `npm run probe <file>` 复现那一段，不要连跑整轮 verify | 同一节。整轮一轮 ~70 s，探针 ~10 s；2026-11-03 用一个 20 行探针两分钟定位了"反向案例 0 请求"的竞态，之前已经空跑了 4 轮整轮 |
| 交付/升级后的整体验收与兼容记录 | npm run acceptance | 入口六（产物在 docs/compatibility/） |
| 提交前机械检查 | npm run check / npm test | 钩子与测试 |

## 运行方式

~~~powershell
cd D:\dsh\local-plugins\dsh-purge
npm run verify                 # 封存基线 + 宿主入口 + 隔离管理入口
npm test                       # 单元测试 + 隔离集成测试
node scripts/verify.mjs --json # 输出机器可读报告
~~~

可用参数：--root（插件源码根）、--install（桌面安装目录）、--out-root（工作区根）、--baseline-dir（基线目录）、--stamp（固定工作区名）、--no-seal（只校验不封存）。

只改入口五时用 `node scripts/verify.mjs --only targets`：跳过宿主加载、预设、受控端点与管理生命周期，只跑
目标定位与适配状态（含逐文件核对与运行结果证明、桌面换包 harness），本机实测约 70 s；报告写「范围：只跑了 targets」，
结论只对跑过的阶段负责。整轮结论仍以不带 `--only` 的那一轮为准。

报告字段用 `node scripts/report-fields.mjs [latest|<stamp>|<report.json>] <点路径…>` 读，不要现写一次性脚本、
也不要把脚本留在仓库根（#25 retro）。

产物：

- 保护基线：D:\dsh\data\dsh-purge\baseline\baseline-<stamp>.json 与 latest.json，只在 D 盘，不进仓库。
- 本次工作区：D:\dsh\tmp\dsh-purge-verify\<stamp>\，含 out/report.json、out/report.md、out/prompt.txt、out/context.txt、out/tool-contracts.json。
- fixture 缓存（#11）：D:\dsh\tmp\dsh-purge-verify\_fixture-cache\asar-<size>-<mtime>\。命中时整棵复制，未命中才从 app.asar 解；
  缓存不属于工作区，删掉整个目录只让下一轮变慢，不影响任何断言。
- 工作区清理（#13）：每轮开始时保留最近 5 个**旧**工作区（`--keep N` 可改，`--no-prune` 关闭），本轮另算；
  其余删除并在报告 `retention` 段记账。跳过的是：本轮自己的、30 分钟内有过写入的（按目录树最深一层判）、名字不匹配的。

报告只汇总结构性事实（长度、哈希、段名、工具名、文件差异）；提示词全文、工具契约全文只落在隔离工作区。

## 报告字段速查（report.json）

断言和文档都引用这里的字段，别抄控制台串（#22 复盘：写「漂移=N」「applied=N」会随着口径和打印格式漂）。

| 字段 | 是什么 |
| --- | --- |
| `ok` / `generatedAt` | 整轮结论与时间戳（`kind` 恒为 `dsh-purge-verify`） |
| `workspace` | 本轮隔离工作区：`root` / `home` / `install` / `out` |
| `fixture` | 宿主副本来源：`source`（cache / asar / install）、`packages`、`cacheHit`、`cacheKey`、`rebuildReason`、`durationMs` |
| `baseline` | 保护基线：`file`、`treeHash`、`fileCount`、`sealCheck`、`drift`、`plugin`、`host`、`git` |
| `retention` | 工作区清理：`keep`、`kept`、`removed`、`freedBytes`、`skippedReasons` |
| `hostEntry` | 宿主加载：`tools`、`sections`、`variables`、`templateContract`、`promptPreset`、`toolBridge`（`prompt` 是全文，只在工作区里） |
| `admin.diffs` | 管理入口的文件差异：`apply` / `reapply` / `revert`，各含 `changed` / `added` / `removed` 与文件名列表 |
| `admin.backupFaults` | 备份/恢复故障注入的逐案例结果（完整 / 过期 / 0 字节备份） |
| `targets.isolated` | 隔离副本的补丁事实：`statusBefore`、`statusAfter`、`summary`、`applied`、`drifted`、`unmatched`、`unresolvedKeys`、`diffs` |
| `targets.live` | 真机安装的同类事实（无 `statusBefore/After`，另有 `shellFile` / `shellCandidates`） |
| `targets.audit` | 状态与文件是否一致：`falseSuccess`、`ahead`、`behind`、`settledByLayout` |
| `targets.runtime` | 入口五的运行结果证明：`completePrompt`、`shell`、`exitTrace`、`desktopSwap`、`presetFetch` |
| `targets.desktop` | 入口五的 NEXT 安装树（A4 / #24）：`facts`（形态 / exe / 是否换包 / 壳入口 / 进程名）与逐条 `cases`（含 `control-red` 拔名单对照） |
| `modelToolCall` / `modelToolCallRejected` | 受控端点上的有效调用与工具集外调用 |
| `presetEntry` / `presetMigration` / `presetAudit` | 预设注册、迁移与静态审计 |
| `pendingSelfHeal` | 已安装副本仍是旧写法、等下次启动自愈的项（不算失败） |
| `knownFailures` | 已复现且归属明确的故障；非空时验收不通过 |
| `commands` | 本轮实际执行过的命令 |

`report.md` 是同一份数据的渲染版：字段名不变，另外把「状态与文件一致」一类结论写成一句话。

## 隔离边界（硬性约束）

1. 全部路径经 assertDriveDPath 校验，工作区、DSH_HOME、缓存、临时目录、日志和宿主副本都在 D 盘。
2. 进程环境会切换到隔离目录：DSH_HOME、DSH_SURFACE=desktop、DSH_DESKTOP_INSTALL、DSH_BASE、LOCALAPPDATA、APPDATA、TEMP/TMP、USERPROFILE，PATH 指向空目录。
3. PATH 清空后，宿主的注册表/运行进程/快捷方式发现不再命中本机真实安装；只保留 DSH_DESKTOP_INSTALL 指向的副本。
4. 管理操作前先调用插件的公开枚举 enumeratePatchAiBases({discover:true})，任何宿主不在工作区内就中止。
5. 真实安装只读：记录真实安装 targetFiles 的 stat（本次运行 55 个文件），管理操作结束后确认 mtime/size 全部未变。
6. 真实 DSH_HOME 只读：只读取 .agent-presets 做静态审计；真实会话、凭据、工作区不参与验证。
7. 不启动 Electron、不发送真实模型请求；宿主包（cordis、system-prompt、tools）以模块方式只读加载。
8. `app.asar` 是未打补丁的解出源，`resources/app` 是当前运行中的已打补丁副本：判断「官方原文」看 asar，判断「现在生效什么」看 `resources/app`。
9. 隔离环境清空 PATH 后，桌面 exe 发现不会回落到真实安装，所以 `desktop-shell` 只在真实安装的只读定位里出现；隔离副本里的桌面壳用 asar 解出的 `lib/main.js` 单独证明。
10. 任何要走 `apply*` 的临时脚本必须用 `npm run probe <file>`：它切隔离环境、预检宿主范围，并在操作前后核对真实安装目标文件的 stat。
    **探针里 `import` 本地绝对路径必须写成 `file:///D:/…`**：Windows 下 Node 会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，白丢一轮。
11. #11 的 fixture 缓存在工作区**旁边**（`tmp/dsh-purge-verify/_fixture-cache/<key>`），不是工作区的一部分：不进保护基线
    （基线只走仓库源码）、不进工作区快照（副本仍落在 `<stamp>/desktop`）、也不参与真实安装守卫（守卫只核对真实安装的
    targetFiles）。缓存按「先写临时目录、再换名」落盘，半成品永远不会被当成命中。
12. #13 的工作区清理只碰验证根的**直接子目录**，且只认 `<YYYYMMDD-HHMMSS>` / `probe-<同样的戳>`：`_fixture-cache`、
    `acceptance-commit`（`docs/compatibility/` 引用了它下面的路径）、测试式命名与普通文件都不动；本轮工作区不删，
    目录树里 30 分钟内有过写入的也不删（按最深一层判），跳过原因按类计数进报告。清理失败只记 `retention.error`，
    不让验证失败。
13. 桌面换包 harness（A7 / #27）只按 fixture 安装根路径匹配进程；调用生产入口前断言 app.asar 在位，
    只走 wscript 的路径过滤。首版原型曾因 asar 缺失落到 unpacked-helper，helper 按镜像名杀进程误伤真实桌面；
    正式 harness 不再在假安装树上跑 helper。

## 入口一：保护基线封存与校验

模块：lib/verify/baseline.js。

- 清单：随包文件与文档/脚本（排除 .git、node_modules、.scratch），记录每个文件的 sha256 与大小，并用排序后的「路径 + 哈希」生成 treeHash。
- 指纹：插件版本、本地更新锁、dshTarget、package.json 哈希；宿主 shell 版本、runtime 版本、buildCommit、app.asar 大小与 mtime；Node/Electron/platform/arch/surface。
- 历史关系：本地分支、HEAD、未提交文件数、远端列表，标记是否用户仓库（1580647885cyh-cyh/dsh-purge）与上游参考仓库。
- 校验：与已封存清单逐文件比较，报告新增、删除、修改；新快照生成后再自检一次，避免封存过程中变化被漏掉。
- 早期备份与上游内容不参与封存，也不会覆盖当前源码。

期望来源：用户确认的当前源码本身（封存清单），不是新实现的输出。

## 入口二：宿主加载与请求准备（主入口）

模块：lib/verify/host-entry.js。

- 用真实宿主包 0.2.1-rc.5 的公开 API：cordis 的 Context/plugin、dsh-system-prompt 的 SystemPrompt 与 renderPrompt、dsh-tools 的 ToolRuntime 与 assertObjectJsonSchema。
- 插件通过 ctx.plugin() 真实加载；与 dsh-agent-loop 一致只注册 provider/model 两个装配变量。
- 捕获：装配段名与长度、renderPrompt 文本（长度/sha256/前 120 字符）、上下文快照、工具契约（名称、参数键、参数哈希）以及宿主 Schema 校验结果。
- 模板渲染契约（#5）：用插件加载后的真实装配变量渲染六类案例——旧模板、自定义模板、空后缀、缺失后缀、正常工作目录、缺失工作目录；期望值是保护基线的模板字面量，任一案例失败即本次验证不通过。
- 完整提示词预设（#5）：读取随包预设的 persona 行配置（宿主自带 yaml 包解析），按该预设声明会话，再走装配 → 渲染 → 真实装配内模板 → 运行上下文快照 → 重复装配稳定性 → required 运行上下文在抑制/刷新下的生命周期；受控请求的消息按 dsh-agent-loop 的顺序组成（系统提示词、本轮用户消息、运行上下文快照），端点侧只记录角色、长度、哈希与标记命中。
- 工具桥接探针（#3）：先按隔离桌面布局（DSH_DESKTOP_INSTALL → resources/app/dsh/node_modules）解析 @deepseek-ai/dsh-tools，确认候选命中且结果落在隔离副本内；再只读地把锚点指向真实桌面安装，导入 lib/redteam/tools.js，确认 defineTool 真的加载出来（预设行 dsh-purge/redteam/tools 的前置条件）。
- {{cwd}} 模板由插件补回的装配变量渲染（#5，见 [records/issue-5.md](records/issue-5.md)）；已安装 redteam 预设仍写已废弃 toolFilter 时进「待自愈」，不算已知故障。

不覆盖：Electron 桌面进程、真实 HTTP 模型请求、模型回答质量。

## 入口三：管理生命周期（补充入口）

模块：lib/verify/admin-entry.js。

- 隔离副本从 app.asar 解出未打补丁的宿主包（#6 起补齐 targetFiles 实际引用的落点，另加 cordis/schemastery/dsh-scope/@standard-schema 与 pi-ai 的 dist/api），而不是复制当前已打补丁的安装目录；apply/revert 的覆盖面随之变大（本次 apply 改 47 个文件、revert 全部还原）。副本里没有桌面 exe：隔离环境清空了 PATH，补丁管线按设计不把真实安装当落点。
- #11 起副本优先来自 fixture 缓存：键是 app.asar 的 size + mtime，命中就整棵复制，未命中才逐包解归档。报告 `fixture.source` 区分
  `cache` / `asar` / `install`（最后一种是宿主没有 asar、只能复制安装目录）；缓存缺失、半成品、少包、宿主版本对不上都会自动重建，
  缓存目录写不进去也只回退到「从 asar 解」，不让验证失败。
- 通过插件公开注册的工具依次执行 purge_status、purge_apply、再次 purge_apply、purge_revert，并逐步比较文件哈希。
- 观察项：apply 是否写入副本、重复 apply 是否稳定、是否产生 .dshpurge.bak、revert 是否真的还原。
- hostFs 文件描述符探针复刻备份占位 fd 的创建与 rename，记录缺失方法与错误码（#3 起要求 present 齐全、无 fd 泄漏、rename 成功）。
- 文件种类探针（#3）：用同一套公开函数处理三个文件——带 shim 签名的文本入口、二进制、普通文本——记录 `shimFileStatus` 前后结果、`patchShim` 返回值、二进制字节是否保持、普通文件是否被写入。基线只把带 shim 签名的文本当入口，普通文本按原语义与二进制一样不注入；探针校验的是“不误写”。

## 入口四：预设注册与工具契约（#4）

模块：lib/verify/preset-entry.js、lib/verify/model-endpoint.js。

- 预设行入口：真实宿主的预设是把 agent.cordis.yml 里每一行交给 cordis ctx.plugin(模块, 行 config)。丢弃 toolFilter 后，挂载断在 tool-subagent 这一行的 apply 上。入口四按同一条路径挂载该行：负向（把旧 toolFilter 加回去）必须复现宿主报错，正向（迁移后）必须挂上，worker 组合必须只少 tool-subagent-fork / tool-workflow / tool-ralph 三行。
- 已安装副本迁移：真实 DSH_HOME 只读；副本复制到工作区后执行与插件启动时相同的迁移，比对“只删除 toolFilter 那几行、只新增 agentPreset 与一行说明”，并连续迁移两次确认幂等。真实副本仍是旧写法时，报告把它列进「待自愈」，不算已知故障。
- 组合校验：用宿主 registry 导出的 entryListProblem 校验迁移后与 worker 的行列表。
- 参数契约：对每个已注册工具用宿主自己的 validateJsonSchemaValue 跑两类案例——空参数对象必须被接受，未声明的额外属性必须被拒绝（结论在 hostEntry.tools[].contract）。
- 受控模型端点：本机 127.0.0.1 上的假 OpenAI 端点 + 真实 dsh-llm / dsh-llm-pi-ai 适配器；模型产出的 tool_call 交给 ctx.tools.execute，走宿主自己的参数校验与工具主体。第二轮让模型点名一个不存在的工具，宿主必须返回 unknown tool。

已知局限：不启动 profile 的 Loader 与整条服务图，所以证明的是失败单元（行 config）与组合等价性；整份预设一次挂载成功由真实桌面运行（#7）兜底。假端点不写真实凭据，密钥只放在进程环境里。

子级预设的挂载代价：registry 会为红队模式和 redteam-worker 各挂一份组合（两者同一 scope 机制、各在自己的 isolate realm 里发布服务，因此不会在 root realm 重复注册；预设头部对“服务行必须带 isolate realm”的约定不变）。

### 入口三附加：备份/恢复故障注入（#7）

模块：lib/verify/backup-faults.js（在管理生命周期跑完之后执行，同一隔离副本）。

- 小副本：从刚 revert 干净的隔离副本复制真实官方样本（agent-instructions、standard preset）到 `out/backup-fixture`，
  故障注入只动这份副本，不污染管理生命周期与入口五的现场。
- 完整备份：**备份之前**先记下目标原文 → `backupAll` → `applyPatches` → `revertAll`，还原结果必须与那份原文逐字节一致（不拿 bak 自证）。
- 官方标记识别：官方原文自带 #2/#3/#50 的「完成标记」，放回官方文件 + 旧 bak 后，`refreshStaleBaksForUpgrade` 仍必须刷新 bak（这类补丁带 `provenance: false`，不能充当「我们改过」的证据）。
- 过期备份刷新：把目标换成「官方新版」内容（满足 #24 的目标态、没有我们的标记），bak 改成旧版本；刷新后的 bak 必须与新版内容逐字节一致。
- 过期备份不写回：随后 `revertAll` 后，目标仍必须与新版内容逐字节一致。
- 不完整备份：目标有效、bak 为 0 字节；`revertAll` 必须保留目标字节，并在 errors 里报 `backup_empty`。
- 五个案例全过才算管理入口通过；失败即「验证不通过」。

## 入口六：验收与兼容修订记录（#8）

模块：`scripts/acceptance.mjs`（`npm run acceptance`）、`lib/verify/acceptance.js`。

- 跑一遍完整隔离验证，再把报告收敛成兼容修订记录：宿主指纹（shell/runtime/buildCommit/app.asar）、插件版本与本地锁、
  十个入口的逐项结果、已确认不适用项（带搜索位置）、未执行的检查、独立恢复材料（保护基线快照 + treeHash）。
- 本地锁按实际行为核对：`assertRemoteUpdatesAllowed()` 必须抛 `ERR_DSH_PURGE_LOCAL_VERSION_LOCK`，
  `localLockedUpdateStatus()` 必须 `locked/pinned`；插件版本必须是 1.1.71 且 `remoteUpdates:false, editable:true`。
- 记录只含结构性事实，不含提示词正文、凭据或会话内容；默认写到 D 盘，`--out DIR --name BASE` 可把一份稳定记录放进仓库
  （当前提交的是 `docs/compatibility/rc5-acceptance.md` 与同名 .json）。
- 记录里还有：兼容修订目录（每项改动的故障/修复/回归证据）、「补丁对不上但不是失败」逐条落点、
  本地依赖来源与手动编辑的实际证据。
- `docs/compatibility/` 不算进保护基线（它是验收产物，不是待恢复源码），否则每写一次记录都会让
  `--no-seal` 报漂移、恢复材料也对不上。
- 「未执行的检查」逐条列出（真实 Electron 进程、真实模型网络、Web/macOS/Linux 与其他版本），不因为没报错就当作通过。

### running 的两个坑（2026-11-03 复盘）

- `npm run acceptance -- --out DIR` 会被 npm 吞成位置参数（`--out` 变成未知配置）：写记录要用
  `node scripts/acceptance.mjs --out DIR --name rc5-acceptance`，否则记录里的命令行与实际产物名对不上。
- `acceptance` 只打印**记录**路径；这一轮的隔离验证报告在 `D:\dsh\tmp\dsh-purge-verify\<stamp>\out\report.md`，
  要最新一份就按目录 mtime 取，别按名字排序（旧目录叫 `smoke2`、`report-check2` 之类）。

## 入口五：目标定位与适配状态（#6）

模块：lib/verify/targets.js、lib/verify/target-entry.js。

只回答两个事实问题：补丁要处理的文件在当前宿主里落在哪；应用之后目标文件里到底有没有目标态。

- 只读定位：用 targetFiles 在真实安装（真实 DSH_HOME 只读）上解析每个键，记录解析到的路径；缺席的键列出实际搜索过的位置（hooks 包、liangshen 预设、user-approval 的 invariant.js 等）。
- 隔离副本逐文件核对：purge_status → purge_apply → 对每个补丁的每个目标文件调用 patchEffectState，分成「目标态 / 还能匹配到待改原文 / 两者都不成立 / 不适用」；再用 patchOwnMarkPresent 把目标态拆成「处理写进了文件」与「宿主本来就满足」（#24 的 preset 本来就写 fetch: true 属于后者）。重复 purge_apply 后再比较整棵副本，必须 0 改动。
- 状态一致性：状态说 applied/already 但文件里两者都不成立 → 假成功；状态说 applied 但文件里还有待改原文 → 状态超前；状态说 pending 但文件里既没原文也不是目标态 → 状态落后。布局软补丁（身份句、审批句）单独列成「按布局结算」，不计入成功证据。
- 不适用与未定位：整行缺席的补丁按 optional 标注列出搜索位置；单个键缺席（*-nested、hooks、user-approval/invariant.js）单独列成未定位键，不被同补丁其他落点的成功吞掉。
- 运行结果证明（都带故障对照，不是只看字符串）：
  - 完整提示词装配：在应用后的副本里 import 宿主自己的 dsh-system-prompt，挂一个 complete 段 + dsh-purge 段 + required 上下文，走 assemble；要求注入段与 complete 段共存、抑制运行上下文后 required 仍在。对照：同一装配在未打补丁的真实宿主上必须丢掉注入段。
  - 桌面壳 close 回调：从 app.asar 解出 lib/main.js，先在未打补丁的入口上跑 code=0（必须报错），再按补丁替换后跑 code=0 / code=3；要求前者不 fail、后者报错、重复应用 0 改动。
  - NEXT 发行形态（A4 / #24）：在工作区里造一棵 `DSH NEXT` 安装树（exe + `resources/app` + 可选 app.asar 变体），
    用同一份生产名单核对四项：exe 定位、壳入口、带 asar 变体不换包、win32 进程名集合含 NEXT（报告 `targets.desktop`）。
    `surface` 只记事实（resources 启发式本来就能把桌面判出来）；形态（`form`）与另外三项一起判红——
    认不出形态，后面三项必然为空。差异见 [records/issue-24.md](records/issue-24.md)。
  - preset fetch 落地：在副本上把 tool-web 的 fetch 改成 false，再走公开的 purge_apply；要求重新打开并写回标记，重复应用不追加。
  - 桌面换包（A7 / #27）：在工作区里造假安装树（编译的 exe 桩独占 app.asar + 记录每次启动看到的布局），
    用生产入口 `restartOfficialHarness` 起 wscript 换包脚本；失败案例用外部 PowerShell 锁住 app.asar。
    要求：`main left 0` / `procs left 0` 早于 rename；成功 = asar 换到 `.bak` 且新进程看到 `absent`；
    失败 = asar 仍在原位且原版按 `present` 布局重新拉起（报告 `targets.runtime.desktopSwap`）。
  - 桌面退出留痕（A5-1 / #25，A5-2 / #26）：#91 把多来源块插在宿主 fs import 之后（模块作用域、只挂一次），
    #90 让 close 回调调用同一个写入器。入口五先核对这段代码依赖的名字确实是宿主 main.js 的模块级 import
    （fs 四件套 → node:fs、homedir → node:os、app → electron；只注入不核对就是证据自造），
    再注入同一批函数、一个事件替身 app 与一个只带 DSH_HOME 的 process，按时序 emit
    quit / web-contents-created→render-process-gone / uncaughtExceptionMonitor / exit：
    四个来源各落一条、来源字段可区分；一次退出的多来源序列合成一条（chain 有序、source 记首因、
    quit 的退出码不被后到的 exit 冲掉）；渲染崩溃只在 web-contents-created 单点挂一次、不挂 uncaughtException 本体；
    30 次退出仍不超条数/字节上界；没有 DSH_HOME 时落到 homedir()/.dsh；没有 fs 作用域 / 目标不可写 /
    半写损坏记录都必须安静跑完（兜底分支也是产物）。写完再用公开的 purge_status 读回「最近一次桌面退出」那一行，
    要求它与 describeDesktopExit 的输出逐字相同（多来源记录带原因链与终结来源）。故障对照两条：拔掉 close 回调里
    那段调用（拔的是补丁产物里的那一段，不是直调写入器）后必须没有记录；未打补丁的同源入口本来就不写。
    对照见 [records/issue-25.md](records/issue-25.md) 与 [records/issue-26.md](records/issue-26.md)。
- 宿主版本与适配状态（A1 / #18）：读桌面壳 `resources/app/package.json` 的 version，与插件声明的 `dshTarget` / `dshTargets` 精确比对，分「已适配 / 未适配 / 未知」三态。**三态都不影响 record.ok**——未适配只写进报告与状态，不挡 Apply（阻断会把人锁在门外）。
- 漂移清单（A2 / #19）：文件在、但既不是目标态也没有可改的原文，且不属于布局软结算的补丁，逐条列成「补丁 → 文件 → 没命中的锚点（首行 80 字符）」。布局软补丁仍走「按布局结算」，不混进漂移。漂移不挡 Apply，但状态词必须写 `drifted`，不能压成 `skipped` / `applied`。
- 只在报告里保留计数、路径与通过情况；提示词正文不进报告。

## 期望来源与允许的表示差异

期望来源：已封存的保护基线、宿主公开 API 的既定行为、已安装预设文件、本文件记录的已知故障。验证不生成 golden 输出，也不把新实现输出当作正确答案。

允许的表示差异：

- 提示词空白与换行归一、provider/model 的具体取值、prompt-inject.md 的本机内容（不参与断言）。
- 工具描述文本长度、参数键顺序（以集合与哈希比较）。
- 报告时间戳、工作区路径、文件 mtime。
- 验证入口的 working-directory 运行上下文按 dsh-working-directory 的公开契约复刻（name/order/required/JSON 引号目录），不加载该包的完整服务图；快照长度随目录路径长度变化。
- 受控请求以端点摘要（角色/长度/哈希/标记命中）呈现，提示词与上下文正文只留在隔离工作区。
- .bak 的字节内容不作为 golden；但「apply 是否产生 bak」「revert 是否用 bak 还原」是验收项（#3）。

不允许的差异：

- 提示词段缺失、工具名缺失、装配变量集合变化（#5 起必须含 cwd）。
- 模板渲染契约任一案例失败、完整提示词预设任一核对项失败（#5 起是硬契约，不再记成已知故障）。
- 受控请求的系统消息没命中插件正文，或运行上下文消息没带工作目录。
- 宿主 Schema 校验从通过变成失败。
- 备份/恢复故障注入任一案例失败：完整备份不能逐字节还原、过期 bak 未刷新、revert 把旧版本写回新宿主、0 字节 bak 覆盖有效目标。
- apply 在未打补丁副本上没有任何文件改动。
- 重复 apply 再次改动文件。
- 真实安装目标文件在管理操作期间发生变化。

## 先例探针的局限

已有两个临时探针可作为定位参考，但不能独自证明桌面兼容：

- D:\dsh\tmp\check-cwd-compat.mjs：直接从 app.asar 用正则抽取 renderer 的声明和函数，再在 vm 中执行。它能证明特定 {{cwd}} 报错，但不经过宿主插件加载、预设注册或工具注册；抽取表达式会随宿主编译产物变化而失配。
- D:\dsh\tmp\check-local-lock.mjs：直接 import 插件的 update/ui 私有模块，并用 data: URL 临时暴露更新处理函数。它能证明更新锁拒绝远程操作，但不是宿主公开调用路径，也不覆盖提示词与工具。

本入口的改进：宿主公开包 + cordis 真实加载 + 真实工具注册表 + 独立宿主副本 + 真实安装只读守卫。仍未覆盖真实 Electron 进程与真实网络请求；桌面换包 harness 用假 exe 与真实 wscript 进程模拟脚本行为。

其他已知局限：管理入口调用的是插件在 ToolRuntime 中注册的定义（execute），不经过 agent loop 的 pre-execute 瀑布与 guard 链；真实安装守卫比较 mtime 与 size，不逐字节比较内容。

## 边界事件与修复记录

首次原型把 DSH_HOME/DSH_BASE 指向 D 盘副本，但宿主的 discover 分支仍通过注册表/运行进程/快捷方式找到真实安装；purge_apply 因此在 2026-11-02 16:35:57 至 16:36:02 重写了真实安装的 50 个已打补丁文件（内容为已应用状态，未执行 revert，未写入用户会话或凭据）。

修复：隔离环境清空 PATH，使 discover 分支无外部信息可查；管理操作前强制预检宿主枚举范围；操作前后对比真实安装 targetFiles 的 stat，并在报告中输出「真实安装目标文件：未改动（55 个）」。该事件保留在此，提醒后续实现不要放宽发现范围。

## 已知故障台账

这些条目由报告自动生成并附证据；修复对应任务时应先让条目消失，而不是修改本台账。

#4 起，预设的旧 toolFilter 不再记成已知故障：迁移在隔离副本上验证（见入口四），真实
DSH_HOME 里的已安装副本仍是旧写法时，报告只在「待自愈」一节列出，等插件下次启动就地迁移。

#5 起，{{cwd}} 模板不再记成已知故障：插件在 apply 时用宿主公开的 SystemPrompt.variable
注册 cwd 变量。模板渲染契约与完整提示词预设同时改成硬契约——任一案例失败即「验证不通过」，
不再降级成已知故障条目。

#6 起，目标定位与适配状态也是硬契约：假成功、状态超前、重复应用仍在改文件、运行结果证明失败，
任一条出现即「验证不通过」；缺席的可选键在报告里逐条列出搜索位置，属于不适用而不是失败。

#7 起，备份/恢复的故障注入也是硬契约：完整备份还原、过期备份刷新、0 字节备份拒绝写回，
任一案例失败即「验证不通过」（见入口三的 backupFaults）。

## 票级记录（回归与验收）

每票的「回归记录 / 本票验收对应」按票分文件放在 `records/`（#22 复盘：这一节会线性增长，不再往 README 里追加）。
新票直接写 `records/issue-<编号>.md`，然后在下表加一行。

| 票 | 主题 | 记录 |
| --- | --- | --- |
| #2 | 封存 1.1.71 保护基线并建立最小隔离验证入口 | [records/issue-2.md](records/issue-2.md) |
| #3 | 桌面宿主依赖解析与文件探测 | [records/issue-3.md](records/issue-3.md) |
| #4 | 恢复现有预设加载并保持工具参数契约 | [records/issue-4.md](records/issue-4.md) |
| #5 | 恢复模板渲染和完整提示词预设运行 | [records/issue-5.md](records/issue-5.md) |
| #6 | 恢复 rc.5 目标定位并让适配状态反映实际结果 | [records/issue-6.md](records/issue-6.md) |
| #7 | 隔离宿主应用与跨版本恢复的完整性 | [records/issue-7.md](records/issue-7.md) |
| #11 | 验证 fixture 缓存 | [records/issue-11.md](records/issue-11.md) |
| #13 | 验证工作区保留策略 | [records/issue-13.md](records/issue-13.md) |
| #21 | web 身份句重定向到 dev-context + 窗口锚点 | [records/issue-21.md](records/issue-21.md) |
| #22 | 回滚 append 改窗口式锚点 | [records/issue-22.md](records/issue-22.md) |
| #24 | DSH NEXT 识别：拆发行形态 / 是否解 asar / 壳入口三事实 + fixture 红绿 | [records/issue-24.md](records/issue-24.md) |
| #25 | 桌面退出留痕：close 退出码 + purge_status 读侧 + 入口五 harness | [records/issue-25.md](records/issue-25.md) |
| #26 | 桌面退出多来源：quit / 渲染崩溃 / uncaught / exit 合成一条原因链 | [records/issue-26.md](records/issue-26.md) |

## CI 不是集成门（2026-11-03 记录）

`.github/workflows/check.yml` 跑 `npm run check` + `npm run test:ci`，但跑在 `windows-latest` 上、没有装桌面宿主：
真宿主电池（`tests/verify/host-admin.test.js`）会因 `hasHost()` 为假而 **skip**。所以 **CI 绿 = 语法 + 单元 + 非宿主路径**，
集成结论只能来自本机 `npm run verify`。任何"CI 过了所以集成没问题"的推断都是错的。

## 测试超时的口径（2026-11-03 实测）

`tests/verify/host-admin.test.js` 是本仓库唯一的真宿主电池（一次 `runVerification`）：

- 单独跑：116 s（`node --test tests/verify/host-admin.test.js --test-force-exit --test-timeout=300000`）。
- 全量 `npm run test:ci` 并行跑：>186 s（`tests/lib/` 新增三个文件后，worker 争 CPU 明显变长）。

因此单例超时定为 300 s（`package.json` 的 `test:ci` 与测试自身的 `timeout` 两处一致）。180 s 会把并行的正常通过判成超时。

## 测试写盘约定

- 测试与脚本只写 D 盘；临时目录用 tests/verify/helpers.js 的 tempDir()。
- 任何会走到 installPreset 的测试必须用 withIsolatedHome()：它把 DSH_HOME、USERPROFILE、HOME 一起切到 D 盘临时目录，并在切换后断言 homedir() 真的在 D 盘。原因：installPreset 会把随包技能同步到 homedir()/.dsh 一份，只改 DSH_HOME 会写真实用户目录。

## 文件索引

- lib/prompt-variables.js：提示词装配变量兼容层（宿主只注册 provider/model，插件补 cwd；与 lib/index.js 共用 promptHosts）。
- lib/host-deps.js：宿主依赖解析（锚点候选 + 宿主包根身份核对）。
- lib/verify/isolate.js：D 盘路径校验、工作区、隔离环境、快照与差异、宿主预检。
- lib/verify/baseline.js：保护基线封存与校验、指纹、git 关系。
- lib/verify/asar.js：从 app.asar 解出未打补丁宿主文件。
- 宿主壳入口原文：`<install>/resources/app/lib/main.js`；未打补丁原文用 `lib/verify/asar.js` 的 `extractAsarSubtree(asarPath, "lib", destDir)` 解出。
- lib/verify/fixture-cache.js：fixture 缓存（#11）：键 = asar size+mtime、临时目录换名落盘、完整性核对与重建。
- lib/verify/host-entry.js：真实宿主包加载、请求准备捕获、预设静态审计。
- lib/verify/admin-entry.js：隔离副本管理生命周期、文件描述符探针、真实安装守卫。
- lib/verify/backup-faults.js：备份/恢复故障注入（完整备份 / 过期备份 / 0 字节备份）。
- lib/verify/targets.js：目标定位与逐文件目标态判定（含不适用键的搜索证据）。
- lib/verify/target-entry.js：入口五编排、完整提示词装配与桌面壳 close 回调的运行结果证明。
- lib/exit-ledger.js：桌面退出留痕的读写契约（DSH_HOME/dsh-purge/exit-ledger.jsonl、来源词表、episode 合并与原因链、条数+字节上界、坏行跳过、不抛）。
- lib/desktop-exit-trace.js：宿主内联的多来源留痕代码（#91 模块作用域块 + #90 close 调用；上界常量从 exit-ledger 取）。
- lib/verify/exit-trace.js：入口五的桌面退出 harness（模块作用域代码求值、事件替身模拟四个来源、episode 合并、拔痕对照、purge_status 读侧）。
- lib/desktop-forms.js：桌面发行形态名单（harness / desktop / next），①形态 ②是否解 asar ③壳入口 各读各的字段。
- lib/verify/desktop-next.js：入口五的 NEXT 安装树 fixture 与四项事实（含拔名单的故障对照）。
- lib/verify/report.js：报告构建与 Markdown 渲染。
- lib/verify/run.js：完整流程编排。
- scripts/verify.mjs：命令行入口。
- scripts/probe.mjs：隔离探针入口（`npm run probe <file>`），切环境 + 宿主预检 + 真实安装只读核对。
- scripts/acceptance.mjs：验收入口（`npm run acceptance`），跑完整验证并输出兼容修订记录；`lib/verify/acceptance.js` 负责收敛与渲染。
- tests/verify/*.test.js：单元与集成测试。
## 行为冲突记录（#4：toolFilter → agentPreset）

规格 #1 要求“无法保持原有配置含义时记录具体冲突，不自动折中”，这里按实记录新旧差异：

1. **工具来源**：旧 toolFilter 是“父级当前工具集 − subagent_fork/workflow/ralph”；新接口只能让子级跑一份具名
   Agent Preset，因此子级拿到的是 redteam-worker 组合声明的工具，而不是宿主在预设之外另外提供、由父级继承下来的工具。
   就当前桌面组合而言，红队预设已经把模型可见工具都写在组合里，所以差异停在“理论上可能”的一层；一旦以后有工具只挂在
   host 平面、靠继承到达父级，子级将不再自动获得它。
2. **生效时机**：旧 deny 在派活时按当时的工具目录生效；新组合在插件启动时由已安装预设文件裁出。改完预设文件要重启
   DSH 才会被下一次派活采用。
3. **subagent 本身**：旧配置的注释已说明“不能 deny subagent（它是该行自己注册的 scoped 工具）”，新旧一致——
   子级仍看得到 subagent，真正拦住递归的是 maxDepth: 1。
4. **deny 列表的落点**：旧配置写工具名（subagent_fork/workflow/ralph），新配置靠行 id
   （tool-subagent-fork/tool-workflow/tool-ralph）裁剪组合；两者由 lib/redteam/preset-migration.js 的
   LEGACY_DENIED_ROWS 一一对应，任何一边改名都会让裁剪失效（测试里用该常量断言数量）。
