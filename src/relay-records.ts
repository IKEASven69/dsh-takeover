// 接力溯源记录：把「本会话由哪张卡/哪家会话接管而来」写进会话日志本身。
// 依托宿主实验性 plugin record API（@deepseek-ai/dsh-session ≥0.2.1-alpha.2 的
// appendPluginRecord / pluginRecordOf）：记录是 ignorable 事件——永不进入模型可见
// 上下文，fork/resume 随日志携带，格式迁移 best-effort 保留。
// 版本兼容：0.2.0-rc.2 无此 API——动态导入后按命名导出缺席静默跳过，行为与 0.2.0 一致；
// 任何失败（非法 data、会话只读等）都不上抛——溯源是增益，不是投递的前置。

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

/** 尽力追加接力溯源记录：API 缺席（旧宿主）/任何失败 → false，调用方不感知 */
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
