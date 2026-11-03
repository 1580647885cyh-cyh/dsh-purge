import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { proveAsarSwapRestart } from "../../lib/verify/desktop-swap.js";
import { tempDir } from "./helpers.js";

/**
 * A7 / #27：asar 换包顺序。
 *
 * 假安装树 + 真锁 app.asar，走生产入口 restartOfficialHarness：
 * - 失败案例：main 被杀、asar 挪不动 → 必须按未换包的原版布局重新拉起 exe；
 * - 成功案例：main 被杀、asar 挪得动 → 新进程必须看到 absent（已换包）。
 *
 * 修前对照（同一条 harness，只把失败分支退回 not starting）在
 * docs/verification/records/issue-27.md 记录：relaunched=false、old-main-gone=true、asar-kept=true。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const windowsOnly = process.platform === "win32" ? {} : { skip: "asar 换包 harness 需要 Windows wscript/taskkill" };

function caseById(record, group, id) {
  const hit = record.cases.find((item) => item.group === group && item.id === id);
  assert.ok(hit, group + " 组缺少案例 " + id + "；实际：" + record.cases.map((item) => item.group + "/" + item.id).join(","));
  return hit;
}

test("A7：asar 挪不动时把原版拉起来，挪得动时仍换包（隔离假安装树）", windowsOnly, async () => {
  const root = tempDir("desktop-swap-");
  try {
    const record = await proveAsarSwapRestart({ pluginRoot: repoRoot, root });
    assert.equal(record.error, "");
    assert.equal(record.ok, true, "失败案例：" + JSON.stringify(record.cases.filter((item) => !item.ok)));

    // 失败案例：桌面被关掉后必须按原版布局回来。
    assert.equal(caseById(record, "failure", "engine-wscript").ok, true, "生产入口必须走 expected wscript 路径");
    assert.equal(caseById(record, "failure", "relaunched").ok, true, "asar 挪不动也必须重新拉起原版");
    assert.equal(caseById(record, "failure", "old-main-gone").ok, true, "旧 main 必须先死");
    assert.match(caseById(record, "failure", "relaunch-layout").detail, /app\.asar=present/);
    assert.equal(caseById(record, "failure", "asar-kept").ok, true, "失败案例里 asar 必须仍在原位");
    assert.equal(caseById(record, "failure", "main-gone-before-move").ok, true, "main left / procs left 必须早于 move");
    assert.equal(caseById(record, "failure", "failure-branch").ok, true, "必须走到失败分支并拉起原版");

    // 成功路径不回退：main 死 → 挪 asar → 新进程看到 absent。
    assert.equal(caseById(record, "success", "relaunched").ok, true);
    assert.equal(caseById(record, "success", "old-main-gone").ok, true);
    assert.equal(caseById(record, "success", "asar-moved").ok, true, "挪得动时必须换成 .bak");
    assert.match(caseById(record, "success", "relaunch-layout").detail, /app\.asar=absent/);
    assert.equal(caseById(record, "success", "main-gone-before-move").ok, true);
    assert.equal(caseById(record, "success", "success-branch").ok, true);

    // 生成脚本本身：失败分支含 relaunch；顺序由上面的 main-gone-before-move 日志行为证明。
    for (const group of ["failure", "success"]) {
      assert.equal(caseById(record, group, "script-failure-relaunch").ok, true, group + " 的失败分支没有 relaunch");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
