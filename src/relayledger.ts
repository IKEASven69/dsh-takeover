/**
 * 接力总账（0.26 /ledger）：把 claude→卡→回执→延续/弃置/僵尸 全链翻成一屏账，
 * 让「取件了没下文」的僵尸卡和被静默吞掉的失败当场现形。纯函数聚合器——
 * 只读三源、只装配、只标注，不写盘、不评分、不推断。
 *
 * 读侧两类来源如实分账（既有 import 与本模块新写各占其一，不混淆）：
 * ① readRelayRecords 是**本模块新写的目录扫描读侧**——src/relay-records.ts 只有
 *    写侧/事件读取器（RELAY_RECORD_TYPE / RelayRecordData / relayProvenancePath /
 *    writeRelayProvenance / relayRecordOf / appendRelayRecord），无任何目录扫描
 *    导出（全仓 grep readRelayRecords 零命中，2026-11-20 实测）。本函数 join(
 *    resolveHome(dir),'relay') 扫 *.json，按 RelayRecordData 形态防御式解析，
 *    坏 JSON / 缺目录 / 形态不符 fail-open 跳过不抛；
 * ② 既有 import：lifecycle 侧 readLifecycleEvents（src/lifecycle.ts:94）、卡面侧
 *    core listPendingReport / listArchivedReport（tools.ts:1184 inboxHistory 同款）。
 *
 * 装配与判定口径（全部沿用既有判据，不自创）：
 * - 链走卡面持久通道 extras.supersedes（信封取件即弃，卡面才持久——tools.ts:1184
 *   同款）；父卡存在性按 <id>.md 在 pending/archived 任一盘判（sessiondoctor.ts:338
 *   mdOnDisk 同判据，经 DirCardsReport 的解析成功卡 ∪ 解析失败档文件名基——后者
 *   保证「父卡文件在盘但解析失败」的链不断账，只标空标题棒）；
 * - supersedes 非 SAFE_ID 形态直接按断链标注、不做盘上探测（sessiondoctor.ts:345
 *   防路径穿越同款——不为路径穿越形态的值打开 existsSync 探面）；
 * - 断链/成环容忍不断账只标注；分叉（同一父棒被多棒接替）同样只标注；
 * - 僵尸口径 = scripts/attribution.mjs:45-49 既有判据：relay 有 pickup 记录
 *   （cardId 非空）而 <id>.md 仍在 pending/ → 僵尸在册。lifeboat 目标卡区分标注
 *   （lifecycle reason=lifeboat 的 target 命中）：救生艇抢出的卡生来就在册，其
 *   「取件记录在案而未消费」与普通僵尸成因不同——本机 2026-11-20 唯一真实命中
 *   （一张救生艇抢出卡，id 形态 ho-xxxxxxx-xxxx）正是这类卡，不加区分会把第一屏
 *   变成误读事故。
 *
 * 纪律：
 * - 闭集计数只出原样「X continued / Y abandoned / Z zombie（n=总棒）」——延续率
 *   评分不做（receipt.ts:26 模块头纪律、docs/计划-0.26.md:148「无账本数据前是
 *   编数字」）：输出无百分比、无评分字段、无 rate 键；
 * - 隐私只含 id/标题/provider/时间：不落卡正文、不落 lifecycle detail、不落绝对路径；
 * - 同输入同输出（确定性翻账）：不取当前时刻、全部排序显式确定；
 * - lifecycle 只有尾 LIFECYCLE_LOG_MAX=500 条窗口（src/lifecycle.ts:61），输出自带
 *   窗口标注；relay/ 与 lifecycle.jsonl 是机器本地事实（src/sync.ts SYNC_GITIGNORE
 *   不随同步）→ 总账是单机口径，跨机卡只出卡面事实、不反推别机事件。
 *
 * @module dsh-takeover/relayledger
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SAFE_ID,
  listArchivedReport,
  listPendingReport,
  resolveHome,
  type Card,
  type DirCardsReport,
} from '@agent-handoff/core'
import { LIFECYCLE_LOG_MAX, readLifecycleEvents } from './lifecycle.ts'

// ---------------------------------------------------------------------------
// ① 本模块新写：relay/ 目录扫描读侧（relay-records.ts 只有写侧，无扫描导出）
// ---------------------------------------------------------------------------

/** relay/ 目录扫描文件数上限（防御式：共享目录被灌爆时不放大读；正常部署远低于此） */
export const RELAY_SCAN_MAX = 2000

/** relay/<sessionId>.json 的防御式读取形态（writeRelayProvenance 落盘的 { sessionId, ...RelayRecordData }；缺的字段给空串） */
export interface RelayLedgerRecord {
  /** 会话 id（落盘顶层字段） */
  sessionId: string
  /** 来源外部 agent 家（takeover / take_deposit；pickup 取件记录通常为空） */
  provider: string
  /** 来源外部会话 id */
  sourceId: string
  /** 消费的交接卡 id（非空 = 取件记录——attribution.mjs:74 同口径） */
  cardId: string
  /** 接管目标标题（与接管会话标题一致） */
  title: string
  /** 记录时刻 ISO 串（RelayRecordData 唯一必填字段；缺失/非串 = 形态不符，整文件跳过） */
  at: string
  /** 来源文件名基（不带扩展名；不落绝对路径） */
  file: string
}

/** ① 目录扫描读侧：扫 <home>/relay/*.json 按 RelayRecordData 形态防御式解析。
 * fail-open：缺目录回空、单文件坏 JSON / 数组 / null / 缺 at 跳过不抛。
 * 输出按（at, file）字典序——同输入同输出（readdirSync 顺序跨平台不稳）。 */
export function readRelayRecords(dir?: string): RelayLedgerRecord[] {
  try {
    const relayDir = join(resolveHome(dir), 'relay')
    if (existsSync(relayDir) !== true) return []
    const names = readdirSync(relayDir).filter((f) => f.endsWith('.json')).slice(0, RELAY_SCAN_MAX)
    const out: RelayLedgerRecord[] = []
    for (const name of names) {
      try {
        const o = JSON.parse(readFileSync(join(relayDir, name), 'utf-8')) as unknown
        if (o === null || typeof o !== 'object' || Array.isArray(o)) continue
        const m = o as Record<string, unknown>
        const at = m['at']
        if (typeof at !== 'string' || at === '') continue
        const s = (k: string): string => (typeof m[k] === 'string' ? (m[k] as string) : '')
        out.push({
          sessionId: s('sessionId'),
          provider: s('provider'),
          sourceId: s('sourceId'),
          cardId: s('cardId'),
          title: s('title'),
          at,
          file: name.slice(0, -'.json'.length),
        })
      } catch { /* 单文件坏 JSON：跳过不抛 */ }
    }
    return out.sort((a, b) => {
      const byAt = a.at.localeCompare(b.at)
      return byAt !== 0 ? byAt : a.file.localeCompare(b.file)
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// ② 链装配（卡面持久通道 extras.supersedes；inboxHistory/sessiondoctor 同口径）
// ---------------------------------------------------------------------------

/** 链上一棒 */
export interface ChainStep {
  id: string
  /** 卡面标题（解析失败档骨架给空串——诚实缺省，不编） */
  title: string
  /** 推送时刻（解析失败档骨架给空串，排序时排最前） */
  pushedAt: string
  /** 这棒现在哪盘 */
  where: 'pending' | 'archived'
  /** 本棒是延续回执卡：指向的源卡 id（extras.receipt.for，tools.ts:1196 同口径） */
  receiptFor?: string
  /** 本棒接替的前置棒 id（extras.supersedes；合法在盘链接才出场） */
  supersedes?: string
  /** 断链标注：supersedes 指向的目标在册不存在（或 id 形态非法）——账不断，只标注 */
  brokenTo?: string
}

/** 一条链 = 一个连通分量（≥1 条边才成链；无链棒不占链屏，只进 counts.chainless） */
export interface RelayChain {
  /** 时间正序（pushed_at 字典序同 inboxHistory：同机卡共享时区口径） */
  steps: ChainStep[]
  /** 成环标注：环不拆、账不断 */
  cycle: boolean
  /** 环上的棒 id（cycle 时在场，字典序） */
  cycleIds: string[]
  /** 分叉标注：被多棒接替的父棒 id（字典序） */
  forks: string[]
}

/** 抽卡面 supersedes（sessiondoctor.ts:152 同口径：非空字符串才算，trim） */
function faceSupersedesOf(card: Card): string | undefined {
  const sup = (card.extras as Record<string, unknown> | undefined)?.['supersedes']
  return typeof sup === 'string' && sup.trim() !== '' ? sup.trim() : undefined
}

/** 抽卡面回执指向（tools.ts:1196 同口径：extras.receipt.for 非空字符串） */
function faceReceiptForOf(card: Card): string | undefined {
  const receipt = (card.extras as Record<string, unknown> | undefined)?.['receipt'] as { for?: unknown } | undefined
  const forId = receipt?.['for']
  return typeof forId === 'string' && forId !== '' ? forId : undefined
}

/** 盘上可寻址 id 集（mdOnDisk 同判据经报告面：解析成功卡 id ∪ 解析失败档 .md 文件名基——
 * 仅 SAFE_ID 形态；非形态基名不可能被 supersedes 指向为在册卡） */
export function onDiskIdsOf(pending: DirCardsReport, archived: DirCardsReport): Set<string> {
  const out = new Set<string>()
  for (const c of pending.cards) out.add(c.id)
  for (const c of archived.cards) out.add(c.id)
  for (const s of [...pending.skipped, ...archived.skipped]) {
    if (s.file.endsWith('.md') !== true) continue
    const base = s.file.slice(0, -3)
    if (SAFE_ID.test(base) === true) out.add(base)
  }
  return out
}

/** 装配链：pending/archived 两份卡面报告 → 连通分量链（线性/断链/成环/分叉，账不断只标注）。
 * 纯函数：不探盘，父卡存在性按 <id>.md 在两盘报告任一在场判（mdOnDisk 同判据）。 */
export function assembleChains(pending: DirCardsReport, archived: DirCardsReport): RelayChain[] {
  // ① 节点集：解析成功卡带全卡面；解析失败档只带文件名基（骨架棒，标题/时刻诚实空串）。
  //    同 id 两盘冲突按 pending 优先（活动副本）
  const nodes = new Map<string, { title: string; pushedAt: string; where: 'pending' | 'archived'; receiptFor?: string; supRaw?: string }>()
  const putCards = (cards: Card[], where: 'pending' | 'archived'): void => {
    for (const c of cards) {
      if (nodes.has(c.id)) continue
      nodes.set(c.id, {
        title: c.from.title,
        pushedAt: c.pushed_at,
        where,
        ...(faceReceiptForOf(c) !== undefined ? { receiptFor: faceReceiptForOf(c) } : {}),
        ...(faceSupersedesOf(c) !== undefined ? { supRaw: faceSupersedesOf(c) } : {}),
      })
    }
  }
  const putSkipped = (skipped: DirCardsReport['skipped'], where: 'pending' | 'archived'): void => {
    for (const s of skipped) {
      if (s.file.endsWith('.md') !== true) continue
      const base = s.file.slice(0, -3)
      if (SAFE_ID.test(base) !== true || nodes.has(base)) continue
      nodes.set(base, { title: '', pushedAt: '', where })
    }
  }
  putCards(pending.cards, 'pending')
  putCards(archived.cards, 'archived')
  putSkipped(pending.skipped, 'pending')
  putSkipped(archived.skipped, 'archived')

  // ② 边集：只认合法在盘链接（SAFE_ID 形态且盘上在场）；其余一律 brokenTo 标注，
  //    非 SAFE_ID 形态不做盘上探测（防路径穿越探面，sessiondoctor.ts:345 同款）
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  const brokenOf = new Map<string, string>()
  for (const id of [...nodes.keys()].sort()) {
    const raw = nodes.get(id)?.supRaw
    if (raw === undefined) continue
    if (SAFE_ID.test(raw) !== true || nodes.has(raw) !== true) {
      brokenOf.set(id, raw)
      continue
    }
    parentOf.set(id, raw)
    const kids = childrenOf.get(raw)
    if (kids === undefined) childrenOf.set(raw, [id])
    else kids.push(id)
  }

  // ③ 成环检测（函数图：每棒至多一个父棒，环必为简单环）
  const cycleIds = new Set<string>()
  const state = new Map<string, 1 | 2>()
  for (const id of [...nodes.keys()].sort()) {
    if (state.has(id)) continue
    const path: string[] = []
    const onPath = new Set<string>()
    let cur: string | undefined = id
    while (cur !== undefined && state.has(cur) !== true) {
      state.set(cur, 1)
      path.push(cur)
      onPath.add(cur)
      cur = parentOf.get(cur)
    }
    if (cur !== undefined && state.get(cur) === 1 && onPath.has(cur)) {
      for (const c of path.slice(path.indexOf(cur))) cycleIds.add(c)
    }
    for (const p of path) state.set(p, 2)
  }

  // ④ 连通分量装配：根（无合法父棒）或环为起点，只装 ≥1 条边的分量
  const visited = new Set<string>()
  const chains: RelayChain[] = []
  const assemble = (start: string, isCycle: boolean): void => {
    const members = new Set<string>()
    const stack = [start]
    while (stack.length > 0) {
      const cur = stack.pop() as string
      if (members.has(cur)) continue
      members.add(cur)
      visited.add(cur)
      for (const ch of childrenOf.get(cur) ?? []) stack.push(ch)
    }
    const forks = [...members].filter((id) => (childrenOf.get(id)?.length ?? 0) > 1).sort()
    const cycHere = isCycle ? [...members].filter((id) => cycleIds.has(id)).sort() : []
    const steps = [...members]
      .map((id): ChainStep => {
        const n = nodes.get(id) as { title: string; pushedAt: string; where: 'pending' | 'archived'; receiptFor?: string }
        const sup = parentOf.get(id)
        const broken = brokenOf.get(id)
        return {
          id,
          title: n.title,
          pushedAt: n.pushedAt,
          where: n.where,
          ...(n.receiptFor !== undefined ? { receiptFor: n.receiptFor } : {}),
          ...(sup !== undefined ? { supersedes: sup } : {}),
          ...(broken !== undefined ? { brokenTo: broken } : {}),
        }
      })
      .sort((a, b) => {
        const byAt = a.pushedAt.localeCompare(b.pushedAt)
        return byAt !== 0 ? byAt : a.id.localeCompare(b.id)
      })
    chains.push({ steps, cycle: isCycle, cycleIds: cycHere, forks })
  }
  for (const id of [...nodes.keys()].sort()) {
    if (visited.has(id)) continue
    if (parentOf.has(id)) continue // 非根非环：由上游起点装配覆盖
    if ((childrenOf.get(id)?.length ?? 0) === 0 && brokenOf.has(id) === false) continue // 无链棒：不占链屏
    assemble(id, false)
  }
  for (const id of [...cycleIds].sort()) {
    if (visited.has(id)) continue
    assemble(id, true)
  }
  return chains.sort((a, b) => {
    const fa = a.steps[0]
    const fb = b.steps[0]
    if (fa === undefined || fb === undefined) return 0
    const byAt = fa.pushedAt.localeCompare(fb.pushedAt)
    return byAt !== 0 ? byAt : fa.id.localeCompare(fb.id)
  })
}

// ---------------------------------------------------------------------------
// ③ 僵尸判定（scripts/attribution.mjs:45-49 口径 + lifeboat 目标卡区分）
// ---------------------------------------------------------------------------

/** 僵尸在册单条 */
export interface ZombieEntry {
  id: string
  /** 取件记录时刻（同卡多条记录取最早一条） */
  at: string
  /** 卡面标题（聚合时回填；独立判定给空串——诚实缺省） */
  title: string
  /** 救生艇抢出目标卡（lifecycle reason=lifeboat 的 target 命中）：生来在册，
   * 成因与普通僵尸不同，渲染必须区分——本机唯一真实命中即救生艇抢出卡 */
  lifeboat: boolean
}

/** 纯函数核心（judgeZombies 的可测芯）：relay pickup 记录（cardId 非空）× <id>.md 仍在 pending。
 * 非 SAFE_ID 形态的 cardId 不判不探（不可能成为在册卡，也不为它开 existsSync 探面）；
 * 同卡多条取件记录只记一条、取最早时刻（顺序无关——不依赖调用方预排序）；
 * pendingOnDisk 由调用方给（聚合面传 existsSync 壳，测试面传集合壳）。 */
export function zombiesOf(
  relay: readonly RelayLedgerRecord[],
  pendingOnDisk: (id: string) => boolean,
  lifeboatTargets: ReadonlySet<string>,
): ZombieEntry[] {
  const byCard = new Map<string, ZombieEntry>()
  for (const r of relay) {
    if (r.cardId === '') continue // 非取件记录（takeover / take_deposit）
    if (SAFE_ID.test(r.cardId) !== true) continue
    if (pendingOnDisk(r.cardId) !== true) continue
    const prior = byCard.get(r.cardId)
    if (prior !== undefined) {
      if (r.at.localeCompare(prior.at) < 0) prior.at = r.at
      continue
    }
    byCard.set(r.cardId, { id: r.cardId, at: r.at, title: '', lifeboat: lifeboatTargets.has(r.cardId) })
  }
  return [...byCard.values()].sort((a, b) => {
    const byAt = a.at.localeCompare(b.at)
    return byAt !== 0 ? byAt : a.id.localeCompare(b.id)
  })
}

/** lifeboat 目标集：lifecycle 里 reason=lifeboat 且 target 非空的事件 target */
function lifeboatTargetsOf(dir?: string): Set<string> {
  return new Set(readLifecycleEvents(dir).filter((e) => e.reason === 'lifeboat' && e.target !== '').map((e) => e.target))
}

/** judgeZombies(dir)：IO 壳——relay 扫描 + pending 盘上探测 + lifeboat 目标集。
 * fail-open：任何异常回空账，不抛。 */
export function judgeZombies(dir?: string): ZombieEntry[] {
  try {
    const relay = readRelayRecords(dir)
    const pendingDirPath = join(resolveHome(dir), 'pending')
    return zombiesOf(relay, (id) => existsSync(join(pendingDirPath, `${id}.md`)), lifeboatTargetsOf(dir))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// ④ 三源 join 聚合：relay × lifecycle × 卡面 → { chains, zombies, counts }
// ---------------------------------------------------------------------------

/** 闭集计数（原样，0.26 不评分：无延续率/无评分/无 rate 键） */
export interface LedgerCounts {
  /** lifecycle continued 事件条数（原样） */
  continued: number
  /** lifecycle abandoned 事件条数（原样） */
  abandoned: number
  /** 僵尸在册命中数（attribution.mjs 口径，含救生艇抢出卡） */
  zombie: number
  /** 其中救生艇抢出目标卡（成因不同，渲染须区分） */
  zombieLifeboat: number
  /** 无链棒：从未接棒也不被接棒的孤立在册卡（不占链屏，只计数） */
  chainless: number
  /** n=总棒：pending ∪ archived 盘上 SAFE_ID 形态卡数（解析成功 ∪ 解析失败档） */
  batons: number
}

/** 窗口与口径标注（LIFECYCLE_LOG_MAX 窗口外历史不可见；单机口径） */
export interface LedgerWindow {
  /** 读到的 lifecycle 事件条数 */
  lifecycleEvents: number
  /** lifecycle 尾部窗口上限（src/lifecycle.ts:61） */
  lifecycleCap: number
  /** relay 记录总数（含无 cardId 的 takeover / take_deposit） */
  relayRecords: number
  /** 其中取件记录（cardId 非空） */
  relayPickups: number
  /** 确定性拼装的说明（不含当前时刻） */
  note: string
}

/** 三源 join 对不齐的如实单列（不硬归账） */
export interface UnjoinedRow {
  kind: 'relay_pickup_no_card' | 'lifecycle_no_card'
  /** relay cardId 或 lifecycle target */
  id: string
  at: string
  detail: string
}

/** 总账聚合输出 */
export interface RelayLedger {
  chains: RelayChain[]
  zombies: ZombieEntry[]
  counts: LedgerCounts
  unjoined: UnjoinedRow[]
  window: LedgerWindow
}

/** 三源 join 聚合：relay 扫描（①）× lifecycle（②既有）× 卡面（③既有 core）。
 * 绝不抛：底层读取器全部 fail-open，此处再兜绝对意外——异常时如实缺省不编数字。 */
export function aggregateLedger(dir?: string): RelayLedger {
  try {
    const relay = readRelayRecords(dir)
    const lifecycle = readLifecycleEvents(dir)
    const pending = listPendingReport(dir)
    const archived = listArchivedReport(dir)
    const onDisk = onDiskIdsOf(pending, archived)
    const chains = assembleChains(pending, archived)

    // 僵尸：pending 盘上探测（SAFE_ID 把关在 zombiesOf 内，非 SAFE 值不开 existsSync 探面）
    const pendingDirPath = join(resolveHome(dir), 'pending')
    const zombies = zombiesOf(relay, (id) => existsSync(join(pendingDirPath, `${id}.md`)), lifeboatTargetsOf(dir))
      .map((z) => ({ ...z, title: pending.cards.find((c) => c.id === z.id)?.from.title ?? '' }))

    // 闭集计数（原样）：continued/abandoned 取事件条数；n=总棒
    const covered = chains.reduce((sum, c) => sum + c.steps.length, 0)
    const counts: LedgerCounts = {
      continued: lifecycle.filter((e) => e.reason === 'continued').length,
      abandoned: lifecycle.filter((e) => e.reason === 'abandoned').length,
      zombie: zombies.length,
      zombieLifeboat: zombies.filter((z) => z.lifeboat).length,
      chainless: Math.max(0, onDisk.size - covered),
      batons: onDisk.size,
    }

    // 三源 join 对不齐如实单列（同卡多份取件记录只列一次——最早一条）
    const unjoined: UnjoinedRow[] = []
    const seenPickup = new Set<string>()
    for (const r of relay) {
      if (r.cardId === '' || seenPickup.has(r.cardId) || onDisk.has(r.cardId)) continue
      seenPickup.add(r.cardId)
      unjoined.push({
        kind: 'relay_pickup_no_card',
        id: r.cardId,
        at: r.at,
        detail: SAFE_ID.test(r.cardId) !== true
          ? '取件记录 cardId 形态非法（SAFE_ID 形态才可能成为在册卡）——如实单列不硬归'
          : '取件记录指向在册不存在的卡（已消费后被滚动清理，或从未落盘）——如实单列不硬归',
      })
    }
    for (const e of lifecycle) {
      if ((e.reason !== 'continued' && e.reason !== 'abandoned') || e.target === '' || onDisk.has(e.target)) continue
      unjoined.push({ kind: 'lifecycle_no_card', id: e.target, at: e.at, detail: `账本端点（${e.reason}）指向在册不存在的卡——如实单列不硬归` })
    }
    unjoined.sort((a, b) => {
      const byAt = a.at.localeCompare(b.at)
      return byAt !== 0 ? byAt : `${a.kind}/${a.id}`.localeCompare(`${b.kind}/${b.id}`)
    })

    const relayPickups = relay.filter((r) => r.cardId !== '').length
    const note = lifecycle.length >= LIFECYCLE_LOG_MAX
      ? `lifecycle 已达尾 ${LIFECYCLE_LOG_MAX} 条窗口上限，更早历史不可见；relay/lifecycle 为本机事实不随同步（SYNC_GITIGNORE），总账是单机口径`
      : `lifecycle 窗口内 ${lifecycle.length} 条（尾 ${LIFECYCLE_LOG_MAX} 封顶）；relay/lifecycle 为本机事实不随同步（SYNC_GITIGNORE），总账是单机口径`
    return {
      chains,
      zombies,
      counts,
      unjoined,
      window: {
        lifecycleEvents: lifecycle.length,
        lifecycleCap: LIFECYCLE_LOG_MAX,
        relayRecords: relay.length,
        relayPickups,
        note,
      },
    }
  } catch (e) {
    // 绝对意外兜底：如实缺省不编数字（绝不拖垮调用方）
    return {
      chains: [],
      zombies: [],
      counts: { continued: 0, abandoned: 0, zombie: 0, zombieLifeboat: 0, chainless: 0, batons: 0 },
      unjoined: [],
      window: {
        lifecycleEvents: 0,
        lifecycleCap: LIFECYCLE_LOG_MAX,
        relayRecords: 0,
        relayPickups: 0,
        note: `总账聚合失败：${e instanceof Error ? e.message : String(e)}——如实缺省，不编数字`,
      },
    }
  }
}
