import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  EXIT_LEDGER_MAX_BYTES,
  EXIT_LEDGER_MAX_ENTRIES,
  EXIT_LEDGER_SOURCES,
  EXIT_TERMINAL_SOURCES,
  describeDesktopExit,
  exitLedgerFile,
  mergeExitRecords,
  readLatestDesktopExit,
  recordDesktopExit,
} from "../../lib/exit-ledger.js";
import { renderStatus } from "../../lib/index.js";
import { tempDir } from "../verify/helpers.js";

/**
 * 桌面退出留痕（A5-2 / #26）。
 *
 * 这一组只测读写契约：一条记录里有什么、什么时候算「无」、多来源怎么合成一条、写多了会不会无限长。
 * 「宿主四个来源真的会写」由入口五的 harness 证明（lib/verify/exit-trace.js）——
 * 这里直调写入器只当补充证据，不当生产路径的证据（CODING_STANDARDS #6）。
 *
 * 多来源规则（与宿主内联副本同一份契约）：
 * 1. 一次进程运行（episode）内的来源合成一条记录，不追加第二行；
 * 2. source 记第一个来源，chain 按触发顺序去重；
 * 3. 终结性来源（quit / exit）的退出码优先，且先到者优先：后到的 exit 不会把 quit 的码冲成 null；
 * 4. 非终结来源只补空位，不覆盖已经有值的码。
 */

function at(iso, extra = {}) {
  return { at: iso, code: 0, signal: null, source: "close", ...extra };
}

function readLinesDir(home) {
  return readLatestDesktopExit({ home });
}

test("桌面退出留痕：没有记录时读侧给一句明确的「无」，不是空白", () => {
  const dir = tempDir("exit-ledger-empty-");
  try {
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.found, false);
    assert.equal(info.latest, null);
    assert.equal(info.file, exitLedgerFile(dir));
    assert.match(info.reason, /missing|unreadable/, "缺席要有原因，不只是一个空值");
    const text = describeDesktopExit(info);
    assert.match(text, /无/, "没有记录时必须写「无」");
    assert.ok(text.trim().length > 1, "不能是空白串");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：来源词表覆盖 close / quit / render-crash / uncaught / exit", () => {
  assert.deepEqual([...EXIT_LEDGER_SOURCES], ["close", "quit", "render-crash", "uncaught", "exit"]);
  assert.deepEqual([...EXIT_TERMINAL_SOURCES], ["quit", "exit"], "只有应用自己的退出事件算终结性来源");
});

test("桌面退出留痕：纯合并函数——首因/chain/终结码三条规则各自可验", () => {
  const base = (extra) => ({ at: "2026-01-01T00:00:00.000Z", started_at: "2026-01-01T00:00:00.000Z", code: null, signal: null, source: "close", terminal: null, chain: ["close"], detail: "", episode: "run-a", ...extra });
  const merged = mergeExitRecords(base({ code: 0, signal: "SIGTERM" }), base({ at: "2026-01-01T00:00:01.000Z", started_at: "2026-01-01T00:00:01.000Z", code: 3, source: "quit", terminal: "quit", chain: ["quit"] }));
  assert.equal(merged.source, "close", "先到的来源是原因链起点");
  assert.equal(merged.terminal, "quit");
  assert.equal(merged.code, 3, "终结性来源的码覆盖非终结来源的码");
  assert.equal(merged.signal, "SIGTERM", "signal 不因为后到来源没有值就被清掉");
  assert.deepEqual(merged.chain, ["close", "quit"]);
  assert.equal(merged.started_at, "2026-01-01T00:00:00.000Z");
  assert.equal(merged.at, "2026-01-01T00:00:01.000Z");
  const noClobber = mergeExitRecords(base({ code: 3, source: "quit", terminal: "quit", chain: ["quit"] }), base({ at: "2026-01-01T00:00:02.000Z", code: 0, source: "exit", terminal: "exit", chain: ["exit"] }));
  assert.equal(noClobber.code, 3, "先到的终结码优先，后到的 exit 不能冲掉");
  assert.deepEqual(noClobber.chain, ["quit", "exit"]);
});

test("桌面退出留痕：一条 close 记录带 code / signal / 时间 / 来源，落在 DSH_HOME/dsh-purge/", () => {
  const dir = tempDir("exit-ledger-one-");
  try {
    const written = recordDesktopExit({ code: 0, signal: null, source: "close" }, { home: dir, episode: "run-1" });
    assert.equal(written.ok, true);
    assert.equal(written.file, path.join(dir, "dsh-purge", "exit-ledger.jsonl"));
    assert.ok(fs.existsSync(written.file), "记录要真的落盘");
    const lines = fs.readFileSync(written.file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const raw = JSON.parse(lines[0]);
    assert.equal(raw.code, 0);
    assert.equal(raw.signal, null);
    assert.equal(raw.source, "close");
    assert.equal(raw.episode, "run-1");
    assert.deepEqual(raw.chain, ["close"]);
    assert.equal(typeof raw.at, "string");
    assert.equal(Number.isNaN(Date.parse(raw.at)), false, "时间必须可解析");

    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.found, true);
    assert.equal(info.latest.source, "close");
    assert.equal(info.latest.code, 0);
    assert.equal(info.latest.signal, null);
    assert.equal(info.latest.at, raw.at);
    assert.deepEqual(info.latest.chain, ["close"]);
    assert.equal(info.count, 1);
    const text = describeDesktopExit(info);
    assert.match(text, /code=0/);
    assert.match(text, /来源=close/);
    assert.match(text, /signal=无/, "没有 signal 时写「无」，不是 null 或空白");
    assert.ok(text.includes(raw.at), "描述里要能看到时间");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：signal 退出也记一条，code 为 null 不丢", () => {
  const dir = tempDir("exit-ledger-signal-");
  try {
    recordDesktopExit({ code: null, signal: "SIGTERM", source: "close" }, { home: dir, episode: "run-1" });
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.latest.code, null);
    assert.equal(info.latest.signal, "SIGTERM");
    assert.equal(info.latest.source, "close");
    const text = describeDesktopExit(info);
    assert.match(text, /signal=SIGTERM/);
    assert.match(text, /code=无|null/, "没有 code 时也要写清楚（不接受空白）");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：四个来源各自可区分（quit / render-crash / uncaught / exit）", () => {
  const cases = [
    { source: "quit", code: 0, detail: "", wantCode: 0, wantDetail: "" },
    { source: "render-crash", code: null, detail: "renderer crashed (exitCode 133)", wantCode: null, wantDetail: "renderer crashed" },
    { source: "uncaught", code: null, detail: "uncaughtException: boom", wantCode: null, wantDetail: "boom" },
    { source: "exit", code: 7, detail: "", wantCode: 7, wantDetail: "" },
  ];
  for (const item of cases) {
    const dir = tempDir("exit-ledger-source-" + item.source + "-");
    try {
      const written = recordDesktopExit({ source: item.source, code: item.code, detail: item.detail }, { home: dir, episode: "run-" + item.source });
      assert.equal(written.ok, true, item.source + " 必须能落一条");
      const info = readLatestDesktopExit({ home: dir });
      assert.equal(info.latest.source, item.source, "来源字段要能区分：" + item.source);
      assert.equal(info.latest.code, item.wantCode);
      if (item.wantDetail) assert.ok(info.latest.detail.includes(item.wantDetail), "原因要进记录：" + item.wantDetail);
      const text = describeDesktopExit(info);
      assert.match(text, new RegExp("来源=" + item.source.replace("-", "\\-")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("桌面退出留痕：一次运行的多个来源合成一条，chain 记顺序、source 记首因", () => {
  const dir = tempDir("exit-ledger-multi-");
  try {
    recordDesktopExit({ source: "uncaught", detail: "uncaughtException: boom" }, { home: dir, episode: "run-a" });
    recordDesktopExit({ source: "quit", code: 0 }, { home: dir, episode: "run-a" });
    recordDesktopExit({ source: "exit", code: 0 }, { home: dir, episode: "run-a" });
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.count, 1, "一次退出只留一条，不是三个来源三行");
    assert.equal(info.latest.source, "uncaught", "source 记首因（原因链的起点）");
    assert.equal(info.latest.terminal, "quit", "terminal 记第一个终结性来源");
    assert.equal(info.latest.code, 0);
    assert.deepEqual(info.latest.chain, ["uncaught", "quit", "exit"]);
    assert.ok(info.latest.detail.includes("boom"), "原因说明不能被后到的来源清掉");
    assert.ok(Date.parse(info.latest.started_at) <= Date.parse(info.latest.at), "at 是最后一次观测，started_at 是第一次");
    const text = describeDesktopExit(info);
    assert.match(text, /来源=uncaught/);
    assert.match(text, /链=uncaught→quit→exit/);
    assert.match(text, /终结=quit/);
    assert.match(text, /原因=uncaughtException: boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：后到的 exit 不覆盖 quit 的退出码（无信息不覆盖有信息）", () => {
  const dir = tempDir("exit-ledger-no-overwrite-");
  try {
    recordDesktopExit({ source: "quit", code: 3 }, { home: dir, episode: "run-a" });
    recordDesktopExit({ source: "exit", code: 0 }, { home: dir, episode: "run-a" });
    let info = readLatestDesktopExit({ home: dir });
    assert.equal(info.latest.code, 3, "quit 的退出码优先，exit 后到也不能冲掉");
    assert.deepEqual(info.latest.chain, ["quit", "exit"]);

    recordDesktopExit({ source: "quit", code: null }, { home: dir, episode: "run-b" });
    recordDesktopExit({ source: "exit", code: 9 }, { home: dir, episode: "run-b" });
    info = readLatestDesktopExit({ home: dir });
    assert.equal(info.latest.code, 9, "quit 没给码时，exit 的码补空位");
    assert.deepEqual(info.latest.chain, ["quit", "exit"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：close 先到、quit 后到时，终结性来源的码优先", () => {
  const dir = tempDir("exit-ledger-close-quit-");
  try {
    recordDesktopExit({ source: "close", code: 0, signal: "SIGTERM" }, { home: dir, episode: "run-a" });
    recordDesktopExit({ source: "quit", code: 4 }, { home: dir, episode: "run-a" });
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.count, 1);
    assert.equal(info.latest.source, "close");
    assert.equal(info.latest.terminal, "quit");
    assert.equal(info.latest.code, 4, "quit 是应用自己的退出码，优先于子进程 close 的码");
    assert.equal(info.latest.signal, "SIGTERM");
    assert.deepEqual(info.latest.chain, ["close", "quit"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：不同 episode 各留一条（跨进程运行不合并）", () => {
  const dir = tempDir("exit-ledger-episodes-");
  try {
    recordDesktopExit({ source: "quit", code: 0 }, { home: dir, episode: "run-a" });
    recordDesktopExit({ source: "exit", code: 0 }, { home: dir, episode: "run-a" });
    recordDesktopExit({ source: "quit", code: 2 }, { home: dir, episode: "run-b" });
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.count, 2, "两次运行是两条记录");
    assert.equal(info.latest.code, 2);
    assert.deepEqual(info.latest.chain, ["quit"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：条数有上界，多来源不改变上界（写 30 次运行不是 30 条）", () => {
  const dir = tempDir("exit-ledger-bound-");
  try {
    for (let i = 0; i < 30; i += 1) {
      const episode = "run-" + i;
      recordDesktopExit({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), code: i, signal: null, source: "quit" }, { home: dir, episode });
      recordDesktopExit({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), code: i, signal: null, source: "exit" }, { home: dir, episode });
    }
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.count, EXIT_LEDGER_MAX_ENTRIES, "条数必须压到上限");
    assert.equal(info.latest.code, 29, "留下的是最近一条");
    assert.deepEqual(info.latest.chain, ["quit", "exit"], "最近一条仍带完整原因链");
    const bytes = fs.statSync(info.file).size;
    assert.ok(bytes <= EXIT_LEDGER_MAX_BYTES, "文件字节数也要在上界内：" + bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：字节上界同样生效（长记录会挤掉更旧的）", () => {
  const dir = tempDir("exit-ledger-bytes-");
  try {
    for (let i = 0; i < EXIT_LEDGER_MAX_ENTRIES; i += 1) {
      recordDesktopExit({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), code: i, signal: "S".repeat(600), source: "close" }, { home: dir, episode: "run-" + i });
    }
    const info = readLatestDesktopExit({ home: dir });
    assert.ok(info.count < EXIT_LEDGER_MAX_ENTRIES, "字节超限时要少留几条");
    assert.ok(info.count >= 1);
    assert.ok(fs.statSync(info.file).size <= EXIT_LEDGER_MAX_BYTES);
    assert.equal(info.latest.code, EXIT_LEDGER_MAX_ENTRIES - 1, "最近一条不能因为压缩被挤掉");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：半写/损坏文件不抛，读侧跳过坏行、全坏按无记录", () => {
  const dir = tempDir("exit-ledger-corrupt-");
  try {
    const file = exitLedgerFile(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","code":3,"signal":null,"source":"close"}\n{"at":"2026-01-01T00:00:01.000Z","co', "utf8");
    const mixed = readLatestDesktopExit({ home: dir });
    assert.equal(mixed.found, true, "坏行不能把好行一起废掉");
    assert.equal(mixed.latest.code, 3);
    assert.equal(mixed.count, 1);

    fs.writeFileSync(file, "\u0000\u0000 not json at all\n{{{\n", "utf8");
    const allBad = readLatestDesktopExit({ home: dir });
    assert.equal(allBad.found, false);
    assert.match(describeDesktopExit(allBad), /无/);

    // 写侧对着损坏文件也要能继续写，且不抛。
    const written = recordDesktopExit({ code: 1, signal: null, source: "close" }, { home: dir, episode: "run-a" });
    assert.equal(written.ok, true);
    const repaired = readLatestDesktopExit({ home: dir });
    assert.equal(repaired.found, true);
    assert.equal(repaired.latest.code, 1);
    assert.equal(repaired.count, 1, "坏行在写入时被清掉，不会一直占着上界");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：损坏的上一行不参与 episode 合并，多来源写入照样不抛", () => {
  const dir = tempDir("exit-ledger-corrupt-multi-");
  try {
    const file = exitLedgerFile(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"episode":"run-a","source":"quit","chain":["quit"],"at":"not-a-date"}\n{ half line', "utf8");
    let written = null;
    assert.doesNotThrow(() => {
      written = recordDesktopExit({ source: "quit", code: 0 }, { home: dir, episode: "run-b" });
    });
    assert.equal(written.ok, true);
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.found, true);
    assert.equal(info.latest.source, "quit");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：旧版 v1 记录（无 chain / episode）仍能读，chain 退化成单来源", () => {
  const dir = tempDir("exit-ledger-v1-");
  try {
    const file = exitLedgerFile(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","code":0,"signal":null,"source":"close"}\n', "utf8");
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.found, true);
    assert.deepEqual(info.latest.chain, ["close"]);
    assert.equal(info.latest.terminal, null);
    assert.match(describeDesktopExit(info), /来源=close/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** purge_status 的最小 state：只喂它渲染时要读到的字段。 */
function statusState(home) {
  return {
    surface: "desktop",
    dsh_home: home,
    desktop_install: "",
    ai_base: "",
    shim_dir: "",
    desktop_runtimes: [],
    has_backup: false,
    override_path: path.join(home, "prompt-inject.md"),
    override_status: "ok",
    asar_still_sealed: false,
    display_patches: [],
    patch_status: {},
    shim_cmd: "missing",
    shim_ps1: "missing",
    shim_bin: "missing",
    desktop_exit: readLatestDesktopExit({ home }),
  };
}

function statusLineOf(home) {
  return renderStatus(statusState(home)).split("\n").find((line) => line.includes("最近一次桌面退出")) || "";
}

test("purge_status 读侧：没有记录时那一行写明确的「无」", () => {
  const dir = tempDir("exit-ledger-status-empty-");
  try {
    const line = statusLineOf(dir);
    assert.ok(line, "状态输出里必须有「最近一次桌面退出」这一行");
    assert.match(line, /最近一次桌面退出/);
    assert.match(line, /无/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("purge_status 读侧：有记录时那一行带 code / signal / 时间 / 来源", () => {
  const dir = tempDir("exit-ledger-status-one-");
  try {
    const written = recordDesktopExit({ code: null, signal: "SIGINT", source: "close" }, { home: dir, episode: "run-a" });
    assert.equal(written.ok, true);
    const latest = readLatestDesktopExit({ home: dir }).latest;
    const line = statusLineOf(dir);
    assert.match(line, /code=无/);
    assert.match(line, /signal=SIGINT/);
    assert.match(line, /来源=close/);
    assert.ok(line.includes(latest.at), "时间要进状态输出");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("purge_status 读侧：多来源记录那一行带原因链与终结来源", () => {
  const dir = tempDir("exit-ledger-status-multi-");
  try {
    recordDesktopExit({ source: "uncaught", detail: "uncaughtException: boom" }, { home: dir, episode: "run-a" });
    recordDesktopExit({ source: "quit", code: 0 }, { home: dir, episode: "run-a" });
    recordDesktopExit({ source: "exit", code: 0 }, { home: dir, episode: "run-a" });
    const line = statusLineOf(dir);
    assert.match(line, /来源=uncaught/);
    assert.match(line, /链=uncaught→quit→exit/);
    assert.match(line, /终结=quit/);
    assert.match(line, /原因=.*boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：读不了文件时「无」要带原因，不压成一个词", () => {
  const dir = tempDir("exit-ledger-unreadable-");
  try {
    // 留痕路径是个目录：readFileSync 撞 EISDIR，读侧必须报 unreadable 而不是 missing。
    fs.mkdirSync(exitLedgerFile(dir), { recursive: true });
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.found, false);
    assert.equal(info.reason, "unreadable");
    assert.ok(info.error, "读不了要带原因");
    assert.match(describeDesktopExit(info), /无/);
    assert.match(describeDesktopExit(info), /读不了/);
    // 同一份坏目标下写侧也不抛（写不进去只记账）。
    let written = null;
    assert.doesNotThrow(() => { written = recordDesktopExit({ code: 0, signal: null, source: "close" }, { home: dir, episode: "run-a" }); });
    assert.equal(written.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：写不进去也不抛（宿主退出不能被留痕卡住）", () => {
  const dir = tempDir("exit-ledger-fail-");
  try {
    // 把 home 指向一个普通文件：dsh-purge 目录建不出来。
    const home = path.join(dir, "not-a-dir");
    fs.writeFileSync(home, "x", "utf8");
    let written = null;
    assert.doesNotThrow(() => {
      written = recordDesktopExit(at("2026-01-01T00:00:00.000Z"), { home, episode: "run-a" });
    });
    assert.equal(written.ok, false);
    assert.ok(written.error, "失败要带回原因，不能静默");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
