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
    assert.equal(report.admin.backupsCreated, 0);
    assert.equal(report.admin.revertRestored, false);
    const failureIds = report.knownFailures.map((failure) => failure.id);
    assert.ok(failureIds.includes("hostfs-fd-methods"));
    assert.ok(failureIds.includes("revert-without-backup"));
    assert.ok(fs.existsSync(result.files.jsonFile));
    assert.ok(fs.existsSync(result.files.mdFile));
    const workspaceOut = path.join(result.workspace.out, "prompt.txt");
    assert.ok(fs.existsSync(workspaceOut), "提示词全文只落在隔离工作区");
  } finally {
    fs.rmSync(result.workspace.root, { recursive: true, force: true });
    fs.rmSync(baselineDir, { recursive: true, force: true });
  }
});