import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildReport, knownFailures, renderReportMarkdown, writeReport } from "../../lib/verify/report.js";

const TEST_ROOT = "D:\\dsh\\tmp\\dsh-purge-test";

function workspace(name) {
  const root = path.join(TEST_ROOT, name + "-" + process.pid + "-" + Date.now());
  const out = path.join(root, "out");
  fs.mkdirSync(out, { recursive: true });
  return { root, home: path.join(root, "home"), install: path.join(root, "desktop"), out };
}

test("knownFailures 汇总宿主、预设与管理入口的已知故障", () => {
  const failures = knownFailures({
    hostEntry: {
      cwdTemplate: { ok: false, error: "unknown prompt variable" },
      toolErrors: [{ name: "purge_apply", error: "missing additionalProperties" }],
    },
    presetAudit: { files: [{ id: "redteam", file: "redteam/agent.cordis.yml", deprecated: [{ key: "toolFilter", line: 317 }] }] },
    admin: { knownFailures: [{ id: "hostfs-fd-methods", summary: "fd" }] },
  });
  const ids = failures.map((failure) => failure.id);
  assert.deepEqual(ids, ["cwd-template-variable", "tool-schema-purge_apply", "preset-deprecated-redteam", "hostfs-fd-methods"]);
  assert.equal(failures[2].summary.includes("toolFilter@317"), true);
});

test("buildReport 要求基线自检、宿主入口与管理入口同时通过", () => {
  const ws = workspace("report");
  const base = {
    workspace: ws,
    baselineFile: "D:\\dsh\\data\\dsh-purge\\baseline\\baseline-x.json",
    seal: { baseline: { sourceRoot: "D:\\repo", source: { treeHash: "abc", fileCount: 2 }, plugin: { version: "1.1.71" }, host: { shellVersion: "0.2.1-rc.5" }, environment: {}, git: {} } },
    sealCheck: { ok: true },
    drift: null,
    hostInfo: { shellVersion: "0.2.1-rc.5" },
    pluginInfo: { version: "1.1.71" },
    hostEntry: { ok: true, prompt: { length: 10, sha256: "deadbeef" }, sections: [], variables: ["provider", "model"], tools: [], toolErrors: [], cwdTemplate: { ok: true } },
    presetAudit: { files: [] },
    admin: { ok: true, hosts: [path.join(ws.root, "x")], steps: [], diffs: {}, knownFailures: [], liveHost: { ok: true, checked: 55 } },
    commands: ["node scripts/verify.mjs"],
  };
  const report = buildReport(base);
  assert.equal(report.ok, true);
  assert.equal(report.baseline.sealCheck.ok, true);
  const failed = buildReport({ ...base, hostEntry: { ok: false, tools: [], toolErrors: [], sections: [], variables: [] } });
  assert.equal(failed.ok, false);
  const driftFailed = buildReport({ ...base, sealCheck: { ok: false } });
  assert.equal(driftFailed.ok, false);
});

test("renderReportMarkdown 输出边界、入口与已知故障，不包含提示词正文", () => {
  const ws = workspace("report-md");
  const report = buildReport({
    workspace: ws,
    baselineFile: "D:\\baseline.json",
    seal: { baseline: { sourceRoot: "D:\\repo", source: { treeHash: "abcdef", fileCount: 3 }, plugin: { version: "1.1.71", localVersionLock: { remoteUpdates: false } }, host: { shellVersion: "0.2.1-rc.5", runtimeVersion: "0.2.1-rc.5" }, environment: {}, git: {} } },
    sealCheck: { ok: true },
    hostEntry: { ok: true, prompt: { length: 22041, sha256: "9f3b94350f541d47aaaa" }, sections: [{ name: "dsh-purge", length: 10 }], variables: ["provider", "model"], tools: [{ name: "purge_apply" }], toolErrors: [], cwdTemplate: { ok: false, error: "unknown prompt variable" } },
    admin: { ok: true, hosts: [path.join(ws.root, "host")], steps: [{ name: "apply", ok: true, text: "applied=1" }], diffs: { apply: { added: 0, changed: 5, removed: 0 } }, knownFailures: [], liveHost: { ok: true, checked: 55 } },
  });
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /## 隔离边界/);
  assert.match(markdown, /## 宿主加载与请求准备/);
  assert.match(markdown, /## 管理生命周期/);
  assert.match(markdown, /真实安装目标文件：未改动（55 个）/);
  assert.match(markdown, /cwd-template-variable/);
  assert.equal(markdown.includes("PRIME DIRECTIVE"), false);
});

test("writeReport 生成 JSON 与 Markdown", () => {
  const ws = workspace("report-write");
  const report = { generatedAt: new Date().toISOString(), ok: true, workspace: ws, baseline: {}, knownFailures: [] };
  const files = writeReport(ws, report);
  assert.ok(fs.existsSync(files.jsonFile));
  assert.ok(fs.existsSync(files.mdFile));
  assert.equal(JSON.parse(fs.readFileSync(files.jsonFile, "utf8")).ok, true);
});
