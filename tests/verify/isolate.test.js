import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  applyProcessEnvironment,
  assertDriveDPath,
  assertHostsIsolated,
  diffSnapshots,
  ensureWorkspace,
  isDriveDPath,
  isolatedEnvironment,
  planWorkspace,
  snapshotTree,
} from "../../lib/verify/isolate.js";

const TEST_ROOT = "D:\\dsh\\tmp\\dsh-purge-test";

function tempDir(name) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dir = path.join(TEST_ROOT, name + "-" + process.pid + "-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("isDriveDPath / assertDriveDPath 只接受 D 盘", () => {
  assert.equal(isDriveDPath("D:\\dsh\\tmp"), true);
  assert.equal(isDriveDPath("d:/dsh/tmp"), true);
  assert.equal(isDriveDPath("C:\\Users\\me"), false);
  assert.equal(isDriveDPath(""), false);
  assert.throws(() => assertDriveDPath("C:\\Users\\me", "测试目录"), /D 盘/);
  assert.equal(assertDriveDPath("D:\\dsh\\tmp", "测试目录"), path.resolve("D:\\dsh\\tmp"));
});

test("planWorkspace 产出的每个目录都在 D 盘且含 stamp", () => {
  const workspace = planWorkspace({ root: TEST_ROOT, stamp: "unit-stamp" });
  assert.ok(workspace.root.endsWith("unit-stamp"));
  for (const [key, value] of Object.entries(workspace)) {
    if (key === "stamp") continue;
    assert.equal(isDriveDPath(value), true, key + " 必须在 D 盘");
  }
});

test("ensureWorkspace 创建工作目录，isolatedEnvironment 指向隔离目录", () => {
  const workspace = ensureWorkspace(planWorkspace({ root: TEST_ROOT, stamp: "unit-env" }));
  const env = isolatedEnvironment(workspace, { base: { ...process.env, DSH_PERMISSION_MODE: "danger-full-access" } });
  assert.equal(env.DSH_HOME, workspace.home);
  assert.equal(env.LOCALAPPDATA, workspace.localAppData);
  assert.equal(env.APPDATA, workspace.appData);
  assert.equal(env.TEMP, workspace.tmp);
  assert.equal(env.PATH, workspace.emptyBin);
  assert.equal(env.DSH_SURFACE, "desktop");
  assert.equal(env.DSH_DESKTOP_INSTALL, workspace.install);
  assert.equal("DSH_PERMISSION_MODE" in env, false);
  for (const value of [env.DSH_HOME, env.LOCALAPPDATA, env.TEMP, env.PATH]) {
    assert.equal(isDriveDPath(value), true);
  }
});

test("applyProcessEnvironment 应用并恢复进程环境", () => {
  const saved = process.env.DSH_HOME;
  const restore = applyProcessEnvironment({
    ...process.env,
    DSH_HOME: "D:\\dsh\\tmp\\isolated-home",
    DSH_SURFACE: "desktop",
    PATH: "D:\\dsh\\tmp\\emptybin",
    LOCALAPPDATA: "D:\\dsh\\tmp\\localappdata",
    APPDATA: "D:\\dsh\\tmp\\appdata",
    TEMP: "D:\\dsh\\tmp\\temp",
    TMP: "D:\\dsh\\tmp\\temp",
    DSH_DESKTOP_INSTALL: "D:\\dsh\\tmp\\desktop",
    DSH_BASE: "D:\\dsh\\tmp\\base",
  });
  try {
    assert.equal(process.env.DSH_HOME, "D:\\dsh\\tmp\\isolated-home");
    assert.equal(process.env.PATH, "D:\\dsh\\tmp\\emptybin");
  } finally {
    restore();
  }
  assert.equal(process.env.DSH_HOME, saved);
});

test("snapshotTree / diffSnapshots 报告新增、修改、删除", () => {
  const dir = tempDir("snapshot");
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "lib", "index.js"), "one");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  const before = snapshotTree(dir);
  fs.writeFileSync(path.join(dir, "lib", "index.js"), "two");
  fs.writeFileSync(path.join(dir, "lib", "extra.js"), "new");
  fs.rmSync(path.join(dir, "package.json"));
  const after = snapshotTree(dir);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.changed, ["lib/index.js"]);
  assert.deepEqual(diff.added, ["lib/extra.js"]);
  assert.deepEqual(diff.removed, ["package.json"]);
});

test("assertHostsIsolated 只接受工作区内宿主", () => {
  const workspace = planWorkspace({ root: TEST_ROOT, stamp: "unit-hosts" });
  assert.deepEqual(assertHostsIsolated([workspace.hostBase], workspace), [workspace.hostBase]);
  assert.throws(() => assertHostsIsolated(["C:\\Program Files\\DeepSeek Harness"], workspace), /超出隔离工作区/);
  assert.throws(() => assertHostsIsolated([], workspace), /没有枚举到任何宿主/);
});
