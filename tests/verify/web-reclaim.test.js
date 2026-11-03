import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  decideWebReclaim,
  installWebReclaimIntoBin,
  readWebServerRecord,
  recordDispositionAfterKill,
  removeWebServerRecord,
  revertWebReclaimFromBin,
  webReclaimEntrySource,
  webServerRecordPath,
  writeWebServerRecord,
} from "../../lib/web-reclaim.js";
import { tempDir } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const node = process.execPath;

function systemPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return [
    path.join(root, "System32"),
    root,
    path.join(root, "System32", "Wbem"),
    path.join(root, "System32", "WindowsPowerShell", "v1.0"),
  ].join(path.delimiter);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
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

async function waitFor(fn, timeoutMs = 10000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(step);
  }
  return false;
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

function fakeDshServer(root, port, { dsh = true } = {}) {
  const dir = dsh
    ? path.join(root, "node_modules", "@deepseek-ai", "dsh", "lib")
    : path.join(root, "stranger");
  const file = path.join(dir, dsh ? "bin.js" : "server.mjs");
  write(file, [
    'import http from "node:http";',
    'const at = process.argv.indexOf("--port");',
    "const port = Number(at >= 0 ? process.argv[at + 1] : process.argv[2]);",
    'const server = http.createServer((req, res) => res.end("ok"));',
    'server.listen(port, "127.0.0.1");',
    "",
  ].join("\n"));
  const args = dsh ? [file, "web", "--port", String(port)] : [file, String(port)];
  const child = spawn(node, args, {
    cwd: root,
    detached: false,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, PATH: systemPath() },
  });
  return child;
}

function sidecarFile(root) {
  const file = path.join(root, "web-reclaim-sidecar.mjs");
  fs.writeFileSync(file, webReclaimEntrySource(), "utf8");
  return file;
}

function runSidecar(root, home, port, { pathOverride = "" } = {}) {
  const file = sidecarFile(root);
  const child = spawn(node, [file, "web", "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, DSH_HOME: home, PATH: pathOverride || systemPath() },
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      killTree(child.pid);
      resolve({ code: null, out, err, timeout: true });
    }, 15000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timeout: false });
    });
  });
}

test("决策矩阵：记录 pid、监听者、命令行与 PID 复用", () => {
  const dshCmd = '"C:\\node.exe" "C:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --port 3080';
  assert.equal(decideWebReclaim({ record: { pid: 10 }, pidAlive: true, listenerPid: 10, listenerCmd: dshCmd }).action, "kill-record");
  assert.equal(decideWebReclaim({ record: { pid: 10 }, pidAlive: true, listenerPid: 10, listenerCmd: "" }).action, "kill-record");
  assert.equal(decideWebReclaim({ record: { pid: 10 }, pidAlive: true, listenerPid: 10, listenerCmd: "C:\\other.exe" }).action, "drop-record");
  assert.equal(decideWebReclaim({ record: { pid: 10 }, pidAlive: true, listenerPid: 20, listenerCmd: dshCmd }).action, "kill-listener");
  assert.equal(decideWebReclaim({ record: { pid: 10 }, pidAlive: true, listenerPid: 20, listenerCmd: "C:\\other.exe" }).action, "drop-record");
  assert.equal(decideWebReclaim({ record: { pid: 10 }, pidAlive: true, listenerPid: 0, listenerCmd: "" }).action, "drop-record");
  assert.equal(decideWebReclaim({ record: { pid: 10 }, pidAlive: false, listenerPid: 20, listenerCmd: dshCmd }).action, "kill-listener");
  assert.equal(decideWebReclaim({ record: { pid: 10 }, pidAlive: false, listenerPid: 20, listenerCmd: "C:\\other.exe" }).action, "drop-record");
  assert.equal(decideWebReclaim({ record: null, pidAlive: false, listenerPid: 20, listenerCmd: dshCmd }).action, "kill-listener");
  assert.equal(decideWebReclaim({ record: null, pidAlive: false, listenerPid: 20, listenerCmd: "C:\\other.exe" }).action, "leave");
  assert.equal(decideWebReclaim({ record: null, pidAlive: false, listenerPid: 0, listenerCmd: "" }).action, "leave");
  assert.deepEqual(recordDispositionAfterKill({ killed: true }), { remove: true });
  assert.deepEqual(recordDispositionAfterKill({ killed: false }), { remove: false });
});

test("记录文件：路径、读写、删除与坏 JSON", () => {
  const root = tempDir("web-record-");
  try {
    const home = path.join(root, "home");
    const file = webServerRecordPath({ dshHome: home, port: 41234 });
    assert.equal(file, path.join(home, "dsh-purge", "web-server-41234.json"));
    const record = { pid: 123, port: 41234, host: "127.0.0.1", url: "http://127.0.0.1:41234/?token=x", startedAt: "2026-11-03T00:00:00.000Z", execPath: "node", argv: ["bin.js", "web"], state: "listening" };
    writeWebServerRecord({ dshHome: home, port: 41234, record });
    assert.deepEqual(readWebServerRecord({ dshHome: home, port: 41234 }), record);
    fs.writeFileSync(file, "{bad json", "utf8");
    assert.equal(readWebServerRecord({ dshHome: home, port: 41234 }), null);
    removeWebServerRecord({ dshHome: home, port: 41234 });
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("注入/还原：sidecar + bin.js 顶部 import，幂等；源码 cli 跳过", () => {
  const root = tempDir("web-inject-");
  try {
    const bin = path.join(root, "lib", "bin.js");
    write(bin, "#!/usr/bin/env node\nimport { Command } from \"commander\";\nconsole.log(\"boot\");\n");
    assert.equal(installWebReclaimIntoBin(root), "injected");
    const sidecar = path.join(root, "lib", "dsh-purge-web-reclaim.js");
    assert.equal(fs.existsSync(sidecar), true);
    const first = fs.readFileSync(bin, "utf8");
    assert.match(first, /^#!\/usr\/bin\/env node\nimport "\.\/dsh-purge-web-reclaim\.js"; \/\/ \[dsh-purge\] web reclaim preflight\n/);
    assert.equal((first.match(/dsh-purge-web-reclaim/g) || []).length, 1);
    assert.equal(installWebReclaimIntoBin(root), "already_injected");
    assert.equal(fs.readFileSync(bin, "utf8"), first);
    assert.equal(revertWebReclaimFromBin(root), "reverted");
    assert.equal(fs.existsSync(sidecar), false);
    assert.equal(fs.readFileSync(bin, "utf8").includes("dsh-purge-web-reclaim"), false);
    assert.equal(revertWebReclaimFromBin(root), "absent");

    const sourceRoot = path.join(root, "apps", "cli");
    write(path.join(sourceRoot, "lib", "bin.js"), "#!/usr/bin/env node\n");
    assert.equal(installWebReclaimIntoBin(sourceRoot), "skipped_source_cli");
    assert.equal(fs.existsSync(path.join(sourceRoot, "lib", "dsh-purge-web-reclaim.js")), false);
    assert.equal(revertWebReclaimFromBin(sourceRoot), "absent");
    assert.equal(fs.readFileSync(path.join(sourceRoot, "lib", "bin.js"), "utf8"), "#!/usr/bin/env node\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("端到端：记录里的 dsh web 监听者被回收，记录删除", async () => {
  const root = tempDir("web-e2e-");
  let child = null;
  try {
    const home = path.join(root, "home");
    const port = await freePort();
    child = fakeDshServer(root, port);
    assert.equal(await waitFor(() => portOpen(port)), true, "fake dsh web 没有监听");
    writeWebServerRecord({
      dshHome: home,
      port,
      record: { pid: child.pid, port, host: "127.0.0.1", url: "", startedAt: new Date().toISOString(), execPath: node, argv: ["bin.js", "web", "--port", String(port)], state: "spawned" },
    });
    const result = await runSidecar(root, home, port);
    assert.equal(result.timeout, false, "sidecar 超时");
    assert.equal(result.code, 0, result.err);
    assert.equal(pidAlive(child.pid), false, "旧 server 没有被回收");
    assert.equal(await portOpen(port), false, "端口没有释放");
    assert.equal(readWebServerRecord({ dshHome: home, port }), null, "记录没有删除");
  } finally {
    if (child) killTree(child.pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("PID 复用：记录 pid 活着但没在监听该端口，不杀", async () => {
  const root = tempDir("web-pid-reuse-");
  let child = null;
  try {
    const home = path.join(root, "home");
    const port = await freePort();
    child = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    assert.equal(await waitFor(() => pidAlive(child.pid)), true);
    writeWebServerRecord({
      dshHome: home,
      port,
      record: { pid: child.pid, port, host: "127.0.0.1", url: "", startedAt: new Date().toISOString(), execPath: node, argv: [], state: "spawned" },
    });
    const result = await runSidecar(root, home, port);
    assert.equal(result.code, 0, result.err);
    assert.equal(pidAlive(child.pid), true, "PID 复用被误杀");
    assert.equal(readWebServerRecord({ dshHome: home, port }), null, "stale 记录没有清掉");
  } finally {
    if (child) killTree(child.pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("陌生端口：没有记录且监听者不是 dsh web，不动它", async () => {
  const root = tempDir("web-stranger-");
  let child = null;
  try {
    const home = path.join(root, "home");
    const port = await freePort();
    child = fakeDshServer(root, port, { dsh: false });
    assert.equal(await waitFor(() => portOpen(port)), true, "陌生 server 没有监听");
    const result = await runSidecar(root, home, port);
    assert.equal(result.code, 0, result.err);
    assert.equal(pidAlive(child.pid), true, "陌生进程被误杀");
    assert.equal(await portOpen(port), true, "陌生端口被误关");
  } finally {
    if (child) killTree(child.pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("只回收本次端口：另一个端口的记录 server 不受影响", async () => {
  const root = tempDir("web-other-port-");
  let a = null;
  let b = null;
  try {
    const home = path.join(root, "home");
    const portA = await freePort();
    const portB = await freePort();
    a = fakeDshServer(path.join(root, "a"), portA);
    b = fakeDshServer(path.join(root, "b"), portB);
    assert.equal(await waitFor(() => portOpen(portA) && portOpen(portB)), true);
    for (const [port, pid] of [[portA, a.pid], [portB, b.pid]]) {
      writeWebServerRecord({ dshHome: home, port, record: { pid, port, host: "127.0.0.1", url: "", startedAt: new Date().toISOString(), execPath: node, argv: [], state: "spawned" } });
    }
    const result = await runSidecar(root, home, portA);
    assert.equal(result.code, 0, result.err);
    assert.equal(pidAlive(a.pid), false, "本次端口旧 server 没被回收");
    assert.equal(pidAlive(b.pid), true, "别的端口 server 被误杀");
    assert.notEqual(readWebServerRecord({ dshHome: home, port: portB }), null, "别的端口记录被误删");
  } finally {
    if (a) killTree(a.pid);
    if (b) killTree(b.pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("helper：openBrowser=false 时写 pid/port/state，不冒充 listening", async () => {
  const root = tempDir("web-helper-");
  let server = null;
  try {
    const home = path.join(root, "home");
    const port = await freePort();
    const serverFile = path.join(root, "server.mjs");
    write(serverFile, [
      'import http from "node:http";',
      "const port = Number(process.argv[2]);",
      'http.createServer((req, res) => res.end("ok")).listen(port, "127.0.0.1");',
      "",
    ].join("\n"));
    const payload = {
      kind: "web",
      execPath: node,
      argv: [serverFile, String(port)],
      cwd: root,
      host: "127.0.0.1",
      port,
      pid: 0,
      openBrowser: false,
    };
    server = spawn(node, [path.join(repoRoot, "lib", "restart-web.js")], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, DSH_HOME: home, DSH_PURGE_RESTART: JSON.stringify(payload), PATH: systemPath() },
    });
    let err = "";
    server.stderr.on("data", (chunk) => { err += chunk; });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { killTree(server.pid); resolve(null); }, 10000);
      server.on("exit", (value) => { clearTimeout(timer); resolve(value); });
    });
    assert.equal(code, 0, err);
    const record = readWebServerRecord({ dshHome: home, port });
    assert.ok(record, "helper 没有写记录");
    assert.equal(record.port, port);
    assert.equal(record.state, "spawned");
    assert.equal(record.url, "");
    assert.equal(pidAlive(record.pid), true, "记录 pid 不是活着的 server");
    killTree(record.pid);
  } finally {
    if (server) killTree(server.pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("杀不掉：taskkill 失败时不误报、记录保留、进程继续活着", async () => {
  const root = tempDir("web-kill-fail-");
  let child = null;
  try {
    const home = path.join(root, "home");
    const port = await freePort();
    child = fakeDshServer(root, port);
    assert.equal(await waitFor(() => portOpen(port)), true);
    const fakeBin = path.join(root, "fakebin");
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeTaskkill = path.join(fakeBin, "taskkill.exe");
    fs.copyFileSync(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", fakeTaskkill);
    writeWebServerRecord({
      dshHome: home,
      port,
      record: { pid: child.pid, port, host: "127.0.0.1", url: "", startedAt: new Date().toISOString(), execPath: node, argv: [], state: "spawned" },
    });
    const result = await runSidecar(root, home, port, { pathOverride: fakeBin + path.delimiter + systemPath() });
    assert.equal(result.code, 0, result.err);
    assert.equal(pidAlive(child.pid), true, "taskkill 失败后进程应仍在");
    assert.notEqual(readWebServerRecord({ dshHome: home, port }), null, "失败后记录应保留");
  } finally {
    if (child) killTree(child.pid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
