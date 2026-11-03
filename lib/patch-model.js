/**
 * 补丁模型 —— 一条补丁的语义只住在这里：怎么认回自己写过（ownMark）、
 * 算不算完成（target / pending / foreign）、以及把文本改写成目标态。
 *
 * 纯文本逻辑：不碰 fs、不碰宿主、不碰补丁表。
 * 调用方（core 的 apply/status、verify 的逐文件核对）只做投影，不再各自实现一套判定。
 *
 * 这是架构审查「候选 1 · 补丁条目与状态」的第一刀（issue #15）：
 * 新增 observe() 作为唯一读法；老的导出名保留为兼容层，82 条补丁不需要一次性迁移。
 */

// ---------- 词表 ----------

/** 一次观察的三种事实：目标态已成立 / 还能匹配到待改原文 / 两者都不成立。 */
export const OBSERVE_STATES = Object.freeze(["target", "pending", "foreign"]);

/** 效果词表。对外由 patchEffectState 投影，tests/verify/targets.test.js 锁着这三个词。 */
export const EFFECT_STATES = Object.freeze(["applied", "pending", "unmatched"]);

/**
 * 状态词表。apply / status / 面板共用。client.js 另有 unmatched/unlocated/off 的容错分支（#15 不改 client）。
 *
 * A2（issue #19）新增 drifted：文件在、原文对不上、也没留下我们的产物 —— 这条没生效，
 * 而且不是「本来就不适用」。以前它被压进 skipped，等于报告里什么都没发生。
 * 只加这一个词：其余语义仍然复用老词，别再往这张表里塞同义词。
 */
export const STATUS_WORDS = Object.freeze([
  "applied",
  "already",
  "pending",
  "skipped",
  "drifted",
  "missing_file",
  "na",
]);

const EFFECT_OF_STATE = Object.freeze({ target: "applied", pending: "pending", foreign: "unmatched" });

/** 自标记型补丁认的「原文」本身就是本插件写进去的痕迹（撤销/注入型补丁）。 */
const SELF_MARK_TOKENS = ["[dsh-purge]", "# dsh-purge", "dsh-purge:"];

/** 布局软补丁的旧表写法：身份句 4/25/26、审批句 5/11/12 会随宿主布局变化而结算。 */
const LAYOUT_SOFT_IDS = new Set([4, 25, 26, 5, 11, 12]);

/** #42 需要先收拾旧产物（叠多份 legacyApplyPath、调用已删除的函数）。 */
const LEGACY_APPLY_KIND = "legacy-apply";

function isLegacyApplyPatch(patch) {
  return Boolean(patch && (patch.kind === LEGACY_APPLY_KIND || patch.id === 42));
}

// ---------- 文本与判定（实现细节，不是 interface） ----------

function asLf(text) {
  return typeof text === "string" ? text.replace(/\r\n/g, "\n") : text;
}

function isYamlPath(fp) {
  return typeof fp === "string" && /\.ya?ml$/i.test(fp);
}

function legacyApplyPathStarts(text) {
  const hay = asLf(text);
  const key = "function legacyApplyPath(section, op) {";
  let count = 0;
  let from = 0;
  while (from < hay.length) {
    const at = hay.indexOf(key, from);
    if (at < 0) break;
    count += 1;
    from = at + key.length;
  }
  return count;
}

function endOfBalancedBlock(text, openAt) {
  let depth = 0;
  for (let i = openAt; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** 1.1.17 之前 #42 会叠多份 legacyApplyPath，settings 整文件语法错误、提供商目录起不来。 */
function collapseDuplicateLegacyApplyPath(text) {
  const crlf = typeof text === "string" && text.includes("\r\n");
  const src = asLf(text);
  const key = "function legacyApplyPath(section, op) {";
  const starts = [];
  let from = 0;
  while (from < src.length) {
    const at = src.indexOf(key, from);
    if (at < 0) break;
    starts.push(at);
    from = at + key.length;
  }
  if (starts.length < 2) return text;
  const firstOpen = src.indexOf("{", starts[0]);
  const firstEnd = endOfBalancedBlock(src, firstOpen);
  let out = src.slice(0, firstEnd);
  let cursor = firstEnd;
  for (let n = 1; n < starts.length; n += 1) {
    const open = src.indexOf("{", starts[n]);
    const end = endOfBalancedBlock(src, open);
    out += src.slice(cursor, starts[n]);
    cursor = end;
  }
  out += src.slice(cursor);
  out = out.replace(/\n{3,}/g, "\n\n");
  return crlf ? out.replace(/\n/g, "\r\n") : out;
}

const STALE_LEGACY_APPLY_CALL = "=> legacyApplyPath(section, op)";
const SETTINGS_APPLY_CALL = "=> applyPathOp(section, op)";

/** #42 旧产物调用已删除的 legacyApplyPath。只换这一处调用，不动函数定义。 */
function rewriteStaleLegacyApplyCall(text) {
  const hay = asLf(text);
  if (!hay.includes(STALE_LEGACY_APPLY_CALL)) return text;
  const next = hay.split(STALE_LEGACY_APPLY_CALL).join(SETTINGS_APPLY_CALL);
  return text.includes("\r\n") ? next.replace(/\n/g, "\r\n") : next;
}

/**
 * 文件里有没有「我们自己写进去的痕迹」（标记 / 替换文本首行）。
 * 与 patchApplied 的区别：不含 settledWhen 的目标态判定，用来区分「处理写进去了」
 * 和「宿主本来就满足目标态」——验证报告要能把这两件事分开。
 */
function patchOwnMarkPresent(text, patch) {
  const hay = asLf(text);
  if (Array.isArray(patch.forbid) && patch.forbid.some((marker) => hay.includes(asLf(marker)))) return false;
  if (Array.isArray(patch.markers) && patch.markers.length > 0) {
    const match = patch.markersAny ? "some" : "every";
    return patch.markers[match]((marker) => hay.includes(asLf(marker)));
  }
  if (patch.marker) return hay.includes(asLf(patch.marker));
  if (typeof patch.replace === "string" && patch.replace.length > 0) {
    return hay.includes(asLf(patch.replace).split("\n")[0].slice(0, 60));
  }
  return false;
}

function patchApplied(text, patch) {
  const hay = asLf(text);
  if (isLegacyApplyPatch(patch) && legacyApplyPathStarts(hay) > 1) return false;
  if (isLegacyApplyPatch(patch) && hay.includes(STALE_LEGACY_APPLY_CALL)) return false;
  if (Array.isArray(patch.forbid) && patch.forbid.some((marker) => hay.includes(asLf(marker)))) return false;
  // 目标态判定：官方本来就已经是我们要的结果（例如 preset 已写 fetch: true）时，
  // 用「匹配到的字符串」当标记会把官方文案误算成我们的产物 —— 由补丁给出范围明确的判定。
  if (typeof patch.settledWhen === "function") {
    try {
      if (patch.settledWhen(hay)) return true;
    } catch {
      /* 判定函数抛错按未完成处理 */
    }
  }
  // 标记 / 替换文本首行：与 patchOwnMarkPresent 共用同一套判定。
  return patchOwnMarkPresent(hay, patch);
}

function cloneRegExp(pattern, global) {
  let flags = String(pattern.flags || "").replace("g", "");
  if (global) flags += "g";
  return new RegExp(pattern.source, flags);
}

function matchesPattern(hay, pattern) {
  if (pattern instanceof RegExp) {
    // 不复用带 g 的模块级正则。test() 会留下 lastIndex，下一次替换从中间开始，等于没匹配到。
    return cloneRegExp(pattern, false).test(hay);
  }
  return hay.includes(asLf(pattern));
}

/**
 * 逐条锚点的命中扫描 —— 唯一一份。
 * 「还有没有待做」与「漂在哪些锚点」都从它投影，避免两套相似循环各算一遍（code-review 判断项）。
 */
function scanAnchors(text, patch, fp = "") {
  const hay = asLf(text);
  const yaml = isYamlPath(fp);
  const out = [];
  patchReplacements(patch).forEach(({ pattern, replace }, index) => {
    if (!pattern || typeof replace !== "string") return;
    // 与 apply 一致：YAML 里无缩进 identity 不能 replaceAll，不算待做。
    if (yaml && isBareIdentityNeedle(pattern)) return;
    out.push({ index, pattern, matched: matchesPattern(hay, pattern) });
  });
  return out;
}

function patchHasRemainingWork(text, patch, fp = "") {
  return scanAnchors(text, patch, fp).some((anchor) => anchor.matched);
}

/**
 * 逐条锚点的命中情况（A2 / issue #19）：报告要能说清「漂在哪个锚点」。
 *
 * 只保留没命中的；命中数不参与状态判定（不引入 expect 命中数契约）。
 * head 取 pattern 首行前 80 字符：够定位，也不把整段宿主原文抄进报告。
 */
function missingAnchors(text, patch, fp = "") {
  return scanAnchors(text, patch, fp)
    .filter((anchor) => !anchor.matched)
    .map((anchor) => {
      const head = anchor.pattern instanceof RegExp ? anchor.pattern.source : String(anchor.pattern);
      return {
        index: anchor.index,
        kind: anchor.pattern instanceof RegExp ? "regex" : "literal",
        head: asLf(head).split("\n")[0].slice(0, 80),
      };
    });
}

/**
 * 布局软补丁：宿主布局不同时，允许「没有残留原文」也算完成。
 * 新补丁在表里写 settle: "layout-soft" | "strict"；老补丁继续按 id 认（迁移清单见 issue #15）。
 */
function isLayoutSoftPatch(patch) {
  if (!patch) return false;
  if (patch.settle === "layout-soft") return true;
  if (patch.settle === "strict") return false;
  return Boolean(patch.softSettle) || LAYOUT_SOFT_IDS.has(patch.id);
}

function filePatchSettled(text, patch, fp = "") {
  if (patchApplied(text, patch)) return true;
  // 官方副本布局不同、或审批句已被 0.1.5 改写时，没有残留 pattern 就算完成。
  if (isLayoutSoftPatch(patch)) return !patchHasRemainingWork(text, patch, fp);
  return false;
}

/**
 * 一个文件对这条补丁的处置结果（A2 把「跳过」和「漂移」分开）。
 *
 * - applied：目标态成立（含布局软结算）；
 * - pending：还能匹配到待改原文，再点应用就能改；
 * - skipped：自标记型补丁找不到痕迹 —— 本来就没写过，不算漂移；
 * - drifted：既不是目标态、也没有可改的原文 —— 这条没生效，且不是「本来就不适用」。
 */
function filePatchOutcome(text, patch, fp = "") {
  if (filePatchSettled(text, patch, fp)) return "applied";
  if (patchHasRemainingWork(text, patch, fp)) return "pending";
  if (isSelfMarkedPatch(patch)) return "skipped";
  return "drifted";
}

/**
 * 自标记型补丁：它认的 pattern 全是本插件留下的痕迹。
 * 与 patchOwnMarkPresent 的区别：那个判「文件里有没有我们的产物」，这个判「补丁认的原文
 * 是不是我们自己的产物」——前者用来看写没写进去，后者用来决定找不到时算不算漂移。
 */
function isSelfMarkedPatch(patch) {
  if (!patch) return false;
  const reps = patchReplacements(patch);
  if (reps.length === 0) return false;
  return reps.every(({ pattern }) => {
    if (pattern instanceof RegExp) return false;
    const needle = asLf(pattern) || "";
    return SELF_MARK_TOKENS.some((token) => needle.includes(token));
  });
}

/**
 * 只看文件里的事实：目标态已成立 / 还有可改的原文 / 两者都不成立。
 *
 * 与 filePatchOutcome 的区别是不掺 layout-soft 的结算规则。验证入口用它核对
 * 「状态是不是真的对应文件结果」——软补丁可以因为布局不同而结算，但那是状态规则，
 * 不能当成「处理已经写进目标文件」的证据。
 */
function patchEffectState(text, patch, fp = "") {
  return EFFECT_OF_STATE[stateOf(text, patch, fp)] || "unmatched";
}

function patchReplacements(p) {
  if (Array.isArray(p.replacements)) return p.replacements;
  return (p.patterns ?? []).map((pat) => ({ pattern: pat, replace: p.replace }));
}

function isBareIdentityNeedle(pattern) {
  const needle = asLf(pattern);
  if (!needle) return false;
  if (/^[ \t]/.test(needle)) return false;
  return /^You are a coding agent powered by\b/.test(needle);
}

// 行尾的 JS 注释写进 YAML 会变成字符串。!!js 行本身是表达式，引号里的 // 也不动。
function yamlJsCommentsToHash(text) {
  return asLf(text).split("\n").map((line) => {
    if (line.includes("!!js")) return line;
    let quote = "";
    for (let i = 0; i < line.length - 1; i += 1) {
      const ch = line[i];
      if (quote) {
        if (quote === "'" && ch === "'" && line[i + 1] === "'") {
          i += 1;
          continue;
        }
        if (quote === '"' && ch === "\\") {
          i += 1;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "#") return line;
      if (ch === "/" && line[i + 1] === "/" && (i === 0 || /\s/.test(line[i - 1]))) {
        return `${line.slice(0, i)}#${line.slice(i + 2)}`;
      }
    }
    return line;
  }).join("\n");
}

function applyReplacementsToText(text, patch, fp = "") {
  let source = text;
  let preChanged = false;
  if (isLegacyApplyPatch(patch)) {
    const collapsed = collapseDuplicateLegacyApplyPath(source);
    if (collapsed !== source) {
      source = collapsed;
      preChanged = true;
    }
    const rewritten = rewriteStaleLegacyApplyCall(source);
    if (rewritten !== source) {
      source = rewritten;
      preChanged = true;
    }
  }
  // 插入型补丁锚点仍在，已有标记则不再 replaceAll。
  if (patch.skipIfMarked && patchApplied(source, patch)) {
    return { text: source, changed: preChanged };
  }
  const crlf = typeof source === "string" && source.includes("\r\n");
  const yaml = isYamlPath(fp);
  let out = asLf(source);
  let changed = false;
  for (const { pattern, replace } of patchReplacements(patch)) {
    if (!pattern || typeof replace !== "string") continue;
    // YAML 块标量行首有缩进；无缩进 identity+\n\n 会留下 6 空格，再和下一段拼成 12 空格。
    if (yaml && isBareIdentityNeedle(pattern)) continue;
    const written = yaml ? yamlJsCommentsToHash(asLf(replace)) : asLf(replace);
    // 正则 pattern：用于自匹配型替换（产物包含原 pattern，如 timeoutMs 追加 0）。
    if (pattern instanceof RegExp) {
      const re = cloneRegExp(pattern, true);
      re.lastIndex = 0;
      if (!re.test(out)) continue;
      re.lastIndex = 0;
      // 用字符串形态调用：保留 $1..$9 展开语义（回调形态会把 "$1" 当字面量写进文件）。
      const next = out.replace(re, written);
      if (next === out) continue;
      out = next;
      changed = true;
      continue;
    }
    const needle = asLf(pattern);
    if (!out.includes(needle)) continue;
    const next = out.split(needle).join(written);
    if (next === out) continue;
    out = next;
    changed = true;
  }
  if (crlf) out = out.replace(/\n/g, "\r\n");
  return { text: out, changed: changed || preChanged };
}

/**
 * 一条补丁的总状态（多文件汇总）。优先级就是「事实强度」的排序：
 *
 * 1. 写/读错误 —— EACCES 不能被 applied 吞成绿（A2 与上游同口径）；
 * 2. 必需补丁缺原文 —— 仍是硬失败，语义不变；
 * 3. drifted —— 有文件漂了，整体就不是干净的（哪怕别的文件写成功了）；
 * 4. applied / already / missing_file / skipped / pattern_not_found。
 */
function rollupPatchStatus({ applied, already, missing, notFound, drifted = 0, lastError, keyCount, layoutSoft, strictFiles }) {
  if (lastError) return lastError;
  if (strictFiles && notFound > 0) return "pattern_not_found";
  if (drifted > 0) return "drifted";
  if (applied > 0) return "applied";
  if (already > 0 && (notFound === 0 || layoutSoft)) return "already";
  if (missing === keyCount) return "missing_file";
  if (notFound === 0) return "skipped";
  return "pattern_not_found";
}

/**
 * 唯一读法：这份文本对这条补丁来说处于什么状态。
 * @returns {{state: "target" | "pending" | "foreign", ownMark: boolean}}
 *   ownMark 区分「我们写进去的」与「宿主本来就满足目标态」——verify 的假成功判定要这个。
 */
export function observe(text, patch, fp = "") {
  return { state: stateOf(text, patch, fp), ownMark: patchOwnMarkPresent(asLf(text), patch) };
}

/** 三种事实的唯一实现：observe 与 patchEffectState 都从它投影，不再各算一遍。 */
function stateOf(text, patch, fp = "") {
  const hay = asLf(text);
  if (patchApplied(hay, patch)) return "target";
  if (patchHasRemainingWork(hay, patch, fp)) return "pending";
  return "foreign";
}

/** 把观察结果投影成效果词（旧 interface，测试锁着 applied/pending/unmatched）。 */
export function effectOf(observation) {
  return EFFECT_OF_STATE[observation && observation.state] || "unmatched";
}

/**
 * 每个状态词的两个事实：挡不挡 apply（soft）、面板上算不算「已就绪」（ready）。
 * 以前这两件事各写一遍（ALWAYS_SOFT_STATUSES 与 patchStatusReady），规则还逐条重复。
 * 注意二者语义不同：na 不挡 apply，但面板上不算就绪。
 */
export function statusFacts(status, patch = null) {
  if (status === "applied" || status === "already" || status === "skipped" || status === "missing_file") {
    return { soft: true, ready: true };
  }
  if (status === "na") return { soft: true, ready: false };
  // 漂移看得见、但不挡 Apply（用户口径：阻断会把人锁在门外），也不算「已就绪」。
  if (status === "drifted") return { soft: true, ready: false };
  // 读/写错误仍然要报出来，但只有必需补丁的错误才允许挡重启：
  // 一条可选补丁撞 EACCES 不该把整个清洗判死（code-review Spec 轴第 5 条）。
  if (status === "read_error" || String(status).startsWith("write_error:")) {
    if (!patch) return { soft: false, ready: false };
    return { soft: !patch.strictFiles, ready: false };
  }
  if (status === "pattern_not_found") {
    if (patch && patch.strictFiles) return { soft: false, ready: false };
    if (patch && patch.optional) return { soft: true, ready: true };
    if (isLayoutSoftPatch(patch)) return { soft: true, ready: false };
    return { soft: false, ready: false };
  }
  return { soft: false, ready: false };
}

export function resultSoftOk(row, patch = null) {
  if (!row) return false;
  return statusFacts(row.status == null ? row.st : row.status, patch).soft;
}

export function readyStatus(status, patch = null) {
  return statusFacts(status, patch).ready;
}


// ---------- 补丁表的受检引用（issue #15） ----------

/** targetFiles 的键注册表。targetFiles 每次解析后都与它比对，漂移即报错。 */
export const TARGET_FILE_KEYS = Object.freeze([
  "agent-instructions", "agent-instructions-bootstrap", "web-app", "web-app-lib", "dev-context",
  "headless", "desktop-shell", "agent-preset", "user-approval",
  "user-approval-code", "user-approval-invariant", "escalation", "fs-sandbox",
  "sandbox-local", "base", "settings", "compaction-instant-client",
  "fs-observation-policy", "repeat-tool-reminder", "compaction-tool-result-pruner", "tool-fs",
  "tool-subagent", "subagent", "subagent-types", "base-package",
  "preset-unrestricted", "preset-standard", "preset-cordis", "preset-minimal",
  "preset-ptc", "preset-acp-app", "preset-sdk-app", "preset-sdk-minimal",
  "tool-bash", "tool-pwsh", "preset-liangshen", "preset-liangshen-pkg",
  "liangshen-tool-bootstrap", "persona", "session-format-v0", "system-prompt",
  "tool-web", "hooks-claude-code", "hooks-codex", "api-session-controller",
  "pi-ai-completions", "pi-ai-responses-shared", "pi-ai-anthropic-messages", "session-reference",
  "permission-presets", "permission-presets-types", "session-log-deepseek", "session-log-deepseek-types",
  "deliverables-prompt", "llm-deepseek", "session", "agent-loop",
  "app-boot", "conversation-client", "tool-todo", "auto-review",
  "dsh-tools", "dsh-tools-types", "dsh-tools-ptc", "sandbox-policy",
]);

/**
 * 只在旧布局里存在的备用键：合法、当前宿主解析不到、报告里归「不适用」。
 * 它们由 verify/targets.js 的 MISSING_KEY_PATHS 解释；不在 targetFiles 里。
 */
export const ALT_FILE_KEYS = Object.freeze([
  "tool-web-nested",
  "hooks-claude-code-nested",
  "hooks-codex-nested",
  "system-prompt-nested",
]);

const KNOWN_FILE_KEYS = new Set([...TARGET_FILE_KEYS, ...ALT_FILE_KEYS]);

export function isKnownFileKey(key) {
  return typeof key === "string" && KNOWN_FILE_KEYS.has(key);
}

/**
 * 补丁表的问题清单。
 * hard：写错就永远静默变绿的那一类（未知 file 键、重复 id、字段类型不对）。
 * soft：语义缺失（没有任何改写写法 / 没有任何完成标记 / 缺 name、layer）——不挡加载，测试里要求为空。
 */
export function patchTableProblems(patches = []) {
  const hard = [];
  const soft = [];
  const seen = new Map();
  for (const patch of patches) {
    const id = patch && patch.id;
    if (!Number.isInteger(id)) {
      hard.push("有一条补丁缺少整数 id");
      continue;
    }
    if (seen.has(id)) {
      const prev = seen.get(id);
      hard.push("#" + id + " 的 id 与 #" + prev.id + (prev.name ? "（" + prev.name + "）" : "") + " 重复");
    }
    seen.set(id, patch);
    const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
    if (keys.length === 0 || keys.some((key) => typeof key !== "string" || !key)) {
      hard.push("#" + id + " 的 file 为空或不是字符串");
    }
    for (const key of keys) {
      if (typeof key === "string" && key && !isKnownFileKey(key)) {
        hard.push("#" + id + " 引用了未知的 file 键 \"" + key + "\"（既不在 targetFiles 也不在 altKeys）");
      }
    }
    // 备用键永远解析不到：只写备用键的补丁会永远静默 missing。必须至少有一个可解析键。
    if (keys.length > 0 && !keys.some((key) => TARGET_FILE_KEYS.includes(key))) {
      hard.push("#" + id + " 只引用了备用布局键（" + keys.join(", ") + "），永远解析不到，会静默 missing");
    }
    if (patch.replacements != null && !Array.isArray(patch.replacements)) {
      hard.push("#" + id + " 的 replacements 不是数组");
    }
    if (patch.patterns != null && !Array.isArray(patch.patterns)) {
      hard.push("#" + id + " 的 patterns 不是数组");
    }
    if (Array.isArray(patch.patterns) && typeof patch.replace !== "string") {
      hard.push("#" + id + " 用了 patterns 却没有字符串 replace");
    }
    for (const flag of ["markersAny", "skipIfMarked", "softSettle", "strictFiles", "optional"]) {
      if (patch[flag] != null && typeof patch[flag] !== "boolean") {
        hard.push("#" + id + " 的 " + flag + " 不是布尔");
      }
    }
    for (const list of ["markers", "forbid"]) {
      if (patch[list] == null) continue;
      if (!Array.isArray(patch[list]) || patch[list].some((item) => typeof item !== "string" || !item)) {
        hard.push("#" + id + " 的 " + list + " 不是非空字符串数组");
      }
    }
    if (patch.settle != null && patch.settle !== "layout-soft" && patch.settle !== "strict") {
      hard.push("#" + id + " 的 settle 只能是 layout-soft 或 strict");
    }
    if (patch.kind != null && typeof patch.kind !== "string") hard.push("#" + id + " 的 kind 不是字符串");
    for (const fn of ["settledWhen", "revertsFrom"]) {
      if (patch[fn] != null && typeof patch[fn] !== "function") {
        hard.push("#" + id + " 的 " + fn + " 不是函数");
      }
    }
    const hasRewrite = Array.isArray(patch.replacements) || Array.isArray(patch.patterns) || typeof patch.marker === "string";
    if (!hasRewrite) soft.push("#" + id + " 没有任何改写写法（replacements / patterns / marker）");
    // 完成标记有四种来源：markers / marker / settledWhen，以及「只写 patterns+replace 时用 replace 首行」
    // （与 patchOwnMarkPresent 的回退一致）。布局软补丁（#21 这类 migration-only）例外：
    // 它的完成规则就是「没有残留原文」，不靠标记。
    const hasMark = Array.isArray(patch.markers)
      || typeof patch.marker === "string"
      || typeof patch.settledWhen === "function"
      || (typeof patch.replace === "string" && patch.replace.length > 0)
      || isLayoutSoftPatch(patch);
    if (!hasMark) soft.push("#" + id + " 没有任何完成标记（markers / marker / settledWhen / 布局软结算）");
    if (!patch.name || !patch.layer) soft.push("#" + id + " 缺 name/layer，面板上是空层名");
  }
  return { hard, soft };
}

/** 加载期断言：hard 问题直接抛错，不让「写错键名 = 静默变绿」出现。 */
export function assertPatchTable(patches = []) {
  const problems = patchTableProblems(patches);
  if (problems.hard.length > 0) {
    const error = new Error("补丁表校验失败：\n" + problems.hard.join("\n"));
    error.code = "ERR_DSH_PURGE_PATCH_TABLE";
    throw error;
  }
  return patches.length;
}

/** targetFiles 解析出的键必须与注册表一致；多一个少一个都说明解析器和注册表漂了。 */
export function assertTargetKeys(actualKeys = []) {
  const known = new Set(TARGET_FILE_KEYS);
  const actual = new Set(actualKeys);
  const missing = TARGET_FILE_KEYS.filter((key) => !actual.has(key));
  const extra = actualKeys.filter((key) => !known.has(key));
  if (missing.length === 0 && extra.length === 0) return actualKeys.length;
  const parts = [];
  if (missing.length > 0) parts.push("注册表里多出：" + missing.join(", "));
  if (extra.length > 0) parts.push("解析器多出：" + extra.join(", "));
  const error = new Error("targetFiles 的键与注册表不一致（" + parts.join("；") + "）");
  error.code = "ERR_DSH_PURGE_TARGET_KEYS";
  throw error;
}


// ---------- 兼容导出（候选 1 第一刀；迁完 observe/rewrite 后收敛） ----------
// core.js 的既有调用点仍按老名字取用；新调用者只用 observe / effectOf / statusFacts。
export {
  asLf,
  isYamlPath,
  patchOwnMarkPresent,
  isSelfMarkedPatch,
  missingAnchors,
  patchEffectState,
  isLayoutSoftPatch,
  applyReplacementsToText,
  collapseDuplicateLegacyApplyPath,
  yamlJsCommentsToHash,
  filePatchSettled,
  filePatchOutcome,
  patchHasRemainingWork,
  rollupPatchStatus,
};
