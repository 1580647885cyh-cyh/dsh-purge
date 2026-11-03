import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hostTargets } from "../../lib/host-version.js";

/**
 * 兼容记录不得指向一个「已经不在声明里」的宿主版本（复盘 2026-11-03）。
 *
 * rc5-acceptance.json 曾长期写着 dshTarget: 0.2.0-rc.2（本机实测 0.2.1-rc.5），而验收逻辑只抄不判，
 * 于是记录自己在并排展示矛盾值。这条检查把它变成机械判定：记录的 dshTarget 必须在当前声明集合里。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = path.join(root, "docs", "compatibility");

function newestRecord() {
  if (!fs.existsSync(dir)) return null;
  const rows = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      rows.push({ name, record, at: Date.parse(record.generatedAt || "") || 0 });
    } catch {
      rows.push({ name, record: null, at: 0 });
    }
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.find((row) => row.record) || null;
}

test("兼容记录：最新一份声明的宿主版本必须仍在 package.json 的声明集合里", () => {
  const newest = newestRecord();
  if (!newest) return; // 还没生成过记录时不算失败
  const declared = hostTargets(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")));
  assert.ok(declared.length > 0, "package.json 必须声明 dshTarget / dshTargets");

  const record = newest.record;
  const recorded = record.plugin && record.plugin.dshTarget;
  assert.ok(recorded, newest.name + " 必须记下 plugin.dshTarget");
  assert.ok(
    declared.includes(recorded),
    newest.name + " 的 dshTarget=" + recorded + " 不在当前声明（" + declared.join(" / ") + "）里："
      + "要么把该版本加回 dshTargets，要么重新生成记录",
  );

  const adaptation = record.host && record.host.adaptation;
  assert.ok(adaptation, newest.name + " 必须带 host.adaptation");
  assert.equal(adaptation.version, record.host.shellVersion, "适配判定必须针对实测宿主版本");
  assert.equal(
    adaptation.targets.includes(adaptation.version),
    adaptation.state === "adapted",
    "adapted 与 targets 必须自洽：已适配 ⟺ 版本在声明集合里",
  );
});
