import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pruneWorkspaces } from "../../lib/verify/retention.js";
import { buildReport, renderReportMarkdown } from "../../lib/verify/report.js";
import { tempDir } from "./helpers.js";

/**
 * 工作区保留策略的接缝：pruneWorkspaces(root, keep, protect, minAgeMs) 的返回值与磁盘结果。
 * 「工作区」= 验证根下的直接子目录，名字是 <YYYYMMDD-HHMMSS> 或 probe-<同样的戳>；
 * 其它名字（_fixture-cache、acceptance-commit、it-*）与普通文件一律不碰。
 */

const TWO_HOURS = 2 * 60 * 60 * 1000;

/** 造一个「旧」工作区：目录里有内容，mtime 回拨到很久以前。 */
function makeWorkspace(root, name, { ageMs = TWO_HOURS } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, "out", "report.json"), "{}\n");
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(path.join(dir, "out", "report.json"), when, when);
  fs.utimesSync(path.join(dir, "out"), when, when);
  fs.utimesSync(dir, when, when);
  return dir;
}

function sandbox(label) {
  const base = tempDir(label + "-");
  const root = path.join(base, "verify-root");
  fs.mkdirSync(root, { recursive: true });
  return { base, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const names = (dir) => fs.readdirSync(dir).sort();

test("只清自己的时间戳目录：保留最近 keep 个，其它名字一律不碰", () => {
  const box = sandbox("retention-window");
  try {
    const stamps = ["20260101-000000", "20260102-000000", "20260103-000000", "20260104-000000", "20260105-000000"];
    for (const stamp of stamps) makeWorkspace(box.root, stamp);
    makeWorkspace(box.root, "probe-20260103-120000");
    // 白名单外的东西：缓存、验收记录、测试式命名、普通文件。
    fs.mkdirSync(path.join(box.root, "_fixture-cache", "asar-1-2"), { recursive: true });
    fs.mkdirSync(path.join(box.root, "acceptance-commit"), { recursive: true });
    fs.mkdirSync(path.join(box.root, "it-1234-5678"), { recursive: true });
    fs.writeFileSync(path.join(box.root, "notes.txt"), "keep me\n");

    const result = pruneWorkspaces({ root: box.root, keep: 3, protect: [] });
    assert.equal(result.root, box.root);
    assert.equal(result.keep, 3);
    // 6 个时间戳目录（5 个 verify + 1 个 probe）按戳排序，留最新 3 个（新的在前）。
    assert.deepEqual(result.kept, ["20260105-000000", "20260104-000000", "probe-20260103-120000"]);
    assert.deepEqual(result.removed.sort(), ["20260101-000000", "20260102-000000", "20260103-000000"]);
    assert.ok(result.freedBytes > 0);
    assert.deepEqual(names(box.root), [
      "_fixture-cache",
      "acceptance-commit",
      "it-1234-5678",
      "notes.txt",
      "probe-20260103-120000",
      "20260104-000000",
      "20260105-000000",
    ].sort());
  } finally {
    box.cleanup();
  }
});

test("本轮工作区永不删：即使它落在保留窗口外", () => {
  const box = sandbox("retention-current");
  try {
    for (const stamp of ["20260101-000000", "20260102-000000", "20260103-000000"]) makeWorkspace(box.root, stamp);
    const result = pruneWorkspaces({ root: box.root, keep: 1, protect: [path.join(box.root, "20260101-000000")] });
    assert.ok(result.removed.includes("20260102-000000"));
    assert.ok(!result.removed.includes("20260101-000000"), "当前工作区不能被清");
    assert.ok(fs.existsSync(path.join(box.root, "20260101-000000")));
    assert.ok(result.skipped.some((item) => item.name === "20260101-000000" && /当前工作区/.test(item.reason)));
  } finally {
    box.cleanup();
  }
});

test("最近还在写的目录不删：并发/在跑的兄弟进程", () => {
  const box = sandbox("retention-inflight");
  try {
    makeWorkspace(box.root, "20260101-000000");
    makeWorkspace(box.root, "20260102-000000");
    makeWorkspace(box.root, "20260103-000000", { ageMs: 0 });
    const result = pruneWorkspaces({ root: box.root, keep: 1, protect: [] });
    // 在跑的目录既不删、也不占保留名额：可删的两个里留最新的那个。
    assert.deepEqual(result.removed, ["20260101-000000"]);
    assert.ok(fs.existsSync(path.join(box.root, "20260102-000000")));
    assert.ok(fs.existsSync(path.join(box.root, "20260103-000000")), "刚写过的目录要留着");
    assert.ok(result.skipped.some((item) => item.name === "20260103-000000" && /写入/.test(item.reason)));
  } finally {
    box.cleanup();
  }
});

test("keep=0 只留本轮；--no-prune 等价于不调用", () => {
  const box = sandbox("retention-zero");
  try {
    for (const stamp of ["20260101-000000", "20260102-000000"]) makeWorkspace(box.root, stamp);
    makeWorkspace(box.root, "20260103-000000", { ageMs: 0 });
    const result = pruneWorkspaces({ root: box.root, keep: 0, protect: [path.join(box.root, "20260103-000000")] });
    assert.deepEqual(result.removed.sort(), ["20260101-000000", "20260102-000000"]);
    assert.deepEqual(names(box.root), ["20260103-000000"]);
  } finally {
    box.cleanup();
  }
});

test("报告写下工作区清理的结构性事实", () => {
  const workspace = { root: "D:/x/20260105-000000", home: "D:/x/20260105-000000/home", install: "D:/x/20260105-000000/desktop", out: "D:/x/20260105-000000/out" };
  const report = buildReport({
    workspace,
    retention: {
      root: "D:/x",
      keep: 5,
      kept: ["20260105-000000"],
      removed: ["20260101-000000", "20260102-000000"],
      freedBytes: 12 * 1048576,
      skipped: [{ name: "20260106-000000", reason: "最近仍在写入" }],
    },
  });
  assert.equal(report.retention.keep, 5);
  assert.deepEqual(report.retention.removed, ["20260101-000000", "20260102-000000"]);
  assert.equal(report.retention.skippedCount, 1);
  // 跳过原因按类计数，不在 markdown 里只挑几个名字念。
  assert.deepEqual(report.retention.skippedReasons, [{ reason: "最近仍在写入", count: 1 }]);
  assert.match(
    renderReportMarkdown(report),
    /工作区清理：保留最近 5 个旧工作区（本轮另算） · 删除 2 个 · 释放 12 MB · 跳过 1 个（最近仍在写入 ×1）/,
  );
});

test("--no-prune 时报告写「已关闭」，不是整段消失", () => {
  const workspace = { root: "D:/x/20260105-000000", home: "D:/x/20260105-000000/home", install: "D:/x/20260105-000000/desktop", out: "D:/x/20260105-000000/out" };
  const report = buildReport({
    workspace,
    retention: { enabled: false, root: "D:/x", keep: 5, kept: [], removed: [], freedBytes: 0, skipped: [] },
  });
  assert.equal(report.retention.enabled, false);
  assert.match(renderReportMarkdown(report), /工作区清理：已关闭（--no-prune）/);
});

test("深处还在写也算在跑：只看顶层 mtime 会误删跑久的兄弟进程", () => {
  const box = sandbox("retention-deep-write");
  try {
    const dir = makeWorkspace(box.root, "20260101-000000");
    // 顶层与浅层都回拨成旧时间，只有深处文件是「刚写的」。
    const deep = path.join(dir, "desktop", "resources", "app", "dsh", "index.js");
    fs.mkdirSync(path.dirname(deep), { recursive: true });
    fs.writeFileSync(deep, "export {}\n");
    const old = new Date(Date.now() - TWO_HOURS);
    for (const shallow of [dir, path.join(dir, "out"), path.join(dir, "desktop"), path.join(dir, "desktop", "resources")]) {
      if (fs.existsSync(shallow)) fs.utimesSync(shallow, old, old);
    }
    const result = pruneWorkspaces({ root: box.root, keep: 0, protect: [] });
    assert.deepEqual(result.removed, [], "深处还在写就不能删");
    assert.ok(fs.existsSync(dir));
    assert.ok(result.skipped.some((item) => item.name === "20260101-000000" && /写入/.test(item.reason)));
  } finally {
    box.cleanup();
  }
});

test("不越界：根目录之外的目录一个都不动", () => {
  const box = sandbox("retention-scope");
  try {
    const outside = path.join(box.base, "outside", "20260101-000000");
    fs.mkdirSync(outside, { recursive: true });
    makeWorkspace(box.root, "20260101-000000");
    makeWorkspace(box.root, "20260102-000000");
    const result = pruneWorkspaces({ root: box.root, keep: 0, protect: [] });
    assert.deepEqual(result.removed.sort(), ["20260101-000000", "20260102-000000"]);
    assert.ok(fs.existsSync(outside), "根目录之外的同名目录不能被删");
  } finally {
    box.cleanup();
  }
});
