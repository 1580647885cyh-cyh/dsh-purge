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
- 已知故障按记录保留、不改预设：{{cwd}} 自定义模板仍会渲染失败；已安装 redteam 预设仍写已废弃 toolFilter。

不覆盖：Electron 桌面进程、真实 HTTP 模型请求、模型回答质量。

## 入口三：管理生命周期（补充入口）

模块：lib/verify/admin-entry.js。

- 隔离副本从 app.asar 解出未打补丁的 dsh-agent-instructions、dsh-system-prompt、dsh-tools，而不是复制当前已打补丁的安装目录。
- 通过插件公开注册的工具依次执行 purge_status、purge_apply、再次 purge_apply、purge_revert，并逐步比较文件哈希。
- 观察项：apply 是否写入副本、重复 apply 是否稳定、是否产生 .dshpurge.bak、revert 是否真的还原。
- hostFs 文件描述符探针复刻备份占位 fd 的创建与 rename，记录缺失方法与错误码。

## 期望来源与允许的表示差异

期望来源：已封存的保护基线、宿主公开 API 的既定行为、已安装预设文件、本文件记录的已知故障。验证不生成 golden 输出，也不把新实现输出当作正确答案。

允许的表示差异：

- 提示词空白与换行归一、provider/model 的具体取值、prompt-inject.md 的本机内容（不参与断言）。
- 工具描述文本长度、参数键顺序（以集合与哈希比较）。
- 报告时间戳、工作区路径、文件 mtime。
- 隔离副本中 .bak、临时文件的存在与否只作为观察项。

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

## 已知故障台账（不在本票修复）

- cwd-template-variable：宿主只注册 provider/model，任意模板里的 {{cwd}} 仍会让装配渲染失败（归属 #5 / #6）。
- preset-deprecated-redteam：已安装 redteam 预设第 317 行仍是 toolFilter，新宿主已废弃该字段（归属 #4）。
- revert-without-backup：revert 报告成功但隔离副本没有 .dshpurge.bak，文件未被还原。
- hostfs-fd-methods：hostFs 缺少 closeSync、readSync、fstatSync、fsyncSync；备份占位 fd 无法关闭，rename 返回 EPERM，apply 不产生备份（归属 #3 / #7）。

这些条目由报告自动生成并附证据；修复对应任务时应先让条目消失，而不是修改本台账。

## 本票验收对应

- 核对并保留当前源码、形成可校验快照：baseline.js 的清单/treeHash/自检与测试。
- 确认目标宿主与指纹：baseline.js 的 hostFingerprint/pluginFingerprint/environmentFingerprint 与报告。
- 隔离副本、配置、缓存、日志与测试端点都在 D 盘：isolate.js、预检、真实安装只读守卫与测试。
- 宿主公开加载与请求准备最小案例：host-entry.js 与集成测试。
- 公开管理操作最小隔离案例：admin-entry.js 与集成测试。
- 先例探针局限：见上一节。
- 期望来源与允许差异：见上一节。

## 文件索引

- lib/verify/isolate.js：D 盘路径校验、工作区、隔离环境、快照与差异、宿主预检。
- lib/verify/baseline.js：保护基线封存与校验、指纹、git 关系。
- lib/verify/asar.js：从 app.asar 解出未打补丁宿主文件。
- lib/verify/host-entry.js：真实宿主包加载、请求准备捕获、预设静态审计。
- lib/verify/admin-entry.js：隔离副本管理生命周期、文件描述符探针、真实安装守卫。
- lib/verify/report.js：报告构建与 Markdown 渲染。
- lib/verify/run.js：完整流程编排。
- scripts/verify.mjs：命令行入口。
- tests/verify/*.test.js：单元与集成测试。