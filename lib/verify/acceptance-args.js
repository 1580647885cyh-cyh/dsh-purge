/**
 * 验收入口（scripts/acceptance.mjs）的参数解析（#22 复盘：参数契约要有单测）。
 * 只做解析与默认值，不读环境、不写盘；写法与 lib/verify/cli-args.js 一致。
 *
 * 为什么单独带 positional：本机 npm（11.21.0，PowerShell shim）会把
 * `npm run acceptance -- --out DIR --name BASE` 的旗标吃掉、只把值传进来，
 * 脚本拿到的 argv 于是变成 `["DIR"]`——解析不到旗标，静默回退默认目录。
 * 把「没有旗标却有位置参数」当用法错误，才不会又写错地方。
 */
export function parseAcceptanceArgs(argv = []) {
  const out = { out: "", name: "", stamp: "", positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out.positional.push(arg);
      continue;
    }
    const inline = arg.includes("=") ? arg.slice(2).split("=") : null;
    const key = inline ? inline[0] : arg.slice(2);
    const value = inline ? inline.slice(1).join("=") : argv[i + 1];
    if (!value || (!inline && value.startsWith("--"))) continue;
    if (!inline) i += 1;
    if (key === "out") out.out = value;
    else if (key === "name") out.name = value;
    else if (key === "stamp") out.stamp = value;
  }
  return out;
}

/**
 * 位置参数 = npm 吞掉旗标后留下的值。给出一条能照着改的用法提示；
 * 没有问题时返回空串（调用方据此决定退出码）。
 */
export function acceptanceArgsProblem(parsed) {
  if (!parsed || parsed.positional.length === 0) return "";
  return (
    "参数没送到脚本：收到位置参数 " +
    JSON.stringify(parsed.positional) +
    "，但没有解析到对应旗标（本机 npm 会把 `npm run acceptance -- --out DIR` 的旗标吃掉、只留值）。" +
    "改用 node scripts/acceptance.mjs --out DIR --name BASE，或 npm run acceptance -- -- --out DIR。"
  );
}
