import fs from "node:fs";
import path from "node:path";
import {
  EXIT_LEDGER_MAX_BYTES,
  EXIT_LEDGER_MAX_ENTRIES,
  EXIT_LEDGER_SOURCES,
  describeDesktopExit,
  exitLedgerFile,
  readLatestDesktopExit,
} from "../exit-ledger.js";
import { EXIT_TRACE_SOURCES_BEGIN, EXIT_TRACE_SOURCES_END } from "../desktop-exit-trace.js";

/**
 * 入口五的桌面退出留痕 harness（A5-1 / #25，A5-2 / #26）。
 *
 * 宿主 main.js 里那段多来源留痕跑在模块作用域里（mkdirSync / readFileSync / homedir / app 都是
 * import 进来的）；入口五只能用 new Function 跑代码，作用域里只有我们注入的名字。
 * 所以这里做四件事：
 * 1. runExitSources 把模块作用域那段（#91）和 close 回调（#90）拼回同一个作用域：注入真 fs、
 *    一个只带 DSH_HOME 的 process、一个记录监听器的 app，再按时序 emit quit / render-process-gone /
 *    uncaughtExceptionMonitor / exit —— 四个来源各写一条，最后用 lib/exit-ledger.js 读回；
 * 2. 核对留痕代码依赖的名字确实是宿主 main.js 的模块级 import（app ← electron）；
 *    只注入不核对的话，「注入了所以能写」证明不了真机上也能写；
 * 3. stripExitTrace：把生产路径上的 close 调用摘掉，同一套断言必须重新变红；
 * 4. 多来源一次退出必须只剩一条记录：chain 记顺序、source 记首因、quit 的退出码不被后到的 exit 冲掉。
 */

const TRACE_MARKER = "[dsh-purge] desktop exit trace";
const TRACE_END = "desktop exit trace never blocks exit";

/** 留痕代码用到、必须由宿主 main.js 模块作用域提供的名字（其余是全局对象或本段自己声明的）。 */
const HOST_SCOPE_BINDINGS = Object.freeze({
  mkdirSync: "node:fs",
  readFileSync: "node:fs",
  writeFileSync: "node:fs",
  existsSync: "node:fs",
  homedir: "node:os",
  app: "electron",
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

/** 取 #91 那段模块作用域代码（起止标记之间的整段，含首尾注释行）。 */
export function extractExitSourcesBlock(text) {
  const source = String(text || "");
  const start = source.indexOf(EXIT_TRACE_SOURCES_BEGIN);
  if (start < 0) return "";
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const endAt = source.indexOf(EXIT_TRACE_SOURCES_END, start);
  if (endAt < 0) return "";
  const lineEndAt = source.indexOf("\n", endAt);
  return source.slice(lineStart, lineEndAt < 0 ? source.length : lineEndAt);
}

/** 一段代码自己声明了哪些名字（函数/变量）；这些不算「宿主模块作用域必须提供」。 */
function declaredNames(text) {
  const out = new Set();
  for (const match of String(text || "").matchAll(/(?:function|var|let|const)\s+([A-Za-z_$][\w$]*)/g)) out.add(match[1]);
  return out;
}

/**
 * 宿主 main.js 在模块作用域里本来就有的那批名字 + 一个只带环境变量的 process。
 * @param home 这条假 DSH_HOME（留痕落在这里）
 * @param options.withFs 关掉后只留 process（证明没有 fs 作用域时回调安静跳过）
 * @param options.env 覆盖 process.env（默认 { DSH_HOME: home }）
 * @param options.userHome homedir() 的返回值（DSH_HOME 缺失时的兜底）
 * @param options.recordExit 模块作用域里的共享写入器（close 回调只调它）
 */
export function closeHandlerScope(home, { withFs = true, env = { DSH_HOME: home }, userHome = path.dirname(home), recordExit = null } = {}) {
  const scope = { process: { env, platform: process.platform } };
  if (withFs) {
    scope.mkdirSync = fs.mkdirSync;
    scope.readFileSync = fs.readFileSync;
    scope.writeFileSync = fs.writeFileSync;
    scope.existsSync = fs.existsSync;
    scope.homedir = () => userHome;
  }
  if (typeof recordExit === "function") scope.dshPurgeRecordExit = recordExit;
  return scope;
}

/**
 * 在隔离的 this 上跑 close 回调。
 * @param body 回调体（extractCloseHandler 的产物）
 * @param code 退出码（signal 退出时是 null）
 * @param options.signal 信号名；options.scope 宿主模块作用域里本来就有的名字（fs / process / 写入器）
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

/** 极简事件替身：只记监听器、只按名字 emit（不替宿主做任何分发语义）。 */
export function fakeEmitter() {
  const listeners = new Map();
  return {
    on(name, handler) {
      const list = listeners.get(name) || [];
      list.push(handler);
      listeners.set(name, list);
      return this;
    },
    emit(name, ...args) {
      for (const handler of (listeners.get(name) || []).slice()) handler(...args);
    },
    listenerCount(name) {
      return (listeners.get(name) || []).length;
    },
    eventNames() {
      return [...listeners.keys()];
    },
  };
}

/**
 * 在真 fs 上求值 #91 那段模块作用域代码。
 * @returns {{recordExit: Function|null, app: object, proc: object, file: string}}
 *   app / proc 是事件替身：测试按宿主真实时序 emit，不靠直调写入器。
 */
export function runExitSources(block, { home = "", userHome = "", platform = process.platform, pid = 4242, withFs = true, withApp = true } = {}) {
  const app = fakeEmitter();
  const proc = Object.assign(fakeEmitter(), { env: home ? { DSH_HOME: home } : {}, platform, pid });
  const names = [];
  const args = [];
  if (withApp) {
    names.push("app");
    args.push(app);
  }
  names.push("process");
  args.push(proc);
  if (withFs) {
    names.push("mkdirSync", "readFileSync", "writeFileSync", "existsSync", "homedir");
    args.push(fs.mkdirSync, fs.readFileSync, fs.writeFileSync, fs.existsSync, () => userHome || (home ? path.dirname(home) : ""));
  }
  const factory = new Function(...names, String(block || "") + '\n;return { recordExit: typeof dshPurgeRecordExit === "function" ? dshPurgeRecordExit : null };');
  const out = factory(...args);
  return { ...out, app: withApp ? app : null, proc, file: home ? exitLedgerFile(home) : "" };
}

/**
 * 把生产路径上的那段 close 留痕摘掉（故障对照用）。
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
 * 留痕代码依赖的名字，哪些既不是宿主 main.js 的模块级 import、也不是本段自己声明的。
 * 名单从代码本身读（typeof X === "function" / "object"），所以换了写法也会被发现。
 */
export function missingScopeBindings(body, hostText, provided = []) {
  const local = new Set([...provided, ...declaredNames(body)]);
  const needed = new Set();
  for (const match of String(body || "").matchAll(/typeof\s+([A-Za-z_$][\w$]*)\s*[!=]==\s*"(?:function|object)"/g)) needed.add(match[1]);
  const imports = importedNames(hostText);
  const missing = [];
  for (const name of needed) {
    if (HOST_GLOBALS.has(name) || local.has(name)) continue;
    const expectedModule = HOST_SCOPE_BINDINGS[name];
    if (expectedModule) {
      const set = imports.get(expectedModule) || new Set();
      if (!set.has(name)) missing.push(name + " ← " + expectedModule);
      continue;
    }
    const anywhere = [...imports.values()].some((set) => set.has(name));
    if (!anywhere) missing.push(name + " ← 任意模块");
  }
  // needed 只留「宿主模块作用域必须提供」的名字：本段自己声明的（函数/变量）与全局对象不算证据。
  return { needed: [...needed].filter((name) => !HOST_GLOBALS.has(name) && !local.has(name)), missing };
}

function caseOf(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

function freshHome(scratch, name) {
  const home = path.join(scratch, name);
  fs.rmSync(home, { recursive: true, force: true });
  return home;
}

function sourceRecord(info, source) {
  return Boolean(info.latest) && info.latest.source === source;
}

function chainOf(info) {
  return info && info.latest && Array.isArray(info.latest.chain) ? info.latest.chain : [];
}

/**
 * 入口五的桌面退出多来源证明。
 *
 * @param patchedText 打完补丁的宿主壳入口全文
 * @param unpatchedText 未打补丁的同源入口（故障对照 + 模块作用域核对）
 * @param home 隔离 DSH_HOME —— 读侧那一趟真的写在这里，再用 purge_status 读回
 * @param scratchDir 各趟用的临时目录（默认落在 home 旁边）
 * @param readStatus 返回 purge_status 文本的函数（真实工具；报告只截那一行）
 */
export async function proveExitTrace({ patchedText = "", unpatchedText = "", home = "", scratchDir = "", readStatus = null } = {}) {
  const record = {
    kind: "target-entry.exit-trace",
    ok: false,
    error: "",
    home,
    bound: { maxEntries: EXIT_LEDGER_MAX_ENTRIES, maxBytes: EXIT_LEDGER_MAX_BYTES },
    sources: [...EXIT_LEDGER_SOURCES],
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
    const block = extractExitSourcesBlock(patchedText);
    if (!block || !block.includes(EXIT_TRACE_SOURCES_BEGIN) || !block.includes(EXIT_TRACE_SOURCES_END)) {
      record.error = "补丁产物里取不到多来源留痕块（#91）";
      return record;
    }

    // 1) 依赖名字在不在宿主 main.js 的模块作用域里 —— 注入 fs/app 之前先排除「真机根本没这批绑定」。
    const scopeCheck = missingScopeBindings(block + "\n" + body, unpatchedText, declaredNames(block));
    record.cases.push(caseOf(
      "module-scope",
      scopeCheck.needed.length > 0 && scopeCheck.missing.length === 0,
      scopeCheck.needed.length === 0
        ? "找不到任何 typeof 守卫，无法核对接线"
        : (scopeCheck.missing.length > 0
          ? "宿主 main.js 缺这些绑定：" + scopeCheck.missing.join(", ")
          : "依赖名字都在宿主 main.js 的模块作用域里：" + scopeCheck.needed.join(",")),
    ));

    // 2) 挂点：web-contents-created 只挂一次；不挂 uncaughtException 本体。
    const hookHome = freshHome(scratch, "hook-single");
    const hookRun = runExitSources(block, { home: hookHome, pid: 4101 });
    const contentsA = fakeEmitter();
    const contentsB = fakeEmitter();
    hookRun.app.emit("web-contents-created", {}, contentsA);
    hookRun.app.emit("web-contents-created", {}, contentsB);
    const hookCounts = {
      quit: hookRun.app.listenerCount("quit"),
      contentsCreated: hookRun.app.listenerCount("web-contents-created"),
      renderOnApp: hookRun.app.listenerCount("render-process-gone"),
      uncaughtMonitor: hookRun.proc.listenerCount("uncaughtExceptionMonitor"),
      uncaughtBody: hookRun.proc.listenerCount("uncaughtException"),
      exit: hookRun.proc.listenerCount("exit"),
      renderA: contentsA.listenerCount("render-process-gone"),
      renderB: contentsB.listenerCount("render-process-gone"),
    };
    record.cases.push(caseOf(
      "hook-single",
      hookCounts.quit === 1
        && hookCounts.contentsCreated === 1
        && hookCounts.renderOnApp === 0
        && hookCounts.uncaughtMonitor === 1
        && hookCounts.uncaughtBody === 0
        && hookCounts.exit === 1
        && hookCounts.renderA === 1
        && hookCounts.renderB === 1,
      "quit=" + hookCounts.quit + " web-contents-created=" + hookCounts.contentsCreated
        + " 每页 render-process-gone=" + hookCounts.renderA + "/" + hookCounts.renderB
        + " uncaughtExceptionMonitor=" + hookCounts.uncaughtMonitor + " uncaughtException=" + hookCounts.uncaughtBody
        + " exit=" + hookCounts.exit,
    ));

    // 3) 守卫也是产物：app / fs / contents 不在作用域或形状不对时，安静跳过而不是炸。
    const sourcesScopeHome = freshHome(scratch, "sources-scope-fallback");
    let sourcesScopeThrew = "";
    try {
      const run = runExitSources(block, { home: sourcesScopeHome, pid: 4109, withFs: false });
      run.app.emit("quit", {}, 0);
      run.proc.emit("exit", 0);
    } catch (error) {
      sourcesScopeThrew = String(error && error.message ? error.message : error);
    }
    const sourcesScopeInfo = readLatestDesktopExit({ home: sourcesScopeHome });
    record.cases.push(caseOf(
      "sources-scope-fallback",
      !sourcesScopeThrew && sourcesScopeInfo.found === false,
      sourcesScopeThrew ? "没有 fs 作用域时写入器炸了：" + sourcesScopeThrew : "没有 fs 作用域时四个来源都安静跳过（未写记录）",
    ));

    const appMissingHome = freshHome(scratch, "source-exit-without-app");
    let appMissingThrew = "";
    try {
      const run = runExitSources(block, { home: appMissingHome, pid: 4110, withApp: false });
      run.proc.emit("exit", 2);
    } catch (error) {
      appMissingThrew = String(error && error.message ? error.message : error);
    }
    const appMissingInfo = readLatestDesktopExit({ home: appMissingHome });
    record.cases.push(caseOf(
      "source-exit-without-app",
      !appMissingThrew && sourceRecord(appMissingInfo, "exit") && appMissingInfo.latest.code === 2,
      appMissingThrew ? "没有 app 作用域时炸了：" + appMissingThrew : "没有 app 作用域时进程来源照常落记录",
    ));

    const contentsGuardHome = freshHome(scratch, "hook-contents-guard");
    let contentsGuardThrew = "";
    try {
      const run = runExitSources(block, { home: contentsGuardHome, pid: 4111 });
      run.app.emit("web-contents-created", {}, {});
      run.app.emit("web-contents-created", {}, null);
    } catch (error) {
      contentsGuardThrew = String(error && error.message ? error.message : error);
    }
    const contentsGuardInfo = readLatestDesktopExit({ home: contentsGuardHome });
    record.cases.push(caseOf(
      "hook-contents-guard",
      !contentsGuardThrew && contentsGuardInfo.found === false,
      contentsGuardThrew ? "contents 形状不对时炸了：" + contentsGuardThrew : "contents 没有 on() 时安静跳过（未写记录）",
    ));

    let noHomeThrew = "";
    let noHomeFile = "not-run";
    try {
      const run = runExitSources(block, { home: "", userHome: "", pid: 4112 });
      noHomeFile = run.file;
      run.app.emit("quit", {}, 0);
    } catch (error) {
      noHomeThrew = String(error && error.message ? error.message : error);
    }
    record.cases.push(caseOf(
      "no-home",
      !noHomeThrew && noHomeFile === "",
      noHomeThrew ? "没有 DSH_HOME 也没有 homedir 时炸了：" + noHomeThrew : "没有可用 home 时写入器直接返回（未写记录）",
    ));

    // 4) 四个来源各写一条，来源字段可区分。
    const quitHome = freshHome(scratch, "source-quit");
    const quitRun = runExitSources(block, { home: quitHome, pid: 4102 });
    quitRun.app.emit("quit", {}, 0);
    const quitInfo = readLatestDesktopExit({ home: quitHome });
    record.cases.push(caseOf(
      "source-quit",
      sourceRecord(quitInfo, "quit") && quitInfo.latest.code === 0 && quitInfo.latest.terminal === "quit",
      quitInfo.found ? describeDesktopExit(quitInfo) : "quit 没有留下记录",
    ));

    const crashHome = freshHome(scratch, "source-render-crash");
    const crashRun = runExitSources(block, { home: crashHome, pid: 4103 });
    const crashContents = fakeEmitter();
    crashRun.app.emit("web-contents-created", {}, crashContents);
    crashContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
    const crashInfo = readLatestDesktopExit({ home: crashHome });
    record.cases.push(caseOf(
      "source-render-crash",
      sourceRecord(crashInfo, "render-crash")
        && crashInfo.latest.detail.includes("crashed")
        && crashInfo.latest.detail.includes("133"),
      crashInfo.found ? describeDesktopExit(crashInfo) : "渲染进程消失没有留下记录",
    ));

    const uncaughtHome = freshHome(scratch, "source-uncaught");
    const uncaughtRun = runExitSources(block, { home: uncaughtHome, pid: 4104 });
    uncaughtRun.proc.emit("uncaughtExceptionMonitor", new Error("boom"), "uncaughtException");
    const uncaughtInfo = readLatestDesktopExit({ home: uncaughtHome });
    record.cases.push(caseOf(
      "source-uncaught",
      sourceRecord(uncaughtInfo, "uncaught")
        && uncaughtInfo.latest.detail.includes("boom")
        && uncaughtInfo.latest.detail.includes("uncaughtException"),
      uncaughtInfo.found ? describeDesktopExit(uncaughtInfo) : "uncaughtExceptionMonitor 没有留下记录",
    ));

    const exitHome = freshHome(scratch, "source-exit");
    const exitRun = runExitSources(block, { home: exitHome, pid: 4105 });
    exitRun.proc.emit("exit", 7);
    const exitInfo = readLatestDesktopExit({ home: exitHome });
    record.cases.push(caseOf(
      "source-exit",
      sourceRecord(exitInfo, "exit") && exitInfo.latest.code === 7,
      exitInfo.found ? describeDesktopExit(exitInfo) : "process exit 没有留下记录",
    ));

    // 4) 一次退出的多来源序列：合成一条、chain 有序、source 记首因、quit 的码不被 exit 冲掉。
    const multiHome = freshHome(scratch, "multi-source");
    const multiRun = runExitSources(block, { home: multiHome, pid: 4106 });
    multiRun.proc.emit("uncaughtExceptionMonitor", new Error("boom"), "uncaughtException");
    multiRun.app.emit("quit", {}, 3);
    multiRun.proc.emit("exit", 3);
    const multiInfo = readLatestDesktopExit({ home: multiHome });
    const multiChain = chainOf(multiInfo);
    record.cases.push(caseOf(
      "multi-source",
      multiInfo.count === 1
        && sourceRecord(multiInfo, "uncaught")
        && multiInfo.latest.terminal === "quit"
        && multiInfo.latest.code === 3
        && multiChain.join("→") === "uncaught→quit→exit",
      "记录 " + multiInfo.count + " 条 · " + (multiInfo.found ? describeDesktopExit(multiInfo) : "无"),
    ));

    const noOverwriteHome = freshHome(scratch, "multi-source-code");
    const noOverwriteRun = runExitSources(block, { home: noOverwriteHome, pid: 4107 });
    noOverwriteRun.app.emit("quit", {}, 5);
    noOverwriteRun.proc.emit("exit", 0);
    const noOverwriteInfo = readLatestDesktopExit({ home: noOverwriteHome });
    record.cases.push(caseOf(
      "multi-source-no-overwrite",
      noOverwriteInfo.count === 1 && noOverwriteInfo.latest.code === 5,
      "quit=5 → exit=0 后记录 " + (noOverwriteInfo.found ? describeDesktopExit(noOverwriteInfo) : "无"),
    ));

    // 5) close 走生产路径（close 回调）与其余来源共用一个 episode。
    const closeMultiHome = freshHome(scratch, "close-then-quit");
    const closeMultiRun = runExitSources(block, { home: closeMultiHome, pid: 4108 });
    runCloseHandler(body, 0, { scope: closeHandlerScope(closeMultiHome, { recordExit: closeMultiRun.recordExit }) });
    closeMultiRun.app.emit("quit", {}, 0);
    closeMultiRun.proc.emit("exit", 0);
    const closeMultiInfo = readLatestDesktopExit({ home: closeMultiHome });
    record.cases.push(caseOf(
      "close-then-quit",
      closeMultiInfo.count === 1
        && sourceRecord(closeMultiInfo, "close")
        && closeMultiInfo.latest.terminal === "quit"
        && chainOf(closeMultiInfo).join("→") === "close→quit→exit",
      "记录 " + closeMultiInfo.count + " 条 · " + (closeMultiInfo.found ? describeDesktopExit(closeMultiInfo) : "无"),
    ));

    // 6) close 三路各自落一条（与 A5-1 相同的断言，写入器换成共享的）。
    const paths = [
      { id: "close-code0", code: 0, signal: undefined, want: { code: 0, signal: null }, fails: 0 },
      { id: "close-code3", code: 3, signal: undefined, want: { code: 3, signal: null }, fails: 1 },
      { id: "close-signal", code: null, signal: "SIGTERM", want: { code: null, signal: "SIGTERM" }, fails: 0 },
    ];
    for (const item of paths) {
      const dir = freshHome(scratch, item.id);
      const writer = runExitSources(block, { home: dir, pid: 4110 });
      const run = runCloseHandler(body, item.code, { signal: item.signal, scope: closeHandlerScope(dir, { recordExit: writer.recordExit }) });
      const info = readLatestDesktopExit({ home: dir });
      record.cases.push(caseOf(
        item.id,
        run.resolved && run.failed.length === item.fails && sourceRecord(info, "close")
          && info.latest.code === item.want.code && info.latest.signal === item.want.signal,
        "resolve=" + String(run.resolved) + " fail=" + run.failed.length
          + " · 记录 " + (info.found ? describeDesktopExit(info) : "无"),
      ));
    }

    // 7) 上界：宿主内联实现与本模块是两份代码，同一个滚动规则要在真 fs 上复测（多来源也压得住）。
    const boundHome = freshHome(scratch, "bound");
    for (let i = 0; i < EXIT_LEDGER_MAX_ENTRIES + 10; i += 1) {
      const run = runExitSources(block, { home: boundHome, pid: 4200 + i });
      run.app.emit("quit", {}, i);
      run.proc.emit("exit", i);
    }
    const bound = readLatestDesktopExit({ home: boundHome });
    const boundBytes = bound.file && fs.existsSync(bound.file) ? fs.statSync(bound.file).size : 0;
    record.cases.push(caseOf(
      "bound",
      bound.count === EXIT_LEDGER_MAX_ENTRIES && bound.latest.code === EXIT_LEDGER_MAX_ENTRIES + 9 && boundBytes <= EXIT_LEDGER_MAX_BYTES,
      "写 " + (EXIT_LEDGER_MAX_ENTRIES + 10) + " 次留下 " + bound.count + " 条 / " + boundBytes + " 字节",
    ));

    // 8) 没有 DSH_HOME 时走 homedir()/.dsh：兜底分支也要真的能用（不是写了没人验证的一句）。
    const fallbackUserHome = freshHome(scratch, "user-home");
    const homeFallback = runExitSources(block, { home: "", userHome: fallbackUserHome, pid: 4300 });
    homeFallback.app.emit("quit", {}, 7);
    const fallbackInfo = readLatestDesktopExit({ home: path.join(fallbackUserHome, ".dsh") });
    record.cases.push(caseOf(
      "home-fallback",
      sourceRecord(fallbackInfo, "quit") && fallbackInfo.latest.code === 7,
      fallbackInfo.found
        ? "没有 DSH_HOME 时落到 homedir()/.dsh：" + describeDesktopExit(fallbackInfo)
        : "没有 DSH_HOME 时没有落记录",
    ));

    // 9) 没有 fs 作用域：安静跳过（宿主若把这段挪到别的模块，也不能炸）。
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

    // 10) 留痕目标不可写（这里是「文件位置被目录占住」）：不抛、不挡退出。
    const blockedHome = freshHome(scratch, "write-blocked");
    fs.mkdirSync(path.join(blockedHome, "dsh-purge", "exit-ledger.jsonl"), { recursive: true });
    let blockedThrew = "";
    try {
      const blockedRun = runExitSources(block, { home: blockedHome, pid: 4301 });
      blockedRun.app.emit("quit", {}, 0);
    } catch (error) {
      blockedThrew = String(error && error.message ? error.message : error);
    }
    record.cases.push(caseOf(
      "write-blocked",
      !blockedThrew,
      blockedThrew ? "写不进去时炸了：" + blockedThrew : "留痕目标不可写时不抛（quit 监听器照常返回）",
    ));

    // 11) 读侧：真的写进隔离 DSH_HOME，再用 purge_status 读回来（同一个公共路径）。
    const readRun = runExitSources(block, { home, pid: 4302 });
    readRun.app.emit("quit", {}, 0);
    readRun.proc.emit("exit", 0);
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
      Boolean(readBack.latest)
        && expected.length > 0
        && record.statusLine.includes("最近一次桌面退出")
        && record.statusLine.includes(expected),
      statusError
        ? "purge_status 读取失败：" + statusError
        : "status 行 " + JSON.stringify(record.statusLine || "（没有这一行）"),
    ));

    // 12) 损坏/半写记录：多来源写入不抛，读侧跳过坏行。
    const corruptHome = freshHome(scratch, "corrupt");
    fs.mkdirSync(path.join(corruptHome, "dsh-purge"), { recursive: true });
    fs.writeFileSync(exitLedgerFile(corruptHome), '{"at":"nope"}\n{ half\n', "utf8");
    let corruptThrew = "";
    try {
      const corruptRun = runExitSources(block, { home: corruptHome, pid: 4303 });
      corruptRun.proc.emit("uncaughtExceptionMonitor", new Error("kept"), "uncaughtException");
      corruptRun.app.emit("quit", {}, 0);
      corruptRun.proc.emit("exit", 0);
    } catch (error) {
      corruptThrew = String(error && error.message ? error.message : error);
    }
    const corruptInfo = readLatestDesktopExit({ home: corruptHome });
    record.cases.push(caseOf(
      "corrupt",
      !corruptThrew && sourceRecord(corruptInfo, "uncaught") && corruptInfo.count === 1 && chainOf(corruptInfo).length === 3,
      corruptThrew ? "坏文件把写入炸了：" + corruptThrew : (corruptInfo.found ? describeDesktopExit(corruptInfo) : "坏文件后没有记录"),
    ));

    // 13) 两条拔痕对照：拔掉生产路径上的那一段必须没有记录；未打补丁的入口本来就没有。
    const stripped = stripExitTrace(body);
    const stripHome = freshHome(scratch, "control-stripped");
    if (stripped) {
      const stripWriter = runExitSources(block, { home: stripHome, pid: 4304 });
      runCloseHandler(stripped, 0, { scope: closeHandlerScope(stripHome, { recordExit: stripWriter.recordExit }) });
    }
    const stripInfo = readLatestDesktopExit({ home: stripHome });
    record.cases.push(caseOf(
      "control-trace-removed",
      Boolean(stripped) && stripped.includes(TRACE_MARKER) === false && stripInfo.found === false,
      stripped
        ? "拔掉生产路径上的 close 留痕后：没有记录"
        : "拔不掉 close 留痕调用（标记对不上），对照不成立",
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
