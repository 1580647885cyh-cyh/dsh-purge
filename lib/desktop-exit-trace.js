import { EXIT_LEDGER_MAX_BYTES, EXIT_LEDGER_MAX_ENTRIES } from "./exit-ledger.js";

/**
 * 宿主内联的桌面退出多来源留痕代码（A5-2 / #26）。
 *
 * 宿主 main.js 不能 import 插件，所以这两段代码是 `lib/exit-ledger.js` 合并/滚动规则的
 * **内联副本**：
 * - #91 把 SOURCE_LINES 插在宿主 fs import 之后（模块作用域，只挂一次），注册 quit /
 *   web-contents-created→render-process-gone / uncaughtExceptionMonitor / exit 四个来源；
 * - #90 把 close 回调里的旧内联块换成一行调用，让 close 与其余来源共用同一个 episode。
 *
 * 入口五的 harness（lib/verify/exit-trace.js）用真 fs 跑这两段，再把记录交给
 * lib/exit-ledger.js 读回；上界常量只从这里 import，改上限不用改两处。
 */

export const EXIT_TRACE_SOURCES_BEGIN = "[dsh-purge] desktop exit trace sources begin";
export const EXIT_TRACE_SOURCES_END = "[dsh-purge] desktop exit trace sources end";
export const EXIT_TRACE_CLOSE_MARKER = "[dsh-purge] desktop exit trace call";

/** #91 的替换文本（行数组；用 JSON 序列化生成，避免手抄缩进/转义）。 */
const SOURCE_LINES = [
  "// [dsh-purge] desktop exit trace sources begin: quit / render crash / uncaught / exit —— 只旁听，不改退出行为、不改 exit code、不挡退出",
  "var dshPurgeExitEpisode = \"p\" + (typeof process !== \"undefined\" && process ? String(process.pid) : \"?\") + \"@\" + new Date().toISOString();",
  "function dshPurgeExitSourceKnown(source) { return source === \"close\" || source === \"quit\" || source === \"render-crash\" || source === \"uncaught\" || source === \"exit\"; }",
  "function dshPurgeExitLedgerFile() {",
  "\tvar home = typeof process !== \"undefined\" && process && process.env ? String(process.env.DSH_HOME || \"\").trim() : \"\";",
  "\tvar sep = typeof process !== \"undefined\" && process && process.platform === \"win32\" ? \"\\\\\" : \"/\";",
  "\tif (!home) {",
  "\t\tvar userHome = typeof homedir === \"function\" ? String(homedir() || \"\") : \"\";",
  "\t\thome = userHome ? userHome + (userHome.endsWith(sep) ? \"\" : sep) + \".dsh\" : \"\";",
  "\t}",
  "\tif (!home) return \"\";",
  "\treturn home + (home.endsWith(sep) ? \"\" : sep) + \"dsh-purge\" + sep + \"exit-ledger.jsonl\";",
  "}",
  "function dshPurgeExitMerge(previous, next) {",
  "\tvar chain = Array.isArray(previous.chain) && previous.chain.length ? previous.chain.slice() : [previous.source];",
  "\tvar nextChain = Array.isArray(next.chain) && next.chain.length ? next.chain : [next.source];",
  "\tfor (var i = 0; i < nextChain.length; i += 1) if (chain.indexOf(nextChain[i]) < 0) chain.push(nextChain[i]);",
  "\tvar terminal = previous.terminal || next.terminal || null;",
  "\tvar code = previous.code;",
  "\tvar signal = previous.signal;",
  "\tif (next.terminal && !previous.terminal) {",
  "\t\tif (next.code !== null && next.code !== undefined) code = next.code;",
  "\t\tif (next.signal) signal = next.signal;",
  "\t} else {",
  "\t\tif ((code === null || code === undefined) && next.code !== null && next.code !== undefined) code = next.code;",
  "\t\tif (!signal && next.signal) signal = next.signal;",
  "\t}",
  "\treturn { at: next.at, started_at: previous.started_at || previous.at, code: code === undefined ? null : code, signal: signal || null, source: previous.source, terminal: terminal, chain: chain, detail: previous.detail || next.detail || \"\", episode: previous.episode || next.episode || \"\" };",
  "}",
  "function dshPurgeRecordExit(source, code, signal, detail) {",
  "\ttry {",
  "\t\tif (!dshPurgeExitSourceKnown(source)) return;",
  "\t\tvar file = dshPurgeExitLedgerFile();",
  "\t\tif (!file) return;",
  "\t\tif (typeof mkdirSync !== \"function\" || typeof readFileSync !== \"function\" || typeof writeFileSync !== \"function\" || typeof existsSync !== \"function\") return;",
  "\t\tvar now = new Date().toISOString();",
  "\t\tvar next = { at: now, started_at: now, code: typeof code === \"number\" ? code : null, signal: typeof signal === \"string\" && signal ? signal : null, source: source, terminal: source === \"quit\" || source === \"exit\" ? source : null, chain: [source], detail: typeof detail === \"string\" ? detail.slice(0, 160) : \"\", episode: dshPurgeExitEpisode };",
  "\t\tvar cut = file.length - \"exit-ledger.jsonl\".length - 1;",
  "\t\tvar dir = cut > 0 ? file.slice(0, cut) : file;",
  "\t\tmkdirSync(dir, { recursive: true });",
  "\t\tvar lines = [];",
  "\t\ttry {",
  "\t\t\tif (existsSync(file)) lines = readFileSync(file, \"utf8\").split(\"\\n\").filter(function (line) { try { var parsed = JSON.parse(line); return !!parsed && typeof parsed === \"object\"; } catch (parseError) { return false; } });",
  "\t\t} catch (readError) { lines = []; }",
  "\t\tvar previous = null;",
  "\t\tif (lines.length > 0) { try { previous = JSON.parse(lines[lines.length - 1]); } catch (previousError) { previous = null; } }",
  "\t\tif (previous && previous.episode === dshPurgeExitEpisode) lines[lines.length - 1] = JSON.stringify(dshPurgeExitMerge(previous, next));",
  "\t\telse lines.push(JSON.stringify(next));",
  "\t\tlines = lines.slice(-__MAX_ENTRIES__);",
  "\t\twhile (lines.length > 1 && Buffer.byteLength(lines.join(\"\\n\") + \"\\n\", \"utf8\") > __MAX_BYTES__) lines.shift();",
  "\t\twriteFileSync(file, lines.join(\"\\n\") + \"\\n\", \"utf8\");",
  "\t} catch (traceError) { /* [dsh-purge] desktop exit trace never blocks exit */ }",
  "}",
  "if (typeof app === \"object\" && app && typeof app.on === \"function\") {",
  "\tapp.on(\"quit\", function (_event, exitCode) { dshPurgeRecordExit(\"quit\", exitCode, null, \"\"); });",
  "\tapp.on(\"web-contents-created\", function (_event, contents) {",
  "\t\tif (!contents || typeof contents.on !== \"function\") return;",
  "\t\tcontents.on(\"render-process-gone\", function (_event2, details) {",
  "\t\t\tvar reason = details && details.reason ? String(details.reason) : \"gone\";",
  "\t\t\tvar crashCode = details && typeof details.exitCode === \"number\" ? details.exitCode : null;",
  "\t\t\tdshPurgeRecordExit(\"render-crash\", null, null, \"renderer \" + reason + (crashCode === null ? \"\" : \" (exitCode \" + crashCode + \")\"));",
  "\t\t});",
  "\t});",
  "}",
  "if (typeof process !== \"undefined\" && process && typeof process.on === \"function\") {",
  "\tprocess.on(\"uncaughtExceptionMonitor\", function (error, origin) {",
  "\t\tvar message = error && error.message ? String(error.message) : String(error || \"\");",
  "\t\tdshPurgeRecordExit(\"uncaught\", null, null, String(origin || \"uncaughtException\") + \": \" + message.slice(0, 120));",
  "\t});",
  "\tprocess.on(\"exit\", function (code) { dshPurgeRecordExit(\"exit\", code, null, \"\"); });",
  "}",
  "// [dsh-purge] desktop exit trace sources end"
];

/** #90 的替换文本：close 回调只把 code / signal 交给模块作用域的写入器（四个 tab 缩进）。 */
const CLOSE_LINES = [
  "\t\t\t\t// [dsh-purge] desktop exit trace call: close 来源交给模块作用域的写入器（#91），只旁听",
  "\t\t\t\ttry {",
  "\t\t\t\t\tif (typeof dshPurgeRecordExit === \"function\") dshPurgeRecordExit(\"close\", typeof code === \"undefined\" ? null : code, typeof signal === \"undefined\" ? null : signal, \"\");",
  "\t\t\t\t} catch (traceError) { /* [dsh-purge] desktop exit trace never blocks exit */ }"
];

/** 宿主内联副本（上界常量在模块加载时替换，两份实现同口径）。 */
export const DESKTOP_EXIT_TRACE_SOURCES_CODE = SOURCE_LINES.join("\n")
  .replaceAll("__MAX_ENTRIES__", String(EXIT_LEDGER_MAX_ENTRIES))
  .replaceAll("__MAX_BYTES__", String(EXIT_LEDGER_MAX_BYTES));

/** close 回调里的共享写入器调用（含 #90 的起止标记）。 */
export const DESKTOP_EXIT_TRACE_CLOSE_CODE = CLOSE_LINES.join("\n");

/** A5-1（#90 旧版）留下的内联块：升级时换成上面的 close 调用，不叠加第二份。 */
export const DESKTOP_EXIT_TRACE_OLD_BLOCK = new RegExp("\\t+// \\[dsh-purge\\] desktop exit trace:[^\\n]*\\n\\t+try \\{\\n\\t+var dshPurgeExitHome[\\s\\S]{0,4000}?\\} catch \\(traceError\\) \\{ /\\* \\[dsh-purge\\] desktop exit trace never blocks exit \\*/ \\}");
