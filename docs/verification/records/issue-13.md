# #13 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 回归记录（#13 验证工作区保留策略）

- 事实：`npm run verify` 每轮在验证根下建一个 5–6 MB 工作区且从不清理。本轮取证（2026-11-03 07:36，`Get-ChildItem
  D:\dsh\tmp\dsh-purge-verify -Directory` 计数 + 递归求和）：86 个目录 / 484 MB；#11 票面写的是 78 / 413 MB。
  #11 只解决「不再重建宿主副本」，不解决「只增不减」。
- 实现：新增 `lib/verify/retention.js`，`runVerification` 在 `ensureWorkspace` 之后、准备 fixture 之前调用
  `pruneWorkspaces`（根取自 `planWorkspace` 回传的 `base`，不再用 `dirname(workspace.root)` 反推）。四条规则：
  只认 `<YYYYMMDD-HHMMSS>` / `probe-<同样的戳>` 两类名字；本轮工作区永不删（窗口是「最近 keep 个旧工作区」，本轮另算）；
  30 分钟内有写入的目录不删（跳过的目录不占保留名额）；只碰验证根的直接子目录。
- 「还在写」的判据是**目录树里任意一层**的 mtime，不是顶层目录：#13 实现时用的是顶层 mtime，review 指出 `ensureWorkspace`
  建完子目录后顶层 mtime 就不再刷新，跑久的兄弟进程会被当陈旧删掉。现在 `scanTree` 边走边比，发现新 mtime 立刻收手。
- 为什么按名字白名单而不是「删最旧」：`docs/compatibility/rc5-acceptance.md` 引用了 `acceptance-commit` 下的路径，
  删掉就成了悬空引用；`_fixture-cache` 是 #11 的缓存，删掉只是下一轮变慢。名字白名单让这两类天然免疫。
- 参数与报告：`--keep N`（默认 5）、`--no-prune`（关掉时报告写「已关闭（--no-prune）」，不是整段消失）。报告 `retention` 段记
  enabled / root / keep / error / kept / removed / freedBytes / skippedCount / skippedReasons / skipped（前 10 条样例）。
  `report.md` 与两个控制台共用 `describeRetention` 一段话（「保留最近 N 个旧工作区（本轮另算） · 删除 X 个 · 释放 Y MB ·
  跳过 Z 个（原因 ×次数）」），避免三处各写一遍数字格式。
- 记账口径：`freedBytes` 只在 `rmSync` 成功之后累加（删到一半失败的目录既不记「已释放」，也不会假装干净）；清理本身抛错
  （例如根不是 D 盘）由 `resolveRetention` 记成 `retention.error`，验证照常跑完。
- 通过证据：单测 `tests/verify/retention.test.js` 覆盖名字白名单与保留窗口、本轮保护、在跑保护、深写保护、keep=0、
  越界不删、报告段、`--no-prune` 报告；`tests/verify/cli-args.test.js` 覆盖参数契约（默认值、`--keep` 两种写法、
  `--no-prune`、`--stamp`/`--out-root`/`--no-seal`/`--json`）。集成在真实验证里跑一次清理，报告 `retention.removed`
  记下实际删除的目录。

## 本票验收对应（#13 验证工作区保留策略）

- 只清自己的时间戳目录：`pruneWorkspaces` 的名字白名单（`STAMP_BODY` 与 `stampNow` 共用同一形状）+ 单测「只清自己的
  时间戳目录」「不越界」。
- 默认保留最近 5 个，`--keep` / `--no-prune` 可调：参数解析抽到 `lib/verify/cli-args.js` 并单测；`runVerification` 的
  `retentionKeep` / `prune` 选项；单测「keep=0 只留本轮」。
- 本轮工作区永不删、在跑的不删：单测「本轮工作区永不删：即使它落在保留窗口外」「最近还在写的目录不删」「深处还在写也算
  在跑」；跳过原因按类计数进 `retention.skippedReasons`。
- 释放量进报告、清理失败不阻断：`freedBytes` 只在删除成功后累加，删除异常记 `skipped[].reason = "删除失败：…"`；
  `resolveRetention` 兜住抛错并写 `retention.error`。
- 全绿：`npm run check` / `npm run test:ci` / `npm run verify` 本轮各跑一遍。
