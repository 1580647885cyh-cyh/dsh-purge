# #21 验证记录

> 从 `docs/verification/README.md` 拆出（#22 复盘：票级记录按票分文件，README 只留导航与入口）。

## 回归记录（#21 web 身份句重定向到 dev-context + 窗口锚点）

- 故障（rc.5 实测）：`#32`/`#53` 指向 `web-app-lib`，但这段提示词已搬到 `dsh-harness-dev-context/lib/index.js`：
  `WEB_SURFACE_PROMPT` 整段（句尾从 `at ${webUrl}.` 换成 `whose URL the runtime context names.`）、
  `LEGACY_WEB_SURFACE` 的 prefix/suffix，以及 `Current DeepSeek Harness Web GUI URL:` 那条运行时上下文。
  旧整句锚点一次都命中不了：隔离副本里两条补丁是「不适用」，真机漂移清单 3 条（`#32`/`#53`/`#77`）。
- 实现：
  - 新增落点键 `dev-context`（`TARGET_FILE_KEYS` 64 → 65）：桌面布局 `dsh-harness-dev-context/lib/index.js`、
    npm 嵌套 `dsh/node_modules/@deepseek-ai/…`、源码仓库 `packages/context/harness-dev-context/lib/index.js`。
    旧键 `web-app-lib` 保留（老版本宿主与既有 `.dshpurge.bak` 仍认它），但两条补丁不再依赖它。
  - `#32`/`#53` 改成窗口锚点：`const WEB_SURFACE_PROMPT =` 方法头钉死，中间用非贪婪窗口吃掉并原样搬回，
    窗口里排除本插件 marker（A3 的口径，见 `docs/dsh-adaptation-backlog.md`）。窗口都带字符上限（2000 / 240 / 160），
    右侧钉结构而不是钉句意：#32 收在语句结尾的 `` `; ``，`#53` 收在下一句 `When the user refers` 的开头——
    两轴 review 用「句尾拉长」「两句连写」「上下文行换成普通字符串」三种改写试过：都只会失配进漂移，不会吞掉正文。
    #32 只把产品名换成 local、句尾原样搬回；#53 再把身份句与「Do not start a replacement server」整句删掉。
    #32 的第二条锚点另钉 `text: () => `…`` 这个字段形状（同文件还有一句 `Current DeepSeek Harness implementation
    checkout`，只认品牌词会让窗口跨语句），并在行尾写同一枚标记：只命中一条时状态也看得见。
  - `LEGACY_WEB_SURFACE` 是宿主**冻结**的旧段落（用来匹配老会话已记录的提示词），#53 的删除窗口以
    `const LEGACY_` 为界跨不过去；故障对照里旧的整句锚点会把那份一起删掉，正是这条边界存在的理由。
  - 标记分开：#32 写 `[dsh-purge] web surface identity neutralized`（写在语句行尾），#53 写
    `[dsh-purge] web surface identity sentence dropped`（写在语句上方一行）。两处都在模板字面量之外，
    不会进提示词正文。共用同一个标记会让 #32 的标记替 #53 结算状态（#53 一个字没写也报 applied）；
    反方向（#53 删掉 #32 改名后的整句、#32 只剩标记）是有意保留的：删整句是更强的目标态，最终文件里
    产品名一处不剩，由 `tests/verify/targets.test.js` 的 `DeepSeek Harness Web GUI` 计数钉住。
  - 顺带修掉两条被新用例顶出来的问题：① `WEB_SURFACE_PROMPT` 的替换少一个空格（`localWeb GUI`）；
    ② `targetFiles` 在 npm 嵌套布局里先把 4 个备用键（`*-nested`）并进 `files` 再做键集合比对，会当场报
    「解析器多出」——改成「先比对注册键，再并 `nestedTargetFiles`」，这与 `ALT_FILE_KEYS`「不在注册表里」的约定一致。
  - fixture 配方加 `dsh-harness-dev-context`：不加的话隔离副本里这两条永远是「不适用」，等于没有验收对象。
    配方参与缓存核对，旧缓存自动重建（本轮 `fixture.durationMs` ≈ 3.2 s、`fixture.packages` = 44、缓存未命中一次）。
- 通过证据（`20261103-160023` 报告）：
  - 漂移清单只剩 `#77`（`conversation-client` 的 `append(record)`，属 A3-2）：`targets.isolated.drifted = [77]`。
    真机 `unmatched` 仍是 `#21`/`#80`/`#77`，前两条是布局软结算/自标记型，本来就不进漂移清单。
  - `#32`/`#53`：`statusAfter = applied`、`evidence = effective`、落点 `dev-context` —— 处理确实写进了文件，
    不是「宿主本来就满足」。改写目标以本机 rc.5 原文为 fixture（`tests/verify/targets.test.js` 的 `RC5_DEV_CONTEXT`
    逐字节抄自安装目录，含转义反引号），不是手写骨架。
  - `admin.diffs`：apply.changed = 48（本票之前 47，新增的就是 dev-context 落点）、reapply.changed = 0、
    revert.changed = 48 全部还原；`audit` 假成功 0 / 超前 0 / 落后 0。
- 取舍（写进宿主的新文案）：`#53` 不再写回 `Local web GUI: ${webUrl}.`。rc.5 这一节是 `interpolate: false`，
  而且 `webUrl` 变量根本不存在，写回去只会留下字面量；URL 现在由宿主自己的运行时上下文行给出，
  所以身份句是整句删除。补丁写进宿主的语义（去掉身份句与禁止另开服务器）没变。

## 本票验收对应（#21 web 身份句重定向与窗口化）

- 新键覆盖三种布局，且不把备用键判成漂移：`tests/verify/targets.test.js`「目标定位：dev-context 键覆盖桌面布局、
  npm 嵌套与源码仓库」逐条断言（含嵌套布局下 `system-prompt-nested` 合法出现）。
- 隔离副本从 skipped/unmatched 变成 applied：报告 `targets.isolated` 的 `#32`/`#53` 行 = applied / effective，
  落点 `dev-context`；`targets.isolated.drifted` 只剩 `#77`。
- 故障对照（把锚点改回旧的 `web-app-lib` 写法就红）：同文件「故障对照：把锚点改回旧 web-app-lib 写法，这一组必须红」——
  旧整句锚点在 rc.5 文本上一次都不命中（`patchEffectState = unmatched`），旧的字面删除还会把 LEGACY 里冻结的那份删掉。
- 原文不许动：`#53` 之后 `LEGACY_WEB_SURFACE` 整段与原文逐字节相同；身份句/禁止句在全文里各只剩 legacy 那一份。
- 真机 `npm run verify`：通过，漂移清单少这两条（`targets.isolated.drifted` 只剩 `#77`），其余入口不变；
  apply 文件数 47 → 48 是新增的 `dev-context` 落点（`admin.diffs.apply.changed`）；`npm run check` 与
  `npm run test:ci` 全绿。
