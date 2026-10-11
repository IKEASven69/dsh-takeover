// 接力溯源：把「本会话由哪张卡/哪家会话接管而来」持久化两层——
// 1. 保底层（本插件完全可控）：<HANDOFF_HOME>/relay/<sessionId>.json，持久、
//    跨机随 HANDOFF_HOME 同步、不依赖任何宿主内部接口；
// 2. 增益层（尽力而为）：宿主实验性 plugin record API（@deepseek-ai/dsh-session
//    ≥0.2.1-alpha.2 的 appendPluginRecord）——记录作为 ignorable 事件进会话日志，
//    永不进入模型可见上下文，fork/resume 随行。旧宿主无此 API 时静默跳过。
// 两层任何失败都不上抛——溯源是增益，不是投递的前置。
import { resolveHome } from '@agent-handoff/core'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

/** 记录类型（plugin record 文法：plugin: 后跟小写斜杠分段） */
export const RELAY_RECORD_TYPE = {
  takeover: 'plugin:dsh-takeover/takeover',
  take_deposit: 'plugin:dsh-takeover/take-deposit',
  pickup: 'plugin:dsh-takeover/pickup',
} as const

export type RelayRecordKind = keyof typeof RELAY_RECORD_TYPE

export interface RelayRecordData {
  /** 来源外部 agent 家（takeover / take_deposit） */
  provider?: string
  /** 来源外部会话 id（takeover / take_deposit） */
  sourceId?: string
  /** 消费的交接卡 id（pickup；take_deposit 时为待落卡占位空） */
  cardId?: string
  /** 接管目标标题（与接管会话标题一致） */
  title?: string
  /** 记录时刻 ISO 串 */
  at: string
}

/** 保底层路径：<HANDOFF_HOME>/relay/<sessionId>.json */
export function relayProvenancePath(sessionId: string, dir?: string): string {
  return join(resolveHome(dir), 'relay', `${sessionId}.json`)
}

/** 保底写盘：整文件写入（同会话重复接管覆盖为最新溯源） */
export function writeRelayProvenance(sessionId: string, data: RelayRecordData, dir?: string): boolean {
  try {
    const file = relayProvenancePath(sessionId, dir)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ sessionId, ...data }, null, 2))
    return true
  } catch {
    return false
  }
}

/** 读取一条会话事件里的接力溯源记录（非本插件记录 → undefined） */
export function relayRecordOf(event: unknown): { kind: RelayRecordKind; data: RelayRecordData; seq?: number } | undefined {
  try {
    const e = event as { type?: unknown; data?: unknown }
    const type = typeof e?.type === 'string' ? e.type : ''
    const kind = (Object.keys(RELAY_RECORD_TYPE) as RelayRecordKind[]).find((k) => RELAY_RECORD_TYPE[k] === type)
    if (kind === undefined) return undefined
    const data = (e?.data ?? {}) as RelayRecordData
    return { kind, data, seq: (e as { seq?: number }).seq }
  } catch {
    return undefined
  }
}

/** 增益层尽力追加：API 缺席（旧宿主）/任何失败 → false，调用方不感知 */
export async function appendRelayRecord(session: unknown, kind: RelayRecordKind, data: RelayRecordData): Promise<boolean> {
  try {
    const mod = (await import('@deepseek-ai/dsh-session')) as {
      appendPluginRecord?: (session: unknown, type: string, payload: unknown) => number
    }
    if (typeof mod.appendPluginRecord !== 'function') return false
    mod.appendPluginRecord(session, RELAY_RECORD_TYPE[kind], { ...data })
    return true
  } catch {
    return false
  }
}
