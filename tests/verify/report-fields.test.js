import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pickReportField, readReportFields, resolveReportFile } from "../../lib/verify/report-fields.js";
import { tempDir } from "./helpers.js";

/**
 * 读报告字段的入口（#25 retro）。
 *
 * 断言的是「选哪份报告」和「点名字段」两件事：latest 按目录 mtime、不看名字；
 * 取不到的字段要出现在 missing 里，不能静默变成 undefined。
 */

function seed(root, stamp, report, mtimeMs) {
  const dir = path.join(root, stamp);
  fs.mkdirSync(path.join(dir, "out"), { recursive: true });
  const file = path.join(dir, "out", "report.json");
  fs.writeFileSync(file, JSON.stringify(report), "utf8");
  if (mtimeMs) fs.utimesSync(dir, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test("latest 按目录 mtime 取，不按名字排序（旧工作区名字可能更靠后）", () => {
  const root = tempDir("report-fields-");
  try {
    seed(root, "20261103-120000", { ok: true, tag: "old" }, 1_000_000);
    seed(root, "smoke2", { ok: false, tag: "named" }, 3_000_000);
    seed(root, "20261103-130000", { ok: true, tag: "new" }, 2_000_000);
    const file = resolveReportFile("latest", { root });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).tag, "new", "取 mtime 最新的一轮，而不是名字最大的");
    // 非时间戳目录不参与候选
    assert.equal(resolveReportFile("20261103-120000", { root }), path.join(root, "20261103-120000", "out", "report.json"));
    assert.throws(() => resolveReportFile("20990101-000000", { root }), /report\.json 不存在/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("点名字段支持数组下标；取不到进 missing，不静默变成空值", () => {
  const root = tempDir("report-fields-pick-");
  try {
    const report = { ok: true, targets: { runtime: { exitTrace: { cases: [{ id: "close-code0", ok: true }] } } } };
    const file = seed(root, "20261103-140000", report);
    const got = readReportFields(file, ["targets.runtime.exitTrace.cases.0.id", "nope.nothing"]);
    assert.equal(got.fields["targets.runtime.exitTrace.cases.0.id"], "close-code0");
    assert.deepEqual(got.missing, ["nope.nothing"]);
    assert.equal(pickReportField(report, "targets.runtime"), report.targets.runtime);
    assert.equal(pickReportField(report, "targets.runtime.exitTrace.cases.9"), undefined);
    assert.equal(pickReportField(report, "targets.runtime.exitTrace.cases.x"), undefined);
    const keys = readReportFields(file, []);
    assert.deepEqual(keys.keys, ["ok", "targets"], "不传字段时给顶层键，用来发现字段名");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
