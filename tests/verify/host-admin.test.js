import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isWithin } from "../../lib/verify/isolate.js";
import { runVerification } from "../../lib/verify/run.js";
import { resolveHostInstall } from "../../lib/verify/host-entry.js";

const TEST_ROOT = "D:\\dsh\\tmp\\dsh-purge-test";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function hasHost() {
  try {
    resolveHostInstall({});
    return true;
  } catch {
    return false;
  }
}

test("隔离宿主加载与请求准备：真实宿主包 + 插件工具契约", { timeout: 180000 }, async (t) => {
  if (!hasHost()) {
    t.skip("未安装桌面宿主，跳过");
    return;
  }
  const stamp = "it-" + process.pid + "-" + Date.now();
  const baselineDir = path.join(TEST_ROOT, "baseline-" + stamp);
  const result = await runVerification({ root: REPO_ROOT, outRoot: TEST_ROOT, baselineDir, stamp, seal: true });
  const report = result.report;
  try {
    assert.equal(report.ok, true, "验证应通过：" + JSON.stringify(report.hostEntry && report.hostEntry.error));
    assert.equal(report.hostEntry.ok, true);
    const names = report.hostEntry.tools.map((tool) => tool.name);
    assert.ok(names.includes("purge_status"));
    assert.ok(names.includes("purge_apply"));
    assert.ok(names.includes("purge_revert"));
    assert.ok(report.hostEntry.prompt.length > 1000);
    assert.ok(report.hostEntry.sections.some((section) => section.name === "dsh-purge"));
    assert.deepEqual(report.hostEntry.variables, ["provider", "model"]);
    assert.equal(report.hostEntry.cwdTemplate.ok, false);
    assert.match(report.hostEntry.cwdTemplate.error, /unknown prompt variable/);
    assert.equal(report.baseline.drift === null || typeof report.baseline.drift.ok === "boolean", true);
    assert.equal(report.baseline.sealCheck.ok, true);
    assert.equal(report.baseline.plugin.version, "1.1.71");
    assert.equal(report.baseline.host.shellVersion, "0.2.1-rc.5");
    for (const host of report.admin.hosts) {
      assert.equal(isWithin(host, report.workspace.root), true, "管理操作只能命中隔离宿主：" + host);
    }
    assert.ok(report.admin.diffs.apply.changed >= 3, "候选宿主补丁应写入隔离副本");
    assert.equal(report.admin.diffs.reapply.changed, 0, "重复 apply 不应再改文件");

    // #3：文本/普通/非文本文件在管理操作中被区分；fd 读取与关闭可用。
    assert.equal(report.admin.fdProbe.missing.length, 0, "hostFs 不应缺 fd 方法");
    assert.equal(report.admin.fdProbe.fdLeaked, false);
    assert.equal(report.admin.fdProbe.renameError, "");
    assert.equal(report.admin.fileProbe.ok, true, JSON.stringify(report.admin.fileProbe));
    assert.equal(report.admin.fileProbe.before.text, "original");
    assert.equal(report.admin.fileProbe.after.text, "patched");
    assert.equal(report.admin.fileProbe.before.binary, "binary");
    assert.equal(report.admin.fileProbe.binaryUnchanged, true);

    // #3：备份真的落地，revert 用备份还原。
    assert.ok(report.admin.backupsCreated > 0, "apply 应产生 .dshpurge.bak");
    assert.equal(report.admin.revertRestored, true);

    // #3：隔离桌面布局能解析宿主依赖，真实宿主能把桥接模块真正加载起来。
    const bridge = report.hostEntry.toolBridge;
    assert.equal(bridge.ok, true, JSON.stringify(bridge));
    assert.equal(bridge.isolated.ok, true);
    assert.match(bridge.isolated.via, /desktop-install/);
    assert.equal(isWithin(bridge.isolated.hostRoot, report.workspace.root), true);
    assert.ok(bridge.isolated.tried.some((row) => row.status === "resolved"));
    assert.equal(bridge.host.ok, true);
    assert.match(bridge.host.via, /desktop-install/);
    const realInstall = resolveHostInstall({}).installDir;
    assert.equal(isWithin(bridge.host.hostRoot, realInstall), true, "真实宿主解析应落在安装目录内");
    assert.equal(bridge.loaded.ok, true);
    assert.equal(bridge.loaded.apply, true);

    // #4：旧 toolFilter 在真实宿主行入口复现，迁移后能挂上；子级预设只少那三行工具。
    const presetEntry = report.presetEntry;
    assert.equal(presetEntry.ok, true, JSON.stringify({ legacy: presetEntry.legacy, migrated: presetEntry.migrated, worker: presetEntry.worker }));
    assert.equal(presetEntry.legacy.rejected, true, "旧配置应复现宿主的 toolFilter 拒绝");
    assert.match(presetEntry.legacy.error, /toolFilter is no longer supported/);
    assert.equal(presetEntry.migrated.ok, true, JSON.stringify(presetEntry.migrated));
    assert.equal(presetEntry.composition.problem, "");
    assert.equal(presetEntry.composition.declaration, "", "预设声明应通过宿主 AgentPreset.Config");
    assert.equal(presetEntry.worker.declaration, "");
    assert.equal(presetEntry.worker.differsFromParent, true);
    assert.deepEqual(presetEntry.worker.removed, ["tool-subagent-fork", "tool-workflow", "tool-ralph"]);
    assert.equal(presetEntry.worker.ok, true);
    assert.equal(presetEntry.worker.agentPreset, "redteam-worker");
    assert.equal(presetEntry.bundled.ok, true, "随包模板同样要能挂上");
    // 已安装副本只读：迁移只发生在隔离副本上，且只改 toolFilter 那几行。
    assert.equal(report.presetMigration.idempotent, true, "重复迁移不应叠加改动");
    assert.ok(report.presetMigration.addedLines.some((line) => /agentPreset: redteam-worker/.test(line)));
    assert.ok(report.presetMigration.removedLines.some((line) => /toolFilter:/.test(line)));

    // #4：参数契约用宿主校验器跑有效/额外属性案例。
    for (const tool of report.hostEntry.tools) {
      assert.equal(tool.contract.validAccepted, true, tool.name + " 应接受空参数对象");
      assert.equal(tool.contract.extraRejected, true, tool.name + " 应拒绝未声明属性");
    }

    // #4：受控模型端点 → 模型产出的 tool_call → 真实工具执行路径。
    assert.equal(report.modelToolCall.ok, true, JSON.stringify(report.modelToolCall));
    assert.equal(report.modelToolCall.executed.isError, false);
    assert.ok(report.modelToolCall.executed.textLength > 0);
    assert.equal(report.modelToolCall.endpoint.requests.length, 1);
    assert.ok(report.modelToolCall.endpoint.requests[0].toolNames.includes("purge_status"));
    assert.equal(report.modelToolCallRejected.executed.isError, true, "工具集外的调用应被拒绝");

    const failureIds = report.knownFailures.map((failure) => failure.id);
    assert.equal(failureIds.includes("hostfs-fd-methods"), false, "fd 缺口应已修复");
    assert.equal(failureIds.includes("revert-without-backup"), false, "有备份后 revert 应还原");
    assert.equal(failureIds.includes("host-tool-bridge"), false);
    assert.ok(failureIds.includes("cwd-template-variable"));
    // 已安装副本仍写 toolFilter 时，降级为“待自愈”，不再算已知故障。
    assert.equal(failureIds.includes("preset-deprecated-redteam"), false);
    assert.equal(failureIds.includes("preset-migration"), false);
    if (report.presetEntry.installedLegacy) {
      assert.equal(report.pendingSelfHeal.length, 1);
      assert.match(report.pendingSelfHeal[0].summary, /已安装副本/);
    }
    assert.ok(fs.existsSync(result.files.jsonFile));
    assert.ok(fs.existsSync(result.files.mdFile));
    const workspaceOut = path.join(result.workspace.out, "prompt.txt");
    assert.ok(fs.existsSync(workspaceOut), "提示词全文只落在隔离工作区");
  } finally {
    fs.rmSync(result.workspace.root, { recursive: true, force: true });
    fs.rmSync(baselineDir, { recursive: true, force: true });
  }
});