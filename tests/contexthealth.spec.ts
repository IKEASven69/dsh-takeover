// contextHealth 上下文预警触发器（0.26 WS-1）：
// 主指标（最后请求 usage ÷ 广告 contextWindow）、可选字段缺失全降级路径、
// 兜底触发器（max-tokens / surfaceOp replace）、fork 降级、阈值边界、防御不抛。
// 合成事件形态照 @deepseek-ai/dsh-session types.d.ts 的 SessionEvent 封装
// （type/seq/time/data 在封装层，surfaceOp 在封装层，usage 在 data 层）。
// 探针补路径波：真机可达访问器（绑定快照重试 / log 内部数组 / 分母绑定重试，
// 形态照 0.2.2-rc.1 装机实测：解绑丢 this 必抛）+ 条件性代价投影（诚实两态）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { CRITICAL_RATIO, probeContexthealth, WARN_RATIO } from '../src/contexthealth.ts'

/** assistant/message 事件（带 usage，取尾口径的被测对象） */
function usageEvent(tokens: number, seq: number, extraUsage?: Record<string, unknown>): Record<string, unknown> {
  const usage = extraUsage ?? { totalTokens: tokens }
  return { type: 'assistant/message', seq, time: 0, data: { turn: 1, step: 1, usage } }
}

/** turn/end 事件（reason 是 { kind } 和类型） */
function turnEndEvent(kind: string, seq: number): Record<string, unknown> {
  return { type: 'turn/end', seq, time: 0, data: { turn: 1, reason: { kind } } }
}

/** 表面替换事件（compaction 的落盘形态：surfaceOp 在封装层） */
function replaceEvent(seq: number): Record<string, unknown> {
  return { type: 'user/message', seq, time: 0, data: {}, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }
}

/** 主会话合成：事件流 + 广告窗口 + seq 全在场的标准桩 */
function mainSession(events: unknown[], window: number, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    snapshotEvents: () => events,
    requestContext: () => ({ provider: 'deepseek', model: 'test', contextWindow: window }),
    seq: events.length,
    ...extra,
  }
}

test('主指标通路：usage÷contextWindow 三档分级与建议动作', () => {
  // 14000/28000=0.5 → ok 无动作
  const ok = probeContexthealth(mainSession([usageEvent(14000, 1)], 28000))
  assert.equal(ok.level, 'ok')
  assert.equal(ok.ratio, 14000 / 28000)
  assert.equal(ok.action, null)

  // 21000/28000=0.75 → warn 建议寄存（mode='take_deposit' 既有端点）
  const warn = probeContexthealth(mainSession([usageEvent(21000, 1)], 28000))
  assert.equal(warn.level, 'warn')
  assert.equal(warn.action, 'deposit')

  // 25000/28000≈0.89 → critical 建议救生艇（POST /lifeboat 既有端点）
  const crit = probeContexthealth(mainSession([usageEvent(25000, 1)], 28000))
  assert.equal(crit.level, 'critical')
  assert.equal(crit.action, 'lifeboat')
  // 只建议不执行：动作是指路字符串，不是执行结果
  assert.ok(crit.basis.includes('requestContext()'), 'basis 如实记分母来源')
})

test('阈值边界：>= 含端点，warn/critical 阈值与常量同步（window=1000）', () => {
  const levelOf = (tokens: number) =>
    probeContexthealth(mainSession([usageEvent(tokens, 1)], 1000)).level
  const warnAt = Math.round(WARN_RATIO * 1000)
  const critAt = Math.round(CRITICAL_RATIO * 1000)
  assert.equal(levelOf(warnAt - 1), 'ok')
  assert.equal(levelOf(warnAt), 'warn')
  assert.equal(levelOf(critAt - 1), 'warn')
  assert.equal(levelOf(critAt), 'critical')
  assert.equal(levelOf(1000), 'critical')
})

test('usage 取尾口径：多事件取最后请求，中间穿插事件不影响', () => {
  // 尾部 1000（ok）；若误取头部 25000 会判 critical——断言 ok 即钉死取尾
  const r = probeContexthealth(
    mainSession([usageEvent(25000, 1), turnEndEvent('completed', 2), usageEvent(1000, 3)], 28000),
  )
  assert.equal(r.level, 'ok')
  assert.ok(r.basis.includes('seq 3'), 'basis 记录取尾事件的 seq 作证据')
})

test('usage 取尾口径：靠后事件无 usage 时取最后一条带 usage 的', () => {
  const noUsage = { type: 'assistant/message', seq: 2, time: 0, data: { turn: 1, step: 2 } }
  const r = probeContexthealth(mainSession([usageEvent(1000, 1), noUsage], 28000))
  assert.equal(r.level, 'ok')
  assert.ok(r.basis.includes('seq 1'))
})

test('usage 分项求和口径：无 totalTokens 时按 disjoint 四项求和', () => {
  const events = [
    { type: 'assistant/message', seq: 1, time: 0, data: { usage: { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 10, outputTokens: 40, reasoningTokens: 30 } } },
  ]
  const r = probeContexthealth(mainSession(events, 1000))
  // 100+50+10+40=200（reasoningTokens 是输出子集不重复计）→ 0.2 ok
  assert.equal(r.ratio, 0.2)
  assert.ok(r.basis.includes('分项求和'))
})

test('分母缺失（contextWindow 未广告）→ unknown + 触发器，不编比率', () => {
  const events = [usageEvent(20000, 1), turnEndEvent('max-tokens', 2)]
  const r = probeContexthealth(mainSession(events, undefined as unknown as number, {
    requestContext: () => ({ provider: 'deepseek', model: 'test' }), // 未广告
  }))
  assert.equal(r.level, 'unknown')
  assert.equal(r.ratio, undefined)
  assert.ok(!('ratio' in r), 'unknown 态 ratio 键缺席')
  assert.equal(r.action, null)
  assert.ok(r.basis.includes('分母缺失'))
  assert.deepEqual(r.triggers, ['turn/end reason=max-tokens ×1（输出撞顶）'], '触发器照报')
})

test('分母缺失：contextWindow=0/负数/NaN 同路降级', () => {
  for (const bad of [0, -5, Number.NaN]) {
    const r = probeContexthealth(mainSession([usageEvent(100, 1)], bad))
    assert.equal(r.level, 'unknown', `contextWindow=${bad} 应降级`)
    assert.ok(r.basis.includes('分母缺失'))
  }
})

test('分子缺失（事件流无 usage）→ unknown + 触发器，不编比率', () => {
  const r = probeContexthealth(mainSession([replaceEvent(1)], 28000))
  assert.equal(r.level, 'unknown')
  assert.equal(r.ratio, undefined)
  assert.equal(r.action, null)
  assert.ok(r.basis.includes('分子缺失'))
  assert.equal(r.triggers.length, 1, 'surfaceOp replace 触发器独立命中')
  assert.ok(r.triggers[0]?.includes('surfaceOp replace'))
})

test('分子分母双缺失 → unknown，basis 双写并注明事件流不可用', () => {
  const r = probeContexthealth({})
  assert.equal(r.level, 'unknown')
  assert.ok(r.basis.includes('分子缺失'))
  assert.ok(r.basis.includes('分母缺失'))
  assert.ok(r.basis.includes('事件流不可用'))
  assert.deepEqual(r.triggers, [])
})

test('分母兜底：requestContext() 缺席时退事件流 request/context 事件', () => {
  const events = [
    { type: 'request/context', seq: 1, time: 0, data: { provider: 'deepseek', model: 'test', contextWindow: 28000 } },
    usageEvent(14000, 2),
  ]
  const r = probeContexthealth({ snapshotEvents: () => events, seq: 2 })
  assert.equal(r.level, 'ok')
  assert.equal(r.ratio, 0.5)
  assert.ok(r.basis.includes('事件流 request/context'), 'basis 如实记分母来自事件流兜底')
})

test('seq 防御：非函数非数值、抛错、函数形态三种都不炸', () => {
  // seq 是字符串（既非 getter 数值也非函数）→ 忽略，规模退事件条数
  const junk = mainSession([usageEvent(14000, 1)], 28000, { seq: 'garbage' })
  const rj = probeContexthealth(junk)
  assert.equal(rj.level, 'ok')
  assert.ok(rj.basis.includes('事件流 1 条'), 'seq 不可用时规模退事件条数')

  // seq 函数抛错 → 忽略不炸
  const throwing = mainSession([usageEvent(14000, 1)], 28000, { seq: () => { throw new Error('boom') } })
  assert.equal(probeContexthealth(throwing).level, 'ok')

  // seq 函数形态（防御兼容）→ 正常取数
  const fnSeq = mainSession([usageEvent(14000, 1)], 28000, { seq: () => 42 })
  assert.ok(probeContexthealth(fnSeq).basis.includes('session.seq=42'))
})

test('触发器独立命中一：只有 max-tokens（reason.kind 判据）', () => {
  const r = probeContexthealth(mainSession([usageEvent(100, 1), turnEndEvent('max-tokens', 2)], 28000))
  assert.equal(r.level, 'ok', '比率 ok 时触发器只作观察不改级')
  assert.deepEqual(r.triggers, ['turn/end reason=max-tokens ×1（输出撞顶）'])
  // 计数 ×N：两条 max-tokens
  const twice = probeContexthealth(mainSession([usageEvent(100, 1), turnEndEvent('max-tokens', 2), turnEndEvent('max-tokens', 3)], 28000))
  assert.ok(twice.triggers[0]?.includes('×2'))
})

test('触发器独立命中二：只有 surfaceOp replace（事件流源）', () => {
  const r = probeContexthealth(mainSession([replaceEvent(1), usageEvent(100, 2)], 28000))
  assert.deepEqual(r.triggers, ['surfaceOp replace ×1（compaction 已发生）'])
  // 非 replace 的 surfaceOp（append）不算
  const append = { type: 'user/message', seq: 3, time: 0, data: {}, surfaceOp: 'append' }
  const r2 = probeContexthealth(mainSession([append, usageEvent(100, 4)], 28000))
  assert.deepEqual(r2.triggers, [])
  // turn/end completed 不算 max-tokens
  const r3 = probeContexthealth(mainSession([usageEvent(100, 1), turnEndEvent('completed', 2)], 28000))
  assert.deepEqual(r3.triggers, [])
})

test('触发器二双源取大：surface.replaceGeneration getter 与事件流计数', () => {
  // getter 源在场（事件流无 replace 事件）
  const getterOnly = mainSession([usageEvent(100, 1)], 28000, { surface: { nodes: [], replaceGeneration: 2 } })
  assert.deepEqual(probeContexthealth(getterOnly).triggers, ['surfaceOp replace ×2（compaction 已发生）'])
  // 双源取大：getter=1，事件流 3 条 → ×3
  const both = mainSession(
    [replaceEvent(1), replaceEvent(2), replaceEvent(3), usageEvent(100, 4)],
    28000,
    { surface: { nodes: [], replaceGeneration: 1 } },
  )
  assert.ok(probeContexthealth(both).triggers[0]?.includes('×3'))
  // 两触发器并存（独立命中汇总）
  const bothTriggers = probeContexthealth(
    mainSession([replaceEvent(1), turnEndEvent('max-tokens', 2), usageEvent(100, 3)], 28000),
  )
  assert.equal(bothTriggers.triggers.length, 2)
})

test('seeded/subagent 识别降级：四种元数据任一命中 → unknown 不算比率', () => {
  // 即使 usage+窗口双在场且比率会判 critical，也一律降级
  const wouldBeCritical = [usageEvent(27000, 6)]
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ header: { isSeeded: true }, inheritedEventCount: 5 }, 'isSeeded'],
    [{ header: { origin: 'subagent' } }, 'subagent'],
    [{ header: { delegationDepth: 2 } }, 'delegationDepth'],
    [{ inheritedEventCount: 3 }, 'inheritedEventCount'],
  ]
  for (const [extra, mark] of cases) {
    const r = probeContexthealth(mainSession(wouldBeCritical, 28000, extra))
    assert.equal(r.level, 'unknown', `${mark} 应降级`)
    assert.equal(r.ratio, undefined, `${mark} 不算比率`)
    assert.equal(r.action, null)
    assert.ok(r.basis.includes('fork 继承'), `${mark} basis 注明 fork 继承`)
    assert.ok(r.basis.includes('只对主会话出'), `${mark} basis 注明 0.26 口径边界`)
  }
})

test('seeded 降级：触发器只扫自有事件，继承前缀里的 max-tokens 不算到子会话头上', () => {
  const events = [
    turnEndEvent('max-tokens', 0), // 继承前缀（父会话的挤迫）
    turnEndEvent('max-tokens', 1), // 继承前缀
    replaceEvent(2), // 子会话自有
    usageEvent(27000, 3), // 子会话自有（比率会判 critical，但降级不算）
  ]
  const r = probeContexthealth(mainSession(events, 28000, { header: { isSeeded: true }, inheritedEventCount: 2 }))
  assert.equal(r.level, 'unknown')
  assert.deepEqual(r.triggers, ['surfaceOp replace ×1（compaction 已发生）'], '继承前缀的 max-tokens 被剔除')
  assert.ok(r.basis.includes('继承前缀 2 条已从触发器扫描剔除'))
})

test('seeded 降级：继承前缀长度不可知时触发器跳过（宁缺勿编）', () => {
  const r = probeContexthealth(
    mainSession([usageEvent(100, 0), turnEndEvent('max-tokens', 1)], 28000, { header: { isSeeded: true } }),
  )
  assert.equal(r.level, 'unknown')
  assert.deepEqual(r.triggers, [])
  assert.ok(r.basis.includes('继承前缀长度不可知'))
})

test('空会话 / 非 object session：一律 unknown 且不抛', () => {
  for (const bad of [null, undefined, 42, 'str', true, []]) {
    const r = probeContexthealth(bad)
    assert.equal(r.level, 'unknown', `session=${String(bad)} 应 unknown`)
    assert.deepEqual(r.triggers, [])
    assert.equal(r.action, null)
    assert.ok(r.basis.includes('为空或非对象'))
  }
})

test('事件流探测降级链：snapshotEvents 抛错退 events 数组（照 probeSessionEvents 形态）', () => {
  const events = [usageEvent(14000, 1)]
  const r = probeContexthealth(mainSession([], 28000, {
    snapshotEvents: () => { throw new Error('boom') },
    events,
  }))
  assert.equal(r.level, 'ok')
  assert.equal(r.ratio, 0.5)
  // 事件流全垃圾但分母在场 → 只缺分子，退化 unknown（basis 如实只写分子缺失）
  const junk = probeContexthealth(mainSession([{ nope: 1 }], 28000))
  assert.equal(junk.level, 'unknown')
  assert.ok(junk.basis.includes('分子缺失'))
  // events 字段无法识别（非数组）且无 requestContext → 双缺失并注明事件流不可用
  const rj = probeContexthealth({ events: 'garbage', seq: 5 })
  assert.equal(rj.level, 'unknown')
  assert.ok(rj.basis.includes('事件流不可用'))
})

test('雷区全扫描：getter 抛错 / 垃圾 usage / 垃圾事件一律不外抛', () => {
  const hostile: Record<string, unknown> = {}
  Object.defineProperty(hostile, 'surface', { get() { throw new Error('boom') } })
  Object.defineProperty(hostile, 'header', { get() { throw new Error('boom') } })
  hostile['requestContext'] = () => { throw new Error('boom') }
  hostile['snapshotEvents'] = () => [
    { type: 'assistant/message', seq: 1, time: 0, data: { usage: { inputTokens: 'x' } } },
    'junk-string',
    null,
    { type: 42 },
    { type: 'assistant/message', seq: 5, time: 0, data: { usage: {} } },
  ]
  const r = probeContexthealth(hostile)
  assert.equal(r.level, 'unknown', '垃圾 usage 算不出分子 → 双缺失降级')
  assert.equal(r.ratio, undefined)
  // 分子可用但 surface/header getter 抛错 → 不影响主指标
  const okButThrowing = mainSession([usageEvent(14000, 1)], 28000)
  Object.defineProperty(okButThrowing, 'surface', { get() { throw new Error('boom') } })
  const r2 = probeContexthealth(okButThrowing)
  assert.equal(r2.level, 'ok', 'surface getter 抛错只损触发器源，不损主指标')
  assert.deepEqual(r2.triggers, [])
})

/* ── 探针补路径波：真机可达访问器（绑定重试 / log 兜底 / 分母绑定重试）── */

/** 依赖 this 的真机形态：解绑调用（this=undefined）在方法体第一行即抛（装机实测同款） */
function thisDependentSession(window: number, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    log: [{ type: 'assistant/message', seq: 1, time: 0, data: { usage: { totalTokens: 14000 } } }],
    snapshotEvents() {
      void (this as { log?: unknown }).log
      return Object.freeze((this as { log: unknown[] }).log.slice())
    },
    requestContext() {
      void (this as { contextFoldSeq?: unknown }).contextFoldSeq // 装机实测：默认参数读 this.contextFoldSeq
      return { provider: 'deepseek', model: 'test', contextWindow: window }
    },
    seq: 1,
    ...extra,
  }
}

test('新访问器一：绑定快照重试三态——可达（解绑必抛的真机形态由此点亮主指标）', () => {
  // 只有依赖 this 的 snapshotEvents 方法（无 events/log 直读面）：路径一抛 → 路径三绑定重试接管
  const r = probeContexthealth(thisDependentSession(28000))
  assert.equal(r.level, 'ok')
  assert.equal(r.ratio, 0.5)
  assert.ok(r.basis.includes('requestContext()'), '分母绑定重试同路点亮，来源仍记官方 API')
  assert.ok(!r.basis.includes('非正式面'), '官方 API 读取不作非正式面注明')
  assert.ok(!('projection' in r), '未传 tokenMeter 时 projection 键缺席（不可达态）')
  assert.ok(r.basis.includes('代价投影不可达，未接入'), '不可达态 basis 如实标注')
})

test('新访问器一三态之二：snapshotEvents 缺席（undefined）→ 事件流不可用如实注明', () => {
  const r = probeContexthealth({ seq: 3 })
  assert.equal(r.level, 'unknown')
  assert.ok(r.basis.includes('事件流不可用'))
  assert.ok(r.basis.includes('绑定/解绑两形态'), '降级链说明覆盖绑定重试')
  assert.ok(r.basis.includes('typeof log=undefined'))
})

test('新访问器一三态之三：绑定调用仍抛错 → 落 log 末位兜底，不外抛', () => {
  const r = probeContexthealth(thisDependentSession(28000, {
    snapshotEvents() {
      void (this as { log?: unknown }).log
      throw new Error('bound boom')
    },
  }))
  assert.equal(r.level, 'ok', '绑定抛错落 log，主指标不损')
  assert.equal(r.ratio, 0.5)
  assert.ok(r.basis.includes('session.log 内部数组'), 'basis 注明 log 来源')

  // snapshotEvents 访问器本身是抛错 getter：readKey 吞掉 → 视同 undefined 继续降级
  const getterThrows: Record<string, unknown> = {
    log: [{ type: 'assistant/message', seq: 1, time: 0, data: { usage: { totalTokens: 14000 } } }],
    requestContext: () => ({ provider: 'deepseek', model: 'test', contextWindow: 28000 }),
  }
  Object.defineProperty(getterThrows, 'snapshotEvents', { get() { throw new Error('getter boom') } })
  const r2 = probeContexthealth(getterThrows)
  assert.equal(r2.level, 'ok', 'getter 抛错不外抛，log 兜底接管')
  assert.ok(r2.basis.includes('非正式面'))
})

test('新访问器二：session.log 内部数组末位兜底（非正式面注明进 basis）', () => {
  // 无 snapshotEvents / events，仅 log：真机快照 API 缺席时的末位兜底
  const r = probeContexthealth({
    log: [{ type: 'assistant/message', seq: 1, time: 0, data: { usage: { totalTokens: 14000 } } }],
    requestContext: () => ({ provider: 'deepseek', model: 'test', contextWindow: 28000 }),
  })
  assert.equal(r.level, 'ok')
  assert.equal(r.ratio, 0.5)
  assert.ok(r.basis.includes('session.log 内部数组（非正式面'), '注明非正式面')
  assert.ok(r.basis.includes('末位兜底'))

  // log 全垃圾（条目缺 type 字段）→ 同 events 口径降级
  const junk = probeContexthealth({ log: [{ nope: 1 }] })
  assert.equal(junk.level, 'unknown')
  assert.ok(junk.basis.includes('事件流不可用'))

  // log 非数组 → 终态降级注明全链形态
  const garbage = probeContexthealth({ log: 'garbage' })
  assert.equal(garbage.level, 'unknown')
  assert.ok(garbage.basis.includes('typeof log=string'))
})

test('分母绑定重试：requestContext 依赖 this 的真机形态（解绑必抛 → 绑定点亮）', () => {
  const r = probeContexthealth(thisDependentSession(28000))
  assert.equal(r.level, 'ok')
  assert.equal(r.ratio, 0.5)
  assert.ok(r.basis.includes('contextWindow 来源 requestContext()'), '分母由绑定重试取得')

  // 绑定也抛 → 退事件流 request/context 兜底（extra 覆盖 log 注入路由事件）
  const r2 = probeContexthealth(thisDependentSession(0, {
    log: [
      { type: 'request/context', seq: 1, time: 0, data: { provider: 'deepseek', model: 'test', contextWindow: 28000 } },
      { type: 'assistant/message', seq: 2, time: 0, data: { usage: { totalTokens: 14000 } } },
    ],
    requestContext() {
      void (this as { contextFoldSeq?: unknown }).contextFoldSeq
      throw new Error('bound boom')
    },
  }))
  assert.equal(r2.level, 'ok', '绑定抛错落事件流分母兜底')
  assert.equal(r2.ratio, 0.5)
  assert.ok(r2.basis.includes('事件流 request/context'))
})

/* ── 条件性代价投影：诚实两态（可达直读 / 不可达未接入），绝不自算 ── */

/** 真·依赖 this 的 tokenMeter 桩（服务内部读 this 的投影句柄，装机实测） */
function tokenMeterStub(pressure: { pressureTokens?: number; contextWindow?: number; projectedTokens?: number } | ((...a: unknown[]) => never)): Record<string, unknown> {
  return {
    contextPressure() {
      void (this as { handle?: unknown }).handle // this=undefined 即抛，钉死 method-call 形态
      if (typeof pressure === 'function') return (pressure as () => never)()
      return { ...pressure }
    },
  }
}

test('代价投影可达：tokenMeter.contextPressure 直读，projection 原样透传且未参与分级', () => {
  // usage 比率 0.5（ok）；即便投影数值按比率会判 critical，级别仍由主指标决定
  const tm = tokenMeterStub({ pressureTokens: 18000, contextWindow: 20000 })
  const r = probeContexthealth(thisDependentSession(28000), tm)
  assert.equal(r.level, 'ok', '投影不参与分级——pressureTokens/容量比 0.9 不改级别')
  assert.equal(r.action, null)
  assert.deepEqual(r.projection, { pressureTokens: 18000, contextWindow: 20000 }, '官方数值原样透传，不派生')
  assert.ok(r.basis.includes('tokenMeter.contextPressure 直读'))
  assert.ok(r.basis.includes('未参与分级'))
  assert.ok(r.basis.includes('pressureTokens=18000（最近请求 prompt，不含输出）'))
  assert.ok(r.basis.includes('contextWindow=20000（最新路由容量）'))

  // method-call 形态钉死：解绑调用会炸的桩（handle 读取在 this 上）可达即证明绑定正确
  const unwrapped = tokenMeterStub({ pressureTokens: 100 })
  const fn = unwrapped['contextPressure'] as () => unknown
  assert.throws(() => fn(), '桩自身依赖 this——模块若用裸调用必炸，测试即防回归')

  // forward-compat：官方若在方法面补 projectedTokens，防御性读取接住
  const withProjected = probeContexthealth(thisDependentSession(28000), tokenMeterStub({ pressureTokens: 100, projectedTokens: 23400, contextWindow: 131072 }))
  assert.deepEqual(withProjected.projection, { pressureTokens: 100, projectedTokens: 23400, contextWindow: 131072 })
  assert.ok(withProjected.basis.includes('projectedTokens=23400（下一请求预估）'))
})

test('代价投影可达：部分字段在场（projection 只含官方给出的键，缺席不编 0）', () => {
  const r = probeContexthealth(thisDependentSession(28000), tokenMeterStub({ contextWindow: 131072 }))
  assert.deepEqual(r.projection, { contextWindow: 131072 })
  assert.ok(!('pressureTokens' in (r.projection ?? {})), '未给出的字段键缺席')
  assert.ok(!r.basis.includes('pressureTokens='))
})

test('代价投影不可达四因：缺席/方法缺席/抛错/形态垃圾/无数值，basis 一律如实标注', () => {
  // 一因：未传 tokenMeter（本波集成面未接线时的常态）
  const r1 = probeContexthealth(thisDependentSession(28000))
  assert.ok(r1.basis.includes('代价投影不可达，未接入'))
  assert.ok(r1.basis.includes('tokenMeter 未传入或宿主缺席'))
  assert.ok(!('projection' in r1))

  // 二因：tokenMeter 在但方法缺席
  const r2 = probeContexthealth(thisDependentSession(28000), { nope: 1 })
  assert.ok(r2.basis.includes('代价投影不可达，未接入（tokenMeter.contextPressure 方法缺席）'))
  assert.ok(!('projection' in r2))

  // 三因：调用抛错（fail-open）
  const boom: Record<string, unknown> = { contextPressure: () => { throw new Error('boom') } }
  const r3 = probeContexthealth(thisDependentSession(28000), boom)
  assert.ok(r3.basis.includes('代价投影不可达，未接入（投影调用抛错'))
  assert.ok(!('projection' in r3))

  // 四因：返回非对象
  const junk: Record<string, unknown> = { contextPressure: () => 'garbage' }
  const r4 = probeContexthealth(thisDependentSession(28000), junk)
  assert.ok(r4.basis.includes('投影返回形态无法识别'))
  assert.ok(!('projection' in r4))

  // 五因：对象但无数值字段（会话尚无 usage/路由记录——官方语义的字段缺席）
  const empty: Record<string, unknown> = { contextPressure: () => ({}) }
  const r5 = probeContexthealth(thisDependentSession(28000), empty)
  assert.ok(r5.basis.includes('投影无数值字段'))
  assert.ok(!('projection' in r5))
})

test('代价投影独立于分级：unknown/fork 态同样直读官方投影（参考字段不受降级影响）', () => {
  const tm = tokenMeterStub({ pressureTokens: 18000, contextWindow: 20000 })
  // fork 降级态：级别 unknown，但官方投影是事实观察，照报
  const fork = probeContexthealth(
    thisDependentSession(28000, { header: { isSeeded: true }, inheritedEventCount: 0 }),
    tm,
  )
  assert.equal(fork.level, 'unknown')
  assert.ok(fork.basis.includes('fork 继承'))
  assert.ok(fork.basis.includes('代价投影（官方 tokenMeter.contextPressure 直读'))
  assert.deepEqual(fork.projection, { pressureTokens: 18000, contextWindow: 20000 })

  // 分子缺失 unknown 态：投影照报
  const noNumer = probeContexthealth({ seq: 0 }, tm)
  assert.equal(noNumer.level, 'unknown')
  assert.ok(noNumer.basis.includes('分子缺失'))
  assert.ok(noNumer.basis.includes('代价投影（官方'))

  // 投影抛错不污染主指标：主指标照常 ok
  const boom: Record<string, unknown> = { contextPressure: () => { throw new Error('boom') } }
  const ok = probeContexthealth(thisDependentSession(28000), boom)
  assert.equal(ok.level, 'ok')
  assert.equal(ok.ratio, 0.5)
  assert.ok(!('projection' in ok))
})

test('雷区补扫：tokenMeter 非对象垃圾形态不外抛，投影统一走不可达态', () => {
  for (const junk of [null, undefined, 42, 'str', []]) {
    const r = probeContexthealth(thisDependentSession(28000), junk)
    assert.equal(r.level, 'ok', `tokenMeter=${String(junk)} 不影响主指标`)
    assert.ok(r.basis.includes('代价投影不可达，未接入'))
    assert.ok(!('projection' in r))
  }
})
