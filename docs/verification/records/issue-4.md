# #4 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 本票验收对应（#4 恢复现有预设加载并保持工具参数契约）

- 通过真实宿主预设与工具注册入口复现废弃配置的加载阻断：入口四的 legacy 段（旧 toolFilter 被 dsh-tool-subagent 拒绝），错误文本与本机 preset-declare.json 记录的一致。
- 随包预设与已安装旧副本都核查；迁移保留用户内容、重复执行不叠加：migratePresetCopy 只改副本，报告列出删除/新增的行，第二次迁移 changed=false。
- 废弃字段保持原配置含义：旧 deny 的三件工具改由子级预设 redteam-worker 裁掉（deriveWorkerRows 从父级组合裁剪），没有用“删掉字段换可加载”的办法；tool-subagent 行的 provider/toolName/maxDepth 等原值不变。上一节记录了无法完全等同的三处差异。
- 预设能被宿主注册和选择、工具集合符合原契约：migrated / worker 两段挂载都通过，composition 通过宿主 entryListProblem；worker 相对父级只少那三行。
- 对象与嵌套 Schema 通过宿主校验、参数契约保留：hostEntry.tools[].contract 的 validAccepted / extraRejected 案例。
- 受控模型端点与无害工具调用：modelToolCall（有效调用成功）与 modelToolCallRejected（工具集外被拒）。
- 只改必要实现：版本 1.1.71、localVersionLock、本地可编辑方式与远程更新锁都未改动（baseline.plugin 记录）。
