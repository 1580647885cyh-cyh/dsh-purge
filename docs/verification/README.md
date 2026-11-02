# 隔离验证入口（保护基线 + 宿主加载 + 管理生命周期）

对应任务：[#2 封存 1.1.71 保护基线并建立最小隔离验证入口](https://github.com/1580647885cyh-cyh/dsh-purge/issues/2)。

目标是用当前真实源码与当前安装的 Windows 官方桌面 DSH 0.2.1-rc.5，建立一条可重复、可核对、只写 D 盘的最小验证路径；不在本入口修复后续任务负责的兼容缺陷。

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
- 本次工作区：D:\dsh\tmp\dsh-purge-verify\<stamp>\，含 out/report.json、out/report.md、out/prompt.txt、out/tool-contracts.json。

报告只汇总结构性事实（长度、哈希、段名、工具名、文件差异）；提示词全文、工具契约全文只落在隔离工作区。

## 隔离边界（硬性约束）

1. 全部路径经 assertDriveDPath 校验，工作区、DSH_HOME、缓存、临时目录、日志和宿主副本都在 D 盘。
2. 进程环境会切换到隔离目录：DSH_HOME、DSH_SURFACE=desktop、DSH_DESKTOP_INSTALL、DSH_BASE、LOCALAPPDATA、APPDATA、TEMP/TMP、USERPROFILE，PATH 指向空目录。
3. PATH 清空后，宿主的注册表/运行进程/快捷方式发现不再命中本机真实安装；只保留 DSH_DESKTOP_INSTALL 指向的副本。
4. 管理操作前先调用插件的公开枚举 enumeratePatchAiBases({discover:true})，任何宿主不在工作区内就中止。
5. 真实安装只读：记录真实安装 targetFiles 的 stat（本次运行 55 个文件），管理操作结束后确认 mtime/size 全部未变。
6. 真实 DSH_HOME 只读：只读取 .agent-presets 做静态审计；真实会话、凭据、工作区不参与验证。
7. 不启动 Electron、不发送真实模型请求；宿主包（cordis、system-prompt、tools）以模块方式只读加载。

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
- 工具桥接探针（#3）：先按隔离桌面布局（DSH_DESKTOP_INSTALL → resources/app/dsh/node_modules）解析 @deepseek-ai/dsh-tools，确认候选命中且结果落在隔离副本内；再只读地把锚点指向真实桌面安装，导入 lib/redteam/tools.js，确认 defineTool 真的加载出来（预设行 dsh-purge/redteam/tools 的前置条件）。
- 已知故障按记录保留、不改预设：{{cwd}} 自定义模板仍会渲染失败；已安装 redteam 预设仍写已废弃 toolFilter。

不覆盖：Electron 桌面进程、真实 HTTP 模型请求、模型回答质量。

## 入口三：管理生命周期（补充入口）

模块：lib/verify/admin-entry.js。

- 隔离副本从 app.asar 解出未打补丁的 dsh-agent-instructions、dsh-system-prompt、dsh-tools，而不是复制当前已打补丁的安装目录。
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

## 期望来源与允许的表示差异

期望来源：已封存的保护基线、宿主公开 API 的既定行为、已安装预设文件、本文件记录的已知故障。验证不生成 golden 输出，也不把新实现输出当作正确答案。

允许的表示差异：

- 提示词空白与换行归一、provider/model 的具体取值、prompt-inject.md 的本机内容（不参与断言）。
- 工具描述文本长度、参数键顺序（以集合与哈希比较）。
- 报告时间戳、工作区路径、文件 mtime。
- .bak 的字节内容不作为 golden；但「apply 是否产生 bak」「revert 是否用 bak 还原」是验收项（#3）。

不允许的差异：

- 提示词段缺失、工具名缺失、装配变量集合变化。
- 宿主 Schema 校验从通过变成失败。
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

- cwd-template-variable：宿主只注册 provider/model，任意模板里的 {{cwd}} 仍会让装配渲染失败（归属 #5 / #6）。

#4 起，预设的旧 toolFilter 不再记成已知故障：迁移在隔离副本上验证（见入口四），真实
DSH_HOME 里的已安装副本仍是旧写法时，报告只在「待自愈」一节列出，等插件下次启动就地迁移。

这些条目由报告自动生成并附证据；修复对应任务时应先让条目消失，而不是修改本台账。

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

- lib/host-deps.js：宿主依赖解析（锚点候选 + 宿主包根身份核对）。
- lib/verify/isolate.js：D 盘路径校验、工作区、隔离环境、快照与差异、宿主预检。
- lib/verify/baseline.js：保护基线封存与校验、指纹、git 关系。
- lib/verify/asar.js：从 app.asar 解出未打补丁宿主文件。
- lib/verify/host-entry.js：真实宿主包加载、请求准备捕获、预设静态审计。
- lib/verify/admin-entry.js：隔离副本管理生命周期、文件描述符探针、真实安装守卫。
- lib/verify/report.js：报告构建与 Markdown 渲染。
- lib/verify/run.js：完整流程编排。
- scripts/verify.mjs：命令行入口。
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
