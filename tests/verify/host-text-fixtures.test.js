import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HOST_TEXT_FIXTURES } from "./host-text-fixtures.js";
import { resolveHostInstall } from "../../lib/verify/host-entry.js";

/**
 * 宿主原文 fixture 的回核（#21 复盘）。
 *
 * 这条只证明一件事：登记为「原文」的文本，确实还是那个宿主文件里的一段。
 * 结构检查永远跑（每份文本要有出处、够长、无 CRLF）；子串核对只在装了桌面宿主的机器上跑，
 * CI / 干净检出时跳过——它核对的是本机安装，不是仓库内容。
 */

function hostBase() {
  try {
    return resolveHostInstall({}).hostBase;
  } catch {
    return "";
  }
}

test("宿主原文 fixture：每份文本都有包/文件出处，够长且不含 CRLF", () => {
  assert.ok(HOST_TEXT_FIXTURES.length > 0, "登记表不能是空的，否则后面的子串核对会退化成空跑");
  for (const entry of HOST_TEXT_FIXTURES) {
    assert.equal(typeof entry.id, "string");
    assert.ok(entry.id.length > 0, "entry 缺 id");
    assert.match(entry.package, /^dsh-[a-z0-9-]+$/, entry.id + " 的 package 要写宿主包目录名（不带 @deepseek-ai/）");
    assert.ok(entry.relative.length > 0 && entry.relative.endsWith(".js"), entry.id + " 的 relative 要指到文件");
    const texts = Object.entries(entry.texts || {});
    assert.ok(texts.length > 0, entry.id + " 没有登记任何文本");
    for (const [name, text] of texts) {
      assert.equal(typeof text, "string", entry.id + "." + name + " 不是字符串");
      assert.ok(text.trim().length > 20, entry.id + "." + name + " 太短：多半又是手写骨架");
      assert.equal(text.includes("\r"), false, entry.id + "." + name + " 含 CRLF，宿主文件是 LF");
    }
  }
});

test("宿主原文 fixture：逐条都是安装目录里那个文件的子串（没有宿主时跳过）", (t) => {
  const base = hostBase();
  if (!base) {
    t.skip("未安装桌面宿主，跳过");
    return;
  }
  for (const entry of HOST_TEXT_FIXTURES) {
    const file = path.join(base, entry.package, entry.relative);
    assert.ok(fs.existsSync(file), entry.id + " 的宿主文件不存在：" + file);
    const host = fs.readFileSync(file, "utf8");
    for (const [name, text] of Object.entries(entry.texts)) {
      assert.ok(
        host.includes(text),
        entry.id + "." + name + " 已经不是宿主原文的子串：宿主改版就更新这里，手写骨架就删掉重抄（" + file + "）",
      );
    }
    // 故障对照：#21 第一版的手写骨架（把 "this GUI", "this app" 缩成一句）必须仍然对不上。
    // 它是这条检查存在的理由——哪天有人把骨架当原文登记回来，这里先红。
    if (entry.id === "dev-context") {
      const skeleton = "You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. When the user refers to \"this page\" they mean this GUI.";
      assert.equal(host.includes(skeleton), false, "手写骨架又被当成原文了：核对抄的是不是宿主字节");
    }
  }
});
