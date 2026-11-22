/**
 * 延续回执卡（0.26 特色功能）：取件即回执——源卡被取件（pending→archived）时程序化
 * 产出一张回执卡挂上接力链（args.supersedes=源卡 id，父卡 remaining 继承
 * inheritParentRemaining 自动获得），并把「这张卡到底有没有被延续」落进 lifecycle
 * 账本（continued / abandoned，闭集见 src/lifecycle.ts）。
 *
 * 回执卡 `extras.receipt = { for, picked_at, picked_by, first_step, evidence[{claim,state}] }`；
 * evidence 由取件时 verifyGit 已产出的四态直接落账（inboxLoad 现成在手，零新核验面）：
 * mismatches → `MISMATCH`、unavailable → `UNAVAILABLE`、核验一致 → `CURRENT_OBSERVED`，
 * 源卡 extras.flight 里 claim_cmd 登记的命令声称 → `unverified`（0.26 无执行面）。
 * 四态闭集定义在 flightcheck.ts（登记与回执 evidence 共用）。
 *
 * 纪律：
 * - **fail-open 硬纪律**：回执生成挂在取件热路径——本模块任何失败只返回 { ok:false }
 *   与错误说明，绝不 throw、绝不拦取件主流程（对照 tools.ts 通知面同款降级纪律）；
 *   回执卡寄存被密钥闸/空壳闸拒收同样是 fail-open（源卡已取件的事实不受影响）。
 * - 回执本身是新卡，照走消费即弃 + pushHandoff 全套纪律（密钥闸/覆盖率/信封/补丁）——
 *   下游取件回执卡即完成账本闭环，无需产出二次回执。
 * - 回执未落地（被拒/失败）时**不记 continued 也不记 abandoned**：账本如实缺省——
 *   「取件了但回执没成」是 continued/abandoned 二态之外的第三种真实状态，0.26 不编造。
 * - 0.26 只建数据面：候选 C（延续率评分）明确不做——无账本数据前是编数字。
 * - 对外措辞红线：只写「对手工交接卡面做机器体检并回执追踪延续」，
 *   不写「首个交接验证工具」（agent-receipt / handoff-receipts / RBP / Oracle-gate
 *   已占验证语义）。
 *
 * 集成面接线立约（本模块不改 tools.ts；挂点 docs/计划-0.26.md §5.2）：
 * ```
 * // inboxLoad 内 loadCard 完成 pending→archived 搬移之后（fail-open）：
 * const receipt = generateReceiptCard({
 *   sourceId: card.id,
 *   verify: { mismatches: check.mismatches, unavailable: check.unavailable,
 *             branch: card.git.branch, changedCount: card.git.changed.length },
 *   source: { stopped: card.sections.stopped, flight: card.extras?.flight },
 *   cwd: card.cwd,
 * })
 * // 结果只进 note/日志，不进取件返回值的成败判定
 * ```
 * dismiss 侧（settings/server 面）落账 abandoned：
 * `recordLifecycleEvent({ stage: 'pickup', reason: 'abandoned', target: <卡id>, detail: 'dismiss 未取件' })`
 *
 * @module dsh-takeover/receipt
 */
import { hostname } from 'node:os'
import { assertSafeId, type CardSections } from '@agent-handoff/core'
import { pushHandoff, type CardAxis, type CardPayload, type PushResult } from './tools.ts'
import { recordLifecycleEvent } from './lifecycle.ts'
import { claimsFromFlight, sanitizeLine, type ClaimState } from './flightcheck.ts'

/** 单条 evidence claim 截断上限（verifyGit mismatch 串可能携带长文件清单） */
export const RECEIPT_CLAIM_MAX = 200
/** evidence 总条数封顶（verify 条目优先、claims 兜底装；超出部分仍在源卡卡面可查） */
export const RECEIPT_EVIDENCE_MAX = 20
/** first_step 截断上限 */
export const RECEIPT_FIRST_STEP_MAX = 300

/** evidence 四态 = flightcheck 登记四态闭集（re-export 保持单一出处） */
export type EvidenceState = ClaimState

/** 单条延续证据（extras.receipt.evidence 的条目形态） */
export interface ReceiptEvidence {
  /** 证据陈述（净化单行 + 截断；done 段逐条带四态标注回显） */
  claim: string
  state: EvidenceState
}

/** 回执卡 extras.receipt 契约（字段只此五件） */
export interface ReceiptExtras {
  /** 源卡 id（SAFE_ID 形态，接力链 supersedes 同值） */
  for: string
  /** 取件时刻（ISO8601，与 lifecycle at 同款 toISOString 口径） */
  picked_at: string
  /** 取件方标识（缺省本机 hostname） */
  picked_by: string
  /** 源卡 stopped 段「最安全的第一步」摘录（无标注取首行，空段如实缺省） */
  first_step: string
  /** 四态证据（verifyGit 三态映射 + claim_cmd 登记的 unverified 条目） */
  evidence: ReceiptEvidence[]
}

/** 取件核验事实（inboxLoad 里 verifyGit 的产出 + 源卡 git 快照概要，照传即可） */
export interface VerifyFacts {
  /** git 核验冲突（MISMATCH 原文串） */
  mismatches?: string[]
  /** 无法核验说明（UNAVAILABLE 原文） */
  unavailable?: string
  /** 源卡记录的分支（CURRENT_OBSERVED 陈述用） */
  branch?: string
  /** 源卡记录的 dirty 文件数（CURRENT_OBSERVED 陈述用） */
  changedCount?: number
}

export interface ReceiptExtrasInput {
  /** 源卡 id（非法形态抛中文错——与 core 入口闸同款；generateReceiptCard 先拦成 ok:false） */
  sourceId: string
  pickedAt?: Date
  pickedBy?: string
  verify?: VerifyFacts
  /** 源卡 stopped 段（first_step 提取） */
  stopped?: string
  /** 源卡 extras.flight（claim_cmd 登记 → unverified 条目；坏数据防御式忽略） */
  flight?: unknown
}

/**
 * first_step 提取：stopped 段「最安全的第一步：…」标注优先（跨行取首个命中、
 * 单行截断）；无标注取首个非空行；空段返回空串（如实缺省）。
 */
export function firstStepOf(stopped: string): string {
  const text = typeof stopped === 'string' ? stopped : ''
  if (text.trim() === '') return ''
  for (const raw of text.split(/\r?\n/)) {
    const m = /最安全的第一步\s*[：:]\s*(.+)/.exec(raw)
    const hit = m?.[1]?.trim()
    if (hit !== undefined && hit !== '') return sanitizeLine(hit, RECEIPT_FIRST_STEP_MAX)
  }
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '')
  return firstLine !== undefined ? sanitizeLine(firstLine, RECEIPT_FIRST_STEP_MAX) : ''
}

/**
 * verifyGit 产出 → 四态 evidence（确定性映射，零新核验面）：
 * mismatches 逐条 MISMATCH → unavailable 一条 UNAVAILABLE → 都没有 = 核验一致，
 * 一条 CURRENT_OBSERVED（分支/dirty 数随源卡快照如实陈述，缺了不编）。
 */
export function evidenceFromVerify(facts: VerifyFacts): ReceiptEvidence[] {
  const mismatches = Array.isArray(facts.mismatches) ? facts.mismatches.filter((m) => typeof m === 'string' && m.trim() !== '') : []
  if (mismatches.length > 0) {
    // 溢出摘要计入封顶预算（「≤上限」按字面兑现，不让汇总条突破常量）
    const cap = mismatches.length > RECEIPT_EVIDENCE_MAX ? RECEIPT_EVIDENCE_MAX - 1 : RECEIPT_EVIDENCE_MAX
    const out: ReceiptEvidence[] = mismatches.slice(0, cap).map((m) => ({ claim: sanitizeLine(m, RECEIPT_CLAIM_MAX), state: 'MISMATCH' as const }))
    if (mismatches.length > cap) {
      out.push({ claim: `另有 ${mismatches.length - cap} 处核验冲突未逐条落账（上限 ${RECEIPT_EVIDENCE_MAX} 条）`, state: 'MISMATCH' })
    }
    return out
  }
  if (typeof facts.unavailable === 'string' && facts.unavailable.trim() !== '') {
    return [{ claim: sanitizeLine(facts.unavailable, RECEIPT_CLAIM_MAX), state: 'UNAVAILABLE' }]
  }
  const branch = sanitizeLine(facts.branch, 120)
  const n = typeof facts.changedCount === 'number' && Number.isInteger(facts.changedCount) && facts.changedCount >= 0
    ? facts.changedCount
    : null
  return [{
    claim: `git 核验一致：分支「${branch !== '' ? branch : '（空）'}」dirty ${n === null ? '?' : n} 处与卡面快照一致（取件时观察）`,
    state: 'CURRENT_OBSERVED',
  }]
}

/** 回执 extras 构建（纯函数；sourceId 非法抛中文错，generateReceiptCard 已先拦） */
export function buildReceiptExtras(input: ReceiptExtrasInput): ReceiptExtras {
  assertSafeId(input.sourceId)
  const verifyItems = evidenceFromVerify(input.verify ?? {})
  const claimItems = claimsFromFlight(input.flight).map((c) => ({
    claim: `命令声称（源卡 ${c.section} 段，登记未验）：${c.claim}`,
    state: 'unverified' as const,
  }))
  return {
    for: input.sourceId,
    picked_at: (input.pickedAt ?? new Date()).toISOString(),
    picked_by: sanitizeLine(input.pickedBy ?? hostname(), 100) || 'unknown',
    first_step: firstStepOf(input.stopped ?? ''),
    // verify 条目优先落账，claims 装余量——放不下的声称仍在源卡 extras.flight 持久可查
    evidence: [...verifyItems, ...claimItems].slice(0, RECEIPT_EVIDENCE_MAX),
  }
}

export interface ReceiptGenerateInput {
  /** 源卡 id */
  sourceId: string
  /** 取件核验事实（inboxLoad 的 verifyGit 产出照传）；缺省 = 上层未提供核验面 →
   * evidence 如实落 UNAVAILABLE 占位说明，绝不编 CURRENT_OBSERVED */
  verify?: VerifyFacts
  /** 源卡快照：stopped 段 / extras.flight / git 概要 */
  source?: { stopped?: string; flight?: unknown; branch?: string; changedCount?: number }
  /** 取件方标识（缺省本机 hostname） */
  pickedBy?: string
  /** 回执卡归属工作目录（进卡面 cwd 与 git 快照采集；缺省进程 cwd） */
  cwd?: string
  /** 回执卡目标（缺省 any） */
  to?: string
}

export type ReceiptCardResult =
  | { ok: true; id: string; path: string; /** 回执指向的源卡 id */ receiptFor: string; evidenceCount: number }
  | { ok: false; error: string }

/**
 * 生成延续回执卡（程序化出卡，复用 pushHandoff 全套纪律 + supersedes 挂链）。
 * 全程不抛、不拦调用方主流程：失败一律 { ok:false, error }（fail-open 硬纪律）；
 * 成功时记 lifecycle continued 事件（target=源卡 id，回执卡在即 continued 的证据）。
 */
export function generateReceiptCard(
  input: ReceiptGenerateInput,
  deps?: { push?: typeof pushHandoff; dir?: string; now?: Date },
): ReceiptCardResult {
  try {
    const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
    try {
      assertSafeId(sourceId)
    } catch (e) {
      return { ok: false, error: `延续回执未生成：${e instanceof Error ? e.message : `非法源卡 id：${sanitizeLine(sourceId, 64)}`}` }
    }
    const now = deps?.now ?? new Date()
    const extras = buildReceiptExtras({
      sourceId,
      pickedAt: now,
      pickedBy: input.pickedBy,
      // 上层没传核验事实 ≠ 核验一致——如实落 UNAVAILABLE 占位说明，不编 CURRENT_OBSERVED
      verify: input.verify ?? { unavailable: '取件方未提供 git 核验事实（未接核验面或核验面降级）' },
      stopped: input.source?.stopped,
      flight: input.source?.flight,
    })
    const mismatchCount = extras.evidence.filter((ev) => ev.state === 'MISMATCH').length
    const unavailableCount = extras.evidence.filter((ev) => ev.state === 'UNAVAILABLE').length
    const sections: CardSections = {
      goal: [
        `延续回执：源卡 ${sourceId} 已于 ${extras.picked_at} 被取件延续（取件方 ${extras.picked_by}）。`,
        `本卡是延续账本数据面（取件即回执）：取件方按源卡 remaining 与下方证据决定续作；回执本身照走消费即弃，无需产出二次回执。`,
      ].join('\n'),
      files: '回执卡不携带文件清单——延续证据在「做到哪」段（四态标注逐条）与 extras.receipt.evidence。',
      done: [
        `取件核验证据（四态标注，逐条落账）：`,
        ...extras.evidence.map((ev) => `- ${ev.claim}（${ev.state}）`),
        extras.first_step !== '' ? `- 源卡「停在哪」段第一步摘录已随卡转移：${extras.first_step}（HISTORY_REPORTED）` : '',
      ].filter((l) => l !== '').join('\n'),
      remaining: [
        `下游接手方：按源卡 ${sourceId} 的「还差什么」（若父卡仍在盘，已作「上一棒遗留」前缀并入本卡 remaining 顶部）与本卡 evidence 决定续作。`,
        mismatchCount > 0 ? `源卡核验冲突 ${mismatchCount} 处（MISMATCH）：关键陈述先对 git 当面核实再动手。` : '',
        unavailableCount > 0 ? `源卡存在无法核验项（UNAVAILABLE）：按 HISTORY_REPORTED 处理。` : '',
        `账本侧：本回执卡被取件即完成闭环（continued 已在册），无需回执本卡。`,
      ].filter((l) => l !== '').join('\n'),
      stopped: `停在取件时刻（${extras.picked_at}，取件方 ${extras.picked_by}）。最安全的第一步：核对 git 当前分支与 dirty 集合是否与 evidence 的 CURRENT_OBSERVED 条目一致，不一致按 MISMATCH 条目排查。`,
      warnings: [
        '本回执卡由程序化管线生成，全部内容为取件时刻快照（HISTORY_REPORTED），不是当下事实。',
        'evidence 的 MISMATCH/UNAVAILABLE 条目表示源卡卡面与仓库现实脱节或不可核验——执行前先核对 git 状态。',
        '源卡内命令声称（如有）均为 unverified 登记态：0.26 无命令执行面，任何声称都未经本管线验证。',
      ].join('\n'),
    }
    const push = deps?.push ?? pushHandoff
    const result: PushResult = push(undefined, {
      goal: sections.goal,
      files: sections.files,
      done: sections.done,
      remaining: sections.remaining,
      stopped: sections.stopped,
      warnings: sections.warnings,
      title: `延续回执 · ${sourceId}`,
      to: typeof input.to === 'string' && input.to.trim() !== '' ? input.to.trim() : 'any',
      ...(typeof input.cwd === 'string' && input.cwd.trim() !== '' ? { cwd: input.cwd.trim() } : {}),
      supersedes: sourceId,
    }, {
      dir: deps?.dir,
      // 四轴 IR 立约：回执卡是 session 轴载荷，形态为 distilled（甄别过的证据条目随卡）；
      // extras.receipt 走 SPEC extras 持久通道（先例 extras.coverage / extras.baseline）
      extras: {
        axis: 'session' satisfies CardAxis,
        payload: 'distilled' satisfies CardPayload,
        receipt: extras,
      },
    })
    if (!result.ok) {
      // 回执被闸拒收（如证据串里带出密钥形态文本）= fail-open：源卡已取件的事实不受影响，
      // 账本不记 continued/abandoned（诚实缺省，见模块头「第三种真实状态」）
      return { ok: false, error: `延续回执未生成（取件主流程不受影响）：${result.error}` }
    }
    recordLifecycleEvent(
      { stage: 'pickup', reason: 'continued', target: sourceId, detail: `延续回执卡 ${result.id}（evidence ${extras.evidence.length} 条）` },
      deps?.dir,
      now,
    )
    return { ok: true, id: result.id, path: result.path, receiptFor: sourceId, evidenceCount: extras.evidence.length }
  } catch (e) {
    return { ok: false, error: `延续回执未生成（取件主流程不受影响）：${e instanceof Error ? e.message : String(e)}` }
  }
}
