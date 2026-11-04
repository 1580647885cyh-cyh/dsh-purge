import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 暗色主题对比度（跟随上游 1.1.85 / #196，2026-11-04）。
 *
 * 宿主暗色主题把 --dsw-alias-brand-primary 解析为近白色（neutral-bluish-50 #f9fafb），
 * 任何"品牌色作底 + 白字"的按钮都会变成白底白字。这条规则没法在 CI 里用眼睛看，
 * 所以用静态断言钉住三件事：
 *   1. 演练台里每一条"品牌色作底 + 白字"的规则，都有对应的暗色覆盖；
 *   2. 覆盖里同时写 color 与 -webkit-text-fill-color（宿主可能用后者覆盖前者）；
 *   3. 覆盖块真的进了构建产物 client.js —— 改了源却忘记 npm run build:client 会红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const drillSrc = readFileSync(path.join(repoRoot, "lib", "redteam", "client.js"), "utf8");
const bundle = readFileSync(path.join(repoRoot, "client.js"), "utf8");

/** 从基础规则里找出"品牌色作底 + 白字"的选择器（暗色下会变白块的那一类）。 */
function brandOnWhiteSelectors(css) {
  const out = new Set();
  for (const rule of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    const body = rule[2];
    if (!/background:\s*var\(--dsw-alias-brand-primary\)/.test(body)) continue;
    if (!/color:\s*#fff\b/i.test(body)) continue;
    out.add(rule[1]);
  }
  return [...out].sort();
}

const DARK = "body[data-ds-dark-theme]";
const DUSK = '.dshp-dock[data-theme="dusk"]';

/** 把整份 CSS 拆成「选择器列表 + 规则体」，按精确选择器比对（不按子串、不按标记切片）。 */
function cssRules(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    out.push({ selectors: m[1].split(",").map((s) => s.trim()).filter(Boolean), body: m[2] });
  }
  return out;
}

test("暗色覆盖：每一条「品牌色作底 + 白字」的规则都有覆盖", () => {
  const targets = brandOnWhiteSelectors(drillSrc);
  assert.ok(targets.length > 0, "没有找到品牌色作底的规则 —— 选择器解析可能失效，这条断言会变成空转");
  const rules = cssRules(drillSrc);
  for (const name of targets) {
    for (const prefix of [DARK, DUSK]) {
      const selector = `${prefix} .${name}`;
      const hit = rules.find((rule) => rule.selectors.includes(selector) && /background:\s*#3d8f68/.test(rule.body));
      assert.ok(hit, `缺少暗色覆盖（精确选择器 + 绿色实底）：${selector}`);
    }
  }
});

test("暗色覆盖：同时写 color 与 -webkit-text-fill-color", () => {
  const block = drillSrc.slice(drillSrc.indexOf("#196（跟随上游 1.1.85）"));
  assert.ok(block.length > 0, "找不到 #196 覆盖块");
  assert.match(block, /-webkit-text-fill-color:\s*#fff\s*!important/, "必须显式写 -webkit-text-fill-color");
  assert.match(block, /color:\s*#fff\s*!important/, "必须写 color");
  assert.match(block, /#3d8f68/, "暗色主按钮底色应为绿色实底 #3d8f68");
  assert.match(block, /#347a59/, "悬停色应为 #347a59");
});

test("暗色覆盖：已进入构建产物 client.js（忘记 build:client 会红）", () => {
  assert.ok(bundle.includes(`${DARK} .rt-btn-primary`), "client.js 里没有暗色覆盖 —— 改了 lib/redteam/client.js 却忘了 npm run build:client");
  assert.ok(bundle.includes("-webkit-text-fill-color:#fff!important"), "构建产物里缺少 -webkit-text-fill-color");
});
