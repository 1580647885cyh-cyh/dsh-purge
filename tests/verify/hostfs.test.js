import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { hostFs } from "../../lib/extract-asar.js";
import { patchShim, refreshStaleBaksForUpgrade, shimFileStatus } from "../../lib/core.js";
import { assertDriveDPath } from "../../lib/verify/isolate.js";

/**
 * 文件探测与管理操作里的文件描述符路径。
 *
 * 宿主包（app.asar 仍在时）的文件都经 hostFs 代理读写；备份占位符、文本/二进制判定
 * 都通过 fd 完成。这里直接观察代理的 fd 契约与 classify 契约，不依赖真实宿主。
 */

const TEST_ROOT = assertDriveDPath("D:\\dsh\\tmp\\dsh-purge-test", "测试根目录");

function tempDir(label) {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TEST_ROOT, label));
}

test("hostFs 支持 fd 写入、读取、状态与关闭，关闭后的错误可观察", () => {
  const dir = tempDir("fd-");
  const file = path.join(dir, "fd-probe.txt");
  try {
    const fd = hostFs.openSync(file, "w+");
    try {
      const payload = Buffer.from("verify-fd-probe", "utf8");
      assert.equal(hostFs.writeSync(fd, payload, 0, payload.length), payload.length);
      hostFs.fsyncSync(fd);
      const stat = hostFs.fstatSync(fd);
      assert.equal(stat.size, payload.length);
      const buf = Buffer.alloc(payload.length);
      assert.equal(hostFs.readSync(fd, buf, 0, payload.length, 0), payload.length);
      assert.equal(buf.toString("utf8"), "verify-fd-probe");
    } finally {
      hostFs.closeSync(fd);
    }
    assert.equal(fs.readFileSync(file, "utf8"), "verify-fd-probe");
    assert.throws(() => hostFs.fstatSync(fd), (error) => {
      assert.ok(error && error.code, "关闭后的 fd 应抛出带错误码的异常");
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("无害文本入口、普通文件和非文本文件在管理操作中被区分", async () => {
  const dir = tempDir("shim-");
  const home = tempDir("shim-home-");
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const ps1 = path.join(dir, "dsh.ps1");
  const bin = path.join(dir, "dsh");
  const plain = path.join(dir, "notes.txt");
  const binaryBytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x00]);
  try {
    fs.writeFileSync(ps1, "# dsh launcher\nexit 0\n", "utf8");
    fs.writeFileSync(bin, binaryBytes);
    fs.writeFileSync(plain, "ordinary text, not a launcher\n", "utf8");

    // 判定入口本身必须能读前 512 字节并关闭 fd，不能把所有文件都当成不可读。
    assert.equal(shimFileStatus(ps1), "original");
    assert.equal(shimFileStatus(bin), "binary");
    assert.equal(shimFileStatus(plain), "binary");

    const result = await patchShim(dir);
    assert.equal(result["dsh.ps1"], "patched");
    assert.equal(result.dsh, "skipped_binary");
    assert.equal(shimFileStatus(ps1), "patched");
    assert.equal(shimFileStatus(bin), "binary");
    assert.ok(fs.readFileSync(ps1, "utf8").includes("dsh-purge shim"));

    // 非文本文件按字节保持原样，普通文件不参与 shim 写入。
    assert.deepEqual(fs.readFileSync(bin), binaryBytes);
    assert.equal(fs.readFileSync(plain, "utf8"), "ordinary text, not a launcher\n");
    assert.equal(fs.existsSync(path.join(dir, "notes.txt.dshpurge.bak")), false);
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("已打补丁的宿主文件不会被误判为宿主升级，bak 保持原样", () => {
  const aiBase = tempDir("upgrade-");
  try {
    const instructionLib = path.join(aiBase, "dsh-agent-instructions", "lib");
    fs.mkdirSync(instructionLib, { recursive: true });
    const patchedText = 'const WORKSPACE_CONTEXT_INTRO = "The following instructions are ACTIVE and MANDATORY for the stated scope.";\n';
    const officialText = 'const WORKSPACE_CONTEXT_INTRO = "The following workspace instructions may be relevant to your work.";\n';
    const instruction = path.join(instructionLib, "index.js");
    fs.writeFileSync(instruction, patchedText, "utf8");
    fs.writeFileSync(instruction + ".dshpurge.bak", officialText, "utf8");

    // 对照：官方升级后的新文件（没有补丁痕迹）才应该刷新 bak。
    const promptLib = path.join(aiBase, "dsh-system-prompt", "lib");
    fs.mkdirSync(promptLib, { recursive: true });
    const upgraded = path.join(promptLib, "index.js");
    fs.writeFileSync(upgraded, "// official 0.2.1-rc.5 upgrade\n", "utf8");
    fs.writeFileSync(upgraded + ".dshpurge.bak", "// official 0.2.0-rc.2 baseline\n", "utf8");

    const refreshed = refreshStaleBaksForUpgrade(aiBase);
    assert.deepEqual(refreshed, [upgraded], "只有真正的宿主升级文件应刷新 bak");
    assert.equal(fs.readFileSync(instruction + ".dshpurge.bak", "utf8"), officialText);
    assert.equal(fs.readFileSync(upgraded + ".dshpurge.bak", "utf8"), "// official 0.2.1-rc.5 upgrade\n");
  } finally {
    fs.rmSync(aiBase, { recursive: true, force: true });
  }
});

