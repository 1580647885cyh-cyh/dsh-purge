import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertDriveDPath } from "../../lib/verify/isolate.js";

/**
 * 测试共用设施：所有写盘都落在 D 盘临时目录。
 *
 * 为什么不各写各的：`installPreset` 会把随包技能同步到 `$DSH_HOME/redteam/skills`，
 * 并在 `homedir()/.dsh` 存在时顺手补一份。测试若只改 DSH_HOME，真实用户目录会被写。
 * 所以凡是会走到这类代码的测试，一律用 {@link withIsolatedHome}，它连 homedir 一起切走，
 * 并在切完后断言 home 真的在 D 盘（切不过去就直接失败，而不是悄悄写进 C 盘）。
 */

export const TEST_ROOT = assertDriveDPath("D:\\dsh\\tmp\\dsh-purge-test", "测试根目录");

/** 测试根下的唯一临时目录；调用方负责清理。 */
export function tempDir(label) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_ROOT, label));
}

/**
 * 把 DSH_HOME 与 home 指向 D 盘临时目录后执行 fn，结束后恢复环境并清理目录。
 * @param fn 接收临时 home 目录，返回值原样返回（异步也支持）。
 */
export async function withIsolatedHome(fn) {
  const home = tempDir("home-");
  const saved = { DSH_HOME: process.env.DSH_HOME, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.DSH_HOME = path.join(home, "dsh-home");
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    assertDriveDPath(os.homedir(), "测试 home");
    return await fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
