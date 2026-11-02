#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runVerification } from "../lib/verify/run.js";
import { collectAcceptance, writeAcceptance } from "../lib/verify/acceptance.js";
import { hostFingerprint } from "../lib/verify/baseline.js";
import { resolveHostInstall } from "../lib/verify/host-entry.js";
import { stampNow } from "../lib/verify/isolate.js";
import { assertRemoteUpdatesAllowed, localLockedUpdateStatus } from "../lib/local-version-lock.js";

/**
 * 验收入口（#8）：跑一遍隔离验证，再把结果收敛成兼容修订记录。
 *
 * 用法：node scripts/acceptance.mjs [--out DIR] [--name BASE] [--stamp ID]
 * 默认记录写到 D:\dsh\tmp\dsh-purge-acceptance\<stamp>\；给 --out 时写到指定目录
 * （用于把一份稳定记录放进仓库）。记录只含结构性事实，不含提示词正文、凭据或会话内容。
 * 退出码：0 通过；2 未通过。
 */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    i += 1;
    out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = args.stamp || "acceptance-" + stampNow();

const result = await runVerification({
  root,
  stamp,
  logger: (stage, detail) => console.error("[" + stage + "] " + detail),
});

// 本地锁的实际行为：远程更新必须被拒绝，状态必须是 pinned。
let assertError = "";
try {
  assertRemoteUpdatesAllowed();
} catch (error) {
  assertError = (error && error.code) || String(error && error.message ? error.message : error);
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const hostInstall = resolveHostInstall({});
const hostInfo = hostFingerprint(hostInstall.installDir);
const report = result.report;
// 手动编辑能力的实际证据：插件入口文件当前可写（不是只看 editable 字段）。
let writable = true;
try {
  fs.accessSync(path.join(root, "lib", "index.js"), fs.constants.W_OK);
} catch {
  writable = false;
}

const record = collectAcceptance({
  report,
  lock: { assertError, status: localLockedUpdateStatus(pkg.version), writable },
  plugin: {
    version: pkg.version,
    localVersionLock: (pkg.dsh && pkg.dsh.localVersionLock) || null,
    dshTarget: pkg.dshTarget || "",
  },
  host: {
    shellVersion: hostInfo.shellVersion,
    runtimeVersion: hostInfo.runtimeVersion,
    buildCommit: hostInfo.buildCommit,
    asar: hostInfo.appAsar,
  },
  baseline: {
    file: result.sealed ? result.sealed.file : "",
    treeHash: report.baseline ? report.baseline.treeHash : "",
    fileCount: report.baseline ? report.baseline.fileCount : 0,
  },
  // 记录实际执行过的命令与封存下来的环境指纹，不写死常量。
  commands: [...(report.commands || []), [process.execPath, ...process.argv.slice(1)].map((item) => (item.includes(" ") ? JSON.stringify(item) : item)).join(" ")],
  environment: (report.baseline && report.baseline.environment) || {},
  dependencies: pkg.dependencies || {},
});

const outDir = args.out ? path.resolve(args.out) : path.join("D:\\dsh\\tmp\\dsh-purge-acceptance", stamp);
const files = writeAcceptance({ outDir, record });
let mdFile = files.md;
let jsonFile = files.json;
if (args.name) {
  const base = String(args.name).replace(/\.md$/, "");
  mdFile = path.join(outDir, base + ".md");
  jsonFile = path.join(outDir, base + ".json");
  fs.renameSync(files.md, mdFile);
  fs.renameSync(files.json, jsonFile);
}

console.log("dsh-purge 兼容修订验收：" + (record.ok ? "通过" : "未通过"));
console.log("  插件 " + record.plugin.version + "（本地锁 " + JSON.stringify(record.plugin.localVersionLock) + "）");
console.log("  宿主 " + record.host.shellVersion + " / runtime " + record.host.runtimeVersion + " / build " + String(record.host.buildCommit || "").slice(0, 12));
console.log("  入口 " + record.entries.filter((entry) => entry.ok).length + "/" + record.entries.length + " 通过 · 不适用 " + record.notApplicable.length + " 项");
console.log("  记录 " + mdFile);
process.exitCode = record.ok ? 0 : 2;
