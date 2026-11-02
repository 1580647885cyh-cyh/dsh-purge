#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVerification } from "../lib/verify/run.js";

/**
 * 隔离验证入口：node scripts/verify.mjs [--root DIR] [--install DIR] [--stamp ID] [--json]
 * 退出码：0 通过；2 未通过（已知故障只记录，不影响退出码）。
 */

function parseArgs(argv) {
  const out = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { out.json = true; continue; }
    if (arg === "--no-seal") { out.seal = false; continue; }
    if (!arg.startsWith("--")) continue;
    const inline = arg.includes("=") ? arg.slice(2).split("=") : null;
    const key = inline ? inline[0] : arg.slice(2);
    const value = inline ? inline.slice(1).join("=") : argv[i + 1];
    if (!value || (!inline && value.startsWith("--"))) continue;
    if (!inline) i += 1;
    if (key === "root") out.root = path.resolve(value);
    else if (key === "install") out.installDir = path.resolve(value);
    else if (key === "out-root") out.outRoot = path.resolve(value);
    else if (key === "baseline-dir") out.baselineDir = path.resolve(value);
    else if (key === "stamp") out.stamp = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const result = await runVerification({
  root: args.root,
  outRoot: args.outRoot,
  baselineDir: args.baselineDir,
  installDir: args.installDir,
  stamp: args.stamp,
  seal: args.seal !== false,
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