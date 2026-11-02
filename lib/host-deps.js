import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

/**
 * 宿主依赖解析。
 *
 * 插件既可能跑在官方桌面（resources/app 解包布局）里，也可能跑在 npm/pnpm 安装的
 * Web/CLI 树里。预设行只静态 import 插件自己的包，运行时要用的宿主包
 * （@deepseek-ai/dsh-tools 等）必须按宿主实际布局解析。
 *
 * 两条硬约束（#3）：
 *   1. 候选来自宿主锚点（DSH_BASE / DSH_DESKTOP_INSTALL / resourcesPath / execPath /
 *      DSH_HOME 与 ~/.dsh / argv / cwd），不放固定机器路径；
 *   2. 命中前核对宿主身份：候选所在的 @deepseek-ai 包根确实有 dsh-agent-instructions/lib，
 *      且解析结果落回该锚点范围（符号链接按真实路径复核）。
 *
 * 这样“任意目录里有个同名 node_modules”不会冒充宿主依赖。
 */

const SCOPE = "@deepseek-ai";

function normalizeDir(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return path.normalize(text);
}

function isDir(value) {
  try {
    return Boolean(value) && fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/** 宿主包根：@deepseek-ai 目录，且带 dsh-agent-instructions/lib。 */
export function isHostAiBase(dir) {
  return isDir(dir) && isDir(path.join(dir, "dsh-agent-instructions", "lib"));
}

function within(child, root) {
  const c = path.resolve(String(child || "")).replace(/[\\/]+$/, "").toLowerCase();
  const r = path.resolve(String(root || "")).replace(/[\\/]+$/, "").toLowerCase();
  if (!c || !r || /^[a-z]:$/.test(r)) return false;
  return c === r || c.startsWith(r + path.sep) || c.startsWith(r + "/");
}

function realOr(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

/** 从入口文件反推包目录（@deepseek-ai/<pkg>）。 */
function packageDirOf(entry, pkgName) {
  let dir = path.dirname(String(entry || ""));
  for (let i = 0; i < 12; i += 1) {
    if (path.basename(dir).toLowerCase() === pkgName.toLowerCase()) {
      return path.basename(path.dirname(dir)).toLowerCase() === SCOPE.toLowerCase() ? dir : "";
    }
    const up = path.dirname(dir);
    if (!up || up === dir) break;
    dir = up;
  }
  return "";
}

/** 当前进程的宿主锚点；测试可显式传入自己的锚点。 */
export function defaultHostAnchors(proc = process) {
  const env = proc.env || {};
  const homes = [env.DSH_HOME, path.join(os.homedir(), ".dsh")].filter(Boolean);
  return {
    env: { DSH_BASE: env.DSH_BASE || "", DSH_DESKTOP_INSTALL: env.DSH_DESKTOP_INSTALL || "" },
    homes,
    execPath: proc.execPath || "",
    resourcesPath: proc.resourcesPath || "",
    argv1: proc.argv && proc.argv[1] ? proc.argv[1] : "",
    cwd: typeof proc.cwd === "function" ? proc.cwd() : "",
  };
}

/**
 * 候选形状：{ via, file, hostRoot, scopeRoot, aiBase? }
 *   file      createRequire 的基点（包目录里的 package.json，或 aiBase 的 package.json）
 *   hostRoot 用来核对身份的 @deepseek-ai 包根
 *   scopeRoot 解析结果必须落回的锚点范围（嵌套布局比 hostRoot 深一层）
 *   aiBase   true 时按目录解析目标包（DSH_BASE 直接就是 @deepseek-ai 根）
 */
function push(out, seen, desc) {
  const root = normalizeDir(desc.hostRoot);
  const scope = normalizeDir(desc.scopeRoot || desc.hostRoot);
  const file = normalizeDir(desc.file);
  if (!root || !scope || !file) return;
  const key = scope.toLowerCase() + "|" + file.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ via: desc.via, file, hostRoot: root, scopeRoot: scope, aiBase: desc.aiBase === true });
}

/** require 根（含 node_modules 的目录）→ 一个候选。 */
function addRequireRoot(out, seen, via, root) {
  const dir = normalizeDir(root);
  if (!dir) return;
  push(out, seen, {
    via,
    file: path.join(dir, "package.json"),
    hostRoot: path.join(dir, "node_modules", SCOPE),
    scopeRoot: dir,
  });
}

/** 桌面安装根 → resources/app 与 resources/app/dsh 两种包布局。 */
function addDesktopRoots(out, seen, via, installRoot) {
  const root = normalizeDir(installRoot);
  if (!root) return;
  const resources = path.join(root, "resources");
  addRequireRoot(out, seen, via + ":app", path.join(resources, "app"));
  addRequireRoot(out, seen, via + ":app-dsh", path.join(resources, "app", "dsh"));
  addRequireRoot(out, seen, via + ":asar-unpacked", path.join(resources, "app.asar.unpacked", "dsh"));
}

/** argv[1] 常见形态：npm 全局 bin、包内 bin、直接跑包入口。 */
function binCandidates(bin) {
  const raw = String(bin || "").trim();
  if (!raw) return [];
  const text = realOr(raw).replace(/\\/g, "/");
  const out = [];
  const scoped = text.lastIndexOf("/node_modules/" + SCOPE + "/dsh/");
  if (scoped >= 0) out.push(text.slice(0, scoped));
  const nm = text.lastIndexOf("/node_modules/");
  if (nm >= 0) out.push(text.slice(0, nm));
  const dir = path.dirname(text);
  // npm 全局的 argv 常常是 …/bin/dsh，真正的包在旁边的 lib/node_modules。
  out.push(path.join(dir, "..", "lib"));
  out.push(path.join(dir, ".."));
  return out;
}

/**
 * 候选顺序：先宿主身份锚点，再安装形态推断，最后是通用候选。
 * 同一份 npm/Web 布局由 DSH_HOME 与 ~/.dsh 两条 home 锚点覆盖。
 */
export function hostRequireCandidates(anchors = defaultHostAnchors()) {
  const env = (anchors && anchors.env) || {};
  const out = [];
  const seen = new Set();

  const base = normalizeDir(env.DSH_BASE);
  if (base) {
    push(out, seen, {
      via: "dsh-base",
      file: path.join(base, "package.json"),
      hostRoot: base,
      scopeRoot: base,
      aiBase: true,
    });
  }

  addDesktopRoots(out, seen, "desktop-install", env.DSH_DESKTOP_INSTALL);

  const resources = normalizeDir(anchors && anchors.resourcesPath);
  if (resources) {
    addRequireRoot(out, seen, "resources-path:app", path.join(resources, "app"));
    addRequireRoot(out, seen, "resources-path:app-dsh", path.join(resources, "app", "dsh"));
  }

  const execPath = normalizeDir(anchors && anchors.execPath);
  if (execPath) {
    const exeDir = path.dirname(execPath);
    addDesktopRoots(out, seen, "exec-path", exeDir);
    addRequireRoot(out, seen, "exec-path:app", path.join(exeDir, "app"));
  }

  const homes = (Array.isArray(anchors && anchors.homes) ? anchors.homes : [])
    .map(normalizeDir)
    .filter(Boolean);
  for (const home of homes) {
    addRequireRoot(out, seen, "dsh-home", home);
    for (const profile of ["web", "desktop", "default"]) {
      const profileRoot = path.join(home, "profiles", profile);
      addRequireRoot(out, seen, "profile:" + profile, profileRoot);
      // npm 嵌套布局：@deepseek-ai/dsh 自带 node_modules，包在它下面。
      push(out, seen, {
        via: "profile:" + profile + ":nested",
        file: path.join(profileRoot, "node_modules", SCOPE, "dsh", "package.json"),
        hostRoot: path.join(profileRoot, "node_modules", SCOPE),
        scopeRoot: profileRoot,
      });
    }
  }

  for (const root of binCandidates(anchors && anchors.argv1)) {
    addRequireRoot(out, seen, "argv", root);
  }

  const cwd = normalizeDir(anchors && anchors.cwd);
  if (cwd) addRequireRoot(out, seen, "cwd", cwd);

  // 这里不放任何固定机器路径：旧实现的 D:\DeepSeek Harness\npm-global 兜底在 #3 移除，
  // 同样的 CLI 布局由 argv（bin → node_modules）覆盖，且所有候选都要过宿主身份核对。
  return out;
}

function statusText(status) {
  if (status === "not-a-host") return "不是宿主包根";
  if (status === "package-missing") return "宿主没有这个包";
  if (status === "outside-host") return "解析结果不在该宿主锚点内";
  if (status === "unexpected-entry") return "解析结果不是 @deepseek-ai 包";
  if (status === "resolve-error") return "解析失败";
  return status;
}

/**
 * 在宿主包根上解析一个宿主依赖。
 * 返回 { ok, entry, hostRoot, via, error, tried }；tried 记录每个候选的状态，便于验证入口取证。
 */
export function resolveHostModule(specifier, anchors = defaultHostAnchors()) {
  const name = String(specifier || "").trim();
  const pkgName = name.split("/").pop();
  const result = { ok: false, specifier: name, entry: "", hostRoot: "", via: "", error: "", tried: [] };
  if (!name || !pkgName) {
    result.error = "解析宿主依赖需要一个包名";
    return result;
  }
  for (const cand of hostRequireCandidates(anchors)) {
    const row = { via: cand.via, hostRoot: cand.hostRoot, status: "", entry: "" };
    result.tried.push(row);
    if (!isHostAiBase(cand.hostRoot)) {
      row.status = "not-a-host";
      continue;
    }
    let entry = "";
    try {
      const req = createRequire(cand.file);
      // aiBase 根自己就是 @deepseek-ai 目录：按目录解析，而不是从 node_modules 里找自己。
      entry = cand.aiBase ? req.resolve("./" + pkgName) : req.resolve(name);
    } catch (error) {
      row.status = error && error.code === "MODULE_NOT_FOUND" ? "package-missing" : "resolve-error";
      row.error = String(error && error.code ? error.code + ": " : "") + String(error && error.message ? error.message : error);
      continue;
    }
    const landed = packageDirOf(entry, pkgName);
    const inside = within(entry, cand.scopeRoot) || within(realOr(entry), realOr(cand.scopeRoot));
    if (!landed) {
      row.status = "unexpected-entry";
      row.entry = entry;
      continue;
    }
    if (!inside) {
      row.status = "outside-host";
      row.entry = entry;
      continue;
    }
    row.status = "resolved";
    row.entry = entry;
    return { ...result, ok: true, entry, hostRoot: cand.hostRoot, via: cand.via };
  }
  const last = [...result.tried].reverse().find((row) => row.status !== "not-a-host");
  result.error = "cannot resolve " + name + " from host"
    + (last ? " (" + last.via + ": " + statusText(last.status) + ")" : " (no host package root found)");
  return result;
}
