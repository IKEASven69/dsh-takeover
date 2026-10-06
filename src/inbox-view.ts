/**
 * 收件箱进阶纯函数层（0.3.0）：可脱离 DOM/React 单测，client.ts 只做接线。
 * 四块能力，全部纯前端、零依赖：
 * - 过滤：标题 / 来源（原始 id + 显示名）/ 编号子串，大小写不敏感，输入即滤；
 * - 相邻重复卡分组：同来源 + 同标题的**连续**卡片折叠为一组（非相邻不合并）；
 * - 新卡判定：已见 id 集合持久化在 localStorage，键含 HANDOFF_HOME 路径散列
 *   （FNV-1a，避免同源端口转发到不同机器时多环境串扰）；打开过（展开过）即记为已见；
 * - 导出文本生成：单卡 frontmatter + 六段、全部待取件拼一个 .md。
 *
 * 导出诚实纪律：/dsh-takeover/state 只提供 id / 来源 / 标题 / 项目 / 推送时间 /
 * 目标段预览（服务端截 240 字）。来源会话、cwd、git 快照、tasks 与其余五段全文
 * **不在 state 内**——导出时就地注明 limitation，绝不臆造字段值。
 * frontmatter 的字符串值经 yamlQuote 转义，可被 @agent-handoff/core 的
 * yamlParse/parseCard 原样读回（本模块单测做了 round-trip 断言）。
 * 六段标题（目标/涉及文件/…）是协议线格式（core card.ts 同款固定中文），不进 i18n。
 * @module dsh-takeover/inbox-view
 */

import type { PendingRow } from './settings.ts'

// ---------------------------------------------------------------------------
// 过滤
// ---------------------------------------------------------------------------

/**
 * 即时过滤：query 去首尾空白后为空 → 原样返回（同一数组引用，方便调用方判等）；
 * 带 source/newOnlyIds 时即使 query 为空也会产出过滤后的新数组。
 * 匹配字段：标题、编号、来源原始 id、来源显示名（labelOf 注入，避免本模块依赖品牌表）。
 * 防御：字段非字符串按空串处理（state 经 fetch 而来，外来坏数据不抛错）。
 * 全部大小写不敏感的子串匹配。
 */
export function filterPending(
  rows: PendingRow[],
  query: string,
  labelOf: (agent: string) => string,
  source?: string | null,
  newOnlyIds?: ReadonlySet<string> | null,
): PendingRow[] {
  let out = rows
  if (source) out = out.filter((p) => p.agent === source)
  // 只留新卡：调用方传入的是「不在已见集合」的新 id 集——写反会把新卡全藏掉只显旧卡
  if (newOnlyIds) out = out.filter((p) => newOnlyIds.has(p.id))
  const q = query.trim().toLowerCase()
  if (q === '') return out
  return out.filter((p) => {
    const title = typeof p.title === 'string' ? p.title : ''
    const id = typeof p.id === 'string' ? p.id : ''
    const agent = typeof p.agent === 'string' ? p.agent : ''
    return title.toLowerCase().includes(q)
      || id.toLowerCase().includes(q)
      || agent.toLowerCase().includes(q)
      || labelOf(p.agent ?? '').toLowerCase().includes(q)
  })
}

/** 待取件卡的来源去重清单（出现顺序），供来源筛选 chips 渲染 */
export function sourceFacets(rows: PendingRow[]): Array<{ agent: string; count: number }> {
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.agent, (counts.get(r.agent) ?? 0) + 1)
  return [...counts.entries()].map(([agent, count]) => ({ agent, count }))
}

// ---------------------------------------------------------------------------
// 相邻重复卡分组
// ---------------------------------------------------------------------------

/** 分组：同来源 + 同标题的连续卡片；key 供 openIds 复用（展开状态同一机制） */
export interface PendingGroup {
  key: string
  agent: string
  title: string
  rows: PendingRow[]
}

/**
 * 相邻折叠：只合并**连续**的同来源 + 同标题卡；中间插了别家/别题就断开。
 * 标题为空的卡永不入组（空标题行显示的是编号，按标题合并会把无关卡拉一起）。
 * 单卡也包成单元素组（渲染层据 rows.length 决定是否出组头），key 全列表唯一。
 */
export function groupAdjacent(rows: PendingRow[]): PendingGroup[] {
  const groups: PendingGroup[] = []
  let cur: PendingGroup | null = null
  for (const p of rows) {
    if (cur !== null && p.title !== '' && p.agent === cur.agent && p.title === cur.title) {
      cur.rows.push(p)
    } else {
      cur = { key: `g-${groups.length}-${p.id}`, agent: p.agent, title: p.title, rows: [p] }
      groups.push(cur)
    }
  }
  return groups
}

// ---------------------------------------------------------------------------
// 新卡判定：已见 id 集合（localStorage，键含 HANDOFF_HOME 散列）
// ---------------------------------------------------------------------------

/** 存储面（Storage 的结构子集）：注入式，单测用 Map 假货，浏览器传 localStorage。
 * removeItem 供 client 侧可写性探测用（写入后清理探针键）。 */
export interface SeenStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** FNV-1a 32 位散列（十六进制，8 位）：键命名空间用，不做安全用途 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 已见集合的存储键：含 HANDOFF_HOME 散列——同一浏览器（同源）先后连不同
 * 机器（端口转发场景）时不串扰。v1 后缀留版本余地。 */
export function seenStorageKey(home: string): string {
  return `dsh-takeover.seen.v1.${fnv1a(home)}`
}

/** 已见集合容量上限（防无限增长）：超出时保最新的一批 */
export const SEEN_CAP = 1000

/** 读已见集合：存储缺席 / 键不存在 / JSON 损坏 / 形态不符 → 空集，绝不抛错 */
export function loadSeenSet(store: SeenStore | null, key: string): Set<string> {
  if (store === null) return new Set()
  try {
    const raw = store.getItem(key)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    return new Set()
  }
}

/** 写已见集合：保最新 SEEN_CAP 条；存储缺席/写满（quota）静默放弃——
 * 徽标语义退化为「仅本会话记住」，比把异常抛进渲染强 */
export function saveSeenSet(store: SeenStore | null, key: string, ids: Iterable<string>): void {
  if (store === null) return
  try {
    const list = [...ids]
    store.setItem(key, JSON.stringify(list.length > SEEN_CAP ? list.slice(list.length - SEEN_CAP) : list))
  } catch {
    /* 配额满 / 禁写：静默 */
  }
}

/** 本次 state 里首次出现（不在已见集合）的卡 id——「新」徽标与组角标的数据源 */
export function newIdsOf(rows: PendingRow[], seen: Set<string>): string[] {
  return rows.filter((p) => !seen.has(p.id)).map((p) => p.id)
}

// ---------------------------------------------------------------------------
// 导出文本生成
// ---------------------------------------------------------------------------

/**
 * 协议六段固定顺序与标题（与 @agent-handoff/core card.ts 的 SECTION_KEYS 对齐）。
 * 线格式固定中文，是可解析的协议标识符（同 /handoff 等命令字面量），不进 i18n。
 */
export const SECTION_HEADINGS: ReadonlyArray<readonly [key: string, heading: string]> = [
  ['goal', '目标'],
  ['files', '涉及文件'],
  ['done', '做到哪'],
  ['remaining', '还差什么'],
  ['stopped', '停在哪'],
  ['warnings', '读者警告'],
]

/** 导出里的说明文案（调用方从 t() 现取，本模块保持无 i18n 依赖） */
export interface ExportNotes {
  /** 文件顶部：state 字段边界总说明 */
  top: string
  /** 单段全文不在 state 内时的就地说明 */
  missing: string
}

/**
 * YAML 双引号标量（协议 yamlParse 兼容口径）：
 * 先剔除换行/制表之外的控制字符（含 \r、DEL——真实卡片不会有，多是剪贴板污染），
 * 再按 \\ → \" → \n → \t 顺序转义。产出的形态 @agent-handoff/core 的
 * parseDoubleQuoted 与标准 YAML 双引号标量都能原样读回（单测有 round-trip）。
 */
export function yamlQuote(value: string): string {
  const stripped = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r]/g, '')
  const escaped = stripped
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/**
 * 单卡导出文本：frontmatter（只写 state 真有的字段）+ 六段正文。
 * - `handoff: 1` 是协议版本常量；to/session/cwd/git/tasks 不在 state 内，一律不写
 *   （core 解析时对缺失字段给默认值，好过写个假的 "any"）；
 * - 「目标」段 = state 预览（服务端截 240 字）；其余五段就地放 missing 说明；
 * - 顶部放 notes.top 总说明（正文首个 `##` 之前，协议解析会忽略，人读得懂）。
 * 结尾恰一个换行。
 */
export function cardMarkdown(p: PendingRow, notes: ExportNotes): string {
  const lines: string[] = [
    '---',
    'handoff: 1',
    `id: ${yamlQuote(p.id)}`,
    'from:',
    `  agent: ${yamlQuote(p.agent)}`,
    `  title: ${yamlQuote(p.title)}`,
    `project: ${yamlQuote(p.project)}`,
    `pushed_at: ${yamlQuote(p.pushedAt)}`,
    '---',
    '',
    notes.top,
    '',
  ]
  for (const [key, heading] of SECTION_HEADINGS) {
    // 目标段为空时预览取自 done 段（settings.previewOf 同款回退）——导出时各归各段：
    // 回退内容写进「做到哪」，「目标」段如实标 missing，不再段级错位
    let body = notes.missing
    if (key === 'goal' && !p.previewFromDone && p.preview !== '') body = p.preview
    if (key === 'done' && p.previewFromDone && p.preview !== '') body = p.preview
    lines.push(`## ${heading}`, '', body, '')
  }
  // 末位已垫空串元素，join 后恰一个收尾换行；不再追加
  return lines.join('\n')
}

/** 全部待取件拼一个 .md：卡与卡之间空行 + `---` 分隔线，末尾恰一个换行 */
export function pendingListMarkdown(rows: PendingRow[], notes: ExportNotes): string {
  if (rows.length === 0) return ''
  return `${rows.map((p) => cardMarkdown(p, notes).trimEnd()).join('\n\n---\n\n')}\n`
}
