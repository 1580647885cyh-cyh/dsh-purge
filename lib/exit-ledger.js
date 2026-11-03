import fs from "node:fs";
import path from "node:path";

/**
 * 桌面退出留痕（A5-1 / #25，A5-2 / #26）。
 *
 * 桌面 dir 形态静默退出时，只有 close 回调知道真实的 code / signal（#83/#84 把两个分支都改成
 * 静默 resolve 之后，这两个值读完就丢）。#26 把其余生命周期来源补齐：宿主 quit（带 exitCode）、
 * 渲染进程消失、uncaughtExceptionMonitor、进程 exit。这里定义落哪、写什么、留多少，以及读侧
 * 怎么回答「最近一次桌面退出」。
 *
 * 写入方有两份实现，契约只有这一份：
 * 1. 宿主进程里的那一段（core.js 的 desktop-shell 补丁 #90 调用的 #91 块）—— 宿主 main.js 不能
 *    import 插件，所以它是同一套规则的**内联副本**，由入口五的 harness 用真 fs 跑一遍再交给本模块
 *    读回；harness 另外核对内联代码依赖的名字确实在宿主 main.js 的模块作用域里（见 exit-trace.js
 *    的 module-scope 案例）—— 否则「注入了作用域所以能写」证明不了真机上也能写。
 * 2. 本模块的 recordDesktopExit —— 同一套合并/滚动规则的插件内版本；目前只有单元测试用它，
 *    不进宿主退出路径。
 *
 * 三条硬约束：
 * - 有上界：条数 + 字节都滚动，写满之后不再无限增长；
 * - 不抛：半写、损坏、权限不足都只记 error，绝不让留痕挡住宿主退出；
 * - 只旁听：不改退出行为、不改 exit code、不写官方更新 journal。
 *
 * 多来源规则（#26；两份实现同口径）：
 * - 一次进程运行是一个 episode；同一 episode 的多个来源合成**一条**记录，后到的来源只追加到
 *   chain，不再写第二行；
 * - source 记第一个来源（原因链起点），terminal 记第一个终结性来源（quit / exit）；
 * - 退出码以终结性来源优先、先到者优先：quit(3) 之后的 exit(0) 不会把 3 冲成 0；
 *   quit 没给码时 exit 的码才补空位；非终结来源（close / 渲染崩溃 / uncaught）只补空位。
 */

/** 留痕目录名（DSH_HOME 下）。 */
const EXIT_LEDGER_DIR_NAME = "dsh-purge";
/** 留痕文件名：一行一条 JSON，读侧逐行校验，坏行跳过。 */
const EXIT_LEDGER_FILE_NAME = "exit-ledger.jsonl";

/** 条数上界：一次桌面退出一条，留 20 次足够回答「上次怎么退的」。 */
export const EXIT_LEDGER_MAX_ENTRIES = 20;
/** 字节上界（UTF-8，内联副本同口径）：超了就挤掉更旧的记录。 */
export const EXIT_LEDGER_MAX_BYTES = 8192;
/** 来源词表（#26）：每个来源都必须是真实挂上的生命周期事件，不预埋不会产生的来源。 */
export const EXIT_LEDGER_SOURCES = Object.freeze(["close", "quit", "render-crash", "uncaught", "exit"]);
/** 终结性来源：它们带的是应用自己的退出码，优先于子进程 close 与非终结事件。 */
export const EXIT_TERMINAL_SOURCES = Object.freeze(["quit", "exit"]);

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

function knownSource(value) {
  const source = typeof value === "string" ? value.trim() : "";
  return EXIT_LEDGER_SOURCES.includes(source) ? source : "";
}

function normalizeChain(raw, source) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const itemSource = knownSource(item);
    if (itemSource && !out.includes(itemSource)) out.push(itemSource);
  }
  if (out[0] !== source) {
    const without = out.filter((item) => item !== source);
    without.unshift(source);
    return without;
  }
  return out;
}

/**
 * 一条记录的形状校验。缺时间、时间不可解析、来源不在词表里都不算数 ——
 * 读侧宁可回答「无」，也不把半条记录当成一次真实退出。
 * 缺 chain / terminal / started_at / episode 的旧版（#25）记录照样有效：
 * chain 退化成单来源，terminal 由来源词表推断。
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
  const source = knownSource(raw.source);
  if (!source) return null;
  let startedAt = typeof raw.started_at === "string" ? raw.started_at.trim() : "";
  if (!startedAt || Number.isNaN(Date.parse(startedAt))) startedAt = at;
  let terminal = knownSource(raw.terminal);
  if (terminal && !EXIT_TERMINAL_SOURCES.includes(terminal)) terminal = "";
  if (!terminal && EXIT_TERMINAL_SOURCES.includes(source)) terminal = source;
  const detail = typeof raw.detail === "string" ? raw.detail.trim().slice(0, 200) : "";
  const episode = typeof raw.episode === "string" ? raw.episode.trim() : "";
  return {
    at,
    started_at: startedAt,
    code,
    signal,
    source,
    terminal: terminal || null,
    chain: normalizeChain(raw.chain, source),
    detail,
    episode,
  };
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
 * 同一 episode 的两条记录合成一条（纯函数，单测与宿主内联副本同口径）。
 * 规则见文件头：source 保留首因、chain 去重追加、终结性退出码先到者优先。
 */
export function mergeExitRecords(previous, next) {
  const chain = [...((previous && previous.chain) || [previous.source])];
  for (const source of (next && next.chain) || [next.source]) {
    if (!chain.includes(source)) chain.push(source);
  }
  const terminal = (previous && previous.terminal) || (next && next.terminal) || null;
  let code = previous ? previous.code : null;
  let signal = previous ? previous.signal : null;
  const nextIsTerminal = Boolean(next && next.terminal);
  const previousIsTerminal = Boolean(previous && previous.terminal);
  if (nextIsTerminal && !previousIsTerminal) {
    if (next.code !== null && next.code !== undefined) code = next.code;
    if (next.signal) signal = next.signal;
  } else {
    if ((code === null || code === undefined) && next && next.code !== null && next.code !== undefined) code = next.code;
    if (!signal && next && next.signal) signal = next.signal;
  }
  return {
    at: next.at,
    started_at: (previous && previous.started_at) || (previous && previous.at) || next.at,
    code: code === undefined ? null : code,
    signal: signal || null,
    source: previous ? previous.source : next.source,
    terminal,
    chain,
    detail: (previous && previous.detail) || (next && next.detail) || "",
    episode: (previous && previous.episode) || (next && next.episode) || "",
  };
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

let cachedEpisode = "";
/** 本进程的 episode 记号；插件内写入器与宿主内联副本各有一份（互不相干）。 */
function currentEpisode() {
  if (!cachedEpisode) cachedEpisode = "p" + process.pid + "@" + new Date().toISOString();
  return cachedEpisode;
}

/**
 * 写侧（插件内版本；同一套合并/滚动规则的内联副本在 core.js 补丁 #91）。
 * 绝不抛：写入失败只返回 { ok: false, error }，调用方据此旁听即可。
 * @param record { at?, code?, signal?, source?, detail?, episode? }
 * @param options.home DSH_HOME
 * @param options.episode 覆盖本进程 episode（单测用它模拟「另一次运行」）
 */
export function recordDesktopExit(record = {}, { home = "", episode = "" } = {}) {
  const file = exitLedgerFile(home);
  const out = { ok: false, file, count: 0, error: "" };
  if (!file) {
    out.error = "no DSH_HOME";
    return out;
  }
  try {
    const token = String(episode || record.episode || currentEpisode());
    const normalized = normalizeRecord({
      at: record.at || new Date().toISOString(),
      started_at: record.started_at || record.at,
      code: record.code === undefined ? null : record.code,
      signal: record.signal === undefined ? null : record.signal,
      source: record.source || "close",
      terminal: record.terminal,
      chain: record.chain,
      detail: record.detail,
      episode: token,
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
    const previous = lines.length > 0 ? normalizeRecord(parseJsonLine(lines[lines.length - 1])) : null;
    if (previous && previous.episode && previous.episode === token) {
      lines[lines.length - 1] = JSON.stringify(mergeExitRecords(previous, normalized));
    } else {
      lines.push(JSON.stringify(normalized));
    }
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
 * 多来源记录把原因链 / 终结来源 / 原因说明一起展示（#26），否则「一条能解释退出的记录」
 * 在读侧又退化成只剩最后一个词。
 */
export function describeDesktopExit(info) {
  const record = info && info.latest;
  if (!record) {
    if (info && info.reason === "unreadable") return "无 / none（留痕文件读不了：" + (info.error || "unknown") + "）";
    return "无 / none（还没有桌面退出留痕）";
  }
  const code = record.code === null || record.code === undefined ? "无" : String(record.code);
  const signal = record.signal ? String(record.signal) : "无";
  const chain = Array.isArray(record.chain) && record.chain.length > 0 ? record.chain : [record.source];
  const parts = ["code=" + code, "signal=" + signal, record.at, "来源=" + record.source];
  if (chain.length > 1) parts.push("链=" + chain.join("→"));
  if (record.terminal && record.terminal !== record.source) parts.push("终结=" + record.terminal);
  if (record.detail) parts.push("原因=" + record.detail);
  return parts.join(" · ");
}
