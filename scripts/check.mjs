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
const SKIP_DIRS = new Set(["node_modules", ".git", ".scratch"]);

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

console.log("check: " + relative.length + " 个文件，" + entries.length + " 个入口" + (failures ? "，失败 " + failures : "，通过"));
process.exitCode = failures ? 1 : 0;
