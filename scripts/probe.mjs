#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyProcessEnvironment,
  assertHostsIsolated,
  ensureWorkspace,
  isolatedEnvironment,
  planWorkspace,
  stampNow,
} from "../lib/verify/isolate.js";
import { hostFingerprint } from "../lib/verify/baseline.js";
import { prepareFixtureHost } from "../lib/verify/admin-entry.js";
import { beginLiveHostGuard, checkLiveHostGuard } from "../lib/verify/admin-entry.js";
import { resolveHostInstall } from "../lib/verify/host-entry.js";

/**
 * 隔离探针：node scripts/probe.mjs <probe.mjs> [--no-fixture]
 *
 * 为什么要有这个入口：#6 的复盘发现，ad-hoc 脚本直接 import lib/core.js 调 apply* 时，
 * 宿主发现会回落到真实安装（PATH 还在），把补丁写进了用户正在用的宿主。这里把
 * 隔离环境、宿主预检和真实安装只读核对固定成默认路径，探针只写 D 盘工作区。
 *
 * 探针模块约定：默认导出 async function (context) {}，context 提供
 * { workspace, pluginRoot, core, hosts, aiBase, hostInstall, fixture, env }。
 * core 已在隔离环境之后加载，aiBase 是隔离副本的 @deepseek-ai 根。
 */

const argv = process.argv.slice(2);
const scriptArg = argv.find((arg) => !arg.startsWith("--"));
if (!scriptArg) {
  console.error("用法：node scripts/probe.mjs <probe.mjs> [--no-fixture]");
  process.exit(1);
}
const noFixture = argv.includes("--no-fixture");
const scriptPath = path.resolve(scriptArg);
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const workspace = ensureWorkspace(planWorkspace({ stamp: "probe-" + stampNow() }));
const hostInstall = resolveHostInstall({});
const hostInfo = hostFingerprint(hostInstall.installDir);
const fixture = noFixture
  ? null
  : prepareFixtureHost({
    hostBase: hostInstall.hostBase,
    installDir: workspace.install,
    shellVersion: hostInfo.shellVersion || "0.2.1-rc.5",
    asarPath: path.join(hostInstall.resourcesDir, "app.asar"),
  });
console.error("[probe] 工作区 " + workspace.root + (fixture ? "（副本 " + fixture.source + "）" : "（未建副本）"));

const env = isolatedEnvironment(workspace, { installDir: workspace.install, hostBase: workspace.hostBase });
const restore = applyProcessEnvironment(env);
let exitCode = 0;
try {
  // 必须在切完环境之后再加载 core：宿主发现读的是进程环境。
  const core = await import(pathToFileURL(path.join(pluginRoot, "lib", "core.js")).href);
  const hosts = core.enumeratePatchAiBases({ discover: true });
  assertHostsIsolated(hosts, workspace);
  console.error("[probe] 枚举到的宿主都在工作区内：" + hosts.join(", "));
  const guard = await beginLiveHostGuard(pluginRoot, hostInstall.hostBase, env.DSH_HOME);
  const probe = await import(pathToFileURL(scriptPath).href);
  if (typeof probe.default !== "function") {
    throw new Error("探针模块要默认导出一个 async function(context)：" + scriptPath);
  }
  await probe.default({
    workspace,
    pluginRoot,
    core,
    hosts,
    aiBase: env.DSH_BASE,
    hostInstall,
    hostInfo,
    fixture,
    env,
  });
  const after = await checkLiveHostGuard(guard);
  if (!after.ok) {
    console.error("[probe] ✗ 真实安装的目标文件被改动：" + after.changed.join(", "));
    exitCode = 3;
  } else {
    console.error("[probe] 真实安装目标文件未改动（" + after.checked + " 个）");
  }
} catch (error) {
  console.error("[probe] 失败：" + String(error && error.stack ? error.stack : error));
  exitCode = 1;
} finally {
  restore();
}
process.exitCode = exitCode;
