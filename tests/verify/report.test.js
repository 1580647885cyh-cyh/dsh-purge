import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildReport, knownFailures, renderReportMarkdown, writeReport } from "../../lib/verify/report.js";
import { tempDir } from "./helpers.js";

function workspace(name) {
  const root = tempDir(name + "-");
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

const targetsRecord = (ok) => ({
  ok,
  error: "",
  aiBase: "D:/fixture/@deepseek-ai",
  // A1：宿主版本与适配状态（只记录，不参与通过判定）。
  host: { state: "unadapted", version: "0.2.1-rc.6", targets: ["0.2.1-rc.5"], label: "未适配", path: "C:/install/resources/app/package.json" },
  live: {
    aiBase: "C:/install/@deepseek-ai",
    summary: { effective: 56, satisfied: 8, pending: 1, unmatched: 5, "not-applicable": 15, unknown: 0 },
    unmatched: [{ id: 32, name: "WEB_SURFACE_IDENTITY_NEUTRAL", keys: ["web-app-lib"] }],
    unresolvedKeys: [{ key: "hooks-codex", resolved: false, searched: ["C:/install/dsh-hooks-codex"] }],
    shellFile: "C:/install/resources/app/lib/main.js",
    notApplicable: [],
  },
  isolated: {
    statusBefore: {},
    statusAfter: {},
    summary: { effective: 62, satisfied: 8, pending: 0, unmatched: 5, "not-applicable": 7, unknown: 0 },
    applied: [],
    notApplicable: [{ id: 30, name: "HOOKS_CLAUDE_DENY_ALLOW", optional: true, keys: [{ key: "hooks-claude-code", searched: ["D:/fixture/dsh-hooks-claude-code"] }] }],
    unmatched: [{ id: 77, name: "REWIND_DROP_SENT_ON_APPEND", optional: true, keys: ["conversation-client"] }],
    // A2：漂移清单（补丁 → 文件 → 没命中的锚点）。
    drifted: [{ id: 8, name: "ENGINE_APPROVAL_BYPASS", optional: false, strict: false, keys: [{ key: "base", path: "D:/fixture/dsh-base/cordis.patch.yml", anchors: [{ index: 0, kind: "literal", head: "official anchor line" }] }] }],
    unresolvedKeys: [{ key: "hooks-codex", resolved: false, searched: ["D:/fixture/dsh-hooks-codex"] }],
    diffs: { apply: 47, reapply: 0 },
  },
  audit: { falseSuccess: [], ahead: [], behind: [], settledByLayout: [{ id: 21, name: "BASH_TIMEOUT_RESTORE", status: "applied", targets: ["base"] }] },
  runtime: {
    completePrompt: { ok, error: ok ? "" : "注入段丢失", detail: {} },
    shell: { ok, error: "", cases: [{ id: "clean-exit", ok }] },
    // A5（#25）：桌面退出留痕的证明（三路 + 上界 + 读侧 + 两条拔痕对照）。
    exitTrace: {
      ok,
      error: "",
      latest: ok ? { at: "2026-11-03T11:20:12.698Z", code: 0, signal: null, source: "close" } : null,
      statusLine: ok ? "· 最近一次桌面退出 / desktop exit: code=0 · signal=无 · 2026-11-03T11:20:12.698Z · 来源=close" : "",
      bound: { maxEntries: 20, maxBytes: 8192 },
      cases: ok ? [{ id: "read-side", ok: true, detail: "status 行命中" }] : [{ id: "control-trace-removed", ok: false, detail: "拔掉后仍有记录" }],
    },
  },
  liveHost: { ok: true, checked: 55, changed: [] },
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

test("受控工具调用：判定看 verdict，不看 record.ok（2026-11-04）", () => {
  const ws = workspace("report-tool-verdict");
  const base = {
    workspace: ws,
    seal: { baseline: { sourceRoot: "D:\\repo", source: { treeHash: "abc", fileCount: 2 }, plugin: { version: "1.1.71" }, host: { shellVersion: "0.2.1-rc.5" }, environment: {}, git: {} } },
    sealCheck: { ok: true },
    hostEntry: { ok: true, prompt: { length: 10, sha256: "deadbeef" }, sections: [], variables: ["provider", "model", "cwd"], tools: [], toolErrors: [], templateContract: templateContract(true), promptPreset: promptPreset(true) },
    presetAudit: { files: [] },
    admin: { ok: true, hosts: [], steps: [], diffs: {}, liveHost: { ok: true, checked: 0 } },
    targets: targetsRecord(true),
  };
  const round = (executed, verdict) => ({
    kind: "verify.model-tool-call",
    ok: false,
    verdict,
    call: { name: "purge_nonexistent", arguments: {} },
    endpoint: { port: 1, requests: [], requestCount: 1, attempts: 1 },
    blocks: [],
    executed,
    attempts: 1,
    retried: false,
    error: "",
  });
  const okRound = round({ isError: false, textLength: 3 }, "accepted");

  const rejected = buildReport({ ...base, modelToolCall: okRound, modelToolCallRejected: round({ isError: true, textLength: 39 }, "rejected") });
  assert.equal(rejected.modelToolCallRejected.ok, false, "反向案例的 ok 本来就是 false —— 字段保留原语义");
  assert.equal(rejected.modelToolCallRejected.verdict, "rejected");
  assert.equal(rejected.ok, true, "判定通过时，报告不该因为 ok=false 变红");
  assert.match(renderReportMarkdown(rejected), /判定 rejected/);

  const leaked = buildReport({ ...base, modelToolCall: okRound, modelToolCallRejected: round({ isError: false, textLength: 5 }, "unexpected-success") });
  assert.equal(leaked.ok, false, "本该被拒绝却执行成功 → 报告不通过");
  assert.deepEqual(leaked.knownFailures.map((failure) => failure.id), ["model-tool-unknown-accepted"]);
});

test("预设入口：自研行挂载失败进已知故障，挂载覆盖与工具行进报告（A8 复盘）", () => {
  const failures = knownFailures({
    presetEntry: { ownRows: [{ id: "redteam-tools", ok: false, error: "payload.additionalProperties must be explicitly true or false" }] },
  });
  assert.deepEqual(failures.map((failure) => failure.id), ["preset-own-row-redteam-tools"]);
  assert.match(failures[0].summary, /redteam-tools/);

  const ws = workspace("report-preset-coverage");
  const tools = new Array(56).fill("tool");
  const report = buildReport({
    workspace: ws,
    seal: { baseline: { sourceRoot: "D:\\repo", source: { treeHash: "abc", fileCount: 2 }, plugin: { version: "1.1.71" }, host: { shellVersion: "0.2.1-rc.5" }, environment: {}, git: {} } },
    sealCheck: { ok: true },
    hostEntry: { ok: true, prompt: { length: 10, sha256: "deadbeef" }, sections: [], variables: ["provider", "model", "cwd"], tools: [], toolErrors: [], templateContract: templateContract(true), promptPreset: promptPreset(true) },
    presetAudit: { files: [] },
    presetEntry: {
      ok: true,
      dir: "D:\\repo\\presets\\redteam",
      legacy: { rejected: true, error: "" },
      migrated: { ok: true, error: "", tools: [] },
      worker: { removed: [], ok: true, error: "", agentPreset: "redteam-worker", mount: { ok: true, error: "", tools: [] } },
      composition: { problem: "", rows: 19 },
      ownRows: [{ id: "redteam-tools", ok: true, error: "", tools }],
      coverage: { rows: 19, mounted: ["tool-subagent", "anchor-gate", "redteam-tools"], own: ["anchor-gate", "redteam-tools"], unmountedOwn: [] },
      toolsRow: { ok: true, error: "", tools },
    },
    admin: { ok: true, hosts: [], steps: [], diffs: {}, liveHost: { ok: true, checked: 0 } },
    targets: targetsRecord(true),
  });
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /挂载覆盖：3\/19 行/);
  assert.match(markdown, /工具行 redteam-tools：ok · 宿主 defineTool 编译出 56 个工具/);
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
    targets: targetsRecord(true),
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
  const runtimeFailed = buildReport({ ...base, targets: targetsRecord(false) });
  assert.equal(runtimeFailed.ok, false, "目标定位与运行结果证明失败必须让验证不通过");
});

test("--only 的报告：只对跑过的阶段判红，未执行的阶段不算失败也不算通过", () => {
  const ws = workspace("report-partial");
  const base = {
    workspace: ws,
    baselineFile: "D:\\baseline.json",
    seal: { baseline: { sourceRoot: "D:\\repo", source: { treeHash: "abcdef", fileCount: 3 }, plugin: { version: "1.1.71" }, host: { shellVersion: "0.2.1-rc.5" }, environment: {}, git: {} } },
    sealCheck: { ok: true },
    // 只跑入口五：宿主/预设/模型/管理入口都没跑。
    hostEntry: null,
    presetEntry: null,
    admin: null,
    targets: targetsRecord(true),
    partial: { stages: ["targets"], skipped: ["host", "preset", "model", "admin"] },
  };
  const passed = buildReport(base);
  assert.equal(passed.ok, true, "只跑 targets 且 targets 通过时，整体应为通过");
  assert.deepEqual(passed.partial, base.partial, "报告必须写明只跑了哪些阶段");
  const markdown = renderReportMarkdown(passed);
  assert.match(markdown, /范围：只跑了 targets；未执行：host,preset,model,admin/);

  const failedTargets = buildReport({ ...base, targets: targetsRecord(false) });
  assert.equal(failedTargets.ok, false, "跑过的阶段失败仍然要红");
  const brokenBaseline = buildReport({ ...base, sealCheck: { ok: false } });
  assert.equal(brokenBaseline.ok, false, "基线自检失败不能被 --only 吞掉");
});

test("knownFailures 把假成功、状态超前与运行结果失败报成 #6 的失败", () => {
  const failures = knownFailures({
    targets: {
      audit: {
        falseSuccess: [{ id: 24, name: "PRESET_FETCH_ENABLED", status: "applied", targets: ["preset-standard"] }],
        ahead: [{ id: 84, name: "DESKTOP_HOST_CLOSE_CODE0_NO_FAIL", status: "applied" }],
      },
      isolated: { diffs: { reapply: 2 } },
      runtime: { completePrompt: { ok: false, error: "注入段丢失" }, exitTrace: { ok: false, error: "留痕没写" } },
      liveHost: { ok: false, changed: ["main.js"] },
    },
  });
  const ids = failures.map((failure) => failure.id);
  assert.ok(ids.includes("target-false-success-24"));
  assert.ok(ids.includes("target-status-ahead-84"));
  assert.ok(ids.includes("target-reapply-not-idempotent"));
  assert.ok(ids.includes("target-runtime-completePrompt"));
  assert.ok(ids.includes("target-runtime-exitTrace"));
  assert.ok(ids.includes("target-live-host-write"));
  assert.ok(failures.every((failure) => failure.owner === "#6"));
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
    targets: targetsRecord(true),
  });
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /## 隔离边界/);
  assert.match(markdown, /## 宿主加载与请求准备/);
  assert.match(markdown, /## 管理生命周期/);
  assert.match(markdown, /真实安装目标文件：未改动（55 个）/);
  assert.match(markdown, /模板渲染契约：通过（2 个案例）/);
  assert.match(markdown, /完整提示词预设：通过/);
  assert.match(markdown, /## 目标定位与适配状态（#6）/);
  assert.match(markdown, /应用后逐文件核对：写进文件 62/);
  assert.match(markdown, /对不上 #77/);
  assert.match(markdown, /宿主版本与适配状态：0\.2\.1-rc\.6 — 未适配（本版声明：0\.2\.1-rc\.5）/);
  assert.match(markdown, /漂移（原文对不上、也没改上）：1 条/);
  assert.match(markdown, /漂移 #8/);
  assert.match(markdown, /official anchor line/);
  assert.match(markdown, /桌面壳 close 回调：/);
  assert.match(markdown, /桌面退出留痕：close \/ quit/);
  // 这一行原样来自 purge_status（报告不重算格式，也不在读取失败时自己拼一行）。
  assert.match(markdown, /· 最近一次桌面退出 \/ desktop exit: code=0 · signal=无 · 2026-11-03T11:20:12\.698Z · 来源=close/);
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
