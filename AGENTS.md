## Agent skills

### Issue tracker

规格和任务使用 `1580647885cyh-cyh/dsh-purge` 的 GitHub Issues；读取或发布任务前，先读 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五类状态标签；分流或改变任务状态前，先读 `docs/agents/triage-labels.md`。

### Domain docs

采用单一上下文；探索代码或形成设计前，先读 `docs/agents/domain.md`。

## 仓库导航

- **验证入口**：改宿主适配、提示词/预设注册或管理生命周期前，先读 `docs/verification/README.md`；隔离验证用 `npm run verify`，不要在真实安装上执行 apply/revert。
- **代码地图**：找模块入口、补丁管线、宿主发现和测试位置，读 `docs/CODE-MAP.md`。
- **宿主契约**：改宿主包调用、预设注册或工具 Schema 前，先读 `docs/host-contract.md`。
- **提交检查**：`npm run check` 全量语法 + 入口 import + 两条启发式提示（本次改动新增的未使用导出、测试里的替身调用次数断言；只报告不失败）；pre-commit 钩子跑 `npm run test:ci`（全量测试，带 `--test-force-exit` 与单例超时）。
- **代码索引**：仓库已建 codegraph 索引（`.codegraph/`，本地、已 gitignore、不进保护基线）；问"某符号在哪/谁调用它"时先用 `codegraph_explore(projectPath=仓库根)`，比 grep+read 快得多；改动后可 `codegraph sync .` 增量更新。
