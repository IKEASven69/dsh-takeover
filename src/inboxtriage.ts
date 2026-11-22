/**
 * 收件箱 triage 三件（0.26 扩展波）：置顶 / 正文过滤 / 弃置恢复。
 *
 * 三块能力都是 pending/archived 之外的**旁路层**——不改取件状态机、不新增
 * npm 依赖、任何 IO 失败都回规范值绝不抛出（与 settings/lifecycle 同纪律）：
 * - 置顶：pinIds 存 `<HANDOFF_HOME>/pins.json`（本机视图 sidecar，键=卡 id），
 *   set/unset/list 三操作；卡被消费（.md 被 loadCard 搬走）或弃置（dismiss
 *   搬去 archived/）后 pin **自动失效不报错**——list 读取时对盘面现实校验，
 *   失效条目顺手从 sidecar 清掉（懒清理：消费方 tools/settings 不需要感知 pin）；
 * - 正文过滤：searchInbox(query, { includeBody })，includeBody 时逐张 pending
 *   卡读 .md 全文做大小写不敏感子串匹配（167 张 × 几 KB 全内存毫秒级，零索引
 *   ——为这个量级建倒排是负收益），返回命中 id + 命中行摘要；
 * - 弃置恢复：restoreFromArchived(id) 按 dismissPending 同一扩展名枚举**反向**
 *   搬 archived→pending（含 gzip 分块名单扫），成功后写 lifecycle 一条
 *   stage='write' reason='restored' 正向回执（dismiss 落 abandoned 的逆操作对）。
 *
 * 路径安全：id 消毒与 dismissPending 同款（trim + 去 / \）——pins.json 的键在
 * 载入时也过同一消毒（键含路径分隔符的条目直接丢弃，防 hand-edit 出穿越面）。
 * @module dsh-takeover/inboxtriage
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listPendingReport, resolveHome } from '@agent-handoff/core'
import { recordLifecycleEvent } from './lifecycle.ts'

// ---------------------------------------------------------------------------
// id 消毒（与 settings.dismissPending 同款；两处语义必须保持一致）
// ---------------------------------------------------------------------------

/** 卡 id 消毒：trim + 去路径分隔符。空串由调用方判（各自给各自的错误文案） */
function sanitizeCardId(id: string): string {
  return String(id ?? '').trim().replace(/[\\/]/g, '')
}

// ---------------------------------------------------------------------------
// ① 置顶：pins.json 本机视图 sidecar
// ---------------------------------------------------------------------------

/** pins.json 文件名（置于 <HANDOFF_HOME>/ 下，与 config.json/lifecycle.jsonl 同屋） */
export const PINS_FILE = 'pins.json'

/** 置顶清单容量封顶：超限丢最旧（at 最小）——sidecar 不做无界增长 */
export const PINS_CAP = 500

/** pins.json 路径：HANDOFF_HOME 优先，否则 ~/.handoff（resolveHome 同款解析） */
export function pinsPath(dir?: string): string {
  return join(resolveHome(dir), PINS_FILE)
}

/**
 * 读 pins.json：文件缺席 / JSON 损坏 / 形态不符 → 空表（fail-open 是有文档的
 * 取舍——置顶是本机便利视图，坏了就当没置顶，绝不拦主流程）；键过 id 消毒，
 * 含路径分隔符或空键的条目直接丢弃；值非字符串的条目丢弃。dropped=载入时
 * 丢弃过条目（损坏键）——调用方可在下次写回时顺手把 sidecar 自愈干净。
 */
function readPins(dir?: string): { pins: Record<string, string>; dropped: boolean } {
  const path = pinsPath(dir)
  if (!existsSync(path)) return { pins: {}, dropped: false }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { pins: {}, dropped: true }
    const out: Record<string, string> = {}
    let dropped = false
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const safe = sanitizeCardId(key)
      if (safe === '' || safe !== key || typeof value !== 'string') {
        dropped = true
        continue
      }
      out[key] = value
    }
    return { pins: out, dropped }
  } catch {
    return { pins: {}, dropped: true }
  }
}

/**
 * 写 pins.json：tmp+rename 原子替换（settings.saveSwitches 同款——进程中断
 * 不留半截文件）；rename 失败退回直写。返回是否写成功，调用方给诚实两态。
 */
function writePins(pins: Record<string, string>, dir?: string): boolean {
  const home = resolveHome(dir)
  try {
    mkdirSync(home, { recursive: true })
  } catch { /* 目录已存在等——直写时再暴露真实错误 */ }
  const target = pinsPath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(pins, null, 2)}\n`, 'utf-8')
    try {
      renameSync(tmp, target)
    } catch (e) {
      // rename 失败（跨设备等）退回直写；临时文件尽力清掉
      try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
      throw e
    }
    return true
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    console.warn(`[dsh-takeover] pins.json 写入失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** 置顶一张卡（幂等：重复置顶只刷新时间戳）。id 为空回规范错误值 */
export function setPin(id: string, dir?: string, now?: Date): { ok: boolean; error?: string } {
  const safe = sanitizeCardId(id)
  if (safe === '') return { ok: false, error: 'id 不能为空' }
  const { pins } = readPins(dir)
  // 容量封顶：新条目进不来时丢最旧（at 字典序=时间序，ISO8601 同口径可比），
  // 腾出的名额至少 1 个，保证本次 set 落盘
  if (!(safe in pins)) {
    const entries = Object.entries(pins)
    if (entries.length >= PINS_CAP) {
      entries.sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      for (const [staleId] of entries.slice(0, entries.length - PINS_CAP + 1)) delete pins[staleId]
    }
  }
  pins[safe] = (now ?? new Date()).toISOString()
  return writePins(pins, dir) ? { ok: true } : { ok: false, error: 'pins.json 写入失败（详见服务端日志）' }
}

/** 解除置顶：未置顶回规范错误值（诚实两态——「本来就没置顶」不是成功解除） */
export function unsetPin(id: string, dir?: string): { ok: boolean; error?: string } {
  const safe = sanitizeCardId(id)
  if (safe === '') return { ok: false, error: 'id 不能为空' }
  const { pins } = readPins(dir)
  if (!(safe in pins)) return { ok: false, error: `该卡未置顶：${safe}` }
  delete pins[safe]
  return writePins(pins, dir) ? { ok: true } : { ok: false, error: 'pins.json 写入失败（详见服务端日志）' }
}

/**
 * 列当前有效的置顶卡 id（新置顶在前，at 降序）。
 * 有效性判据 = pending/<id>.md 还在盘上：卡被消费（loadCard 搬走）或弃置
 * （dismiss 搬去 archived）后 pin 自动失效，**不报错**；失效条目顺手从
 * sidecar 清掉（懒清理，写失败静默——下次 list 再试，视图语义不受影响）。
 */
export function listPins(dir?: string): string[] {
  const { pins, dropped } = readPins(dir)
  const pd = join(resolveHome(dir), 'pending')
  const valid: Array<{ id: string; at: string }> = []
  let pruned: Record<string, string> | null = null
  for (const [id, at] of Object.entries(pins)) {
    const live = (() => {
      try { return existsSync(join(pd, `${id}.md`)) } catch { return false }
    })()
    if (live) {
      valid.push({ id, at })
    } else {
      // 卡已不在 pending（被消费/弃置/手删）→ pin 失效；记下待写回的精简表
      pruned ??= { ...pins }
      delete pruned[id]
    }
  }
  // 失效清理落盘（含载入时丢弃的损坏键——读一次就把 sidecar 自愈干净）；写失败静默
  if (pruned !== null || dropped) writePins(pruned ?? pins, dir)
  return valid.sort((a, b) => b.at.localeCompare(a.at)).map((v) => v.id)
}

/** 单卡是否置顶（对 listPins 结果判定——无效 pin 在 list 时已被清理） */
export function isPinned(id: string, dir?: string): boolean {
  return listPins(dir).includes(sanitizeCardId(id))
}

// ---------------------------------------------------------------------------
// ② 正文过滤：searchInbox
// ---------------------------------------------------------------------------

/** 单卡最多返回的命中行数（正文命中的摘要是给人扫一眼定位的，不是全文回传） */
export const BODY_HIT_LINES_MAX = 5

/** 单条命中行摘要的最大长度（超出截断加省略号） */
export const BODY_LINE_SNIPPET_MAX = 160

/** 正文扫描尺寸闸：与 core MAX_CARD_BYTES / settings.buildState 同口径——
 * 巨文件不全量读进内存；core 的 listDirCards 已把超尺寸卡挡在 cards 外，
 * 这里再闸一次防「列表与读取之间文件被换大」的竞态窗口 */
export const SEARCH_MAX_CARD_BYTES = 8 * 1024 * 1024

export interface InboxSearchOptions {
  /** true = 逐张读 .md 全文匹配并产出命中行摘要；缺省 = 只匹配元字段（不读正文全文留存） */
  includeBody?: boolean
  /** HANDOFF_HOME（测试注入）；缺省走 resolveHome 环境解析 */
  dir?: string
}

export interface InboxSearchHit {
  id: string
  agent: string
  title: string
  project: string
  /** 命中面：meta=编号/标题/来源/项目；body=.md 全文（含 frontmatter）命中 */
  where: 'meta' | 'body' | 'meta+body'
  /** 正文命中行摘要（至多 BODY_HIT_LINES_MAX 行，每行截 BODY_LINE_SNIPPET_MAX）；meta 命中为空数组 */
  lines: string[]
}

export interface InboxSearchResult {
  /** 原样回显的查询词（trim 前） */
  query: string
  includeBody: boolean
  /** 实际扫描的卡数（坏卡/重复卡剔除后） */
  scanned: number
  /** 因尺寸闸跳过正文扫描的卡 id（诚实暴露：这些卡可能含查询词但没扫，不静默漏） */
  skippedOversize: string[]
  hits: InboxSearchHit[]
  /** 收件箱整体不可读时的规范错误值（hits 为空；单卡读失败不进这里，只降级该卡正文） */
  error?: string
}

/**
 * 收件箱检索：query 与卡元字段（编号/标题/来源 agent/项目）大小写不敏感子串
 * 匹配；includeBody 时再逐张读 .md 全文匹配（167 张 × 几 KB 全内存毫秒级，
 * 零索引——按卡数线性扫，不为这个量级建倒排）。返回命中 id + 命中行摘要。
 *
 * 防御：
 * - query trim 后为空 → 空命中、scanned=0（不做全量枚举——空查询回全屏是 footgun）；
 * - 同 frontmatter id 的重复文件只扫首次出现（settings.buildState 同款）；
 * - 单卡读失败 = 该卡正文不可扫（meta 命中仍有效），不拦其余卡；
 * - 枚举失败 = 整体 error 规范值（与 state.inboxError 同语义），绝不抛出。
 */
export function searchInbox(query: string, opts?: InboxSearchOptions): InboxSearchResult {
  const dir = opts?.dir
  const includeBody = opts?.includeBody === true
  const rawQuery = String(query ?? '')
  const q = rawQuery.trim().toLowerCase()
  const base: InboxSearchResult = { query: rawQuery, includeBody, scanned: 0, skippedOversize: [], hits: [] }
  if (q === '') return base
  let cards
  try {
    cards = listPendingReport(dir).cards
  } catch (e) {
    return { ...base, error: `收件箱不可读：${e instanceof Error ? e.message : String(e)}` }
  }
  // 同 frontmatter id 的重复文件只保留首次出现（core 宽松解析放行，重复让 React key
  // 冲突、命中率虚高——0.4.0 审计 F1 同款处理）
  const seen = new Set<string>()
  const unique = cards.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
  const pd = join(resolveHome(dir), 'pending')
  const hits: InboxSearchHit[] = []
  const skippedOversize: string[] = []
  let scanned = 0
  for (const c of unique) {
    scanned += 1
    const title = typeof c.from?.title === 'string' ? c.from.title : ''
    const agent = typeof c.from?.agent === 'string' ? c.from.agent : ''
    const project = typeof c.project === 'string' ? c.project : ''
    const metaHit = title.toLowerCase().includes(q)
      || c.id.toLowerCase().includes(q)
      || agent.toLowerCase().includes(q)
      || project.toLowerCase().includes(q)
    const lines: string[] = []
    let bodyHit = false
    if (includeBody) {
      try {
        const p = join(pd, `${c.id}.md`)
        if (statSync(p).size > SEARCH_MAX_CARD_BYTES) {
          skippedOversize.push(c.id)
        } else {
          // 扫描面 = .md 全文（含 frontmatter）：卡正文的诚实口径是整文件，
          // frontmatter 里的标题/项目本就是元字段的同源，重复命中无害
          const collected = new Set<string>()
          for (const rawLine of readFileSync(p, 'utf-8').split('\n')) {
            const line = rawLine.trim()
            if (line === '' || !line.toLowerCase().includes(q)) continue
            bodyHit = true
            const snippet = line.length > BODY_LINE_SNIPPET_MAX ? `${line.slice(0, BODY_LINE_SNIPPET_MAX)}…` : line
            collected.add(snippet)
            if (collected.size >= BODY_HIT_LINES_MAX) break
          }
          lines.push(...collected)
        }
      } catch { /* 单卡读失败=该卡正文不可扫（不拦其余卡），meta 命中仍有效 */ }
    }
    if (!metaHit && !bodyHit) continue
    hits.push({
      id: c.id,
      agent,
      title,
      project,
      where: metaHit && bodyHit ? 'meta+body' : metaHit ? 'meta' : 'body',
      lines,
    })
  }
  return { ...base, scanned, skippedOversize, hits }
}

// ---------------------------------------------------------------------------
// ③ 弃置恢复：restoreFromArchived（dismissPending 的逆操作）
// ---------------------------------------------------------------------------

/** 随卡同搬的固定扩展名枚举（与 settings.dismissPending 逐字一致——两边不同步就会出现单侧认不出的形态） */
const RESTORE_EXTS = ['.md', '.envelope.json', '.patch', '.patch.gz', '.hippo.jsonl'] as const

/** gzip 分块文件名尾段校验（<id>.patch.NNN.gz，NNN 纯数字）；与 dismissPending 同款正则口径 */
const RESTORE_CHUNK_SUFFIX_RE = /^\d+\.gz$/

export interface RestoreResult {
  ok: boolean
  /** 实际搬回 pending 的文件份数 */
  moved?: number
  error?: string
}

/**
 * 弃置恢复：把一张已弃置卡（dismissPending 搬进 archived/ 的整卡）按原路径搬回
 * pending/，让它在收件箱重新可见、可取件。搬运清单 = dismissPending 同一扩展名
 * 枚举（.md/.envelope.json/.patch/.patch.gz/.hippo.jsonl）+ gzip 分块名单扫
 * （<id>.patch.NNN.gz，固定枚举盖不住带序号的形态）。
 *
 * 语义细节：
 * - archived/ 没有这张卡的任何形态 → 规范错误值（可能从未 dismiss、已被恢复、
 *   或已被 clearArchived 清掉）；
 * - pending 已有同名文件（同 id 卡被重新 push 过）→ **一次都不搬**并报错——
 *   rename 会静默覆盖，覆盖即毁掉活卡，违背恢复语义（预检全部通过才动第一份）；
 * - 成功后写 lifecycle 一条 stage='write' reason='restored' 正向回执
 *   （target=卡 id，detail=搬运份数，不落卡正文）；部分失败不落账（卡不完整）。
 * 路径安全：id 消毒与 dismissPending 同款。
 */
export function restoreFromArchived(id: string, dir?: string, now?: Date): RestoreResult {
  const safe = sanitizeCardId(id)
  if (safe === '') return { ok: false, error: 'id 不能为空' }
  const home = resolveHome(dir)
  const ad = join(home, 'archived')
  if (!existsSync(ad)) return { ok: false, error: `archived 里没有这张卡：${safe}（可能从未弃置过卡）` }
  // 预检：收集搬运清单（archived 侧实际在场的文件），一个都不动
  const plan: string[] = []
  for (const ext of RESTORE_EXTS) {
    if (existsSync(join(ad, safe + ext))) plan.push(safe + ext)
  }
  try {
    const prefix = `${safe}.patch.`
    for (const f of readdirSync(ad)) {
      if (!f.startsWith(prefix) || !f.endsWith('.gz')) continue
      if (!RESTORE_CHUNK_SUFFIX_RE.test(f.slice(prefix.length))) continue
      if (!plan.includes(f)) plan.push(f)
    }
  } catch (e) {
    return { ok: false, error: `archived 目录枚举失败（${e instanceof Error ? e.message : String(e)}）` }
  }
  if (plan.length === 0) return { ok: false, error: `archived 里没有这张卡：${safe}（可能从未 dismiss、已被恢复或已被清空）` }
  for (const name of plan) {
    if (existsSync(join(home, 'pending', name))) return { ok: false, error: `pending 已有同名文件，拒绝覆盖：${name}（先处理同名冲突再恢复）` }
  }
  // pending/ 可能被人手删过（全新总线 push 才建目录）：先补上
  try {
    mkdirSync(join(home, 'pending'), { recursive: true })
  } catch (e) {
    return { ok: false, error: `pending 目录创建失败（${e instanceof Error ? e.message : String(e)}）` }
  }
  let moved = 0
  for (const name of plan) {
    try {
      renameSync(join(ad, name), join(home, 'pending', name))
      moved += 1
    } catch (e) {
      return { ok: false, moved, error: `移动失败：${name}（${e instanceof Error ? e.message : String(e)}）` }
    }
  }
  // 正向回执落账：abandoned（未取件即弃）的逆操作对；detail=搬运份数，不落卡正文
  recordLifecycleEvent({ stage: 'write', reason: 'restored', target: safe, detail: `archived→pending 恢复 ${moved} 份` }, dir, now)
  return { ok: true, moved }
}
