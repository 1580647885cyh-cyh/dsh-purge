import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ALL_PATCHES, applyReplacementsToText } from "../../lib/core.js";
import {
  EXIT_LEDGER_MAX_BYTES,
  EXIT_LEDGER_MAX_ENTRIES,
  EXIT_LEDGER_SOURCES,
  describeDesktopExit,
  readLatestDesktopExit,
} from "../../lib/exit-ledger.js";
import {
  EXIT_TRACE_CLOSE_MARKER,
  EXIT_TRACE_SOURCES_BEGIN,
} from "../../lib/desktop-exit-trace.js";
import {
  closeHandlerScope,
  extractCloseHandler,
  extractExitSourcesBlock,
  fakeEmitter,
  importedNames,
  missingScopeBindings,
  proveExitTrace,
  runCloseHandler,
  runExitSources,
  stripExitTrace,
} from "../../lib/verify/exit-trace.js";
import { RC5_CLOSE } from "./desktop-close-fixture.js";
import { tempDir } from "./helpers.js";

/**
 * 入口五的桌面退出多来源 harness（A5-2 / #26）。
 *
 * 要证明五件事，缺一条都只能算「没炸」：
 * 1. #91 那段模块作用域代码在真 fs + 事件替身下，四个来源（quit / render-process-gone /
 *    uncaughtExceptionMonitor / exit）各落一条，来源字段可区分；
 * 2. 一次退出的多来源序列合成一条：chain 有序、source 记首因、quit 的退出码不被 exit 冲掉；
 * 3. 渲染崩溃只在 web-contents-created 单点挂一次（每页一个 render-process-gone），不挂
 *    uncaughtException 本体；
 * 4. 那段代码依赖的名字确实在宿主 main.js 的模块作用域里（只注入不核对 = 证据自造）；
 * 5. 把生产路径上的 close 调用拔掉之后，同一套断言必须重新变红。
 *
 * 宿主 main.js 的模块作用域（mkdirSync/app/...) 在 new Function 里不存在，
 * 所以这里显式把同一批依赖与一个只带 DSH_HOME 的 process 注进去。
 */

/** 宿主 main.js 真实那几行 import（0.2.1-rc.5；与安装目录里的字节一致）。 */
const HOST_IMPORTS = [
  'import { createRequire } from "node:module";',
  'import { BrowserWindow, Menu, Notification, Tray, WebContentsView, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, net, powerMonitor, protocol, session, shell, systemPreferences } from "electron";',
  'import { cpus, homedir, totalmem, userInfo } from "node:os";',
  'import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFile as readFile$1, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";',
].join("\n");

/** 等价壳入口：真实模块 import + rc.5 的 close 回调（#91 的锚点在 import 行上）。 */
const SHELL_FIXTURE = HOST_IMPORTS + "\n" + RC5_CLOSE;

/** 按生产顺序把 desktop-shell 的补丁全部打一遍（#83/#84 改写分支，#91 插来源，#90 接 close）。 */
function patchedText() {
  let text = SHELL_FIXTURE;
  let changed = false;
  for (const patch of ALL_PATCHES) {
    const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
    if (!keys.includes("desktop-shell")) continue;
    const applied = applyReplacementsToText(text, patch, "main.js");
    if (applied.text !== text) changed = true;
    text = applied.text;
  }
  assert.equal(changed, true, "close 回调必须被补丁认出");
  assert.ok(text.includes(EXIT_TRACE_SOURCES_BEGIN), "#91 的多来源块必须留下");
  assert.ok(text.includes(EXIT_TRACE_CLOSE_MARKER), "#90 的 close 调用必须留下");
  return text;
}

async function withHome(fn) {
  const dir = tempDir("exit-trace-");
  try {
    return await fn(path.join(dir, "home"), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function emitAll(run, { pid } = {}) {
  run.app.emit("quit", {}, 0);
  if (pid !== undefined) run.proc.pid = pid;
}

test("harness：四个来源各落一条，来源字段可区分", async () => {
  const text = patchedText();
  const block = extractExitSourcesBlock(text);
  assert.ok(block.length > 0, "要能取出 #91 的多来源块");
  await withHome(async (home, dir) => {
    const scratch = path.join(dir, "scratch");
    fs.mkdirSync(scratch, { recursive: true });

    const quitHome = path.join(scratch, "quit");
    const quitRun = runExitSources(block, { home: quitHome, pid: 5001 });
    quitRun.app.emit("quit", {}, 0);
    let info = readLatestDesktopExit({ home: quitHome });
    assert.equal(info.latest.source, "quit");
    assert.equal(info.latest.code, 0);
    assert.equal(info.latest.terminal, "quit");

    const crashHome = path.join(scratch, "crash");
    const crashRun = runExitSources(block, { home: crashHome, pid: 5002 });
    const contents = fakeEmitter();
    crashRun.app.emit("web-contents-created", {}, contents);
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 133 });
    info = readLatestDesktopExit({ home: crashHome });
    assert.equal(info.latest.source, "render-crash");
    assert.ok(info.latest.detail.includes("crashed"));
    assert.ok(info.latest.detail.includes("133"));

    const uncaughtHome = path.join(scratch, "uncaught");
    const uncaughtRun = runExitSources(block, { home: uncaughtHome, pid: 5003 });
    uncaughtRun.proc.emit("uncaughtExceptionMonitor", new Error("boom"), "uncaughtException");
    info = readLatestDesktopExit({ home: uncaughtHome });
    assert.equal(info.latest.source, "uncaught");
    assert.ok(info.latest.detail.includes("boom"));

    const exitHome = path.join(scratch, "exit");
    const exitRun = runExitSources(block, { home: exitHome, pid: 5004 });
    exitRun.proc.emit("exit", 7);
    info = readLatestDesktopExit({ home: exitHome });
    assert.equal(info.latest.source, "exit");
    assert.equal(info.latest.code, 7);

    assert.deepEqual([...EXIT_LEDGER_SOURCES], ["close", "quit", "render-crash", "uncaught", "exit"]);
  });
});

test("harness：渲染崩溃只在 web-contents-created 单点挂一次，不挂 uncaughtException 本体", async () => {
  const block = extractExitSourcesBlock(patchedText());
  await withHome(async (home) => {
    const run = runExitSources(block, { home, pid: 5005 });
    const a = fakeEmitter();
    const b = fakeEmitter();
    run.app.emit("web-contents-created", {}, a);
    run.app.emit("web-contents-created", {}, b);
    assert.equal(run.app.listenerCount("web-contents-created"), 1, "web-contents-created 只能挂一个");
    assert.equal(run.app.listenerCount("quit"), 1);
    assert.equal(run.app.listenerCount("render-process-gone"), 0, "不能把 render-process-gone 挂到 app 上");
    assert.equal(a.listenerCount("render-process-gone"), 1, "每个 WebContents 只挂一次");
    assert.equal(b.listenerCount("render-process-gone"), 1);
    assert.equal(run.proc.listenerCount("uncaughtExceptionMonitor"), 1);
    assert.equal(run.proc.listenerCount("exit"), 1);
    assert.equal(run.proc.listenerCount("uncaughtException"), 0, "不挂 uncaughtException 本体（会改变宿主退出行为）");
  });
});

test("harness：一次退出的多来源合成一条，chain 有序且 quit 的码不被后到的 exit 冲掉", async () => {
  const block = extractExitSourcesBlock(patchedText());
  await withHome(async (home) => {
    const run = runExitSources(block, { home, pid: 5006 });
    run.proc.emit("uncaughtExceptionMonitor", new Error("boom"), "uncaughtException");
    run.app.emit("quit", {}, 3);
    run.proc.emit("exit", 3);
    const info = readLatestDesktopExit({ home });
    assert.equal(info.count, 1, "一次退出只能留一条");
    assert.equal(info.latest.source, "uncaught", "source 记首因");
    assert.equal(info.latest.terminal, "quit");
    assert.equal(info.latest.code, 3);
    assert.deepEqual(info.latest.chain, ["uncaught", "quit", "exit"]);
    assert.ok(info.latest.detail.includes("boom"));
    const line = describeDesktopExit(info);
    assert.match(line, /链=uncaught→quit→exit/);
    assert.match(line, /终结=quit/);
  });
  await withHome(async (home) => {
    const run = runExitSources(block, { home, pid: 5007 });
    run.app.emit("quit", {}, 5);
    run.proc.emit("exit", 0);
    const info = readLatestDesktopExit({ home });
    assert.equal(info.count, 1);
    assert.equal(info.latest.code, 5, "quit 的退出码优先，exit 后到也不能冲成 0");
  });
});

test("harness：close 走生产路径，与 quit / exit 共用一个 episode", async () => {
  const text = patchedText();
  const body = extractCloseHandler(text);
  const block = extractExitSourcesBlock(text);
  await withHome(async (home) => {
    const run = runExitSources(block, { home, pid: 5008 });
    const closeRun = runCloseHandler(body, 0, { scope: closeHandlerScope(home, { recordExit: run.recordExit }) });
    assert.equal(closeRun.resolved, true);
    run.app.emit("quit", {}, 0);
    run.proc.emit("exit", 0);
    const info = readLatestDesktopExit({ home });
    assert.equal(info.count, 1);
    assert.equal(info.latest.source, "close");
    assert.equal(info.latest.terminal, "quit");
    assert.deepEqual(info.latest.chain, ["close", "quit", "exit"]);
  });
});

test("harness：code=0 / 非 0 / signal 三路 close 都落一条（共享写入器）", async () => {
  const text = patchedText();
  const body = extractCloseHandler(text);
  const block = extractExitSourcesBlock(text);
  const runs = [
    { code: 0, signal: undefined, want: { code: 0, signal: null }, fails: 0 },
    { code: 3, signal: undefined, want: { code: 3, signal: null }, fails: 1 },
    { code: null, signal: "SIGTERM", want: { code: null, signal: "SIGTERM" }, fails: 0 },
  ];
  for (const item of runs) {
    await withHome((home) => {
      const writer = runExitSources(block, { home, pid: 5010 });
      const result = runCloseHandler(body, item.code, { signal: item.signal, scope: closeHandlerScope(home, { recordExit: writer.recordExit }) });
      assert.equal(result.resolved, true, "三路都必须 resolve");
      assert.equal(result.failed.length, item.fails, "退出行为不能被留痕改掉");
      const info = readLatestDesktopExit({ home });
      assert.equal(info.found, true, "code=" + String(item.code) + " 必须留下记录");
      assert.equal(info.latest.source, "close");
      assert.equal(info.latest.code, item.want.code);
      assert.equal(info.latest.signal, item.want.signal);
      assert.equal(Number.isNaN(Date.parse(info.latest.at)), false);
    });
  }
});

test("harness：没有 DSH_HOME 时落到 homedir()/.dsh，记录照样成立", async () => {
  const block = extractExitSourcesBlock(patchedText());
  await withHome((home, dir) => {
    const userHome = path.join(dir, "user-home");
    const run = runExitSources(block, { home: "", userHome, pid: 5011 });
    run.app.emit("quit", {}, 7);
    const info = readLatestDesktopExit({ home: path.join(userHome, ".dsh") });
    assert.equal(info.found, true, "兜底分支也要真的能用");
    assert.equal(info.latest.code, 7);
    assert.equal(info.latest.source, "quit");
  });
});

test("harness：条数与字节上界在宿主内联实现里同样成立（多来源也压得住）", async () => {
  const block = extractExitSourcesBlock(patchedText());
  await withHome((home) => {
    for (let i = 0; i < EXIT_LEDGER_MAX_ENTRIES + 10; i += 1) {
      const run = runExitSources(block, { home, pid: 5100 + i });
      run.app.emit("quit", {}, i);
      run.proc.emit("exit", i);
    }
    const info = readLatestDesktopExit({ home });
    assert.equal(info.count, EXIT_LEDGER_MAX_ENTRIES, "30 次退出只能留上限条数");
    assert.equal(info.latest.code, EXIT_LEDGER_MAX_ENTRIES + 9);
    assert.deepEqual(info.latest.chain, ["quit", "exit"]);
    assert.ok(fs.statSync(info.file).size <= EXIT_LEDGER_MAX_BYTES);
  });
  await withHome((home) => {
    for (let i = 0; i < EXIT_LEDGER_MAX_ENTRIES; i += 1) {
      const run = runExitSources(block, { home, pid: 5200 + i });
      run.app.emit("quit", {}, 0);
      run.proc.emit("exit", 0);
      run.app.emit("quit", {}, 0); // 同一 episode 再触发一次，不新增行
    }
    const info = readLatestDesktopExit({ home });
    assert.equal(info.count, EXIT_LEDGER_MAX_ENTRIES);
    assert.ok(fs.statSync(info.file).size <= EXIT_LEDGER_MAX_BYTES);
  });
});

test("harness：没有 fs 作用域时不炸、也不写（兜底守卫是产物，删掉就红）", async () => {
  const text = patchedText();
  const body = extractCloseHandler(text);
  await withHome((home) => {
    let result = null;
    assert.doesNotThrow(() => {
      result = runCloseHandler(body, 0, { scope: closeHandlerScope(home, { withFs: false }) });
    });
    assert.equal(result.resolved, true);
    assert.equal(readLatestDesktopExit({ home }).found, false, "没有写入器时不许凭空出现记录");
  });
});

test("harness：留痕目标不可写时不抛、不挡退出", async () => {
  const block = extractExitSourcesBlock(patchedText());
  await withHome((home) => {
    fs.mkdirSync(path.join(home, "dsh-purge", "exit-ledger.jsonl"), { recursive: true });
    const run = runExitSources(block, { home, pid: 5300 });
    assert.doesNotThrow(() => {
      run.app.emit("quit", {}, 0);
    });
  });
});

test("依赖核对：留痕代码依赖的名字必须出现在宿主 main.js 的模块 import 里", () => {
  const text = patchedText();
  const body = extractCloseHandler(text);
  const block = extractExitSourcesBlock(text);
  const bare = missingScopeBindings(block + "\n" + body, RC5_CLOSE);
  assert.ok(bare.missing.length > 0, "没有 import 的骨架必须报缺绑定（否则这条核对会退化成空跑）");
  assert.ok(bare.missing.some((item) => item.startsWith("app")), "app 要按 electron 点名");
  assert.ok(bare.missing.some((item) => item.startsWith("mkdirSync")), "fs 名字要按模块点名");
  assert.equal(missingScopeBindings(block + "\n" + body, HOST_IMPORTS + "\n" + RC5_CLOSE).missing.length, 0, "宿主真实 import 必须齐全");
  assert.equal(importedNames(HOST_IMPORTS).get("electron").has("app"), true);
  // 宿主若把调用包成模块作用域里没有的名字，必须报出来（不能只核对已知那几个）。
  const renamed = block.replace(/typeof mkdirSync !== "function"/, 'typeof fsMkdirSync !== "function"');
  assert.ok(missingScopeBindings(renamed, HOST_IMPORTS).missing.some((item) => item.startsWith("fsMkdirSync")), "未导入的名字要被点出来");
});

test("故障对照：把 close 调用的 typeof 守卫与兜底 catch 都拆掉，无作用域那一趟必须红", async () => {
  // 生产代码的两层兜底：typeof 守卫（宿主作用域里没有写入器就不碰）与整段 try/catch。
  // 两层都拆掉时，入口五的 scope-fallback 必须变红 —— 否则「没炸」不能算「有兜底」。
  await withHome(async (home, dir) => {
    const text = patchedText();
    const body = extractCloseHandler(text);
    const knockedBody = body
      .replace(/if \(typeof dshPurgeRecordExit === "function"\)/, "if (true)")
      .replace("} catch (traceError) { /* [dsh-purge] desktop exit trace never blocks exit */ }", "} catch (traceError) { throw traceError; }");
    assert.notEqual(knockedBody, body, "两处兜底都要能被替换掉，否则这条对照退化成空跑");
    const record = await proveExitTrace({
      patchedText: text.replace(body, knockedBody),
      unpatchedText: RC5_CLOSE,
      home,
      scratchDir: path.join(dir, "scratch"),
      readStatus: () => "",
    });
    const fallback = record.cases.find((item) => item.id === "scope-fallback");
    assert.ok(fallback && fallback.ok === false, "没有作用域时必须炸出来，而不是安静跳过");
    assert.equal(record.ok, false);
  });
});

test("故障对照：拔掉 close 回调里那段调用，harness 就读不到 close 记录", async () => {
  const text = patchedText();
  const body = extractCloseHandler(text);
  const block = extractExitSourcesBlock(text);
  const stripped = stripExitTrace(body);
  assert.ok(stripped.length > 0, "要能从产物里精确摘掉那一段");
  assert.equal(stripped.includes(EXIT_TRACE_CLOSE_MARKER), false);
  assert.ok(stripped.includes("this.stderr.trim()"), "只拔留痕，close 回调其余部分留着");
  await withHome((home) => {
    const writer = runExitSources(block, { home, pid: 5400 });
    runCloseHandler(stripped, 0, { scope: closeHandlerScope(home, { recordExit: writer.recordExit }) });
    assert.equal(readLatestDesktopExit({ home }).found, false, "拔掉生产路径上的留痕后必须没有记录");
  });
});

test("故障对照：未打补丁的 close 回调本来就不写记录", async () => {
  const body = extractCloseHandler(RC5_CLOSE);
  assert.equal(body.includes("[dsh-purge] desktop exit trace"), false);
  await withHome((home) => {
    runCloseHandler(body, 0, { scope: closeHandlerScope(home) });
    assert.equal(readLatestDesktopExit({ home }).found, false);
  });
});

test("proveExitTrace：全部案例一起进记录", async () => {
  await withHome(async (home, dir) => {
    const readStatus = () => "dsh-purge 状态 / Status\n"
      + "· 最近一次桌面退出 / desktop exit: " + describeDesktopExit(readLatestDesktopExit({ home })) + "\n";
    const record = await proveExitTrace({
      patchedText: patchedText(),
      unpatchedText: HOST_IMPORTS + "\n" + RC5_CLOSE,
      home,
      scratchDir: path.join(dir, "scratch"),
      readStatus,
    });
    assert.equal(record.ok, true, JSON.stringify(record.cases.filter((item) => !item.ok)));
    const ids = record.cases.map((item) => item.id);
    for (const id of [
      "module-scope", "hook-single", "sources-scope-fallback", "source-exit-without-app",
      "hook-contents-guard", "no-home", "source-quit", "source-render-crash", "source-uncaught",
      "source-exit", "multi-source", "multi-source-no-overwrite", "close-then-quit",
      "close-code0", "close-code3", "close-signal", "bound", "home-fallback",
      "scope-fallback", "write-blocked", "read-side", "corrupt", "control-trace-removed", "control-unpatched",
    ]) {
      assert.ok(ids.includes(id), "缺案例：" + id);
    }
    assert.equal(record.latest.source, "quit");
    assert.deepEqual(record.latest.chain, ["quit", "exit"]);
    assert.ok(record.statusLine.includes("最近一次桌面退出"), "报告要能看到读侧那一行");
    assert.ok(record.statusLine.includes("链=quit→exit"), "状态行要能区分多来源");
    assert.deepEqual(record.bound, { maxEntries: EXIT_LEDGER_MAX_ENTRIES, maxBytes: EXIT_LEDGER_MAX_BYTES });
    assert.deepEqual(record.sources, [...EXIT_LEDGER_SOURCES]);
  });
});

test("proveExitTrace 故障对照：读侧读不到记录时必须红", async () => {
  await withHome(async (home, dir) => {
    const readStatus = () => "dsh-purge 状态 / Status\n· 最近一次桌面退出 / desktop exit: 无 / none（还没有桌面退出留痕）\n";
    const record = await proveExitTrace({
      patchedText: patchedText(),
      unpatchedText: HOST_IMPORTS + "\n" + RC5_CLOSE,
      home,
      scratchDir: path.join(dir, "scratch"),
      readStatus,
    });
    assert.equal(record.ok, false);
    const readSide = record.cases.find((item) => item.id === "read-side");
    assert.ok(readSide && readSide.ok === false, "读侧那一行没对上记录时必须红");
  });
});
