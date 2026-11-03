# 代码地图

只放导航指针，不复制实现语义。改代码前先看对应模块。

## 入口与加载

- 插件入口：`lib/index.js`（`apply`、`applyHostHooks`、`purge_*` 工具注册、提示词段）
- 身份与提示词改写：`lib/identity.js`
- 提示词装配变量：`lib/prompt-variables.js`（宿主只注册 provider/model，插件补 `cwd`；`promptHosts` 与 `registerPromptSections` 共用）
- 补丁表与目标：`lib/core.js`（`ALL_PATCHES`、`targetFiles`、`applyPatchesAllHosts`、`revertAll`）
- 补丁语义：`lib/patch-model.js`（`observe` / `effectOf` / `statusFacts`、受检键注册表 `TARGET_FILE_KEYS`、`assertPatchTable`；迁移清单见 `docs/patch-model-migration.md`）
- 桌面安装发现与重启：`lib/desktop.js`
- 宿主依赖解析：`lib/host-deps.js`（锚点候选 + 宿主包根身份核对；`lib/redteam/tools.js` 用它取 `@deepseek-ai/dsh-tools`）
- asar 解包与文件代理：`lib/extract-asar.js`（`hostFs` 路径方法按 asar 映射选 fs；fd 方法直接交给 `node:fs`）
- 宿主面识别：`lib/surface.js`
- 桌面发行形态名单：`lib/desktop-forms.js`（harness / desktop / next；①形态 ②是否解 asar ③壳入口 各读各的字段）
- 宿主版本与适配状态：`lib/host-version.js`（`parseHostVersion` / `hostTargets` / `hostAdaptation` / `readHostVersion`；A1 / #18，只报告不阻断）
- 更新锁：`lib/local-version-lock.js`、`lib/update.js`
- 桌面退出留痕（A5 / #25）：`lib/exit-ledger.js`（`<DSH_HOME>/dsh-purge/exit-ledger.jsonl` 的读写契约与描述；写入方在宿主 close 回调里是内联副本，补丁 #90）
- RedTeam：`lib/redteam/index.js`、`lib/redteam/tools.js`、`presets/redteam/`
- 预设迁移：`lib/redteam/preset-migration.js`（toolFilter → agentPreset 的文本迁移、子级预设组合裁剪）

## 验证与测试

- 隔离验证：`docs/verification/README.md`、`lib/verify/`、`scripts/verify.mjs`
- 目标定位与适配状态（#6）：`lib/verify/targets.js`（逐文件目标态判定）、`lib/verify/target-entry.js`（入口五：定位、应用、运行结果证明）
- 备份/恢复故障注入（#7）：`lib/verify/backup-faults.js`（完整备份 / 过期备份 / 0 字节备份），由入口三调用
- NEXT 安装树 fixture 与入口五四事实（#24）：`lib/verify/desktop-next.js`
- 桌面退出留痕 harness（#25）：`lib/verify/exit-trace.js`（close 回调作用域注入 + 拔痕对照 + purge_status 读侧）
- 参数解析（#13）：`lib/verify/cli-args.js`（`scripts/verify.mjs` 的参数契约，含 `--keep` / `--no-prune`）
- 验收入口参数（#22 复盘）：`lib/verify/acceptance-args.js`（`scripts/acceptance.mjs` 的 `--out` / `--name` / `--stamp`；
  位置参数 = npm 吞掉旗标后留下的值，当用法错误处理）
- 工作区清理（#13）：`lib/verify/retention.js`（只清 `<stamp>` / `probe-<stamp>`，本轮与在跑的不清，释放量进报告）
- fixture 缓存（#11）：`lib/verify/fixture-cache.js`（键 = app.asar size+mtime；命中整棵复制、未命中从 asar 解；缺包/损坏自动重建）
- 隔离探针：`scripts/probe.mjs`（`npm run probe <file>`，切环境 + 宿主预检 + 真实安装只读核对）
- 只跑入口五：`node scripts/verify.mjs --only targets`（~35 s，跳过宿主/预设/模型/管理入口；报告写明只跑了哪一段）
- 读报告字段：`node scripts/report-fields.mjs [latest|<stamp>|<report.json>] <点路径…>`（`lib/verify/report-fields.js`），取不到的字段进 `missing`
- 验收与兼容记录（#8）：`scripts/acceptance.mjs`（`npm run acceptance`）、`lib/verify/acceptance.js`、`docs/compatibility/`
- 预设与工具契约入口：`lib/verify/preset-entry.js`、`lib/verify/model-endpoint.js`
- 测试：`tests/verify/`（验证设施）、`tests/lib/`（补丁模型 / 表校验 / 接线检查）、`tests/archive/`（原版与能力面守卫）；`npm test`（无宿主时集成测试自动 skip）
- **宿主原文 fixture**：`tests/verify/host-text-fixtures.js` —— 测试里**声称是宿主原文**的文本只能登记在这里，
  由 `host-text-fixtures.test.js` 回真机核对子串；手写骨架会被判成「证据自证」（#21 复盘钉的故障对照）。
  故意裁过的等价形状留在各自测试里，不要混进登记表。
- 原版 1.1.71 与能力指纹：`docs/original-1.1.71.sha256.json`（108 文件清单）、`docs/original-1.1.71.capability.json`（工具/预设行/技能/内嵌提示词哈希）；守卫是 `tests/archive/original-1.1.71.test.js`
- 检查：`npm run check`（全量 `node --check` + 入口 import）；`npm run test:unit`（除真宿主电池外的全部测试，秒级；清单由 `tests/lib/wiring.test.js` 守，新增测试文件必须加进去）
- 钩子：`git config core.hooksPath .githooks` 启用；跳过单次用 `DSH_PURGE_SKIP_HOOKS=1`；钩子跑 `npm run test:ci`（全量测试 + `--test-force-exit` + 单例超时），新增测试文件不用改钩子
- 审查标准：`CODING_STANDARDS.md`（审查代理读；实现代理不需要）
- 架构审查候选与顺序：`docs/architecture-review-2026-11-03.md`（13 条深化机会、证据行号、强度与先后；起手新候选前先读它）
- **DSH 适配清单**：`docs/dsh-adaptation-backlog.md`（8 条要做的、4 条不需要、能力面红线、顺序与验收；动手前先读它和 ADR-0002）

## 常见改动从哪里开始

- 改补丁行为：`lib/core.js` 的 `ALL_PATCHES` / `targetFiles`，在隔离副本上跑 `npm run verify`。**新增/改指落点键时同步 `lib/verify/admin-entry.js` 的 `FIXTURE_PACKAGES`**——它是隔离副本的白名单，漏了包这两条补丁在副本里一路报「不适用」，而整轮报告仍然是绿的（`tests/verify/host-admin.test.js` 有一条跨检兜底）
- 改提示词注入：`lib/index.js` 的 `registerPromptSections`，用 host-entry 捕获段名与变量
- 改宿主发现或文件操作：`lib/desktop.js` / `lib/extract-asar.js` / `lib/host-deps.js`，配合 fd 探针、文件种类探针与真实安装守卫
