/**
 * 记忆快照交接：把各 agent 的本地记忆文件（CLAUDE.md / AGENTS.md / .cursorrules…）
 * 打包成一张 handoff: 1 交接卡进共享收件箱——会话能交接，记忆也能。
 * 扫描只读、清单确定（已知路径逐个 existsSync，绝不猜测目录内容）；
 * 出卡走 pushHandoff（密钥闸/空壳守门/覆盖率/机器信封整套纪律原样生效），
 * 卡的「建议加载」段装记忆正文，取件方按卡吸收进自己的记忆文件。
 * @module dsh-takeover/memory
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
 * 不随卡直带，存在性照报（UI 提示装了记忆库），出卡时正文替换为 export/import 指引。 */
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

/** 读一份记忆文件进卡正文（超限截断并注明；读失败如实写 UNAVAILABLE。
 * hippo 记忆库是二进制例外：不读内容，写 export/import 互通指引——
 * dsh-hippo 官方通路（v0.1.9+ zvec 引擎）：`hippo export -f jsonl` 导出 JSONL
 * 快照，取件方 `hippo import <file>` 幂等合并导入） */
function fileBody(row: MemorySourceRow): string {
  if (row.key === 'hippo-db') {
    return [
      '（dsh-hippo 记忆库是 zvec 原生目录（proxima 向量索引 + rocksdb FTS），二进制不随卡直带。官方互通通路走 hippo CLI 的 JSONL 导出/导入：',
      '- 源机：`hippo export -f jsonl -o hippo-memory.jsonl` 导出全库 JSONL 快照，把该 JSONL 随同步盘带给对方（或作为记忆来源重新出卡）；',
      '- 取件方若装了 dsh-hippo：`hippo import hippo-memory.jsonl` 幂等导入（自动重嵌入；重复条目强化合并、不覆盖已有记录）。',
      '本卡先携带来源清单与交接意图，JSONL 快照按上面两步补齐。）',
    ].join('\n')
  }
  try {
    const text = readFileSync(row.path, 'utf-8')
    if (text.length <= FILE_BODY_MAX) return text
    return `${text.slice(0, FILE_BODY_MAX)}\n…（超 ${FILE_BODY_MAX} 字符截断，完整内容见源文件）`
  } catch (e) {
    return `（读取失败，UNAVAILABLE：${e instanceof Error ? e.message : String(e)}）`
  }
}

/** 记忆卡六段组装（全部 History_Reported 口径：记忆是历史快照不是当下事实） */
export function memorySections(
  picks: MemorySourceRow[],
  meta: { target: string; at: string },
): CardSections {
  const kb = (n: number): string => (n >= 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${n} B`)
  const list = picks.map((r) => `- [${r.agent}] ${r.path}（${kb(r.bytes)}${r.mtime !== '' ? `，${r.mtime.slice(0, 10)}` : ''}）`).join('\n')
  const bodies = picks.map((r) => `## ${r.path}\n\n${fileBody(r)}`).join('\n\n')
  const total = picks.reduce((s, r) => {
    if (r.key === 'hippo-db') return s + r.bytes
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
    }, { dir: deps?.dir })
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
