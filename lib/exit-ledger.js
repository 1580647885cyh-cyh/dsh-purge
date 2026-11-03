import fs from "node:fs";
import path from "node:path";

/**
 * 桌面退出留痕（A5 / #25）。
 *
 * 桌面 dir 形态静默退出时，只有 close 回调知道真实的 code / signal（#83/#84 把两个分支都改成
 * 静默 resolve 之后，这两个值读完就丢）。这里定义落哪、写什么、留多少，以及读侧怎么回答
 * 「最近一次桌面退出」。
 *
 * 写入方有两份实现，契约只有这一份：
 * 1. 宿主进程里的那一段（core.js 的 desktop-shell 补丁 #90）—— 宿主 main.js 不能 import 插件，
 *    所以它是同一套规则的**内联副本**，由入口五的 harness 用真 fs 跑一遍再交给本模块读回；
 *    harness 另外核对内联代码依赖的名字确实在宿主 main.js 的模块作用域里（见 exit-trace.js
 *    的 module-scope 案例）—— 否则「注入了作用域所以能写」证明不了真机上也能写。
 * 2. 本模块的 recordDesktopExit —— 同一套滚动规则的插件内版本；目前只有单元测试用它，
 *    不进宿主退出路径。
 *
 * 三条硬约束：
 * - 有上界：条数 + 字节都滚动，写满之后不再无限增长；
 * - 不抛：半写、损坏、权限不足都只记 error，绝不让留痕挡住宿主退出；
 * - 只旁听：不改退出行为、不改 exit code、不写官方更新 journal。
 */

/** 留痕目录名（DSH_HOME 下）。 */
const EXIT_LEDGER_DIR_NAME = "dsh-purge";
/** 留痕文件名：一行一条 JSON，读侧逐行校验，坏行跳过。 */
const EXIT_LEDGER_FILE_NAME = "exit-ledger.jsonl";
/** 条数上界：一次桌面退出一条，留 20 次足够回答「上次怎么退的」。 */
export const EXIT_LEDGER_MAX_ENTRIES = 20;
/** 字节上界（UTF-8，内联副本同口径）：超了就挤掉更旧的记录。 */
export const EXIT_LEDGER_MAX_BYTES = 8192;
/** 来源词表：当前只有 close 回调会写；quit/crash/signal 留待后续票，不预埋。 */
const EXIT_LEDGER_SOURCES = Object.freeze(["close"]);

/** 留痕文件路径；没有 DSH_HOME 时返回空串（读侧据此答「无」）。 */
export function exitLedgerFile(home) {
  const base = typeof home === "string" ? home.trim() : "";
  if (!base) return "";
  return path.join(base, EXIT_LEDGER_DIR_NAME, EXIT_LEDGER_FILE_NAME);
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

/** 写侧/读侧共用的「这一行是不是一条可用的 JSONL 记录」：对象即可，字段由读侧校验。 */
function parseJsonLine(line) {
  try {
    const raw = JSON.parse(line);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 一条记录的形状校验。缺时间、时间不可解析、来源不在词表里都不算数 ——
 * 读侧宁可回答「无」，也不把半条记录当成一次真实退出。
 */
function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const at = typeof raw.at === "string" ? raw.at.trim() : "";
  if (!at || Number.isNaN(Date.parse(at))) return null;
  let code = null;
  if (raw.code !== null && raw.code !== undefined) {
    code = Number(raw.code);
    if (!Number.isInteger(code)) return null;
  }
  const signal = raw.signal === null || raw.signal === undefined || raw.signal === "" ? null : String(raw.signal);
  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  if (!EXIT_LEDGER_SOURCES.includes(source)) return null;
  return { at, code, signal, source };
}

/** 逐行解析；坏行跳过，不抛。返回按写入顺序排列的有效记录。 */
function parseExitLedger(text) {
  const out = [];
  for (const line of String(text == null ? "" : text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = normalizeRecord(parseJsonLine(line));
    if (record) out.push(record);
  }
  return out;
}

/**
 * 读侧：最近一次桌面退出。
 * @returns {{found: boolean, latest: object|null, count: number, file: string, reason: string, error: string}}
 *   reason 区分 missing / no-home / unreadable / no-valid-record / ok —— 「无」也要有原因。
 */
export function readLatestDesktopExit({ home = "" } = {}) {
  const file = exitLedgerFile(home);
  const info = { found: false, latest: null, count: 0, file, reason: "no-home", error: "" };
  if (!file) return info;
  info.reason = "missing";
  let text = "";
  try {
    if (!fs.existsSync(file)) return info;
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    info.reason = "unreadable";
    info.error = errorText(error);
    return info;
  }
  const records = parseExitLedger(text);
  info.count = records.length;
  if (records.length === 0) {
    info.reason = "no-valid-record";
    return info;
  }
  info.found = true;
  info.reason = "ok";
  info.latest = records[records.length - 1];
  return info;
}

/**
 * 写侧（插件内版本；同一套滚动规则的内联副本在宿主补丁 #90 里）。
 * 绝不抛：写入失败只返回 { ok: false, error }，调用方据此旁听即可。
 */
export function recordDesktopExit(record = {}, { home = "" } = {}) {
  const file = exitLedgerFile(home);
  const out = { ok: false, file, count: 0, error: "" };
  if (!file) {
    out.error = "no DSH_HOME";
    return out;
  }
  try {
    const normalized = normalizeRecord({
      at: record.at || new Date().toISOString(),
      code: record.code === undefined ? null : record.code,
      signal: record.signal === undefined ? null : record.signal,
      source: record.source || "close",
    });
    if (!normalized) throw new Error("exit record is incomplete");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines = [];
    try {
      if (fs.existsSync(file)) {
        lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim() !== "" && parseJsonLine(line));
      }
    } catch {
      lines = [];
    }
    lines.push(JSON.stringify(normalized));
    lines = lines.slice(-EXIT_LEDGER_MAX_ENTRIES);
    while (lines.length > 1 && Buffer.byteLength(lines.join("\n") + "\n", "utf8") > EXIT_LEDGER_MAX_BYTES) lines.shift();
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    out.ok = true;
    out.count = lines.length;
  } catch (error) {
    out.error = errorText(error);
  }
  return out;
}

/**
 * 一句话描述（purge_status 与验证报告共用）：没有记录时也必须是明确的「无」。
 * 读不了文件时把原因带出来 —— 「无」和「读不到」是同一条契约，不该在展示层压成一个词。
 */
export function describeDesktopExit(info) {
  const record = info && info.latest;
  if (!record) {
    if (info && info.reason === "unreadable") return "无 / none（留痕文件读不了：" + (info.error || "unknown") + "）";
    return "无 / none（还没有桌面退出留痕）";
  }
  const code = record.code === null || record.code === undefined ? "无" : String(record.code);
  const signal = record.signal ? String(record.signal) : "无";
  return "code=" + code + " · signal=" + signal + " · " + record.at + " · 来源=" + record.source;
}
