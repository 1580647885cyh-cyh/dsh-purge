## Agent skills

### Issue tracker

规格和任务使用 `1580647885cyh-cyh/dsh-purge` 的 GitHub Issues；读取或发布任务前，先读 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认五类状态标签；分流或改变任务状态前，先读 `docs/agents/triage-labels.md`。

### Domain docs

采用单一上下文；探索代码或形成设计前，先读 `docs/agents/domain.md`。

## 仓库导航

- **验证入口**：改宿主适配、提示词/预设注册或管理生命周期前，先读 `docs/verification/README.md`；隔离验证用 `npm run verify`；任何要 import `lib/core.js` 做探查/实验的脚本一律 `npm run probe <file>`（自动切隔离环境 + 宿主预检 + 真实安装只读核对），不要在真实环境直接调 apply/revert。**读报告字段用 `node scripts/report-fields.mjs latest <字段>`**（见 README「报告字段速查」），不要现写一次性脚本，也不要用 read 直接啃 report.json（会被行数上限截断）。
- **本机使用边界**：本机不以 web 为日常面；web 适配只做已复现缺陷，验证停在隔离/测试，不做真实 web 长期看护。
- **桌面/重启探针**：任何会启动/结束桌面进程、或调用 `restartOfficialHarness` / `restart-desktop.js` 的探针，一律走 `npm run probe`，并先读 `docs/verification/probe-gotchas.md`（asar 前置 / 路径过滤 / detached PowerShell / cwd 缓存等本机坑）。
- **脚本参数**：带参数的脚本直接 `node scripts/xxx.mjs …`（如 `node scripts/acceptance.mjs --out docs/compatibility --name rc5-acceptance`）；`npm run xxx -- --flag` 在本机 npm（PowerShell shim，实测 11.21.0）下会把旗标吃掉、只把值传进来，脚本会静默走默认值（#22 复盘）。
- **代码地图**：找模块入口、补丁管线、宿主发现和测试位置，读 `docs/CODE-MAP.md`。
- **宿主契约**：改宿主包调用、预设注册或工具 Schema 前，先读 `docs/host-contract.md`。
- **文档编辑**：改长文档用 `edit` 定点替换/追加，不要 read→write 整文件（读回可能被截断，写完不核对就会静默丢段）；整文件写回后核对 `totalLines` 与 `git diff --numstat` 的删除行数。整文件 write 会写 LF，`git` 的 LF→CRLF 警告属工作树口径，看 `git diff` 不看 stderr。
- **提交检查**：迭代时只跑受影响的测试文件（`node --test tests/verify/<模块>.test.js`）；全量 `npm run test:ci`（`--test-force-exit` + 单例超时）交给 pre-commit 钩子，不要手动重复跑；技能要求「最后跑一次全量」时，以提交钩子的那次为准（#22 复盘：手动跑一遍 + 钩子再跑一遍纯属浪费）。整轮测试与提交钩子约 100–120 s，**放后台跑**，在前台等会撞单次命令预算。`npm run check` 便宜，随时可跑：全量语法 + 入口 import + 四条启发式提示（本次改动新增的未使用导出、测试里的替身调用次数断言、测试自建临时目录、文档新增行里手抄的控制台串/单点计数；只报告不失败）。
- **代码索引**：仓库已建 codegraph 索引（`.codegraph/`，本地、已 gitignore、不进保护基线）；问"某符号在哪/谁调用它"、以及"某条补丁 / 某个报告字段 / 某段行为归哪个模块、谁在读它"时，先用 `codegraph_explore(projectPath=仓库根)`，比 grep+read 快得多。索引由 MCP 侧更新（新增文件未经手动 sync 已可检索），不用手动 sync。
