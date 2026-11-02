import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { resolveHostModule } from "../../lib/host-deps.js";
import { assertDriveDPath } from "../../lib/verify/isolate.js";

/**
 * 宿主依赖解析：只在能核对身份的宿主包根上解析 @deepseek-ai/dsh-tools。
 *
 * 覆盖当前桌面布局（resources/app/dsh/node_modules）、基线支持的 Web/npm 布局，
 * 以及“有同名包但没有宿主身份”的诱饵目录。
 */

const TEST_ROOT = assertDriveDPath("D:\\dsh\\tmp\\dsh-purge-test", "测试根目录");
const SPEC = "@deepseek-ai/dsh-tools";

function tempDir(label) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_ROOT, label));
}

function writePackage(dir, name) {
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, version: "0.2.1-rc.5", main: "./lib/index.js" }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "lib", "index.js"), "module.exports = { hostPackage: true };\n", "utf8");
}

function makeHostTree(aiBase) {
  writePackage(path.join(aiBase, "dsh-agent-instructions"), "@deepseek-ai/dsh-agent-instructions");
  writePackage(path.join(aiBase, "dsh-system-prompt"), "@deepseek-ai/dsh-system-prompt");
  writePackage(path.join(aiBase, "dsh-tools"), SPEC);
}

function anchors(overrides = {}) {
  const env = overrides.env || {};
  return {
    env,
    homes: env.DSH_HOME ? [env.DSH_HOME] : [],
    execPath: "",
    resourcesPath: "",
    argv1: "",
    cwd: "",
    ...overrides,
  };
}

test("当前桌面布局：从隔离安装的 resources/app/dsh/node_modules 解析宿主依赖", () => {
  const install = tempDir("deps-desktop-");
  const appDsh = path.join(install, "resources", "app", "dsh");
  const aiBase = path.join(appDsh, "node_modules", "@deepseek-ai");
  try {
    makeHostTree(aiBase);
    fs.writeFileSync(
      path.join(appDsh, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-desktop-runtime", version: "0.2.1-rc.5" }),
      "utf8",
    );
    const result = resolveHostModule(SPEC, anchors({ env: { DSH_DESKTOP_INSTALL: install } }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.via, "desktop-install:app-dsh");
    assert.equal(result.hostRoot.toLowerCase(), aiBase.toLowerCase());
    assert.equal(result.entry.toLowerCase().endsWith(path.join("dsh-tools", "lib", "index.js").toLowerCase()), true);
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});

test("基线支持的 Web/npm 布局：从 DSH_HOME 的 node_modules 解析", () => {
  const home = tempDir("deps-web-");
  const aiBase = path.join(home, "node_modules", "@deepseek-ai");
  try {
    makeHostTree(aiBase);
    const result = resolveHostModule(SPEC, anchors({ env: { DSH_HOME: home } }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.via, "dsh-home");
    assert.equal(result.hostRoot.toLowerCase(), aiBase.toLowerCase());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("生产桌面锚点：process.resourcesPath 与 execPath 也能解析同一布局", () => {
  const install = tempDir("deps-anchors-");
  const appDsh = path.join(install, "resources", "app", "dsh");
  const aiBase = path.join(appDsh, "node_modules", "@deepseek-ai");
  try {
    makeHostTree(aiBase);
    fs.writeFileSync(path.join(appDsh, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop-runtime" }), "utf8");
    const viaResources = resolveHostModule(SPEC, anchors({ resourcesPath: path.join(install, "resources") }));
    assert.equal(viaResources.ok, true, viaResources.error);
    assert.equal(viaResources.via, "resources-path:app-dsh");
    const viaExec = resolveHostModule(SPEC, anchors({ execPath: path.join(install, "DeepSeek Harness.exe") }));
    assert.equal(viaExec.ok, true, viaExec.error);
    assert.equal(viaExec.via, "exec-path:app-dsh");
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});

test("home 锚点：没有 DSH_HOME 时按 ~/.dsh 同构目录解析", () => {
  const home = tempDir("deps-home-");
  const aiBase = path.join(home, "node_modules", "@deepseek-ai");
  try {
    makeHostTree(aiBase);
    const result = resolveHostModule(SPEC, anchors({ homes: [home] }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.via, "dsh-home");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("npm 嵌套布局：@deepseek-ai/dsh 自带 node_modules 时也能解析", () => {
  const home = tempDir("deps-nested-");
  const scoped = path.join(home, "profiles", "web", "node_modules", "@deepseek-ai");
  const nested = path.join(scoped, "dsh", "node_modules", "@deepseek-ai");
  try {
    writePackage(path.join(scoped, "dsh-agent-instructions"), "@deepseek-ai/dsh-agent-instructions");
    fs.mkdirSync(path.join(scoped, "dsh"), { recursive: true });
    fs.writeFileSync(path.join(scoped, "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh" }), "utf8");
    writePackage(path.join(nested, "dsh-tools"), SPEC);
    const result = resolveHostModule(SPEC, anchors({ env: { DSH_HOME: home } }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.via, "profile:web:nested");
    assert.ok(result.entry.toLowerCase().includes(path.join("dsh", "node_modules").toLowerCase()), result.entry);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("argv 锚点：npm 全局 bin 布局（无固定机器路径）也能解析", () => {
  const root = tempDir("deps-argv-");
  const aiBase = path.join(root, "node_modules", "@deepseek-ai");
  try {
    makeHostTree(aiBase);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dsh-cli-root" }), "utf8");
    const result = resolveHostModule(SPEC, anchors({ argv1: path.join(aiBase, "dsh", "bin", "dsh.js") }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.via, "argv");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("宿主包根核对：只有同名包、没有宿主包树的目录不能命中", () => {
  const decoy = tempDir("deps-decoy-");
  try {
    writePackage(path.join(decoy, "node_modules", "@deepseek-ai", "dsh-tools"), SPEC);
    const result = resolveHostModule(SPEC, anchors({ env: { DSH_HOME: decoy }, cwd: decoy }));
    assert.equal(result.ok, false);
    assert.match(result.error, /@deepseek-ai\/dsh-tools/);
    assert.ok(result.tried.length > 0, "应记录尝试过的候选");
    assert.equal(result.tried.every((item) => item.status !== "resolved"), true);
    assert.ok(result.tried.some((item) => item.status === "not-a-host"));
  } finally {
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});

test("宿主存在但缺目标包时明确报未解析，不借用其它目录命中", () => {
  const install = tempDir("deps-missing-");
  const aiBase = path.join(install, "resources", "app", "dsh", "node_modules", "@deepseek-ai");
  try {
    writePackage(path.join(aiBase, "dsh-agent-instructions"), "@deepseek-ai/dsh-agent-instructions");
    const result = resolveHostModule(SPEC, anchors({ env: { DSH_DESKTOP_INSTALL: install } }));
    assert.equal(result.ok, false);
    assert.match(result.error, /@deepseek-ai\/dsh-tools/);
    assert.ok(result.tried.some((item) => item.status === "package-missing"));
  } finally {
    fs.rmSync(install, { recursive: true, force: true });
  }
});
