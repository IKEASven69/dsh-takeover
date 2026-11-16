/**
 * 记忆写回最小闭环（0.2.x）：handoff_absorb——把**已取件**的 memory 轴记忆卡
 * （payload='files'，「建议加载」段条目）写进目标 harness 的记忆文件。
 *
 * 硬线（THREAT-MODEL T8 · 写回面）：
 * 1. 外部 harness 的**会话存储永不写**——目标闭集 = MEMORY_SOURCES 的文件型记忆路径
 *    （CLAUDE.md / AGENTS.md / .cursorrules 族），无自由路径入参；hippo-db 是 zvec
 *    引擎目录，不是可写的记忆文件，明确拒收（回退指引走 hippo CLI import）。
 * 2. 写回 = 显式授权动作：confirm 两步确认（先 handoff_inbox load 看卡，再 absorb
 *    落盘），confirm 非 true 一律拒绝并把「将写什么」的计划原样回显。
 * 3. 追加前按条目 sha256 去重——目标文件已有的条目不重写（幂等：同一张卡重复
 *    absorb 第二次必为 0 追加）。
 * 4. 写前把目标文件原物快照进 archived/absorb-backup/<id>-<target>.md（可回滚；
 *    同名快照已存在时不覆盖——保留的永远是第一次写入前的原物）。
 * 5. 落盘 tmp+rename 原子替换；写后 lifecycle 记 absorbed-write 事件留痕。
 *
 * 卡源只认 archived/（已取件）：pending/ 里的卡还没看过就被落盘违反两步语义，
 * 明确拒绝并提示先取件。卡面 extras.axis !== 'memory' 的卡一律拒收。
 * @module dsh-takeover/absorb
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { archivedDir, assertSafeId, parseCardLenient } from '@agent-handoff/core'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { recordLifecycleEvent } from './lifecycle.ts'
import { MEMORY_SOURCES } from './memory.ts'

/** 卡 id 长度上限（与 tools.ts MAX_ID_CHARS 同口径——absorb 不反向依赖 tools，避免环） */
const ABSORB_ID_MAX = 64
/** 单次吸收追加总字符上限（与 memory.ts SUGGESTED_TOTAL_MAX 同量级：写回也要封顶，最坏有界） */
export const ABSORB_TOTAL_MAX = 120_000
/** 会话存储路径段黑名单（结构守门：目标注册表解析出的任何路径都不得命中——未来改注册表时在运行时兜底） */
const SESSION_STORE_SEGMENTS = new Set(['projects', 'sessions', 'storages', 'session-store', 'history'])

/** 吸收目标定义：从 MEMORY_SOURCES 选（复用同一份路径真源），hippo-db（引擎目录）除外 */
export interface AbsorbTargetDef {
  key: string
  agent: string
  scope: 'user' | 'project'
  path: (home: string, cwd: string) => string
}

/**
 * 吸收目标注册表：MEMORY_SOURCES 的文件型子集，AGENTS.md 族事实标准优先排序
 * （展示口径——工具错误文案按此序列候选）。hippo-db 特意不在册：zvec 原生目录
 * 不接受文件写回（写了就是砸库），absorb 对它单独给诚实报错。
 */
export const ABSORB_TARGETS: readonly AbsorbTargetDef[] = MEMORY_SOURCES
  .filter((d): d is typeof d & { key: string } => d.key !== 'hippo-db')
  .map((d) => ({ key: d.key, agent: d.agent, scope: d.scope, path: d.path }))
  .sort((a, b) => {
    const rank = (k: string): number => (k.includes('agents') || k === 'zcode-user' || k === 'codex-user' || k === 'opencode-user' ? 0 : 1)
    return rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)
  })

/** 解析出的目标路径做会话存储结构守门：路径段命中黑名单即拒（防注册表未来改动引入会话路径） */
function assertNotSessionStore(p: string): void {
  const segs = p.split(/[\\/]/).map((s) => s.toLowerCase())
  for (const seg of segs) {
    if (SESSION_STORE_SEGMENTS.has(seg)) {
      throw new Error(`写回目标命中会话存储路径段（${seg}）——外部 harness 的会话存储永不写（T8 硬线），注册表配置有误`)
    }
  }
}

/** 规范错误（readableError 不引依赖的本地简版：absorb 自产错误全是中文文案，系统错误包 errno 口径） */
function readable(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return `文件系统错误（${code}）：${e.message}`
    return e.message
  }
  return String(e)
}

/** 「建议加载」段条目：一行为一条（空行/段标题/截断标记行不算条目），sha 取 trim 后内容的 sha256 */
export interface AbsorbEntry {
  line: string
  sha256: string
  /** 条目来自卡内哪个来源块（`## <路径>` 标题；无标题块为「未标注来源」） */
  source: string
}

/**
 * 解析「建议加载」段为条目列表（确定性）：
 * - `## <路径>` 行是来源块标题（memorySections 的组装形态），不算条目，只记来源；
 * - 其余非空行各算一条（trim 后参与哈希与追加）；
 * - 截断标记行（`…（`开头，memory.ts 截断口径的产物）与块内小节标题形态跳过；
 * - 无任何 `##` 标题的外来卡：整段按「未标注来源」单块处理。
 */
export function parseSuggestedEntries(suggested: string): AbsorbEntry[] {
  const entries: AbsorbEntry[] = []
  let source = '未标注来源'
  for (const raw of suggested.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(raw)
    if (heading !== null) {
      source = heading[1]?.trim() ?? ''
      continue
    }
    const line = raw.trim()
    if (line === '' || line.startsWith('…（')) continue
    entries.push({ line, sha256: createHash('sha256').update(line, 'utf-8').digest('hex'), source })
  }
  return entries
}

/** 目标文件既有条目 sha 集合（非空行 trim 后哈希——与 parseSuggestedEntries 同口径） */
function existingShas(content: string): Set<string> {
  const out = new Set<string>()
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    out.add(createHash('sha256').update(line, 'utf-8').digest('hex'))
  }
  return out
}

/** absorb 参数（工具面与核心函数共用） */
export interface AbsorbArgs {
  id?: string
  target?: string
  confirm?: boolean
  /** project 级目标必填：目标记忆文件所在项目目录 */
  cwd?: string
}

/** absorb 依赖注入（测试用：dir=HANDOFF_HOME、home=user home、now=事件时刻） */
export interface AbsorbDeps {
  dir?: string
  home?: string
  now?: Date
}

export type AbsorbResult =
  | {
      ok: true
      action: 'absorb'
      id: string
      target: string
      agent: string
      /** 落盘的记忆文件绝对路径 */
      path: string
      /** 实际追加条数 */
      appended: number
      /** 按 sha 去重跳过的条数（目标已有，未重写） */
      deduped: number
      /** 写前原物快照路径（目标原本不存在时缺省） */
      snapshot?: string
      detail: string
    }
  | { ok: false; error: string }

/**
 * 记忆卡吸收核心（可脱离 host 单测）。全流程：
 * 参数校验 → 目标解析（闭集 + 会话存储守门）→ 读 archived 卡（未取件明确拒）
 * → axis=memory 校验 → 建议段解析 + sha 去重 → confirm 闸（缺省拒 + 计划回显）
 * → 快照 → tmp+rename 落盘 → lifecycle absorbed-write 留痕。
 * 任何失败都只回 { ok: false, error }，不抛异常。
 */
export function absorbCard(args: AbsorbArgs, deps?: AbsorbDeps): AbsorbResult {
  try {
    const id = (args.id ?? '').trim()
    if (id === '') return { ok: false, error: 'id 不能为空：先 handoff_inbox action=load 取件记忆卡，再 absorb 落盘' }
    if (id.length > ABSORB_ID_MAX) {
      return { ok: false, error: `非法卡片 id（长度 ${id.length} 超上限 ${ABSORB_ID_MAX}）：${id.slice(0, 48)}…` }
    }
    try {
      assertSafeId(id)
    } catch (e) {
      return { ok: false, error: `非法卡片 id：${readable(e)}` }
    }
    const targetKey = (args.target ?? '').trim()
    if (targetKey === '') {
      const keys = ABSORB_TARGETS.map((t) => t.key).join(' / ')
      return { ok: false, error: `target 不能为空：从注册表选一个（AGENTS.md 族事实标准优先）——${keys}；建议先 handoff_memory action=scan 看本机哪些记忆文件在场` }
    }
    if (targetKey === 'hippo-db') {
      return { ok: false, error: 'hippo-db 是 zvec 原生记忆库目录（proxima 向量索引 + rocksdb FTS），不能按文件写回——条目吸收走 hippo CLI：`hippo import hippo-memory.jsonl`（见记忆卡建议段的指引）' }
    }
    const def = ABSORB_TARGETS.find((t) => t.key === targetKey)
    if (def === undefined) {
      const keys = ABSORB_TARGETS.map((t) => t.key).join(' / ')
      return { ok: false, error: `未知 target：${targetKey}（注册表只有 ${keys}；会话存储路径不是合法目标——外部会话存储永不写）` }
    }
    const cwd = (args.cwd ?? '').trim()
    if (def.scope === 'project' && cwd === '') {
      return { ok: false, error: `target=${targetKey} 是项目级记忆文件，必须给 cwd（项目目录）` }
    }
    const home = deps?.home ?? homedir()
    const abs = def.path(home, cwd)
    assertNotSessionStore(abs)

    // 卡源只认 archived/：pending/ 的卡还没看过（两步语义第一步未完成），明确拒
    const archivedPath = join(archivedDir(deps?.dir), `${id}.md`)
    if (!existsSync(archivedPath)) {
      const pendingPath = join(archivedDir(deps?.dir).replace(/[\\/]archived$/, ''), 'pending', `${id}.md`)
      if (existsSync(pendingPath)) {
        return { ok: false, error: `卡 ${id} 还在 pending/（未取件）：两步语义是先 handoff_inbox action=load 看卡，再 absorb 落盘——先取件` }
      }
      return { ok: false, error: `archived/ 无此卡：${id}（absorb 只吸收已取件归档的卡；id 以 handoff_inbox 输出为准）` }
    }
    let axis: unknown
    let suggested = ''
    try {
      const card = parseCardLenient(readFileSync(archivedPath, 'utf-8'), { filename: `${id}.md` })
      axis = (card.extras as Record<string, unknown> | undefined)?.['axis']
      suggested = card.sections.suggested ?? ''
    } catch (e) {
      return { ok: false, error: `卡解析失败：${readable(e)}` }
    }
    if (axis !== 'memory') {
      return { ok: false, error: `非 memory 轴卡（axis=${String(axis ?? '缺省')}）：handoff_absorb 只吸收记忆卡（extras.axis='memory'）；会话卡/配置卡各有自己的消费通路` }
    }
    if (suggested.trim() === '') {
      return { ok: false, error: '本卡没有「建议加载」段，无可吸收条目' }
    }
    const entries = parseSuggestedEntries(suggested)
    if (entries.length === 0) {
      return { ok: false, error: '「建议加载」段没有可吸收的条目（全是标题/空行/截断标记）' }
    }

    // 去重：目标已有内容（trim 行 sha）命中的条目跳过；卡内重复条目也只追加一次
    let existing = ''
    let targetExists = false
    try {
      const st = statSync(abs)
      if (st.isFile()) {
        targetExists = true
        existing = readFileSync(abs, 'utf-8')
      }
    } catch { /* 目标不存在：全新建 */ }
    const shas = existingShas(existing)
    const seen = new Set<string>()
    const toAppend: AbsorbEntry[] = []
    let deduped = 0
    let totalChars = 0
    let truncated = false
    for (const e of entries) {
      if (shas.has(e.sha256) || seen.has(e.sha256)) {
        deduped += 1
        continue
      }
      if (totalChars + e.line.length + 1 > ABSORB_TOTAL_MAX) {
        truncated = true
        break
      }
      seen.add(e.sha256)
      toAppend.push(e)
      totalChars += e.line.length + 1
    }

    // confirm 闸：缺省一律拒绝，计划原样回显（两步语义第二步要模型/用户亲授）
    if (args.confirm !== true) {
      const planLines = [
        `将写入：${abs}（${def.agent}，${targetExists ? `已有 ${existing.length} 字符，追加` : '文件不存在，新建'}）`,
        ...toAppend.slice(0, 10).map((e) => `  + ${e.line}${e.source !== '未标注来源' ? `（来自 ${e.source}）` : ''}`),
        toAppend.length > 10 ? `  …共 ${toAppend.length} 条` : '',
        `去重跳过 ${deduped} 条（目标已有，不重写）${truncated ? `；超 ${ABSORB_TOTAL_MAX} 字符上限截断` : ''}`,
        targetExists ? `写前快照：archived/absorb-backup/${id}-${targetKey}.md（可回滚）` : '目标不存在，无快照',
        '两步确认：先 handoff_inbox action=load 看过卡，确认无误后带 confirm: true 重试。本调用未写任何盘。',
      ].filter(Boolean)
      return { ok: false, error: planLines.join('\n') }
    }

    // 写前三件套：快照（首个快照不被覆盖，永远是第一次写入前的原物）→ tmp+rename → 留痕
    mkdirSync(dirname(abs), { recursive: true })
    let snapshot: string | undefined
    if (targetExists) {
      const backupDir = join(archivedDir(deps?.dir), 'absorb-backup')
      mkdirSync(backupDir, { recursive: true })
      snapshot = join(backupDir, `${id}-${targetKey}.md`)
      if (!existsSync(snapshot)) copyFileSync(abs, snapshot)
    }
    let content = existing
    if (content !== '' && !content.endsWith('\n')) content += '\n'
    content += toAppend.map((e) => e.line).join('\n')
    if (toAppend.length > 0) content += '\n'
    const tmp = `${abs}.${process.pid}.tmp`
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, abs)

    recordLifecycleEvent({
      stage: 'write',
      reason: 'absorbed-write',
      target: id,
      detail: `${def.agent}（${targetKey}）追加 ${toAppend.length} 条、去重 ${deduped} 条；${snapshot !== undefined ? `快照 ${basename(snapshot)}` : '目标原不存在（新建）'}${truncated ? '；超限截断' : ''}`,
    }, deps?.dir, deps?.now)

    return {
      ok: true,
      action: 'absorb',
      id,
      target: targetKey,
      agent: def.agent,
      path: abs,
      appended: toAppend.length,
      deduped,
      ...(snapshot !== undefined ? { snapshot } : {}),
      detail: `${def.agent} 记忆文件已按条目吸收（追加 ${toAppend.length} / 去重 ${deduped}）${truncated ? `，超 ${ABSORB_TOTAL_MAX} 字符部分截断` : ''}${snapshot !== undefined ? `；写前原物快照在 ${snapshot}（回滚 = 用快照覆盖目标文件）` : '；目标为新建，无快照'}。重复 absorb 同一张卡是幂等的（全部去重，0 追加）。`,
    }
  } catch (e) {
    return { ok: false, error: readable(e) }
  }
}

/** execute 规范值 → 模型可见文本 */
export function renderAbsorb(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { ok?: boolean; id?: string; agent?: string; path?: string; appended?: number; deduped?: number; snapshot?: string; detail?: string; error?: unknown }
  if (v.ok !== true) {
    return [{ type: 'text', text: `❌ 吸收未执行：${typeof v.error === 'string' ? v.error : JSON.stringify(v.error)}` }]
  }
  const lines = [
    `🧠 已吸收进 ${v.agent ?? ''} 记忆文件：${v.path ?? ''}`,
    `卡片 ${v.id ?? ''}：追加 ${v.appended ?? 0} 条、去重跳过 ${v.deduped ?? 0} 条（已有内容不重写）`,
  ]
  if (typeof v.snapshot === 'string' && v.snapshot !== '') lines.push(`↩️ 写前原物快照：${v.snapshot}（回滚 = 用快照覆盖目标文件）`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 注册 handoff_absorb 工具（写回面唯一记忆入口：confirm 两步 + 去重 + 快照 + 留痕） */
export function registerAbsorbTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'handoff_absorb',
    description: '记忆写回（显式授权动作）：把已取件（archived/）的 memory 轴记忆卡「建议加载」段条目写进目标 harness 的记忆文件。目标闭集 = MEMORY_SOURCES 的文件型记忆路径（claude/codex/opencode/zcode 的 AGENTS.md 与 CLAUDE.md 族、.cursorrules、项目级三件），外部 harness 的会话存储永不写。confirm 两步强制：先 handoff_inbox action=load 看卡，再 absorb 落盘；缺 confirm 一律拒绝并回显「将写什么」计划。追加前按条目 sha 去重（已有内容不重写），写前把目标原物快照进 archived/absorb-backup/（可回滚），写后记 absorbed-write 生命周期事件。返回 { ok, path, appended, deduped, snapshot? } 规范值。',
    parameters: {
      id: { type: 'string', required: true, description: '已取件记忆卡的 id（handoff_inbox action=load 后在 archived/）' },
      target: { type: 'string', required: true, description: '目标记忆文件键（claude-user / zcode-user / codex-user / opencode-user / cursor-user / agents-project / claude-project / cursor-project；hippo-db 是引擎目录不可按文件写回）' },
      confirm: { type: 'boolean', description: '必须显式 true 才落盘（两步确认：先 load 看卡再 absorb；缺省拒绝并回显计划）' },
      cwd: { type: 'string', description: '项目级目标（*-project）必填：项目目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '是否已落盘（false = 拒绝/计划回显，未写盘）' },
          action: { type: 'string', description: '动作名（absorb）' },
          id: { type: 'string', description: '吸收的卡片 id' },
          target: { type: 'string', description: '目标键' },
          agent: { type: 'string', description: '目标 agent 名' },
          path: { type: 'string', description: '落盘的记忆文件绝对路径' },
          appended: { type: 'number', description: '实际追加条数' },
          deduped: { type: 'number', description: '按 sha 去重跳过条数' },
          snapshot: { type: 'string', description: '写前原物快照路径（目标原本不存在时缺省）' },
          error: { type: 'json', description: '拒绝/失败原因（confirm 缺省时含「将写什么」计划）' },
        },
      },
      render: renderAbsorb,
    },
    async execute(args: AbsorbArgs): Promise<AbsorbResult> {
      return absorbCard(args)
    },
  }))
}
