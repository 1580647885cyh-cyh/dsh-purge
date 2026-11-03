import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ADAPTATION_STATES,
  describeHostAdaptation,
  hostAdaptation,
  hostTargets,
  hostVersionKey,
  parseHostVersion,
  readHostVersion,
} from "../../lib/host-version.js";
import { tempDir } from "../verify/helpers.js";

/**
 * 宿主版本与适配状态（A1 / issue #18）。
 *
 * 判定的语义是「声明过的版本才算已适配」，刻意不做 semver 区间：
 * 区间会把没验证过的版本自动说成可适配，那是假绿。三态都不阻断任何写入。
 */

test("parseHostVersion：认 v 前缀与预发布分段，认不出返回 null", () => {
  assert.deepEqual(parseHostVersion("0.2.1-rc.5"), { major: 0, minor: 2, patch: 1, pre: ["rc", "5"] });
  assert.deepEqual(parseHostVersion("v0.2.1"), { major: 0, minor: 2, patch: 1, pre: [] });
  assert.equal(parseHostVersion(""), null);
  assert.equal(parseHostVersion("0.2"), null);
  assert.equal(parseHostVersion("latest"), null);
  assert.equal(parseHostVersion(null), null);
});

test("hostVersionKey：v 前缀、大小写、尾随空白不算差异；认不出是空串", () => {
  assert.equal(hostVersionKey(" 0.2.1-RC.5 "), "0.2.1-rc.5");
  assert.equal(hostVersionKey("v0.2.1-rc.5"), "0.2.1-rc.5");
  assert.equal(hostVersionKey("0.2.1"), "0.2.1");
  assert.equal(hostVersionKey("nope"), "");
});

test("hostTargets：dshTarget 在前、dshTargets 并列，按归一化键去重", () => {
  assert.deepEqual(hostTargets({ dshTarget: "0.2.1-rc.5" }), ["0.2.1-rc.5"]);
  assert.deepEqual(
    hostTargets({ dshTarget: "0.2.1-rc.5", dshTargets: ["0.2.1-rc.2", "v0.2.1-rc.5", "0.2.1-rc.6"] }),
    ["0.2.1-rc.5", "0.2.1-rc.2", "0.2.1-rc.6"],
  );
  assert.deepEqual(hostTargets({}), []);
});

test("hostAdaptation：已适配 / 未适配 / 未知三态，且都不抛", () => {
  const targets = ["0.2.1-rc.5"];
  assert.equal(hostAdaptation("0.2.1-rc.5", targets).state, "adapted");
  assert.equal(hostAdaptation("v0.2.1-RC.5", targets).state, "adapted", "等价写法算同一个版本");
  assert.equal(hostAdaptation("0.2.1-rc.6", targets).state, "unadapted", "宿主升级即未适配，不靠区间蒙混");
  assert.equal(hostAdaptation("", targets).state, "unknown", "读不到版本是未知，不是已适配");
  assert.equal(hostAdaptation("0.2.1-rc.6", []).state, "unadapted", "插件没声明目标时也不假装适配");
  assert.equal(hostAdaptation("0.2.1-rc.6", []).label, "未适配");
  assert.deepEqual(ADAPTATION_STATES, ["adapted", "unadapted", "unknown"]);
  assert.equal(hostAdaptation("0.2.1-rc.6", targets).targets.length, 1, "记录里要留下声明过的版本");
});

test("readHostVersion：从 <appDir>/package.json 读壳版本，读不到返回 null", () => {
  const dir = tempDir("host-version-");
  try {
    assert.equal(readHostVersion(dir), null, "没有 package.json 时返回 null，不抛");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.1-rc.6" }), "utf8");
    const read = readHostVersion(dir);
    assert.equal(read.version, "0.2.1-rc.6");
    assert.equal(read.name, "@deepseek-ai/dsh-desktop");
    assert.ok(read.path.endsWith("package.json"));
    fs.writeFileSync(path.join(dir, "package.json"), "{not json", "utf8");
    assert.equal(readHostVersion(dir), null, "坏 JSON 也按读不到处理");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("describeHostAdaptation：一行给人看，读不到版本时写「读不到」", () => {
  assert.equal(describeHostAdaptation(hostAdaptation("0.2.1-rc.5", ["0.2.1-rc.5"])), "0.2.1-rc.5 — 已适配（本版声明：0.2.1-rc.5）");
  assert.equal(describeHostAdaptation(hostAdaptation("0.2.1-rc.6", ["0.2.1-rc.5"])), "0.2.1-rc.6 — 未适配（本版声明：0.2.1-rc.5）");
  assert.equal(describeHostAdaptation(hostAdaptation("", ["0.2.1-rc.5"])), "读不到 — 未知（本版声明：0.2.1-rc.5）");
  assert.equal(describeHostAdaptation(null), "读不到 — 未知（本版声明：未声明）");
});
