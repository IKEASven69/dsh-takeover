#!/usr/bin/env node
/**
 * 0.4.1 归因版 · 失败归因管线（死亡地图）。
 *
 * 问题：接力失败不是单一事件——卡可能死在写侧闸、读侧跳过、取侧核验，
 * 也可能被消费了但工作没延续（execution-death）。此前这些死法散在各处，
 * 没有一张统一的地图回答「卡都死在哪」。
 *
 * 数据源（三路合并，全部当场可复核）：
 *  1. lifecycle.jsonl —— 写侧/取侧拒收事件（0.4.1 事件层）；
 *  2. relay/*.json —— 接力记录（取件/接管发生过的证据）；
 *  3. archived/ 回测行 —— 消费后的延续证据（复用 backtest-archived 的导出函数）。
 *
 * 闭集死亡分类（每张卡恰好一个结局）：
 *   write_rejected   写侧闸拒收，从未落盘
 *   read_skipped     在册但读侧跳过（坏卡），永远不会被消费
 *   consumed         已消费；其中延续证据分 survived / died_at_execution
 *   unmeasurable     消费了但 cwd 缺失/非 git——无法归因，如实计数
 *   in_inbox         还躺在 pending 里（未到结局）
 *
 * 隐私纪律：输出只有聚合计数与 id/文件 basename，不落卡正文。
 * 用法：node scripts/attribution.mjs [--home <dir>] [--out <file>]
 * @module dsh-takeover/attribution
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { sectionOf, extractPaths, frontmatterValue, continuationEvidence, markedRatioOf } from './backtest-archived.mjs'
import { readLifecycleEvents, reasonFromCoreSkip } from '../src/lifecycle.ts'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const HOME = arg('home', join(homedir(), '.handoff'))
const OUT = arg('out', join(process.cwd(), 'test-artifacts', 'attribution-report.json'))

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf-8')) } catch { return null } }

/** 单卡归因（纯函数核心，导出供单测）：rows 输入 = 三路数据的每卡切片 */
export function attributeCard(input) {
  const { id, inPending, lifecycleEvents, relayPickups, backtest } = input
  if (inPending) {
    // 在册 ≠ 死亡：只有带读侧事件的才是 read_skipped，其余只是还没人取
    const readEv = lifecycleEvents.find((e) => e.stage === 'read' && e.target === `${id}.md`)
    return readEv
      ? { outcome: 'read_skipped', reason: readEv.reason, stage: 'read' }
      : { outcome: 'in_inbox', reason: 'no-pickup-record', stage: null }
  }
  const writeEv = lifecycleEvents.find((e) => e.stage === 'write' && (e.target === id))
  if (writeEv && !relayPickups.includes(id)) return { outcome: 'write_rejected', reason: writeEv.reason, stage: 'write' }
  const pickup = relayPickups.includes(id) || backtest?.consumed === true
  if (!pickup) return { outcome: 'in_inbox', reason: 'no-pickup-record', stage: null }
  if (backtest?.measurable !== true) return { outcome: 'unmeasurable', reason: backtest?.reason ?? 'no-backtest', stage: 'pickup' }
  return backtest.continued
    ? { outcome: 'survived', reason: 'continued-in-git', stage: 'pickup' }
    : { outcome: 'died_at_execution', reason: 'consumed-no-git-continuation', stage: 'pickup' }
}

// ---------- 主流程 ----------
const report = { generatedAt: new Date().toISOString(), home: HOME, sources: {}, map: {}, cards: [] }
const t0 = Date.now()

// 源 1：生命周期事件
const lifecycle = readLifecycleEvents(HOME)
report.sources.lifecycleEvents = lifecycle.length
const writeRejects = lifecycle.filter((e) => e.stage === 'write')

// 源 2：relay 接力记录（cardId 非空 = 指到具体卡的取件）
const relayDir = join(HOME, 'relay')
const relayPickups = []
if (existsSync(relayDir)) {
  for (const f of readdirSync(relayDir)) {
    if (!f.endsWith('.json')) continue
    const r = readJson(join(relayDir, f))
    if (r && typeof r.cardId === 'string' && r.cardId !== '') relayPickups.push(r.cardId)
  }
}
report.sources.relayRecords = relayPickups.length

// 源 3：archived 回测（消费卡的延续证据）
const archivedDir = join(HOME, 'archived')
const pendingDir = join(HOME, 'pending')
const archivedFiles = existsSync(archivedDir) ? readdirSync(archivedDir).filter((f) => f.endsWith('.md')) : []
const pendingFiles = existsSync(pendingDir) ? readdirSync(pendingDir).filter((f) => f.endsWith('.md')) : []
report.sources.archivedCards = archivedFiles.length
report.sources.pendingCards = pendingFiles.length

// 读侧活性跳过（与 state 同口径：live 视图）
const liveSkipped = []
for (const f of pendingFiles) {
  const p = join(pendingDir, f)
  try {
    if (requireSizeOver(p)) liveSkipped.push({ file: f, reason: reasonFromCoreSkip('字节上限') })
  } catch { /* stat 失败不计 */ }
}
function requireSizeOver(p) {
  return require('node:fs').statSync(p).size > 8 * 1024 * 1024
}

// 逐卡归因：archived（消费侧）∪ pending（在册）∪ 写侧拒收记录里的 target
const outcomes = {}
const bump = (k) => { outcomes[k] = (outcomes[k] ?? 0) + 1 }
for (const f of archivedFiles) {
  const id = f.slice(0, -3)
  const text = (() => { try { return readFileSync(join(archivedDir, f), 'utf-8') } catch { return '' } })()
  const cwd = frontmatterValue(text, 'cwd')
  const pushedAt = frontmatterValue(text, 'pushed_at')
  const files = extractPaths(sectionOf(text, ['涉及文件']))
  const repoExists = cwd !== '' && existsSync(cwd)
  const ev = repoExists ? continuationEvidence({ cwd, sinceIso: pushedAt, cardFiles: files }) : { measurable: false, reason: 'cwd-missing' }
  const a = attributeCard({ id, inPending: false, lifecycleEvents: lifecycle, relayPickups, backtest: { consumed: true, measurable: ev.measurable, continued: ev.continued, reason: ev.reason } })
  bump(a.outcome)
  report.cards.push({ id, outcome: a.outcome, reason: a.reason, coverage: markedRatioOf(text) })
}
for (const f of pendingFiles) {
  const id = f.slice(0, -3)
  const a = attributeCard({ id, inPending: true, lifecycleEvents: lifecycle, relayPickups, backtest: null })
  bump(a.outcome)
  report.cards.push({ id, outcome: a.outcome, reason: a.reason })
}
for (const e of writeRejects) {
  // 写侧拒收没有卡 id（从未落盘）——target 即标题，按事件计数
  bump('write_rejected')
  report.cards.push({ id: e.target, outcome: 'write_rejected', reason: e.reason, at: e.at })
}
for (const sk of liveSkipped) {
  bump('read_skipped')
  report.cards.push({ id: basename(sk.file, '.md'), outcome: 'read_skipped', reason: sk.reason })
}

report.map = outcomes
report.map.write_rejected = outcomes.write_rejected ?? 0
const measurable = (outcomes.survived ?? 0) + (outcomes.died_at_execution ?? 0)
report.continuationRate = measurable > 0 ? Number((outcomes.survived / measurable).toFixed(4)) : null
report.measurableTotal = measurable
report.elapsedMs = Date.now() - t0

mkdirSync(join(OUT, '..'), { recursive: true })
writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf-8')
console.log(`死亡地图 → ${OUT}`)
console.log(`  写侧拒收 ${report.map.write_rejected} | 读侧跳过 ${report.map.read_skipped ?? 0} | 存活 ${outcomes.survived ?? 0} | 执行死亡 ${outcomes.died_at_execution ?? 0} | 不可归因 ${outcomes.unmeasurable ?? 0} | 在册 ${outcomes.in_inbox ?? 0}`)
console.log(`  可测延续率：${report.continuationRate ?? 'n/a'}（n=${measurable}）`)
