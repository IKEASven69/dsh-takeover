/**
 * FR-1..4 回归：一键接管投递核心（admitTakeover）+ 会话控制器防御访问 +
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

test('一键接管 take：建会话→改标题→queue 投递单行指令，载荷与浏览器复制同源', async () => {
  const { controller, calls } = fakeController()
  const r = await admitTakeover(
    controller,
    { mode: 'take', provider: 'zcode', reference: 'sess-abc' },
    { resolve: async () => ({ ok: true, ref: { id: 'sess-abc', agent: 'zcode', title: '收件箱开发', cwd: '', updatedAt: 0, fingerprint: '', kind: 'sqlite' } }), random: () => 'rid-1' },
  )
  assert.deepEqual(r, { ok: true, sessionId: 'sess-new-1', title: '接管：收件箱开发' })
  assert.equal(calls.length, 3)
  assert.match(calls[0] ?? '', /^create:/)
  assert.match(calls[1] ?? '', /^rename:接管：收件箱开发/)
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

// ---------- 审查修复回归（S3/S4/S5/C4/C8 + mode 白名单） ----------

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

// ---------- FR-2 / FR-3：子代理判定与项目 facet ----------

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
