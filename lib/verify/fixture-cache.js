import fs from "node:fs";
import path from "node:path";
import { assertDriveDPath, VERIFY_ROOT } from "./isolate.js";

/**
 * 验证 fixture 缓存（#11）。
 *
 * 每轮验证都需要一份「未打补丁的宿主副本」，旧实现每次都从 182 MB 的 app.asar 重解
 * 四十多个宿主包。这里把解出来的副本按宿主身份留一份，下一轮直接整棵复制。
 *
 * 三条边界：
 * - 键 = app.asar 的 size + mtime：换宿主、换包，键就变，旧目录自然不再命中。
 * - 缓存落在验证根目录旁边（默认 D:\dsh\tmp\dsh-purge-verify\_fixture-cache），不属于
 *   工作区，因此不进保护基线、不进工作区快照、也不参与真实安装守卫（守卫只看真实安装的
 *   targetFiles）；删掉整个目录只影响下次快慢。
 * - 任何缓存故障（写不进、被并发抢占、读到半成品）都只回退到「从 asar 解」，不让验证失败。
 *
 * 清单里同时记下缓存键、宿主编译版本与 fixture 配方（要解哪些包、哪些额外依赖）：
 * 键只由 asar 决定，配方变了仍会换键相同的缓存，所以配方必须单独比对，否则往
 * FIXTURE_PACKAGES 里加包后旧缓存会静默少包、把固定契约豁免掉（规则 7）。
 */

const FIXTURE_CACHE_DIR_NAME = "_fixture-cache";
const FIXTURE_TREE_DIR_NAME = "desktop";
const MANIFEST_NAME = "fixture.json";

/** 缓存根：验证根目录下的 _fixture-cache。 */
export function fixtureCacheRoot(base = VERIFY_ROOT) {
  return assertDriveDPath(path.join(assertDriveDPath(base, "验证根目录"), FIXTURE_CACHE_DIR_NAME), "fixture 缓存根");
}

/** 缓存键 = app.asar 的 size + mtime。 */
export function fixtureCacheKey(asarPath) {
  const stat = fs.statSync(asarPath);
  if (!stat.isFile()) throw new Error("asar 不是文件：" + asarPath);
  return "asar-" + stat.size + "-" + Math.round(stat.mtimeMs);
}

function manifestFile(dir) {
  return path.join(dir, MANIFEST_NAME);
}

function treeDir(dir) {
  return path.join(dir, FIXTURE_TREE_DIR_NAME);
}

function readManifest(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(manifestFile(dir), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function message(error) {
  return String(error && error.message ? error.message : error);
}

function recipeText(recipe) {
  return JSON.stringify({
    packages: (recipe && recipe.packages) || [],
    extras: (recipe && recipe.extras) || [],
  });
}

/**
 * 清单与副本对不对得上这次的身份：配方、宿主编译版本、两层 package.json、
 * 每个包有 package.json、每份额外依赖在。返回 "" 表示可用，否则给出重建原因。
 */
function treeProblem(dir, manifest, { key, shellVersion, recipe } = {}) {
  if (manifest.key !== key) return "缓存键不匹配（" + manifest.key + " ≠ " + key + "）";
  if (manifest.shellVersion !== shellVersion) return "宿主版本不一致（" + manifest.shellVersion + " ≠ " + shellVersion + "）";
  if (recipeText(manifest.recipe) !== recipeText(recipe)) return "fixture 配方已变（要解的包或额外依赖与清单不同）";
  if (!Array.isArray(manifest.copied) || manifest.copied.length === 0) return "清单没有包列表";
  const tree = treeDir(dir);
  if (!fs.existsSync(tree)) return "缺少 " + FIXTURE_TREE_DIR_NAME + " 副本";
  const appDir = path.join(tree, "resources", "app");
  for (const file of ["package.json", path.join("dsh", "package.json")]) {
    if (!fs.existsSync(path.join(appDir, file))) return "缺少 " + file;
  }
  for (const pkg of manifest.copied) {
    const pkgDir = path.join(appDir, "dsh", "node_modules", "@deepseek-ai", pkg);
    if (!fs.existsSync(pkgDir)) return "少包：" + pkg;
    if (!fs.existsSync(path.join(pkgDir, "package.json"))) return "包不完整（缺 package.json）：" + pkg;
  }
  for (const innerPath of manifest.copiedExtras || []) {
    if (!fs.existsSync(path.join(appDir, ...String(innerPath).split("/")))) return "缺依赖：" + innerPath;
  }
  return "";
}

/** 看一眼缓存目录：清单只读一次，用到最后；未命中时 reason 说明为什么要重建。 */
function inspectCache(dir, { key, shellVersion, recipe } = {}) {
  if (!fs.existsSync(dir)) return { manifest: null, reason: "缓存目录不存在" };
  const manifest = readManifest(dir);
  if (!manifest) return { manifest: null, reason: "清单缺失或损坏（" + MANIFEST_NAME + "）" };
  const reason = treeProblem(dir, manifest, { key, shellVersion, recipe });
  return { manifest: reason === "" ? manifest : null, reason };
}

/** 缓存不可用时的占位条目：结构一致，永远未命中。 */
function unavailableCache(reason, error) {
  return {
    key: "",
    dir: "",
    manifest: null,
    summary() {
      return { key: "", dir: "", hit: false, rebuildReason: reason, error };
    },
    use() {
      return false;
    },
    rebuild() {
      throw new Error(error || reason || "fixture 缓存不可用");
    },
  };
}

/**
 * 打开一份 fixture 缓存条目（不写盘）：
 * - use(installDir)：命中时把缓存副本整棵复制进去，成功返回 true；
 * - rebuild(installDir, builder)：先写缓存目录旁边的临时目录、成功后再换名并复制到 installDir，
 *   半成品永远不会被当成命中；返回写进清单的内容；
 * - summary()：进报告的结构性事实（以本轮实际用上的来源为准）。
 *
 * 不抛错：打不开、读不了只退化成「未命中」，让调用方直接去解 asar。
 */
export function openFixtureCache({ asarPath, shellVersion, recipe, cacheRoot = fixtureCacheRoot() } = {}) {
  let key = "";
  let dir = "";
  try {
    key = fixtureCacheKey(asarPath);
    dir = path.join(cacheRoot, key);
  } catch (error) {
    return unavailableCache("无法读取 asar 身份", message(error));
  }
  const inspected = inspectCache(dir, { key, shellVersion, recipe });
  // served 记录本轮到底用了哪条路：cache（命中）、rebuilt（重建）、none（缓存没用上）。
  let served = "none";
  let rebuildReason = inspected.reason;
  let lastError = "";
  return {
    key,
    dir,
    manifest: inspected.manifest,
    use(installDir) {
      try {
        fs.cpSync(treeDir(dir), installDir, { recursive: true });
        served = "cache";
        return true;
      } catch (error) {
        lastError = message(error);
        rebuildReason = "命中后复制失败，改为重建：" + lastError;
        return false;
      }
    },
    rebuild(installDir, builder) {
      try {
        fs.mkdirSync(cacheRoot, { recursive: true });
        const tmp = dir + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2, 8);
        fs.rmSync(tmp, { recursive: true, force: true });
        let built = null;
        try {
          const tree = treeDir(tmp);
          fs.mkdirSync(tree, { recursive: true });
          const filled = builder(tree) || {};
          built = {
            key,
            shellVersion,
            asarPath: String(asarPath),
            recipe: JSON.parse(recipeText(recipe)),
            builtAt: new Date().toISOString(),
            copied: filled.copied || [],
            copiedExtras: filled.copiedExtras || [],
          };
          fs.writeFileSync(manifestFile(tmp), JSON.stringify(built, null, 2) + "\n", "utf8");
          fs.rmSync(dir, { recursive: true, force: true });
          fs.renameSync(tmp, dir);
        } catch (error) {
          fs.rmSync(tmp, { recursive: true, force: true });
          // 并发下另一个进程可能刚好换名成功：它能用就认它的副本。
          const raced = inspectCache(dir, { key, shellVersion, recipe });
          if (!raced.manifest) throw error;
          built = raced.manifest;
        }
        fs.cpSync(treeDir(dir), installDir, { recursive: true });
        served = "rebuilt";
        return built;
      } catch (error) {
        lastError = message(error);
        throw error;
      }
    },
    summary() {
      return {
        key,
        dir,
        hit: served === "cache",
        rebuildReason: served === "cache" ? "" : rebuildReason || "",
        error: lastError,
      };
    },
  };
}
