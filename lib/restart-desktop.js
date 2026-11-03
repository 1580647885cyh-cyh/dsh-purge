import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

const cleanup = Array.isArray(info.cleanup) ? info.cleanup : [];
const logPath = path.join(
  process.env.TEMP || process.env.TMPDIR || "/tmp",
  "dsh-purge-restart-desktop.log",
);

function log(msg) {
  try {
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ignore
  }
}

function spawnEnv() {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  delete env.DSH_PURGE_RESTART;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete env[key];
  }
  // [dsh-purge-fix 2026-10-09] 从 explorer 继承的 env 常缺 DSH_PROFILE
  // (WM_SETTINGCHANGE broadcast 不刷新存活很久的 explorer)。helper relaunch
  // 时如果不兜底，新 Electron → host 子进程继续缺,报 "cannot determine the
  // boot profile" host crash → dsh-purge 插件没 activate → inject 全断。
  if (!env.DSH_PROFILE) env.DSH_PROFILE = "desktop";
  return env;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function waitPidGone(pid) {
  if (!pid) {
    await sleep(400);
    return true;
  }
  for (let i = 0; i < 80; i++) {
    if (!pidAlive(pid)) return true;
    await sleep(120);
  }
  return !pidAlive(pid);
}

function rmTree(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  } catch {
    // 锁着就留下
  }
}

function psQuote(value) {
  return "'" + String(value || "").replace(/'/g, "''") + "'";
}

/** 解析 `ps -Ao pid=,ppid=,command=` 的匹配行；main/host 的先后由 ppid 结构决定，不靠枚举顺序。 */
function procsFromPs(out, accept) {
  const procs = [];
  for (const line of String(out || "").split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cmd = m[3].trim();
    if (!pid || !accept(cmd)) continue;
    procs.push({ pid, ppid });
  }
  return procs;
}

function darwinBundleOf(exe) {
  const n = String(exe || "").replace(/\\/g, "/");
  const m = n.match(/^(.*\.app)\/Contents\/MacOS\//i);
  return m ? m[1] : "";
}

function darwinBundleName(bundle) {
  if (!bundle) return "";
  const infoPlist = path.join(bundle, "Contents", "Info.plist");
  try {
    return execFileSync("defaults", ["read", path.join(bundle, "Contents", "Info"), "CFBundleName"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    // fall through
  }
  try {
    return execFileSync("plutil", ["-extract", "CFBundleName", "raw", infoPlist], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
  } catch {
    return path.basename(bundle, ".app");
  }
}

function listDarwinProcs(exe) {
  const bundle = darwinBundleOf(exe);
  if (!exe || !bundle) return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 8000,
    });
  } catch {
    return [];
  }
  const frameworks = `${bundle}/Contents/Frameworks/`;
  return procsFromPs(out, (cmd) => {
    // CLI 独立宿主（dsh web / plugin 等），不占桌面单实例锁，不能一起杀。
    if (cmd.includes("/dsh-desktop-host/lib/cli.js")) return false;
    return cmd === exe || cmd.startsWith(`${exe} `) || cmd.startsWith(frameworks);
  });
}

function commandMatchesExe(cmd, exe) {
  if (!cmd || !exe) return false;
  if (cmd.includes("/dsh-desktop-host/lib/cli.js")) return false;
  return cmd === exe || cmd.startsWith(`${exe} `) || cmd.startsWith(`${exe}\t`);
}

function listPosixProcs(exe) {
  if (!exe) return [];
  let out = "";
  try {
    out = execFileSync("ps", ["-Ao", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 8000,
    });
  } catch {
    return [];
  }
  return procsFromPs(out, (cmd) => commandMatchesExe(cmd, exe));
}

/** win32：只取本次安装根下的进程（路径过滤），不再按镜像名杀同名第三方。 */
function listWin32Procs(exe) {
  const target = String(exe || "").toLowerCase();
  if (!target) return [];
  const root = `${path.dirname(target)}\\`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object {",
    "  $p = $_.ExecutablePath.ToLower()",
    "  if ($p -eq " + psQuote(target) + " -or $p.StartsWith(" + psQuote(root) + ")) { \"$($_.ProcessId)|$($_.ParentProcessId)\" }",
    "}",
  ].join("; ");
  let out = "";
  try {
    out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
  } catch {
    return [];
  }
  const procs = [];
  for (const line of String(out || "").split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split("|").map(Number);
    if (pid) procs.push({ pid, ppid });
  }
  return procs;
}

function listDesktopProcs(exe = info.execPath) {
  if (process.platform === "darwin") return listDarwinProcs(exe);
  if (process.platform !== "win32") return listPosixProcs(exe);
  return listWin32Procs(exe);
}

/** 本安装进程树里的根 = main（父进程不在本安装进程集里）；host / renderer 的父进程是 main。 */
function mainProcPids(procs) {
  const ids = new Set(procs.map((p) => p.pid));
  return procs.filter((p) => !ids.has(p.ppid)).map((p) => p.pid);
}

function signalPids(pids, signal) {
  for (const pid of pids) {
    if (pid === process.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
      // 已经退了
    }
  }
}

async function waitPidsGone(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pids.some((pid) => pidAlive(pid))) return true;
    await sleep(120);
  }
  return !pids.some((pid) => pidAlive(pid));
}

async function waitDesktopGone(exe, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const left = listDesktopProcs(exe).filter((p) => p.pid !== process.pid);
    if (left.length === 0) return true;
    await sleep(200);
  }
  return listDesktopProcs(exe).filter((p) => p.pid !== process.pid).length === 0;
}

/** 顺序：先 main（确认消失）→ 再 host / renderer / runner → 最后 SIGKILL 兜底。 */
async function killOtherDesktopProcesses(keepPid, exe = info.execPath) {
  const first = listDesktopProcs(exe).filter((p) => p.pid !== keepPid && p.pid !== process.pid);
  if (first.length === 0) return true;
  const roots = mainProcPids(first);
  signalPids(roots, process.platform === "darwin" ? "SIGTERM" : undefined);
  await waitPidsGone(roots, 8000);
  const rest = listDesktopProcs(exe).filter((p) => p.pid !== keepPid && p.pid !== process.pid);
  signalPids(rest.map((p) => p.pid), process.platform === "darwin" ? "SIGTERM" : undefined);
  await waitPidsGone(rest.map((p) => p.pid), 5000);
  const left = listDesktopProcs(exe).filter((p) => p.pid !== keepPid && p.pid !== process.pid);
  if (left.length > 0) {
    signalPids(left.map((p) => p.pid), "SIGKILL");
    await waitPidsGone(left.map((p) => p.pid), 2000);
  }
  return listDesktopProcs(exe).filter((p) => p.pid !== keepPid && p.pid !== process.pid).length === 0;
}

async function quitPosixDesktop(exe) {
  await killOtherDesktopProcesses(process.pid, exe);
  log("quit by main-first SIGTERM/SIGKILL");
  return "SIGKILL";
}

async function quitDarwinDesktop(exe) {
  const bundle = darwinBundleOf(exe);
  const name = darwinBundleName(bundle);
  if (name) {
    try {
      execFileSync(
        "osascript",
        ["-e", `if application "${name}" is running then tell application "${name}" to quit`],
        { timeout: 15000 },
      );
      log("osascript quit sent");
    } catch (e) {
      log(`osascript quit failed: ${e && e.message ? e.message : e}`);
    }
    if (await waitDesktopGone(exe, 8000)) {
      log("quit by apple event");
      return "apple-event";
    }
  }
  await killOtherDesktopProcesses(process.pid, exe);
  log("quit by main-first SIGTERM/SIGKILL");
  return "SIGKILL";
}


async function moveAsarAsideAsync(asar) {
  if (!asar) return false;
  try {
    if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) return true;
  } catch {
    return true;
  }
  const bak = `${asar}.bak`;
  try {
    if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
  } catch {
    // keep going
  }
  for (let i = 0; i < 80; i++) {
    try {
      if (!fs.existsSync(asar) || !fs.statSync(asar).isFile()) {
        log("asar already absent");
        return true;
      }
      fs.renameSync(asar, bak);
      log(`asar moved to ${bak}`);
      return true;
    } catch {
      await sleep(300);
    }
  }
  log("asar move failed after retries");
  return false;
}

function asarStillSealed(asar) {
  try {
    return Boolean(asar) && fs.existsSync(asar) && fs.statSync(asar).isFile();
  } catch {
    return false;
  }
}

async function releaseSealedAsar(asar, exe) {
  if (!asar) return true;
  if (await moveAsarAsideAsync(asar)) return true;
  log("retry quit then move asar");
  if (process.platform === "darwin") await quitDarwinDesktop(exe);
  else if (process.platform === "win32") {
    await killOtherDesktopProcesses(process.pid, exe);
  } else await quitPosixDesktop(exe);
  if (await moveAsarAsideAsync(asar)) return true;
  return !asarStillSealed(asar);
}

async function relaunchDesktop() {
  if (!info.execPath) {
    process.exit(1);
  }
  const env = spawnEnv();
  if (process.platform === "darwin") {
    const bundle = darwinBundleOf(info.execPath);
    if (bundle) {
      const child = spawn("open", [bundle], {
        detached: true,
        stdio: "ignore",
        env,
        shell: false,
      });
      child.on("error", () => process.exit(1));
      child.unref();
      log("relaunched via open");
      return;
    }
  }
  // [dsh-purge-fix 2026-10-09] 复用 Electron 自带的 --updated argv 分支:
  // main.js:11256 process.argv.includes("--updated") → raiseAfterUpdate=true
  // → enterWorkspace 时 window.moveTop() + window.focus() 内部强制前台。
  // 比外部 PS SetForegroundWindow 可靠得多 (Win11 前台保护只挡外部进程)。
  const baseArgv = Array.isArray(info.argv) ? info.argv.slice() : [];
  if (process.platform === "win32" && !baseArgv.includes("--updated")) {
    baseArgv.push("--updated");
  }
  const child = spawn(info.execPath, baseArgv, {
    detached: true,
    stdio: "ignore",
    cwd: info.cwd || process.cwd(),
    env,
    windowsHide: true,
    shell: false,
  });
  child.on("error", () => process.exit(1));
  child.unref();
  log("relaunched via execPath (argv=" + JSON.stringify(baseArgv) + ")");
  // 核对启动结果：等一个冷启动窗口，新 main 还活着才算起来；不活只记一笔，不挡后面的前台提升。
  await sleep(1200);
  if (!pidAlive(child.pid)) log("relaunch did not stay alive (pid " + child.pid + ")");

  // [dsh-purge-fix 2026-10-09] Windows: 新 Electron 从 detached helper spawn,
  // Windows 焦点规则让它跑在后台。helper 已经不是前台(老 Electron 被 kill 了),
  // 直接 SetForegroundWindow 会被 Windows 静默 reject。
  // 三重 trick 强推前台:
  //   1) keybd_event 发送虚拟 Alt key — 模拟用户输入,解除 foreground lock
  //   2) AttachThreadInput attach 当前前台线程的 input queue — 继承前台权限
  //   3) ShowWindow(SW_RESTORE) + BringWindowToTop + SetForegroundWindow
  if (process.platform === "win32") {
    const exeLiteral = info.execPath.replace(/'/g, "''");
    const psScript =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$sig=@'\n" +
      "[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h);\n" +
      "[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h,int c);\n" +
      "[DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr h);\n" +
      "[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();\n" +
      "[DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);\n" +
      "[DllImport(\"kernel32.dll\")] public static extern uint GetCurrentThreadId();\n" +
      "[DllImport(\"user32.dll\")] public static extern bool AttachThreadInput(uint a,uint b,bool f);\n" +
      "[DllImport(\"user32.dll\")] public static extern void keybd_event(byte k,byte s,uint f,int e);\n" +
      "'@;" +
      "$t=Add-Type -MemberDefinition $sig -Name W -Namespace U -PassThru;" +
      "[void]$t::keybd_event(0x12,0,0,0);" +
      "[void]$t::keybd_event(0x12,0,2,0);" +
      "for($i=0;$i -lt 25;$i++){" +
      "  Start-Sleep -Milliseconds 300;" +
      "  $p=Get-Process | Where-Object {$_.Path -eq '" + exeLiteral + "' -and $_.MainWindowHandle -ne 0} | Select-Object -First 1;" +
      "  if($p){" +
      "    $h=$p.MainWindowHandle;" +
      "    $fg=$t::GetForegroundWindow();" +
      "    $pid2=0;" +
      "    $fgTid=$t::GetWindowThreadProcessId($fg,[ref]$pid2);" +
      "    $curTid=$t::GetCurrentThreadId();" +
      "    [void]$t::AttachThreadInput($curTid,$fgTid,$true);" +
      "    [void]$t::ShowWindow($h,9);" +
      "    [void]$t::BringWindowToTop($h);" +
      "    [void]$t::SetForegroundWindow($h);" +
      "    [void]$t::AttachThreadInput($curTid,$fgTid,$false);" +
      "    break;" +
      "  }" +
      "}";
    try {
      const ps = spawn("powershell.exe", [
        "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
        "-Command", psScript,
      ], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
      // detached + unref 后 ENOENT 等异步错走 'error' 事件,外层 try/catch 捕不到 → uncaught 崩进程。
      ps.on("error", (err) => log("ps bring-to-front spawn error: " + String(err?.message || err)));
      ps.unref();
      log("spawned ps bring-to-front helper (keybd+attach+setfg)");
    } catch (err) {
      log("ps bring-to-front spawn failed: " + String(err));
    }
  }
}

let asarReleased = true;
if (info.killApp) {
  // #85: 先杀 Electron,再 sleep + cleanup。原顺序 sleep 400ms 开头 →
  // host 已经 exit → Electron 还活着跑旧 close 回调弹 crash dialog。
  // 新顺序:立刻 kill (host 这边 killInstallElectronSync 已经杀过,这里兜底),
  // Electron 死得越快,旧回调越没机会跑。
  if (process.platform === "darwin") {
    await quitDarwinDesktop(info.execPath);
  } else if (process.platform === "win32") {
    // 顺序：先结束 Electron main，确认它消失；再清 host / renderer，最后才挪 asar。
    await killOtherDesktopProcesses(process.pid, info.execPath);
  } else {
    await quitPosixDesktop(info.execPath);
  }
  for (const dir of cleanup) rmTree(dir);
  if (info.helper) {
    try {
      fs.unlinkSync(info.helper);
    } catch {
      /* ignore */
    }
  }
  if (info.asar) asarReleased = await releaseSealedAsar(info.asar, info.execPath);
} else {
  const gone = await waitPidGone(info.pid);
  if (!gone) process.exit(1);
  for (const dir of cleanup) rmTree(dir);
  if (info.helper) {
    try {
      fs.unlinkSync(info.helper);
    } catch {
      /* ignore */
    }
  }
  if (info.asar) asarReleased = await releaseSealedAsar(info.asar, info.execPath);
}

if (info.respawn === false) {
  process.exit(asarReleased ? 0 : 1);
}

if (info.asar && !asarReleased) {
  // app.asar 还在原位：把用户刚才关掉的桌面按原版布局拉回来，不能留一个空现场。
  log("asar still sealed; relaunching original");
  await relaunchDesktop();
  await sleep(400);
  process.exit(0);
}

if (!info.execPath) process.exit(1);

await relaunchDesktop();
await sleep(400);
process.exit(0);
