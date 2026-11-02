# 代码地图

只放导航指针，不复制实现语义。改代码前先看对应模块。

## 入口与加载

- 插件入口：`lib/index.js`（`apply`、`applyHostHooks`、`purge_*` 工具注册、提示词段）
- 身份与提示词改写：`lib/identity.js`
- 提示词装配变量：`lib/prompt-variables.js`（宿主只注册 provider/model，插件补 `cwd`；`promptHosts` 与 `registerPromptSections` 共用）
- 补丁表与目标：`lib/core.js`（`ALL_PATCHES`、`targetFiles`、`applyPatchesAllHosts`、`revertAll`）
- 桌面安装发现与重启：`lib/desktop.js`
- 宿主依赖解析：`lib/host-deps.js`（锚点候选 + 宿主包根身份核对；`lib/redteam/tools.js` 用它取 `@deepseek-ai/dsh-tools`）
- asar 解包与文件代理：`lib/extract-asar.js`（`hostFs` 路径方法按 asar 映射选 fs；fd 方法直接交给 `node:fs`）
- 宿主面识别：`lib/surface.js`
- 更新锁：`lib/local-version-lock.js`、`lib/update.js`
- RedTeam：`lib/redteam/index.js`、`lib/redteam/tools.js`、`presets/redteam/`
- 预设迁移：`lib/redteam/preset-migration.js`（toolFilter → agentPreset 的文本迁移、子级预设组合裁剪）

## 验证与测试

- 隔离验证：`docs/verification/README.md`、`lib/verify/`、`scripts/verify.mjs`
- 预设与工具契约入口：`lib/verify/preset-entry.js`、`lib/verify/model-endpoint.js`
- 测试：`tests/verify/`；`npm test`（无宿主时集成测试自动 skip）
- 检查：`npm run check`（全量 `node --check` + 入口 import）；`npm run test:unit`
- 钩子：`git config core.hooksPath .githooks` 启用；跳过单次用 `DSH_PURGE_SKIP_HOOKS=1`；钩子跑 `npm run test:ci`（全量测试 + `--test-force-exit` + 单例超时），新增测试文件不用改钩子
- 审查标准：`CODING_STANDARDS.md`（审查代理读；实现代理不需要）

## 常见改动从哪里开始

- 改补丁行为：`lib/core.js` 的 `ALL_PATCHES` / `targetFiles`，在隔离副本上跑 `npm run verify`
- 改提示词注入：`lib/index.js` 的 `registerPromptSections`，用 host-entry 捕获段名与变量
- 改宿主发现或文件操作：`lib/desktop.js` / `lib/extract-asar.js` / `lib/host-deps.js`，配合 fd 探针、文件种类探针与真实安装守卫
