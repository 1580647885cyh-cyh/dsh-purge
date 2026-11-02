import assert from "node:assert/strict";
import test from "node:test";
import { parseVerifyArgs } from "../../lib/verify/cli-args.js";

/** 验证入口的参数契约：默认值、--keep、--no-prune 与既有开关。 */

test("默认值：保留策略开、默认 5 由 runVerification 兜底，seal 开、非 json", () => {
  const args = parseVerifyArgs([], { defaultRoot: "D:/repo" });
  assert.equal(args.root, "D:/repo");
  assert.equal(args.seal, true);
  assert.equal(args.prune, true);
  assert.equal(args.json, false);
  assert.equal(args.retentionKeep, undefined, "没给 --keep 就不要编一个默认值");
});

test("--keep 接受空格与等号两种写法，非数字忽略", () => {
  assert.equal(parseVerifyArgs(["--keep", "2"], { defaultRoot: "D:/repo" }).retentionKeep, 2);
  assert.equal(parseVerifyArgs(["--keep=7"], { defaultRoot: "D:/repo" }).retentionKeep, 7);
  assert.equal(parseVerifyArgs(["--keep", "abc"], { defaultRoot: "D:/repo" }).retentionKeep, undefined);
  assert.equal(parseVerifyArgs(["--keep", "0"], { defaultRoot: "D:/repo" }).retentionKeep, 0);
});

test("--no-prune 关掉清理；--stamp / --out-root / --no-seal / --json 照旧", () => {
  const args = parseVerifyArgs(["--no-prune", "--stamp", "s1", "--out-root", "D:/o", "--no-seal", "--json"], { defaultRoot: "D:/repo" });
  assert.equal(args.prune, false);
  assert.equal(args.stamp, "s1");
  assert.equal(args.outRoot, "D:\\o");
  assert.equal(args.seal, false);
  assert.equal(args.json, true);
});
