import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveWorkerRows,
  findToolFilterKeys,
  migrateToolFilter,
  workerDefinition,
  WORKER_PRESET_ID,
} from "../../lib/redteam/preset-migration.js";

/**
 * 预设迁移（#4）：宿主 0.2.1-rc.5 废弃 toolFilter，等价语义落到子级预设 redteam-worker。
 *
 * 期望来源是 1.1.71 的旧配置含义（deny subagent_fork/workflow/ralph），不是新实现的输出：
 * 迁移只许改 tool-subagent 行里那一段，用户其余内容一个字节都不许动，重复执行不再改动。
 */

const LEGACY = [
  "- id: persona",
  "  name: dsh-persona",
  "  config:",
  "    prefix: |",
  "      ## 用户自己的提示词",
  "      这一行必须原样保留",
  "",
  "- id: delegation",
  "  name: cordis:group",
  "  group: true",
  "  config:",
  "    - id: tool-subagent",
  "      name: dsh-tool-subagent",
  "      disabled: false",
  "      config:",
  "        provider: spawn",
  "        toolName: subagent",
  "        maxDepth: 1",
  "        toolFilter:",
  "          deny:",
  "            - subagent_fork",
  "            - workflow",
  "            - ralph",
  "",
  "    - id: tool-subagent-fork",
  "      name: dsh-tool-subagent",
  "      config:",
  "        provider: fork",
  "",
  "    - id: tool-workflow",
  "      name: dsh-tool-workflow",
  "",
  "    - id: tool-ralph",
  "      name: dsh-tool-ralph",
  "",
  "- id: tool-todo",
  "  name: dsh-tool-todo",
""
].join("\n"); // LEGACY

test("迁移：删掉 toolFilter 块并在同一行写 agentPreset", () => {
  const out = migrateToolFilter(LEGACY);
  assert.equal(out.changed, true);
  assert.equal(out.skipped, false);
  assert.equal(findToolFilterKeys(out.text).length, 0);
  assert.match(out.text, /^ {8}agentPreset: redteam-worker$/m);
  assert.equal(/^\s+- subagent_fork$/m.test(out.text), false);
});

test("迁移幂等：同一份文本连续迁移，第二次不再改动", () => {
  const first = migrateToolFilter(LEGACY);
  const second = migrateToolFilter(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
  assert.equal(migrateToolFilter(first.text).skipped, false);
});

test("迁移保留用户自定义内容：提示词、其它行与自己的注释都不动", () => {
  const withNote = LEGACY.replace("        maxDepth: 1", "        # 用户自己写的注释\n        maxDepth: 1");
  const out = migrateToolFilter(withNote);
  assert.match(out.text, /## 用户自己的提示词\n      这一行必须原样保留/);
  assert.match(out.text, /# 用户自己写的注释\n {8}maxDepth: 1/);
  assert.match(out.text, /- id: tool-todo\n {2}name: dsh-tool-todo/);
  const dropped = /^\s*(toolFilter:|deny:|- subagent_fork|- workflow|- ralph)$/;
  for (const line of withNote.split("\n")) {
    if (dropped.test(line)) continue;
    assert.ok(out.text.split("\n").includes(line), "被误改：" + line);
  }
});

test("迁移在 CRLF 文件上保持行尾，不把整份文件改成 LF", () => {
  const out = migrateToolFilter(LEGACY.replace(/\n/g, "\r\n"));
  assert.equal(out.changed, true);
  assert.equal((out.text.match(/\r\n/g) || []).length > 10, true);
  assert.equal(/[^\r]\n/.test(out.text), false);
});

test("迁移不猜内联写法：toolFilter 在同一行时报告 skipped 并原样返回", () => {
  const inline = "  - id: tool-subagent\n    config:\n      toolFilter: { deny: [subagent_fork] }\n";
  const out = migrateToolFilter(inline);
  assert.equal(out.changed, false);
  assert.equal(out.skipped, true);
  assert.equal(out.text, inline);
  assert.match(out.reason, /内联/);
});

test("迁移对已经没有 toolFilter 的文本是 no-op", () => {
  const migrated = migrateToolFilter(LEGACY).text;
  const again = migrateToolFilter(migrated);
  assert.equal(again.changed, false);
  assert.equal(again.skipped, false);
  assert.equal(again.text, migrated);
});

test("worker 组合只裁掉旧 deny 的三行工具，其余行逐字保留", () => {
  const rows = [
    { id: "persona", name: "p", config: { prefix: "x" } },
    { id: "delegation", name: "cordis:group", group: true, config: [
      { id: "tool-subagent", name: "s", config: { provider: "spawn", agentPreset: WORKER_PRESET_ID } },
      { id: "tool-subagent-fork", name: "s", config: { provider: "fork" } },
      { id: "tool-workflow", name: "w" },
      { id: "tool-ralph", name: "r" },
    ] },
    { id: "tool-todo", name: "t" },
  ];
  const out = deriveWorkerRows(rows);
  assert.deepEqual(out.removed, ["tool-subagent-fork", "tool-workflow", "tool-ralph"]);
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.rows[1].config.map((row) => row.id), ["tool-subagent"]);
  assert.equal(rows[1].config.length, 4);
});

test("workerDefinition：id/order 由父级派生，工具集是父级减去 deny 行", () => {
  const parent = { id: "redteam", name: "红队模式", order: 10, plugins: [{ id: "tool-ralph", name: "r" }, { id: "tool-todo", name: "t" }] };
  const { definition, removed } = workerDefinition(parent);
  assert.equal(definition.id, WORKER_PRESET_ID);
  assert.equal(definition.order, 11);
  assert.deepEqual(definition.plugins.map((row) => row.id), ["tool-todo"]);
  assert.deepEqual(removed, ["tool-ralph"]);
  assert.match(definition.description, /subagent_fork/);
});
