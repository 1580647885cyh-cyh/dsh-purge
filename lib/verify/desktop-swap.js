import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertDriveDPath } from "./isolate.js";

/**
 * A7 / #27：asar 换包顺序与失败分支的隔离验证。
 *
 * 现场：一棵假安装树（exe 是编译出来的桩，会独占 app.asar 并记录每次启动时看到的布局），
 * 用生产入口 restartOfficialHarness 起换包脚本。失败案例再用一个外部 PowerShell 进程把
 * app.asar 锁住，脚本杀完 main 也挪不动；修前/修后观察「桌面有没有按原版布局回来」。
 *
 * 安全边界：
 * - 生产脚本按假安装根路径匹配进程；harness 自己收 wscript 时按 command line 含 fixture 根过滤。
 * - 调用生产入口前断言 app.asar 在位，避免落到 unpacked-helper 分支（那条分支在 win32 按镜像名杀）。
 * - 所有写盘都在调用方给的 D 盘目录里。
 *
 * 这个 harness 跑本机实际选择的 wscript 换包路径；PS1 fallback 的失败分支由接线断言覆盖
 * （本机 detached PowerShell 直接 exit 0、不执行脚本，见 #27 记录）。
 */

const EXE_NAME = "DeepSeek Harness.exe";

const STUB_SOURCE = `using System;
using System.IO;
using System.Reflection;
using System.Threading;

public class SwapStub {
  public static void Main(string[] args) {
    string exe = Assembly.GetEntryAssembly().Location;
    string dir = Path.GetDirectoryName(exe);
    string asar = Path.Combine(dir, "resources", "app.asar");
    string state = File.Exists(asar) ? "present" : "absent";
    try {
      string line = System.Diagnostics.Process.GetCurrentProcess().Id + " " + state + " " + DateTime.UtcNow.ToString("o") + Environment.NewLine;
      File.AppendAllText(Path.Combine(dir, "launches.log"), line);
    } catch {}
    FileStream hold = null;
    try {
      if (File.Exists(asar)) hold = new FileStream(asar, FileMode.Open, FileAccess.Read, FileShare.None);
    } catch {}
    try { Thread.Sleep(Timeout.Infinite); } catch {}
    if (hold != null) hold.Dispose();
  }
}
`;

const HOLDER_PS1 = [
  "param([string]$Path, [string]$Ready)",
  "try {",
  "  $fs = [IO.File]::Open($Path, 'Open', 'Read', 'None')",
  "} catch {",
  "  $_.Exception.Message | Set-Content -LiteralPath ($Ready + '.error')",
  "  exit 1",
  "}",
  "'ready' | Set-Content -LiteralPath $Ready",
  "Start-Sleep -Seconds 300",
  "$fs.Dispose()",
  "",
].join("\r\n");

const RUNNER = [
  'import fs from "node:fs";',
  'const { restartOfficialHarness } = await import(process.env.DSWAP_DESKTOP_URL);',
  'const asar = process.env.DSWAP_ASAR;',
  'if (!fs.existsSync(asar)) { console.log(JSON.stringify({ abort: "asar-missing" })); process.exit(4); }',
  'const result = restartOfficialHarness({ exe: process.env.DSWAP_EXE, asar, exit: false });',
  'console.log(JSON.stringify(result));',
  "",
].join("\n");

const HOST_PROMPT = [
  "/* fixture: 只满足换包脚本的 clean gate；判定看进程与布局，不读这段标记。 */",
  "[dsh-purge] identity stripped",
  "[dsh-purge] complete prompt keeps inject",
  "// system-prompt/assemble",
  "",
].join("\n");

function systemRoot() {
  return process.env.SystemRoot || "C:\\Windows";
}

function systemPath() {
  const root = systemRoot();
  return [
    path.join(root, "System32"),
    root,
    path.join(root, "System32", "Wbem"),
    path.join(root, "System32", "WindowsPowerShell", "v1.0"),
  ].join(path.delimiter);
}

function powershellExe() {
  return path.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function taskkillExe() {
  return path.join(systemRoot(), "System32", "taskkill.exe");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function readLaunches(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
      const [pid, state, at] = line.trim().split(/\s+/);
      return { pid: Number(pid), state, at };
    });
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!n) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  try {
    execFileSync(taskkillExe(), ["/F", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 8000,
      env: { ...process.env, PATH: systemPath() },
    });
  } catch {
    // 已经退了
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

/** 编译假 exe 桩：一次编译，多个案例复制；csc 是 Windows 自带 .NET Framework 编译器。 */
function compileStub(binDir) {
  const exe = path.join(binDir, EXE_NAME);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(binDir, { recursive: true });
  const source = path.join(binDir, "swap-stub.cs");
  fs.writeFileSync(source, STUB_SOURCE, "utf8");
  const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  if (!fs.existsSync(csc)) throw new Error("找不到 csc.exe，无法编译换包 fixture");
  execFileSync(csc, ["/nologo", "/target:winexe", `/out:${exe}`, source], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 30000,
  });
  if (!fs.existsSync(exe)) throw new Error("换包 fixture 的 stub exe 没有编出来");
  return exe;
}

function prepareFixture({ root, stub }) {
  const install = path.join(root, "install");
  const resources = path.join(install, "resources");
  const exe = path.join(install, EXE_NAME);
  const asar = path.join(resources, "app.asar");
  fs.mkdirSync(resources, { recursive: true });
  fs.copyFileSync(stub, exe);
  fs.writeFileSync(asar, "asar-fixture-content\n", "utf8");
  writeFile(path.join(resources, "app", "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js"), HOST_PROMPT);
  const tmp = path.join(root, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const home = path.join(root, "home");
  const holderPs1 = path.join(root, "holder.ps1");
  fs.writeFileSync(holderPs1, HOLDER_PS1, "utf8");
  const runner = path.join(root, "runner.mjs");
  fs.writeFileSync(runner, RUNNER, "utf8");
  const launches = path.join(install, "launches.log");
  return { root, install, resources, exe, asar, tmp, home, holderPs1, runner, launches };
}

async function startHolder(fixture) {
  const ready = path.join(fixture.tmp, "lock-ready.txt");
  const failed = ready + ".error";
  fs.rmSync(ready, { force: true });
  fs.rmSync(failed, { force: true });
  let spawnError = "";
  const child = spawn(powershellExe(), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    fixture.holderPs1,
    "-Path",
    fixture.asar,
    "-Ready",
    ready,
  ], {
    // 本机实测：PowerShell 以 DETACHED_PROCESS 启动会直接 exit 0 不执行脚本；锁进程留在
    // harness 的子进程树里即可（cleanup 负责收），不需要 detached。
    cwd: fixture.tmp,
    detached: false,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, PATH: systemPath() },
  });
  child.on("error", (err) => {
    spawnError = String(err && err.message ? err.message : err);
  });
  const ok = await waitFor(() => fs.existsSync(ready) || fs.existsSync(failed) || spawnError, 8000, 100);
  if (!ok || !fs.existsSync(ready)) {
    const reason = spawnError || (fs.existsSync(failed) ? fs.readFileSync(failed, "utf8").trim() : "");
    killPid(child.pid);
    throw new Error("外部锁没有就绪（app.asar 没能被独占打开）" + (reason ? "：" + reason : ""));
  }
  return child;
}

async function startMain(fixture) {
  const child = spawn(fixture.exe, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: fixture.install,
  });
  child.unref();
  const first = await waitFor(() => readLaunches(fixture.launches)[0], 8000, 100);
  if (!first) {
    killPid(child.pid);
    throw new Error("假 main 没有写出启动记录");
  }
  return first;
}

function runProductionRestart({ pluginRoot, fixture }) {
  const env = {
    ...process.env,
    TEMP: fixture.tmp,
    TMP: fixture.tmp,
    DSH_HOME: fixture.home,
    DSH_BASE: path.join(fixture.root, "base"),
    DSH_DESKTOP_INSTALL: fixture.install,
    DSWAP_DESKTOP_URL: pathToFileURL(path.join(pluginRoot, "lib", "desktop.js")).href,
    DSWAP_EXE: fixture.exe,
    DSWAP_ASAR: fixture.asar,
    PATH: systemPath(),
  };
  delete env.DSH_PURGE_RESTART;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  const stdout = execFileSync(process.execPath, [fixture.runner], {
    cwd: fixture.tmp,
    env,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  return JSON.parse(String(stdout || "").trim().split(/\r?\n/).pop());
}

function caseOf(id, ok, detail) {
  return { id, ok: Boolean(ok), detail };
}

function withGroup(cases, locked) {
  const group = locked ? "failure" : "success";
  return cases.map((item) => ({ ...item, group }));
}

function readLog(fixture) {
  try {
    return fs.readFileSync(path.join(fixture.tmp, "dsh-purge-official-restart.log"), "utf8");
  } catch {
    return "";
  }
}

/** 生产入口写下的 wscript 原文：顺序与失败分支的接线证据（不是直调脚本）。 */
function readRestartScript(fixture) {
  try {
    const name = fs.readdirSync(fixture.tmp).find((item) => item.startsWith("dsh-purge-official-restart-") && item.endsWith(".js"));
    return name ? fs.readFileSync(path.join(fixture.tmp, name), "utf8") : "";
  } catch {
    return "";
  }
}

/** 成功路径的 wscript 会按设计多睡 45s 占住 inflight 窗口；fixture 结束时按 command line 收掉。 */
function killFixtureWscript(fixture) {
  try {
    execFileSync(powershellExe(), [
      "-NoProfile",
      "-Command",
      "$root=$env:DSWAP_ROOT; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'wscript.exe' -and $_.CommandLine -and $_.CommandLine.Contains($root) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ], {
      cwd: fixture.tmp,
      env: { ...process.env, DSWAP_ROOT: fixture.root, PATH: systemPath() },
      stdio: "ignore",
      timeout: 15000,
      windowsHide: true,
    });
  } catch {
    // 收不掉时脚本自己会在 45s 后退出
  }
}

async function cleanup(fixture, holder) {
  if (holder && holder.pid) killPid(holder.pid);
  killFixtureWscript(fixture);
  for (const row of readLaunches(fixture.launches)) killPid(row.pid);
  await sleep(200);
  try {
    fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  } catch {
    // 进程还没退干净时留给下一轮；报告里不把清理失败当行为失败。
  }
}

async function runCase({ pluginRoot, stub, root, locked }) {
  const fixture = prepareFixture({ root, stub });
  const cases = [];
  let holder = null;
  try {
    if (locked) holder = await startHolder(fixture);
    const first = await startMain(fixture);
    const result = runProductionRestart({ pluginRoot, fixture });
    cases.push(caseOf(
      "engine-wscript",
      result && result.restarting === true && result.engine === "wscript",
      "生产入口返回：" + JSON.stringify(result),
    ));
    // 失败案例要等脚本把 80 次挪包重试跑完（~24s）再拉起原版；成功案例一般几秒内就有第二条启动记录。
    const timeout = locked ? 60000 : 30000;
    const outcome = await waitFor(() => {
      const rows = readLaunches(fixture.launches);
      if (rows.length >= 2) return rows[1];
      // 修前对照：失败分支只写 not starting 就退出，不必等满超时。
      if (locked && readLog(fixture).includes("rename failed; not starting")) return { missing: true };
      return null;
    }, timeout);
    const second = outcome && outcome.missing ? null : outcome;
    cases.push(caseOf("relaunched", Boolean(second), second ? "第二次启动 pid=" + second.pid : "超时没有第二次启动"));
    if (!second) {
      // 修前的失败分支：桌面被杀掉后没有进程回来，asar 也还在原位。
      cases.push(caseOf("old-main-gone", !pidAlive(first.pid), "原 main pid=" + first.pid + " 存活=" + pidAlive(first.pid)));
      if (locked) {
        cases.push(caseOf(
          "asar-kept",
          fs.existsSync(fixture.asar) && !fs.existsSync(fixture.asar + ".bak"),
          "app.asar 在位=" + fs.existsSync(fixture.asar) + " · .bak=" + fs.existsSync(fixture.asar + ".bak"),
        ));
      }
      return { cases: withGroup(cases, locked), fixture };
    }
    cases.push(caseOf("old-main-gone", !pidAlive(first.pid), "原 main pid=" + first.pid + " 存活=" + pidAlive(first.pid)));
    cases.push(caseOf("new-pid", second.pid !== first.pid, "新 pid=" + second.pid + " 原 pid=" + first.pid));
    cases.push(caseOf(
      "relaunch-layout",
      locked ? second.state === "present" : second.state === "absent",
      "新进程看到的 app.asar=" + second.state + "（失败案例应为 present，成功案例应为 absent）",
    ));
    if (locked) {
      cases.push(caseOf(
        "asar-kept",
        fs.existsSync(fixture.asar) && !fs.existsSync(fixture.asar + ".bak"),
        "app.asar 在位=" + fs.existsSync(fixture.asar) + " · .bak=" + fs.existsSync(fixture.asar + ".bak"),
      ));
    } else {
      cases.push(caseOf(
        "asar-moved",
        !fs.existsSync(fixture.asar) && fs.existsSync(fixture.asar + ".bak"),
        "app.asar 在位=" + fs.existsSync(fixture.asar) + " · .bak=" + fs.existsSync(fixture.asar + ".bak"),
      ));
    }
    const script = readRestartScript(fixture);
    cases.push(caseOf(
      "script-failure-relaunch",
      /rename failed; relaunching original/.test(script) && script.includes("startExe('relaunched original')"),
      "生成脚本的失败分支含 relaunching original=" + /rename failed; relaunching original/.test(script),
    ));
    // 脚本在启动后先等 1.5s 再核对 pids，才开始写 started / relaunched original；等它落盘再读。
    await waitFor(() => {
      const wanted = locked ? "relaunched original" : "started";
      return readLog(fixture).split(/\r?\n/).some((line) => line.endsWith(" " + wanted));
    }, 6000, 200);
    const log = readLog(fixture);
    const lines = log.split(/\r?\n/).filter(Boolean);
    const indexOf = (re) => lines.findIndex((line) => re.test(line));
    const mainIndex = indexOf(/main left 0/);
    const restIndex = indexOf(/procs left 0/);
    const moveIndex = indexOf(/renamed|rename failed/);
    cases.push(caseOf(
      "main-gone-before-move",
      mainIndex >= 0 && restIndex >= 0 && moveIndex > mainIndex && moveIndex > restIndex,
      "log 顺序：main left=" + mainIndex + " · procs left=" + restIndex + " · move=" + moveIndex,
    ));
    cases.push(caseOf(
      locked ? "failure-branch" : "success-branch",
      locked
        ? indexOf(/rename failed; relaunching original/) >= 0 && indexOf(/relaunched original/) >= 0
        : indexOf(/renamed/) >= 0 && indexOf(/started/) >= 0,
      "log 尾部：" + JSON.stringify(lines.slice(-4)),
    ));
    return { cases: withGroup(cases, locked), fixture };
  } finally {
    await cleanup(fixture, holder);
  }
}

/**
 * 跑两个案例：locked（挪不动 → 原版按 present 布局回来）与 unlocked（挪得动 → 新进程看到 absent）。
 * 返回结构化记录，入口五与测试都读同一份。
 */
export async function proveAsarSwapRestart({ pluginRoot, root } = {}) {
  const record = { kind: "desktop-swap", ok: false, error: "", fixture: null, cases: [] };
  try {
    assertDriveDPath(root, "桌面换包 fixture");
    fs.mkdirSync(root, { recursive: true });
    const stub = compileStub(path.join(root, "bin"));
    record.fixture = { exeName: EXE_NAME, stub, root };
    const failure = await runCase({ pluginRoot, stub, root: path.join(root, "failure"), locked: true });
    record.cases.push(...failure.cases);
    const success = await runCase({ pluginRoot, stub, root: path.join(root, "success"), locked: false });
    record.cases.push(...success.cases);
    record.ok = record.cases.length > 0 && record.cases.every((item) => item.ok);
  } catch (error) {
    record.error = String(error && error.message ? error.message : error);
  }
  return record;
}
