import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 验证设施共用的进程/端口小工具。
 *
 * 只给 lib/verify 的 harness 与 tests/verify 用：系统二进制绝对路径、等待、pid 存活、
 * 杀进程、找空闲端口、探测端口。别把业务判断塞进来。
 */

function systemRoot() {
  return process.env.SystemRoot || "C:\\Windows";
}

export function systemPath() {
  const root = systemRoot();
  return [
    path.join(root, "System32"),
    root,
    path.join(root, "System32", "Wbem"),
    path.join(root, "System32", "WindowsPowerShell", "v1.0"),
  ].join(path.delimiter);
}

export function powershellExe() {
  return path.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function taskkillExe() {
  return path.join(systemRoot(), "System32", "taskkill.exe");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, timeoutMs = 10000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

export function pidAlive(pid) {
  const n = Number(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

export function killPid(pid) {
  const n = Number(pid);
  if (!n) return;
  try {
    if (process.platform === "win32") {
      execFileSync(taskkillExe(), ["/PID", String(n), "/T", "/F"], {
        env: { ...process.env, PATH: systemPath() },
        stdio: "ignore",
        windowsHide: true,
        timeout: 8000,
      });
    } else {
      process.kill(n, "SIGKILL");
    }
  } catch {
    // 已经退了
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) }, () => {
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
