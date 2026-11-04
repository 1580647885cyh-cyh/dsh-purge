import assert from "node:assert/strict";
import test from "node:test";
import { presetDeclareOutcome } from "../../lib/redteam/preset-status.js";

/**
 * preset-declare.json 的口径（A8 复盘）。
 *
 * 这份文件是「红队模式挂上没有」的现场证据：list() 读不到时不能写 registered，
 * 成功时也必须把上一阶段留下的 error 清掉，否则会出现 ok:true + 旧错误的假绿。
 */

test("presetDeclareOutcome：成功时 phase=registered 且 error 被清空", () => {
  assert.deepEqual(presetDeclareOutcome({}), {
    ok: true,
    phase: "registered",
    broken: null,
    workerBroken: null,
    listError: null,
    error: null,
  });
});

test("presetDeclareOutcome：registry.list 读不到时记 unverified，不算 registered", () => {
  const out = presetDeclareOutcome({ listError: "list failed" });
  assert.equal(out.ok, false);
  assert.equal(out.phase, "registered-unverified");
  assert.equal(out.listError, "list failed");
  assert.equal(out.error, null);
});

test("presetDeclareOutcome：父级/子级 broken 都归到 registered-broken", () => {
  const parent = presetDeclareOutcome({ broken: "row 3 never started" });
  assert.equal(parent.ok, false);
  assert.equal(parent.phase, "registered-broken");
  assert.equal(parent.broken, "row 3 never started");
  const worker = presetDeclareOutcome({ broken: null, workerBroken: "worker row failed" });
  assert.equal(worker.ok, false);
  assert.equal(worker.phase, "registered-broken");
  assert.equal(worker.workerBroken, "worker row failed");
});
