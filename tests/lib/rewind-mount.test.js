import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 撤销按钮的挂载方式（跟随上游 1.1.90 / #208，2026-11-04）。
 *
 * 症状：Android WebView 切后台回来，整个输入框消失，连带撤销按钮。
 * 根因：按钮注册在 conversation.input.right，那个槽位渲染在 composer 的 React 子树里；
 *       宿主提交阶段抛一次错，React 把整棵子树卸载。
 * 修法：不再走槽位，改挂 body 上的 fixed 宿主 + createPortal，位置按最靠下的
 *       .standardControls 矩形对齐，并给它留出空位。
 *
 * 这条修复在 CI 里看不见（没有浏览器），所以用静态断言钉住结构不变量：
 * 一旦有人把槽位注册加回来、或把 portal 挂载删掉，这里就红。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const client = readFileSync(path.join(repoRoot, "client.js"), "utf8");

test("#208：不再注册 conversation.input.right 槽位", () => {
  assert.equal(client.includes('id: "dsh-purge-rewind"'), false,
    "撤销按钮又被注册回 composer 的槽位了 —— 那正是输入框被整块卸载的原因");
  // 注释里可以提到槽位名（解释为什么不用），但不能再有 register 调用。
  // 注释里可以留旧写法的痕迹（解释为什么不用），只查真正的调用行。
  const registerLines = client
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter((line) => /slots\.(inject|register)/.test(line) && line.includes("conversation.input.right"));
  assert.deepEqual(registerLines, [], "仍然有 conversation.input.right 的槽位注册：" + registerLines.join(" | "));
});

test("#208：按钮挂在 body 的 fixed 宿主里，且由覆盖层挂载", () => {
  assert.ok(client.includes('const REWIND_HOST_ATTR = "data-dsh-purge-rewind-host"'), "缺少 body 宿主标记");
  assert.ok(client.includes("function RewindDockMount()"), "缺少 RewindDockMount 组件");
  assert.ok(client.includes("h(RewindDockMount)"), "覆盖层没有挂载 RewindDockMount —— 组件存在但没人渲染");
  assert.ok(client.includes('document.body.appendChild(el)'), "宿主节点没有挂到 body");
  assert.ok(client.includes("rd.createPortal(h(RewindSafe"), "没有用 portal 渲染按钮");
  assert.ok(client.includes("el.remove()"), "卸载时没有移除 body 宿主（会留下空 div）");
});

test("#208：对齐与留白按最靠下的 .standardControls", () => {
  assert.ok(client.includes('[class*="standardControls"]'), "没有找 composer 底部工具条");
  assert.ok(client.includes("rect.top >= bestTop"), "没有按「最靠下」挑锚点（会抢到消息工具条里的同名控件）");
  assert.ok(client.includes("const REWIND_RESERVE_PX = 64"), "缺少预留宽度常量");
  assert.ok(client.includes("Math.max(REWIND_RESERVE_PX"), "预留宽度没有跟按钮实测宽度走（标签变长会压到模型选择器）");
  assert.ok(client.includes("padded.style.paddingLeft = padded.dataset.dshpPad"), "没有归还留白的路径（无会话时应恢复）");
});

test("#208：面板盖住 composer 时让位（本次实测补充）", () => {
  assert.ok(client.includes("function rewindDockCovers"), "缺少遮挡判断");
  assert.ok(client.includes('.dshp-dock:not([data-open="0"])'), "没有识别「面板已打开」");
  assert.ok(client.includes("if (rewindDockCovers(anchor.getBoundingClientRect()))"), "place() 没有调用遮挡判断");
});

test("#208：锚点查找带缓存与节流，且无会话时隐藏", () => {
  assert.ok(client.includes("now - lastQuery > 1000"), "锚点查找没有节流 —— 长会话滚动会被拖慢");
  assert.ok(client.includes("!padded.isConnected"), "没有检测锚点掉线（宿主重挂后不会重新对齐）");
  assert.ok(client.includes("if (!sessionRef.current)"), "没有「无会话时隐藏」的分支");
  assert.ok(client.includes('document.addEventListener("scroll", onMove, true)'), "滚动时没有重新对齐");
});
