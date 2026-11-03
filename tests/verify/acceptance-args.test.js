import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceArgsProblem, parseAcceptanceArgs } from "../../lib/verify/acceptance-args.js";

/**
 * 验收入口的参数契约（#22 复盘）。
 *
 * 背景：本机 npm 会把 `npm run acceptance -- --out DIR --name BASE` 的旗标吃掉，
 * 只把值传进来。这一组钉住两件事：正常写法解析得到；被吞之后能被当成用法错误。
 */

test("默认值：不传参数时没有 out/name/stamp，也没有位置参数", () => {
  const args = parseAcceptanceArgs([]);
  assert.equal(args.out, "");
  assert.equal(args.name, "");
  assert.equal(args.stamp, "");
  assert.deepEqual(args.positional, []);
  assert.equal(acceptanceArgsProblem(args), "", "没问题时不该报用法错误");
});

test("空格与等号两种写法都认", () => {
  const spaced = parseAcceptanceArgs(["--out", "docs/compatibility", "--name", "rc5-acceptance", "--stamp", "s1"]);
  assert.equal(spaced.out, "docs/compatibility");
  assert.equal(spaced.name, "rc5-acceptance");
  assert.equal(spaced.stamp, "s1");
  assert.deepEqual(spaced.positional, []);

  const inline = parseAcceptanceArgs(["--out=docs/compatibility", "--name=rc5-acceptance"]);
  assert.equal(inline.out, "docs/compatibility");
  assert.equal(inline.name, "rc5-acceptance");
  assert.deepEqual(inline.positional, []);
});

test("npm 吞掉旗标后的argv（只剩值）要当成用法错误，并给出可照抄的写法", () => {
  // 实测：npm run acceptance -- --out docs/compatibility --name rc5-acceptance
  // 传到脚本的是 ["docs/compatibility"]。
  const mangled = parseAcceptanceArgs(["docs/compatibility"]);
  assert.deepEqual(mangled.positional, ["docs/compatibility"]);
  assert.equal(mangled.out, "", "旗标没了就是没了，不许猜");
  const problem = acceptanceArgsProblem(mangled);
  assert.ok(problem.includes("node scripts/acceptance.mjs --out DIR"), "提示里要给可直接照抄的命令：" + problem);
  assert.ok(problem.includes("位置参数"), "要说清拿到了什么：" + problem);
});
