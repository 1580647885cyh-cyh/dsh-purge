import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleUrl, resolveHostInstall } from "../../lib/verify/host-entry.js";
import { ownRowIds, presetEntryOk, probePresetEntry, rowTarget } from "../../lib/verify/preset-entry.js";

/**
 * 预设入口（A8 复盘）。
 *
 * 报告曾经把「只挂 tool-subagent 一行」渲染成整份预设通过；工具行 redteam-tools
 * 才是真正注册 53+ 个工具、把每个参数 schema 交给宿主 defineTool 编译的那一行。
 * 这里把「自研行必须全挂、工具行必须真的编译出工具」钉成硬条件：
 * 少挂一行、工具行失败或没注册出工具，presetEntryOk 都必须为 false。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundledPreset = path.join(repoRoot, "presets", "redteam");

function installOrNull() {
  try {
    return resolveHostInstall({});
  } catch {
    return null;
  }
}

function record(overrides = {}) {
  return {
    toolFilter: [],
    migration: { changed: false },
    composition: { problem: "", declaration: "", rows: 19 },
    legacy: { rejected: true, error: "" },
    migrated: { ok: true, error: "", tools: [] },
    worker: {
      ok: true,
      error: "",
      declaration: "",
      problem: "",
      removed: ["tool-subagent-fork", "tool-workflow", "tool-ralph"],
      agentPreset: "redteam-worker",
      mount: { ok: true, error: "", tools: [] },
    },
    ownRows: [{ id: "redteam-tools", ok: true, error: "", tools: ["redteam_preflight"] }],
    coverage: { rows: 19, mounted: ["tool-subagent", "redteam-tools"], own: ["redteam-tools"], unmountedOwn: [] },
    toolsRow: { id: "redteam-tools", ok: true, error: "", tools: ["redteam_preflight"] },
    ...overrides,
  };
}

test("presetEntryOk：工具行没挂上、没注册出工具、自研行漏挂都要判失败", () => {
  assert.equal(presetEntryOk(record()), true);
  assert.equal(presetEntryOk(record({ toolsRow: { ok: false, error: "p.additionalProperties must be explicitly true or false", tools: [] } })), false);
  assert.equal(presetEntryOk(record({ toolsRow: { ok: true, error: "", tools: [] } })), false, "工具行挂上但没注册出工具，说明没走到真编译");
  assert.equal(presetEntryOk(record({ coverage: { rows: 19, mounted: ["tool-subagent"], own: ["redteam-tools"], unmountedOwn: ["redteam-tools"] } })), false);
  assert.equal(presetEntryOk(record({ legacy: { rejected: false, error: "没有复现宿主拒绝" } })), false);
});

test("ownRowIds：只认 ./ 与 dsh-purge/ 开头的行，并且要穿透 group", () => {
  const rows = [
    { id: "persona", name: "@deepseek-ai/dsh-persona" },
    {
      id: "group",
      group: true,
      config: [
        { id: "redteam-tools", name: "dsh-purge/redteam/tools" },
        { id: "anchor-gate", name: "./anchor-gate.mjs" },
      ],
    },
    { id: "tool-pwsh", name: "@deepseek-ai/dsh-tool-pwsh" },
  ];
  assert.deepEqual(ownRowIds(rows, bundledPreset).map((row) => row.id), ["redteam-tools", "anchor-gate"]);
  // readCompositionRows 会把 ./x.mjs 解析成 file:// URL；真实形状也要认。
  assert.deepEqual(
    ownRowIds([{ id: "anchor-gate", name: pathToFileURL(path.join(bundledPreset, "anchor-gate.mjs")).href }], bundledPreset).map((row) => row.id),
    ["anchor-gate"],
  );
  assert.deepEqual(ownRowIds([{ id: "outside", name: pathToFileURL(path.join(repoRoot, "README.md")).href }], bundledPreset), []);
  assert.deepEqual(ownRowIds([{ id: "anchor-gate", name: "file:///D:/elsewhere/anchor-gate.mjs" }]), []);
});

test("rowTarget：自研行按预设目录/包内路径解析，宿主行不越权挂载", () => {
  assert.equal(rowTarget({ id: "redteam-tools", name: "dsh-purge/redteam/tools" }, bundledPreset).kind, "local");
  const anchor = rowTarget({ id: "anchor-gate", name: "./anchor-gate.mjs" }, bundledPreset);
  assert.equal(anchor.kind, "local");
  assert.ok(anchor.file.endsWith("anchor-gate.mjs"));
  assert.equal(rowTarget({ id: "anchor-gate", name: "./nope.mjs" }, bundledPreset), null);
  assert.equal(rowTarget({ id: "persona", name: "@deepseek-ai/dsh-persona" }, bundledPreset), null);
});

test("预设入口：自研行在真实宿主上真挂，工具行由宿主 defineTool 编译出工具", async (t) => {
  const install = installOrNull();
  if (!install) {
    t.skip("未安装桌面宿主，跳过");
    return;
  }
  const saved = process.env.DSH_DESKTOP_INSTALL;
  process.env.DSH_DESKTOP_INSTALL = install.installDir;
  try {
    const entry = await probePresetEntry({ hostBase: install.hostBase, presetDir: bundledPreset });
    assert.deepEqual(entry.coverage.own.slice().sort(), ["anchor-gate", "redteam-tools"]);
    assert.deepEqual(entry.coverage.unmountedOwn, [], "自研行必须全部挂上");
    assert.equal(entry.toolsRow.ok, true, entry.toolsRow.error);
    assert.ok(entry.toolsRow.tools.length > 0, "工具行必须真的注册出工具");
    assert.equal(entry.ok, true, entry.error);
  } finally {
    if (saved === undefined) delete process.env.DSH_DESKTOP_INSTALL;
    else process.env.DSH_DESKTOP_INSTALL = saved;
  }
});

test("宿主 author DSL：漏 additionalProperties 的 object 参数会被拒（A8 的失败源头）", async (t) => {
  const install = installOrNull();
  if (!install) {
    t.skip("未安装桌面宿主，跳过");
    return;
  }
  const tools = await import(moduleUrl(install.hostBase, "dsh-tools/lib/index.js"));
  assert.throws(
    () => tools.defineTool({
      name: "probe_unsealed",
      description: "probe",
      parameters: { payload: { type: "object", properties: { a: { type: "string" } } } },
      output: { schema: { type: "string" }, render: (_args, value) => value },
      async execute() { return ""; },
    }),
    /additionalProperties/,
  );
});
