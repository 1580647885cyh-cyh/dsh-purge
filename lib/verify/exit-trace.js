import fs from "node:fs";
import path from "node:path";
import {
  EXIT_LEDGER_MAX_BYTES,
  EXIT_LEDGER_MAX_ENTRIES,
  describeDesktopExit,
  readLatestDesktopExit,
} from "../exit-ledger.js";

/**
 * 入口五的 close 回调 harness（A5 / #25）。
 *
 * 宿主 main.js 里那段留痕调用跑在模块作用域里（mkdirSync / readFileSync / homedir / ... 都是
 * import 进来的）；入口五只能用 new Function("resolve", body) 跑回调体，作用域里只有一个 resolve。
 * 所以这里做三件事：
 * 1. runCloseHandler 允许注入作用域（真 fs + 只带 DSH_HOME 的 process），让同一段生产代码
 *    真的写一条记录，再用 lib/exit-ledger.js 读回来；
 * 2. 核对留痕代码依赖的名字确实是宿主 main.js 的模块级 import —— 只注入不核对的话，
 *    「注入了所以能写」证明不了真机上也能写（宿主换成 fs.mkdirSync 时证据会全绿而留痕静默 no-op）；
 * 3. stripExitTrace：把生产路径上的那段留痕原样摘掉，同一套断言必须重新变红
 *    —— 否则「没炸」会被当成「留了痕」（CODING_STANDARDS #6）。
 */

const TRACE_MARKER = "[dsh-purge] desktop exit trace";
const TRACE_END = "desktop exit trace never blocks exit";

/** 留痕代码用到、必须由宿主 main.js 模块作用域提供的名字（其余是全局对象）。 */
const HOST_SCOPE_BINDINGS = Object.freeze({
  mkdirSync: "node:fs",
  readFileSync: "node:fs",
  writeFileSync: "node:fs",
  existsSync: "node:fs",
  homedir: "node:os",
});
const HOST_GLOBALS = new Set(["process", "Buffer", "JSON", "Date", "String", "Number", "Array", "Object"]);

/**
 * 取 close 回调整体（从 child.once("close", ... 的花括号开始配对），
 * 用它跑真实分支，而不是断言某一句注释在文件里。
 */
export function extractCloseHandler(text) {
  const source = String(text || "");
  const marker = 'child.once("close", (';
  const at = source.indexOf(marker);
  if (at < 0) return "";
  const open = source.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

/**
 * 宿主 main.js 在模块作用域里本来就有的那批名字 + 一个只带环境变量的 process。
 * @param home 这条假 DSH_HOME（留痕落在这里）
 * @param options.withFs 关掉后只留 process（证明没有 fs 作用域时回调安静跳过）
 * @param options.env 覆盖 process.env（默认 { DSH_HOME: home }）
 * @param options.userHome homedir() 的返回值（DSH_HOME 缺失时的兜底）
 */
export function closeHandlerScope(home, { withFs = true, env = { DSH_HOME: home }, userHome = path.dirname(home) } = {}) {
  const scope = { process: { env, platform: process.platform } };
  if (withFs) {
    scope.mkdirSync = fs.mkdirSync;
    scope.readFileSync = fs.readFileSync;
    scope.writeFileSync = fs.writeFileSync;
    scope.existsSync = fs.existsSync;
    scope.homedir = () => userHome;
  }
  return scope;
}

/**
 * 在隔离的 this 上跑 close 回调。
 * @param body 回调体（extractCloseHandler 的产物）
 * @param code 退出码（signal 退出时是 null）
 * @param options.signal 信号名；options.scope 宿主模块作用域里本来就有的名字（fs / process）
 */
export function runCloseHandler(body, code, options = {}) {
  const failed = [];
  let resolved = false;
  const names = ["resolve"];
  const args = [() => {
    resolved = true;
  }];
  for (const [name, value] of Object.entries(options.scope || {})) {
    names.push(name);
    args.push(value);
  }
  const factory = new Function(...names, "return function (code, signal) {" + body + "\n};");
  const handler = factory(...args);
  const self = { stderr: { trim: () => "" }, fail: (error) => failed.push(String(error && error.message ? error.message : error)) };
  handler.call(self, code, options.signal);
  return { resolved, failed, failedClean: code === 0 && failed.length === 0 };
}

/**
 * 把生产路径上的那段留痕摘掉（故障对照用）。
 * 找不到标记就返回空串：调用方会把「拔不掉」当成失败，而不是当成拔干净了。
 */
export function stripExitTrace(body) {
  const text = String(body || "");
  const markerAt = text.indexOf(TRACE_MARKER);
  if (markerAt < 0) return "";
  const endAt = text.indexOf(TRACE_END, markerAt);
  if (endAt < 0) return "";
  const lineStart = text.lastIndexOf("\n", markerAt) + 1;
  const lineEndAt = text.indexOf("\n", endAt);
  const lineEnd = lineEndAt < 0 ? text.length : lineEndAt + 1;
  return text.slice(0, lineStart) + text.slice(lineEnd);
}

/** 宿主文件里的 ESM 具名 import：模块 → 名字集合。 */
export function importedNames(text) {
  const out = new Map();
  const re = /import\s*\{([^}]*)\}\s*from\s*"([^"]+)";/g;
  for (const match of String(text || "").matchAll(re)) {
    const names = match[1].split(",").map((item) => item.trim().split(/\s+as\s+/).pop()).filter(Boolean);
    const set = out.get(match[2]) || new Set();
    for (const name of names) set.add(name);
    out.set(match[2], set);
  }
  return out;
}

/**
 * 留痕代码依赖的名字，哪些不是宿主 main.js 的模块级 import。
 * 名单从代码本身读（typeof X === "function"），所以换了写法也会被发现：
 * 例如宿主若改写成命名空间调用，那个命名空间既不是全局也没被 import，这里就报出来。
 */
export function missingScopeBindings(body, hostText) {
  const needed = new Set();
  for (const match of String(body || "").matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*===\s*"function"/g)) needed.add(match[1]);
  const imports = importedNames(hostText);
  const missing = [];
  for (const name of needed) {
    if (HOST_GLOBALS.has(name)) continue;
    const expectedModule = HOST_SCOPE_BINDINGS[name];
    if (expectedModule) {
      const set = imports.get(expectedModule) || new Set();
      if (!set.has(name)) missing.push(name + " ← " + expectedModule);
      continue;
    }
    const anywhere = [...imports.values()].some((set) => set.has(name));
    if (!anywhere) missing.push(name + " ← 任意模块");
  }
  return { needed: [...needed], missing };
}

function caseOf(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

function freshHome(scratch, name) {
  const home = path.join(scratch, name);
  fs.rmSync(home, { recursive: true, force: true });
  return home;
}

function sameRecord(record, want) {
  return Boolean(record)
    && record.code === want.code
    && record.signal === want.signal
    && record.source === "close"
    && Number.isNaN(Date.parse(record.at)) === false;
}

/**
 * 入口五的桌面退出留痕证明。
 *
 * @param patchedText 打完补丁的宿主壳入口全文
 * @param unpatchedText 未打补丁的同源入口（故障对照 + 模块作用域核对）
 * @param home 隔离 DSH_HOME —— 读侧那一趟真的写在这里，再用 purge_status 读回
 * @param scratchDir 前几趟用的临时目录（默认落在 home 旁边）
 * @param readStatus 返回 purge_status 文本的函数（真实工具；报告只截那一行）
 */
export async function proveExitTrace({ patchedText = "", unpatchedText = "", home = "", scratchDir = "", readStatus = null } = {}) {
  const record = {
    kind: "target-entry.exit-trace",
    ok: false,
    error: "",
    home,
    bound: { maxEntries: EXIT_LEDGER_MAX_ENTRIES, maxBytes: EXIT_LEDGER_MAX_BYTES },
    latest: null,
    statusLine: "",
    cases: [],
  };
  try {
    if (!home) {
      record.error = "没有隔离 DSH_HOME，读侧无从证明";
      return record;
    }
    const scratch = scratchDir || path.join(home, "dsh-purge-trace-scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const body = extractCloseHandler(patchedText);
    if (!body || !body.includes(TRACE_MARKER)) {
      record.error = "补丁产物里取不到 close 回调的留痕调用";
      return record;
    }

    // 1) 依赖名字在不在宿主 main.js 的模块作用域里 —— 注入 fs 之前先排除「真机根本没这批绑定」。
    const scopeCheck = missingScopeBindings(body, unpatchedText);
    record.cases.push(caseOf(
      "module-scope",
      scopeCheck.needed.length > 0 && scopeCheck.missing.length === 0,
      scopeCheck.needed.length === 0
        ? "找不到任何 typeof 守卫，无法核对接线"
        : (scopeCheck.missing.length > 0
          ? "宿主 main.js 缺这些绑定：" + scopeCheck.missing.join(", ")
          : "依赖名字都在宿主 main.js 的模块作用域里：" + scopeCheck.needed.join(",")),
    ));

    // 2) 三路退出各写一条。
    const paths = [
      { id: "close-code0", code: 0, signal: undefined, want: { code: 0, signal: null }, fails: 0 },
      { id: "close-code3", code: 3, signal: undefined, want: { code: 3, signal: null }, fails: 1 },
      { id: "close-signal", code: null, signal: "SIGTERM", want: { code: null, signal: "SIGTERM" }, fails: 0 },
    ];
    for (const item of paths) {
      const dir = freshHome(scratch, item.id);
      const run = runCloseHandler(body, item.code, { signal: item.signal, scope: closeHandlerScope(dir) });
      const info = readLatestDesktopExit({ home: dir });
      record.cases.push(caseOf(
        item.id,
        run.resolved && run.failed.length === item.fails && sameRecord(info.latest, item.want),
        "resolve=" + String(run.resolved) + " fail=" + run.failed.length
          + " · 记录 " + (info.found ? describeDesktopExit(info) : "无"),
      ));
    }

    // 3) 上界：宿主内联实现与本模块是两份代码，同一个滚动规则要在真 fs 上复测。
    const boundHome = freshHome(scratch, "bound");
    for (let i = 0; i < EXIT_LEDGER_MAX_ENTRIES + 10; i += 1) {
      runCloseHandler(body, i, { scope: closeHandlerScope(boundHome) });
    }
    const bound = readLatestDesktopExit({ home: boundHome });
    const boundBytes = bound.file && fs.existsSync(bound.file) ? fs.statSync(bound.file).size : 0;
    record.cases.push(caseOf(
      "bound",
      bound.count === EXIT_LEDGER_MAX_ENTRIES && bound.latest.code === EXIT_LEDGER_MAX_ENTRIES + 9 && boundBytes <= EXIT_LEDGER_MAX_BYTES,
      "写 " + (EXIT_LEDGER_MAX_ENTRIES + 10) + " 次留下 " + bound.count + " 条 / " + boundBytes + " 字节",
    ));

    // 4) 没有 DSH_HOME 时走 homedir()/.dsh：兜底分支也要真的能用（不是写了没人验证的一句）。
    const fallbackUserHome = freshHome(scratch, "user-home");
    const homeFallback = runCloseHandler(body, 7, {
      scope: closeHandlerScope(freshHome(scratch, "unused-home"), { env: {}, userHome: fallbackUserHome }),
    });
    const fallbackInfo = readLatestDesktopExit({ home: path.join(fallbackUserHome, ".dsh") });
    record.cases.push(caseOf(
      "home-fallback",
      homeFallback.resolved && sameRecord(fallbackInfo.latest, { code: 7, signal: null }),
      fallbackInfo.found
        ? "没有 DSH_HOME 时落到 homedir()/.dsh：" + describeDesktopExit(fallbackInfo)
        : "没有 DSH_HOME 时没有落记录",
    ));

    // 5) 没有 fs 作用域：安静跳过（宿主若把这段挪到别的模块，也不能炸）。
    const fallbackHome = freshHome(scratch, "scope-fallback");
    let fallback = null;
    let fallbackThrew = "";
    try {
      fallback = runCloseHandler(body, 0, { scope: closeHandlerScope(fallbackHome, { withFs: false }) });
    } catch (error) {
      fallbackThrew = String(error && error.message ? error.message : error);
    }
    const fallbackScopeInfo = readLatestDesktopExit({ home: fallbackHome });
    record.cases.push(caseOf(
      "scope-fallback",
      !fallbackThrew && Boolean(fallback && fallback.resolved) && fallbackScopeInfo.found === false,
      fallbackThrew ? "ReferenceError：" + fallbackThrew : "无 fs 作用域时安静跳过（未写记录）",
    ));

    // 6) 留痕目标不可写（这里是「文件位置被目录占住」）：不抛、不挡退出。
    const blockedHome = freshHome(scratch, "write-blocked");
    fs.mkdirSync(path.join(blockedHome, "dsh-purge", "exit-ledger.jsonl"), { recursive: true });
    let blocked = null;
    let blockedThrew = "";
    try {
      blocked = runCloseHandler(body, 0, { scope: closeHandlerScope(blockedHome) });
    } catch (error) {
      blockedThrew = String(error && error.message ? error.message : error);
    }
    record.cases.push(caseOf(
      "write-blocked",
      !blockedThrew && Boolean(blocked && blocked.resolved),
      blockedThrew ? "写不进去时炸了：" + blockedThrew : "留痕目标不可写时不抛（回调照常 resolve）",
    ));

    // 7) 读侧：真的写进隔离 DSH_HOME，再用 purge_status 读回来（同一个公共路径）。
    const readRun = runCloseHandler(body, 0, { scope: closeHandlerScope(home) });
    const readBack = readLatestDesktopExit({ home });
    record.latest = readBack.latest;
    let statusText = "";
    let statusError = "";
    if (typeof readStatus === "function") {
      try {
        statusText = String(await readStatus());
      } catch (error) {
        statusError = String(error && error.message ? error.message : error);
      }
    } else {
      statusError = "没有 purge_status 读取函数";
    }
    record.statusLine = statusText.split(/\r?\n/).find((line) => line.includes("最近一次桌面退出")) || "";
    // 判定用的是同一份描述函数（渲染侧也用它）：记录被写成什么样，状态行就得原样出现什么样。
    const expected = readBack.latest ? describeDesktopExit({ latest: readBack.latest }) : "";
    record.cases.push(caseOf(
      "read-side",
      readRun.resolved
        && Boolean(readBack.latest)
        && expected.length > 0
        && record.statusLine.includes("最近一次桌面退出")
        && record.statusLine.includes(expected),
      statusError
        ? "purge_status 读取失败：" + statusError
        : "status 行 " + JSON.stringify(record.statusLine || "（没有这一行）"),
    ));

    // 8) 两条拔痕对照：拔掉生产路径上的那一段必须没有记录；未打补丁的入口本来就没有。
    const stripped = stripExitTrace(body);
    const stripHome = freshHome(scratch, "control-stripped");
    if (stripped) runCloseHandler(stripped, 0, { scope: closeHandlerScope(stripHome) });
    const stripInfo = readLatestDesktopExit({ home: stripHome });
    record.cases.push(caseOf(
      "control-trace-removed",
      Boolean(stripped) && stripped.includes(TRACE_MARKER) === false && stripInfo.found === false,
      stripped
        ? "拔掉生产路径上的留痕后：没有记录"
        : "拔不掉留痕调用（标记对不上），对照不成立",
    ));

    const unpatchedBody = extractCloseHandler(unpatchedText);
    const unpatchedHome = freshHome(scratch, "control-unpatched");
    if (unpatchedBody) runCloseHandler(unpatchedBody, 0, { scope: closeHandlerScope(unpatchedHome) });
    const unpatchedInfo = readLatestDesktopExit({ home: unpatchedHome });
    record.cases.push(caseOf(
      "control-unpatched",
      Boolean(unpatchedBody) && unpatchedBody.includes(TRACE_MARKER) === false && unpatchedInfo.found === false,
      unpatchedBody ? "未打补丁的 close 回调：没有记录" : "未打补丁的入口里取不到 close 回调",
    ));

    record.ok = record.cases.every((item) => item.ok);
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
}
