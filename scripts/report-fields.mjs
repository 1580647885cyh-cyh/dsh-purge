#!/usr/bin/env node
import { readReportFields } from "../lib/verify/report-fields.js";

/**
 * 读验证报告里的字段（#25 retro）：不用再写一次性脚本，也不会把临时脚本落进仓库根。
 *
 * 用法：
 *   node scripts/report-fields.mjs                         # 最新一轮的顶层键
 *   node scripts/report-fields.mjs latest targets.audit     # 最新一轮的某个字段
 *   node scripts/report-fields.mjs 20261103-195047 targets.runtime.exitTrace.cases
 *   node scripts/report-fields.mjs D:/dsh/tmp/x/out/report.json ok
 *
 * 输出一个 JSON 对象：{ file, fields, missing }；取不到的字段进 missing，不静默当成空值。
 */

const [target = "latest", ...paths] = process.argv.slice(2);
try {
  const result = readReportFields(target, paths);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(String(error && error.message ? error.message : error));
  process.exitCode = 1;
}
