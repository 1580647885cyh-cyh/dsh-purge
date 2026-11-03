# #11 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 回归记录（#11 验证 fixture 缓存）

- 背景与实测差异：票面记录的是「本机 78 个工作区 / 413 MB，单轮 verify ~2.5 分钟，绝大部分时间在从 182 MB 的
  app.asar 重解宿主包」。本机复测只成立一半：整轮 `npm run verify` 43–48 s，fixture 步骤只有 1.1–1.4 s
  （43 个包 / 7 MiB）。缓存按票实现，收益只落在 fixture 这一步——整轮由其余阶段决定，本轮没有逐阶段计时，
  也不据此声称别处是瓶颈。
- 实现：新增 `lib/verify/fixture-cache.js`，`prepareFixtureHost` 建副本前先看缓存。
  - 键 = app.asar 的 size + mtime（毫秒取整）：换宿主、换包，键就变，旧目录自然不再命中。
  - 命中：一次 `cpSync` 把 `_fixture-cache/<key>/desktop` 整棵复制到 `<stamp>/desktop`；未命中：逐包从 asar 解到
    缓存目录**旁边的临时目录**，写清单后换名，再整棵复制出去。半成品不会变成命中。
  - 完整性：清单里的键、宿主编译版本、**fixture 配方**（要解哪些包与额外依赖）、两层 `package.json`、每个包的
    `package.json`、两份额外依赖逐项核对；缺一项就按核对给出的原因重建（报告 `fixture.rebuildReason` 记原因，例如
    「包不完整（缺 package.json）：dsh-tools」）。配方必须单独比对：键只由 asar 决定，往 FIXTURE_PACKAGES 加包时
    asar 没变、键也不变，不比对配方就会拿旧缓存静默少包——这正是规则 7 禁止的「用缺记录豁免让固定契约静默通过」，
    #11 审查发现后补的。宿主编译版本同样参与判定：副本里两层 `package.json` 写的就是它，对不上时报告与副本会自相矛盾。
  - 故障不放大：缓存目录写不进、被占用、并发抢占都只回退到「从 asar 解」，验证照常跑完；`fixture.cacheError` 留证据。
  - 边界：缓存落在验证根目录旁边，不属于工作区；工作区快照（`snapshotTree(workspace.install)`）、保护基线（只走仓库源码）
    与真实安装守卫（只核对真实安装 targetFiles）都看不到它。
- 耗时对比（同一台机器，同一份 182 MB app.asar）：

  | 阶段 | 改造前 | 改造后（未命中） | 改造后（命中） |
  | --- | --- | --- | --- |
  | fixture 步骤 | 1198 / 1112 ms（连续两次冷跑） | 1395 ms | 339 / 365 / 331 ms（三次） |
  | 整轮 `npm run verify` | 43.3 s | 48.4 s | 47.8 s |

  fixture 步骤命中时快 3.4–3.8 倍；整轮 43.3 → 47.8 s 的差异落在噪声里，因为 fixture 只占整轮约 3%——票面
  「单轮 ~2.5 分钟、绝大部分时间在解包」的前提在本机不成立，本票不把它当收益写进结论。
  取证口径：改造前的 1198/1112 ms 来自单独计时脚本（改造前报告还没有 fixture 段），改造后来自报告里的
  `fixture.durationMs`（进 report.json）加整轮秒表，不是估算。
  复现：删掉 `_fixture-cache` 目录 → 跑一次 `npm run verify`（未命中，顺带重建缓存）→ 再跑一次（命中），
  对照 `report.json` 的 `fixture.cacheHit` 与 `fixture.durationMs`。
- 通过证据：
  - 单测 `tests/verify/fixture-cache.test.js` 九项：命中复制、size/mtime 失效、缺 package.json / 少包 / 清单损坏重建、
    宿主版本不一致不复用、配方变了不复用、命中后复制失败不假装命中、缓存不可写不阻断、缓存根路径、报告 `fixture` 段区分
    `asar` / `cache`。归档用「头表 + 数据区」的最小构造，断言的是缓存行为（落盘字节、两次 `snapshotTree` 全等、清单里的
    配方）；真实 asar 由本入口与入口三覆盖。
  - 集成（`tests/verify/host-admin.test.js`）：整轮验证里 `fixture.source` 只能是 `asar` 或 `cache`（不能拿真实安装充数），
    缓存目录名匹配 `_fixture-cache/asar-<size>-<mtime>` 且不落在工作区内。
  - 报告：`fixture.source` / `packages` / `extras` / `durationMs` / `cacheKey` / `cacheDir` / `cacheHit` /
    `rebuildReason` / `cacheError`；`report.md` 的「隔离边界」一节逐条打印来源与耗时。

## 本票验收对应（#11 验证 fixture 缓存）

- 缓存键 = asar 的 size + mtime，目录在 D 盘 `tmp/dsh-purge-verify/_fixture-cache/<key>/`：`fixtureCacheKey` /
  `fixtureCacheRoot`，单测「asar 的 size/mtime 变了就自动失效」逐项验证（只改 mtime、再改大小）。
- 命中走 `cpSync`、未命中才从 asar 解，来源可区分：`prepareFixtureHost` 的两条返回路径，报告 `fixture.source` 取
  `cache` / `asar` / `install`；`report.md` 分别打印「（命中缓存，整棵复制）」与「（从 app.asar 解）」。
- 缓存不参与基线、不参与真实安装守卫：缓存目录在工作区外（集成测试断言 `isWithin(cacheDir, workspace.root) === false`），
  基线只遍历仓库源码条目，守卫只 stat 真实安装的 targetFiles。损坏或不完整（缺 package.json / 少包 / 清单坏 / 宿主版本变 /
  配方变）自动重建：单测「缺 package.json、少包、清单损坏都会重建」「宿主版本不一致时不复用旧副本」「配方变了就不复用」。
- 命中时变快并记录对比：见上一节的耗时表（fixture 步骤 1.1–1.4 s → 0.33–0.37 s），并写清取证口径。
- `npm run check` / `npm run test:ci` / `npm run verify` 全绿，缓存逻辑有单测（命中、失效、重建）：本轮三个命令各跑一遍通过
  （check：93 个文件 / 2 个入口；test:ci：74 tests、74 pass、0 fail，含 49–52 s 的宿主集成用例；verify：报告 ok）。
- 缓存只增不减（旧键不自动清理）：每份实测 6.6 MiB，删掉 `_fixture-cache` 目录即回收；自动清理不在本票范围——票面提到的
  413 MB 工作区膨胀另有来源，本票只负责不再重建宿主副本。
