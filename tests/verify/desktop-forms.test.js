import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "../../lib/core.js";
import * as desktop from "../../lib/desktop.js";
import * as surface from "../../lib/surface.js";
import {
  DESKTOP_RELEASE_FORMS,
  desktopPortableNames,
  desktopProcessImages,
} from "../../lib/desktop-forms.js";
import { proveNextRecognition } from "../../lib/verify/desktop-next.js";
import { tempDir, withIsolatedHome } from "./helpers.js";

/**
 * A4 / #24：DSH NEXT 识别。
 *
 * 三件事必须各自独立：①这是桌面发行形态 ②它的 asar 该不该解开 ③壳入口文件在哪。
 * 名单只有一份（lib/desktop-forms.js），拔掉其中 NEXT 那一项，四个事实必须一起退回修前。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function writeFile(fp, text) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, text, "utf8");
}

/** 一棵安装树：exe + resources/app/lib/main.js（+ 可选的 app.asar 变体）。 */
function installTree(root, { dirName, exeName, withAsar = false }) {
  const install = path.join(root, dirName);
  writeFile(path.join(install, exeName), "fixture\n");
  if (withAsar) writeFile(path.join(install, "resources", "app.asar"), "fixture-asar\n");
  writeFile(path.join(install, "resources", "app", "lib", "main.js"), "// fixture shell\n");
  const env = {
    ...process.env,
    DSH_HOME: path.join(root, "home"),
    DSH_BASE: path.join(root, "base"),
    DSH_DESKTOP_INSTALL: install,
    LOCALAPPDATA: path.join(root, "localappdata"),
    APPDATA: path.join(root, "appdata"),
    USERPROFILE: path.join(root, "home"),
    PATH: path.join(root, "emptybin"),
  };
  return {
    install,
    exe: path.join(install, exeName),
    resources: path.join(install, "resources"),
    shell: path.join(install, "resources", "app", "lib", "main.js"),
    env,
  };
}

/** 三个事实全部由生产函数给出：形态/换包/壳入口，不在这里拼判定。 */
function factsFor(tree) {
  return core.desktopRecognition({
    execPath: tree.exe,
    resourcesPath: tree.resources,
    argv: [],
    env: tree.env,
  });
}

/** 临时把名单里某一项摘掉，跑完必定插回；返回 fn 的结果。 */
function withoutForm(id, fn) {
  const index = DESKTOP_RELEASE_FORMS.findIndex((form) => form.id === id);
  assert.ok(index >= 0, "名单里必须有 " + id + " 这一项");
  const [removed] = DESKTOP_RELEASE_FORMS.splice(index, 1);
  try {
    return fn();
  } finally {
    DESKTOP_RELEASE_FORMS.splice(index, 0, removed);
  }
}

test("三事实矩阵：官方 Harness / DSH Desktop / NEXT 的取值由生产函数给出", async () => {
  await withIsolatedHome(async () => {
    const root = tempDir("desktop-forms-matrix-");
    try {
      const harness = installTree(root, { dirName: "DeepSeek Harness", exeName: "DeepSeek Harness.exe", withAsar: true });
      const desktopTree = installTree(root, { dirName: "DSH Desktop", exeName: "DSH Desktop.exe" });
      const next = installTree(root, { dirName: "DSH NEXT", exeName: "DSH NEXT.exe", withAsar: true });
      const rows = [harness, desktopTree, next].map((tree) => {
        const facts = factsFor(tree);
        return {
          form: facts.form,
          surface: facts.surface,
          exe: facts.exe === tree.exe,
          swap_asar: facts.swap_asar,
          shell_main: facts.shell_main === tree.shell,
        };
      });
      assert.deepEqual(rows, [
        { form: "harness", surface: "desktop", exe: true, swap_asar: true, shell_main: true },
        { form: "desktop", surface: "desktop", exe: true, swap_asar: false, shell_main: false },
        { form: "next", surface: "desktop", exe: true, swap_asar: false, shell_main: true },
      ]);
      // 状态栏读同一份事实（purge_status 四行：形态 / exe / 是否换包 / 壳入口 + 依据）。
      const lines = core.desktopRecognitionLines(factsFor(next));
      assert.deepEqual(lines.map((item) => item.label), ["发行形态 / form", "桌面 exe / exe", "asar / 换包", "壳入口 / shell"]);
      assert.match(lines[0].value, /DSH NEXT/);
      assert.equal(lines[1].ok, true);
      assert.match(lines[2].value, /不解包/);
      assert.equal(lines[3].ok, true);
      assert.deepEqual(core.desktopRecognitionLines({ surface: "web" }), [], "web 面不显示桌面四行");

      // 三个事实各自的单点判定：①形态 ②解包 ③壳入口布局，互不代替。
      const trees = [harness, desktopTree, next];
      assert.deepEqual(trees.map((tree) => desktop.isDesktopExecutable(tree.exe)), [true, true, true], "① 三种形态都认得出");
      assert.deepEqual(trees.map((tree) => desktop.formUnpacksAsar(tree.exe)), [true, false, false], "② 只有官方 Harness 解包");
      assert.deepEqual(trees.map((tree) => desktop.formHasShellEntry(tree.exe)), [true, false, true], "③ NEXT 的壳入口照样在 resources/app");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("既有两种形态不回退：官方仍换包且壳入口照旧，DSH Desktop 带 asar 也不换包", async () => {
  await withIsolatedHome(async () => {
    const root = tempDir("desktop-forms-legacy-");
    try {
      const harness = installTree(root, { dirName: "DeepSeek Harness", exeName: "DeepSeek Harness.exe", withAsar: true });
      const desktopWithAsar = installTree(root, { dirName: "DSH Desktop", exeName: "DSH Desktop.exe", withAsar: true });
      const harnessFacts = factsFor(harness);
      assert.equal(harnessFacts.swap_asar, true, "官方 Harness 的 asar 仍会被换");
      assert.equal(harnessFacts.shell_main, harness.shell, "官方 Harness 的壳入口定位与改动前一致");
      const desktopFacts = factsFor(desktopWithAsar);
      assert.equal(desktopFacts.swap_asar, false, "DSH Desktop 仍不会被换包（即使它身边带一份 asar）");
      assert.equal(desktopFacts.shell_main, "", "DSH Desktop 的壳入口定位与改动前一致（不定位）");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("故障对照：从发行形态名单里删掉 NEXT，四项事实必须重新变红", async () => {
  await withIsolatedHome(async () => {
    const root = tempDir("desktop-forms-red-");
    try {
      const next = installTree(root, { dirName: "DSH NEXT", exeName: "DSH NEXT.exe", withAsar: true });
      const green = factsFor(next);
      assert.equal(green.form, "next");
      assert.equal(green.exe, next.exe);
      assert.equal(green.swap_asar, false, "修后：带 asar 变体也不换包");
      assert.equal(green.shell_main, next.shell, "修后：壳入口照常定位");
      assert.ok(green.process_images.includes("DSH NEXT.exe"), "修后：进程名集合含 NEXT");

      const red = withoutForm("next", () => {
        const facts = factsFor(next);
        // 插回之前先读，免得 finally 把名单补回去后这里读到绿的。
        return facts;
      });
      assert.equal(red.form, "", "拔掉名单：形态必须认不出");
      assert.equal(red.exe, "", "拔掉名单：exe 定位必须退回空");
      assert.equal(red.shell_main, "", "拔掉名单：壳入口必须退回空");
      assert.equal(red.swap_asar, true, "拔掉名单：带 asar 变体必须退回 swapAsar: true（老兜底）");
      assert.equal(red.process_images.includes("DSH NEXT.exe"), false, "拔掉名单：进程名集合看不到 NEXT");

      const restored = factsFor(next);
      assert.equal(restored.form, "next", "名单插回后必须立刻恢复");
      assert.equal(restored.shell_main, next.shell);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("入口五：fixture 的 NEXT 安装树四项全绿，拔掉名单同一段证明全红", async () => {
  await withIsolatedHome(async () => {
    const root = tempDir("desktop-forms-entry-");
    try {
      const green = proveNextRecognition({ core, root });
      assert.deepEqual(green.cases.filter((item) => !item.ok), [], "四项事实加形态必须全绿");
      assert.equal(green.ok, true);
      assert.equal(green.facts.form, "next");
      assert.equal(green.facts.surface, "desktop", "resources 启发式已把桌面判出来（与票面写的 web 不同，见 #24 评论）");
      assert.equal(green.dirVariant.shell_main.endsWith(path.join("resources", "app", "lib", "main.js")), true);

      const red = withoutForm("next", () => proveNextRecognition({ core, root }));
      const failed = red.cases.filter((item) => !item.ok).map((item) => item.id);
      for (const id of ["form", "exe", "asar-not-swapped", "shell", "dir-variant-shell", "pids-image"]) {
        assert.ok(failed.includes(id), "拔掉名单后 " + id + " 必须红");
      }
      assert.equal(red.ok, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test("安装目录与进程名：既有两种形态的行不变，NEXT 由同一份名单加进来", async () => {
  await withIsolatedHome(async () => {
    const env = {
      ...process.env,
      LOCALAPPDATA: "D:\\fixture\\local",
      ProgramFiles: "D:\\fixture\\pf",
      "ProgramFiles(x86)": "D:\\fixture\\pf86",
    };
    const home = process.env.USERPROFILE;
    const dirs = desktop.commonDesktopInstallDirs(env);
    const legacy = [
      path.join("D:\\fixture\\local", "Programs", "DeepSeek Harness"),
      path.join("D:\\fixture\\local", "Programs", "DSH Desktop"),
      path.join("D:\\fixture\\local", "DeepSeek Harness"),
      path.join("D:\\fixture\\pf", "DeepSeek Harness"),
      path.join("D:\\fixture\\pf", "DSH Desktop"),
      path.join("D:\\fixture\\pf86", "DSH Desktop"),
      // uniquePaths 会按平台归一化分隔符，这里同样过一遍 path.normalize。
      path.normalize("/Applications/DeepSeek Harness.app"),
      path.normalize("/Applications/DSH Desktop.app"),
      path.normalize("/opt/DeepSeek Harness"),
      path.normalize("/opt/DSH Desktop"),
      path.normalize("/usr/lib/deepseek-harness"),
      path.normalize("/usr/lib/dsh-desktop"),
      path.normalize("/usr/share/deepseek-harness"),
      path.join(home, ".local", "share", "DeepSeek Harness"),
      path.join(home, "Applications", "DSH Desktop.app"),
    ];
    for (const dir of legacy) assert.ok(dirs.includes(dir), "既有安装位置不能丢：" + dir);
    // 顺序也是契约：多客户端时「先找到哪一个」由这份顺序决定，NEXT 插队不许改动既有相对次序。
    const legacyOnly = dirs.filter((dir) => !dir.includes("NEXT") && !dir.includes("dsh-next"));
    assert.deepEqual(legacyOnly, [
      path.join("D:\\fixture\\local", "Programs", "DeepSeek Harness"),
      path.join("D:\\fixture\\local", "Programs", "DSH Desktop"),
      path.join("D:\\fixture\\local", "DeepSeek Harness"),
      path.join("D:\\fixture\\pf", "DeepSeek Harness"),
      path.join("D:\\fixture\\pf", "DSH Desktop"),
      path.join("D:\\fixture\\pf86", "DeepSeek Harness"),
      path.join("D:\\fixture\\pf86", "DSH Desktop"),
      path.normalize("/Applications/DeepSeek Harness.app"),
      path.normalize("/Applications/DSH Desktop.app"),
      path.join(home, "Applications", "DeepSeek Harness.app"),
      path.join(home, "Applications", "DSH Desktop.app"),
      path.normalize("/opt/DeepSeek Harness"),
      path.normalize("/opt/deepseek-harness"),
      path.normalize("/usr/lib/DeepSeek Harness"),
      path.normalize("/usr/lib/deepseek-harness"),
      path.normalize("/usr/share/deepseek-harness"),
      path.join(home, ".local", "share", "DeepSeek Harness"),
      path.join(home, ".local", "share", "deepseek-harness"),
      path.normalize("/opt/DSH Desktop"),
      path.normalize("/usr/lib/dsh-desktop"),
    ], "既有两种形态的目录顺序必须与改动前一致");
    assert.ok(dirs.includes(path.join("D:\\fixture\\local", "Programs", "DSH NEXT")), "NEXT 的默认安装位置要在名单里");
    // 便携目录名收编进名单时不许丢旧名（#24 review 抓到过一次 "deepseek-harness" 被漏掉）。
    for (const name of ["DeepSeek Harness", "DeepseekHarnessDesktop", "DeepSeekHarnessDesktop", "DSH Desktop", "deepseek-harness"]) {
      assert.ok(desktopPortableNames().includes(name), "便携目录名不能丢：" + name);
    }

    assert.deepEqual(desktopProcessImages(), ["DeepSeek Harness.exe", "DSH Desktop.exe", "DSH NEXT.exe"]);
    withoutForm("next", () => {
      const withoutNext = desktop.commonDesktopInstallDirs(env);
      assert.equal(withoutNext.includes(path.join("D:\\fixture\\local", "Programs", "DSH NEXT")), false, "拔掉名单后 NEXT 的目录必须一起消失");
      assert.deepEqual(desktopProcessImages(), ["DeepSeek Harness.exe", "DSH Desktop.exe"], "拔掉名单后进程名必须一起消失");
    });
  });
});

test("路径启发式：exe 路径认得出，安装目录名本身与祖先同名不算桌面（与改动前一致）", () => {
  const { pathLooksDesktop } = surface;
  assert.equal(pathLooksDesktop("D:/x/DSH NEXT/DSH NEXT.exe"), true);
  assert.equal(pathLooksDesktop("D:/x/DSH Desktop/DSH Desktop.exe"), true);
  assert.equal(pathLooksDesktop("D:/x/DSH NEXT/resources/app/lib/main.js"), true, "resources 形态算安装树");
  assert.equal(pathLooksDesktop("D:/DeepSeek Harness"), false, "安装目录名本身不算（harness 名字到处都是）");
  assert.equal(pathLooksDesktop("D:/x/DSH NEXT"), false, "安装目录名本身不算");
  assert.equal(pathLooksDesktop("D:/DeepSeek Harness/npm-global/bin/node.exe"), false, "祖先目录叫这个名字不算");
  assert.equal(pathLooksDesktop("D:/deepseek-harness/resources/app"), true);
});

test("fixture 与生产名单同名：NEXT 的目录名 / exe 名 / 进程名三处字符串钉在一起", () => {
  const nextForm = DESKTOP_RELEASE_FORMS.find((form) => form.id === "next");
  assert.ok(nextForm, "名单里必须有 next");
  assert.deepEqual([...nextForm.installNames], ["DSH NEXT"], "fixture 的安装目录名");
  assert.ok(nextForm.exeNames.includes("DSH NEXT.exe"), "fixture 的 exe 名");
  assert.equal(nextForm.processImage, "DSH NEXT.exe", "进程名");
  assert.equal(nextForm.unpackAsar, false, "NEXT 不解 asar");
  assert.equal(nextForm.shellInAppDir, true, "NEXT 的壳入口在 resources/app");
});

test("接线：进程名与壳入口都从名单/形态字段来，不各写一套", () => {
  const restartSrc = fs.readFileSync(path.join(repoRoot, "lib", "restart-desktop.js"), "utf8");
  // A7 后 helper 改为按安装路径过滤（不再按镜像名枚举）；进程名名单仍由 core 的安装结束路径使用。
  assert.doesNotMatch(restartSrc, /desktopProcessImages\(\)/, "helper 不再按镜像名枚举进程");
  assert.match(restartSrc, /Get-CimInstance Win32_Process/, "helper 的 win32 进程选择必须按安装路径过滤");
  assert.doesNotMatch(restartSrc, /tasklist/, "helper 不再用 tasklist 按镜像名枚举");

  const coreSrc = fs.readFileSync(path.join(repoRoot, "lib", "core.js"), "utf8");
  assert.match(coreSrc, /desktopProcessImages\(\)/, "core 的安装进程结束必须仍从名单取进程名");
  assert.match(coreSrc, /desktop\.formHasShellEntry\(exe\)/, "壳入口必须看形态字段（而不是「官方」布尔）");
  const shellBody = coreSrc.slice(coreSrc.indexOf("export function desktopShellMain"), coreSrc.indexOf("export function desktopShellMain") + 900);
  assert.doesNotMatch(shellBody, /isOfficialHarnessExecutable/, "壳入口不得再从「官方」布尔早退（NEXT 会被误连成未定位）");
  const handoffBody = coreSrc.slice(coreSrc.indexOf("export function sealedAsarHandoff"), coreSrc.indexOf("export function sealedAsarHandoff") + 1400);
  assert.match(handoffBody, /desktop\.formUnpacksAsar\(/, "换包必须走同一个解包判定");
  const desktopSrc = fs.readFileSync(path.join(repoRoot, "lib", "desktop.js"), "utf8");
  const decision = desktopSrc.slice(desktopSrc.indexOf("export function formUnpacksAsar"), desktopSrc.indexOf("export function formUnpacksAsar") + 500);
  assert.match(decision, /form\.unpackAsar/, "解包判定必须读名单里的字段");
});
