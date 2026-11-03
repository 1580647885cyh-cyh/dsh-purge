import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 宿主版本与适配状态（A1 / issue #18）。
 *
 * 只回答两件事：宿主现在跑的是哪个版本；这个版本在本维护版声明过的目标里吗。
 * 结论只影响报告与提醒，**不阻断**任何写入 —— 阻断会把冻结版锁在门外（backlog §A1）。
 *
 * 版本的唯一真源是桌面壳的 package.json（<install>/resources/app/package.json），
 * 不是 resources/app/dsh/package.json 里的运行时版本（docs/host-contract.md）。
 */

export const ADAPTATION_STATES = Object.freeze(["adapted", "unadapted", "unknown"]);

export const ADAPTATION_LABELS = Object.freeze({
  adapted: "已适配",
  unadapted: "未适配",
  unknown: "未知",
});

/** 版本串 → 分段；认不出返回 null（不抛，调用方按「未知」处理）。 */
export function parseHostVersion(raw) {
  const text = String(raw == null ? "" : raw).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!text) return null;
  return {
    major: Number(text[1]),
    minor: Number(text[2]),
    patch: Number(text[3]),
    pre: text[4] ? text[4].split(".") : [],
  };
}

/** 归一化键：v 前缀、尾随空白、预发布段大小写都不算差异。 */
export function hostVersionKey(raw) {
  const parsed = parseHostVersion(raw);
  if (!parsed) return "";
  const pre = parsed.pre.length > 0 ? "-" + parsed.pre.join(".").toLowerCase() : "";
  return parsed.major + "." + parsed.minor + "." + parsed.patch + pre;
}

/** 声明过的目标版本：dshTarget 在前，dshTargets 并列，按归一化键去重。 */
export function hostTargets(pkg = {}) {
  const list = [];
  if (typeof pkg.dshTarget === "string" && pkg.dshTarget) list.push(pkg.dshTarget);
  if (Array.isArray(pkg.dshTargets)) {
    for (const item of pkg.dshTargets) if (typeof item === "string" && item) list.push(item);
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = hostVersionKey(item) || item;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 本插件 package.json 里声明的目标版本（模块加载期读一次）。 */
export const PLUGIN_HOST_TARGETS = (() => {
  try {
    return hostTargets(JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")));
  } catch {
    return [];
  }
})();

/**
 * 适配判定：精确命中声明集合才算已适配；读不到/认不出是未知；其余是未适配。
 * 刻意不做 semver 区间 —— 区间会把没验证过的版本自动说成可适配，那正是假绿。
 */
export function hostAdaptation(version, targets = PLUGIN_HOST_TARGETS) {
  const list = (Array.isArray(targets) ? targets : []).filter((item) => typeof item === "string" && item);
  const version_ = String(version == null ? "" : version).trim();
  const key = hostVersionKey(version_);
  if (!key) {
    return { state: "unknown", version: version_, targets: list, matched: "", label: ADAPTATION_LABELS.unknown };
  }
  const matched = list.find((item) => hostVersionKey(item) === key) || "";
  const state = matched ? "adapted" : "unadapted";
  return { state, version: version_, targets: list, matched, label: ADAPTATION_LABELS[state] };
}

/** 读一个安装树里的宿主壳版本：<appDir>/package.json。读不到返回 null。 */
export function readHostVersion(appDir) {
  if (!appDir) return null;
  const file = path.join(appDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const version = typeof pkg.version === "string" ? pkg.version : "";
  if (!hostVersionKey(version)) return null;
  return { version, name: typeof pkg.name === "string" ? pkg.name : "", path: file };
}

/** 一行给人看的描述：0.2.1-rc.5 — 未适配（本版声明：0.2.1-rc.5）。 */
export function describeHostAdaptation(adaptation) {
  const item = adaptation || {};
  const target = Array.isArray(item.targets) && item.targets.length > 0 ? item.targets.join(" / ") : "未声明";
  const state = ADAPTATION_LABELS[item.state] || ADAPTATION_LABELS.unknown;
  return (item.version || "读不到") + " — " + state + "（本版声明：" + target + "）";
}
