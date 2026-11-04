import assert from "node:assert/strict";
import test from "node:test";
import { ACCEPTANCE_ENTRIES, NOT_EXECUTED, collectAcceptance, renderAcceptanceMarkdown } from "../../lib/verify/acceptance.js";

/**
 * 验收记录（#8）：入口判定、锁与版本的硬条件、不适用项与「未执行」清单，
 * 以及记录里不能带提示词正文。
 */

function passingReport(overrides = {}) {
  return {
    ok: true,
    hostEntry: {
      ok: true,
      templateContract: { ok: true },
      promptPreset: { ok: true },
      toolBridge: { ok: true },
      promptBody: "SECRET-PROMPT-BODY",
    },
    presetEntry: { ok: true },
    modelToolCall: { ok: true, executed: { isError: false, textLength: 12 } },
    modelToolCallRejected: { executed: { isError: true, textLength: 39 } },
    admin: { ok: true, backupFaults: { ok: true } },
    targets: { ok: true, isolated: { notApplicable: [{ id: 30, name: "HOOKS", optional: true, keys: [{ searched: ["D:/x/dsh-hooks-claude-code"] }] }], unresolvedKeys: [] } },
    baseline: { treeHash: "abc123", fileCount: 149 },
    knownFailures: [],
    ...overrides,
  };
}

const OK_LOCK = { assertError: "ERR_DSH_PURGE_LOCAL_VERSION_LOCK", status: { locked: true, pinned: true, channel: "stable", updateTarget: "local" } };
const OK_PLUGIN = { version: "1.1.71", localVersionLock: { version: "1.1.71", remoteUpdates: false, editable: true }, dshTarget: "0.2.1-rc.5", dshTargets: ["0.2.1-rc.5"] };
const OK_HOST = { shellVersion: "0.2.1-rc.5", runtimeVersion: "0.2.1-rc.5", buildCommit: "d4db512a969f", asar: { size: 182766714, mtime: "2026-10-29" } };
const OK_BASELINE = { file: "D:/baseline.json", treeHash: "abc123", fileCount: 149 };

test("验收记录：全部入口 + 锁 + 版本都成立才判通过", () => {
  const record = collectAcceptance({ report: passingReport(), lock: OK_LOCK, plugin: OK_PLUGIN, host: OK_HOST, baseline: OK_BASELINE, commands: ["npm run acceptance"] });
  assert.equal(record.ok, true);
  assert.equal(record.entries.length, ACCEPTANCE_ENTRIES.length);
  assert.equal(record.entries.every((entry) => entry.ok), true);
  assert.equal(record.lock.ok, true);
  assert.equal(record.plugin.versionOk, true);
  assert.deepEqual(record.notApplicable.map((item) => item.id), ["#30"]);
  assert.deepEqual(record.notExecuted, NOT_EXECUTED);
  // A1：适配状态进记录，但不参与通过判定 —— 未适配不等于验收失败。
  assert.equal(record.host.adaptation.state, "adapted");
  assert.deepEqual(record.plugin.dshTargets, ["0.2.1-rc.5"]);
});

test("验收记录：任一入口失败、锁未拒绝或版本变化都判未通过", () => {
  const entryFailed = collectAcceptance({ report: passingReport({ targets: { ok: false } }), lock: OK_LOCK, plugin: OK_PLUGIN, host: OK_HOST, baseline: OK_BASELINE });
  assert.equal(entryFailed.ok, false);
  assert.equal(entryFailed.entries.find((entry) => entry.id === "targets").ok, false);

  const lockPassed = collectAcceptance({ report: passingReport(), lock: { assertError: "", status: { locked: true, pinned: true } }, plugin: OK_PLUGIN, host: OK_HOST, baseline: OK_BASELINE });
  assert.equal(lockPassed.ok, false, "锁没有拒绝远程更新时必须判未通过");

  const versionDrift = collectAcceptance({ report: passingReport(), lock: OK_LOCK, plugin: { ...OK_PLUGIN, version: "1.1.72" }, host: OK_HOST, baseline: OK_BASELINE });
  assert.equal(versionDrift.ok, false, "版本不是 1.1.71 时必须判未通过");

  const hostAhead = collectAcceptance({
    report: passingReport(), lock: OK_LOCK, plugin: OK_PLUGIN,
    host: { ...OK_HOST, shellVersion: "0.2.1-rc.6" }, baseline: OK_BASELINE,
  });
  assert.equal(hostAhead.host.adaptation.state, "unadapted", "宿主升级即记为未适配");
  assert.equal(hostAhead.ok, true, "未适配只记录，不让验收失败（用户口径：不阻断）");
});

test("验收记录：Markdown 只带结构性事实，不含提示词正文；未执行项必须列出", () => {
  const record = collectAcceptance({ report: passingReport(), lock: OK_LOCK, plugin: OK_PLUGIN, host: OK_HOST, baseline: OK_BASELINE, commands: ["npm run acceptance"] });
  const markdown = renderAcceptanceMarkdown(record);
  assert.equal(markdown.includes("SECRET-PROMPT-BODY"), false, "提示词正文不能进记录");
  assert.match(markdown, /## 验收入口/);
  assert.match(markdown, /## 兼容修订/);
  assert.match(markdown, /## 补丁对不上但不是失败/);
  assert.match(markdown, /## 已确认不适用/);
  assert.match(markdown, /## 未执行的检查/);
  assert.match(markdown, /dsh-hooks-claude-code/);
  assert.match(markdown, /treeHash：abc123/);
  for (const item of NOT_EXECUTED) assert.ok(markdown.includes(item), "未执行项要逐条列出：" + item);
});
