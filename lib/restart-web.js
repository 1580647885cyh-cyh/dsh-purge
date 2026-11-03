import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { envForDetachedSpawn, findDshHome } from "./core.js";
import { removeWebServerRecord, writeWebServerRecord } from "./web-reclaim.js";

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

function killOldServer() {
  const pid = Number(info.pid);
  if (!pid || pid === process.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

function openBrowser(url) {
  if (!url) return;
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

async function waitFree() {
  for (let i = 0; i < 40; i++) {
    if (await portFree()) return true;
    if (i === 8) killOldServer();
    await new Promise((r) => setTimeout(r, 120));
  }
  killOldServer();
  for (let i = 0; i < 40; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

const ok = await waitFree();
if (!ok) process.exit(1);

// 记录 detached server 的身份：下一次 boot 的 preflight 只按这条记录 + 端口监听者核对，
// 不靠“看起来像 dsh web”就杀（#29）。写失败不挡重启。
const dshHome = (() => {
  try { return findDshHome(); } catch { return ""; }
})();
let record = null;
const saveRecord = (patch) => {
  if (!dshHome) return;
  record = { ...(record || {}), ...patch };
  writeWebServerRecord({ dshHome, port, record });
};

// 接着 stdout 里的新地址打开浏览器。旧页面的 token 在新进程里无效，只刷新会打不开。
let opened = false;
const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  cwd: info.cwd || process.cwd(),
  env: envForDetachedSpawn(),
  windowsHide: true,
  shell: false,
});
child.on("error", () => {
  if (dshHome) removeWebServerRecord({ dshHome, port });
  process.exit(1);
});
const wantBrowser = info.openBrowser !== false;
const startedAt = new Date().toISOString();
saveRecord({
  pid: child.pid,
  port,
  host,
  url: "",
  startedAt,
  execPath: info.execPath,
  argv: info.argv,
  openBrowser: wantBrowser,
  state: "starting",
});
const takeUrl = (chunk) => {
  const text = String(chunk || "");
  if (opened) return;
  const match = text.match(/dsh web:\s+(https?:\/\/\S+)/);
  if (!match) return;
  opened = true;
  const url = match[1].replace(/[),.;]+$/, "");
  saveRecord({ url, state: "listening" });
  if (!wantBrowser) return;
  openBrowser(url);
};
child.stdout?.on("data", takeUrl);
child.stderr?.on("data", takeUrl);
child.unref();
if (wantBrowser) {
  const started = Date.now();
  while (!opened && Date.now() - started < 20000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!opened) {
    // 没拿到 URL：记录保留为 unconfirmed（preflight 仍可按 pid/port 回收），但不冒充 listening。
    saveRecord({ state: "unconfirmed" });
    process.exit(1);
  }
} else {
  // 等子进程真正起来再退出，避免端口未监听时父链误判失败又拉一把。
  await new Promise((r) => setTimeout(r, 1500));
  saveRecord({ state: opened ? "listening" : "spawned" });
}
process.exit(0);
