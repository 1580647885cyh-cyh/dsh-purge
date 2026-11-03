# #7 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

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
