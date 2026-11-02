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

const hints = unusedExports.length + internalAssertions.length;
if (unusedExports.length > 0) {
  console.warn("提示（不阻塞）：未使用导出 " + unusedExports.length + " 个（规则 5；宿主按名字取用的入口会误报）：");
  for (const hit of unusedExports.slice(0, 20)) console.warn("  " + hit.rel + ":" + hit.line + " " + hit.name);
  if (unusedExports.length > 20) console.warn("  … 其余 " + (unusedExports.length - 20) + " 个");
}
if (internalAssertions.length > 0) {
  console.warn("提示（不阻塞）：测试断言了替身调用次数/内部记录 " + internalAssertions.length + " 处（规则 4）：");
  for (const item of internalAssertions.slice(0, 20)) console.warn("  " + item.rel + ":" + item.line + " " + item.text);
}

console.log("check: " + relative.length + " 个文件，" + entries.length + " 个入口"
  + (failures ? "，失败 " + failures : "，通过")
  + (hints > 0 ? "，提示 " + hints + " 条（不阻塞）" : ""));
process.exitCode = failures ? 1 : 0;
