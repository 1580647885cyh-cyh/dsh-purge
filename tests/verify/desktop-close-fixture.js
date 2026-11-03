/**
 * 桌面壳 close 回调的等价形状（#6 / #25）。
 *
 * 这是**故意裁过的等价形状**，不是宿主原文（原文登记在 host-text-fixtures.js，需要有出处）。
 * 缩进照真机：回调 3 个 tab、块内 4 个 tab —— #90 的留痕锚点落在方法头 + suffix 两行上。
 *
 * 两份：rc.5 原文（不收 signal，把 null 并进同一个 if）与旧形态（收 signal，先处理 null/signal）。
 * 入口五与补丁单测共用同一份，避免两处各抄一遍后各自漂。
 */

const TAB = String.fromCharCode(9);
const pad = (n) => TAB.repeat(n);

/** 0.2.1-rc.5 的 close 回调。 */
export const RC5_CLOSE = [
  pad(3) + 'child.once("close", (code) => {',
  pad(4) + 'const suffix = this.stderr.trim() === "" ? "" : `: ${this.stderr.trim()}`;',
  pad(4) + "if (code !== 0 && code !== null) this.fail(/* @__PURE__ */ new Error(`dsh desktop host exited with ${String(code)}${suffix}`));",
  pad(4) + "else this.fail(/* @__PURE__ */ new Error(`dsh desktop host stopped${suffix}`));",
  pad(4) + "resolve();",
  pad(3) + "});",
].join("\n");

/** 旧形态（0.1.x）：close 回调收 signal，先单独处理 null/signal。 */
export const LEGACY_CLOSE = [
  pad(3) + 'child.once("close", (code, signal) => {',
  pad(4) + 'const suffix = this.stderr.trim() === "" ? "" : `: ${this.stderr.trim()}`;',
  pad(4) + "if (code === null || signal) { resolve(); return; }",
  pad(4) + "if (code !== 0) this.fail(/* @__PURE__ */ new Error(`dsh desktop host exited with ${String(code)}${suffix}`));",
  pad(4) + "else this.fail(/* @__PURE__ */ new Error(`dsh desktop host stopped${suffix}`));",
  pad(4) + "resolve();",
  pad(3) + "});",
].join("\n");
