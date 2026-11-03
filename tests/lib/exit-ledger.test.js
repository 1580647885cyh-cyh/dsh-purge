import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  EXIT_LEDGER_MAX_BYTES,
  EXIT_LEDGER_MAX_ENTRIES,
  describeDesktopExit,
  exitLedgerFile,
  readLatestDesktopExit,
  recordDesktopExit,
} from "../../lib/exit-ledger.js";
import { renderStatus } from "../../lib/index.js";
import { tempDir } from "../verify/helpers.js";

/**
 * 桌面退出留痕（A5 / #25）。
 *
 * 这一组只测读写契约：一条记录里有什么、什么时候算「无」、写多了会不会无限长。
 * 「close 回调真的会写」由入口五的 harness 证明（lib/verify/exit-trace.js）——
 * 这里直调写入器只当补充证据，不当生产路径的证据（CODING_STANDARDS #6）。
 */

function at(iso) {
  return { at: iso, code: 0, signal: null, source: "close" };
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

test("桌面退出留痕：一条 close 记录带 code / signal / 时间 / 来源，落在 DSH_HOME/dsh-purge/", () => {
  const dir = tempDir("exit-ledger-one-");
  try {
    const written = recordDesktopExit({ code: 0, signal: null, source: "close" }, { home: dir });
    assert.equal(written.ok, true);
    assert.equal(written.file, path.join(dir, "dsh-purge", "exit-ledger.jsonl"));
    assert.ok(fs.existsSync(written.file), "记录要真的落盘");
    const lines = fs.readFileSync(written.file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 1);
    const raw = JSON.parse(lines[0]);
    assert.equal(raw.code, 0);
    assert.equal(raw.signal, null);
    assert.equal(raw.source, "close");
    assert.equal(typeof raw.at, "string");
    assert.equal(Number.isNaN(Date.parse(raw.at)), false, "时间必须可解析");

    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.found, true);
    assert.deepEqual(info.latest, { at: raw.at, code: 0, signal: null, source: "close" });
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
    recordDesktopExit({ code: null, signal: "SIGTERM", source: "close" }, { home: dir });
    const info = readLatestDesktopExit({ home: dir });
    assert.deepEqual(info.latest, { at: info.latest.at, code: null, signal: "SIGTERM", source: "close" });
    const text = describeDesktopExit(info);
    assert.match(text, /signal=SIGTERM/);
    assert.match(text, /code=无|null/, "没有 code 时也要写清楚（不接受空白）");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("桌面退出留痕：条数有上界，只留最近的一批（写 30 条不是 30 条）", () => {
  const dir = tempDir("exit-ledger-bound-");
  try {
    for (let i = 0; i < 30; i += 1) {
      recordDesktopExit({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), code: i, signal: null, source: "close" }, { home: dir });
    }
    const info = readLatestDesktopExit({ home: dir });
    assert.equal(info.count, EXIT_LEDGER_MAX_ENTRIES, "条数必须压到上限");
    assert.equal(info.latest.code, 29, "留下的是最近一条");
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
      recordDesktopExit({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), code: i, signal: "S".repeat(600), source: "close" }, { home: dir });
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
    const written = recordDesktopExit({ code: 1, signal: null, source: "close" }, { home: dir });
    assert.equal(written.ok, true);
    const repaired = readLatestDesktopExit({ home: dir });
    assert.equal(repaired.found, true);
    assert.equal(repaired.latest.code, 1);
    assert.equal(repaired.count, 1, "坏行在写入时被清掉，不会一直占着上界");
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
    const written = recordDesktopExit({ code: null, signal: "SIGINT", source: "close" }, { home: dir });
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
    assert.doesNotThrow(() => { written = recordDesktopExit({ code: 0, signal: null, source: "close" }, { home: dir }); });
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
      written = recordDesktopExit(at("2026-01-01T00:00:00.000Z"), { home });
    });
    assert.equal(written.ok, false);
    assert.ok(written.error, "失败要带回原因，不能静默");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
