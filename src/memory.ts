/**
 * 记忆快照交接：把各 agent 的本地记忆文件（CLAUDE.md / AGENTS.md / .cursorrules…）
 * 打包成一张 handoff: 1 交接卡进共享收件箱——会话能交接，记忆也能。
 * 扫描只读、清单确定（已知路径逐个 existsSync，绝不猜测目录内容）；
 * 出卡走 pushHandoff（密钥闸/空壳守门/覆盖率/机器信封整套纪律原样生效），
 * 卡的「建议加载」段装记忆正文，取件方按卡吸收进自己的记忆文件。
 * 四轴 IR 立约：本轴卡 extras.axis='memory'、extras.payload='files'（原文件正文随卡）。
 * 记忆库掏取契约：二进制/引擎型记忆库（hippo 等）走通用 MEMORY_STORES 注册表——
 * 每项 { id, label, entriesFile?, guidance }，条目 JSONL（每行 {text, tags?}）在场就
 * 实际读条目（64KB 截断口径内）进「建议加载」段，不在场退回该 store 的指引文案；
 * 不再有任何 store 的代码特例（hippo 只是注册表里的一项）。
 * @module dsh-takeover/memory
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pushHandoff, type PushResult } from './tools.ts'
import type { CardSections } from '@agent-handoff/core'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** 记忆来源定义：路径确定、只读；project 级仅在给出 cwd 时扫描 */
export interface MemorySourceDef {
  /** 稳定键（客户端勾选回传 / 工具 push 用） */
  key: string
  /** 归属 agent（展示用） */
  agent: string
  scope: 'user' | 'project'
  path: (home: string, cwd: string) => string
}

/** 已知记忆文件清单（用户级全局 + 项目级常用约定文件）。
 * 只列有公开文档惯例的路径；没列入的家不是不支持，是路径无公开惯例。
 * hippo-db 特殊行：dsh-hippo（伴侣智能体长期记忆插件）的记忆库——v0.1.9 起是
 * <数据目录>/memories/ 的 zvec 原生目录（proxima 向量索引 + rocksdb FTS），二进制
 * 不随卡直带，存在性照报（UI 提示装了记忆库）；出卡正文走 MEMORY_STORES 通用
 * 掏取契约（条目 JSONL 在场掏条目、缺席退回指引），这里只管「探测到没有」。 */
export const MEMORY_SOURCES: readonly MemorySourceDef[] = [
  { key: 'claude-user', agent: 'Claude Code', scope: 'user', path: (h) => join(h, '.claude', 'CLAUDE.md') },
  { key: 'codex-user', agent: 'Codex CLI', scope: 'user', path: (h) => join(h, '.codex', 'AGENTS.md') },
  { key: 'opencode-user', agent: 'OpenCode', scope: 'user', path: (h) => join(h, '.config', 'opencode', 'AGENTS.md') },
  { key: 'zcode-user', agent: 'ZCode', scope: 'user', path: (h) => join(h, '.zcode', 'AGENTS.md') },
  { key: 'cursor-user', agent: 'Cursor', scope: 'user', path: (h) => join(h, '.cursorrules') },
  { key: 'hippo-db', agent: 'dsh-hippo 记忆库', scope: 'user', path: (h) => join(hippoDataDir(h), 'memories') },
  { key: 'agents-project', agent: '项目 AGENTS.md', scope: 'project', path: (_h, c) => join(c, 'AGENTS.md') },
  { key: 'claude-project', agent: '项目 CLAUDE.md', scope: 'project', path: (_h, c) => join(c, 'CLAUDE.md') },
  { key: 'cursor-project', agent: '项目 .cursorrules', scope: 'project', path: (_h, c) => join(c, '.cursorrules') },
]

/**
 * dsh-hippo 数据目录解析（与 dsh-hippo 现役语义对齐，v0.1.9+ zvec 布局）：
 * 优先 HIPPO_DATA_DIR 环境变量，其次 ~/.hippo/data-dir.txt 内容（hippo 把自己的
 * 数据目录写在该文件），最后回退 ~/.hippo。探测对象是 <数据目录>/memories（zvec
 * 目录）存在性；数据根下的 memories.db 是旧版引擎遗留文件，不作判断依据。
 */
function hippoDataDir(home: string): string {
  const env = process.env['HIPPO_DATA_DIR']
  if (env !== undefined && env.trim() !== '') return env.trim()
  try {
    const raw = readFileSync(join(home, '.hippo', 'data-dir.txt'), 'utf-8').trim()
    if (raw !== '') return raw
  } catch { /* 文件缺失/读失败按未配置，继续回退 */ }
  return join(home, '.hippo')
}

const PREVIEW_CHARS = 240
/** 单文件进卡正文的上限（字符）：记忆文件异常巨大时截断并注明 */
const FILE_BODY_MAX = 64_000
/** 「建议加载」段总上限（pushHandoff 段闸 128K 之内先自查，超了按比例提示） */
const SUGGESTED_TOTAL_MAX = 120_000

/** 扫描结果行 */
export interface MemorySourceRow {
  key: string
  agent: string
  path: string
  exists: boolean
  bytes: number
  /** ISO 时间；不存在为空串 */
  mtime: string
  /** 开头预览（截 240 字符；不存在/超大为空串） */
  preview: string
  // 索引签名：让输出满足 defineTool 的 JsonValue 契约（CoverageStats/InboxItem 同款）
  [k: string]: string | number | boolean
}

function toIso(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : ''
}

/**
 * 记忆库 store 注册表项：二进制/引擎型记忆库的通用掏取契约。
 * 这类库的本体不是可读文件（zvec 目录 / sqlite 等），扫描只能报存在性；
 * 内容能不能随卡走，取决于该库有没有「条目 JSONL」导出落在约定路径上：
 * - entriesFile 在场：实际读条目（每行 {text, tags?}）进「建议加载」段（64KB 截断口径内）；
 * - entriesFile 不在场：退回 guidance 指引文案（告诉双方怎么补齐 JSONL 快照）。
 * entriesFile 是 (row) => 路径 的解析函数而非静态字符串：导出约定路径往往锚在
 * 该库的数据目录上，而数据目录是动态的（env / data-dir.txt / 回退根，hippoDataDir
 * 同款三级解析）——扫描行 row.path 已带解析好的基座，从它推约定路径即可，测试注入
 * 假 row 也天然可注入（假 entriesFile 指临时文件即得两态）。
 */
export interface MemoryStoreDef {
  /** 稳定键（与 MEMORY_SOURCES 的 key 对应，fileBody 按它查表） */
  id: string
  /** 展示名 */
  label: string
  /** 条目 JSONL 约定路径（每行 {text, tags?}）；undefined = 无掏取通路，恒走指引 */
  entriesFile?: (row: MemorySourceRow) => string
  /** 条目 JSONL 不在场时的退回指引文案（export/import 通路说明） */
  guidance: string
}

/**
 * 条目 JSONL 约定：每行一个 JSON 对象 {text, tags?}——与 `hippo export -f jsonl`
 * 的行形态兼容（多余字段忽略），其他记忆库照此约定产出即可获得同款掏取通路。
 */
export interface MemoryStoreEntry {
  text: string
  tags?: string[]
}

/** 记忆库 store 注册表（hippo 在册——不再是代码特例；新库 = 在这里加一项） */
export const MEMORY_STORES: readonly MemoryStoreDef[] = [
  {
    id: 'hippo-db',
    label: 'dsh-hippo 记忆库',
    // 导出约定路径：<数据目录>/hippo-memory.jsonl（row.path 是 <数据目录>/memories，
    // 取其父目录即数据目录根——与扫描同一套三级解析，不重复实现）
    entriesFile: (row) => join(dirname(row.path), 'hippo-memory.jsonl'),
    guidance: [
      '（dsh-hippo 记忆库是 zvec 原生目录（proxima 向量索引 + rocksdb FTS），二进制不随卡直带。官方互通通路走 hippo CLI 的 JSONL 导出/导入：',
      '- 源机：`hippo export -f jsonl -o hippo-memory.jsonl`（在 hippo 数据目录下执行）导出全库 JSONL 快照到约定路径 <数据目录>/hippo-memory.jsonl——重新出卡即自动按条目随卡携带；',
      '- 取件方若装了 dsh-hippo：`hippo import hippo-memory.jsonl` 幂等导入（自动重嵌入；重复条目强化合并、不覆盖已有记录）。',
      '本卡先携带来源清单与交接意图，JSONL 快照按上面两步补齐。）',
    ].join('\n'),
  },
]

/** 条目 JSONL 读取结果：entries 为解析出的有效条目（坏行/缺 text 跳过） */
export interface StoreEntriesRead {
  entries: MemoryStoreEntry[]
  /** 原始文件字符数（超 FILE_BODY_MAX 时渲染侧截断并注明） */
  rawChars: number
}

/**
 * 读一份条目 JSONL（纯读；64KB 截断口径由渲染侧执行，这里只解析）：
 * 每行一个 JSON 对象取 text 与 tags（非字符串 tags 项丢弃），坏行/空行/缺 text 行跳过。
 * 文件不在场 / 读失败 / 零有效条目 → undefined（调用方退回指引文案）。
 */
export function readStoreEntries(file: string): StoreEntriesRead | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch {
    return undefined
  }
  const entries: MemoryStoreEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    try {
      const o = JSON.parse(t) as Record<string, unknown>
      const text = typeof o['text'] === 'string' ? o['text'] : ''
      if (text === '') continue
      const tags = Array.isArray(o['tags'])
        ? o['tags'].filter((x): x is string => typeof x === 'string')
        : undefined
      entries.push(tags !== undefined && tags.length > 0 ? { text, tags } : { text })
    } catch { /* 坏行跳过：条目 JSONL 是外来数据，单行坏不拦整份 */ }
  }
  if (entries.length === 0) return undefined
  return { entries, rawChars: raw.length }
}

/** 条目 → 卡正文 bullet 列表（64KB 截断口径与文件正文一致，超限截断并注明） */
function renderStoreEntries(entries: MemoryStoreEntry[]): string {
  const body = entries
    .map((e) => `- ${e.text}${e.tags !== undefined ? ` [${e.tags.join(', ')}]` : ''}`)
    .join('\n')
  if (body.length <= FILE_BODY_MAX) return body
  return `${body.slice(0, FILE_BODY_MAX)}\n…（超 ${FILE_BODY_MAX} 字符截断，完整条目见条目 JSONL）`
}

/** store 行的卡正文：条目 JSONL 在场就掏条目，不在场退回该 store 的指引文案 */
function storeBody(row: MemorySourceRow, store: MemoryStoreDef): string {
  const file = store.entriesFile?.(row)
  if (file !== undefined) {
    const read = readStoreEntries(file)
    if (read !== undefined) return renderStoreEntries(read.entries)
  }
  return store.guidance
}

/** 扫描已知记忆文件（纯读；deps.home/cwd 可注入，缺省真实 home / 无项目级） */
export function scanMemorySources(deps?: { home?: string; cwd?: string }): MemorySourceRow[] {
  const home = deps?.home ?? homedir()
  const cwd = deps?.cwd ?? ''
  const rows: MemorySourceRow[] = []
  for (const def of MEMORY_SOURCES) {
    if (def.scope === 'project' && cwd === '') continue
    const p = def.path(home, cwd)
    try {
      if (def.key === 'hippo-db') {
        // hippo-db 特例（v0.1.9+ zvec 布局）：探测对象是 <数据目录>/memories 目录
        // 存在性，不是文件；目录体积不统计（proxima+rocksdb 索引树可达 GB 级，
        // 全量走盘不值）——bytes 恒 0，mtime 取目录自身，预览照旧不读。
        const st = statSync(p)
        const isDir = st.isDirectory()
        rows.push({ key: def.key, agent: def.agent, path: p, exists: isDir, bytes: 0, mtime: isDir ? toIso(st.mtimeMs) : '', preview: '' })
        continue
      }
      if (!existsSync(p)) {
        rows.push({ key: def.key, agent: def.agent, path: p, exists: false, bytes: 0, mtime: '', preview: '' })
        continue
      }
      const st = statSync(p)
      if (!st.isFile()) {
        rows.push({ key: def.key, agent: def.agent, path: p, exists: false, bytes: 0, mtime: '', preview: '' })
        continue
      }
      let preview = ''
      if (st.size <= 512 * 1024) {
        try {
          preview = readFileSync(p, 'utf-8').slice(0, PREVIEW_CHARS)
        } catch { /* 预览失败不拦扫描 */ }
      }
      rows.push({ key: def.key, agent: def.agent, path: p, exists: true, bytes: st.size, mtime: toIso(st.mtimeMs), preview })
    } catch {
      rows.push({ key: def.key, agent: def.agent, path: p, exists: false, bytes: 0, mtime: '', preview: '' })
    }
  }
  return rows
}

/** 读一份记忆文件进卡正文（超限截断并注明；读失败如实写 UNAVAILABLE）。
 * store 在册的行（hippo 等引擎型记忆库）不走文件读取，改走通用掏取契约：
 * 条目 JSONL 在场掏条目、不在场退回该 store 的指引文案（MEMORY_STORES 查表）。 */
function fileBody(row: MemorySourceRow, stores: readonly MemoryStoreDef[]): string {
  const store = stores.find((s) => s.id === row.key)
  if (store !== undefined) return storeBody(row, store)
  try {
    const text = readFileSync(row.path, 'utf-8')
    if (text.length <= FILE_BODY_MAX) return text
    return `${text.slice(0, FILE_BODY_MAX)}\n…（超 ${FILE_BODY_MAX} 字符截断，完整内容见源文件）`
  } catch (e) {
    return `（读取失败，UNAVAILABLE：${e instanceof Error ? e.message : String(e)}）`
  }
}

/** 记忆卡六段组装（全部 History_Reported 口径：记忆是历史快照不是当下事实）。
 * deps.stores 可注入 store 注册表（缺省 MEMORY_STORES）——测试用假 store 验证
 * 条目 JSONL 在场/缺席两态，不必真装 hippo。 */
export function memorySections(
  picks: MemorySourceRow[],
  meta: { target: string; at: string },
  deps?: { stores?: readonly MemoryStoreDef[] },
): CardSections {
  const stores = deps?.stores ?? MEMORY_STORES
  const kb = (n: number): string => (n >= 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${n} B`)
  const list = picks.map((r) => `- [${r.agent}] ${r.path}（${kb(r.bytes)}${r.mtime !== '' ? `，${r.mtime.slice(0, 10)}` : ''}）`).join('\n')
  const bodies = picks.map((r) => `## ${r.path}\n\n${fileBody(r, stores)}`).join('\n\n')
  // 汇总口径：store 行按其条目 JSONL 实际字节算（在场的掏取物如实计入总量），
  // 普通文件行按文件字符数——不再有按 key 硬编码的特例
  const total = picks.reduce((s, r) => {
    const store = stores.find((x) => x.id === r.key)
    if (store !== undefined) {
      const ef = store.entriesFile?.(r)
      if (ef === undefined) return s
      try { return s + statSync(ef).size } catch { return s }
    }
    try { return s + readFileSync(r.path, 'utf-8').length } catch { return s }
  }, 0)
  const goal = [
    `记忆快照交接：把本机 ${picks.length} 份记忆文件带给 ${meta.target}。`,
    '会话能交接，记忆也能——这些是各 agent 长期积累的项目约定与偏好，接手方吸收后即可延续工作习惯。',
    '来源清单：',
    list,
    `快照时刻：${meta.at}`,
  ].join('\n')
  return {
    goal,
    files: `随卡记忆文件 ${picks.length} 份（全文在「建议加载」段）：\n${list}`,
    done: `（资料卡：无可蒸馏的完成项。全部记忆正文见「建议加载」段，共约 ${kb(total)}，全部 HISTORY_REPORTED。）`,
    remaining: '取件方：把与本工作区相关的条目吸收进自己的记忆文件（CLAUDE.md / AGENTS.md / 记忆库），吸收后按己方惯例归档本卡。',
    stopped: `停在记忆快照时刻（${meta.at}）。最安全的第一步：只吸收与当前工作相关的条目，过期约定不盲信。`,
    warnings: [
      '记忆内容全部按 HISTORY_REPORTED 处理：是快照，不是当下事实；可能含过期约定、废弃路径或已被推翻的决定。',
      '吸收时逐条判断，与当前工作区指令冲突时以工作区为准。',
    ].join('\n'),
    suggested: bodies.length > SUGGESTED_TOTAL_MAX
      ? `${bodies.slice(0, SUGGESTED_TOTAL_MAX)}\n…（超出总上限截断——请按来源清单直接读源文件补齐）`
      : bodies,
  }
}

/** 记忆出卡参数（工作台路由与 handoff_memory 工具共用） */
export interface MemoryPushArgs {
  /** 要带的来源键；缺省 = 全部存在的用户级来源 */
  keys?: string[]
  target?: string
  title?: string
  lang?: 'zh' | 'en'
}

export type MemoryPushResult =
  | { ok: true; id: string; path: string; sources: number }
  | { ok: false; error: string }

/** 记忆出卡核心（pushHandoff 复用——session 传 undefined，六段全部手写，守门不误伤） */
export function pushMemoryCard(
  args: MemoryPushArgs,
  deps?: { scan?: typeof scanMemorySources; push?: typeof pushHandoff; dir?: string },
): MemoryPushResult {
  try {
    const scan = deps?.scan ?? scanMemorySources
    const push = deps?.push ?? pushHandoff
    const rows = scan().filter((r) => r.exists)
    const wanted = Array.isArray(args.keys) && args.keys.length > 0 ? new Set(args.keys.map(String)) : null
    const picks = wanted === null ? rows : rows.filter((r) => wanted.has(r.key))
    if (picks.length === 0) {
      return { ok: false, error: '没有可带的记忆文件：勾选的来源在盘上不存在（GET /dsh-takeover/memory-scan 可看清单）。' }
    }
    const target = typeof args.target === 'string' && args.target.trim() !== '' ? args.target.trim() : 'any'
    const at = new Date().toISOString()
    const sections = memorySections(picks, { target, at })
    const title = typeof args.title === 'string' && args.title.trim() !== ''
      ? args.title.trim()
      : `记忆快照 · ${picks.length} 份`
    const result: PushResult = push(undefined, {
      goal: sections.goal,
      files: sections.files,
      done: sections.done,
      remaining: sections.remaining,
      stopped: sections.stopped,
      warnings: sections.warnings,
      suggested: sections.suggested,
      title,
      to: target,
      project: '',
    }, {
      dir: deps?.dir,
      // 四轴 IR 立约：记忆卡是 memory 轴载荷，形态为 files（原文件正文随卡，
      // 取件方原样吸收整份——蒸馏条目形态用 payload='distilled'，本工具不产）
      extras: { axis: 'memory', payload: 'files' },
    })
    if (!result.ok) return result
    return { ok: true, id: result.id, path: result.path, sources: picks.length }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** execute 的规范值（命名类型别名：成员才拿得到隐式索引签名，满足 defineTool 的 JsonValue 契约） */
export type MemoryToolResult =
  | { ok: true; action: 'scan'; sources: MemorySourceRow[] }
  | { ok: true; action: 'push'; id: string; path: string; sources: number }
  | { ok: false; error: string }

/** 注册 handoff_memory 工具（agent 侧同款能力：scan 看清单 / push 出卡） */
export function registerMemoryTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'handoff_memory',
    description: '记忆快照交接：action=scan 列本机各 agent 的记忆文件（~/.claude/CLAUDE.md、~/.codex/AGENTS.md、~/.zcode/AGENTS.md、项目级 AGENTS.md 等，只读、含大小/预览）；action=push 把勾选的记忆打包成一张 handoff: 1 交接卡寄存进共享收件箱（密钥闸与覆盖率纪律同会话卡），任何 agent 可取件吸收。返回 { ok, ... } 规范值。',
    parameters: {
      action: { type: 'string', required: true, enum: ['scan', 'push'], description: 'scan 列记忆文件清单；push 打包出卡' },
      keys: { type: 'json', description: 'push：要带的来源键数组（scan 返回的 key）；缺省带全部存在的' },
      target: { type: 'string', description: 'push：目标 agent（claude/codex/…/any，默认 any）' },
      cwd: { type: 'string', description: 'push/scan：项目目录（带项目级记忆文件；缺省只扫用户级）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '操作是否成功' },
          action: { type: 'string', description: '实际执行的动作' },
          sources: { type: 'json', description: 'scan：记忆文件清单' },
          id: { type: 'string', description: 'push：卡片 id' },
          path: { type: 'string', description: 'push：卡片落盘路径' },
          error: { type: 'json', description: '失败原因' },
        },
      },
      render: renderMemory,
    },
    async execute(args: { action?: string; keys?: unknown; target?: string; cwd?: string }): Promise<MemoryToolResult> {
      if (args.action === 'scan') {
        return { ok: true, action: 'scan', sources: scanMemorySources({ cwd: typeof args.cwd === 'string' ? args.cwd : undefined }) }
      }
      if (args.action === 'push') {
        const result = pushMemoryCard({
          keys: Array.isArray(args.keys) ? args.keys.map(String) : undefined,
          target: args.target,
        }, { scan: () => scanMemorySources({ cwd: typeof args.cwd === 'string' ? args.cwd : undefined }) })
        if (result.ok) return { ok: true, action: 'push', id: result.id, path: result.path, sources: result.sources }
        return { ok: false, error: result.error }
      }
      return { ok: false, error: `未知 action：${String(args.action)}（支持 scan / push）` }
    },
  }))
}

/** execute 规范值 → 模型可见文本 */
export function renderMemory(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { ok?: boolean; action?: string; sources?: MemorySourceRow[]; id?: string; path?: string; sourcesCount?: number; error?: unknown }
  if (v.ok !== true) {
    return [{ type: 'text', text: `❌ 记忆交接失败：${typeof v.error === 'string' ? v.error : JSON.stringify(v.error)}` }]
  }
  if (v.action === 'scan') {
    const rows = v.sources ?? []
    if (rows.length === 0) return [{ type: 'text', text: '📭 没有发现任何已知记忆文件' }]
    const kb = (n: number): string => (n >= 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${n} B`)
    const lines = rows.map((r) => `${r.exists ? '✅' : '➖'} ${r.agent}｜${r.path}${r.exists ? `（${kb(r.bytes)}${r.preview !== '' ? `｜开头：${r.preview.slice(0, 60).replace(/\s+/g, ' ')}` : ''}）` : '（不存在）'}`)
    return [{ type: 'text', text: `🧠 本机记忆文件清单：\n${lines.join('\n')}\n\n出卡：handoff_memory({ action: "push", keys: ["<key>", …], target: "claude" })` }]
  }
  return [{ type: 'text', text: `🧠 记忆交接卡已寄存：${v.id}（${v.path}）。收件箱取件方按「建议加载」吸收。` }]
}
