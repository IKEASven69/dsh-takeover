/**
 * 上下文预警触发器（0.26 contextHealth，WS-1）：
 * 把「会话还剩多少上下文」从 collect.ts 已被实测判死刑的条数代理
 * （userMessages≤100 / writeEdits≤200 / commands≤10 全封顶失真）
 * 换成真指标——最后请求的 usage ÷ 广告的 contextWindow——并在临界时
 * 给出可一键执行的预警态建议（救生艇 / 寄存）。不做任何仪表盘
 * （KPI 栏 / 热力图 / 趋势图 / 组成堆叠条是 dsh-context 的「看」位，
 * 本模块交付的全部是「何时该动手」的判定）。
 *
 * 主指标口径（docs/预研-0.26.md §2.1/§2.2，探针面在 @deepseek-ai/dsh-session
 * 类型与运行时双核实）：
 * - 分子：事件流「最后一条带 usage 的事件」（assistant/message 的 `usage?`，
 *   types.d.ts:331-339，「when the adapter reported token accounting」——取尾：
 *   事件流按 seq 连续递增，尾部即最后请求）；
 * - 分母：`session.requestContext().contextWindow`（types.d.ts:231-240，
 *   「Maximum combined request and response context in tokens, when advertised」；
 *   getter 缺席时退事件流 `request/context` 事件——同一份路由元数据的落盘形态）。
 * 两者都是可选字段（预研 §2.4 #1/#2）：任一缺失 → level='unknown'，只报
 * 兜底触发器与依据，绝不编比率。
 *
 * 兜底触发器两条独立在册（与比率口径无关的事实观察，预研 §2.1 触发器行）：
 * - turn/end reason `max-tokens`（types.d.ts:186-190，step 撞输出 token 顶）；
 * - surfaceOp `replace` 计数（types.d.ts:452-463 + surface.d.ts:122
 *   replaceGeneration——compaction 已发生的信号；getter 与事件流两源取大）。
 *
 * seeded/subagent 会话（header.isSeeded / origin='subagent' / delegationDepth /
 * inheritedEventCount 任一命中）：0.26 输出形态一律 level='unknown' + basis
 * 注明 fork 继承，不算比率——元数据只用于识别并降级，不硬编子代理阈值
 * （预研附录 B #12③ Agent 侧探针材料截断，0.26 预警只对主会话出）。
 * 触发器扫描只看子会话自有事件（按 inheritedEventCount 剔除继承前缀），
 * 剔不掉时宁可不报——把父会话的 max-tokens 算到子会话头上就是编造。
 *
 * 阈值不定死：材料未给建议值（预研 §2.4 #4），常量出模块头，上线初期从宽
 * （warn 阈低设，宁误报不漏报），实测分布后再调。
 *
 * 实现风格延续 probeSessionEvents（src/collect.ts:77-98）：全程 typeof 防御、
 * fail-open、绝不 throw；不改 collect.ts（探针是会话对象级探测，不进
 * collectFacts 的事件类型分发 switch）。零依赖（纯函数，node:stdlib 都不用）。
 *
 * ── 探针补路径（0.26+ 真实事件读取，装机 0.2.2-rc.1 实测复现）──
 * 真机瓦片「snapshotEvents/events 均 undefined」的根因是解绑调用丢 this：
 * snapshotEvents 默认参数读 `this.seq`（dsh-session lib/index.js:1454），裸调用
 * `fn()` 时 this=undefined 必抛 → 落 events 字段，而真机 Session 永远没有
 * `events` 字段（内部数组真名是 `log`，实例 own keys 实测）。故在既有两路径
 * 之后追加两条真机可达路径（既有路径原样保留，typeof 防御 + fail-open 分级不变）：
 * - 路径三：同一官方 API 的绑定重试——`snapshotEvents.call(session)`，以 session
 *   为接收者（真机实测：解绑必抛 'reading seq'，绑定 OK 且返回冻结快照）；
 * - 路径四（末位兜底）：`session.log` 内部数组（live）——非正式面，basis 注明来源。
 * 分母同理：requestContext 解绑在真机同样必抛（默认参数读 `this.contextFoldSeq`，
 * 装机实测），追加绑定重试后才在真机点亮。
 * 注意：snapshotEvents/eventAt 上游已标 @deprecated（指向同步读退役架构笔记），
 * 宿主 SessionStore.fork 仍在用，绑定调用短期安全；中长期官方面是 sessionProjections
 * 投影注册表——basis 不把 snapshotEvents 说成长期承诺。
 *
 * ── 条件性代价投影（诚实两态，绝不自算）──
 * 可选第二参 tokenMeter（集成面传 `ctx.root?.tokenMeter`，@deepseek-ai/dsh-token-meter
 * 服务，dsh-base bundle 挂载；精简 profile 可能缺席）。在位时直读官方投影
 * `tokenMeter.contextPressure(session)`（method-call 形态，服务内部读 this 的投影
 * 句柄）——0.2.2-rc.1 装机实测方法面只返回 `pressureTokens`（最近请求 provider
 * 上报 prompt size，不含输出）与 `contextWindow`（最新路由容量）；`projectedTokens`
 * 在投影状态里但不在本方法返回面（官方签名 Pick<'pressureTokens'|'contextWindow'>），
 * 字段保留防御性读取，缺席不编。官方文档明言投影是「user-facing reference,
 * not a billing or gating input」——故只作参考字段呈现，绝不参与分级。
 * tokenMeter 缺席/方法缺席/调用抛错/返回无数值 → 投影字段缺席，basis 如实写
 * 「代价投影不可达，未接入」——不可达就说不可达，绝不自算投影。
 *
 * @module dsh-takeover/contexthealth
 */

/** 预警级别：unknown = 无可靠比率口径（分母/分子缺失或 fork 降级），降级即产品行为 */
export type ContexthealthLevel = 'ok' | 'warn' | 'critical' | 'unknown'

/** 建议动作：只指路到既有端点（lifeboat=POST /dsh-takeover/lifeboat，
 * deposit=POST /dsh-takeover/takeover 的 mode='take_deposit'），执行权在集成面与用户 */
export type ContexthealthAction = 'lifeboat' | 'deposit' | null

/** 官方代价投影字段集（tokenMeter.contextPressure 直读的原始数值，绝不自算派生）。
 * 三项均按官方语义可选：pressureTokens 缺席=provider 尚未上报 usage；
 * contextWindow 缺席=无 adapter 广告容量；projectedTokens 官方方法面（0.2.2-rc.1
 * 实测）暂不返回，保留防御性读取。字段键缺席即「该来源未给出」，不编 0。 */
export type ContexthealthProjection = {
  /** 最近请求的 provider 上报 prompt size（不含输出） */
  pressureTokens?: number
  /** 下一请求预估（官方投影状态字段；方法面当前不返回，防御性读取） */
  projectedTokens?: number
  /** 最新记录的路由容量 */
  contextWindow?: number
}

/** 探测结果立约（集成面经 state.contextHealth 呈现，字段语义见模块头）。
 * type 别名而非 interface（集成期定型，零逻辑变更）：命名别名才有隐式索引签名，
 * 过 defineTool 的 JsonValue 契约——RepoBaseline/SyncToolValue 同款仓内惯例 */
export type ContexthealthReport = {
  level: ContexthealthLevel
  /** 已用 ÷ 广告窗口；仅比率口径双在场时有值，unknown 态一律缺席 */
  ratio?: number
  /** 分级/降级依据（中文一句话，如实说明口径来源或缺失原因） */
  basis: string
  /** 兜底触发器清单（独立于比率的事实观察；无命中为空数组） */
  triggers: string[]
  /** 建议动作：critical→lifeboat（紧急抢出），warn→deposit（提前寄存），其余 null */
  action: ContexthealthAction
  /** 官方代价投影直读（参考字段，绝不参与分级）；键缺席 = 不可达未接入（basis 注明原因） */
  projection?: ContexthealthProjection
}

/**
 * 分级阈值（模块头常量，实测分布后调；预研 §2.4 #4 材料未给建议值）。
 * 从宽原则：warn 阈低设，宁误报不漏报；边界判定用 >=（含端点）。
 */
export const WARN_RATIO = 0.7
export const CRITICAL_RATIO = 0.85

/** 非 null 非 array 的 object（探针第一道闸，照 probeSessionEvents 口径） */
function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 有限正数（contextWindow / usage 计数的资格线：0 与负数不是窗口） */
function isPosNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/** 有限非负数（seq / replaceGeneration / inheritedEventCount 的资格线） */
function isNonNegNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/**
 * 防御式读属性：属性访问本身可能抛（getter 抛错是合法形态），
 * 与「值不可用」同路降级，绝不外抛。
 */
function readKey(obj: Record<string, unknown>, key: string): unknown {
  try {
    return obj[key]
  } catch {
    return undefined
  }
}

/** 探测结果：不可用/无法识别时 skipped=true 并附中文说明（照 ProbeResult 形态）；
 * viaNote 非空时是「来源注明」（如 log 内部数组的非正式面声明），进 basis */
interface EventsProbe {
  events: unknown[]
  skipped: boolean
  note: string
  viaNote: string
}

/** 事件条目结构闸：空数组放行，非空时要求每条都是带 string type 的对象（照 collectFacts 口径） */
function eventsLookLikeEvents(v: unknown[]): boolean {
  return !(
    v.length > 0 &&
    v.every((e) => !(e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string'))
  )
}

/**
 * 探测会话事件流（四路径降级链，前两路径原样保留）：
 * 1. snapshotEvents() 解绑调用（既有；合成桩的箭头函数形态可用，真机 Session 因丢
 *    this 在默认参数 this.seq 处必抛——装机 0.2.2-rc.1 实测）；
 * 2. session.events 数组（既有；合成桩形态，真机 Session 无此字段）；
 * 3. snapshotEvents.call(session) 绑定重试（新增；真机官方 API 的正确调用形态，
 *    实测绑定 OK 且返回冻结快照）；
 * 4. session.log 内部数组（新增，末位兜底；live 但非正式面，basis 注明来源）。
 * 全链 typeof 防御 + fail-open，绝不 throw；形态照抄 probeSessionEvents
 * （src/collect.ts:77-98），不 import 集成专用面，模块自含零耦合。
 */
function probeEvents(session: Record<string, unknown>): EventsProbe {
  const snapshot = readKey(session, 'snapshotEvents')
  if (typeof snapshot === 'function') {
    try {
      const out = (snapshot as () => unknown)()
      if (Array.isArray(out)) return { events: out, skipped: false, note: '', viaNote: '' }
    } catch {
      // 快照失败继续试 events 字段
    }
  }
  const events = readKey(session, 'events')
  if (Array.isArray(events)) {
    if (!eventsLookLikeEvents(events)) {
      return { events: [], skipped: true, note: 'events 结构无法识别：事件缺少 type 字段', viaNote: '' }
    }
    return { events, skipped: false, note: '', viaNote: '' }
  }
  // 新增路径三：绑定重试——同一官方 API 以 session 为接收者（真机可达形态；
  // 与路径一同口径：官方快照返回数组即采信，不二次猜内容）
  if (typeof snapshot === 'function') {
    try {
      const out = (snapshot as (this: unknown) => unknown).call(session)
      if (Array.isArray(out)) return { events: out, skipped: false, note: '', viaNote: '' }
    } catch {
      // 绑定快照也失败 → 落内部数组兜底
    }
  }
  // 新增路径四（末位兜底）：log 内部数组 live 可读，但属实现细节非正式面——注明来源
  const log = readKey(session, 'log')
  if (Array.isArray(log)) {
    if (!eventsLookLikeEvents(log)) {
      return { events: [], skipped: true, note: 'log 结构无法识别：事件缺少 type 字段', viaNote: '' }
    }
    return {
      events: log,
      skipped: false,
      note: '',
      viaNote: '；事件流读取自 session.log 内部数组（非正式面，官方快照 API 不可用时的末位兜底）',
    }
  }
  return {
    events: [],
    skipped: true,
    note:
      `全链不可读：snapshotEvents()（绑定/解绑两形态）、events、log 均不可用` +
      `（typeof events=${typeof events}、typeof log=${typeof log}）`,
    viaNote: '',
  }
}

/**
 * session.seq 探测（O(1) 事件总数，index.d.ts:239「next event's seq = log length」，
 * 规模补充信号，替代 collectFacts 失真的 eventCount 口径）。运行时是 getter（number），
 * 兼容函数形态；两者都不是或抛错 → null（防御不编数）。
 */
function probeSeq(session: Record<string, unknown>): number | null {
  const raw = readKey(session, 'seq')
  if (isNonNegNum(raw)) return raw
  if (typeof raw === 'function') {
    try {
      const out = (raw as () => unknown)()
      if (isNonNegNum(out)) return out
    } catch {
      return null
    }
  }
  return null
}

/** 单条 usage 的计数结果（tokens 数值 + 实际采用的口径描述，进 basis 供人核） */
interface UsageCount {
  tokens: number
  via: 'totalTokens' | '分项求和'
}

/**
 * 单条 usage 的 token 计数（TokenUsage，dsh-llm types.d.ts:160-178）：
 * totalTokens 是上游明确的全调用总量（含聚合 prompt 与输出），在场优先；
 * 缺席时按 disjoint 口径求和——未缓存输入 + 缓存读 + 缓存写 + 输出
 * （reasoningTokens 是输出的子集，不重复计）。算不出有限数 → null。
 */
function usageTotalOf(usage: unknown): UsageCount | null {
  if (!isObj(usage)) return null
  const total = readKey(usage, 'totalTokens')
  if (typeof total === 'number' && Number.isFinite(total)) return { tokens: total, via: 'totalTokens' }
  let sum = 0
  let counted = false
  for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
    const v = readKey(usage, key)
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v
      counted = true
    }
  }
  return counted ? { tokens: sum, via: '分项求和' } : null
}

/** 事件封装的资格闸（照 collectFacts：非 object 或 type 非串的条目跳过） */
function eventOf(ev: unknown): Record<string, unknown> | null {
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  return typeof e['type'] === 'string' ? e : null
}

interface UsageHit {
  tokens: number
  /** 计数口径描述（进 basis：totalTokens 在场 / disjoint 求和） */
  via: string
  /** 事件 seq（取尾口径的证据） */
  seq: string
}

/**
 * 分子：事件流最后一条带可用 usage 的事件（取尾——最后请求）。
 * 从尾部倒扫，第一条能算出有限 token 数的即命中；全流算不出 → null（分子缺失）。
 */
function lastUsageOf(events: unknown[]): UsageHit | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = eventOf(events[i])
    if (!e || e['type'] !== 'assistant/message') continue
    const data = readKey(e, 'data')
    if (!isObj(data)) continue
    const count = usageTotalOf(readKey(data, 'usage'))
    if (count === null) continue
    return { tokens: count.tokens, via: count.via, seq: isNonNegNum(e['seq']) ? String(e['seq']) : '?' }
  }
  return null
}

/**
 * 分母：requestContext().contextWindow（types.d.ts:312 getter）优先，
 * 缺席/抛错/未广告时退事件流最后一条 `request/context` 事件（types.d.ts:406，
 * 同一份 RequestContext 的落盘形态）。两源都没有正数窗口 → null（分母缺失）。
 * 真机补路径：requestContext 解绑在真机同样必抛（默认参数读 this.contextFoldSeq，
 * 装机 0.2.2-rc.1 实测）——解绑尝试后追加绑定重试（.call(session)），再落事件流兜底。
 */
function denominatorOf(session: Record<string, unknown>, events: unknown[]): { window: number; source: string } | null {
  const rc = readKey(session, 'requestContext')
  if (typeof rc === 'function') {
    try {
      const ctx = (rc as () => unknown)()
      if (isObj(ctx)) {
        const w = readKey(ctx, 'contextWindow')
        if (isPosNum(w)) return { window: w, source: 'requestContext()' }
      }
    } catch {
      // 解绑抛错（真机常态）→ 绑定重试
    }
    try {
      const ctx = (rc as (this: unknown) => unknown).call(session)
      if (isObj(ctx)) {
        const w = readKey(ctx, 'contextWindow')
        if (isPosNum(w)) return { window: w, source: 'requestContext()' }
      }
    } catch {
      // 绑定也失败 → 落事件流兜底
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = eventOf(events[i])
    if (!e || e['type'] !== 'request/context') continue
    const data = readKey(e, 'data')
    if (!isObj(data)) continue
    const w = readKey(data, 'contextWindow')
    if (isPosNum(w)) return { window: w, source: '事件流 request/context' }
  }
  return null
}

/** 触发器一：turn/end reason max-tokens（reason 是 { kind: 'max-tokens' } 和类型） */
function countMaxTokens(events: unknown[]): number {
  let n = 0
  for (const ev of events) {
    const e = eventOf(ev)
    if (!e || e['type'] !== 'turn/end') continue
    const data = readKey(e, 'data')
    if (!isObj(data)) continue
    const reason = readKey(data, 'reason')
    if (isObj(reason) && reason['kind'] === 'max-tokens') n++
  }
  return n
}

/** 单条事件的 surfaceOp replace 判定：封装层 surfaceOp 字段（types.d.ts:445-463
 * SurfaceIntent）为准，data.surfaceOp 作形态容错；同一事件只计一次 */
function isReplaceEvent(e: Record<string, unknown>): boolean {
  for (const holder of [e, readKey(e, 'data')]) {
    if (!isObj(holder)) continue
    const op = readKey(holder, 'surfaceOp')
    if (isObj(op) && op['op'] === 'replace') return true
  }
  return false
}

/**
 * 触发器二：surfaceOp replace 计数（compaction 已发生）。
 * 两源取大：session.surface.replaceGeneration（surface.d.ts:122，运行时维护的
 * 单调计数，getter 抛错/缺席不计）与事件流扫描；两源都拿不到 → null。
 */
function countSurfaceReplace(session: Record<string, unknown>, events: unknown[]): number | null {
  let fromSurface: number | null = null
  const surface = readKey(session, 'surface')
  if (isObj(surface)) {
    const gen = readKey(surface, 'replaceGeneration')
    if (isNonNegNum(gen)) fromSurface = gen
  }
  let fromEvents = 0
  for (const ev of events) {
    const e = eventOf(ev)
    if (e && isReplaceEvent(e)) fromEvents++
  }
  const candidates = [fromSurface, fromEvents > 0 ? fromEvents : null].filter((v): v is number => v !== null)
  if (candidates.length === 0) return null
  return Math.max(...candidates)
}

/** 兜底触发器扫描 → 触发器清单（无命中空数组；计数带 ×N 便于人读） */
function scanTriggers(session: Record<string, unknown>, events: unknown[]): string[] {
  const triggers: string[] = []
  const maxTokens = countMaxTokens(events)
  if (maxTokens > 0) triggers.push(`turn/end reason=max-tokens ×${maxTokens}（输出撞顶）`)
  const replaces = countSurfaceReplace(session, events)
  if (replaces !== null && replaces > 0) triggers.push(`surfaceOp replace ×${replaces}（compaction 已发生）`)
  return triggers
}

/** fork/子代理元数据命中清单（任一非空即降级） */
function forkMarks(session: Record<string, unknown>): string[] {
  const marks: string[] = []
  const header = readKey(session, 'header')
  if (isObj(header)) {
    if (readKey(header, 'isSeeded') === true) marks.push('header.isSeeded=true')
    if (readKey(header, 'origin') === 'subagent') marks.push("header.origin='subagent'")
    const depth = readKey(header, 'delegationDepth')
    if (isPosNum(depth)) marks.push(`header.delegationDepth=${depth}`)
  }
  const inherited = readKey(session, 'inheritedEventCount')
  if (isPosNum(inherited)) marks.push(`inheritedEventCount=${inherited}`)
  return marks
}

/**
 * fork 降级路径的触发器扫描面：按 inheritedEventCount 剔除继承前缀，
 * 只扫子会话自有事件；剔除长度不可知时返回空（不把父会话事件算到子会话头上）。
 */
function ownEventsOf(session: Record<string, unknown>, events: unknown[]): unknown[] {
  const inherited = readKey(session, 'inheritedEventCount')
  if (!isNonNegNum(inherited)) return []
  if (inherited >= events.length) return []
  return events.slice(inherited)
}

/** 级别与建议动作映射（含端点）：critical→lifeboat（紧急抢出）、warn→deposit（提前寄存） */
function levelOf(ratio: number): { level: ContexthealthLevel; action: ContexthealthAction } {
  if (ratio >= CRITICAL_RATIO) return { level: 'critical', action: 'lifeboat' }
  if (ratio >= WARN_RATIO) return { level: 'warn', action: 'deposit' }
  return { level: 'ok', action: null }
}

/** 未知态出参（不编比率的统一出口） */
function unknownReport(basis: string, triggers: string[]): ContexthealthReport {
  return { level: 'unknown', basis, triggers, action: null }
}

/** 投影探测结果：projection=null 即不可达（note 带原因）；可达时 note 是进 basis 的口径声明 */
interface ProjectionProbe {
  projection: ContexthealthProjection | null
  note: string
}

/**
 * 官方代价投影直读（诚实两态，绝不自算）：tokenMeter.contextPressure(session)
 * method-call 形态（服务内部读 this 的投影句柄，cordis traceable 代理下 method-call
 * 安全）。可达 = 至少一个官方数值字段在场，原样透传不派生；不可达 = projection
 * 缺席 + note 如实写「代价投影不可达，未接入（原因）」。绝不 throw。
 */
function probeProjection(session: Record<string, unknown>, tokenMeter: unknown): ProjectionProbe {
  if (!isObj(tokenMeter)) {
    return { projection: null, note: '；代价投影不可达，未接入（tokenMeter 未传入或宿主缺席——精简 profile 无此服务）' }
  }
  const fn = readKey(tokenMeter, 'contextPressure')
  if (typeof fn !== 'function') {
    return { projection: null, note: '；代价投影不可达，未接入（tokenMeter.contextPressure 方法缺席）' }
  }
  try {
    const out = (fn as (this: unknown, s: unknown) => unknown).call(tokenMeter, session)
    if (!isObj(out)) {
      return { projection: null, note: '；代价投影不可达，未接入（投影返回形态无法识别）' }
    }
    const projection: ContexthealthProjection = {}
    const pressure = readKey(out, 'pressureTokens')
    const projected = readKey(out, 'projectedTokens')
    const window = readKey(out, 'contextWindow')
    if (isNonNegNum(pressure)) projection.pressureTokens = pressure
    if (isNonNegNum(projected)) projection.projectedTokens = projected
    if (isNonNegNum(window)) projection.contextWindow = window
    if (Object.keys(projection).length === 0) {
      return {
        projection: null,
        note: '；代价投影不可达，未接入（投影无数值字段——该会话尚无 provider usage 或路由容量记录）',
      }
    }
    const parts: string[] = []
    if (projection.pressureTokens !== undefined) parts.push(`pressureTokens=${projection.pressureTokens}（最近请求 prompt，不含输出）`)
    if (projection.projectedTokens !== undefined) parts.push(`projectedTokens=${projection.projectedTokens}（下一请求预估）`)
    if (projection.contextWindow !== undefined) parts.push(`contextWindow=${projection.contextWindow}（最新路由容量）`)
    return {
      projection,
      note: `；代价投影（官方 tokenMeter.contextPressure 直读，未参与分级）：${parts.join('、')}`,
    }
  } catch {
    return { projection: null, note: '；代价投影不可达，未接入（投影调用抛错，fail-open）' }
  }
}

/**
 * 探测会话上下文健康并给出预警态（纯函数，绝不 throw）。
 * 任何意外的探测异常都在顶层兜底成 unknown——fail-open，绝不拦调用方。
 *
 * @param session 宿主会话对象（`ctx.root.sessions.get(id)` 的同一实例，弱映射态按实例取）
 * @param tokenMeter 可选；宿主 tokenMeter 服务（集成面传 `ctx.root?.tokenMeter`）。
 * 缺席即代价投影不可达态——basis 如实注明「代价投影不可达，未接入」，绝不自算投影。
 */
export function probeContexthealth(session: unknown, tokenMeter?: unknown): ContexthealthReport {
  try {
    // 照 probeSessionEvents 第一道闸：空/非 object 直接降级（自检 / 无会话环境）
    if (!isObj(session)) {
      return unknownReport('exec.agent.session 为空或非对象（自检 / 无会话环境），无任何口径可用，不编比率', [])
    }

    const probe = probeEvents(session)
    // 官方代价投影直读（独立于比率分级的参考字段，两态如实标注）
    const proj = probeProjection(session, tokenMeter)
    const projectionField = proj.projection === null ? {} : { projection: proj.projection }
    const events = probe.events
    const seq = probeSeq(session)

    // 规模补充说明（session.seq 在场优先；缺席退事件条数；都缺席不提规模）
    let scale = ''
    if (seq !== null) scale = `；规模补充 session.seq=${seq}（O(1) 事件总数）`
    else if (!probe.skipped) scale = `；规模补充 事件流 ${events.length} 条（session.seq 不可用）`
    // 事件流来源注明（log 内部数组的非正式面声明，官方路径读取时为空）
    const viaNote = probe.viaNote

    // fork/子代理降级先行：seeded/subagent 一律 unknown 不算比率（0.26 只对主会话出预警）
    const marks = forkMarks(session)
    if (marks.length > 0) {
      const own = ownEventsOf(session, events)
      const triggers = scanTriggers(session, own)
      const cut = readKey(session, 'inheritedEventCount')
      const cutNote = isNonNegNum(cut)
        ? `继承前缀 ${cut} 条已从触发器扫描剔除`
        : '继承前缀长度不可知，触发器扫描跳过（不把父会话事件算到子会话头上）'
      return {
        ...unknownReport(
          `seeded/subagent 会话（${marks.join('、')}）：fork 继承前缀混入父会话历史，` +
            `比率口径不可信，不算比率——0.26 预警只对主会话出，子代理/委派口径待补调研；${cutNote}${scale}${viaNote}${proj.note}`,
          triggers,
        ),
        ...projectionField,
      }
    }

    // 兜底触发器（独立于比率的事实观察，任何级别都如实上报）
    const triggers = scanTriggers(session, events)

    const denom = denominatorOf(session, events)
    const numer = lastUsageOf(events)

    // 分子/分母任一缺失 → unknown：只报触发器与依据，绝不编比率（预研 §2.2 一等约束）
    if (denom === null || numer === null) {
      const missing =
        denom === null && numer === null
          ? '分子缺失（事件流无带 usage 的请求）且分母缺失（contextWindow 未广告）'
          : denom === null
            ? '分母缺失：contextWindow 未广告（requestContext() 与事件流 request/context 均无正数窗口）'
            : '分子缺失：事件流无带 usage 的请求（adapter 未上报 token accounting）'
      const note = probe.skipped && numer === null && denom === null ? `；事件流不可用（${probe.note}）` : ''
      return {
        ...unknownReport(`${missing} → 退化兜底，只报触发器与依据，不编比率${scale}${note}${viaNote}${proj.note}`, triggers),
        ...projectionField,
      }
    }

    // 主指标：最后请求 usage ÷ 广告窗口（usage 取尾，最后请求）
    const ratio = numer.tokens / denom.window
    const { level, action } = levelOf(ratio)
    return {
      level,
      ratio,
      basis:
        `最后请求 usage ÷ 广告窗口 = ${numer.tokens}/${denom.window}≈${ratio.toFixed(2)}` +
        `（usage 取尾 assistant/message@seq ${numer.seq}，${numer.via}；` +
        `contextWindow 来源 ${denom.source}）${scale}${viaNote}${proj.note}`,
      triggers,
      action,
      ...projectionField,
    }
  } catch {
    // 顶层安全网：探测自身异常也不外抛，如实降级（probeSessionEvents 同款纪律的最终兜底）
    return unknownReport('contextHealth 探针自身异常（fail-open 降级），无可靠口径，不编比率', [])
  }
}
