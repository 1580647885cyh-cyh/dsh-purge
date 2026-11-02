import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

/**
 * 验证入口的隔离层：所有工作目录、配置、缓存、日志和宿主副本都落在 D 盘，
 * 并在启动前把进程环境改到隔离目录，确保测试不会读写用户真实会话、凭据或工作区。
 *
 * 这里只做路径与环境的准备工作；不启动宿主、不调用插件。
 */

export const VERIFY_ROOT = "D:\\dsh\\tmp\\dsh-purge-verify";

/** 本机约定：验证产物只写 D 盘。 */
export function isDriveDPath(value) {
  if (!value) return false;
  return /^[dD]:[\\/]/.test(path.resolve(String(value)));
}

export function assertDriveDPath(value, label) {
  if (!isDriveDPath(value)) {
    throw new Error((label || "路径") + "必须在 D 盘：" + value);
  }
  return path.resolve(String(value));
}

export function stampNow(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

/** 规划一次验证的目录布局；只返回路径，不写盘。 */
export function planWorkspace({ root = VERIFY_ROOT, stamp = stampNow() } = {}) {
  const base = assertDriveDPath(root, "验证根目录");
  const dir = assertDriveDPath(path.join(base, stamp), "验证目录");
  const workspace = {
    stamp,
    root: dir,
    home: path.join(dir, "home"),
    localAppData: path.join(dir, "localappdata"),
    appData: path.join(dir, "appdata"),
    tmp: path.join(dir, "tmp"),
    emptyBin: path.join(dir, "emptybin"),
    logs: path.join(dir, "logs"),
    install: path.join(dir, "desktop"),
    hostBase: path.join(dir, "desktop", "resources", "app", "dsh", "node_modules", "@deepseek-ai"),
    out: path.join(dir, "out"),
  };
  for (const [key, value] of Object.entries(workspace)) {
    if (key === "stamp") continue;
    assertDriveDPath(value, "workspace." + key);
  }
  return workspace;
}

export function ensureWorkspace(workspace) {
  for (const key of ["root", "home", "localAppData", "appData", "tmp", "emptyBin", "logs", "out", "install"]) {
    fs.mkdirSync(workspace[key], { recursive: true });
  }
  return workspace;
}

/** 隔离进程环境：DSH_HOME、缓存、临时目录、用户目录和 PATH 全部指向工作区。 */
export function isolatedEnvironment(workspace, { installDir, hostBase, surface = "desktop", base = process.env } = {}) {
  const home = assertDriveDPath(workspace.home, "隔离 DSH_HOME");
  const env = { ...base };
  env.DSH_HOME = home;
  env.DSH_SURFACE = surface;
  env.DSH_DESKTOP_INSTALL = assertDriveDPath(installDir || workspace.install, "隔离宿主安装目录");
  env.DSH_BASE = assertDriveDPath(hostBase || workspace.hostBase, "隔离宿主包根");
  env.LOCALAPPDATA = assertDriveDPath(workspace.localAppData, "LOCALAPPDATA");
  env.APPDATA = assertDriveDPath(workspace.appData, "APPDATA");
  env.TEMP = assertDriveDPath(workspace.tmp, "TEMP");
  env.TMP = assertDriveDPath(workspace.tmp, "TMP");
  env.USERPROFILE = assertDriveDPath(workspace.home, "USERPROFILE");
  env.HOMEDRIVE = "D:";
  env.HOMEPATH = path.dirname(home);
  // 清空 PATH：宿主发现会通过 powershell 查注册表/进程/快捷方式；不查就不会命中本机真实安装。
  env.PATH = assertDriveDPath(workspace.emptyBin, "PATH");
  delete env.DSH_PERMISSION_MODE;
  return env;
}

const ENV_KEYS = [
  "DSH_HOME",
  "DSH_SURFACE",
  "DSH_DESKTOP_INSTALL",
  "DSH_BASE",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PATH",
  "DSH_PERMISSION_MODE",
];

/** 把隔离环境写进当前进程，返回恢复函数。插件必须在应用环境之后加载。 */
function envValue(env, key) {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === lower) return env[name];
  }
  return undefined;
}

export function applyProcessEnvironment(env) {
  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    const value = envValue(env, key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return function restore() {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 递归快照（相对路径 → 哈希/大小），用于观察隔离副本的真实文件结果。 */
export function snapshotTree(root, { skip = () => false } = {}) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (skip(rel, full)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        out.set(rel, { sha256: sha256File(full), size: stat.size });
      }
    }
  };
  walk(root);
  return out;
}

export function diffSnapshots(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [rel, meta] of after) {
    const prev = before.get(rel);
    if (!prev) added.push(rel);
    else if (prev.sha256 !== meta.sha256) changed.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) removed.push(rel);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

export function isWithin(child, root) {
  const normalize = (value) => path.resolve(String(value)).replace(/[\\/]+$/, "").toLowerCase();
  const c = normalize(child);
  const r = normalize(root);
  if (!c || !r || /^[a-z]:$/.test(r)) return false;
  return c === r || c.startsWith(r + path.sep);
}

/**
 * 预检：插件枚举到的每个宿主都必须落在隔离工作区内。
 * 这条检查在任何管理操作之前执行——发现本机真实安装就中止，不写任何宿主文件。
 */
export function assertHostsIsolated(hosts, workspace) {
  const list = Array.isArray(hosts) ? hosts : [];
  if (list.length === 0) throw new Error("预检失败：插件没有枚举到任何宿主，无法执行隔离管理操作");
  const outside = list.filter((host) => !isWithin(host, workspace.root));
  if (outside.length > 0) {
    throw new Error("预检失败：枚举到的宿主超出隔离工作区，已中止管理操作：" + outside.join(", "));
  }
  return list;
}

/** 本机用户目录（仅用于默认定位真实安装，不作为测试写盘目标）。 */
export function realLocalAppData(env = process.env) {
  return env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}