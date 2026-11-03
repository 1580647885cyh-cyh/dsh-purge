import fs from "node:fs";
import path from "node:path";

/**
 * 目标定位与适配状态（#6）。
 *
 * 这里只回答两个事实问题，不重写补丁语义：
 * 1. 补丁要处理的文件在当前宿主里到底落在哪（或者为什么根本不存在）；
 * 2. 应用之后，目标文件里到底有没有目标态 —— 状态说成功时必须有对应的事实。
 *
 * 判定沿用 core 的 patchEffectState（目标态成立 / 还能匹配到待改原文 / 两者都不成立），
 * 再用 patchOwnMarkPresent 区分「处理写进了文件」与「宿主本来就满足目标态」。
 */

/**
 * 缺失键的可核对证据：这些键在旧布局里存在、在 0.2.1-rc.5 桌面安装里不存在。
 * 只用于解释缺席，不参与解析（解析仍以 core.targetFiles 为准）。
 */
const MISSING_KEY_PATHS = {
  "hooks-claude-code": (aiBase) => [path.join(aiBase, "dsh-hooks-claude-code"), path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-hooks-claude-code")],
  "hooks-claude-code-nested": (aiBase) => [path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-hooks-claude-code")],
  "hooks-codex": (aiBase) => [path.join(aiBase, "dsh-hooks-codex"), path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-hooks-codex")],
  "hooks-codex-nested": (aiBase) => [path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-hooks-codex")],
  "system-prompt-nested": (aiBase) => [path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-system-prompt", "lib", "index.js")],
  "tool-web-nested": (aiBase) => [path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-tool-web", "lib", "index.js")],
  "user-approval-invariant": (aiBase) => [path.join(aiBase, "dsh-user-approval", "lib", "invariant.js"), path.join(aiBase, "dsh", "node_modules", "@deepseek-ai", "dsh-user-approval", "lib", "invariant.js")],
  "preset-unrestricted": (_aiBase, dshHome) => [path.join(dshHome || "", ".agent-presets", "unrestricted", "agent.cordis.yml")],
  "preset-liangshen": (_aiBase, dshHome) => [path.join(dshHome || "", ".agent-presets", "liangshen", "agent.cordis.yml")],
  "preset-liangshen-pkg": (_aiBase, dshHome) => [
    path.join(dshHome || "", "profiles", "desktop", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "agent.cordis.yml"),
    path.join(dshHome || "", "profiles", "web", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen", "agent.cordis.yml"),
  ],
  "liangshen-tool-bootstrap": (_aiBase, dshHome) => [path.join(dshHome || "", ".agent-presets", "liangshen", "tool-bootstrap.mjs")],
};

/** 某个键在当前宿主里「本来该在哪」：用于解释缺席，不做模糊搜索。 */
export function searchedPathsFor(key, { aiBase = "", dshHome = "" } = {}) {
  const fn = MISSING_KEY_PATHS[key];
  if (!fn) return [];
  try {
    return fn(aiBase, dshHome).filter((item) => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

function keyPaths(files, key) {
  const value = files[key];
  if (value == null || value === "") return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

/** 某个键对应的第一个目标路径（多落点补丁只取代表文件时用）。 */
export function firstTargetPath(files, key) {
  return keyPaths(files, key)[0] || "";
}

function classifyTargets(targets) {
  // 「处理确实写进了文件」优先于「宿主本来就满足」。
  if (targets.some((item) => item.state === "applied" && item.ownMark)) return "effective";
  if (targets.some((item) => item.state === "applied")) return "satisfied";
  if (targets.some((item) => item.state === "pending")) return "pending";
  if (targets.some((item) => item.state === "unreadable")) return "unknown";
  if (targets.every((item) => item.state === "missing")) return "not-applicable";
  return "unmatched";
}

/**
 * 逐个补丁核对目标定位与文件事实。
 * @returns {{ rows: Array, keys: Array, summary: object, notApplicable: Array, unmatched: Array }}
 */
export function inspectPatchTargets({ core, aiBase, dshHome, extraTargets } = {}) {
  const files = core.targetFiles(aiBase, dshHome);
  const keyIndex = new Map();
  const noteKey = (key, resolved, searched) => {
    const prev = keyIndex.get(key);
    if (prev && prev.resolved) return;
    keyIndex.set(key, { key, resolved, searched });
  };
  const rows = [];
  for (const patch of core.ALL_PATCHES) {
    if (typeof core.patchAppliesHere === "function" && !core.patchAppliesHere(patch)) continue;
    const keys = core.fileKeysOf(patch);
    const targets = [];
    for (const key of keys) {
      // extraTargets 用于「目标文件不在副本里、但有同源未打补丁副本」的键：
      // 桌面壳入口要在解出的 lib/main.js 上证明，不能因为副本没有 exe 就当成不适用。
      const extra = Array.isArray(extraTargets && extraTargets[key])
        ? extraTargets[key].filter((item) => typeof item === "string" && item && fs.existsSync(item))
        : [];
      const direct = keyPaths(files, key);
      const paths = direct.length > 0 ? direct : extra;
      if (paths.length === 0) {
        const searched = searchedPathsFor(key, { aiBase, dshHome });
        noteKey(key, false, searched);
        targets.push({ key, path: "", state: "missing", searched });
        continue;
      }
      noteKey(key, true, []);
      for (const file of paths) {
        let text;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch {
          targets.push({ key, path: file, state: "unreadable", searched: [] });
          continue;
        }
        // 一次观察拿到两个事实：状态（效果词）与 ownMark（是不是我们写的）。
        const observation = core.observe(text, patch, file);
        targets.push({
          key,
          path: file,
          state: core.effectOf(observation),
          ownMark: observation.ownMark,
          searched: [],
        });
      }
    }
    rows.push({
      id: patch.id,
      name: patch.name,
      optional: Boolean(patch.optional),
      strict: Boolean(patch.strictFiles),
      targets,
      evidence: classifyTargets(targets),
    });
  }
  const summary = { effective: 0, satisfied: 0, pending: 0, unmatched: 0, unknown: 0, "not-applicable": 0 };
  for (const row of rows) summary[row.evidence] = (summary[row.evidence] || 0) + 1;
  // 不适用必须带证据：列出去搜过但不存在的位置，而不是只报一个数字；
  // optional 一并带出，报告里能把「可选包缺席」和「必需落点缺席」分开看。
  const notApplicable = rows.filter((row) => row.evidence === "not-applicable").map((row) => ({
    id: row.id,
    name: row.name,
    optional: row.optional,
    keys: row.targets.map((item) => ({ key: item.key, searched: item.searched })),
  }));
  const unmatched = rows.filter((row) => row.evidence === "unmatched").map((row) => ({
    id: row.id,
    name: row.name,
    optional: row.optional,
    keys: row.targets.map((item) => item.key),
  }));
  const keys = [...keyIndex.values()];
  return { rows, keys, summary, notApplicable, unmatched, unresolvedKeys: keys.filter((item) => !item.resolved) };
}

/**
 * 状态与文件事实的一致性检查。
 *
 * - 状态说 applied/already，但目标文件里既没有目标态也没有待改原文 → 假成功；
 * - 状态说 applied/already，文件里还有待改原文 → 状态超前于结果；
 * - 状态说 pending，文件里已经没有原作可改，也不是目标态 → 状态落后于结果。
 *
 * layout-soft（身份句、审批句这类会随宿主布局变化结算的补丁）单独列出，不混进假成功：
 * 它们本来就可能「宿主里没有这句」，但报告必须说清楚是靠布局结算的。
 */
export function auditTargetStatus({ rows = [], status = {}, softIds = [] } = {}) {
  const soft = new Set(softIds);
  const falseSuccess = [];
  const ahead = [];
  const behind = [];
  const settledByLayout = [];
  for (const row of rows) {
    const value = status[row.id];
    const succeeded = value === "applied" || value === "already";
    if (succeeded && row.evidence === "unmatched") {
      const entry = { id: row.id, name: row.name, status: value, targets: row.targets.map((item) => item.key) };
      if (soft.has(row.id)) settledByLayout.push(entry);
      else falseSuccess.push(entry);
      continue;
    }
    if (succeeded && row.evidence === "pending") {
      ahead.push({
        id: row.id,
        name: row.name,
        status: value,
        evidence: row.targets.filter((item) => item.state === "pending").map((item) => item.path).join(", "),
      });
    }
    if (value === "pending" && row.evidence === "unmatched") {
      behind.push({ id: row.id, name: row.name, status: value });
    }
  }
  return { falseSuccess, ahead, behind, settledByLayout };
}
