import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildManifest,
  environmentFingerprint,
  gitRelation,
  hostFingerprint,
  pluginFingerprint,
  readJson,
  sealBaseline,
  verifyBaseline,
} from "../../lib/verify/baseline.js";

const TEST_ROOT = "D:\\dsh\\tmp\\dsh-purge-test";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function tempSource(label) {
  const root = path.join(TEST_ROOT, label + "-" + process.pid + "-" + Date.now());
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture-plugin", version: "1.1.71", dsh: { localVersionLock: { version: "1.1.71", remoteUpdates: false, editable: true } } }, null, 2));
  fs.writeFileSync(path.join(root, "lib", "index.js"), "export const name = \"fixture\";\n");
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return root;
}

test("buildManifest 覆盖随包文件并排除 .git", () => {
  const root = tempSource("manifest");
  const manifest = buildManifest(root);
  const paths = manifest.files.map((file) => file.path);
  assert.deepEqual(paths, ["lib/index.js", "package.json"]);
  assert.equal(manifest.fileCount, 2);
  assert.match(manifest.treeHash, /^[0-9a-f]{64}$/);
  const again = buildManifest(root);
  assert.equal(again.treeHash, manifest.treeHash);
});

test("sealBaseline 写快照，verifyBaseline 检测改动/新增/删除", () => {
  const root = tempSource("seal");
  const outDir = path.join(TEST_ROOT, "baseline-" + process.pid + "-" + Date.now());
  const sealed = sealBaseline({ root, outDir, stamp: "unit" });
  assert.ok(fs.existsSync(sealed.file));
  assert.ok(fs.existsSync(path.join(outDir, "latest.json")));
  const latest = readJson(path.join(outDir, "latest.json"));
  assert.equal(latest.kind, "dsh-purge-baseline");
  assert.equal(latest.plugin.version, "1.1.71");
  assert.equal(latest.plugin.localVersionLock.remoteUpdates, false);
  assert.equal(latest.source.fileCount, 2);
  assert.equal(verifyBaseline({ root, baseline: sealed.baseline }).ok, true);
  fs.writeFileSync(path.join(root, "lib", "index.js"), "changed\n");
  fs.writeFileSync(path.join(root, "lib", "added.js"), "new\n");
  fs.rmSync(path.join(root, "package.json"));
  const drift = verifyBaseline({ root, baseline: sealed.baseline });
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.changed.map((item) => item.path), ["lib/index.js"]);
  assert.deepEqual(drift.added, ["lib/added.js"]);
  assert.deepEqual(drift.removed, ["package.json"]);
});

test("pluginFingerprint 读取当前维护版版本与更新锁", () => {
  const plugin = pluginFingerprint(REPO_ROOT);
  assert.equal(plugin.name, "dsh-purge");
  assert.equal(plugin.version, "1.1.71");
  assert.equal(plugin.localVersionLock.version, "1.1.71");
  assert.equal(plugin.localVersionLock.remoteUpdates, false);
  assert.match(plugin.packageJsonSha256, /^[0-9a-f]{64}$/);
});

test("gitRelation 读取本地与用户远端关系", () => {
  const relation = gitRelation(REPO_ROOT);
  assert.equal(relation.available, true);
  assert.equal(relation.branch, "main");
  assert.ok(relation.dirtyFiles > 0);
  assert.equal(relation.userRemote, true);
  assert.equal(relation.head, null);
  assert.match(relation.note, /HEAD/);
});

test("hostFingerprint 记录 0.2.1-rc.5 桌面宿主指纹", () => {
  const installDir = process.env.DSH_VERIFY_HOST_DIR || path.join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness");
  if (!fs.existsSync(path.join(installDir, "resources", "app", "package.json"))) {
    test.skip("未安装桌面宿主，跳过");
    return;
  }
  const host = hostFingerprint(installDir);
  assert.equal(host.shellVersion, "0.2.1-rc.5");
  assert.equal(host.runtimeVersion, "0.2.1-rc.5");
  assert.ok(host.appAsar && host.appAsar.size > 0);
});

test("environmentFingerprint 记录运行环境", () => {
  const env = environmentFingerprint({ DSH_SURFACE: "desktop" });
  assert.equal(env.platform, process.platform);
  assert.equal(env.arch, process.arch);
  assert.equal(env.node, process.versions.node);
  assert.equal(env.surface, "desktop");
});
