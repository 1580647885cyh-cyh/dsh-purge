# 隔离验证入口（保护基线 + 宿主加载 + 管理生命周期）

对应任务：[#2 封存 1.1.71 保护基线并建立最小隔离验证入口](https://github.com/1580647885cyh-cyh/dsh-purge/issues/2)。

目标是用当前真实源码与当前安装的 Windows 官方桌面 DSH 0.2.1-rc.5，建立一条可重复、可核对、只写 D 盘的最小验证路径；不在本入口修复后续任务负责的兼容缺陷。

## 先选入口

| 你要做的事 | 跑哪个 | 看哪一节 |
| --- | --- | --- |
| 改补丁/适配行为，要全量取证 | npm run verify | 入口一到五（报告在 out/report.md） |
| 临时探查、跑一次性脚本、调 lib/core.js | npm run probe <file> | 隔离边界 + 文件索引（用法见 scripts/probe.mjs 头注释） |
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

产物：

- 保护基线：D:\dsh\data\dsh-purge\baseline\baseline-<stamp>.json 与 latest.json，只在 D 盘，不进仓库。
- 本次工作区：D:\dsh\tmp\dsh-purge-verify\<stamp>\，含 out/report.json、out/report.md、out/prompt.txt、out/context.txt、out/tool-contracts.json。
- fixture 缓存（#11）：D:\dsh\tmp\dsh-purge-verify\_fixture-cache\asar-<size>-<mtime>\。命中时整棵复制，未命中才从 app.asar 解；
  缓存不属于工作区，删掉整个目录只让下一轮变慢，不影响任何断言。

报告只汇总结构性事实（长度、哈希、段名、工具名、文件差异）；提示词全文、工具契约全文只落在隔离工作区。

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
11. #11 的 fixture 缓存在工作区**旁边**（`tmp/dsh-purge-verify/_fixture-cache/<key>`），不是工作区的一部分：不进保护基线
    （基线只走仓库源码）、不进工作区快照（副本仍落在 `<stamp>/desktop`）、也不参与真实安装守卫（守卫只核对真实安装的
    targetFiles）。缓存按「先写临时目录、再换名」落盘，半成品永远不会被当成命中。

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
- {{cwd}} 模板由插件补回的装配变量渲染（#5，见「回归记录」）；已安装 redteam 预设仍写已废弃 toolFilter 时进「待自愈」，不算已知故障。

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
  - preset fetch 落地：在副本上把 tool-web 的 fetch 改成 false，再走公开的 purge_apply；要求重新打开并写回标记，重复应用不追加。
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

本入口的改进：宿主公开包 + cordis 真实加载 + 真实工具注册表 + 独立宿主副本 + 真实安装只读守卫。仍未覆盖 Electron 进程和真实网络请求。

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

## 回归记录（#5 恢复模板渲染和完整提示词预设运行）

- 故障：目标宿主（0.2.1-rc.5 的 dsh-agent-loop）只注册 provider/model；模板里的 {{cwd}}
  让 renderPrompt 抛 unknown prompt variable，整份提示词渲染失败（此前工作目录报错的来源）。
- 修复：lib/prompt-variables.js 在 apply 时注册 cwd（值取 session.header.cwd，缺失给空串），
  旧模板/自定义模板按原契约渲染；插件自己的段仍不写 {{cwd}}，目录由宿主必需运行上下文提供，
  不重复表达同一事实（原 CWD_ONLY_SUFFIX 修复保持不变）。
- 通过证据：报告已知故障 0 条；模板渲染契约 6/6（含空后缀、缺失后缀、缺失工作目录），
  并带故障对照——同一份旧模板只给宿主自带的 provider/model 时必须仍被拒绝（unknown prompt variable）。
- 通过证据：完整提示词预设全部核对项通过——随包预设 persona 进装配并原样保留、真实装配内模板渲染出
  {{cwd}}、会话模式按预设走红队分支、重复装配三次一致、无残留变量、注入段 1 份、required 上下文在抑制下保留；
  受控请求的系统消息命中插件正文，运行上下文消息带工作目录。

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

## 回归记录（#7 隔离宿主应用与跨版本恢复的完整性）

- 故障一（旧备份写回新宿主）：refreshStaleBaksForUpgrade 原用 patchApplied 判断「是不是我们打过的版本」。
  两处误判都复现了：(a) #6 的 settledWhen 让官方新 preset（自带 `fetch: true`）被判成已打补丁；
  (b) #2/#3/#50 的「完成标记」就是官方原文，官方文件本身就带。两种情况下过期 bak 都不刷新，
  revert 随后把旧宿主内容写回。修复：改用 patchOwnMarkPresent，并给这三类补丁标 `provenance: false`。
- 故障二（0 字节备份覆盖目标）：apply 中断会留下 0 字节 bak 占位符；revertAll 只比较字节是否相同，
  不校验 bak 是否有效，直接把有效目标截成 0 字节（复现：60147 → 0）。
- 修复：
  - `looksPatchedAlready` 改用 `patchOwnMarkPresent`（只看我们写进去的标记/替换文本），目标态不再算「打过补丁」；
  - `provenance: false` 标在 #2/#3/#50 上：它们的"标记"是官方句子，不能证明文件被我们改过；
  - `revertAll` 开头先 `refreshStaleBaksForUpgrade`：升级后直接点还原也不会写回旧版本；
  - `revertAll` 对 `size <= 0` 的 bak 拒绝写回，记 `backup_empty` 错误，目标保持原样。
- 通过证据：入口三故障注入 5/5（full-backup / official-mark-refresh / stale-bak-refresh / stale-bak-not-written-back / empty-backup）；
  管理生命周期 apply 47 个文件、52 个备份、revert 全部还原；真实安装 55 个目标文件未改动。
- 边界之一（还原前的刷新会保守处理「用户手改过的目标」）：revert 前的 `refreshStaleBaksForUpgrade` 无法区分
  「宿主升级」和「用户改过文件」，两者都会被当作新版内容而刷新 bak——这与 apply 时的既有假设一致，代价是这类
  文件的还原点变成当前内容（no-op），不会产生数据损坏；没有证据支持做更激进的判断，故记录不修。
- 边界之二：只有 #21 BASH_TIMEOUT_RESTORE 没有自证标记（它的产物就是官方值本身）。
  若历史上它把插件抬起过的 timeout 恢复成官方值，revert 前的刷新会把该文件的 bak 刷成当前内容，
  还原因此变成 no-op——不产生数据损坏，当前基线也不会进入这个状态。

## 本票验收对应（#7 隔离宿主应用与跨版本恢复）

- 完整备份 / 过期基线 / 不完整备份的代表性案例：入口三的 `backupFaults` 三条，加正常 apply/revert/重复应用。
- 应用与重复应用稳定、状态与磁盘一致：管理生命周期记录 apply/reapply/revert 三次整树 diff（重复应用 0 改动）；
  #6 的逐文件核对同时保证状态不靠叠加内容维持成功。
- 恢复使用完整且属于对应宿主的基线：过期备份案例要求 bak 先刷新成当前官方内容，revert 不得写回旧版本；
  0 字节备份被拒绝并报错。
- 基线识别覆盖原有处理：`looksPatchedAlready` 只认我们写进去的标记/替换文本（含无字面 marker 的补丁），
  不再被目标态误判；用户 profile patch 层仍不建 bak、不还原。
- 错误路径明确、目标不被留成不完整内容：`backup_empty` 记入 revert 的 errors，目标字节不变。
- 只纳入当前目标相关缺陷：本轮只改 `looksPatchedAlready` 与 `revertAll`（加刷新与空备份守卫），
  未引入安装器/下载器或生命周期重构；未复现的候选（例如「恢复会删除目标」）保持原语义并有测试。
- 写入范围：故障注入全部在 D 盘隔离副本；真实安装、保护基线、原始独立备份未改动。

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

## 本票验收对应（#2）

- 核对并保留当前源码、形成可校验快照：baseline.js 的清单/treeHash/自检与测试。
- 确认目标宿主与指纹：baseline.js 的 hostFingerprint/pluginFingerprint/environmentFingerprint 与报告。
- 隔离副本、配置、缓存、日志与测试端点都在 D 盘：isolate.js、预检、真实安装只读守卫与测试。
- 宿主公开加载与请求准备最小案例：host-entry.js 与集成测试。
- 公开管理操作最小隔离案例：admin-entry.js 与集成测试。
- 先例探针局限：见上一节。
- 期望来源与允许差异：见上一节。

## 本票验收对应（#3 桌面宿主依赖解析与文件探测）

- 复现与宿主布局、接口使用的关系：隔离副本导入 lib/redteam/tools.js 报 cannot resolve @deepseek-ai/dsh-tools；目标包就在 resources/app/dsh/node_modules，但旧候选只有 argv/DSH_HOME/cwd 与一条固定路径。报告 hostEntry.toolBridge.isolated.tried 逐条列出候选状态，修复前该列表没有任何 resolved 项。
- 隔离桌面加载取得工具桥接依赖：host-entry 的 toolBridge 在隔离副本按 desktop-install:app-dsh 解析成功；同一锚点下只读加载真实宿主包也成功（模块顶层解析失败会直接抛错），报告记录 isolated / host / loaded 三段。
- 文本入口、普通文件与非文本文件的区分、fd 读取/关闭/错误：admin-entry 的 fileProbe + fdProbe，配 hostfs.test.js。注意基线契约：shimFileStatus 只把带 shim 签名（#!、@echo、REM 、"# "）的文本当入口，普通文本与二进制同样返回 binary；探针断言的是“入口被注入、二进制字节不变、普通文件不被 shim 写入”。
- 覆盖当前布局、不靠固定路径或任意命中：lib/host-deps.js 只接受“@deepseek-ai 根带 dsh-agent-instructions/lib”的候选，并要求解析结果落回该锚点范围（符号链接按真实路径复核）。旧实现的 D:\DeepSeek Harness\npm-global 固定路径兜底已删除；同形态的 CLI 布局由 argv 候选覆盖，host-deps.test.js 有专门用例。
- 对照布局回归：同一解析器在 DSH_HOME/node_modules、~/.dsh 同构目录、npm 嵌套布局（@deepseek-ai/dsh/node_modules）、argv bin 布局与 resourcesPath/execPath 桌面锚点都有用例。这里只验证解析候选与身份核对，不构成 Web 端验收承诺（ADR 0001）。
- 随 fd 修复暴露的必要路径缺陷：refreshStaleBaksForUpgrade 原先只看 dsh-purge 字面标记；agent-instructions 这类补丁把官方句子换成强句、不带该字串，备份真正落地后重复 apply 会把有效 bak 覆盖成已打补丁内容，revert 再也还原不回去。现按目标补丁的 marker/替换文本判断“文件已被我们打过”，实现与回归见 lib/core.js、hostfs.test.js，报告里的 reapply=0 / revert 还原 5 个是验收证据。
- 不动工具 Schema/工具集合/预设：本票只加解析模块、fd 代理与验证入口字段。

## 测试写盘约定

- 测试与脚本只写 D 盘；临时目录用 tests/verify/helpers.js 的 tempDir()。
- 任何会走到 installPreset 的测试必须用 withIsolatedHome()：它把 DSH_HOME、USERPROFILE、HOME 一起切到 D 盘临时目录，并在切换后断言 homedir() 真的在 D 盘。原因：installPreset 会把随包技能同步到 homedir()/.dsh 一份，只改 DSH_HOME 会写真实用户目录。

## 文件索引

- lib/prompt-variables.js：提示词装配变量兼容层（宿主只注册 provider/model，插件补 cwd；与 lib/index.js 共用 promptHosts）。
- lib/host-deps.js：宿主依赖解析（锚点候选 + 宿主包根身份核对）。
- lib/verify/isolate.js：D 盘路径校验、工作区、隔离环境、快照与差异、宿主预检。
- lib/verify/baseline.js：保护基线封存与校验、指纹、git 关系。
- lib/verify/asar.js：从 app.asar 解出未打补丁宿主文件。
- lib/verify/fixture-cache.js：fixture 缓存（#11）：键 = asar size+mtime、临时目录换名落盘、完整性核对与重建。
- lib/verify/host-entry.js：真实宿主包加载、请求准备捕获、预设静态审计。
- lib/verify/admin-entry.js：隔离副本管理生命周期、文件描述符探针、真实安装守卫。
- lib/verify/backup-faults.js：备份/恢复故障注入（完整备份 / 过期备份 / 0 字节备份）。
- lib/verify/targets.js：目标定位与逐文件目标态判定（含不适用键的搜索证据）。
- lib/verify/target-entry.js：入口五编排、完整提示词装配与桌面壳 close 回调的运行结果证明。
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

## 本票验收对应（#4 恢复现有预设加载并保持工具参数契约）

- 通过真实宿主预设与工具注册入口复现废弃配置的加载阻断：入口四的 legacy 段（旧 toolFilter 被 dsh-tool-subagent 拒绝），错误文本与本机 preset-declare.json 记录的一致。
- 随包预设与已安装旧副本都核查；迁移保留用户内容、重复执行不叠加：migratePresetCopy 只改副本，报告列出删除/新增的行，第二次迁移 changed=false。
- 废弃字段保持原配置含义：旧 deny 的三件工具改由子级预设 redteam-worker 裁掉（deriveWorkerRows 从父级组合裁剪），没有用“删掉字段换可加载”的办法；tool-subagent 行的 provider/toolName/maxDepth 等原值不变。上一节记录了无法完全等同的三处差异。
- 预设能被宿主注册和选择、工具集合符合原契约：migrated / worker 两段挂载都通过，composition 通过宿主 entryListProblem；worker 相对父级只少那三行。
- 对象与嵌套 Schema 通过宿主校验、参数契约保留：hostEntry.tools[].contract 的 validAccepted / extraRejected 案例。
- 受控模型端点与无害工具调用：modelToolCall（有效调用成功）与 modelToolCallRejected（工具集外被拒）。
- 只改必要实现：版本 1.1.71、localVersionLock、本地可编辑方式与远程更新锁都未改动（baseline.plugin 记录）。

## 本票验收对应（#5 恢复模板渲染和完整提示词预设运行）

- 先回归工作目录报错、已通过的不重复替换：CWD_ONLY_SUFFIX 与 identity.js 的目录句清理保持不变，本票没改提示词段，只补回宿主不再提供的 cwd 装配变量。
- 旧模板、自定义模板、空或缺失后缀、正常与缺失工作目录：host-entry.js 的 templateContract 六案例；期望值取基线模板字面量，缺失目录时变量给空串，渲染不抛。
- 完整提示词预设完成一次受控请求：promptPreset 的 assemble / render / template-in-assembly / baseline-sections / preset-persona / context / stability / required-context / refresh / suppressor-dispose / no-leftovers / no-duplication / request 十三项；随包预设的 persona 行载入装配，会话模式按该预设声明。
- 宿主必需运行上下文与插件贡献的最终呈现：working-directory 按 dsh-working-directory 的公开契约注册（required、JSON 引号目录、不插值），抑制可选上下文后仍在、refresh 后仍在；受控请求的上下文消息命中它，系统消息命中 dsh-purge 正文。
- 与保护基线比较、不宽泛忽略：段名与长度、变量集合、注入段份数、上下文段名逐项比较；report.ok 把模板契约与预设跑通算硬契约，不再降级成已知故障。
- 重复组装与连续步骤稳定：两次装配的提示词、段、上下文一致；受控工具调用照旧（modelToolCall / modelToolCallRejected 未受本票影响）。
- 版本与锁：1.1.71、localVersionLock（remoteUpdates:false、editable:true）与 dshTarget 未改动；baseline.plugin 记录照旧。

## 回归记录（#11 验证 fixture 缓存）

- 背景与实测差异：票面记录的是「本机 78 个工作区 / 413 MB，单轮 verify ~2.5 分钟，绝大部分时间在从 182 MB 的
  app.asar 重解宿主包」。本机复测只成立一半：整轮 `npm run verify` 43–48 s，fixture 步骤只有 1.1–1.4 s
  （43 个包 / 7 MiB）。缓存按票实现，收益只落在 fixture 这一步——整轮由其余阶段决定，本轮没有逐阶段计时，
  也不据此声称别处是瓶颈。
- 实现：新增 `lib/verify/fixture-cache.js`，`prepareFixtureHost` 建副本前先看缓存。
  - 键 = app.asar 的 size + mtime（毫秒取整）：换宿主、换包，键就变，旧目录自然不再命中。
  - 命中：一次 `cpSync` 把 `_fixture-cache/<key>/desktop` 整棵复制到 `<stamp>/desktop`；未命中：逐包从 asar 解到
    缓存目录**旁边的临时目录**，写清单后换名，再整棵复制出去。半成品不会变成命中。
  - 完整性：清单里的键、宿主编译版本、**fixture 配方**（要解哪些包与额外依赖）、两层 `package.json`、每个包的
    `package.json`、两份额外依赖逐项核对；缺一项就按核对给出的原因重建（报告 `fixture.rebuildReason` 记原因，例如
    「包不完整（缺 package.json）：dsh-tools」）。配方必须单独比对：键只由 asar 决定，往 FIXTURE_PACKAGES 加包时
    asar 没变、键也不变，不比对配方就会拿旧缓存静默少包——这正是规则 7 禁止的「用缺记录豁免让固定契约静默通过」，
    #11 审查发现后补的。宿主编译版本同样参与判定：副本里两层 `package.json` 写的就是它，对不上时报告与副本会自相矛盾。
  - 故障不放大：缓存目录写不进、被占用、并发抢占都只回退到「从 asar 解」，验证照常跑完；`fixture.cacheError` 留证据。
  - 边界：缓存落在验证根目录旁边，不属于工作区；工作区快照（`snapshotTree(workspace.install)`）、保护基线（只走仓库源码）
    与真实安装守卫（只核对真实安装 targetFiles）都看不到它。
- 耗时对比（同一台机器，同一份 182 MB app.asar）：

  | 阶段 | 改造前 | 改造后（未命中） | 改造后（命中） |
  | --- | --- | --- | --- |
  | fixture 步骤 | 1198 / 1112 ms（连续两次冷跑） | 1395 ms | 339 / 365 / 331 ms（三次） |
  | 整轮 `npm run verify` | 43.3 s | 48.4 s | 47.8 s |

  fixture 步骤命中时快 3.4–3.8 倍；整轮 43.3 → 47.8 s 的差异落在噪声里，因为 fixture 只占整轮约 3%——票面
  「单轮 ~2.5 分钟、绝大部分时间在解包」的前提在本机不成立，本票不把它当收益写进结论。
  取证口径：改造前的 1198/1112 ms 来自单独计时脚本（改造前报告还没有 fixture 段），改造后来自报告里的
  `fixture.durationMs`（进 report.json）加整轮秒表，不是估算。
  复现：删掉 `_fixture-cache` 目录 → 跑一次 `npm run verify`（未命中，顺带重建缓存）→ 再跑一次（命中），
  对照 `report.json` 的 `fixture.cacheHit` 与 `fixture.durationMs`。
- 通过证据：
  - 单测 `tests/verify/fixture-cache.test.js` 九项：命中复制、size/mtime 失效、缺 package.json / 少包 / 清单损坏重建、
    宿主版本不一致不复用、配方变了不复用、命中后复制失败不假装命中、缓存不可写不阻断、缓存根路径、报告 `fixture` 段区分
    `asar` / `cache`。归档用「头表 + 数据区」的最小构造，断言的是缓存行为（落盘字节、两次 `snapshotTree` 全等、清单里的
    配方）；真实 asar 由本入口与入口三覆盖。
  - 集成（`tests/verify/host-admin.test.js`）：整轮验证里 `fixture.source` 只能是 `asar` 或 `cache`（不能拿真实安装充数），
    缓存目录名匹配 `_fixture-cache/asar-<size>-<mtime>` 且不落在工作区内。
  - 报告：`fixture.source` / `packages` / `extras` / `durationMs` / `cacheKey` / `cacheDir` / `cacheHit` /
    `rebuildReason` / `cacheError`；`report.md` 的「隔离边界」一节逐条打印来源与耗时。

## 本票验收对应（#11 验证 fixture 缓存）

- 缓存键 = asar 的 size + mtime，目录在 D 盘 `tmp/dsh-purge-verify/_fixture-cache/<key>/`：`fixtureCacheKey` /
  `fixtureCacheRoot`，单测「asar 的 size/mtime 变了就自动失效」逐项验证（只改 mtime、再改大小）。
- 命中走 `cpSync`、未命中才从 asar 解，来源可区分：`prepareFixtureHost` 的两条返回路径，报告 `fixture.source` 取
  `cache` / `asar` / `install`；`report.md` 分别打印「（命中缓存，整棵复制）」与「（从 app.asar 解）」。
- 缓存不参与基线、不参与真实安装守卫：缓存目录在工作区外（集成测试断言 `isWithin(cacheDir, workspace.root) === false`），
  基线只遍历仓库源码条目，守卫只 stat 真实安装的 targetFiles。损坏或不完整（缺 package.json / 少包 / 清单坏 / 宿主版本变 /
  配方变）自动重建：单测「缺 package.json、少包、清单损坏都会重建」「宿主版本不一致时不复用旧副本」「配方变了就不复用」。
- 命中时变快并记录对比：见上一节的耗时表（fixture 步骤 1.1–1.4 s → 0.33–0.37 s），并写清取证口径。
- `npm run check` / `npm run test:ci` / `npm run verify` 全绿，缓存逻辑有单测（命中、失效、重建）：本轮三个命令各跑一遍通过
  （check：93 个文件 / 2 个入口；test:ci：74 tests、74 pass、0 fail，含 49–52 s 的宿主集成用例；verify：报告 ok）。
- 缓存只增不减（旧键不自动清理）：每份实测 6.6 MiB，删掉 `_fixture-cache` 目录即回收；自动清理不在本票范围——票面提到的
  413 MB 工作区膨胀另有来源，本票只负责不再重建宿主副本。
