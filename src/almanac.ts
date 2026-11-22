/**
 * 0.26 扩展波 · 接力年鉴（relay-almanac，/almanac）：一条命令把这台机器真实发生过的
 * 接力史编成一页可分享、可审计的 markdown——拦截面 / 救生艇 / 跨家来源 / 归档窗口，
 * 每个数字回指盘上一行，零编造。
 *
 * 四项统计、每项单源可对账（聚合计数绝不跨源拼凑）：
 * 1. **闭集理由直方图**——读既有 readLifecycleEvents（src/lifecycle.ts:94），闭集
 *   LIFECYCLE_REASONS（密钥闸 secret_gate / 空壳闸 skeleton_gate / 救生艇 lifeboat / …），
 *   全闭集在册（缺席理由计 0，逐项可对账）；输出自带「账本尾部 500 条内」窗口标注
 *   （LIFECYCLE_LOG_MAX=500，src/lifecycle.ts:61）——账本是尾 500 条滚动窗口，年鉴只陈述
 *   窗口内的真实行数，绝不冒充全史；
 * 2. **救生艇抢出**——次数 + 目标 id 列表（lifeboat 闭集，src/lifecycle.ts:30；面板一键
 *   抢出不经模型出卡）。列表只含 target id 与事件时刻，detail 原文留在账本不进年鉴；
 * 3. **接力来源家**——relay/*.json 溯源文件按 RelayRecordData 形态（src/relay-records.ts:21）
 *   防御式解析，**非空 provider 去重**计数（provider 为空串/缺席/纯空白的溯源如实不计入
 *   distinct 口径）；只落家名与计数，不落 sessionId / sourceId / title；
 * 4. **归档滚动窗口张数**——archived/ 现场清点 .md 卡与非 .md 侧车（ARCHIVED_KEEP=50，
 *   vendor core dist/index.d.mts:100 实读），窗口只滚 .md、侧车不随之清理（settings
 *   trimArchived 同口径）。现场清点不验卡面健康——那是 sessiondoctor 的职责，单源纪律。
 *
 * 今晚裁剪：链跳数 / 分叉 / 成环统计**不在本模块**——链装配唯一归属 ledger 工作流
 * （assembleChains，supersedes 走查 + 信封兜底），两模块不重复实现。分工口径写死：
 * **年鉴 = 整机聚合直方图（本模块），总账 = 逐卡逐棒对账行（ledger）**；两者各自 import
 * 既有读取器（lifecycle.ts / core），互不 import。
 *
 * 只计数、不评分（docs/计划-0.26.md:38 候选 C「延续率评分」判死原文：无账本数据前是
 * 编数字）——年鉴不做任何打分 / 排名 / 等级，数字就是数字。
 *
 * 措辞红线：lifecycle.jsonl 与 relay/ 不随换机同步（src/sync.ts:38-44 GITIGNORE 实读，
 * 机器本地记录不入库），年鉴是「这台机器的故事」——标题与正文只说本机，不得夸成
 * 「全总线 / 全网」口径；计数随本机测试排放漂移，输出永远带窗口与「以重跑为准」语义。
 *
 * 隐私纪律（可分享的前提）：全文无卡正文、无绝对路径、无会话 id / 会话标题——
 * 只有计数、闭集理由名、provider 家名与卡 id 形态（id 形态是账本行的寻址锚点，可公开）。
 *
 * 防御式纪律（与 lifecycle / sessiondoctor 同款 fail-open）：relay 单文件解析炸只计
 * unread 一笔不拖垮聚合；目录缺席 = 全新机器的诚实零态（不抛、不加降级附注）；目录
 * 在场但读取失败才记 notes。本模块零 LLM、零子进程、零网络。
 *
 * 集成面接线立约（照 src/receipt.ts:26 同款；本模块不改七集成面
 * server / client / settings / tools / index / locales / collect）：
 * ```
 * // /almanac 暴露位：skills/almanac.ts（集成面新建，同 skills/inbox.ts 模板）：
 * export const ALMANAC_SKILL_CONTENT = `# 接力年鉴（/almanac）……`
 * export function almanacSkillRegistration(): SkillRegistration {
 *   return { name: 'almanac', description: '把这台机器的真实接力史编成一页可分享的年鉴',
 *            source: 'bundled', provider: 'dsh-takeover',
 *            invocation: { modelInvocable: false, userInvocable: true },
 *            content: ALMANAC_SKILL_CONTENT }
 * }
 * // 挂点：skills/index.ts skillRegistrations() 数组追加 almanacSkillRegistration()；
 * // 导出面：src/index.ts 补 buildAlmanac / renderAlmanac 同位 export——归集成工程师层
 * ```
 *
 * @module dsh-takeover/almanac
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARCHIVED_KEEP, archivedDir, resolveHome } from '@agent-handoff/core'
import { LIFECYCLE_LOG_MAX, LIFECYCLE_REASONS, readLifecycleEvents, type LifecycleReason } from './lifecycle.ts'
import type { RelayRecordData } from './relay-records.ts'

/** 救生艇目标（账本行的寻址锚点：卡 id + 事件时刻；detail 原文不进年鉴） */
export interface AlmanacLifeboatTarget {
  /** 卡 id（lifecycle 事件 target 字段原文） */
  id: string
  /** 事件时刻 ISO 串（回指 lifecycle.jsonl 那一行的 at） */
  at: string
}

/** 接力来源家（relay/*.json 溯源的非空 provider 去重口径） */
export interface AlmanacRelayStats {
  /** 在场清点的 relay/*.json 文件数（含 provider 为空与解析失败的文件——「见到多少」口径） */
  files: number
  /** provider 非空（trim 后非空串）的溯源份数 */
  withProvider: number
  /** 去重后的来源家名（字典序；只落家名，不落 sessionId / title） */
  providers: string[]
  /** = providers.length（distinct 口径只计非空值） */
  distinctProviders: number
  /** 未能按 RelayRecordData 形态解析的文件数（fail-open 跳过，不计入任何 provider 计数） */
  unread: number
}

/** 年鉴统计（纯数据，每项单源；字段只此六件） */
export interface AlmanacStats {
  /** 生成时刻 ISO 串（now ?? new Date()；确定性断言用同参重放） */
  generatedAt: string
  /** lifecycle.jsonl 尾部窗口内的真实事件行数（「尾 500 条」即此窗口上限） */
  events: number
  /** 闭集理由直方图：全闭集在册、缺席理由为 0（逐项与账本行可对账） */
  reasons: Record<LifecycleReason, number>
  /** 救生艇抢出：次数 + 目标 id 列表（只含 id + 时刻） */
  lifeboat: { count: number; targets: AlmanacLifeboatTarget[] }
  /** 接力来源家（relay/*.json 非空 provider 去重） */
  relay: AlmanacRelayStats
  /** archived 滚动窗口现场清点（keep = ARCHIVED_KEEP，窗口口径随 core 走） */
  archived: { cards: number; sidecars: number; keep: number }
  /** 目录级降级附注（fail-open 逐条如实记录；零降级为空数组） */
  notes: string[]
}

/** relay 溯源目录（relayProvenancePath 的父目录同款：<HOME>/relay） */
function relayDirOf(dir?: string): string {
  return join(resolveHome(dir), 'relay')
}

/** 非空 provider 判据：字符串 trim 后非空串（缺席/非字符串/空白一律按「无来源家」） */
function providerOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const v = (data as Record<string, unknown>)['provider']
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 聚合这台机器的真实接力史（纯读取聚合：零 LLM、零子进程、零网络、不写盘）。
 * 四项统计各回各源：①② lifecycle.jsonl（readLifecycleEvents 自带坏行跳过与 fail-open），
 * ③ relay/*.json，④ archived/ 目录清点。目录缺席是诚实零态，不抛不加附注。
 */
export function buildAlmanac(dir?: string, now?: Date): AlmanacStats {
  const notes: string[] = []

  // ── 单源①②：lifecycle.jsonl（闭集直方图 + 救生艇）──
  const events = readLifecycleEvents(dir)
  const reasons = Object.fromEntries(LIFECYCLE_REASONS.map((r) => [r, 0])) as Record<LifecycleReason, number>
  const lifeboatTargets: AlmanacLifeboatTarget[] = []
  for (const e of events) {
    reasons[e.reason]++
    if (e.reason === 'lifeboat') lifeboatTargets.push({ id: e.target, at: e.at })
  }

  // ── 单源③：relay/*.json 的 provider 字段（RelayRecordData 形态，防御式解析）──
  const relay: AlmanacRelayStats = { files: 0, withProvider: 0, providers: [], distinctProviders: 0, unread: 0 }
  const relayHome = relayDirOf(dir)
  if (existsSync(relayHome)) {
    let names: string[] = []
    try {
      names = readdirSync(relayHome).filter((n) => n.endsWith('.json')).sort()
    } catch {
      notes.push('relay/ 目录在场但读取失败（按零份处理）')
    }
    const seen = new Set<string>()
    for (const name of names) {
      relay.files++
      try {
        const data: unknown = JSON.parse(readFileSync(join(relayHome, name), 'utf-8'))
        const provider = providerOf(data)
        if (provider !== '') {
          relay.withProvider++
          seen.add(provider)
        }
      } catch {
        relay.unread++
      }
    }
    relay.providers = [...seen].sort()
    relay.distinctProviders = seen.size
  }

  // ── 单源④：archived/ 现场清点（.md 卡与其余侧车分开数，不验健康——sessiondoctor 的职责）──
  const archived = { cards: 0, sidecars: 0, keep: ARCHIVED_KEEP }
  const archHome = archivedDir(dir)
  if (existsSync(archHome)) {
    try {
      for (const name of readdirSync(archHome)) {
        if (name.endsWith('.md')) archived.cards++
        else archived.sidecars++
      }
    } catch {
      notes.push('archived/ 目录在场但读取失败（按零张处理）')
    }
  }

  return {
    generatedAt: (now ?? new Date()).toISOString(),
    events: events.length,
    reasons,
    lifeboat: { count: lifeboatTargets.length, targets: lifeboatTargets },
    relay,
    archived,
    notes,
  }
}

/** 确定性渲染开关：闭集理由（直方图行序 = 闭集定义序，与聚合时同一出处） */
const CLOSED_REASONS = LIFECYCLE_REASONS

/**
 * 渲染年鉴 markdown（确定性：同输入同输出 byte 级——模板固定、行序固定、
 * 无 Date.now / 无随机 / 无 locale 依赖）。零数据机器出「这条总线还没有故事」
 * 诚实句而非空报表；每个数字带单源出处标注。
 */
export function renderAlmanac(stats: AlmanacStats): string {
  const zeroData = stats.events === 0 && stats.relay.files === 0 && stats.archived.cards === 0
  const out: string[] = []
  out.push('# 接力年鉴 · 这台机器')
  out.push('')
  if (zeroData) {
    out.push('> **这条总线还没有故事**：lifecycle.jsonl 尚无一行事件、relay/ 尚无一份溯源、archived/ 尚无一张归档卡。')
    out.push('> 这是诚实状态不是故障——年鉴不做演示数据。窗口口径照旧：账本尾部 '
      + `${LIFECYCLE_LOG_MAX} 条、archived 滚动 ${ARCHIVED_KEEP} 张；数字随本机排放漂移，以重跑为准。`)
    out.push(`> 生成时刻：${stats.generatedAt}`)
    return appendNotes(out, stats)
  }
  out.push('> 口径：本机 ~/.handoff 总线真实落账的聚合快照，**只计数、不评分**（延续率评分是判死项，不在本页）。')
  out.push('> 可审计：每个数字单源对账——理由直方图与救生艇回指 lifecycle.jsonl 尾部 '
    + `${LIFECYCLE_LOG_MAX} 条窗口内的一行事件；接力来源家回指 relay/*.json 溯源文件的 provider 字段`
    + '（非空值去重）；归档张数为 archived/ 现场清点。')
  out.push('> 数字随本机排放漂移，以重跑为准。')
  out.push(`> 生成时刻：${stats.generatedAt}`)
  out.push('')

  // ── 理由直方图 ──
  out.push(`## 理由直方图（lifecycle.jsonl 尾部 ${LIFECYCLE_LOG_MAX} 条窗口内 ${stats.events} 行）`)
  out.push('')
  out.push('| 理由 | 次数 |')
  out.push('|---|---:|')
  for (const reason of CLOSED_REASONS) {
    const n = stats.reasons[reason] ?? 0
    if (n > 0) out.push(`| ${reason} | ${n} |`)
  }
  out.push('')
  out.push(`闭集共 ${CLOSED_REASONS.length} 个理由，上表只列非零项（闭集定义见 src/lifecycle.ts；每个次数回指窗口内同理由的事件行）。`)
  out.push('')

  // ── 救生艇抢出 ──
  out.push(`## 救生艇抢出（${stats.lifeboat.count} 次）`)
  out.push('')
  if (stats.lifeboat.count === 0) {
    out.push('这台机器还没有救生艇抢出记录（面板一键抢出成功时，这里会有目标 id 列表）。')
  } else {
    for (const t of stats.lifeboat.targets) out.push(`- ${t.id} · ${t.at}`)
    out.push('')
    out.push('列表只含目标卡 id 与事件时刻（出处即各自事件行）；事件 detail 原文留在 lifecycle.jsonl，不进年鉴。')
  }
  out.push('')

  // ── 接力来源家 ──
  out.push(`## 接力来源（${stats.relay.distinctProviders} 家）`)
  out.push('')
  if (stats.relay.files === 0) {
    out.push('relay/ 还没有溯源文件——跨家接力（或本机再接管）发生时，这里会有来源家清单。')
  } else {
    out.push(`- 溯源文件 ${stats.relay.files} 份（relay/*.json）：provider 非空的 ${stats.relay.withProvider} 份，去重后 ${stats.relay.distinctProviders} 家。`)
    if (stats.relay.providers.length > 0) out.push(`- 来源家：${stats.relay.providers.join('、')}`)
    const empty = stats.relay.files - stats.relay.withProvider
    if (empty > 0) out.push(`- provider 为空的 ${empty} 份如实不计入 distinct 口径（口径：只计非空值）。`)
    if (stats.relay.unread > 0) out.push(`- ${stats.relay.unread} 份未能解析（fail-open 跳过，未计入任何计数）。`)
  }
  out.push('')

  // ── 归档窗口 ──
  out.push(`## 归档窗口（archived/ · 滚动 ${stats.archived.keep} 张）`)
  out.push('')
  out.push(`- 当前归档卡 ${stats.archived.cards} 张、随卡侧车 ${stats.archived.sidecars} 份（窗口保留上限 ${stats.archived.keep} 张，只滚 .md 卡、侧车不随之清理）。`)
  return appendNotes(out, stats)
}

/** 降级附注收尾（零降级不产出该节；确定性拼接） */
function appendNotes(out: string[], stats: AlmanacStats): string {
  if (stats.notes.length > 0) {
    out.push('')
    out.push('## 附注（扫描降级，如实记录）')
    out.push('')
    for (const n of stats.notes) out.push(`- ${n}`)
  }
  return `${out.join('\n')}\n`
}
