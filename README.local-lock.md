# 本地锁定版 dsh-purge 1.1.71

此副本保留了 `{{cwd}}` 兼容修复，远程更新、通道切换和版本回滚已封锁。
检查更新仅返回本地状态，不查询远程版本。主面板和 RedTeam 面板均受此限制。

- 可编辑源码：`D:\dsh\local-plugins\dsh-purge`
- DSH 加载入口：`D:\dsh\data\profiles\desktop\node_modules\dsh-purge`（链接到上述目录）
- 独立备份：`D:\github项目\-dsh-purge`

可直接修改本目录文件；没有设置只读属性或写入权限限制。修改后彻底退出并重新打开 DSH。
修改现有版本不需要改版本号。前端源文件若需要重新构建，沿用插件自带构建脚本。

宿主 profile 的依赖和 pnpm override 均指向此本地目录，不再引用 GitHub master。
`lib/local-version-lock.js` 是包内更新策略；不要删除该文件或使用远程副本覆盖本目录。

备份目录是独立快照，不是指向运行目录的链接。它不会随源码编辑自动变化。
恢复时先退出 DSH，把备份中的插件文件复制回可编辑源码目录，然后重新打开 DSH。
备份内 `.local-backup` 保存 profile 依赖配置、校验清单和验证脚本，不包含 API 密钥或会话。
