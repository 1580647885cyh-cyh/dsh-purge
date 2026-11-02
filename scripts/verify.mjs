#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseVerifyArgs } from "../lib/verify/cli-args.js";
import { describeRetention } from "../lib/verify/report.js";
import { runVerification } from "../lib/verify/run.js";

/**
 * 隔离验证入口：node scripts/verify.mjs [--root DIR] [--install DIR] [--out-root DIR]
 *   [--baseline-dir DIR] [--stamp ID] [--keep N] [--no-prune] [--no-seal] [--json]
 * 退出码：0 通过；2 未通过（已知故障只记录，不影响退出码）。
 */

const args = parseVerifyArgs(process.argv.slice(2), {
  defaultRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
});
const result = await runVerification({
  root: args.root,
  outRoot: args.outRoot,
  baselineDir: args.baselineDir,
  installDir: args.installDir,
  stamp: args.stamp,
  seal: args.seal !== false,
  prune: args.prune !== false,
  retentionKeep: args.retentionKeep,
  logger: (stage, detail) => console.error("[" + stage + "] " + detail),
});

if (args.json) {
  console.log(JSON.stringify(result.report, null, 2));
} else {
  const report = result.report;
  console.log("dsh-purge 隔离验证：" + (report.ok ? "通过" : "未通过"));
  if (report.baseline) {
    console.log("  基线 " + report.baseline.treeHash.slice(0, 16) + " · " + report.baseline.fileCount + " 文件 · 插件 " + (report.baseline.plugin ? report.baseline.plugin.version : "?") + " · 宿主 " + (report.baseline.host ? report.baseline.host.shellVersion : "?"));
    if (report.baseline.drift) console.log("  与上次基线：" + (report.baseline.drift.ok ? "一致" : "有差异"));
  }
  if (report.retention) console.log("  工作区清理：" + describeRetention(report.retention));
  if (report.fixture) {
    console.log("  fixture：" + report.fixture.source
      + (report.fixture.cacheKey ? "（缓存" + (report.fixture.cacheHit ? "命中" : "重建") + " " + report.fixture.cacheKey + "）" : "")
      + " · " + report.fixture.durationMs + " ms · " + report.fixture.packages + " 个包");
  }
  if (report.hostEntry) {
    console.log("  宿主入口：" + (report.hostEntry.ok ? "ok" : "failed") + " · 提示词 " + (report.hostEntry.prompt ? report.hostEntry.prompt.length : 0) + " 字符 · 工具 " + (report.hostEntry.tools || []).map((tool) => tool.name).join(","));
  }
  if (report.admin) {
    console.log("  管理入口：" + (report.admin.ok ? "ok" : "failed") + " · apply 差异 " + (report.admin.diffs.apply ? report.admin.diffs.apply.changed + " 个文件" : "n/a") + " · revert 还原 " + (report.admin.revertRestored ? "是" : "否"));
  }
  if (report.knownFailures.length > 0) {
    console.log("  已知故障：" + report.knownFailures.length);
    for (const failure of report.knownFailures) console.log("    - " + failure.id + "：" + failure.summary);
  }
  console.log("  报告：" + result.files.mdFile);
}
process.exitCode = result.report.ok ? 0 : 2;
