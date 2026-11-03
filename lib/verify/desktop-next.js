import fs from "node:fs";
import path from "node:path";
import { DESKTOP_RELEASE_FORMS } from "../desktop-forms.js";

/**
 * A4 / #24：fixture 造的 `DSH NEXT` 安装树，以及入口五要落报告的四项事实。
 *
 * 本机没有 NEXT 真机，所以目录名与 exe 名由这份 fixture **写下**（不抄上游真机名）。
 * 生产名单（lib/desktop-forms.js）里的 `next` 项必须与这里同名：两条断言把这三处字符串钉在一起
 * （`tests/verify/desktop-forms.test.js` 的「fixture 与生产名单同名」），改名时不会一边静默漂掉。
 *
 * 树形只差一件事：NEXT **不解 asar**，宿主直接住在 `resources/app`。
 * 带 asar 的变体（升级/换包留下的归档）用来钉住「有 asar 也不换包」这一格。
 *
 * 四项事实（与票面一致）：exe 定位 / 壳入口 / 带 asar 变体的 sealedAsarHandoff / 进程名集合。
 * 形态（①）与 surface 单独记事实、不单独判红：本机实测 resources 启发式已经能把桌面判出来，
 * 票面写的「detectSurface 给 web」与实测不符（差异写进 #24 评论与验证记录）。
 */

const NEXT_FIXTURE = Object.freeze({
  dirName: "DSH NEXT",
  exeName: "DSH NEXT.exe",
});

function writeFile(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
}

/**
 * 造一棵 dir 形态的 NEXT 安装树：exe + resources/app/lib/main.js。
 * asarVariant 为真时再加一份 app.asar —— 只用于「有没有 app.asar」这一判定面，不是可解归档。
 */
function prepareNextInstall({ root, shellSource = "", asarVariant = true } = {}) {
  fs.rmSync(root, { recursive: true, force: true });
  const install = path.join(root, NEXT_FIXTURE.dirName);
  const exe = path.join(install, NEXT_FIXTURE.exeName);
  writeFile(exe, "fixture\n");
  const resources = path.join(install, "resources");
  const shell = path.join(resources, "app", "lib", "main.js");
  if (shellSource && fs.existsSync(shellSource)) {
    fs.mkdirSync(path.dirname(shell), { recursive: true });
    fs.copyFileSync(shellSource, shell);
  } else {
    writeFile(shell, "// fixture: NEXT shell entry\n");
  }
  const asar = path.join(resources, "app.asar");
  if (asarVariant) writeFile(asar, "fixture-asar\n");
  const env = {
    ...process.env,
    DSH_HOME: path.join(root, "home"),
    DSH_BASE: path.join(root, "base"),
    DSH_DESKTOP_INSTALL: install,
    LOCALAPPDATA: path.join(root, "localappdata"),
    APPDATA: path.join(root, "appdata"),
    USERPROFILE: path.join(root, "home"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    PATH: path.join(root, "emptybin"),
  };
  return { root, install, exe, resources, shell, asar, env };
}

/**
 * 入口五要证的是「发现」而不是「回读入参」：这里给一个中立的进程 exe，
 * 让 desktopRecognition 走 findDesktopAppExecutable（安装树旁边的候选 + 常见目录）。
 * 「进程就是 NEXT.exe」那条路径由三形态矩阵覆盖（execPath 直接指向各形态的 exe）。
 */
function factsOf(core, fixture) {
  return core.desktopRecognition({
    execPath: path.join(fixture.root, "runtime", "node.exe"),
    resourcesPath: fixture.resources,
    argv: [],
    env: fixture.env,
  });
}

/** 临时把名单里的 next 摘掉（故障对照），跑完必插回。 */
function withoutNextForm(fn) {
  const index = DESKTOP_RELEASE_FORMS.findIndex((form) => form.id === "next");
  if (index < 0) return null;
  const [removed] = DESKTOP_RELEASE_FORMS.splice(index, 1);
  try {
    return fn();
  } finally {
    DESKTOP_RELEASE_FORMS.splice(index, 0, removed);
  }
}

function caseOf(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

/**
 * 跑入口五的 NEXT 一节：一棵带 asar 的树 + 一棵纯 dir 的树，四项事实逐条落 cases。
 * 报告只读这里的 cases / facts；测试也直接调它（入口五与用例共用一个证明）。
 */
export function proveNextRecognition({ core, root, shellSource = "" } = {}) {
  const record = {
    kind: "desktop-next",
    ok: false,
    error: "",
    fixture: { dirName: NEXT_FIXTURE.dirName, exeName: NEXT_FIXTURE.exeName },
    facts: null,
    dirVariant: null,
    control: null,
    cases: [],
  };
  try {
    if (!root) {
      record.error = "没有可写 fixture 的目录";
      return record;
    }
    const withAsar = prepareNextInstall({ root: path.join(root, "asar"), shellSource, asarVariant: true });
    const plain = prepareNextInstall({ root: path.join(root, "plain"), shellSource, asarVariant: false });
    const facts = factsOf(core, withAsar);
    const dirFacts = factsOf(core, plain);
    record.facts = facts;
    record.dirVariant = {
      surface: dirFacts.surface,
      exe: dirFacts.exe,
      swap_asar: dirFacts.swap_asar,
      shell_main: dirFacts.shell_main,
    };
    record.fixture.exe = withAsar.exe;
    record.fixture.shell = withAsar.shell;
    record.fixture.asar = withAsar.asar;
    const shown = (fp) => (fp ? path.relative(withAsar.root, fp).replace(/\\/g, "/") : "未定位");
    record.cases.push(caseOf("form", facts.form === "next", "形态=" + (facts.form || "未认出")));
    record.cases.push(caseOf("exe", facts.exe === withAsar.exe, "exe=" + shown(facts.exe)));
    record.cases.push(caseOf(
      "asar-not-swapped",
      fs.existsSync(withAsar.asar) && facts.swap_asar === false,
      "带 asar 变体（" + shown(withAsar.asar) + "） · 换包=" + String(facts.swap_asar) + " · " + facts.swap_reason,
    ));
    record.cases.push(caseOf("shell", facts.shell_main === withAsar.shell, "壳入口=" + shown(facts.shell_main) + " · " + facts.shell_reason));
    record.cases.push(caseOf(
      "dir-variant-shell",
      dirFacts.shell_main === plain.shell && dirFacts.swap_asar === false,
      "纯 dir 形态 · 壳入口=" + shown(dirFacts.shell_main) + " · 换包=" + String(dirFacts.swap_asar),
    ));
    record.cases.push(caseOf(
      "pids-image",
      (facts.process_images || []).includes(NEXT_FIXTURE.exeName),
      "进程名=" + (facts.process_images || []).join(","),
    ));
    // 故障对照（CODING_STANDARDS #6）：把名单里的 next 临时摘掉，四项必须退回修前，finally 插回。
    const controlFacts = withoutNextForm(() => factsOf(core, withAsar));
    const controlRed = Boolean(controlFacts)
      && controlFacts.form === ""
      && controlFacts.exe === ""
      && controlFacts.swap_asar === true
      && controlFacts.shell_main === ""
      && !(controlFacts.process_images || []).includes(NEXT_FIXTURE.exeName);
    record.control = controlFacts
      ? {
        form: controlFacts.form,
        exe: controlFacts.exe,
        swap_asar: controlFacts.swap_asar,
        shell_main: controlFacts.shell_main,
        pids_has_next: (controlFacts.process_images || []).includes(NEXT_FIXTURE.exeName),
      }
      : null;
    record.cases.push(caseOf(
      "control-red",
      controlRed,
      "拔掉名单后：形态=" + (controlFacts ? controlFacts.form || "未认出" : "未跑") + " · exe=" + shown(controlFacts && controlFacts.exe)
        + " · 换包=" + String(Boolean(controlFacts && controlFacts.swap_asar))
        + " · 壳入口=" + shown(controlFacts && controlFacts.shell_main)
        + " · 进程名含 NEXT=" + String(Boolean(record.control && record.control.pids_has_next)),
    ));
    record.ok = record.cases.every((item) => item.ok);
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
}
