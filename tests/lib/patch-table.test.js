import assert from "node:assert/strict";
import test from "node:test";
import {
  ALT_FILE_KEYS,
  TARGET_FILE_KEYS,
  assertPatchTable,
  assertTargetKeys,
  isKnownFileKey,
  patchTableProblems,
} from "../../lib/patch-model.js";
import { ALL_PATCHES } from "../../lib/core.js";

/**
 * 补丁表的受检引用（issue #15）。
 *
 * 这一组测的不是「某条补丁对不对」，而是「表本身能不能自证」：
 * 键名写错、id 撞车在过去会让 apply 静默变绿；现在加载即失败。
 */

test("键注册表：64 个解析键 + 4 个备用布局键，互不重叠", () => {
  assert.equal(TARGET_FILE_KEYS.length, 64);
  assert.equal(ALT_FILE_KEYS.length, 4);
  assert.equal(new Set(TARGET_FILE_KEYS).size, 64, "注册表不许有重复键");
  for (const key of ALT_FILE_KEYS) {
    assert.equal(TARGET_FILE_KEYS.includes(key), false, key + " 是备用键，不应出现在解析注册表里");
    assert.equal(isKnownFileKey(key), true);
  }
  assert.equal(isKnownFileKey("not-a-real-key"), false);
});

test("82 条补丁全部可构造，且每个 file 键都能解析到已知键", () => {
  assert.equal(ALL_PATCHES.length, 82);
  assert.equal(assertPatchTable(ALL_PATCHES), 82);
  const { hard, soft } = patchTableProblems(ALL_PATCHES);
  assert.deepEqual(hard, [], "硬问题必须为 0");
  assert.deepEqual(soft, [], "软问题（缺改写写法 / 缺完成标记 / 缺 name+layer）必须为 0");
  for (const patch of ALL_PATCHES) {
    const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
    assert.ok(keys.length > 0, "#" + patch.id + " 没有 file");
    for (const key of keys) assert.ok(isKnownFileKey(key), "#" + patch.id + " 的键 " + key + " 未登记");
  }
});

test("故障对照：键名写错必须在构造期炸，不能静默变绿", () => {
  const broken = [...ALL_PATCHES, { ...ALL_PATCHES[0], id: 9999, file: "preset-standardd" }];
  const problems = patchTableProblems(broken);
  assert.equal(problems.hard.length, 1);
  assert.match(problems.hard[0], /#9999 引用了未知的 file 键 "preset-standardd"/);
  assert.throws(() => assertPatchTable(broken), (error) => {
    assert.equal(error.code, "ERR_DSH_PURGE_PATCH_TABLE");
    assert.match(error.message, /preset-standardd/);
    return true;
  });
});

test("故障对照：重复 id 与字段类型错误同样在构造期炸", () => {
  const base = ALL_PATCHES[0];
  assert.throws(() => assertPatchTable([{ ...base, id: 1 }, { ...base, id: 1 }]), /#1 的 id 与 #1/);
  assert.throws(() => assertPatchTable([{ ...base, markersAny: "yes" }]), /markersAny 不是布尔/);
  assert.throws(() => assertPatchTable([{ ...base, settle: "maybe" }]), /settle 只能是/);
  assert.throws(() => assertPatchTable([{ ...base, patterns: ["x"], replace: undefined }]), /用了 patterns 却没有字符串 replace/);
  assert.throws(() => assertPatchTable([{ ...base, revertsFrom: "later" }]), /revertsFrom 不是函数/);
});

test("故障对照：targetFiles 键集合与注册表不一致必须报错（两个方向）", () => {
  assert.equal(assertTargetKeys([...TARGET_FILE_KEYS]), 64);
  assert.throws(() => assertTargetKeys([...TARGET_FILE_KEYS, "vendor-extra"]), (error) => {
    assert.equal(error.code, "ERR_DSH_PURGE_TARGET_KEYS");
    assert.match(error.message, /解析器多出：vendor-extra/);
    return true;
  });
  const missingOne = TARGET_FILE_KEYS.filter((key) => key !== "sandbox-policy");
  assert.throws(() => assertTargetKeys(missingOne), /注册表里多出：sandbox-policy/);
});
