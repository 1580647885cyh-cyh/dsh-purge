#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 全量语法检查：对仓库内所有 JS/MJS 跑 node --check，再 import 两个入口。
 * 不依赖 eslint/tsconfig，也不改写文件；成功后退出码 0。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["lib", "bin", "scripts", "tests", "presets"];
const EXTENSIONS = new Set([".js", ".mjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".scratch", ".codegraph"]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
}

const files = [];
for (const name of ROOTS) {
  const full = path.join(root, name);
  if (fs.existsSync(full)) walk(full, files);
}
const client = path.join(root, "client.js");
if (fs.existsSync(client)) files.push(client);

const relative = files.map((file) => path.relative(root, file)).sort();
let failures = 0;
for (const rel of relative) {
  const result = spawnSync(process.execPath, ["--check", rel], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    failures += 1;
    console.error("✗ 语法检查失败：" + rel);
    if (result.stderr) console.error(result.stderr.trim());
  }
}

const entries = ["lib/index.js", "lib/verify/run.js"];
for (const rel of entries) {
  const url = pathToFileURL(path.join(root, rel)).href;
  const code = "import(" + JSON.stringify(url) + ").catch((error) => { console.error(error); process.exit(1); })";
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    failures += 1;
    console.error("✗ 入口 import 失败：" + rel);
    if (result.stderr) console.error(result.stderr.trim());
  }
}

// —— 生成的宿主内联代码：node --check 只看文件，字符串里的语法错误要在这里当场跑一次 ——
// 这些字符串会被补丁原样写进宿主 main.js；语法坏了不能等到 test:ci 的 harness 才炸。
const hostInline = await import(pathToFileURL(path.join(root, "lib", "desktop-exit-trace.js")).href);
const generated = [
  { name: "DESKTOP_EXIT_TRACE_SOURCES_CODE", code: hostInline.DESKTOP_EXIT_TRACE_SOURCES_CODE },
  { name: "DESKTOP_EXIT_TRACE_CLOSE_CODE", code: "return function (code, signal) {\n" + hostInline.DESKTOP_EXIT_TRACE_CLOSE_CODE + "\n};" },
];
for (const item of generated) {
  try {
    new Function(item.code);
  } catch (error) {
    failures += 1;
    console.error("✗ 生成的宿主代码语法错误：" + item.name);
    console.error(String(error && error.message ? error.message : error));
  }
}

// —— 启发式报告（只报告，不阻塞）：规则 4 / 规则 5 里能机械发现的那一半 ——
// 宿主按名字取插件入口（apply/name/inject/Config）或按约定取工具名，仓库里查不到引用，属于正常误报。
const SKIP_EXPORT_NAMES = new Set(["default", "name", "inject", "apply", "Config", "reusable", "help", "main"]);

const sources = new Map(relative.map((rel) => [rel, fs.readFileSync(path.join(root, rel), "utf8")]));

// 只在"本次改动新增的导出"上查：全仓存量导出有 250+ 个历史遗留，全量扫必然淹没在噪音里。
// 范围是 git diff HEAD 的 + 行（工作树相对 HEAD，含已暂存），新加一个没人用的导出才会被点出来。
function addedExports() {
  const diff = spawnSync("git", ["diff", "-U0", "HEAD", "--", "."], { cwd: root, encoding: "utf8", windowsHide: true });
  if (diff.status !== 0 || !diff.stdout) return [];
  const hits = [];
  let file = "";
  let line = 0;
  for (const raw of diff.stdout.split(/\r?\n/)) {
    // git 输出用 /，sources 的键用平台分隔符；不归一化会让"本文件声明"被算成一次外部引用。
    if (raw.startsWith("+++ b/")) { file = path.normalize(raw.slice(6)); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const text = raw.slice(1);
      const one = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/.exec(text);
      if (one) hits.push({ rel: file, line, name: one[1] });
      const many = /^\s*export\s*\{([^}]*)\}/.exec(text);
      if (many) {
        for (const part of many[1].split(",")) {
          const name = part.trim().split(/\s+as\s+/).pop();
          if (name) hits.push({ rel: file, line, name });
        }
      }
    }
    line += 1;
  }
  return hits;
}

const unusedExports = [];
for (const hit of addedExports()) {
  if (SKIP_EXPORT_NAMES.has(hit.name)) continue;
  const pattern = new RegExp("\\b" + hit.name.replace(/\$/g, "\\$") + "\\b");
  const refs = [...sources].reduce((total, [rel, text]) => {
    const matches = text.match(pattern);
    return total + (matches ? matches.length - (rel === hit.rel ? 1 : 0) : 0);
  }, 0);
  if (refs <= 0) unusedExports.push(hit);
}

const internalAssertions = [];
for (const [rel, text] of sources) {
  if (!rel.includes("tests") || !rel.endsWith(".test.js")) continue;
  text.split(/\r?\n/).forEach((line, index) => {
    if (/\.calls\b|\bcalls\.(?:length|filter|map|some|every)\b|\.mock\.calls\b/.test(line)) {
      internalAssertions.push({ rel, line: index + 1, text: line.trim().slice(0, 100) });
    }
  });
}

// 规则 2（测试写盘约定）：临时目录统一走 tests/verify/helpers.js。
// 只查"自己造临时目录"的写法：自建 TEST_ROOT 常量不算（planWorkspace 的 root 本来就该固定）。
const ownTempDirs = [];
for (const [rel, text] of sources) {
  if (!rel.includes("tests") || !rel.endsWith(".test.js")) continue;
  if (/from\s+["'][^"']*helpers\.js["']/.test(text)) continue;
  const definesTempDir = /function\s+tempDir\s*\(/.test(text);
  const usesMkdtemp = text.includes("mkdtempSync(");
  if (!definesTempDir && !usesMkdtemp) continue;
  ownTempDirs.push({ rel, line: 1, text: definesTempDir ? "自己定义 tempDir()" : "直接 mkdtempSync()" });
}


// —— 试过、并放弃：文本级"跨模块接线"检查（2026-11-03 复盘）——
// 目标：抓住"调用了兄弟模块导出的名字却没导入"（core.js 调 filePatchOutcome 忘了导入，
// 穿过 node --check 与入口 import，只在真跑到那条路径才 ReferenceError）。
// 试过的做法与为什么放弃：
//   1. 先剥注释/字符串再扫调用点 —— 正则、模板、字符串混排时会把成片代码一起吃掉
//      （core.js 的 export function findDshHome 就被"剥模板"吞掉，造成 209 条误报）。
//   2. 不剥、用原文 + 声明/导入白名单 —— 剩 6 条里 0 条真阳性：inject/apply/exec 这类
//      出现在字符串与注释里的调用、以及被当成函数调用的插件字段，文本层面分不开。
// 结论：没有 parser 就做不出一份零误报的检查，而本仓的零依赖策略不允许引入 parser；
// 一条每次都喊 5 声狼来了的提示，比没有提示更糟。
// 替代方案（已落地）：tests/lib/wiring.test.js —— 同一个不变量，用测试而不是提示来守，
// 跑在 pre-commit 的 test:ci 里，毫秒级。要复现本类问题，先看那个文件。

// 规则 9（数字带口径）：文档里抄控制台串/单点计数，而不是引用报告字段时提示。
// 只扫 git diff HEAD 里 docs/ 的新增行：存量文档不追究，且"提到某个串"（不带数字）不算违规。
function addedDocCountLines() {
  const diff = spawnSync("git", ["diff", "-U0", "HEAD", "--", "docs"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (diff.status !== 0 || !diff.stdout) return [];
  const hits = [];
  let file = "";
  let line = 0;
  for (const raw of diff.stdout.split(/\r?\n/)) {
    if (raw.startsWith("+++ b/")) { file = path.normalize(raw.slice(6)); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      const text = raw.slice(1);
      const consoleCount = /\b(?:applied|already|drifted)\b\s*[=:]\s*\d/.test(text);
      const driftCount = /漂移\s*[=:：]\s*\d/.test(text);
      const testCount = /测试\s*\d+\s*条/.test(text);
      if (consoleCount || driftCount || testCount) hits.push({ rel: file, line, text: text.trim().slice(0, 100) });
    }
    line += 1;
  }
  return hits;
}

// 规则 6（守卫也是产物）：新增的补丁替换文本 / 宿主内联代码里的 typeof 形状守卫，
// 提示逐个确认「依赖缺席」的故障对照。只提示，不判定；未跟踪的新文件也算新增。
const GUARD_RE = /typeof\s+[A-Za-z_$][\w$]*(?:\.[\w$]+)?\s*[!=]==\s*\\?"(?:function|object)\\?"/;

const GUARD_GLOBALS = new Set(["process", "Buffer", "JSON", "Date", "String", "Number", "Array", "Object"]);
const guardDeclaredCache = new Map();
function guardDeclared(full) {
  if (guardDeclaredCache.has(full)) return guardDeclaredCache.get(full);
  const set = new Set();
  try {
    for (const match of fs.readFileSync(full, "utf8").matchAll(/(?:function|var|let|const)\s+([A-Za-z_$][\w$]*)/g)) set.add(match[1]);
  } catch {
    // 读不到就当没有本地声明；守卫提示仍然给出。
  }
  guardDeclaredCache.set(full, set);
  return set;
}

function guardName(line) {
  const match = /typeof\s+([A-Za-z_$][\w$]*)/.exec(line);
  return match ? match[1] : "";
}

function shouldSkipGuard(rel, line) {
  const name = guardName(line);
  if (!name || GUARD_GLOBALS.has(name)) return true;
  return guardDeclared(path.join(root, rel)).has(name);
}

function addedTraceGuards() {
  const targets = ["lib/core.js", "lib/desktop-exit-trace.js"];
  const hits = [];
  const diff = spawnSync("git", ["diff", "-U0", "HEAD", "--", ...targets], { cwd: root, encoding: "utf8", windowsHide: true });
  if (diff.status === 0 && diff.stdout) {
    let file = "";
    let line = 0;
    for (const raw of diff.stdout.split(/\r?\n/)) {
      if (raw.startsWith("+++ b/")) { file = path.normalize(raw.slice(6)); continue; }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      if (hunk) { line = Number(hunk[1]); continue; }
      const added = raw.slice(1);
      if (raw.startsWith("+") && !raw.startsWith("+++") && GUARD_RE.test(added) && !shouldSkipGuard(file, added)) {
        hits.push({ rel: file, line, text: added.trim().slice(0, 120) });
      }
      line += 1;
    }
  }
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...targets], { cwd: root, encoding: "utf8", windowsHide: true });
  if (untracked.status === 0) {
    for (const rel of untracked.stdout.split(/\r?\n/).filter(Boolean)) {
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) continue;
      fs.readFileSync(full, "utf8").split(/\r?\n/).forEach((line, index) => {
        if (GUARD_RE.test(line) && !shouldSkipGuard(rel, line)) hits.push({ rel: path.normalize(rel), line: index + 1, text: line.trim().slice(0, 120) });
      });
    }
  }
  return hits;
}

const traceGuards = addedTraceGuards();
const docCountLines = addedDocCountLines();

const hints = unusedExports.length + internalAssertions.length + ownTempDirs.length + docCountLines.length + traceGuards.length;
if (unusedExports.length > 0) {
  console.warn("提示（不阻塞）：未使用导出 " + unusedExports.length + " 个（规则 5；宿主按名字取用的入口会误报）：");
  for (const hit of unusedExports.slice(0, 20)) console.warn("  " + hit.rel + ":" + hit.line + " " + hit.name);
  if (unusedExports.length > 20) console.warn("  … 其余 " + (unusedExports.length - 20) + " 个");
}
if (internalAssertions.length > 0) {
  console.warn("提示（不阻塞）：测试断言了替身调用次数/内部记录 " + internalAssertions.length + " 处（规则 4）：");
  for (const item of internalAssertions.slice(0, 20)) console.warn("  " + item.rel + ":" + item.line + " " + item.text);
}
if (docCountLines.length > 0) {
  console.warn("提示（不阻塞）：文档新增行里抄了控制台串/单点计数 " + docCountLines.length + " 处（规则 9；改成引用 report 字段）：");
  for (const item of docCountLines.slice(0, 20)) console.warn("  " + item.rel + ":" + item.line + " " + item.text);
}
if (traceGuards.length > 0) {
  console.warn("提示（不阻塞）：新增内联代码含 " + traceGuards.length + " 个 typeof 守卫（规则 6；逐个确认有「依赖缺席」对照）：");
  for (const item of traceGuards.slice(0, 20)) console.warn("  " + item.rel + ":" + item.line + " " + item.text);
}
if (ownTempDirs.length > 0) {
  console.warn("提示（不阻塞）：测试自建临时目录 " + ownTempDirs.length + " 处（规则 2；统一用 tests/verify/helpers.js 的 tempDir）：");
  for (const item of ownTempDirs.slice(0, 20)) console.warn("  " + item.rel + "：" + item.text);
}

console.log("check: " + relative.length + " 个文件，" + entries.length + " 个入口"
  + (failures ? "，失败 " + failures : "，通过")
  + (hints > 0 ? "，提示 " + hints + " 条（不阻塞）" : ""));
process.exitCode = failures ? 1 : 0;
