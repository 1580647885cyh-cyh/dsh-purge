import path from "node:path";

/**
 * 验证入口的参数解析（#13 起从 scripts/verify.mjs 抽出来，好让参数契约有单测）。
 * 只做解析与默认值，不读环境、不写盘。
 */

/**
 * `--only` 支持的阶段。当前只有入口五：它最常改、又只有整轮 verify 才看得到，
 * 改一次 harness 要等一轮 60–90 s（#25 retro）。其余阶段暂不开放，别偷偷加值。
 */
export const VERIFY_ONLY_STAGES = Object.freeze(["targets"]);
export function parseVerifyArgs(argv, { defaultRoot } = {}) {
  const out = { root: defaultRoot || process.cwd(), json: false, seal: true, prune: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { out.json = true; continue; }
    if (arg === "--no-seal") { out.seal = false; continue; }
    if (arg === "--no-prune") { out.prune = false; continue; }
    if (!arg.startsWith("--")) continue;
    const inline = arg.includes("=") ? arg.slice(2).split("=") : null;
    const key = inline ? inline[0] : arg.slice(2);
    const value = inline ? inline.slice(1).join("=") : argv[i + 1];
    if (!value || (!inline && value.startsWith("--"))) continue;
    if (!inline) i += 1;
    if (key === "root") out.root = path.resolve(value);
    else if (key === "install") out.installDir = path.resolve(value);
    else if (key === "out-root") out.outRoot = path.resolve(value);
    else if (key === "baseline-dir") out.baselineDir = path.resolve(value);
    else if (key === "stamp") out.stamp = value;
    else if (key === "only") {
      const stage = String(value).trim();
      if (VERIFY_ONLY_STAGES.includes(stage)) out.only = stage;
      else out.onlyInvalid = stage;
    }
    else if (key === "keep") {
      const keep = Number(value);
      if (Number.isFinite(keep)) out.retentionKeep = keep;
    }
  }
  return out;
}
