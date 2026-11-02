import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installPreset, userPresetRoot } from "../../lib/redteam/index.js";
import { assertDriveDPath } from "../../lib/verify/isolate.js";

/**
 * 已安装副本迁移（#4）：真实 installPreset 在“目录已存在”的分支上只做自愈，
 * 所以必须验证它对旧 toolFilter 的就地迁移不覆盖、不叠加、也不抹掉用户内容。
 *
 * 全部写入落在 D 盘临时目录；DSH_HOME 与 home 都指向那里，避免碰到真实用户目录。
 */

const TEST_ROOT = assertDriveDPath("D:\\dsh\\tmp\\dsh-purge-test", "测试根目录");

function withIsolatedHome(fn) {
  const home = fs.mkdtempSync(path.join(TEST_ROOT, "preset-home-"));
  const saved = { DSH_HOME: process.env.DSH_HOME, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.DSH_HOME = path.join(home, "dsh-home");
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  try {
    if (!assertDriveDPath(os.homedir(), "测试 home")) throw new Error("home 未切到 D 盘");
    return fn(home);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("installPreset 把已安装副本里的 toolFilter 就地迁成 agentPreset，重复执行不再改动", () => {
  withIsolatedHome(() => {
    const target = path.join(userPresetRoot(), "redteam");
    fs.mkdirSync(target, { recursive: true });
    const userLine = "      ## 用户自己加的提示词";
    const legacy = [
      "- id: persona",
      "  name: dsh-persona",
      "  config:",
      "    prefix: |",
      userLine,
      "- id: tool-subagent",
      "  name: dsh-tool-subagent",
      "  config:",
      "    provider: spawn",
      "    toolName: subagent",
      "    maxDepth: 1",
      "    toolFilter:",
      "      deny:",
      "        - subagent_fork",
      "        - workflow",
      "        - ralph",
      "- id: anchor-gate",
      "  name: ./anchor-gate.mjs",
      "- id: redteam-tools",
      "  name: dsh-purge/redteam/tools",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(target, "agent.cordis.yml"), legacy, "utf8");

    const first = installPreset({ log: () => {} });
    assert.equal(first.action, "repaired");
    assert.match(String(first.repaired), /tool-filter/);
    const after = fs.readFileSync(path.join(target, "agent.cordis.yml"), "utf8");
    assert.equal(/^\s*toolFilter:/m.test(after), false, "旧字段应被迁走");
    assert.match(after, /^\s*agentPreset: redteam-worker$/m);
    assert.ok(after.includes(userLine), "用户自己的内容必须保留");

    const second = installPreset({ log: () => {} });
    assert.equal(second.action, "kept");
    assert.equal(fs.readFileSync(path.join(target, "agent.cordis.yml"), "utf8"), after, "重复执行不应再改文件");
  });
});
