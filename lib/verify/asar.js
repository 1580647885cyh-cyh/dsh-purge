import fs from "node:fs";
import path from "node:path";

/** 读取 app.asar 头：文件数据从 16 + headerSize 开始，条目 offset 相对该位置。 */
export function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerSize = head.readUInt32LE(12);
    const bytes = Buffer.alloc(headerSize);
    fs.readSync(fd, bytes, 0, headerSize, 16);
    const text = bytes.toString("utf8");
    const header = JSON.parse(text.slice(0, text.lastIndexOf("}") + 1));
    return { header, base: 16 + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

function findNode(header, innerPath) {
  let node = header;
  for (const part of String(innerPath).split("/").filter(Boolean)) {
    if (!node || !node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}

/** 把 asar 内某个子树解到目标目录，得到未打补丁的原始宿主文件。 */
export function extractAsarSubtree(asarPath, innerPath, destDir) {
  const { header, base } = readAsarHeader(asarPath);
  const node = findNode(header, innerPath);
  if (!node) throw new Error("asar 中找不到路径：" + innerPath);
  const fd = fs.openSync(asarPath, "r");
  const written = [];
  const walk = (current, relDir) => {
    for (const [name, child] of Object.entries(current.files || {})) {
      const rel = relDir ? relDir + "/" + name : name;
      const dest = path.join(destDir, ...rel.split("/"));
      if (child.files) {
        fs.mkdirSync(dest, { recursive: true });
        walk(child, rel);
        continue;
      }
      if (child.link !== undefined) continue;
      const offset = Number(child.offset);
      const size = Number(child.size);
      if (!Number.isFinite(offset) || !Number.isFinite(size)) continue;
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, base + offset);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buffer);
      written.push(rel);
    }
  };
  try {
    fs.mkdirSync(destDir, { recursive: true });
    walk(node, "");
  } finally {
    fs.closeSync(fd);
  }
  return written;
}

/** asar 是否存在且能读出 dsh/node_modules/@deepseek-ai。 */
export function asarHasHostPackages(asarPath) {
  try {
    const { header } = readAsarHeader(asarPath);
    return Boolean(findNode(header, "dsh/node_modules/@deepseek-ai"));
  } catch {
    return false;
  }
}
