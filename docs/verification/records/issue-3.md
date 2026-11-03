# #3 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 本票验收对应（#3 桌面宿主依赖解析与文件探测）

- 复现与宿主布局、接口使用的关系：隔离副本导入 lib/redteam/tools.js 报 cannot resolve @deepseek-ai/dsh-tools；目标包就在 resources/app/dsh/node_modules，但旧候选只有 argv/DSH_HOME/cwd 与一条固定路径。报告 hostEntry.toolBridge.isolated.tried 逐条列出候选状态，修复前该列表没有任何 resolved 项。
- 隔离桌面加载取得工具桥接依赖：host-entry 的 toolBridge 在隔离副本按 desktop-install:app-dsh 解析成功；同一锚点下只读加载真实宿主包也成功（模块顶层解析失败会直接抛错），报告记录 isolated / host / loaded 三段。
- 文本入口、普通文件与非文本文件的区分、fd 读取/关闭/错误：admin-entry 的 fileProbe + fdProbe，配 hostfs.test.js。注意基线契约：shimFileStatus 只把带 shim 签名（#!、@echo、REM 、"# "）的文本当入口，普通文本与二进制同样返回 binary；探针断言的是“入口被注入、二进制字节不变、普通文件不被 shim 写入”。
- 覆盖当前布局、不靠固定路径或任意命中：lib/host-deps.js 只接受“@deepseek-ai 根带 dsh-agent-instructions/lib”的候选，并要求解析结果落回该锚点范围（符号链接按真实路径复核）。旧实现的 D:\DeepSeek Harness\npm-global 固定路径兜底已删除；同形态的 CLI 布局由 argv 候选覆盖，host-deps.test.js 有专门用例。
- 对照布局回归：同一解析器在 DSH_HOME/node_modules、~/.dsh 同构目录、npm 嵌套布局（@deepseek-ai/dsh/node_modules）、argv bin 布局与 resourcesPath/execPath 桌面锚点都有用例。这里只验证解析候选与身份核对，不构成 Web 端验收承诺（ADR 0001）。
- 随 fd 修复暴露的必要路径缺陷：refreshStaleBaksForUpgrade 原先只看 dsh-purge 字面标记；agent-instructions 这类补丁把官方句子换成强句、不带该字串，备份真正落地后重复 apply 会把有效 bak 覆盖成已打补丁内容，revert 再也还原不回去。现按目标补丁的 marker/替换文本判断“文件已被我们打过”，实现与回归见 lib/core.js、hostfs.test.js，报告里的 reapply=0 / revert 还原 5 个是验收证据。
- 不动工具 Schema/工具集合/预设：本票只加解析模块、fd 代理与验证入口字段。
