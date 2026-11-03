# #24 验证记录

> 票级记录按票分文件（#22 复盘）；本文件只记 A4（DSH NEXT 识别）。

## 回归记录（#24 拆三事实：发行形态 / 是否解 asar / 壳入口）

- **故障（fixture 复现；本机没有 NEXT 真机）**：三件事挤在 `isOfficialHarnessExecutable` 一个布尔上。
  在 fixture 的 `DSH NEXT` 安装树上，**修前**同时成立：
  - `findDesktopAppExecutable` 给空（名单里没有 NEXT）；
  - 壳入口给空（壳入口判定先看「官方」布尔，NEXT 直接返回 `""`，`desktop-shell` 全线未定位）；
  - 带 asar 变体的 `sealedAsarHandoff` 返回 `swapAsar: true`（认不出 exe + 当前进程 resources 里有 app.asar
    → 会真去挪它的 asar）；
  - `listDesktopPids` 的 win32 镜像名只有 `DeepSeek Harness.exe` / `DSH Desktop.exe`，重启/换包漏杀 NEXT。
- **与票面的差异（实测）**：票面写「`detectSurface` 给 web」，**本机实测不成立**。
  `resourcesLookLikeDesktopInstall` 已经按 `resources/app.asar`（或 `resources/app/dsh`）把 fixture 判成桌面，
  所以修前 `detectSurface` 就是 `desktop`。红项按实测落成四项（exe / 壳入口 / 换包 / 进程名），
  `surface` 只作事实记录；形态（form）参与判红——它是另外三项的前提（认不出形态，后面必然为空）。
- **实现（名单只有一份，三事实各读各的字段）**：
  - 名单：`lib/desktop-forms.js` 的 `DESKTOP_RELEASE_FORMS`（harness / desktop / next）。
    exe 候选、便携目录名、注册表名、进程名、快捷方式通配、常见安装位置、安装树名字启发式
    （`looksLikeDesktopName` / `looksLikeDesktopNameTail`）与换包脚本的进程名都由它派生；
    exe 解析收口到 `resolveDesktopExecutable`（sealed handoff / 壳入口 / 状态三处共用）。
    便携目录名收编时补回了旧名 `deepseek-harness`（review 抓到过一次静默收窄）。
  - ① 发行形态：`desktopFormOf` → `isDesktopExecutable` / `isDesktopSurface` / `pathLooksDesktop`。
  - ② 是否解包：`sealedAsarHandoff` 读名单里的 `unpackAsar`。**认得出的形态按名单**（只有官方 Harness 解开），
    认不出的 exe 保留老兜底（当前进程 resources 里有 app.asar）；「不解包」不另起黑名单。
  - ③ 壳入口：`desktopShellMain`（原 `officialShellMain`，改名并接受 input）只看名单里的 `shellEntry`：
    官方 Harness 与 NEXT 都是 `resources/app`，DSH Desktop 不定位（与改动前一致）。
  - `desktopRecognition` 把四项 + 依据收成一份事实：`purge_status` 与入口五报告读同一份。
- **通过证据（本轮 `npm run verify` 报告 `20261103-185501`；对照 #22 的 `20261103-171028`）**：
  - `targets.desktop`（入口五新增）：`ok`，七个案例全绿——`form=next`、`exe` 定位到 fixture（走发现路径，
    不是回读入参）、`swap_asar=false`（带 asar 变体）、`shell_main` 定位到 `resources/app/lib/main.js`、
    `dir-variant-shell`（没有 asar 也照常定位）、`pids-image` 含 `DSH NEXT.exe`、`control-red` 在报告里
    同时给出修前的 `swap_asar: true`。`facts.surface = desktop`、`form = next`、
    `swap_reason` 写明「发行形态 next：不解 app.asar」。
  - `targets.isolated.drifted` 为空；`targets.audit` 假成功 / 状态超前 / 状态落后均为空（布局结算 1 条仍是 #21）；
    真实安装的桌面壳入口仍定位到 `resources/app/lib/main.js`（官方形态不回退）。
  - 拔名单对照：入口五自己就带 `control-red` 用例（`lib/verify/desktop-next.js` 把 NEXT 从名单里临时
    splice 掉、跑一遍、`finally` 插回），报告里能同时看到修后四项与修前的 `swapAsar: true`；
    `tests/verify/desktop-forms.test.js` 另有一份独立对照（exe 空 / 壳入口空 / `swapAsar: true` / 进程名少一项）。
  - 三形态矩阵：官方 Harness `swap=true` 且壳入口定位；DSH Desktop `swap=false`、壳入口不定位（改动前一致）；
    NEXT `swap=false`、壳入口定位。
- **取舍（也写进 #24 评论）**：
  - 认得出的形态按名单：**DSH Desktop 身边带一份 app.asar 时不再换包**（改动前会；它实际不带 asar，属收紧）。
  - 认不出的 exe 保留老兜底，所以「拔掉名单」能复现修前行为，而不是变成另一种静默。
  - `commonDesktopInstallDirs` 改成「位置种类 × 名单顺序」：既有两种形态的目录集合**与先后顺序**逐条不变
    （用例把去掉 NEXT 之后的序列整段比对），NEXT 只照同一套位置加自己的名字。
  - 重启路径（`scheduleRestart` 的 asar 换包分支）也读同一个 `formUnpacksAsar`：NEXT / DSH Desktop 重启时同样不挪 asar，
    「不解包」不只在 `sealedAsarHandoff` 一处成立。
  - 不为 NEXT 新增补丁文案或变体；`desktop-shell` 落点仍是 `resources/app/{lib/,}main.js`，宿主文件布局假设未变。
