import fs from "node:fs";
import path from "node:path";
import { STAMP_BODY, assertDriveDPath } from "./isolate.js";

/**
 * 验证工作区保留策略（#13）。
 *
 * 每轮验证在验证根下建一个 5–6 MB 的工作区副本，旧实现只增不减（实测 85 个目录 / 484 MB）。
 * 这里按名字与活动时间清掉旧的那一批，规则只有四条：
 *
 * 1. 只认自己的名字：<YYYYMMDD-HHMMSS> 与 probe-<同样的戳>。_fixture-cache、acceptance-commit
 *    （docs/compatibility/ 引用它的路径）、测试式命名与普通文件一律不碰。
 * 2. 本轮工作区永不删，即使它落在保留窗口之外；窗口是「最近 keep 个旧工作区」，本轮另算。
 * 3. 最近 30 分钟内有写入的目录不删：判据是目录树里**任意一层**的 mtime，不是顶层目录——
 *    ensureWorkspace 建完子目录后顶层 mtime 就不再刷新，只看顶层会把跑久的兄弟进程当陈旧删掉。
 *    这类跳过的目录不占保留名额。
 * 4. 只碰验证根的直接子目录（不递归找别的根）。
 *
 * 清理失败只记原因，不抛错——工作区清理不该让验证失败。
 */

export const DEFAULT_RETENTION_KEEP = 5;

/** 活动保护窗口：窗口内有写入的目录算「在跑」。 */
const MIN_AGE_MS = 30 * 60 * 1000;

const WORKSPACE_NAME = new RegExp("^(?:probe-)?(?:" + STAMP_BODY + ")$");

function message(error) {
  return String(error && error.message ? error.message : error);
}

/**
 * 扫一棵工作区：返回 { bytes, fresh }。
 * fresh = 树上任意一项的 mtime 晚于 cutoff（发现即返回；此时 bytes 不完整也不用——在跑的目录不报体积）。
 * 否则 bytes = 全部普通文件大小之和。
 */
function scanTree(dir, cutoff) {
  let bytes = 0;
  const walk = (current) => {
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      return false;
    }
    if (stat.mtimeMs > cutoff) return true;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) return true;
        continue;
      }
      if (!entry.isFile()) continue;
      let fileStat;
      try {
        fileStat = fs.statSync(full);
      } catch {
        continue;
      }
      if (fileStat.mtimeMs > cutoff) return true;
      bytes += fileStat.size;
    }
    return false;
  };
  // 先走完再读 bytes：写在对象字面量里会先取值（永远是 0）。
  const fresh = walk(dir);
  return { bytes, fresh };
}

/**
 * 清掉验证根下过期的工作区，返回结构性事实：
 * { root, keep, kept, removed, freedBytes, skipped: [{ name, reason }] }。
 *
 * keep ≤ 0 表示只留本轮；本轮工作区不计入窗口。
 */
export function pruneWorkspaces({ root, keep = DEFAULT_RETENTION_KEEP, protect = [] } = {}) {
  const base = assertDriveDPath(root, "验证根目录");
  const cutoff = Date.now() - MIN_AGE_MS;
  const protectedNames = new Set((protect || []).filter(Boolean).map((item) => path.basename(path.resolve(String(item)))));
  const skipped = [];
  const candidates = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!WORKSPACE_NAME.test(entry.name)) continue;
    if (protectedNames.has(entry.name)) {
      skipped.push({ name: entry.name, reason: "当前工作区" });
      continue;
    }
    const full = path.join(base, entry.name);
    const scan = scanTree(full, cutoff);
    if (scan.fresh) {
      skipped.push({ name: entry.name, reason: "最近仍在写入" });
      continue;
    }
    candidates.push({ name: entry.name, full, stamp: entry.name.slice(-15), bytes: scan.bytes });
  }
  // 新的在前：先按戳，再按名字（probe- 与同名戳并存时不靠目录顺序碰运气）。
  candidates.sort((a, b) => (a.stamp === b.stamp ? (a.name < b.name ? 1 : -1) : (a.stamp < b.stamp ? 1 : -1)));
  const window = Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 0;
  const kept = candidates.slice(0, window).map((item) => item.name);
  const removed = [];
  let freedBytes = 0;
  for (const row of candidates.slice(window)) {
    try {
      fs.rmSync(row.full, { recursive: true, force: true });
    } catch (error) {
      skipped.push({ name: row.name, reason: "删除失败：" + message(error) });
      continue;
    }
    // 删成功才计释放量：删到一半失败时既不记「已释放」，也不假装干净。
    removed.push(row.name);
    freedBytes += row.bytes;
  }
  return { root: base, keep: window, kept, removed, freedBytes, skipped };
}
