import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { isAsarSealedPath } from "./desktop.js";
import { fsFor } from "./extract-asar.js";
import { looksLikeSourceCliRoot, resolveDshBinRoot } from "./hide-console.js";

/**
 * A6-1 / #29：web 启动前回收孤儿 server。
 *
 * 两半：
 * 1. helper（restart-web.js）把 detached server 的 pid / port / url / startedAt / execPath / argv
 *    写到 <DSH_HOME>/dsh-purge/web-server-<port>.json；
 * 2. 宿主 bin.js 顶部 import 一个自包含 sidecar；它在 profile boot / webserver 绑端口之前
 *    读记录、按「记录 pid → 端口监听者 → 命令行」核对并回收，绝不在 PID 复用/陌生端口上误杀。
 *
 * 记录只落在 <DSH_HOME>/dsh-purge；sidecar 与 bin.js 的 import 复用 hide-console 的注入/还原约定。
 */

const SIDECAR = "dsh-purge-web-reclaim";
const IMPORT_LINE = `import "./${SIDECAR}.js"; // [dsh-purge] web reclaim preflight`;
const MARKER = "[dsh-purge] web reclaim preflight";

export function webServerRecordPath({ dshHome, port } = {}) {
  return path.join(String(dshHome || ""), "dsh-purge", `web-server-${Number(port) || 3080}.json`);
}

export function writeWebServerRecord({ dshHome, port, record } = {}) {
  if (!dshHome || !record || typeof record !== "object") return false;
  const file = webServerRecordPath({ dshHome, port });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function readWebServerRecord({ dshHome, port } = {}) {
  if (!dshHome) return null;
  try {
    const value = JSON.parse(fs.readFileSync(webServerRecordPath({ dshHome, port }), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function removeWebServerRecord({ dshHome, port } = {}) {
  if (!dshHome) return false;
  try {
    fs.rmSync(webServerRecordPath({ dshHome, port }), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 纯决策：输入记录、监听者、命令行、记录 pid 是否活着；输出动作。 */
export function decideWebReclaim({ record, pidAlive = false, listenerPid = 0, listenerCmd = "" } = {}) {
  const isDshWeb = (cmd) => {
    const text = String(cmd || "");
    if (!text) return false;
    if (!/\bweb\b/i.test(text)) return false;
    // 必须像真正的 dsh 启动器（bin.js 或 dsh.cmd/dsh.exe），不能把临时路径里的 "dsh" 当证据。
    return /(?:@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js|[\\/]dsh(?:\.cmd|\.exe)?(?:[\s"']|$))/i.test(text);
  };
  const recorded = record && Number(record.pid) ? Number(record.pid) : 0;
  const listener = Number(listenerPid) || 0;
  if (recorded && pidAlive) {
    if (listener && listener === recorded) {
      if (listenerCmd && !isDshWeb(listenerCmd)) {
        return { action: "drop-record", reason: "record pid is alive and listening, but its command line is not dsh web" };
      }
      return { action: "kill-record", reason: "record pid holds the recorded port" };
    }
    if (listener && listener !== recorded) {
      return isDshWeb(listenerCmd)
        ? { action: "kill-listener", reason: "record pid was reused; the port listener is dsh web" }
        : { action: "drop-record", reason: "record pid was reused; the port listener is not dsh web" };
    }
    return { action: "drop-record", reason: "record pid is alive but not listening on the recorded port" };
  }
  if (recorded && !pidAlive) {
    return listener && isDshWeb(listenerCmd)
      ? { action: "kill-listener", reason: "record pid is gone; the port listener is dsh web" }
      : { action: "drop-record", reason: "record pid is gone and no dsh web listener holds the port" };
  }
  if (listener) {
    return isDshWeb(listenerCmd)
      ? { action: "kill-listener", reason: "no record; the port listener is dsh web" }
      : { action: "leave", reason: "no record; a stranger holds the port" };
  }
  return { action: "leave", reason: "nothing to reclaim" };
}

/** 杀失败保留记录，下一次 boot 再试；杀成功才删记录。 */
export function recordDispositionAfterKill({ killed = false } = {}) {
  return { remove: Boolean(killed) };
}

function parsePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port" && argv[i + 1]) return Number(argv[i + 1]) || 0;
    if (argv[i].startsWith("--port=")) return Number(argv[i].slice(7)) || 0;
  }
  return 0;
}

function isWebInvocation(argv) {
  if (argv.includes("web")) return true;
  const i = argv.indexOf("--profile");
  return i >= 0 && argv[i + 1] === "web";
}

/**
 * 宿主 bin.js 顶部 import 的自包含 preflight。它故意不 import 插件：
 * 只依赖 node 内置 + 记录文件；顶层 await 让 bin.js 的后续 import/body 等它跑完。
 */
export function webReclaimEntrySource() {
  return `// ${MARKER} — auto-installed by dsh-purge; do not edit
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const decideWebReclaim = ${decideWebReclaim.toString()};
const recordDispositionAfterKill = ${recordDispositionAfterKill.toString()};

const START = Date.now();
const BUDGET = 5000;
const DEFAULT_PORT = 3080;

function left() {
  return Math.max(0, BUDGET - (Date.now() - START));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port" && argv[i + 1]) return Number(argv[i + 1]) || 0;
    if (argv[i].startsWith("--port=")) return Number(argv[i].slice(7)) || 0;
  }
  return 0;
}

function isWebInvocation(argv) {
  if (argv.includes("web")) return true;
  const i = argv.indexOf("--profile");
  return i >= 0 && argv[i + 1] === "web";
}

async function candidateHomes() {
  const out = [];
  const push = (value) => {
    if (!value) return;
    const normalized = path.normalize(String(value));
    if (!out.includes(normalized)) out.push(normalized);
  };
  push(process.env.DSH_HOME);
  try {
    const mod = await import("@deepseek-ai/dsh-home-paths");
    if (mod && typeof mod.resolveDshHome === "function") {
      const value = mod.resolveDshHome();
      push(typeof value === "string" ? value : value && value.path);
    }
  } catch {
    // host package unavailable; DSH_HOME / ~/.dsh below
  }
  push(path.join(os.homedir(), ".dsh"));
  return out;
}

function readRecord(home, port) {
  const file = path.join(home, "dsh-purge", "web-server-" + port + ".json");
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? { file, value } : null;
  } catch {
    return null;
  }
}

function removeRecord(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 下一次 boot 再试
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n || n === process.pid) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function listenerPid(port) {
  if (left() <= 0) return 0;
  if (process.platform === "win32") {
    const r = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.max(200, Math.min(1200, left())),
    });
    for (const line of String(r.stdout || "").split(/\\r?\\n/)) {
      const parts = line.trim().split(/\\s+/);
      if (parts.length < 5 || parts[3] !== "LISTENING") continue;
      if (!parts[1].endsWith(":" + port)) continue;
      const pid = Number(parts[4]);
      if (pid) return pid;
    }
    return 0;
  }
  const lsof = spawnSync("lsof", ["-nP", "-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: Math.max(200, Math.min(1200, left())),
  });
  const hit = Number(String(lsof.stdout || "").trim().split(/\\r?\\n/)[0]);
  if (hit) return hit;
  const ss = spawnSync("ss", ["-ltnp"], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: Math.max(200, Math.min(1200, left())),
  });
  for (const line of String(ss.stdout || "").split(/\\r?\\n/)) {
    if (!line.includes(":" + port)) continue;
    const m = line.match(/pid=(\\d+)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

function cmdline(pid) {
  if (!pid || left() <= 0) return "";
  if (process.platform === "win32") {
    const script = '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine';
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      cwd: os.tmpdir(),
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.max(200, Math.min(1500, left())),
    });
    const text = String(r.stdout || "").trim();
    if (text) return text;
    return "";
  }
  const r = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: Math.max(200, Math.min(1200, left())),
  });
  return String(r.stdout || "").trim();
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function killAndWait(pid, port) {
  if (!pid || left() <= 0) return false;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      cwd: os.tmpdir(),
      stdio: "ignore",
      windowsHide: true,
      timeout: Math.max(500, Math.min(1500, left())),
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    for (let i = 0; i < 10 && pidAlive(pid) && left() > 0; i += 1) await sleep(100);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  for (let i = 0; i < 25 && left() > 0; i += 1) {
    if (!pidAlive(pid) && !(await portOpen(port))) return true;
    await sleep(100);
  }
  return !pidAlive(pid) && !(await portOpen(port));
}

async function main() {
  const argv = process.argv.slice(2);
  if (!isWebInvocation(argv) || argv.includes("--help") || argv.includes("-h")) return;
  const port = parsePort(argv) || DEFAULT_PORT;
  const homes = await candidateHomes();
  let found = null;
  for (const home of homes) {
    found = readRecord(home, port);
    if (found) break;
  }
  const record = found ? found.value : null;
  const recordFile = found ? found.file : "";
  const listener = listenerPid(port);
  const alive = record ? pidAlive(Number(record.pid)) : false;
  const cmd = listener ? cmdline(listener) : "";
  const decision = decideWebReclaim({ record, pidAlive: alive, listenerPid: listener, listenerCmd: cmd });
  if (decision.action === "kill-record" || decision.action === "kill-listener") {
    const target = decision.action === "kill-record" ? Number(record.pid) : listener;
    const killed = await killAndWait(target, port);
    const disposition = recordDispositionAfterKill({ killed });
    if (disposition.remove && recordFile) removeRecord(recordFile);
    return;
  }
  if (decision.action === "drop-record" && recordFile) removeRecord(recordFile);
}

try {
  await main();
} catch {
  // 绝不阻断 boot
}
`;
}

/** 把 sidecar + bin.js 顶部 import 写进宿主；与 hide-console 同一套 sidecar 约定。 */
export function installWebReclaimIntoBin(aiBase, { fs: customFs, path: nodePath } = {}) {
  const p = nodePath ?? createRequire(import.meta.url)("node:path");
  const root = resolveDshBinRoot(aiBase, { fs: customFs, path: p });
  if (!root) return "missing_bin";
  if (looksLikeSourceCliRoot(root, { fs: customFs, path: p })) return "skipped_source_cli";
  const nodeFs = customFs ?? fsFor(root);
  const binJs = p.join(root, "lib", "bin.js");
  const side = p.join(root, "lib", `${SIDECAR}.js`);
  if (isAsarSealedPath(root) || isAsarSealedPath(binJs)) return "sealed_asar";
  try {
    nodeFs.writeFileSync(side, webReclaimEntrySource(), "utf8");
    let text = nodeFs.readFileSync(binJs, "utf8");
    if (text.includes(SIDECAR) && text.includes(IMPORT_LINE.split(" //")[0])) return "already_injected";
    text = text.replace(/^import "\.\/dsh-purge-web-reclaim\.js";.*\r?\n/m, "");
    if (/^#!/.test(text)) {
      const nl = text.indexOf("\n");
      text = nl >= 0
        ? text.slice(0, nl + 1) + IMPORT_LINE + "\n" + text.slice(nl + 1)
        : text + "\n" + IMPORT_LINE + "\n";
    } else {
      text = IMPORT_LINE + "\n" + text;
    }
    nodeFs.writeFileSync(binJs, text, "utf8");
    return "injected";
  } catch (error) {
    return "error:" + String(error && error.message ? error.message : error);
  }
}

export function revertWebReclaimFromBin(aiBase, { fs: customFs, path: nodePath } = {}) {
  const p = nodePath ?? createRequire(import.meta.url)("node:path");
  const root = resolveDshBinRoot(aiBase, { fs: customFs, path: p });
  if (!root) return "missing_bin";
  const nodeFs = customFs ?? fsFor(root);
  const binJs = p.join(root, "lib", "bin.js");
  const side = p.join(root, "lib", `${SIDECAR}.js`);
  const sourceCli = looksLikeSourceCliRoot(root, { fs: customFs, path: p });
  let changed = false;
  try {
    if (!sourceCli && nodeFs.existsSync(binJs)) {
      const text = nodeFs.readFileSync(binJs, "utf8");
      const next = text.replace(/^import "\.\/dsh-purge-web-reclaim\.js";.*\r?\n/gm, "");
      if (next !== text) {
        nodeFs.writeFileSync(binJs, next, "utf8");
        changed = true;
      }
    }
  } catch (error) {
    return "error:" + String(error && error.message ? error.message : error);
  }
  try {
    if (nodeFs.existsSync(side)) {
      nodeFs.unlinkSync(side);
      changed = true;
    }
  } catch {
    // 重启后再删
  }
  return changed ? "reverted" : "absent";
}
