/**
 * 回归：一键接管投递核心（admitTakeover）+ 会话控制器防御访问 +
 * foreignResolveOne 门控 + 子代理判定/项目 facet（browser-view）+ PendingRow.supersedes。
 * 会话控制器一律注入假货，不碰真实宿主。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  admitTakeover,
  foreignResolveOne,
  registerTakeoverRoutes,
  sessionControllerOf,
  type SessionControllerLike,
} from '../src/index.ts'
import { cwdFacets, filterByCwd, isSubagentSession, shortId, uiNavigatorOf, type SessionRow } from '../src/browser-view.ts'

/** 录音式假控制器：记录调用序列，行为可编排 */
function fakeController(overrides?: Partial<Record<'create' | 'rename' | 'prompt', (...a: never[]) => unknown>>): {
  controller: SessionControllerLike
  calls: string[]
} {
  const calls: string[] = []
  const controller: SessionControllerLike = {
    create: async (req) => {
      calls.push(`create:${JSON.stringify(req ?? {})}`)
      return { sessionId: 'sess-new-1' }
    },
    rename: async (req) => {
      calls.push(`rename:${req.title}`)
      return undefined
    },
    prompt: async (req) => {
      calls.push(`prompt:${req.mode}:${req.content[0]?.text}`)
      return { accepted: true }
    },
    ...(overrides as object),
  }
  return { controller, calls }
}

// ---------- admitTakeover ----------

test('一键接管 take：建会话→改标题（带时间戳防同名堆积）→queue 投递单行指令，载荷与浏览器复制同源', async () => {
  const { controller, calls } = fakeController()
  const r = await admitTakeover(
    controller,
    { mode: 'take', provider: 'zcode', reference: 'sess-abc' },
    { resolve: async () => ({ ok: true, ref: { id: 'sess-abc', agent: 'zcode', title: '收件箱开发', cwd: '', updatedAt: 0, fingerprint: '', kind: 'sqlite' } }), random: () => 'rid-1' },
  )
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.match(r.title, /^接管：收件箱开发（\d{2}-\d{2} \d{2}:\d{2}）$/)
  assert.equal(r.sessionId, 'sess-new-1')
  assert.equal(calls.length, 3)
  assert.match(calls[0] ?? '', /^create:/)
  assert.match(calls[1] ?? '', /^rename:接管：收件箱开发（/)
  assert.match(calls[2] ?? '', /^prompt:queue:/)
  assert.match(calls[2] ?? '', /\/resume-zcode sess-abc/)
})

test('一键接管 take_deposit：投递两行式指令（与浏览器复制载荷同源同形）', async () => {
  const { controller, calls } = fakeController()
  const r = await admitTakeover(
    controller,
    { mode: 'take_deposit', provider: 'claude', reference: 'C:\\s\\a.jsonl' },
    { resolve: async () => ({ ok: true, ref: { id: 'C:\\s\\a.jsonl', agent: 'claude-code', title: '调试', cwd: '', updatedAt: 0, fingerprint: '', kind: 'file' } }) },
  )
  assert.equal(r.ok, true)
  const promptCall = calls.find((c) => c.startsWith('prompt:')) ?? ''
  const text = promptCall.slice(promptCall.indexOf(':') + 1 + ':queue:'.length)
  const lines = text.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[1] ?? '', /寄存/)
  assert.doesNotMatch(lines[1]?.charAt(0) ?? '', /\s/, '第二行不得有前导空白（esbuild 煮转义回归哨兵同款）')
})

test('一键取件 inbox：不需要 resolve，投递裸 /inbox（最小输入纪律）', async () => {
  const { controller, calls } = fakeController()
  const r = await admitTakeover(controller, { mode: 'inbox' }, { resolve: async () => { throw new Error('不该被调') } })
  assert.equal(r.ok, true)
  assert.match(calls.find((c) => c.startsWith('prompt:')) ?? '', /prompt:queue:\/inbox$/)
})

test('降级三连：解析失败原样透传 / create 缺 sessionId / prompt 抛错——全是规范错误值', async () => {
  const failResolve = async () => ({ ok: false as const, error: '找不到会话：x' })
  const r1 = await admitTakeover(fakeController().controller, { mode: 'take', provider: 'zcode', reference: 'x' }, { resolve: failResolve })
  assert.deepEqual(r1, { ok: false, error: '找不到会话：x' })

  const badCreate = fakeController({ create: async () => ({}) as { sessionId: string } })
  const r2 = await admitTakeover(badCreate.controller, { mode: 'inbox' })
  assert.equal(r2.ok, false)
  if (!r2.ok) assert.match(r2.error, /缺少 sessionId/)

  const boomPrompt = fakeController({ prompt: async () => { throw new Error('gateway down') } })
  const r3 = await admitTakeover(boomPrompt.controller, { mode: 'inbox' })
  assert.equal(r3.ok, false)
  if (!r3.ok) assert.match(r3.error, /gateway down/)
})

// ---------- 回归与 mode 白名单 ----------

test('S4：provider 归一化——"ZCode" 进指令前转小写，与解析层同一口径', async () => {
  const { controller, calls } = fakeController()
  let seenProvider = ''
  const r = await admitTakeover(
    controller,
    { mode: 'take', provider: 'ZCode', reference: 'sess-abc' },
    {
      resolve: (async (args: { provider?: string }) => {
        seenProvider = args?.provider ?? ''
        return { ok: true as const, ref: { id: 'sess-abc', agent: 'zcode', title: 'T', cwd: '', updatedAt: 0, fingerprint: '', kind: 'sqlite' } }
      }) as never,
    },
  )
  assert.equal(r.ok, true)
  assert.equal(seenProvider, 'zcode')
  assert.match(calls.find((c) => c.startsWith('prompt:')) ?? '', /\/resume-zcode sess-abc/)
})

test('S3：env 贯通 resolve——停用闸在 takeover 与读路由同口径', async () => {
  const seen: unknown[] = []
  const r = await admitTakeover(
    fakeController().controller,
    { mode: 'take', provider: 'claude', reference: 'x' },
    {
      resolve: (async (_args: unknown, _deps: unknown, env: unknown) => {
        seen.push(env)
        return { ok: false as const, error: '该 provider 已在设置中停用' }
      }) as never,
      env: { isEnabled: () => false },
    },
  )
  assert.equal(r.ok, false)
  assert.equal(seen.length, 1, 'env 必须随 resolve 传出')
})

test('S5：create 成功后 rename/prompt 失败——错误带孤儿会话 id（不隐瞒）', async () => {
  const boom = fakeController({ prompt: async () => { throw new Error('gateway down') } })
  const r = await admitTakeover(boom.controller, { mode: 'inbox' })
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.error, /gateway down/)
    assert.match(r.error, /已建会话 sess-new-1/)
    assert.equal(r.sessionId, 'sess-new-1')
  }
})

test('mode 白名单在核心层也拦（路由之外无绕过）', async () => {
  const r = await admitTakeover(fakeController().controller, { mode: 'garbage' as never })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /未知 mode/)
})

test('C8：take_deposit lang=en——第二行英文（载荷与 EN 用户的手动复制等价）', async () => {
  const { controller, calls } = fakeController()
  await admitTakeover(
    controller,
    { mode: 'take_deposit', provider: 'zcode', reference: 's1', lang: 'en' },
    { resolve: (async () => ({ ok: true as const, ref: { id: 's1', agent: 'zcode', title: 'T', cwd: '', updatedAt: 0, fingerprint: '', kind: 'sqlite' } })) as never },
  )
  assert.match(calls.find((c) => c.startsWith('prompt:')) ?? '', /deposit the six-section handoff card/i)
})

test('C4：取件带 reference——定向取件指令（点哪张取哪张）', async () => {
  const { controller, calls } = fakeController()
  await admitTakeover(controller, { mode: 'inbox', reference: 'ho-card-9' })
  assert.match(calls.find((c) => c.startsWith('prompt:')) ?? '', /取编号 ho-card-9 这张卡/)
})

// ---------- 路由级（S7）：守卫/降级/极端体，不崩宿主 ----------

function routeHandler(ctxExtra?: Record<string, unknown>, opts?: Parameters<typeof registerTakeoverRoutes>[1]): (req: IncomingMessage, res: ServerResponse) => void {
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
  const host = {
    effect: (fn: () => void): void => fn(),
    webServer: { register: (reg: { handler: typeof handler }): void => { handler = reg.handler } },
  }
  const ctx = { inject: (_deps: string[], cb: (h: typeof host) => void): void => cb(host), ...ctxExtra }
  registerTakeoverRoutes(ctx as unknown as Context, opts)
  if (handler === undefined) throw new Error('路由未注册')
  return handler
}

async function callRoute(
  handler: ReturnType<typeof routeHandler>,
  o: { method?: string; url?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  const { EventEmitter } = await import('node:events')
  return await new Promise((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), {
      method: o.method ?? 'POST',
      url: o.url ?? '/dsh-takeover/takeover',
      headers: o.headers ?? {},
      socket: { remoteAddress: '127.0.0.1' },
    })
    let settle: ((r: { status: number; body: string }) => void) | undefined
    const res = {
      statusCode: 0,
      writeHead(code: number): unknown { this.statusCode = code; return this },
      end(b?: string): void { if (settle !== undefined) settle({ status: this.statusCode, body: b ?? '' }) },
    }
    settle = (r) => resolve(r)
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)
    if (o.body !== undefined) req.emit('data', Buffer.from(o.body))
    req.emit('end')
  })
}

const ORIGIN = { host: 'localhost:3080', origin: 'http://localhost:3080' }

test('路由 S1：null 字面量体不崩宿主，回规范值（测试 ctx 无控制器 → 规范降级）', async () => {
  const handler = routeHandler()
  const r = await callRoute(handler, { headers: { ...ORIGIN }, body: 'null' })
  assert.equal(r.status, 200)
  assert.equal((JSON.parse(r.body) as { ok: boolean }).ok, false)
})

test('路由 S7：无 Origin 403；缺控制器规范降级；未知 mode 规范错误', async () => {
  const handler = routeHandler()
  const forbidden = await callRoute(handler, { headers: { host: 'localhost:3080' }, body: '{"mode":"inbox"}' })
  assert.equal(forbidden.status, 403)

  const degraded = await callRoute(routeHandler(), { headers: { ...ORIGIN }, body: '{"mode":"inbox"}' })
  assert.equal(degraded.status, 200)
  assert.match((JSON.parse(degraded.body) as { error: string }).error, /宿主缺会话控制器/)

  const withCtrl = routeHandler({ root: { sessionController: fakeController().controller } })
  const badMode = await callRoute(withCtrl, { headers: { ...ORIGIN }, body: '{"mode":"delete-all"}' })
  assert.equal(badMode.status, 200)
  assert.match((JSON.parse(badMode.body) as { error: string }).error, /未知 mode/)
})

test('路由 S3：停用 provider 一键接管被拒（env 贯通路由）', async () => {
  const handler = routeHandler({ root: { sessionController: fakeController().controller } }, { takeoverEnv: { isEnabled: () => false } })
  const r = await callRoute(handler, { headers: { ...ORIGIN }, body: '{"mode":"take","provider":"claude","reference":"x"}' })
  assert.equal(r.status, 200)
  assert.match((JSON.parse(r.body) as { error: string }).error, /停用/)
})

test('路由 S8：同键短窗去重——两次同体请求只真实投递一次（防重复建会话）', async () => {
  const { controller, calls } = fakeController()
  const handler = routeHandler({ root: { sessionController: controller } })
  const r1 = await callRoute(handler, { headers: { ...ORIGIN }, body: '{"mode":"inbox"}' })
  const r2 = await callRoute(handler, { headers: { ...ORIGIN }, body: '{"mode":"inbox"}' })
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  const creates = calls.filter((c) => c.startsWith('create:')).length
  assert.equal(creates, 1, `同键去重失效：create 被调了 ${creates} 次`)
  assert.equal((JSON.parse(r2.body) as { ok: boolean }).ok, true, '去重命中的第二次请求也回成功结果')
})

test('路由：不同键不去重（不同卡各投各的）', async () => {
  const { controller, calls } = fakeController()
  const handler = routeHandler({ root: { sessionController: controller } })
  await callRoute(handler, { headers: { ...ORIGIN }, body: '{"mode":"inbox","reference":"ho-a"}' })
  await callRoute(handler, { headers: { ...ORIGIN }, body: '{"mode":"inbox","reference":"ho-b"}' })
  assert.equal(calls.filter((c) => c.startsWith('create:')).length, 2)
})

// ---------- sessionControllerOf：防御访问 ----------

test('sessionControllerOf：官方形态可用；根层可达（cordis inject 纪律）；缺方法/属性缺失抛错全回 undefined', () => {
  const good = sessionControllerOf({ sessionController: fakeController().controller })
  assert.notEqual(good, undefined)

  // 真宿主形态：服务挂根层，插件 ctx 未 inject（直接取抛「without inject」）——沿 root 达
  const rootHit = sessionControllerOf({ root: { sessionController: fakeController().controller } })
  assert.notEqual(rootHit, undefined)

  // 两层都不可达 → undefined，绝不抛出
  const bothThrow = sessionControllerOf({
    get root(): never { throw new Error('no root') },
    get sessionController(): never { throw new Error('cannot get property without inject') },
  })
  assert.equal(bothThrow, undefined)

  assert.equal(sessionControllerOf({ root: { sessionController: { create: () => {} } } }), undefined)
  assert.equal(sessionControllerOf({ root: { get sessionController(): never { throw new Error('x') } } }), undefined)
  assert.equal(sessionControllerOf({ root: { sessionController: 'not-an-object' } }), undefined)
  assert.equal(sessionControllerOf({}), undefined)
})

// ---------- foreignResolveOne ----------

test('foreignResolveOne：空引用在触 readers 前被拦（规范错误）；歧义附候选；正常解析出 ref', async () => {
  const empty = await foreignResolveOne({ provider: 'claude', reference: '' }, {
    listSessions: () => [],
    resolve: () => { throw new Error('不该被调') },
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
  })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.match(empty.error, /缺少会话引用/)

  const amb = await foreignResolveOne({ provider: 'claude', reference: '会话' }, {
    listSessions: () => [],
    resolve: () => ({ kind: 'ambiguous', candidates: [
      { id: 'a', agent: 'claude-code', title: '会话一', cwd: '', updatedAt: 0, fingerprint: '', kind: 'file' },
      { id: 'b', agent: 'claude-code', title: '会话二', cwd: '', updatedAt: 0, fingerprint: '', kind: 'file' },
    ] }),
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
  })
  assert.equal(amb.ok, false)
  if (!amb.ok) assert.equal(amb.candidates?.length, 2)

  const ok = await foreignResolveOne({ provider: 'claude', reference: 'a' }, {
    listSessions: () => [],
    resolve: () => ({ kind: 'resolved', ref: { id: 'a', agent: 'claude-code', title: '会话一', cwd: '', updatedAt: 0, fingerprint: '', kind: 'file' } }),
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
  })
  assert.equal(ok.ok, true)
})

// ---------- 短横车与 facet：子代理判定与项目 facet ----------

const ROWS: SessionRow[] = [
  { id: 'sess_main_1', title: '正式工作', cwd: 'D:\\work\\dsh', updatedAt: '', kind: 'sqlite' },
  { id: 'sess_subagent_a1', title: '随便', cwd: 'D:\\work\\dsh', updatedAt: '', kind: 'sqlite' },
  { id: 'sess_dwf-x-actor', title: 'workflow subagent actor#1@1', cwd: 'D:\\work\\lab', updatedAt: '', kind: 'sqlite' },
  { id: 'sess_main_2', title: 'workflow 指南', cwd: 'D:\\work\\lab', updatedAt: '', kind: 'sqlite' },
]

test('isSubagentSession：三种既见模式命中；普通标题含关键词不误伤', () => {
  assert.equal(isSubagentSession(ROWS[0]!), false)
  assert.equal(isSubagentSession(ROWS[1]!), true, 'id 前缀 sess_subagent_')
  assert.equal(isSubagentSession(ROWS[2]!), true, 'id 前缀 sess_dwf- 与标题模式双命中')
  assert.equal(isSubagentSession(ROWS[3]!), false, '「workflow 指南」是正经会话——标题必须以 workflow subagent/actor 开头才判')
})

test('cwdFacets + filterByCwd：basename 计数排序、空 cwd 归「—」桶、过滤可叠加', () => {
  const rows: SessionRow[] = [
    ...ROWS,
    { id: 'sess_x', title: '无目录', cwd: '', updatedAt: '', kind: 'sqlite' },
  ]
  const facets = cwdFacets(rows)
  assert.equal(facets[0]?.label, 'dsh')
  assert.equal(facets[0]?.count, 2)
  assert.deepEqual(filterByCwd(rows, null).length, 5)
  assert.equal(filterByCwd(rows, 'D:\\work\\lab').length, 2)
  assert.equal(filterByCwd(rows, '').length, 1, '空 cwd 桶可被选为过滤')
})

// ---------- 一键接管闭环 v2：投递后自动切换会话（uiWorkspace） ----------

test('uiNavigatorOf：宿主 uiWorkspace 可达时切会话并返回 true；缺席/抛错/形态不符全回 false', () => {
  const opened: string[] = []
  const ok = uiNavigatorOf({ get: (name: string) => (name === 'uiWorkspace' ? { openSession: (id: string) => { opened.push(id) } } : undefined) })
  assert.equal(ok('sess-9'), true)
  assert.deepEqual(opened, ['sess-9'])

  // cordis 纪律：未挂载服务的 get 会 throw——不抛出，回 false 降级
  const throwing = uiNavigatorOf({ get: () => { throw new Error('cannot get property without inject') } })
  assert.equal(throwing('sess-9'), false)

  assert.equal(uiNavigatorOf({})( 'sess-9'), false)
  assert.equal(uiNavigatorOf({ get: () => 'not-an-object' })('sess-9'), false)
  assert.equal(uiNavigatorOf({ get: () => ({ openSession: 'nope' }) })('sess-9'), false)
})

// ---------- 卡链历史路由（GET /dsh-takeover/history）：读守卫同 state，inboxHistory 直连 ----------

test('路由：GET history 回环同源 200（ok:true + action:history）；跨站 403；POST 405', async () => {
  const handler = routeHandler()
  const ok = await callRoute(handler, {
    method: 'GET',
    url: '/dsh-takeover/history?project=alpha',
    headers: { host: 'localhost:3080', 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.body) as { ok: boolean; action?: string; cards?: unknown[] }
  assert.equal(body.ok, true, '历史回查是业务只读面，照常返回规范值')
  assert.equal(body.action, 'history')
  assert.ok(Array.isArray(body.cards))
  // 读守卫与 state 同款：跨站 sec-fetch-site 拒绝
  const forbidden = await callRoute(handler, {
    method: 'GET',
    url: '/dsh-takeover/history',
    headers: { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(forbidden.status, 403)
  // 写方法不进历史路由
  const post = await callRoute(handler, { method: 'POST', url: '/dsh-takeover/history', headers: { ...ORIGIN }, body: '{}' })
  assert.equal(post.status, 405)
})

// ---------- 0.26 集成接线：state 可选 sessionId → contextHealth；takeover 响应附 state；dismiss 落 abandoned ----------

/** 有比率口径的假会话：900/1000 = 0.9 ≥ CRITICAL_RATIO(0.85) → critical（contexthealth 探针立约） */
function contextSession(home: string): unknown {
  return {
    id: 'sess-ctx-1',
    header: { cwd: home },
    snapshotEvents: () => [{ type: 'assistant/message', seq: 1, data: { usage: { totalTokens: 900 } } }],
    requestContext: () => ({ contextWindow: 1000 }),
  }
}

test('路由：GET state 无参零变化（contextHealth 缺省）；带 sessionId 且会话在场 → 附预警', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-route-state-'))
  process.env.HANDOFF_HOME = home
  try {
    const handler = routeHandler({ root: { sessions: { get: (id: string) => (id === 'sess-ctx-1' ? contextSession(home) : undefined) } } })
    const guard = { host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }
    const bare = await callRoute(handler, { method: 'GET', url: '/dsh-takeover/state', headers: guard })
    assert.equal(bare.status, 200)
    assert.equal('contextHealth' in (JSON.parse(bare.body) as Record<string, unknown>), false, '无参请求响应零变化（向后兼容扩展）')

    const withSession = await callRoute(handler, { method: 'GET', url: '/dsh-takeover/state?sessionId=sess-ctx-1', headers: guard })
    assert.equal(withSession.status, 200)
    const body = JSON.parse(withSession.body) as { contextHealth?: { level?: string; ratio?: number; action?: string | null } }
    assert.equal(body.contextHealth?.level, 'critical', '900/1000=0.9 ≥ CRITICAL_RATIO → critical')
    assert.equal(body.contextHealth?.action, 'lifeboat', 'critical 的建议动作是救生艇')
    assert.ok(typeof body.contextHealth?.ratio === 'number', '比率口径双在场时 ratio 在场')

    const missing = await callRoute(handler, { method: 'GET', url: '/dsh-takeover/state?sessionId=sess-absent', headers: guard })
    assert.equal('contextHealth' in (JSON.parse(missing.body) as Record<string, unknown>), false, '会话缺席 → 字段缺省')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('路由：takeover 成功响应附全量 state——带座位 sessionId 时预警态随动作响应即时回显', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-route-takeover-state-'))
  process.env.HANDOFF_HOME = home
  try {
    const { controller } = fakeController()
    const handler = routeHandler({ root: { sessionController: controller, sessions: { get: (id: string) => (id === 'sess-ctx-1' ? contextSession(home) : undefined) } } })
    const r = await callRoute(handler, { headers: { ...ORIGIN }, body: '{"mode":"inbox","sessionId":"sess-ctx-1"}' })
    assert.equal(r.status, 200)
    const b = JSON.parse(r.body) as { ok: boolean; sessionId?: string; state?: { contextHealth?: { level?: string } } }
    assert.equal(b.ok, true)
    assert.equal(b.sessionId, 'sess-new-1')
    assert.ok(b.state !== undefined && typeof b.state === 'object', '成功响应附全量 state（lifeboat/provider/sync 端点同款免等 30s 轮询）')
    assert.equal(b.state?.contextHealth?.level, 'critical', '座位会话在场 → contextHealth 随响应回显')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('路由：dismiss-pending 成功落 abandoned 生命周期事件（target=卡 id，延续账本闭集）', async () => {
  const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-route-dismiss-'))
  mkdirSync(join(home, 'pending'), { recursive: true })
  process.env.HANDOFF_HOME = home
  try {
    writeFileSync(join(home, 'pending', 'ho-dismiss-0001.md'), ['---', 'handoff: 1', 'id: ho-dismiss-0001', '---', '## 目标', '', '弃置账本钉', ''].join('\n'), 'utf-8')
    const handler = routeHandler()
    const r = await callRoute(handler, { url: '/dsh-takeover/dismiss-pending', headers: { ...ORIGIN }, body: '{"id":"ho-dismiss-0001"}' })
    assert.equal(r.status, 200)
    const b = JSON.parse(r.body) as { ok: boolean; moved?: number }
    assert.equal(b.ok, true)
    assert.ok((b.moved ?? 0) >= 1)
    const lifecycle = readFileSync(join(home, 'lifecycle.jsonl'), 'utf-8')
    assert.match(lifecycle, /"reason":"abandoned"/, '弃置也是账本事件（未取件即清）')
    assert.match(lifecycle, /"target":"ho-dismiss-0001"/)
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------- 0.26 扩展波接线：triage 三动作端点（pin/unpin/restore-archived）+ state 检索/体检 ----------

const GUARD = { host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }

test('路由：pin/unpin——sameOrigin 门 + id 消毒（路径分隔符剥掉）+ 幂等落 pins.json；无 Origin 403', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-route-pin-'))
  process.env.HANDOFF_HOME = home
  try {
    const handler = routeHandler()
    // sameOrigin 门：无 Origin 的 POST 一律 403（与 dismiss-pending 同款纪律）
    const noOrigin = await callRoute(handler, { url: '/dsh-takeover/pin', headers: { host: 'localhost:3080' }, body: '{"id":"ho-a"}' })
    assert.equal(noOrigin.status, 403)
    // GET 不进写路由
    const wrongMethod = await callRoute(handler, { method: 'GET', url: '/dsh-takeover/pin', headers: { ...ORIGIN } })
    assert.equal(wrongMethod.status, 405)

    // 置顶：id 带路径分隔符被消毒（'../ho-x' → '..ho-x'，穿越面进不了文件名寻址）
    const r = await callRoute(handler, { url: '/dsh-takeover/pin', headers: { ...ORIGIN }, body: '{"id":" ../ho-x "}' })
    assert.equal(r.status, 200)
    const b = JSON.parse(r.body) as { ok: boolean; action?: string }
    assert.equal(b.ok, true)
    assert.equal(b.action, 'pin')
    const pins = JSON.parse(readFileSync(join(home, 'pins.json'), 'utf-8')) as Record<string, string>
    assert.ok('..ho-x' in pins, 'id 消毒：trim + 去路径分隔符（dismissPending 同款），消毒后的 id 落 pins.json')

    // 幂等：重复置顶只刷新时间戳，不报错
    const again = await callRoute(handler, { url: '/dsh-takeover/pin', headers: { ...ORIGIN }, body: '{"id":"..ho-x"}' })
    assert.equal((JSON.parse(again.body) as { ok: boolean }).ok, true)

    // 取消置顶：在册才成功；空 id 回规范错误值
    const un = await callRoute(handler, { url: '/dsh-takeover/unpin', headers: { ...ORIGIN }, body: '{"id":"..ho-x"}' })
    assert.equal((JSON.parse(un.body) as { ok: boolean }).ok, true)
    const unAgain = await callRoute(handler, { url: '/dsh-takeover/unpin', headers: { ...ORIGIN }, body: '{"id":"..ho-x"}' })
    assert.equal(unAgain.status, 400, '未置顶再取消 = 规范错误值（诚实两态）')
    const emptyId = await callRoute(handler, { url: '/dsh-takeover/pin', headers: { ...ORIGIN }, body: '{"id":"  "}' })
    assert.equal(emptyId.status, 400)
    assert.match((JSON.parse(emptyId.body) as { error: string }).error, /id 不能为空/)
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('路由：restore-archived——dismiss 后恢复回 pending（整卡搬回 + 落账 restored）；不存在回规范错误', async () => {
  const { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-route-restore-'))
  mkdirSync(join(home, 'pending'), { recursive: true })
  process.env.HANDOFF_HOME = home
  try {
    writeFileSync(join(home, 'pending', 'ho-restore-0001.md'), ['---', 'handoff: 1', 'id: ho-restore-0001', '---', '## 目标', '', '恢复往返钉', ''].join('\n'), 'utf-8')
    const handler = routeHandler()
    // 先弃置（既有端点）
    const dismiss = await callRoute(handler, { url: '/dsh-takeover/dismiss-pending', headers: { ...ORIGIN }, body: '{"id":"ho-restore-0001"}' })
    assert.equal((JSON.parse(dismiss.body) as { ok: boolean }).ok, true)
    assert.equal(existsSync(join(home, 'pending', 'ho-restore-0001.md')), false)

    // 恢复：archived → pending，lifecycle 落 restored
    const r = await callRoute(handler, { url: '/dsh-takeover/restore-archived', headers: { ...ORIGIN }, body: '{"id":"ho-restore-0001"}' })
    assert.equal(r.status, 200)
    const b = JSON.parse(r.body) as { ok: boolean; action?: string; moved?: number }
    assert.equal(b.ok, true)
    assert.equal(b.action, 'restore-archived')
    assert.ok((b.moved ?? 0) >= 1, '整卡搬回（.md 至少一份）')
    assert.equal(existsSync(join(home, 'pending', 'ho-restore-0001.md')), true, '恢复后重新在收件箱可见')

    // sameOrigin 门：无 Origin 403
    const noOrigin = await callRoute(handler, { url: '/dsh-takeover/restore-archived', headers: { host: 'localhost:3080' }, body: '{"id":"x"}' })
    assert.equal(noOrigin.status, 403)

    // 不存在的 id / 二次恢复：规范错误值 400
    const gone = await callRoute(handler, { url: '/dsh-takeover/restore-archived', headers: { ...ORIGIN }, body: '{"id":"ho-restore-0001"}' })
    assert.equal(gone.status, 400, '已在 pending（archived 无形态）→ 拒绝，不静默成功')
    const never = await callRoute(handler, { url: '/dsh-takeover/restore-archived', headers: { ...ORIGIN }, body: '{"id":"ho-never-9999"}' })
    assert.equal(never.status, 400)
    assert.match((JSON.parse(never.body) as { error: string }).error, /没有这张卡/)
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('路由：GET state 增量面——pins/doctor 常驻（pins.json 与体检报告）；?q= 检索附 inboxQuery（includeBody=1 走正文）；无 q 无 inboxQuery（无参零变化钉延伸）', async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-route-state-triage-'))
  mkdirSync(join(home, 'pending'), { recursive: true })
  process.env.HANDOFF_HOME = home
  try {
    // 完整六段 + 规范 frontmatter：总线干净（doctor 零发现），体检断言才能钉在 ok:true 上
    writeFileSync(
      join(home, 'pending', 'ho-query-0001.md'),
      [
        '---',
        'handoff: 1',
        'id: ho-query-0001',
        'from:',
        '  agent: dsh',
        '  session: sess-query-fix',
        '---',
        '## 目标',
        '',
        '把正文检索接进面板',
        '',
        '## 涉及文件',
        '',
        '- src/client.ts',
        '',
        '## 做到哪',
        '',
        '检索端点已接线',
        '',
        '## 还差什么',
        '',
        '面板复测',
        '',
        '## 停在哪',
        '',
        '独有正文词 QUARKFALL',
        '',
        '## 读者警告',
        '',
        '无',
        '',
      ].join('\n'),
      'utf-8',
    )
    const { setPin } = await import('../src/index.ts')
    setPin('ho-query-0001')
    const handler = routeHandler()

    // 无 q：inboxQuery 字段缺省（无参零变化钉延伸——contextHealth 同款向后兼容纪律）
    const bare = await callRoute(handler, { method: 'GET', url: '/dsh-takeover/state', headers: GUARD })
    assert.equal(bare.status, 200)
    const bareBody = JSON.parse(bare.body) as Record<string, unknown>
    assert.equal('inboxQuery' in bareBody, false, '无 q 参数 → inboxQuery 缺省')
    // pins 常驻（triage 接线：state.pins = 当前有效置顶，新置顶在前）
    assert.deepEqual(bareBody['pins'], ['ho-query-0001'], 'state.pins 随 pins.json 进 state')
    // doctor 常驻（doctor 接线：干净总线 ok:true 零发现）
    const doc = bareBody['doctor'] as { ok?: boolean; issues?: unknown[]; scanned?: Record<string, number> } | undefined
    assert.ok(doc !== undefined && typeof doc === 'object', 'state.doctor 体检报告并入 state')
    assert.equal(doc.ok, true, '干净总线零发现 ok:true')
    assert.deepEqual(doc.issues, [])
    assert.ok((doc.scanned?.pendingCards ?? 0) >= 1, '扫描覆盖面计数如实')

    // ?q= 元字段命中；includeBody=1 命中纯正文词（元字段查不到的）
    const metaHit = await callRoute(handler, { method: 'GET', url: `/dsh-takeover/state?q=${encodeURIComponent('ho-query')}&includeBody=1`, headers: GUARD })
    const metaBody = JSON.parse(metaHit.body) as { inboxQuery?: { hits: Array<{ id: string; where: string }>; scanned: number } }
    assert.equal(metaBody.inboxQuery?.hits.length, 1)
    assert.equal(metaBody.inboxQuery?.hits[0]?.where, 'meta+body', '编号与正文双命中 → meta+body')

    const bodyOnly = await callRoute(handler, { method: 'GET', url: `/dsh-takeover/state?q=${encodeURIComponent('QUARKFALL')}&includeBody=1`, headers: GUARD })
    const bodyOnlyBody = JSON.parse(bodyOnly.body) as { inboxQuery?: { hits: Array<{ id: string; where: string; lines: string[] }> } }
    assert.equal(bodyOnlyBody.inboxQuery?.hits.length, 1, 'includeBody=1：纯正文词命中')
    assert.equal(bodyOnlyBody.inboxQuery?.hits[0]?.where, 'body')
    assert.ok((bodyOnlyBody.inboxQuery?.hits[0]?.lines.length ?? 0) >= 1, '命中行摘要随命中带出')

    // 同词不勾含正文：纯正文词零命中（元字段口径，诚实两态）
    const metaOnly = await callRoute(handler, { method: 'GET', url: `/dsh-takeover/state?q=${encodeURIComponent('QUARKFALL')}`, headers: GUARD })
    const metaOnlyBody = JSON.parse(metaOnly.body) as { inboxQuery?: { hits: unknown[] } }
    assert.deepEqual(metaOnlyBody.inboxQuery?.hits, [], '不带 includeBody=1 → 只扫元字段，纯正文词不命中')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})
