import path from "node:path";

/**
 * 桌面发行形态名单（A4 / #24）。
 *
 * 这里是**唯一**的形态名单。三个事实各读各的字段，谁也不许从别人身上推：
 *   ① 这是不是桌面发行形态 —— 落在名单里就是（desktopFormOf）；
 *   ② 它的 app.asar 该不该解开 —— 只有写了解包字段的形态（unpackAsar，官方 Harness）；
 *   ③ 壳入口文件在哪 —— 只看该形态的宿主是不是在 resources/app（shellEntry）。
 *
 * NEXT 就落在「认得出 / 不解包 / 壳入口照常定位」这一格。**「不解包」等价于不在
 * unpackAsar 那一格里，不是另起一张黑名单**；也不要把它做成「不认桌面」或
 * 「找不到壳入口」的副作用（#24 正是为这个连坐拆的）。
 *
 * 本机没有 NEXT 真机：NEXT 的安装目录名与 exe 名由 fixture 定义
 * （lib/verify/desktop-next.js），生产名单与 fixture 用同一份数据，不照抄上游目录名。
 */

const harness = Object.freeze({
  id: "harness",
  label: "DeepSeek Harness",
  // exeNames 是「旁边可能有的那个文件」，installNames 是「安装目录叫什么」，两者别混用。
  exeNames: Object.freeze(["DeepSeek Harness.exe", "deepseek-harness.exe", "DeepSeek Harness", "deepseek-harness"]),
  // 官方 exe 的写法比字面名单松（DeepSeek.Harness.exe / deepseek_harness.exe 都出现过）。
  exePattern: /^deepseek[\s._-]*harness(\.exe)?$/,
  installNames: Object.freeze(["DeepSeek Harness"]),
  // 便携包/安装器留下的目录名，只在用户目录与盘根的一层里猜，不扫盘。
  portableNames: Object.freeze(["DeepseekHarnessDesktop", "DeepSeekHarnessDesktop", "deepseek-harness"]),
  processImage: "DeepSeek Harness.exe",
  shortcutPatterns: Object.freeze(["*DeepSeek*Harness*.lnk", "*deepseek-harness*.lnk"]),
  // ② 只有官方 Harness 把宿主封进 app.asar 并在「应用」时解开。
  unpackAsar: true,
  // ③ 壳入口在 resources/app（解包后就是这个布局）。
  shellInAppDir: true,
  dirHints: Object.freeze(["/deepseek harness/", "/deepseek-harness/", "/deepseekharness", "/deepseek harness.app/"]),
  dirPattern: /\/deepseek[\s._-]*harness/,
  // 祖先目录叫 DeepSeek Harness 的地方很多（npm 前缀、DSH_HOME 的父目录），
  // 必须同时带 resources/ 才算安装树，否则 Web 面会被判成桌面。
  dirNeedsResources: true,
  // 标准安装位置。已上线形态按原有位置原样登记（顺序 = 查找优先级），新形态照同一套位置编。
  locations: Object.freeze({
    localPrograms: true,
    localAppData: true,
    programFiles: true,
    programFilesX86: true,
    applications: true,
    userApplications: true,
    linux: Object.freeze({
      opt: Object.freeze(["DeepSeek Harness", "deepseek-harness"]),
      lib: Object.freeze(["DeepSeek Harness", "deepseek-harness"]),
      share: Object.freeze(["deepseek-harness"]),
      localShare: Object.freeze(["DeepSeek Harness", "deepseek-harness"]),
    }),
  }),
});

const desktop = Object.freeze({
  id: "desktop",
  label: "DSH Desktop",
  exeNames: Object.freeze(["DSH Desktop.exe", "DSH Desktop"]),
  installNames: Object.freeze(["DSH Desktop"]),
  portableNames: Object.freeze([]),
  processImage: "DSH Desktop.exe",
  shortcutPatterns: Object.freeze(["*DSH Desktop*.lnk"]),
  // 第三方客户端不换包；宿主布局也不归我们管（改动前壳入口同样不定位，保持不回退）。
  unpackAsar: false,
  shellInAppDir: false,
  dirHints: Object.freeze(["/dsh desktop/", "/dsh desktop.app/", "dsh-desktop"]),
  dirNeedsResources: false,
  locations: Object.freeze({
    localPrograms: true,
    localAppData: false,
    programFiles: true,
    programFilesX86: true,
    applications: true,
    userApplications: true,
    linux: Object.freeze({
      opt: Object.freeze(["DSH Desktop"]),
      lib: Object.freeze(["dsh-desktop"]),
      share: Object.freeze([]),
      localShare: Object.freeze([]),
    }),
  }),
});

const next = Object.freeze({
  id: "next",
  label: "DSH NEXT",
  exeNames: Object.freeze(["DSH NEXT.exe", "DSH NEXT"]),
  installNames: Object.freeze(["DSH NEXT"]),
  portableNames: Object.freeze([]),
  processImage: "DSH NEXT.exe",
  shortcutPatterns: Object.freeze(["*DSH NEXT*.lnk"]),
  // NEXT 自己就把宿主放在 resources/app：不解 asar，也不因为这个被当成「不认桌面」。
  unpackAsar: false,
  shellInAppDir: true,
  dirHints: Object.freeze(["/dsh next/", "/dsh next.app/", "dsh-next"]),
  dirNeedsResources: false,
  locations: Object.freeze({
    localPrograms: true,
    localAppData: true,
    programFiles: true,
    programFilesX86: true,
    applications: true,
    userApplications: true,
    linux: Object.freeze({
      opt: Object.freeze(["DSH NEXT", "dsh-next"]),
      lib: Object.freeze(["DSH NEXT", "dsh-next"]),
      share: Object.freeze(["dsh-next"]),
      localShare: Object.freeze(["DSH NEXT", "dsh-next"]),
    }),
  }),
});

/**
 * 名单是可变数组：故障对照用例（#24）会临时 splice 掉 NEXT、跑完在 finally 里插回，
 * 用来证明「拔掉生产路径上的名单，四项事实必须重新变红」。生产代码只读，不改这个数组。
 */
export const DESKTOP_RELEASE_FORMS = [harness, desktop, next];

function lastSegment(value) {
  const n = String(value || "").replace(/\\/g, "/");
  const cut = n.lastIndexOf("/");
  return (cut >= 0 ? n.slice(cut + 1) : n).toLowerCase();
}

/**
 * 路径（已 slash + 小写）里有没有这个形态的安装树名：安装目录、.app 包、路径提示都算。
 * 只看名字，不看这个目录存不存在 —— 存在性由调用方的 isFile / isDir 判。
 */
export function formNamesInPath(form, n) {
  const names = form.installNames.map((name) => name.toLowerCase());
  if (names.some((name) => n.includes(`/${name}/`) || n.includes(`/${name}.app/`) || n.endsWith(`/${name}`) || n.endsWith(`/${name}.app`))) return true;
  return (form.dirHints || []).some((hint) => n.includes(hint))
    || Boolean(form.dirPattern && form.dirPattern.test(n));
}

/** ① 发行形态：exe / 安装目录名落在名单里，就返回那一项；认不出返回 null。 */
export function desktopFormOf(filePath) {
  const base = lastSegment(filePath);
  if (!base) return null;
  for (const form of DESKTOP_RELEASE_FORMS) {
    if (form.exeNames.some((name) => name.toLowerCase() === base)) return form;
    if (form.exePattern && form.exePattern.test(base)) return form;
  }
  return null;
}

/** 名单里所有字面 exe 名（保留大小写），给「安装目录旁边有哪些候选」用。 */
export function desktopExeNames() {
  return [...new Set(DESKTOP_RELEASE_FORMS.flatMap((form) => form.exeNames))];
}

/** 结束桌面应用时按进程名找 PID 用的镜像名（win32 tasklist）。 */
export function desktopProcessImages() {
  return [...new Set(DESKTOP_RELEASE_FORMS.map((form) => form.processImage).filter(Boolean))];
}

/** 结束桌面应用时按快捷方式找 exe 用的通配名。 */
export function desktopShortcutPatterns() {
  return [...new Set(DESKTOP_RELEASE_FORMS.flatMap((form) => form.shortcutPatterns || []))];
}

/** 安装目录名（注册表 DisplayName 也按它匹配）。 */
export function desktopInstallNames() {
  return [...new Set(DESKTOP_RELEASE_FORMS.flatMap((form) => form.installNames))];
}

/** 便携包可能用的目录名：安装名 + 各自的变体。只在用户目录与盘根一层里猜。 */
export function desktopPortableNames() {
  return [...new Set(DESKTOP_RELEASE_FORMS.flatMap((form) => [...form.installNames, ...(form.portableNames || [])]))];
}

function linuxInstallDirs(form, home) {
  const spec = (form.locations && form.locations.linux) || {};
  const out = [];
  for (const name of spec.opt || []) out.push(`/opt/${name}`);
  for (const name of spec.lib || []) out.push(`/usr/lib/${name}`);
  for (const name of spec.share || []) out.push(`/usr/share/${name}`);
  for (const name of spec.localShare || []) out.push(path.join(home, ".local", "share", name));
  return out;
}

/**
 * 名单里每个形态的标准安装位置（NSIS / 商店 / 各平台惯例）。
 *
 * 按「位置种类 × 名单顺序」出，不是按形态出：已上线两种形态的目录集合与先后顺序与改动前逐条一致
 * （`tests/verify/desktop-forms.test.js` 钉住），新形态只照同一套位置加自己的名字。
 * 名单里删掉一项，这里就少一组目录。
 */
export function desktopStandardInstallDirs({ local, programFiles, programFilesX86, home } = {}) {
  const forms = DESKTOP_RELEASE_FORMS.filter((form) => form.locations);
  const at = (flag) => forms.filter((form) => form.locations[flag]);
  const first = (form) => form.installNames[0];
  const out = [];
  for (const form of at("localPrograms")) out.push(path.join(local, "Programs", first(form)));
  for (const form of at("localAppData")) out.push(path.join(local, first(form)));
  if (programFiles) for (const form of at("programFiles")) out.push(path.join(programFiles, first(form)));
  if (programFilesX86) for (const form of at("programFilesX86")) out.push(path.join(programFilesX86, first(form)));
  for (const form of at("applications")) out.push(`/Applications/${first(form)}.app`);
  for (const form of at("userApplications")) out.push(path.join(home, "Applications", `${first(form)}.app`));
  for (const form of forms) out.push(...linuxInstallDirs(form, home));
  return out;
}
