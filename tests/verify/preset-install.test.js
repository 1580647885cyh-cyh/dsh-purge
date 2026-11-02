import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { installPreset, userPresetRoot } from "../../lib/redteam/index.js";
import { withIsolatedHome } from "./helpers.js";

/**
 * 已安装副本迁移（#4）：真实 installPreset 在“目录已存在”的分支上只做自愈，
 * 所以必须验证它对旧 toolFilter 的就地迁移不覆盖、不叠加、也不抹掉用户内容。
 *
 * 全部写入落在 D 盘临时目录（withIsolatedHome 连 homedir 一起切走）。
 */

test("installPreset 把已安装副本里的 toolFilter 就地迁成 agentPreset，重复执行不再改动", async () => {
  await withIsolatedHome(() => {
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
