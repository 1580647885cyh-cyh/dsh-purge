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

    const failureIds = report.knownFailures.map((failure) => failure.id);
    assert.equal(failureIds.includes("hostfs-fd-methods"), false, "fd 缺口应已修复");
    assert.equal(failureIds.includes("revert-without-backup"), false, "有备份后 revert 应还原");
    assert.equal(failureIds.includes("host-tool-bridge"), false);
    assert.ok(failureIds.includes("cwd-template-variable"));
    assert.ok(failureIds.includes("preset-deprecated-redteam"));
    assert.ok(fs.existsSync(result.files.jsonFile));
    assert.ok(fs.existsSync(result.files.mdFile));
    const workspaceOut = path.join(result.workspace.out, "prompt.txt");
    assert.ok(fs.existsSync(workspaceOut), "提示词全文只落在隔离工作区");
  } finally {
    fs.rmSync(result.workspace.root, { recursive: true, force: true });
    fs.rmSync(baselineDir, { recursive: true, force: true });
  }
});