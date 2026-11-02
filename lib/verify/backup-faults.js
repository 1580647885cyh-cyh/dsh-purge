import fs from "node:fs";
import path from "node:path";
import { firstTargetPath } from "./targets.js";

/**
 * 备份/恢复的故障注入（#7）。
 *
 * 在**独立的小副本**上跑四类代表性案例，全部用与 purge_apply / purge_revert 相同的 core 函数：
 * 1. 完整备份：先记下 apply 前的原文，revert 必须还原到那份字节（不拿 bak 自证）；
 * 2. 官方原文 + 旧 bak：官方新文件可能自带某些补丁的"完成标记"（#2/#3/#50），
 *    bak 仍必须刷新成官方内容；
 * 3. 过期备份不写回：随后 revert 不得把旧版本写回；
 * 4. 不完整备份：0 字节 bak 不能覆盖有效目标，只能报出明确错误。
 *
 * 用小副本（从隔离副本里复制真实的官方文件）而不是整份宿主：故障注入不污染
 * 管理生命周期的现场，入口五看到的 statusBefore 仍然是干净的隔离副本。
 */

/** 小副本的样本：真实官方内容，路径按 targetFiles 的键布局摆放。 */
const SAMPLE_FILES = [
  ["agent-instructions", ["dsh-agent-instructions", "lib", "index.js"]],
  ["preset-standard", ["dsh-web-app", "presets", "standard.patch.yml"]],
];

/**
 * 「新版官方 preset」夹具：满足 #24 的目标态（fetch: true），但没有我们写过的标记。
 * 单测与入口故障注入共用同一份内容，避免两处各写一份。
 */
export function upgradedPresetFixture() {
  return [
    "# Agent preset standard: new host build",
    "- insert:",
    "    - id: preset-standard",
    "      config:",
    "          - id: tool-web",
    "            name: '@deepseek-ai/dsh-tool-web'",
    "            config:",
    "              fetch: true",
    "              searchTimeoutMs: 60000",
  ].join("\n") + "\n";
}

function prepareBackupFixture({ workspace, sourceAiBase } = {}) {
  const root = path.join(workspace.out, "backup-fixture");
  fs.rmSync(root, { recursive: true, force: true });
  const aiBase = path.join(root, "@deepseek-ai");
  const missing = [];
  for (const [key, parts] of SAMPLE_FILES) {
    const from = path.join(sourceAiBase, ...parts);
    const to = path.join(aiBase, ...parts);
    if (!fs.existsSync(from)) {
      missing.push(key);
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return { aiBase, missing };
}

export async function probeBackupFaults({ core, workspace, sourceAiBase } = {}) {
  const record = { kind: "admin.backup-faults", ok: false, cases: [], error: "" };
  const recordCase = (id, ok, detail) => record.cases.push({ id, ok, detail });
  try {
    if (!workspace || !sourceAiBase) {
      record.error = "缺少 workspace / sourceAiBase";
      return record;
    }
    const fixture = prepareBackupFixture({ workspace, sourceAiBase });
    if (fixture.missing.length > 0) {
      record.error = "隔离副本里缺少样本：" + fixture.missing.join(",");
      return record;
    }
    const aiBase = fixture.aiBase;
    const files = () => core.targetFiles(aiBase);
    const target = firstTargetPath(files(), "agent-instructions");
    const preset = firstTargetPath(files(), "preset-standard");
    if (!target || !preset) {
      record.error = "小副本没有解析出 agent-instructions / preset-standard";
      return record;
    }
    const bakSuffix = core.BAK_SUFFIX || ".dshpurge.bak";
    const targetBak = target + bakSuffix;
    const presetBak = preset + bakSuffix;

    // 1) 完整备份：备份之前先记原文，revert 后逐字节比对。
    const originalBefore = fs.readFileSync(target);
    await core.backupAll(aiBase);
    await core.applyPatches(aiBase);
    const afterApply = fs.readFileSync(target);
    await core.revertAll(aiBase);
    const afterRevert = fs.readFileSync(target);
    recordCase("full-backup", !afterApply.equals(originalBefore) && afterRevert.equals(originalBefore),
      "apply 改了内容：" + !afterApply.equals(originalBefore) + "；revert 后与原文一致：" + afterRevert.equals(originalBefore));

    // 2) 官方原文 + 旧 bak：官方文件自带 #2/#3 的"完成标记"，bak 仍必须刷新。
    fs.writeFileSync(target, originalBefore);
    fs.writeFileSync(targetBak, "// old host build\n" + originalBefore.toString("utf8"), "utf8");
    const refreshedOfficial = core.refreshStaleBaksForUpgrade(aiBase);
    const bakOfficial = fs.readFileSync(targetBak);
    recordCase("official-mark-refresh", refreshedOfficial.includes(target) && bakOfficial.equals(originalBefore),
      "含官方标记的文件也刷新了 bak：" + refreshedOfficial.includes(target) + "；bak 与官方原文一致：" + bakOfficial.equals(originalBefore));

    // 3) 过期备份不写回（合成的新版 preset）。
    const upgraded = upgradedPresetFixture();
    // 小副本里的 bak 可能已在上一轮 revert 被消费，这里直接构造「旧版本的备份」。
    fs.writeFileSync(presetBak, "# old host build\n" + fs.readFileSync(preset, "utf8"), "utf8");
    fs.writeFileSync(preset, upgraded, "utf8");
    const refreshed = core.refreshStaleBaksForUpgrade(aiBase);
    const bakAfterRefresh = fs.readFileSync(presetBak);
    recordCase("stale-bak-refresh", bakAfterRefresh.equals(Buffer.from(upgraded, "utf8")),
      "刷新 " + refreshed.length + " 个；bak 与新版官方内容逐字节一致：" + bakAfterRefresh.equals(Buffer.from(upgraded, "utf8")));

    // 4) 过期备份不写回：revert 后目标仍是新版内容。
    await core.revertAll(aiBase);
    const afterStaleRevert = fs.readFileSync(preset);
    recordCase("stale-bak-not-written-back", afterStaleRevert.equals(Buffer.from(upgraded, "utf8")),
      "revert 后目标与新版官方内容逐字节一致：" + afterStaleRevert.equals(Buffer.from(upgraded, "utf8")));

    // 5) 不完整备份：目标有效、bak 是 0 字节占位符。
    await core.applyPatches(aiBase);
    const before = fs.readFileSync(target);
    fs.writeFileSync(targetBak, "", "utf8");
    const result = await core.revertAll(aiBase);
    const after = fs.readFileSync(target);
    const reported = result.errors.some(([fp, code]) => fp === target && code === "backup_empty");
    recordCase("empty-backup", after.equals(before) && reported, "目标字节未变：" + after.equals(before) + "；backup_empty 已报：" + reported);

    record.ok = record.cases.every((item) => item.ok);
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
}
