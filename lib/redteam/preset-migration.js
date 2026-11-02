/**
 * 预设迁移：宿主 0.2.1-rc.5 废弃了 `tool-subagent` 的 `toolFilter`。
 *
 * 旧语义（1.1.71 基线）：红队子智能体只能拿父级的工具集，其中 `subagent_fork`、
 * `workflow`、`ralph` 三件被 deny 掉，子智能体是叶子节点。
 *
 * 新宿主不再接受 `toolFilter`（`dsh-tool-subagent` 在 apply 时直接抛
 * "no longer supported"），只提供"子级选一个 Agent Preset"这一条接口：
 * 因此迁移把 deny 列表落到一个独立子级预设 `redteam-worker` 上——该预设由父级
 * 组合裁剪同样三行得到（见 deriveWorkerRows），工具集与旧 deny 完全对应，
 * 父级则用 `agentPreset` 指向它。
 *
 * 本模块只做两件纯函数的事：改写预设文本（幂等）、裁剪组合行（递归穿透 group）。
 */

/** 子级预设 id（registry 里的选择项，也是 tool-subagent 的 agentPreset 值）。 */
export const WORKER_PRESET_ID = 'redteam-worker'

/** 旧 toolFilter 里 deny 的模型工具名 → 提供它们的预设行 id。 */
export const LEGACY_DENIED_ROWS = [
  { tool: 'subagent_fork', row: 'tool-subagent-fork' },
  { tool: 'workflow', row: 'tool-workflow' },
  { tool: 'ralph', row: 'tool-ralph' },
]

const DENIED_ROW_IDS = new Set(LEGACY_DENIED_ROWS.map((entry) => entry.row))

/** 迁移时写进父级 tool-subagent 行的那一行（同一 indentation 下）。 */
const AGENT_PRESET_LINE = 'agentPreset: ' + WORKER_PRESET_ID

const MIGRATION_NOTE = '# 宿主 0.2.1-rc.5 起 toolFilter 已废弃：子智能体工具集由 ' + WORKER_PRESET_ID
  + ' 预设裁掉 ' + LEGACY_DENIED_ROWS.map((entry) => entry.tool).join(' / ') + '（叶子节点语义不变）。'

/** 一行里的结构缩进（空格数）；制表符不参与判定。 */
function indentOf(line) {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0].length : 0
}

/** 预设文本按原行尾切行（保留 CRLF 文件的写法）。 */
function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  return { lines: text.split(/\r?\n/), eol }
}

/** 一行若是 `- id: <name>`，返回它的缩进；否则返回 -1。 */
function rowIdIndent(line, id) {
  const match = /^([ \t]*-[ \t]+id:[ \t]*)(.*)$/.exec(line)
  if (!match) return -1
  return match[2].trim() === id ? indentOf(line) : -1
}

/**
 * 找出一个插件行的正文范围：从 `- id:` 行之后到下一个同级/更浅的 `- id:` 之前。
 * @returns 起始（含）与结束（不含）行下标；找不到该行返回 null。
 */
function rowBounds(lines, id) {
  let start = -1
  let indent = -1
  for (let index = 0; index < lines.length; index += 1) {
    const found = rowIdIndent(lines[index], id)
    if (found >= 0) {
      start = index
      indent = found
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const next = /^[ \t]*-[ \t]+id:[ \t]*\S/.exec(line)
    if (next && indentOf(line) <= indent) {
      end = index
      break
    }
  }
  return { start, end }
}

/**
 * 读取旧配置里 toolFilter 的位置（只读核对，不改写）。
 * @param text 预设文本。
 * @returns `{ key, line }` 列表（line 为 1 起的行号）。
 */
export function findToolFilterKeys(text) {
  const found = []
  String(text || '').split(/\r?\n/).forEach((line, index) => {
    const match = /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:/.exec(line)
    if (match && match[1] === 'toolFilter') found.push({ key: match[1], line: index + 1 })
  })
  return found
}

/**
 * 把一份预设文本从 `toolFilter` 迁到 `agentPreset`。
 *
 * 幂等：已迁移的文本原样返回（changed=false）；用户其余内容（包括自定义提示词、
 * 自己加的行）一个字节都不动，只替换 `tool-subagent` 行 config 里那一段。
 *
 * @param text 预设文本（`agent.cordis.yml`）。
 * @returns `{ text, changed, skipped, reason }`：
 *   changed 表示写回了新内容；skipped 表示里面写着 toolFilter 但我们不敢动（内联写法等），
 *   reason 里说明原因，调用方应记录冲突而不是猜。
 */
export function migrateToolFilter(text) {
  const raw = String(text || '')
  const { lines, eol } = splitLines(raw)
  const bounds = rowBounds(lines, 'tool-subagent')
  if (!bounds) {
    const legacy = findToolFilterKeys(raw).length > 0
    return { text: raw, changed: false, skipped: legacy, reason: legacy ? '没有找到 - id: tool-subagent，无法定位 toolFilter' : '' }
  }
  const body = lines.slice(bounds.start + 1, bounds.end)
  const hasAgentPreset = body.some((line) => /^[ \t]*agentPreset[ \t]*:/.test(line))
  const legacyLine = body.findIndex((line) => /^[ \t]*toolFilter[ \t]*:/.test(line))
  if (legacyLine < 0) {
    return { text: raw, changed: false, skipped: false, reason: hasAgentPreset ? '' : 'tool-subagent 行里既没有 toolFilter 也没有 agentPreset' }
  }
  const keyIndent = indentOf(body[legacyLine])
  const inline = body[legacyLine].replace(/^[ \t]*toolFilter[ \t]*:/, '').trim()
  const nested = []
  for (let index = legacyLine + 1; index < body.length; index += 1) {
    const line = body[index]
    if (line.trim() !== '' && indentOf(line) <= keyIndent) break
    nested.push(index)
  }
  if (inline !== '' && !inline.startsWith('#')) {
    return { text: raw, changed: false, skipped: true, reason: 'toolFilter 写在同一行（内联流式），迁移脚本不猜它的含义' }
  }
  if (hasAgentPreset) {
    // 已经声明了 agentPreset：只删旧键，不改用户写死的目标。
    const next = removeIndexes(body, [legacyLine, ...nested])
    return rewrite(raw, lines, bounds, next, eol)
  }
  const insertAt = legacyLine
  const replacement = [
    ' '.repeat(keyIndent) + MIGRATION_NOTE,
    ' '.repeat(keyIndent) + AGENT_PRESET_LINE,
  ]
  const next = removeIndexes(body, [legacyLine, ...nested])
  next.splice(insertAt, 0, ...replacement)
  return rewrite(raw, lines, bounds, next, eol)
}

function removeIndexes(list, indexes) {
  const drop = new Set(indexes)
  return list.filter((_line, index) => !drop.has(index))
}

function rewrite(raw, lines, bounds, body, eol) {
  const next = [
    ...lines.slice(0, bounds.start + 1),
    ...body,
    ...lines.slice(bounds.end),
  ].join(eol)
  if (next === raw) return { text: raw, changed: false, skipped: false, reason: '' }
  return { text: next, changed: true, skipped: false, reason: '' }
}

/**
 * 从父级组合里裁出子级（worker）组合：只去掉旧 toolFilter deny 掉的那几行工具。
 *
 * 递归穿透 `group: true` 行，其余行（含顺序、缩进以外的字段）逐字保留，
 * 因此子级工具集 = 父级工具集 − deny 列表，和 1.1.71 的语义一一对应。
 *
 * @param rows 已解析的组合行（readCompositionRows / readPresetDefinition 的结果）。
 * @returns `{ rows, removed }`：removed 是被裁掉的行 id 列表。
 */
export function deriveWorkerRows(rows) {
  const removed = []
  const walk = (list) => {
    const out = []
    for (const row of list) {
      if (!row || typeof row !== 'object') {
        out.push(row)
        continue
      }
      if (typeof row.id === 'string' && DENIED_ROW_IDS.has(row.id)) {
        removed.push(row.id)
        continue
      }
      if (row.group === true && Array.isArray(row.config)) {
        out.push({ ...row, config: walk(row.config) })
        continue
      }
      out.push(row)
    }
    return out
  }
  return { rows: walk(Array.isArray(rows) ? rows : []), removed }
}

/**
 * 由父级预设定义构造子级预设定义。
 * @param parent `{ id, name, description, order, plugins }`。
 * @returns 交给 `ctx.agentPresets.register` 的 worker 定义。
 */
export function workerDefinition(parent) {
  const derived = deriveWorkerRows(parent && parent.plugins)
  const definition = {
    id: WORKER_PRESET_ID,
    name: '红队执行角色',
    description: '红队模式子智能体使用的组合：与红队模式相同的工具与人设，但不提供 '
      + LEGACY_DENIED_ROWS.map((entry) => entry.tool).join(' / ')
      + '（子智能体是叶子节点，不再往下派活）。由红队模式授权后才使用，不要当主模式选。',
    order: (parent && typeof parent.order === 'number' ? parent.order : 10) + 1,
    plugins: derived.rows,
  }
  return { definition, removed: derived.removed }
}
