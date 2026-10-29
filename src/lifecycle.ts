/**
 * 0.4.1 归因版 · 卡片生命周期事件层（死亡地图的数据底座）。
 *
 * 问题：卡从寄存到取件的一生里会在四个关卡死掉——写侧（密钥闸/空壳闸拒收）、
 * 读侧（坏卡跳过）、取侧（git 核验 MISMATCH/UNAVAILABLE）——此前各关卡的处理
 * 散在返回值与计数里，写方对「自己的卡为什么没被消费」全盲，接力失败无法归因。
 *
 * 设计：
 * - 写侧/取侧事件持久化在 `<HANDOFF_HOME>/lifecycle.jsonl`（append-only，尾 500 条
 *   封顶——多写方共享目录，无界日志会被 30s 轮询放大成读放大事故）；
 * - 读侧跳过是 state 每次现算的**活性视图**（坏卡修好即消失），不进持久日志
 *   （重复轮询会把同一张坏卡刷成千条事件）；
 * - 理由是闭集（reasonFromCoreSkip 把 core 的自由文本映射进闭集）——开集字符串
 * 没法聚合，没法出死亡地图。
 * 隐私纪律：target 只落文件名/卡 id/标题，detail 不落卡正文，与 backtest 同款。
 *
 * @module dsh-takeover/lifecycle
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '@agent-handoff/core'

/** 生命周期阶段：write=寄存闸拒收 read=读侧坏卡 pickup=取件核验异常 */
export type LifecycleStage = 'write' | 'read' | 'pickup'

/** 闭集理由：开集字符串无法聚合出死亡地图。新增理由 = 改这里 + 测试 */
export const LIFECYCLE_REASONS = [
  'secret_gate', // 写侧：密钥闸命中（未旁路）
  'skeleton_gate', // 写侧：空壳卡守门（未确认）
  'oversize', // 读侧：超 MAX_CARD_BYTES 尺寸闸
  'parse_error', // 读侧：frontmatter/正文解析失败
  'drift_mismatch', // 取侧：git 核验 MISMATCH
  'git_unavailable', // 取侧：git 核验不可用（非仓/无 git）
  'sig_tampered', // 取侧：信封 HMAC 验签失败（内容与写侧签名不符）
  'unknown',
] as const
export type LifecycleReason = (typeof LIFECYCLE_REASONS)[number]

export interface LifecycleEvent {
  /** 事件时刻（ISO8601 本地时区，与 SPEC pushed_at 同口径） */
  at: string
  stage: LifecycleStage
  reason: LifecycleReason
  /** 文件名 / 卡 id / 卡标题（不落正文） */
  target: string
  /** 关卡细节（规则名/计数/理由原文截断），不含密钥值 */
  detail: string
}

/** JSONL 尾部封顶：超限重写只留最新 N 条 */
export const LIFECYCLE_LOG_MAX = 500

/** state 里持久事件最多回传条数（30s 轮询不被长尾放大） */
export const LIFECYCLE_STATE_MAX = 50

export function lifecyclePath(dir?: string): string {
  return join(resolveHome(dir), 'lifecycle.jsonl')
}

/** core 读侧 skip 的自由文本理由 → 闭集（映射不出则 unknown，原文字段仍存 detail） */
export function reasonFromCoreSkip(reason: string): LifecycleReason {
  const r = reason ?? ''
  if (/尺寸|size|MAX_CARD|8\s*MiB|字节上限|太大|big/i.test(r)) return 'oversize'
  if (/解析|parse|frontmatter|yaml|yamlParse|格式|malformed|id/i.test(r)) return 'parse_error'
  return 'unknown'
}

function validReason(r: unknown): LifecycleReason {
  return (LIFECYCLE_REASONS as readonly string[]).includes(String(r)) ? (r as LifecycleReason) : 'unknown'
}

/** 追加一条事件并保持尾 500 封顶；任何 IO 失败静默（事件层绝不能反过来弄死主流程） */
export function recordLifecycleEvent(event: Omit<LifecycleEvent, 'at'>, dir?: string, now?: Date): void {
  try {
    const full: LifecycleEvent = { at: (now ?? new Date()).toISOString(), ...event, reason: validReason(event.reason) }
    const path = lifecyclePath(dir)
    const prior = readLifecycleEvents(dir)
    const next = [...prior, full].slice(-LIFECYCLE_LOG_MAX)
    writeFileSync(path, `${next.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8')
  } catch { /* 事件层失败不影响主流程（寄存/取件优先） */ }
}

/** 读全部事件（坏行跳过）；文件不存在 = 无事件 */
export function readLifecycleEvents(dir?: string): LifecycleEvent[] {
  const path = lifecyclePath(dir)
  if (!existsSync(path)) return []
  try {
    const out: LifecycleEvent[] = []
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const o = JSON.parse(line) as Record<string, unknown>
        if (typeof o['at'] !== 'string' || typeof o['stage'] !== 'string' || typeof o['target'] !== 'string') continue
        out.push({
          at: o['at'],
          stage: (['write', 'read', 'pickup'] as const).includes(o['stage'] as never) ? (o['stage'] as LifecycleEvent['stage']) : 'read',
          reason: validReason(o['reason']),
          target: o['target'],
          detail: typeof o['detail'] === 'string' ? o['detail'] : '',
        })
      } catch { /* 单坏行跳过 */ }
    }
    return out
  } catch {
    return []
  }
}
