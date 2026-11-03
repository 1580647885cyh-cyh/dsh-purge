import fs from "node:fs";
import path from "node:path";
import { VERIFY_ROOT } from "./isolate.js";

/**
 * 读一份验证报告的字段（#25 retro）。
 *
 * 为什么要有它：报告字段是断言与文档的共同口径，agent 每轮都在用一次性
 * `node -e` / 临时脚本去翻 `report.json`，脚本还会留在仓库根。这里给一个稳定入口：
 * 选报告（latest / 时间戳 / 显式路径）+ 点名字段（支持数组下标），只读不写。
 *
 * latest 按**目录 mtime** 取，不按名字排序 —— 旧工作区可能叫 smoke2/report-check2 之类（README 已记）。
 */

const STAMP = /^\d{8}-\d{6}$/;

/** 定位 report.json：latest / <stamp> / 显式 .json 路径。 */
export function resolveReportFile(target = "latest", { root = VERIFY_ROOT } = {}) {
  const value = String(target == null ? "" : target).trim();
  if (!value || value === "latest") {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      throw new Error("验证根目录不存在：" + root);
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && STAMP.test(entry.name))
      .map((entry) => {
        const dir = path.join(root, entry.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(dir).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { dir, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const item of dirs) {
      const file = path.join(item.dir, "out", "report.json");
      if (fs.existsSync(file)) return file;
    }
    throw new Error("验证根目录下没有任何一轮报告：" + root);
  }
  if (/\.json$/i.test(value)) {
    const file = path.resolve(value);
    if (!fs.existsSync(file)) throw new Error("报告文件不存在：" + file);
    return file;
  }
  const file = path.join(root, value, "out", "report.json");
  if (!fs.existsSync(file)) throw new Error("这一轮的 report.json 不存在：" + file);
  return file;
}

/** 按点路径取值：`targets.runtime.exitTrace.cases.0.id`。取不到返回 undefined。 */
export function pickReportField(report, dotted) {
  let current = report;
  for (const segment of String(dotted || "").split(".").filter(Boolean)) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else if (typeof current === "object") {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * 读字段。
 * @returns {{file: string, fields: object, missing: string[], keys?: string[]}}
 *   不传 paths 时只给顶层键（用来发现字段名）。
 */
export function readReportFields(target, paths = [], { root } = {}) {
  const file = resolveReportFile(target, { root });
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  if (paths.length === 0) return { file, keys: Object.keys(report), fields: {}, missing: [] };
  const fields = {};
  const missing = [];
  for (const dotted of paths) {
    const value = pickReportField(report, dotted);
    if (value === undefined) missing.push(dotted);
    else fields[dotted] = value;
  }
  return { file, fields, missing };
}
