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
- **提交检查**：`npm run check` 全量语法 + 入口 import；pre-commit 钩子启用方式见 `.githooks/pre-commit`。
