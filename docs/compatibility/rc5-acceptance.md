# 兼容修订记录（Windows 官方桌面 DSH 0.2.1-rc.5）

- 生成时间：2026-11-03T09:12:51.635Z
- 结论：通过（范围见「未执行的检查」）
- 插件版本：1.1.71（本地锁 {"version":"1.1.71","remoteUpdates":false,"editable":true}）
- 宿主：shell 0.2.1-rc.5 / runtime 0.2.1-rc.5 / build d4db512a969f
- 宿主适配：0.2.1-rc.5 — 已适配（本版声明：0.2.1-rc.5）
- app.asar：182766714 字节 / mtime 2026-10-29T14:02:52.000Z
- 本地锁实际行为：远程更新/切换/回滚被拒绝（ERR_DSH_PURGE_LOCAL_VERSION_LOCK），状态 pinned
- 本地依赖来源：无远程依赖（dependencies 为空，保持本地可编辑）
- 手动编辑：插件源码可写（editable:true 且文件可写）

## 验收入口

| 入口 | 结果 |
| --- | --- |
| 宿主加载（cordis 真实加载 + 工具注册） | 通过 |
| 提示词模板渲染契约 | 通过 |
| 完整提示词预设运行 | 通过 |
| 宿主依赖解析（工具桥接） | 通过 |
| 预设注册与组合（含迁移） | 通过 |
| 受控模型端点 → 无害工具调用 | 通过 |
| 工具集外调用被拒绝 | 通过 |
| 管理生命周期（应用/重复应用/恢复） | 通过 |
| 备份/恢复故障注入 | 通过 |
| 目标定位与适配状态 | 通过 |

## 兼容修订

| 修订 | 任务 | 故障 | 修复 | 回归证据 |
| --- | --- | --- | --- | --- |
| R1 | #3 | 桌面布局下解析不到 @deepseek-ai/dsh-tools；备份占位 fd 未关闭导致 rename EPERM | 宿主依赖锚点候选 + 包根身份核对；hostFs 补齐 fd 方法 | docs/verification/README.md「本票验收对应（#3）」 |
| R2 | #4 | 宿主 0.2.1-rc.5 拒绝 toolFilter，预设行挂不上 | toolFilter → agentPreset + redteam-worker 组合裁剪（保留原 deny 语义） | docs/verification/README.md「本票验收对应（#4）」 |
| R3 | #5 | 宿主只注册 provider/model，{{cwd}} 让整份提示词渲染失败 | apply 时用 SystemPrompt.variable 补 cwd（缺失给空串） | docs/verification/README.md「回归记录（#5）」 |
| R4 | #6 | rc.5 的等价分支/编译形式识别不到（#40/#84）；通用标记把官方文案当成功（#24） | 补等价形式匹配 + settledWhen/patchEffectState/patchOwnMarkPresent；新增目标定位与适配状态入口 | docs/verification/README.md「回归记录（#6）」 |
| R5 | #7 | 过期 bak 未刷新（目标态/官方标记误判）导致旧宿主内容写回；0 字节 bak 清空目标 | looksPatchedAlready 改用自证标记 + provenance；revert 前刷新过期 bak、拒绝空备份 | docs/verification/README.md「回归记录（#7）」 |

## 补丁对不上但不是失败（逐条带落点）

- #21（非可选）BASH_TIMEOUT_RESTORE · 落点 base：当前宿主里没有可改的原文（可选补丁或布局差异，见目标定位段）
- #80（可选）MINIMAL_OFFICIAL_TOOLSET · 落点 preset-minimal, preset-sdk-minimal：当前宿主里没有可改的原文（可选补丁或布局差异，见目标定位段）

## 已确认不适用

- #76（可选）PRESET_UNRESTRICTED_IDENTITY_STRIP · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\.agent-presets\unrestricted\agent.cordis.yml
- #71（非可选）LIANGSHEN_IDENTITY_LINE · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\.agent-presets\liangshen\agent.cordis.yml ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\profiles\desktop\node_modules\@linxin666\dsh-liangshen\presets\liangshen\agent.cordis.yml ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\profiles\web\node_modules\@linxin666\dsh-liangshen\presets\liangshen\agent.cordis.yml
- #28（可选）LIANGSHEN_PHASE1_KEEP_INJECT · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\.agent-presets\liangshen\tool-bootstrap.mjs
- #30（可选）HOOKS_CLAUDE_DENY_ALLOW · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code
- #31（可选）HOOKS_CODEX_DENY_ALLOW · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh-hooks-codex ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-codex ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-codex
- #64（可选）HOOKS_STOP_STEER_NEUTRAL · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code
- #65（可选）HOOKS_PRESTEP_REJECT_NEUTRAL · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code
- preset-unrestricted（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\.agent-presets\unrestricted\agent.cordis.yml
- preset-liangshen（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\.agent-presets\liangshen\agent.cordis.yml
- preset-liangshen-pkg（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\profiles\desktop\node_modules\@linxin666\dsh-liangshen\presets\liangshen\agent.cordis.yml ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\profiles\web\node_modules\@linxin666\dsh-liangshen\presets\liangshen\agent.cordis.yml
- user-approval-invariant（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh-user-approval\lib\invariant.js ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-user-approval\lib\invariant.js
- liangshen-tool-bootstrap（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\home\.agent-presets\liangshen\tool-bootstrap.mjs
- tool-web-nested（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tool-web\lib\index.js
- hooks-claude-code（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code
- hooks-claude-code-nested（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-claude-code
- hooks-codex（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh-hooks-codex ; D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-codex
- hooks-codex-nested（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-hooks-codex
- system-prompt-nested（可选）未定位键 · 搜索过 D:\dsh\tmp\dsh-purge-verify\acceptance-20261103-171148\desktop\resources\app\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-system-prompt\lib\index.js

## 未执行的检查（不标记为通过）

- 真实 Electron 桌面进程内的插件加载（验证用宿主包以模块方式只读加载）
- 真实模型网络请求（受控端点只在本机回环，不写真实凭据）
- Web / macOS / Linux 以及其他 DSH 版本

## 独立恢复材料

- 保护基线快照：D:\dsh\data\dsh-purge\baseline\baseline-acceptance-20261103-171148.json
- treeHash：b5d3130efaa63ac80c056e86f93803ba57fcbdbb754a89c9ebdefbfa3dbc479f（176 个文件）
- 校验：`npm run verify -- --no-seal` 会用快照逐文件比对当前源码；快照只在本机 D 盘，不进仓库。

## 执行记录

- node scripts/verify.mjs --stamp acceptance-20261103-171148
- D:\dev-runtime\node\node-v24.14.1-win-x64\node.exe D:\dsh\local-plugins\dsh-purge\scripts\acceptance.mjs --out D:\dsh\local-plugins\dsh-purge\docs\compatibility --name rc5-acceptance
- 环境：platform=win32 / arch=x64 / node=24.14.1 / electron=null / execPath=D:\dev-runtime\node\node-v24.14.1-win-x64\node.exe / surface=auto / homedir=C:\Users\27591

## 报告摘要

- 结论：通过
- 已知故障：无

