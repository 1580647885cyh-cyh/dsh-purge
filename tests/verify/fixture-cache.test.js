import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FIXTURE_RECIPE, prepareFixtureHost } from "../../lib/verify/admin-entry.js";
import { fixtureCacheKey, fixtureCacheRoot, openFixtureCache } from "../../lib/verify/fixture-cache.js";
import { buildReport, renderReportMarkdown } from "../../lib/verify/report.js";
import { snapshotTree } from "../../lib/verify/isolate.js";
import { tempDir } from "./helpers.js";

/**
 * fixture 缓存的接缝：prepareFixtureHost 的返回值（source / cache）与副本落盘结果。
 * 归档只用「头表 + 数据区」的最小构造，断言的是缓存行为（命中/失效/重建），
 * 归档解析本身由隔离验证入口在真实 app.asar 上覆盖。
 */

const SHELL_VERSION = "0.2.1-rc.5";

/** 造一份 asar 兼容的最小归档：头部读法与 lib/verify/asar.js 一致。 */
function writeAsar(file, entries) {
  const root = { files: {} };
  const blobs = [];
  let offset = 0;
  for (const [rel, content] of Object.entries(entries)) {
    const parts = rel.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      node.files[part] = node.files[part] || { files: {} };
      node = node.files[part];
    }
    const buffer = Buffer.from(content, "utf8");
    node.files[parts[parts.length - 1]] = { size: buffer.length, offset };
    offset += buffer.length;
    blobs.push(buffer);
  }
  const raw = Buffer.from(JSON.stringify(root), "utf8");
  const headerSize = Math.ceil(raw.length / 4) * 4;
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(headerSize + 8, 4);
  head.writeUInt32LE(headerSize + 4, 8);
  head.writeUInt32LE(headerSize, 12);
  fs.writeFileSync(file, Buffer.concat([head, raw, Buffer.alloc(headerSize - raw.length, 0), ...blobs]));
}

const FIXTURE_PKGS = ["dsh-agent-instructions", "dsh-system-prompt", "dsh-tools", "cordis"];

function asarEntries(tag) {
  const entries = {};
  for (const pkg of FIXTURE_PKGS) {
    entries["dsh/node_modules/@deepseek-ai/" + pkg + "/package.json"] = JSON.stringify({ name: "@deepseek-ai/" + pkg, version: tag });
    entries["dsh/node_modules/@deepseek-ai/" + pkg + "/lib/index.js"] = "export const tag = " + JSON.stringify(tag) + ";\n";
  }
  entries["dsh/node_modules/@standard-schema/package.json"] = JSON.stringify({ name: "@standard-schema" });
  entries["dsh/node_modules/@earendil-works/pi-ai/dist/api/package.json"] = JSON.stringify({ name: "pi-ai-api" });
  return entries;
}

/** 工作区：归档 + 缓存根 + 每次运行各自的副本目录。 */
function sandbox(label) {
  const root = tempDir(label + "-");
  const asarPath = path.join(root, "app.asar");
  writeAsar(asarPath, asarEntries("v1"));
  return {
    root,
    asarPath,
    cacheRoot: path.join(root, "cache"),
    run(n) {
      return path.join(root, "run" + n, "desktop");
    },
    prepare(n, extra = {}) {
      return prepareFixtureHost({
        hostBase: path.join(root, "no-such-host-base"),
        installDir: this.run(n),
        shellVersion: SHELL_VERSION,
        asarPath,
        cacheRoot: this.cacheRoot,
        ...extra,
      });
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("fixture 缓存：第一次从 asar 解，第二次命中缓存直接复制", () => {
  const box = sandbox("fixture-cache-hit");
  try {
    const first = box.prepare(1);
    assert.equal(first.source, "asar", "首次没有缓存，必须从 asar 解");
    assert.equal(first.cache.hit, false);
    assert.deepEqual(first.copied, FIXTURE_PKGS);
    assert.deepEqual(first.copiedExtras, ["dsh/node_modules/@standard-schema", "dsh/node_modules/@earendil-works/pi-ai/dist/api"]);
    assert.ok(fs.existsSync(path.join(box.run(1), "resources", "app", "dsh", "node_modules", "@deepseek-ai", "dsh-tools", "package.json")));

    const cacheDir = path.join(box.cacheRoot, fixtureCacheKey(box.asarPath));
    assert.ok(fs.existsSync(path.join(cacheDir, "fixture.json")), "缓存要留一份清单");
    assert.equal(cacheDir, first.cache.dir);

    const second = box.prepare(2);
    assert.equal(second.source, "cache", "第二次应命中缓存");
    assert.equal(second.cache.hit, true);
    assert.equal(second.cache.key, first.cache.key);
    assert.deepEqual(second.copied, first.copied);
    // 命中走的是整棵复制：两份副本逐文件一致。
    assert.deepEqual(snapshotTree(box.run(2)), snapshotTree(box.run(1)));
  } finally {
    box.cleanup();
  }
});

test("fixture 缓存：asar 的 size/mtime 变了就自动失效", () => {
  const box = sandbox("fixture-cache-invalidate");
  try {
    const first = box.prepare(1);
    const second = box.prepare(2);
    assert.equal(second.source, "cache");

    // 只改 mtime：同一份内容，但宿主被重新写过，缓存必须换键。
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(box.asarPath, later, later);
    const touched = box.prepare(3);
    assert.equal(touched.source, "asar", "mtime 变了要重新解");
    assert.notEqual(touched.cache.key, first.cache.key);

    // 改大小（新增一个包）：键跟着变，新副本里才有新包。
    writeAsar(box.asarPath, { ...asarEntries("v2"), "dsh/node_modules/@deepseek-ai/dsh-web-app/package.json": JSON.stringify({ name: "dsh-web-app" }) });
    const grown = box.prepare(4);
    assert.equal(grown.source, "asar");
    assert.notEqual(grown.cache.key, touched.cache.key);
    assert.ok(grown.copied.includes("dsh-web-app"));
  } finally {
    box.cleanup();
  }
});

test("fixture 缓存：缺 package.json、少包、清单损坏都会重建", () => {
  const box = sandbox("fixture-cache-rebuild");
  try {
    const first = box.prepare(1);
    const cacheDir = first.cache.dir;
    const pkgDir = (n) => path.join(cacheDir, "desktop", "resources", "app", "dsh", "node_modules", "@deepseek-ai", n);

    // 1) 缓存里的 package.json 被删掉。
    fs.rmSync(path.join(pkgDir("dsh-tools"), "package.json"));
    const one = box.prepare(2);
    assert.equal(one.source, "asar", "缺 package.json 要重建");
    assert.match(one.cache.rebuildReason, /package\.json/);
    assert.ok(fs.existsSync(path.join(pkgDir("dsh-tools"), "package.json")), "重建后缓存要补齐");

    // 2) 少包：整个包目录没了。
    fs.rmSync(pkgDir("cordis"), { recursive: true, force: true });
    const two = box.prepare(3);
    assert.equal(two.source, "asar");
    assert.match(two.cache.rebuildReason, /cordis/);

    // 3) 清单本身损坏。
    fs.writeFileSync(path.join(cacheDir, "fixture.json"), "{ not json", "utf8");
    const three = box.prepare(4);
    assert.equal(three.source, "asar");
    assert.match(three.cache.rebuildReason, /清单/);

    // 重建之后又能命中。
    const four = box.prepare(5);
    assert.equal(four.source, "cache");
  } finally {
    box.cleanup();
  }
});

test("fixture 缓存：宿主版本不一致时不复用旧副本", () => {
  const box = sandbox("fixture-cache-version");
  try {
    const first = box.prepare(1);
    const other = box.prepare(2, { shellVersion: "0.2.2-rc.1" });
    assert.equal(other.source, "asar", "宿主编译版本变了，旧副本不能复用");
    assert.equal(other.cache.key, first.cache.key, "键仍由 asar 身份决定");
    assert.match(other.cache.rebuildReason, /宿主版本/);
    const written = fs.readFileSync(path.join(box.run(2), "resources", "app", "package.json"), "utf8");
    assert.match(written, /0\.2\.2-rc\.1/);
  } finally {
    box.cleanup();
  }
});

test("fixture 缓存：配方变了就不复用（加包不会静默少包）", () => {
  const box = sandbox("fixture-cache-recipe");
  try {
    box.prepare(1);
    const cacheDir = path.join(box.cacheRoot, fixtureCacheKey(box.asarPath));
    const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "fixture.json"), "utf8"));
    assert.deepEqual(manifest.recipe.packages, FIXTURE_RECIPE.packages, "清单要记下这次用的配方");
    assert.deepEqual(manifest.recipe.extras, FIXTURE_RECIPE.extras);

    const same = openFixtureCache({ asarPath: box.asarPath, shellVersion: SHELL_VERSION, cacheRoot: box.cacheRoot, recipe: FIXTURE_RECIPE });
    assert.ok(same.manifest, "同一份配方应当可用");
    // 键只看 asar，配方变了键不变：不比对配方就会拿旧缓存静默少包。
    const drifted = openFixtureCache({
      asarPath: box.asarPath,
      shellVersion: SHELL_VERSION,
      cacheRoot: box.cacheRoot,
      recipe: { packages: [...FIXTURE_RECIPE.packages, "dsh-web-app"], extras: FIXTURE_RECIPE.extras },
    });
    assert.equal(drifted.manifest, null, "加包之后旧缓存不能再用");
    assert.match(drifted.summary().rebuildReason, /配方/);
  } finally {
    box.cleanup();
  }
});

test("fixture 缓存：命中后复制失败记下原因，不假装命中", () => {
  const box = sandbox("fixture-cache-copy-fail");
  try {
    box.prepare(1);
    const cache = openFixtureCache({ asarPath: box.asarPath, shellVersion: SHELL_VERSION, cacheRoot: box.cacheRoot, recipe: FIXTURE_RECIPE });
    assert.ok(cache.manifest);
    // 目标位置的父路径被文件占住：整棵复制必然失败，口径要从「命中」退回「没命中 + 原因」。
    const blocked = path.join(box.root, "blocked");
    fs.writeFileSync(blocked, "x", "utf8");
    assert.equal(cache.use(path.join(blocked, "desktop")), false);
    const summary = cache.summary();
    assert.equal(summary.hit, false, "复制失败就不能算命中");
    assert.match(summary.rebuildReason, /复制失败/);
  } finally {
    box.cleanup();
  }
});

test("fixture 缓存：缓存写不进去也不阻断验证，回退到 asar", () => {
  const box = sandbox("fixture-cache-broken");
  try {
    // 缓存根被一个同名文件占住：写不进缓存目录。
    fs.writeFileSync(box.cacheRoot, "not a dir", "utf8");
    const fixture = box.prepare(1);
    assert.equal(fixture.source, "asar");
    assert.ok(fixture.cache.error.length > 0, "写不进缓存要在报告里留错误：" + JSON.stringify(fixture.cache));
    assert.ok(fs.existsSync(path.join(box.run(1), "resources", "app", "dsh", "node_modules", "@deepseek-ai", "dsh-tools", "package.json")), "副本本身仍要建好");
  } finally {
    box.cleanup();
  }
});

test("fixture 缓存根落在验证根目录下的 _fixture-cache", () => {
  const root = tempDir("fixture-cache-root-");
  try {
    assert.equal(fixtureCacheRoot(root), path.join(path.resolve(root), "_fixture-cache"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("报告把 fixture 来源写进 fixture 段，asar 与 cache 可区分", () => {
  const workspace = { root: "D:/x/stamp", home: "D:/x/stamp/home", install: "D:/x/stamp/desktop", out: "D:/x/stamp/out" };
  const asarReport = buildReport({ workspace, fixture: { source: "asar", copied: ["dsh-tools", "cordis"], copiedExtras: [], cache: { key: "asar-1-2", dir: "D:/x/_fixture-cache/asar-1-2", hit: false, rebuildReason: "" } } });
  assert.equal(asarReport.fixture.source, "asar");
  assert.equal(asarReport.fixture.cacheHit, false);
  assert.equal(asarReport.fixture.packages, 2);
  const cacheReport = buildReport({ workspace, fixture: { source: "cache", copied: ["dsh-tools"], copiedExtras: [], cache: { key: "asar-1-2", dir: "D:/x/_fixture-cache/asar-1-2", hit: true, rebuildReason: "" } } });
  assert.equal(cacheReport.fixture.source, "cache");
  assert.equal(cacheReport.fixture.cacheHit, true);
  const markdown = renderReportMarkdown(cacheReport);
  assert.match(markdown, /fixture 来源：cache/);
  assert.match(renderReportMarkdown(asarReport), /fixture 来源：asar/);
});
