import path from "node:path";
import fs from "node:fs";
import { DESKTOP_RELEASE_FORMS, desktopFormOf } from "./desktop-forms.js";

/** 当前已接线的宿主面。gui / tui 先能识别，适配仍回退 web。 */
export const SURFACES = Object.freeze(["web", "desktop", "gui", "tui"]);

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function slash(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

/** 安装树提示：名字来自发行形态名单；harness 那一项还必须带 resources/（见下）。 */
function formPathHint(form, n) {
  const hinted = (form.dirHints || []).some((hint) => n.includes(hint))
    || Boolean(form.dirPattern && form.dirPattern.test(n));
  if (!hinted) return false;
  if (!form.dirNeedsResources) return true;
  return n.includes("/resources/") || n.includes("/contents/resources/") || n.endsWith("/resources");
}

export function pathLooksDesktop(p) {
  const n = slash(p);
  if (!n) return false;
  // 只认「路径尾部是某个形态的 exe」：安装目录名本身不算（harness 那类名字到处都是），
  // 目录形态交给下面的 resources/ 结构判定，与改动前一致。
  const tail = n.slice(n.lastIndexOf("/") + 1);
  if (tail.endsWith(".exe") && desktopFormOf(tail)) return true;
  // 安装目录可能叫 "DeepSeek Harness" / "DeepSeekHarnessDesktop" / "DSH Desktop"。
  // 源码仓库与 npm 前缀也常带这些名字，所以 harness 那一项还要带 resources/ 才算桌面安装。
  return (
    DESKTOP_RELEASE_FORMS.some((form) => formPathHint(form, n))
    || n.includes("dsh-plugin-desktop")
    || n.endsWith("/host-process-entry.js")
    || n.endsWith("/desktop-cli.js")
  );
}

function resourcesLookLikeDesktopInstall(resourcesPath) {
  if (!resourcesPath) return false;
  if (pathLooksDesktop(resourcesPath)) return true;
  const n = slash(resourcesPath);
  if (!(n.endsWith("/resources") || n.includes("/contents/resources"))) return false;
  try {
    const asar = path.join(resourcesPath, "app.asar");
    if (fs.existsSync(asar) && fs.statSync(asar).isFile()) return true;
    if (fs.existsSync(path.join(resourcesPath, "app", "dsh"))) return true;
    if (fs.existsSync(path.join(resourcesPath, "app.asar.unpacked", "dsh"))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export function isDesktopSurface(input = {}) {
  const env = input.env ?? process.env;
  const forced = norm(env.DSH_SURFACE);
  if (forced === "desktop") return true;
  if (forced && SURFACES.includes(forced)) return false;

  const execPath = input.execPath ?? process.execPath;
  // ① 发行形态：名字落在名单里（官方 Harness / DSH Desktop / DSH NEXT）。
  if (desktopFormOf(execPath)) return true;
  if (pathLooksDesktop(execPath)) return true;

  const resourcesPath = input.resourcesPath ?? process.resourcesPath;
  if (resourcesLookLikeDesktopInstall(resourcesPath)) return true;

  const argv = input.argv ?? process.argv;
  if ((Array.isArray(argv) ? argv : []).some((arg) => pathLooksDesktop(arg))) return true;

  const parentPort = input.parentPort !== undefined ? input.parentPort : process.parentPort;
  if (parentPort && (pathLooksDesktop(execPath) || resourcesLookLikeDesktopInstall(resourcesPath))) return true;

  if (env.ELECTRON_RUN_AS_NODE && (pathLooksDesktop(execPath) || resourcesLookLikeDesktopInstall(resourcesPath))) return true;
  return false;
}

function forcedSurface(env) {
  const forced = norm(env.DSH_SURFACE);
  return SURFACES.includes(forced) ? forced : "";
}

export function detectSurface(input = {}) {
  const env = input.env ?? process.env;
  const forced = forcedSurface(env);
  if (forced) return forced;
  if (isDesktopSurface(input)) return "desktop";
  return "web";
}

/** gui / tui 尚未单独适配，先走 web 重启与探测。 */
export function adapterFor(kind) {
  return kind === "desktop" ? "desktop" : "web";
}
