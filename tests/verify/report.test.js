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

const templateContract = (ok) => ({
  ok,
  cases: [
    { id: "cwd-present-legacy", ok, rendered: ok ? "Working directory: D:/dsh/work. " : "", error: ok ? "" : "unknown prompt variable" },
    { id: "cwd-missing-legacy", ok, rendered: ok ? "Working directory: . " : "", error: ok ? "" : "unknown prompt variable" },
  ],
});

const promptPreset = (ok) => ({
  ok,
  passes: [
    { id: "assemble", ok, detail: "sections=4 variables=provider,model,cwd" },
    { id: "render", ok, detail: "22041 字符" },
    { id: "context", ok, detail: "包含 working-directory" },
    { id: "refresh", ok, detail: "required 上下文在抑制下保留" },
    { id: "stability", ok, detail: "两次装配一致" },
    { id: "no-leftovers", ok, detail: "0 个未解析变量" },
    { id: "request", ok, detail: "系统消息命中提示词与运行上下文" },
  ],
  prompt: { length: 22041, sha256: "9f3b94350f541d47aaaa" },
  context: { length: 120, sha256: "beef", hasWorkingDirectory: ok, names: ["working-directory"] },
  sections: [{ name: "dsh-purge", length: 20989 }],
  variables: ["provider", "model", "cwd"],
  stable: { repeats: 2, promptEqual: ok, sectionsEqual: ok, contextEqual: ok },
  leftovers: ok ? [] : ["{{cwd}}"],
  duplicates: { injectSections: ok ? 1 : 2, repeatedNames: [] },
  request: ok ? [{ role: "system", length: 22041, sha256: "9f3b", hasInject: true }] : null,
  error: "",
});

test("knownFailures 汇总宿主、预设与管理入口的已知故障", () => {
  const failures = knownFailures({
    hostEntry: {
      toolErrors: [{ name: "purge_apply", error: "missing additionalProperties" }],
    },
    presetAudit: { files: [{ id: "redteam", file: "redteam/agent.cordis.yml", deprecated: [{ key: "toolFilter", line: 317 }] }] },
    admin: { knownFailures: [{ id: "hostfs-fd-methods", summary: "fd" }] },
  });
  const ids = failures.map((failure) => failure.id);
  assert.deepEqual(ids, ["tool-schema-purge_apply", "preset-deprecated-redteam", "hostfs-fd-methods"]);
  assert.equal(failures[1].summary.includes("toolFilter@317"), true);
});

test("knownFailures 不再把 {{cwd}} 模板记成已知故障（#5 已修复）", () => {
  const failures = knownFailures({ hostEntry: { templateContract: { ok: false, cases: [] } } });
  assert.deepEqual(failures.map((failure) => failure.id), []);
});

test("buildReport 要求基线自检、宿主入口、模板契约、提示词预设与管理入口同时通过", () => {
  const ws = workspace("report");
  const base = {
    workspace: ws,
    baselineFile: "D:\\dsh\\data\\dsh-purge\\baseline\\baseline-x.json",
    seal: { baseline: { sourceRoot: "D:\\repo", source: { treeHash: "abc", fileCount: 2 }, plugin: { version: "1.1.71" }, host: { shellVersion: "0.2.1-rc.5" }, environment: {}, git: {} } },
    sealCheck: { ok: true },
    drift: null,
    hostInfo: { shellVersion: "0.2.1-rc.5" },
    pluginInfo: { version: "1.1.71" },
    hostEntry: { ok: true, prompt: { length: 10, sha256: "deadbeef" }, sections: [], variables: ["provider", "model", "cwd"], tools: [], toolErrors: [], templateContract: templateContract(true), promptPreset: promptPreset(true) },
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
  const templateFailed = buildReport({ ...base, hostEntry: { ...base.hostEntry, templateContract: templateContract(false) } });
  assert.equal(templateFailed.ok, false, "模板契约失败必须让验证不通过，而不是降级成已知故障");
  const presetFailed = buildReport({ ...base, hostEntry: { ...base.hostEntry, promptPreset: promptPreset(false) } });
  assert.equal(presetFailed.ok, false, "完整提示词预设跑不通必须让验证不通过");
});

test("renderReportMarkdown 输出边界、入口、模板契约与提示词预设，不包含提示词正文", () => {
  const ws = workspace("report-md");
  const report = buildReport({
    workspace: ws,
    baselineFile: "D:\\baseline.json",
    seal: { baseline: { sourceRoot: "D:\\repo", source: { treeHash: "abcdef", fileCount: 3 }, plugin: { version: "1.1.71", localVersionLock: { remoteUpdates: false } }, host: { shellVersion: "0.2.1-rc.5", runtimeVersion: "0.2.1-rc.5" }, environment: {}, git: {} } },
    sealCheck: { ok: true },
    hostEntry: {
      ok: true,
      prompt: { length: 22041, sha256: "9f3b94350f541d47aaaa" },
      sections: [{ name: "dsh-purge", length: 10 }],
      variables: ["provider", "model", "cwd"],
      tools: [{ name: "purge_apply" }],
      toolErrors: [],
      templateContract: templateContract(true),
      promptPreset: promptPreset(true),
    },
    admin: { ok: true, hosts: [path.join(ws.root, "host")], steps: [{ name: "apply", ok: true, text: "applied=1" }], diffs: { apply: { added: 0, changed: 5, removed: 0 } }, knownFailures: [], liveHost: { ok: true, checked: 55 } },
  });
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /## 隔离边界/);
  assert.match(markdown, /## 宿主加载与请求准备/);
  assert.match(markdown, /## 管理生命周期/);
  assert.match(markdown, /真实安装目标文件：未改动（55 个）/);
  assert.match(markdown, /模板渲染契约：通过（2 个案例）/);
  assert.match(markdown, /完整提示词预设：通过/);
  assert.equal(markdown.includes("cwd-template-variable"), false);
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
