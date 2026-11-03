import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openSlot } from "../../lib/table-read.js";

/**
 * 1.1.71 原版与能力面的守卫（2026-11-03 建）。
 *
 * 三件事，全都只读：
 * 1. 原版备份目录（仓库外）没有被任何人动过 —— 对着 docs/original-1.1.71.sha256.json 逐个比对。
 * 2. 当前树没有丢掉原版的任何文件 —— 原版有的路径，当前必须都还在。
 * 3. 能力面只增不减 —— 工具、预设行、技能清单是原版的超集；内嵌提示词与记录的哈希逐字节一致。
 *
 * 备份目录只在本机存在（D:\dsh\backups\…），换机器时第 1 条自动 skip；
 * 第 2、3 条只依赖仓库里的指纹文件，任何机器都跑。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(path.join(repoRoot, "docs", "original-1.1.71.sha256.json"), "utf8"));
const capability = JSON.parse(readFileSync(path.join(repoRoot, "docs", "original-1.1.71.capability.json"), "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(root, full, out);
    else out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
}

test("原版备份：108 个文件逐个哈希一致（本机没有备份则跳过）", (t) => {
  if (!existsSync(manifest.root)) {
    t.skip("本机没有原版备份目录：" + manifest.root);
    return;
  }
  const actual = walk(manifest.root);
  assert.equal(actual.length, manifest.fileCount, "原版文件数变了");
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const full = path.join(manifest.root, ...rel.split("/"));
    assert.ok(existsSync(full), "原版少了文件：" + rel);
    assert.equal(sha256(readFileSync(full)), hash, "原版文件被改过：" + rel);
  }
});

test("当前树没有丢掉原版的任何文件", () => {
  const missing = Object.keys(manifest.files).filter((rel) => !existsSync(path.join(repoRoot, ...rel.split("/"))));
  assert.deepEqual(missing, [], "这些原版文件在当前的仓库里不见了：" + missing.join(", "));
});

test("能力面只增不减：红队工具、预设行、技能清单都是原版的超集", () => {
  const toolsSrc = readFileSync(path.join(repoRoot, "lib", "redteam", "tools.js"), "utf8");
  const current = new Set([...toolsSrc.matchAll(/name:\s*['"](redteam_[a-z0-9_]+)['"]/g)].map((m) => m[1]));
  const missingTools = capability.tools.filter((name) => !current.has(name));
  assert.deepEqual(missingTools, [], "红队工具少了：" + missingTools.join(", "));

  const presetSrc = readFileSync(path.join(repoRoot, "presets", "redteam", "agent.cordis.yml"), "utf8");
  const rows = new Set([...presetSrc.matchAll(/name:\s*['"]?(@deepseek-ai\/[\w-]+|dsh-purge[\w/-]*|@linxin666\/[\w-]+)/g)].map((m) => m[1]));
  const missingRows = capability.presetRows.filter((name) => !rows.has(name));
  assert.deepEqual(missingRows, [], "预设插件行少了：" + missingRows.join(", "));

  const missingSkills = capability.skills.filter((rel) => !existsSync(path.join(repoRoot, ...rel.split("/"))));
  assert.deepEqual(missingSkills, [], "技能文件少了：" + missingSkills.join(", "));
});

test("内嵌提示词：与记录的哈希逐字节一致（改一个字就红）", () => {
  const text = openSlot();
  assert.ok(text.length > 0, "内嵌提示词解不开（asset-table 的 SLOT/MASK/TAG/IV 或 table-key 的配方被改过）");
  assert.equal(text.length, capability.embeddedPrompt.chars, "内嵌提示词长度变了");
  assert.equal(sha256(text), capability.embeddedPrompt.currentSha256,
    "内嵌提示词内容变了：能力面禁止改动。若这次是用户本人的改名，请同步更新 docs/original-1.1.71.capability.json 的 currentSha256 与差异说明。");
});
