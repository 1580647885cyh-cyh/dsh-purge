# 补丁模型迁移清单（issue #15）

第一刀把补丁语义收进 `lib/patch-model.js`，但 82 条补丁仍按老字段书写。这份清单是**终局**：
老字段允许并存，但每迁一条就从这里划掉一条；清单见底才允许删掉 `patch-model.js` 里读老字段的分支。

## 现状（2026-11-03，运行时统计 ALL_PATCHES，82 条）

| 字段 | 条数 | 迁移后由谁承担 |
| --- | --- | --- |
| `replacements` | 75 | `rewrite(text, patch, path)` |
| `patterns` + `replace` | 7 | `rewrite` |
| `marker` | 6 | `observe().ownMark` |
| `markers` | 75 | `observe().ownMark` |
| `markersAny` | 18 | `observe().ownMark`（标记聚合规则内化） |
| `forbid` | 5 | `observe().ownMark` |
| `settledWhen` | 1 | `observe()` 的目标态判定 |
| `skipIfMarked` | 34 | `rewrite` 的幂等不变量 |
| `softSettle` | 3 | `settle: "layout-soft"` 字段 |
| `strictFiles` | 3 | `settle: "strict"` + 报告口径 |
| `optional` | 43 | 保持（语义是「缺组件不算失败」，与状态判定无关） |
| `provenance: false` | 3 | 保持（`looksPatchedAlready` 的判据） |
| `surfaces` / `rel` | 5 / 24 | 保持（面过滤与备份清单，不属于补丁语义） |

`name` / `layer` 现在 82 条齐全（早前文档里的「只有 40 条」是错的），不需要迁。

## 迁移顺序

1. **种类先落字段**：`settle: "layout-soft" | "strict"`、`kind: "legacy-apply"` 写进表；`patch-model.js` 里按 id 认的 `LAYOUT_SOFT_IDS` 与 `isLegacyApplyPatch` 的 id 分支随之删除。
2. **完成标记**：`markers` / `markersAny` / `marker` / `forbid` / `settledWhen` → `observe().ownMark`。
3. **改写**：`replacements` / `patterns`+`replace` → `rewrite()`；`skipIfMarked` 变成 `rewrite` 的幂等断言。
4. **删兼容层**：`patch-model.js` 末尾的「兼容导出」段与 `core.js` 的 re-export 一起删掉。

## 与 client.js 的词表关系

插件这一侧只产出六个状态词（`STATUS_WORDS`）。`client.js:1054–1065` 的 `statusKind`/`statusLabel` 另外还容错
`unmatched` / `unlocated` / `off` —— 那三个词在插件侧已经（或从来）没有产出者，属于客户端的宽容错分支。
本 issue 明确不改 `client.js`，所以这些分支留着；将来要清理，属于客户端那一侧的任务，不是补丁模型的。

## 现在的护栏

- `assertPatchTable(ALL_PATCHES)` 在 `core.js` 加载时跑：未知 `file` 键、重复 id、字段类型错误 → 加载即失败。
- `targetFiles` 每次解析后与 `TARGET_FILE_KEYS` 比对，解析器与注册表漂移即报错。
- `tests/lib/` 三条故障对照：键名写错、重复 id / 字段类型、键集合漂移（两个方向）。
- 接线检查：`core` 用到的每个模型函数都必须真的导入（防 `filePatchOutcome is not defined` 那类漏接）。
