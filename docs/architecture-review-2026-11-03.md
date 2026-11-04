# 架构审查：深化机会（2026-11-03）

一次 `/improve-codebase-architecture` 的产出。审查报告本身是**临时产物**（写在系统临时目录），
这里只留结论与证据，供后续每个候选起手时当规格输入。

- 词汇（codebase-design）：**module** / **interface** / **depth** / **seam** / **adapter** / **leverage** / **locality**。
  判据两条：**deletion test**（删掉它，复杂度是消失还是散到 N 个调用者）与 **interface 就是测试面**。
- 领域词沿用 `GLOSSARY.md`：保护基线、内核、已知故障、待自愈、受控模型端点、fixture 缓存、预设迁移、子级预设。
- 行号以本文档写作时的源码为准；`lib/core.js` 刚被候选 1 重排过（-298 行），涉及它的行号已按当前树更新。

## 谁已经做完

- **候选 1 · 补丁条目与状态**：已落地并关闭（#15）。老字段的迁移终局见 [patch-model-migration.md](patch-model-migration.md)。
- **附带**：验证设施里「受控模型端点反向案例偶发 0 请求」的既存竞态已修并关闭（#16）。

## 顺序与强度

| # | 候选 | 强度 | 主要落点 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 补丁条目与状态 | Strong | core.js / patch-model.js | 已完成 #15 |
| 2 | 可逆性与写路径 | Strong | core.js / hooks-deny.js | 待做（与 1 同域，按迁移清单推进） |
| 3 | 验证裁决（judge） | Strong | verify/report.js / run.js / acceptance.js | **下一棒** |
| 4 | 测试面 | Strong | tests/verify 与各入口 | 待做（它的收益随 3 落地兑现） |
| 5 | 提示词装配 | Strong | index.js / identity.js | 待做 |
| 6 | admin-entry 四概念拆分 | Strong | verify/admin-entry.js | 待做 |
| 7 | 宿主发现与布局 | Worth | core.js / desktop.js / host-deps.js / verify/targets.js | 待做（波及面大） |
| 8 | 宿主对齐状态 | Worth | reapply.js / index.js | 待做 |
| 9 | 入口骨架与记录形状 | Worth | verify/*（六个入口） | 待做（排在 3 之后） |
| 10 | 预设 YAML | Worth | core.js / skills.js / preset-*.js | 待做 |
| 11 | RedTeam 两个前门 | Worth | redteam/store-core.js / tools.js | 待做 |
| 12 | HTTP 路由 | Worth | index.js（installWebServer） | 待做 |
| 13 | 状态快照（gatherState） | Speculative | core.js / index.js / client.js | 待做（牵动面板，单独立项） |
| 14 | web-reclaim 记录/决策/sidecar/注入 | Worth | lib/web-reclaim.js | 待做（A6-1 复盘新增） |

## 逐条证据（只写能核对的东西）

### 2 · 可逆性与写路径

三条写路径（`core.js:6887 applyPatches`、`patchWatchedClientBundlesSync`、`hooks-deny.js:88–136` 不经过补丁表）、
四个读循环（`core.js:7016 patchStatus`、`verify/targets.js:72–144 inspectPatchTargets`、
`core.js:6147 looksPatchedAlready`、`core.js:7789 patchStatusReady`）。
最贵的后果：改补丁 30/31/64/65 的 `replace` 忘了同步 `hooks-deny.js:25–86` 的 8 条 `find`/`replace` 对，
`restoreHookDenyOfficial`（:108）命中 0 条后按「已经是官方形态」处理（:123–125），**静默留下 bypass**。
终局：`applyOne / revertOne`，revert 的 find 由条目派生（`revertsFrom` 字段位已在候选 1 留好）。

### 3 · 验证裁决

「通过」被算六遍：各入口自算 `record.ok`（admin-entry:441、host-entry:237/668、preset-entry:236、target-entry:344）、
`run.js:105/172` 在调用点再 AND、`report.js:204–215` 合成 `ok`、`knownFailures` 另立 16 组条件、
`acceptance.js:14–25` 反推 10 条谓词、`report.js:504–515` 渲染器再搓一份。
三条硬证据：
1. **会员不一致**：`ok` 不含 `admin.backupFaults`，`acceptance.js:23` 却把它列为独立通过项。
2. **丢证据**：`run.js:166–170` 把随包预设探针投影成 `{ok, dir, toolFilter}`，`error/composition/migrated/worker` 全没了；
   `run.js:172` 又并进 `presetEntry.ok` ⇒ 随包预设单独失败时「有结论、无原因」。
3. **不可达**：`report.js:92` 的 `else if (presetAudit …)` 挂在 `if (presetEntry)` 上，而 run.js 两条路径都会赋值。
终局：`judge(facts) → [{id, severity: hard|known, summary, evidence, owner}]`，`severity` 把今天只写在散文里的契约写进数据。

### 4 · 测试面

六个入口共用一个 `host-admin.test.js`：1 个 test、timeout 300 s、98 处 `assert.*`
（`timeout` 与计数见 tests/verify/host-admin.test.js:22 与本文件写作时的 `grep -c "assert\."`；
300 s 的实测口径见 docs/verification/README.md「测试超时的口径」）。
tests 对 lib 的 import 只有 26 条（19 个模块），`identity` / `reapply` / `desktop` / `store-core` / `tools.js` 零单元覆盖。
两处「赝品形状」养出死代码：`acceptance.test.js` 的 `asar.mtime`（生产端只有 `mtimeMs`，`acceptance.js:139` 永不命中）、
`retention.test.js:10` 注释里的 `minAgeMs`（实现里没有）。

### 5 · 提示词装配

三条宿主入口（`index.js:375–420` 声明段、`:743–780` waterfall、`:721/792` 猴补丁 `prompt.assemble`），
而 guard 包的正是宿主 assemble，宿主 assemble 内部自己又 fire `system-prompt/assemble`（见 `tests/verify/targets.test.js:48–57`）
⇒ **一次 assemble 跑两遍 rewritePromptAssembly**，于是四处手写去重（`identity.js:327–377、746、633、971–987`）。
`identity.js` 994 行、零单元 import；唯一相关约束在 `verify/host-entry.js:514–519`，要真宿主。

### 6 · admin-entry 四概念

459 行里住着 fixture 构建（:23–176）、真实安装只读守护（:218–248）、宿主枚举与工具调用（:196–256）、
以及它名字承诺的管理生命周期（:358–460，约 100 行）。
消费方按概念找不到模块：`scripts/probe.mjs:13–14` 与 `tests/verify/fixture-cache.test.js:5` 都从「管理生命周期入口」里取 fixture。

### 7 · 宿主发现与布局

三组助手三角形：`isAiBase` ×3（core:198 / desktop:77 / host-deps:39）、`isDir` ×3、`pathIsUnder/isSubPath/within` ×3；
四份候选枚举（core 的 `findAiBase*`、desktop 的 `packageRoots*`、host-deps 的 `addDesktopRoots`、surface 的 `resourcesLookLike*`）；
两个 asar 可写判据（`desktop.js:50–57` vs `extract-asar.js:96–120`）。
布局侧：`targetFiles`（core.js:6374，64 键）↔ `verify/targets.js:19–34 MISSING_KEY_PATHS`（11 键，注释自称「不参与解析」）
↔ `target-entry.js:290–301` 手写 shell 候选；fixture 侧 `admin-entry.js:86–88` ↔ `fixture-cache.js:78–88`。

### 8 · 宿主对齐状态

`reapply.js:100–198` 的 8 个谓词（stampMatches:100 / hostStillHasAppliedPatches:116 / canHealEmptyStamp:132 /
patchesMatchInstall:138 / hostPatchesStillPending:148 / patchesMatchInstallStrict:160 / hostCleanEnoughToKeep:170 /
patchesLostAfterHostReset:183）+ `index.js:885–1009` 的 120 行决策树；`index.js:901` 直接
`patchesMatchInstallStrict() || hostCleanEnoughToKeep()` —— 意图是三值状态，用两个布尔表达。
`ensureHostClean` 与 `reapplyInstalled` 是同一段编排的第二份实现，退出形状还不同。

### 9 · 入口骨架与记录形状

六份「切环境 → 预检 → 跑 → 记结果」骨架；已验证计数（`grep -rn` 于 lib/ 与 scripts/，2026-11-03）：同款错误串 `String(error && error.message ? …)` **73 处 / 22 文件**、
`record.ok = Boolean(…)` 7 处、`kind` 标签 12 个 / 4 种命名风格、`assertHostsIsolated` 两个调用点
（`admin-entry.js:254` 与 `probe.mjs:61` 内联重写）。
兄弟入口横向依赖：`target-entry.js:6` 借 admin-entry 的 4 个 helper，`model-endpoint.js:3` / `preset-entry.js:4` 借 host-entry 的 `moduleUrl`。

### 10 · 预设 YAML

「改预设里一个字段」四套实现：`core.js` 的 14 个折叠块助手、`skills.js:97–260`、`preset-migration.js:35–169`、
`preset-composition.js:311–403`（唯一真解析器，只用于读自己的随包预设）。
顺序问题：apply 写完 YAML 后无条件再跑 `sanitizeYamlPersonaScalars`，重排器不知道补丁想留什么，
而目标态判定用补丁原文 ⇒ `softSettle` 兜底（`core.js` 里 #21/#24 那族注释）。

### 11 · RedTeam 两个前门

`store-core.js:739–867` 的 dispatch 有 60+ 个 `if (op === …)`，但 `tools.js` 对 dispatch 的引用 **= 0**：
删掉 dispatch，56 个工具一个都不坏（复杂度是被复制而不是隐藏）。op 名与工具名不对应
（`redteam_asset_query ↔ op: assets`）；`dispatch` 的参数契约每个 op 一套双关写法（12 处 `req.x || req`）；
错误被吞成字符串后靠 `tools.js:331` 的正则猜。

### 12 · HTTP 路由

`index.js:1754–2325` 的 `installWebServer`（以下计数用 `grep -c` 数 lib/index.js）：16 条路由、25 处手工方法守卫、15 处手写 405、52 次 `sendJson`、
123 个 try 块，两套注册机制（`registerPluginRoute` 与 `registerRoute`）。
`allowPluginRequest`（:1719）已证明「把共性收一处」可行，剩下的流程还没收。

### 14 · web-reclaim 的记录 / 决策 / sidecar / 注入（A6-1 复盘新增）

`lib/web-reclaim.js` 约 408 行里住着四种关注点：记录文件读写（`webServerRecordPath` / `read` / `write` / `remove`）、
纯决策（`decideWebReclaim` / `recordDispositionAfterKill`）、sidecar 源（`webReclaimEntrySource` 的 300 行模板）、
以及 `bin.js` 注入/还原（`install...` / `revert...`）。测试面也按这四件事各写一段。
删掉注入/还原，记录与决策仍独立可用；删掉 sidecar 源，安装器只剩一个文件拷贝。终局：
`web-server-record` / `web-reclaim-decision` / `web-reclaim-entry`（自包含源，测试直接跑）/ `web-reclaim-install`。
约束：sidecar 仍不得 import 插件；记录路径与 helper `findDshHome` 的契约先按 #29 的测试钉住。

### 13 · 状态快照

`core.js:7791 gatherState` 返回 30+ 平铺字段，其中 `patches_*` 由循环累加、`display_*` 由 `tallyDisplayPatches` 再算一遍。
删掉循环累加，`display_*` 仍得同样的数 —— 那段是透传。调用方因此要写
`state.display_applied ?? state.patches_applied`（`index.js:1787–1830`）。

## 明确的边界（每条候选都受约束）

- 不改 `client.js`、不改对外状态字符串、不改 `npm run verify` 的验收口径（ADR-0001）。
- 固定契约不得降级成已知故障；故障对照必须证明「去掉修复会失败」（CODING_STANDARDS #6/#7）。
- 候选 1 已决定**不合并**四个补丁数组；要合并另立一项。
