import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ALL_PATCHES, applyReplacementsToText } from "../../lib/core.js";
import {
  EXIT_LEDGER_MAX_BYTES,
  EXIT_LEDGER_MAX_ENTRIES,
  describeDesktopExit,
  readLatestDesktopExit,
} from "../../lib/exit-ledger.js";
import {
  closeHandlerScope,
  extractCloseHandler,
  importedNames,
  missingScopeBindings,
  proveExitTrace,
  runCloseHandler,
  stripExitTrace,
} from "../../lib/verify/exit-trace.js";
import { RC5_CLOSE } from "./desktop-close-fixture.js";
import { tempDir } from "./helpers.js";

/**
 * 入口五的 close 回调 harness（A5 / #25）。
 *
 * 要证明四件事，缺一条都只能算「没炸」：
 * 1. 补丁写进宿主 close 回调的那段留痕，在真 fs 作用域下真的会落一条记录（再用 exit-ledger 读回）；
 * 2. 那段代码依赖的名字确实在宿主 main.js 的模块作用域里（只注入不核对 = 证据自造）；
 * 3. 把生产路径上的那段拔掉之后，同一套断言必须重新变红；
 * 4. 没有 fs 作用域 / 写不进去 / 没有 DSH_HOME 时都不炸（兜底分支同样是产物）。
 *
 * 宿主 main.js 的模块作用域（mkdirSync/readFileSync/...) 在 new Function 里不存在，
 * 所以这里显式把同一批函数与一个只带 DSH_HOME 的 process 注进去。
 */

/** 按生产顺序把 desktop-shell 的补丁全部打一遍（#83/#84 先改写分支，#90 再落留痕）。 */
function patchedText() {
  let text = RC5_CLOSE;
  let changed = false;
  for (const patch of ALL_PATCHES) {
    const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
    if (!keys.includes("desktop-shell")) continue;
    const applied = applyReplacementsToText(text, patch, "main.js");
    if (applied.text !== text) changed = true;
    text = applied.text;
  }
  assert.equal(changed, true, "close 回调必须被补丁认出");
  assert.ok(text.includes("[dsh-purge] desktop exit trace"), "生产顺序下留痕必须留下");
  return text;
}

/** 宿主 main.js 真实那几行 import（0.2.1-rc.5；与安装目录里的字节一致）。 */
const HOST_IMPORTS = [
  'import { createRequire } from "node:module";',
  'import { cpus, homedir, totalmem, userInfo } from "node:os";',
  'import { appendFileSync, closeSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";',
].join("\n");

async function withHome(fn) {
  const dir = tempDir("exit-trace-");
  try {
    return await fn(path.join(dir, "home"), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("harness：code=0 / 非 0 / signal 三路都落一条 close 记录", async () => {
  const body = extractCloseHandler(patchedText());
  assert.ok(body.includes("[dsh-purge] desktop exit trace"), "要在补丁产物里取到留痕调用");
  const runs = [
    { code: 0, signal: undefined, want: { code: 0, signal: null }, fails: 0 },
    { code: 3, signal: undefined, want: { code: 3, signal: null }, fails: 1 },
    { code: null, signal: "SIGTERM", want: { code: null, signal: "SIGTERM" }, fails: 0 },
  ];
  for (const run of runs) {
    await withHome((home) => {
      const result = runCloseHandler(body, run.code, { signal: run.signal, scope: closeHandlerScope(home) });
      assert.equal(result.resolved, true, "三路都必须 resolve");
      assert.equal(result.failed.length, run.fails, "退出行为不能被留痕改掉");
      const info = readLatestDesktopExit({ home });
      assert.equal(info.found, true, "code=" + String(run.code) + " 必须留下记录");
      assert.equal(info.latest.code, run.want.code);
      assert.equal(info.latest.signal, run.want.signal);
      assert.equal(info.latest.source, "close");
      assert.equal(Number.isNaN(Date.parse(info.latest.at)), false);
    });
  }
});

test("harness：没有 DSH_HOME 时落到 homedir()/.dsh，记录照样成立", async () => {
  const body = extractCloseHandler(patchedText());
  await withHome((home, dir) => {
    const userHome = path.join(dir, "user-home");
    const run = runCloseHandler(body, 7, { scope: closeHandlerScope(home, { env: {}, userHome }) });
    assert.equal(run.resolved, true);
    const info = readLatestDesktopExit({ home: path.join(userHome, ".dsh") });
    assert.equal(info.found, true, "兜底分支也要真的能用");
    assert.equal(info.latest.code, 7);
    assert.equal(info.latest.source, "close");
  });
});

test("harness：条数与字节上界在宿主内联实现里同样成立", async () => {
  const body = extractCloseHandler(patchedText());
  await withHome((home) => {
    for (let i = 0; i < 30; i += 1) runCloseHandler(body, i, { scope: closeHandlerScope(home) });
    const info = readLatestDesktopExit({ home });
    assert.equal(info.count, EXIT_LEDGER_MAX_ENTRIES, "30 次退出只能留上限条数");
    assert.equal(info.latest.code, 29);
    assert.ok(fs.statSync(info.file).size <= EXIT_LEDGER_MAX_BYTES);
  });
  await withHome((home) => {
    for (let i = 0; i < EXIT_LEDGER_MAX_ENTRIES; i += 1) {
      runCloseHandler(body, 0, { signal: "S".repeat(600), scope: closeHandlerScope(home) });
    }
    const info = readLatestDesktopExit({ home });
    assert.ok(info.count < EXIT_LEDGER_MAX_ENTRIES, "字节超限时要少留几条");
    assert.ok(fs.statSync(info.file).size <= EXIT_LEDGER_MAX_BYTES);
  });
});

test("harness：没有 fs 作用域时不炸、也不写（兜底守卫是产物，删掉就红）", async () => {
  const body = extractCloseHandler(patchedText());
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
  const body = extractCloseHandler(patchedText());
  await withHome((home) => {
    fs.mkdirSync(path.join(home, "dsh-purge", "exit-ledger.jsonl"), { recursive: true });
    let result = null;
    assert.doesNotThrow(() => {
      result = runCloseHandler(body, 0, { scope: closeHandlerScope(home) });
    });
    assert.equal(result.resolved, true);
  });
});

test("依赖核对：留痕代码依赖的名字必须出现在宿主 main.js 的模块 import 里", () => {
  const body = extractCloseHandler(patchedText());
  const bare = missingScopeBindings(body, RC5_CLOSE);
  assert.ok(bare.missing.length > 0, "没有 import 的骨架必须报缺绑定（否则这条核对会退化成空跑）");
  assert.ok(bare.missing.some((item) => item.startsWith("mkdirSync")), "fs 名字要按模块点名");
  assert.equal(missingScopeBindings(body, HOST_IMPORTS + "\n" + RC5_CLOSE).missing.length, 0, "宿主真实 import 必须齐全");
  // 宿主若把调用包成模块作用域里没有的名字，必须报出来（不能只核对已知那五个）。
  const renamed = body.replace(/typeof mkdirSync === "function"/, 'typeof fsMkdirSync === "function"');
  assert.ok(missingScopeBindings(renamed, HOST_IMPORTS).missing.some((item) => item.startsWith("fsMkdirSync")), "未导入的名字要被点出来");
  assert.equal(importedNames(HOST_IMPORTS).get("node:fs").has("mkdirSync"), true);
});

test("故障对照：把 typeof 守卫与兜底 catch 都拆掉，无作用域那一趟必须红", async () => {
  // 生产代码的两层兜底：typeof 守卫（宿主作用域里没这批名字就不碰 I/O）与整段 try/catch。
  // 两层都拆掉时，入口五的 scope-fallback 必须变红 —— 否则「没炸」不能算「有兜底」。
  await withHome(async (home, dir) => {
    const text = patchedText();
    const knocked = text
      .replace(/if \(typeof mkdirSync === "function"[^\n]*\) \{/, "if (true) {")
      .replace("} catch (traceError) { /* [dsh-purge] desktop exit trace never blocks exit */ }", "} catch (traceError) { throw traceError; }");
    assert.notEqual(knocked, text, "两处兜底都要能被替换掉，否则这条对照退化成空跑");
    const record = await proveExitTrace({
      patchedText: knocked,
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

test("故障对照：拔掉 close 回调里那段留痕，harness 就读不到记录", async () => {
  const body = extractCloseHandler(patchedText());
  const stripped = stripExitTrace(body);
  assert.ok(stripped.length > 0, "要能从产物里精确摘掉那一段");
  assert.equal(stripped.includes("[dsh-purge] desktop exit trace"), false);
  assert.ok(stripped.includes("this.stderr.trim()"), "只拔留痕，close 回调其余部分留着");
  await withHome((home) => {
    runCloseHandler(stripped, 0, { scope: closeHandlerScope(home) });
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
      "module-scope", "close-code0", "close-code3", "close-signal", "bound", "home-fallback",
      "scope-fallback", "write-blocked", "read-side", "control-trace-removed", "control-unpatched",
    ]) {
      assert.ok(ids.includes(id), "缺案例：" + id);
    }
    assert.equal(record.latest.source, "close");
    assert.ok(record.statusLine.includes("最近一次桌面退出"), "报告要能看到读侧那一行");
    assert.ok(record.statusLine.includes(record.latest.at), "读侧那一行必须是这次写入的记录");
    assert.deepEqual(record.bound, { maxEntries: EXIT_LEDGER_MAX_ENTRIES, maxBytes: EXIT_LEDGER_MAX_BYTES });
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
