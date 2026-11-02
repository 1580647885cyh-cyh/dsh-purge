import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertDriveDPath, sha256File, stampNow } from "./isolate.js";

/**
 * 保护基线封存与校验。
 *
 * 只读取当前源码与宿主指纹，不写入、不替换、不重置源码目录；
 * 快照写到 D 盘独立目录，避免把验证产物混进维护版本身。
 */

export const DEFAULT_BASELINE_DIR = "D:\\dsh\\data\\dsh-purge\\baseline";

export const SOURCE_ENTRIES = [
  "package.json",
  "client.js",
  "cordis.patch.yml",
  "README.md",
  "README.zh-CN.md",
  "README.local-lock.md",
  "GLOSSARY.md",
  "LICENSE",
  "MIRROR-NOTICE.md",
  "release-notes.md",
  "screenshots.json",
  ".gitignore",
  ".npmignore",
  ".github",
  "bin",
  "lib",
  "scripts",
  "presets",
  "skills",
  "docs",
  "tests",
];

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".scratch", ".codegraph"]);
const EXCLUDED_FILES = new Set([".DS_Store", "Thumbs.db"]);
// 兼容修订记录是验收产物，不是待恢复的源码：算进基线会让每次补记录都改变 treeHash，
// 恢复材料也就永远对不上当前树（#8）。
const EXCLUDED_PATHS = new Set(["docs/compatibility"]);

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 保护基线覆盖的源码文件列表：随包文件 + 文档/脚本，排除 VCS 与临时目录。 */
export function listSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      if (EXCLUDED_FILES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (EXCLUDED_PATHS.has(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(rel);
    }
  };
  for (const entry of SOURCE_ENTRIES) {
    const full = path.join(root, entry);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full);
    else out.push(entry);
  }
  return out.sort();
}

export function buildManifest(root) {
  const files = [];
  for (const rel of listSourceFiles(root)) {
    const full = path.join(root, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    files.push({ path: rel, size: stat.size, sha256: sha256File(full) });
  }
  const treeHash = createHash("sha256")
    .update(files.map((file) => file.path + "  " + file.sha256).join("\n"), "utf8")
    .digest("hex");
  return { treeHash, fileCount: files.length, files };
}

function git(root, args, env) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: env || process.env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** 本地与用户远端的历史关系：分支、HEAD、未提交状态和远端来源，不联网。 */
export function gitRelation(root, { env } = {}) {
  const result = {
    available: true,
    branch: "",
    head: null,
    headSubject: "",
    dirtyFiles: 0,
    remotes: [],
    userRemote: false,
    upstreamRemote: false,
    note: "",
  };
  try {
    git(root, ["rev-parse", "--git-dir"], env);
  } catch (error) {
    result.available = false;
    result.note = String(error && error.message ? error.message : error);
    return result;
  }
  try {
    result.branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"], env);
  } catch {
    try {
      result.branch = git(root, ["symbolic-ref", "--short", "HEAD"], env);
    } catch {
      result.branch = "";
    }
  }
  try {
    result.head = git(root, ["rev-parse", "HEAD"], env);
    result.headSubject = git(root, ["log", "-1", "--format=%s"], env);
  } catch {
    result.head = null;
    result.note = "HEAD 尚未提交（unborn branch）";
  }
  try {
    const status = git(root, ["status", "--porcelain=v1"], env);
    result.dirtyFiles = status ? status.split("\n").filter(Boolean).length : 0;
  } catch {
    result.dirtyFiles = -1;
  }
  try {
    const remoteText = git(root, ["remote", "-v"], env);
    const seen = new Set();
    for (const line of remoteText.split("\n")) {
      const [name, url] = line.split(/\s+/);
      if (!name || !url || seen.has(name + " " + url)) continue;
      seen.add(name + " " + url);
      result.remotes.push({ name, url });
    }
  } catch {
    result.remotes = [];
  }
  result.userRemote = result.remotes.some((remote) => /1580647885cyh-cyh\/dsh-purge/i.test(remote.url));
  result.upstreamRemote = result.remotes.some((remote) => /YuJunZhiXue\/dsh-purge/i.test(remote.url));
  return result;
}

export function pluginFingerprint(root) {
  const file = path.join(root, "package.json");
  const pkg = readJson(file, {});
  return {
    name: pkg.name || "",
    version: pkg.version || "",
    type: pkg.type || "",
    dshTarget: pkg.dshTarget || "",
    localVersionLock: pkg.dsh && pkg.dsh.localVersionLock ? pkg.dsh.localVersionLock : null,
    packageJsonSha256: fs.existsSync(file) ? sha256File(file) : "",
  };
}

export function hostFingerprint(installDir) {
  const resources = path.join(installDir, "resources");
  const appDir = path.join(resources, "app");
  const shell = readJson(path.join(appDir, "package.json"), {});
  const runtime = readJson(path.join(appDir, "dsh", "package.json"), {});
  const asar = path.join(resources, "app.asar");
  let asarStat = null;
  try {
    const stat = fs.statSync(asar);
    asarStat = { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
  } catch {
    asarStat = null;
  }
  return {
    installDir,
    appDir,
    shellName: shell.name || "",
    shellVersion: shell.version || "",
    buildCommit: shell.dshBuildCommit || "",
    buildDirty: shell.dshBuildDirty === true,
    runtimeName: runtime.name || "",
    runtimeVersion: runtime.version || "",
    appAsar: asarStat,
  };
}

export function environmentFingerprint(env = process.env) {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron || null,
    execPath: process.execPath,
    surface: env.DSH_SURFACE || "auto",
    homedir: os.homedir(),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 封存当前源码：生成可校验的清单与指纹，写到 D 盘快照目录。
 * 不读取备份目录内容，也不回写源码。
 */
export function sealBaseline({ root, outDir = DEFAULT_BASELINE_DIR, installDir, stamp = stampNow(), env = process.env } = {}) {
  const sourceRoot = path.resolve(root);
  const targetDir = assertDriveDPath(outDir, "基线输出目录");
  const manifest = buildManifest(sourceRoot);
  const baseline = {
    kind: "dsh-purge-baseline",
    createdAt: new Date().toISOString(),
    stamp,
    sourceRoot,
    source: manifest,
    plugin: pluginFingerprint(sourceRoot),
    host: installDir ? hostFingerprint(installDir) : null,
    environment: environmentFingerprint(env),
    git: gitRelation(sourceRoot, { env }),
  };
  const file = path.join(targetDir, "baseline-" + stamp + ".json");
  writeJson(file, baseline);
  writeJson(path.join(targetDir, "latest.json"), baseline);
  return { file, baseline };
}

/** 用已封存清单校验当前源码；任何新增/删除/改动都会报告，不覆盖源码。 */
export function verifyBaseline({ root, baseline } = {}) {
  if (!baseline || !baseline.source || !Array.isArray(baseline.source.files)) {
    throw new Error("基线文件缺少 source.files，无法校验");
  }
  const current = buildManifest(path.resolve(root));
  const expected = new Map(baseline.source.files.map((file) => [file.path, file.sha256]));
  const actual = new Map(current.files.map((file) => [file.path, file.sha256]));
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, hash] of actual) {
    if (!expected.has(rel)) added.push(rel);
    else if (expected.get(rel) !== hash) changed.push({ path: rel, expected: expected.get(rel), actual: hash });
  }
  for (const rel of expected.keys()) {
    if (!actual.has(rel)) removed.push(rel);
  }
  changed.sort((a, b) => a.path.localeCompare(b.path));
  added.sort();
  removed.sort();
  return {
    ok: current.treeHash === baseline.source.treeHash && changed.length === 0 && added.length === 0 && removed.length === 0,
    expectedTreeHash: baseline.source.treeHash,
    actualTreeHash: current.treeHash,
    expectedFileCount: baseline.source.files.length,
    actualFileCount: current.files.length,
    changed,
    added,
    removed,
  };
}