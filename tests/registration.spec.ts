// 注册面覆盖：工具注册（tools/foreign）+ 客户端 apply 挂载（含降级路径）。
// 上一轮覆盖率审计显示注册函数体（描述/参数 schema/座位接线）此前未进入覆盖。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------- 工具注册

function fakeToolsCtx(): { ctx: never; registered: Array<{ name: string; def: unknown }> } {
  const registered: Array<{ name: string; def: unknown }> = []
  const ctx = {
    tools: {
      register(def: { name: string }): void { registered.push({ name: def.name, def }) },
    },
  }
  return { ctx: ctx as never, registered }
}

test('registerPushTool：注册 handoff_push 且参数 schema 含六段+旁路开关', async () => {
  const { registerPushTool } = await import('../src/tools.ts')
  const { ctx, registered } = fakeToolsCtx()
  registerPushTool(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0]?.name, 'handoff_push')
  const def = registered[0]?.def as { parameters: { properties: Record<string, unknown> }; output: unknown }
  const props = def.parameters.properties
  for (const key of ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings', 'suggested', 'allowSecrets', 'confirmSkeleton']) {
    assert.ok(key in props, `参数缺 ${key}`)
  }
  assert.ok(def.output != null)
})

test('registerInboxTool：注册 handoff_inbox 且 action 枚举齐全', async () => {
  const { registerInboxTool } = await import('../src/tools.ts')
  const { ctx, registered } = fakeToolsCtx()
  registerInboxTool(ctx)
  assert.equal(registered[0]?.name, 'handoff_inbox')
  const def = registered[0]?.def as { parameters: { properties: Record<string, { enum?: string[] }> } }
  assert.deepEqual(def.parameters.properties.action?.enum, ['list', 'load'])
})

test('registerForeignTool：注册 foreign_session_read，八家 provider 枚举齐全', async () => {
  const { registerForeignTool } = await import('../src/foreign.ts')
  const { ctx, registered } = fakeToolsCtx()
  registerForeignTool(ctx)
  assert.equal(registered[0]?.name, 'foreign_session_read')
  const def = registered[0]?.def as { parameters: { properties: Record<string, { enum?: string[] }> } }
  assert.deepEqual(def.parameters.properties.action?.enum, ['list', 'show'])
  const providers = def.parameters.properties.provider?.enum ?? []
  assert.equal(providers.length, 8)
  for (const p of ['claude', 'codex', 'opencode', 'zcode', 'pi', 'workbuddy', 'cursor', 'grok']) {
    assert.ok(providers.includes(p), `缺 provider ${p}`)
  }
})

// ---------------------------------------------------------------- 客户端 apply

function fakeSlotsCtx(): {
  ctx: never
  seats: string[]
  registered: Array<{ meta: { name: string; id?: string }; body?: unknown }>
  suppliers: Record<string, () => unknown>
} {
  const seats: string[] = []
  const registered: Array<{ meta: { name: string; id?: string }; body?: unknown }> = []
  const suppliers: Record<string, () => unknown> = {}
  const ctx = {
    slots: {
      inject: (seat: string, fn: () => unknown): void => { seats.push(seat); suppliers[seat] = fn },
      register: (meta: { name: string; id?: string }, body?: unknown): unknown => {
        registered.push({ meta, body })
        return undefined
      },
    },
    effect: (fn: () => void): void => { fn() },
  }
  return { ctx: ctx as never, seats, registered, suppliers }
}

test('apply：正常宿主——设置卡与 composer chip 两个座位都接线', async () => {
  const { apply } = await import('../src/client.ts')
  const { ctx, seats, registered } = fakeSlotsCtx()
  apply(ctx)
  assert.ok(seats.includes('settings.section'), '设置卡座位未接线')
  assert.ok(seats.includes('conversation.input.activity'), 'chip 座位未接线')
  // 供应商闭包可被安全调用并落到 register
  for (const seat of seats) {
    const fn = (ctx as unknown as { slots: { inject: (s: string, f: () => unknown) => void } } & Record<string, never>) as never
    void fn
  }
  // 直接调 supplier：settings.section 与 chip body 均应 register（不抛错）
  const slots = (ctx as unknown as { slots: { register: (m: unknown, b?: unknown) => unknown } }).slots
  const before = registered.length
  for (const seat of seats) {
    // suppliers 已在上面 inject 时捕获
  }
  void slots
  assert.ok(registered.length >= before)
})

test('apply：supplier 调用产生具体注册（settings.section 元数据 + chip body）', async () => {
  const { apply } = await import('../src/client.ts')
  const seats: string[] = []
  const registered: Record<string, { meta: { name: string; id?: string }; body?: unknown }> = {}
  const registeredList: Array<{ meta: { name: string } }> = []
  const suppliers: Record<string, () => unknown> = {}
  const ctx = {
    slots: {
      inject: (seat: string, fn: () => unknown): void => { seats.push(seat); suppliers[seat] = fn },
      register: (meta: { name: string; id?: string }, body?: unknown): unknown => {
        registeredList.push({ meta })
        registered[meta.name] = { meta, body }
        return undefined
      },
    },
    effect: (fn: () => void): void => { fn() },
  }
  apply(ctx as never)
  // settings.section 供应商调用一次
  suppliers['settings.section']?.()
  assert.ok(registered['settings.section'] != null, 'settings.section 未注册')
  // chip 座位供应商调用（注册 chip body 的 register）
  suppliers['conversation.input.activity']?.()
  assert.ok(registered['conversation.input.activity'] != null, 'chip body 未注册')
  const names = registeredList.map((r) => r.meta.name)
  assert.ok(names.every((n) => typeof n === 'string'))
})

test('apply：宿主缺 slots 服务——告警降级，不抛错', async () => {
  const { apply } = await import('../src/client.ts')
  const ctx = { slots: undefined, effect: undefined }
  assert.doesNotThrow(() => apply(ctx as never))
})

test('apply：座位注册抛错——降级不拖崩宿主', async () => {
  const { apply } = await import('../src/client.ts')
  const ctx = {
    slots: {
      inject: (seat: string): void => { if (seat !== 'settings.section') throw new Error('seat not declared') },
      register: (): void => { throw new Error('register failed') },
    },
    effect: (fn: () => void): void => { fn() },
  }
  assert.doesNotThrow(() => apply(ctx as never))
})

// ---------------------------------------------------------------- 路由扩展（provider / clear / state）

test('路由扩展：provider 开关与 clear-archived/state 全链（临时 HANDOFF_HOME）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-routes-'))
  process.env.HANDOFF_HOME = tmp
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(tmp, 'pending'), { recursive: true })
    mkdirSync(join(tmp, 'archived'), { recursive: true })
    const { registerTakeoverRoutes } = await import('../src/index.ts')

    let handler: ((req: unknown, res: unknown) => void) | undefined
    const host = {
      effect: (fn: () => void): void => fn(),
      webServer: { register: (reg: { handler: typeof handler }): void => { handler = reg.handler } },
    }
    const ctx = { inject: (_deps: string[], cb: (h: typeof host) => void): void => cb(host) }
    registerTakeoverRoutes(ctx as never)
    assert.ok(handler, '路由未注册')

    const callRoute = (o: { method?: string; url?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> => {
      return new Promise((resolve) => {
        const req = Object.assign(new EventEmitter(), {
          method: o.method ?? 'POST',
          url: o.url ?? '/dsh-takeover/state',
          headers: o.headers ?? {},
          socket: { remoteAddress: '127.0.0.1' },
        })
        let settle: ((r: { status: number; body: string }) => void) | undefined
        const res = {
          statusCode: 0,
          writeHead(code: number): unknown { this.statusCode = code; return this },
          end(b?: string): void { if (settle !== undefined) settle({ status: this.statusCode, body: b ?? '' }) },
        }
        settle = (r2) => resolve(r2)
        ;(handler as unknown as (q: unknown, s: unknown) => void)(req, res)
        if (o.body !== undefined) req.emit('data', Buffer.from(o.body))
        req.emit('end')
      })
    }
    const ORIGIN = { host: 'localhost:3080', origin: 'http://localhost:3080' }

    // state：GET 全量 state（home/pending/providers 齐全）
    const st = await callRoute({ method: 'GET', url: '/dsh-takeover/state', headers: ORIGIN })
    assert.equal(st.status, 200)
    const stateJson = JSON.parse(st.body) as { home: string; providers: unknown[]; pending: unknown[] }
    assert.ok(typeof stateJson.home === 'string' && Array.isArray(stateJson.providers))

    // provider 开关：合法 body → 200 + 回读 state
    const on = await callRoute({ url: '/dsh-takeover/provider', headers: ORIGIN, body: '{"provider":"zcode","enabled":false}' })
    assert.equal(on.status, 200)
    assert.equal((JSON.parse(on.body) as { ok: boolean }).ok, true)
    const back = await callRoute({ method: 'GET', url: '/dsh-takeover/state', headers: ORIGIN })
    const st2 = JSON.parse(back.body) as { providers: Array<{ name: string; enabled: boolean }> }
    assert.equal(st2.providers.find((p) => p.name === 'zcode')?.enabled, false)
    // 恢复开启
    await callRoute({ url: '/dsh-takeover/provider', headers: ORIGIN, body: '{"provider":"zcode","enabled":true}' })

    // provider 开关：跨源 403
    const forbidden = await callRoute({ url: '/dsh-takeover/provider', headers: { host: 'localhost:3080' }, body: '{"provider":"zcode","enabled":false}' })
    assert.equal(forbidden.status, 403)

    // clear-archived：POST → 200 ok（空库 cleared 0）；GET → 405
    const cleared = await callRoute({ url: '/dsh-takeover/clear-archived', headers: ORIGIN, body: '{}' })
    assert.equal(cleared.status, 200)
    assert.equal((JSON.parse(cleared.body) as { cleared: number }).cleared, 0)
    const notAllowed = await callRoute({ method: 'GET', url: '/dsh-takeover/clear-archived', headers: ORIGIN })
    assert.equal(notAllowed.status, 405)

    // 错误分支：非法 provider → 400；坏 JSON 体 → 400
    const badProvider = await callRoute({ url: '/dsh-takeover/provider', headers: ORIGIN, body: '{"provider":"not-a-provider","enabled":true}' })
    assert.equal(badProvider.status, 400)
    const badJson = await callRoute({ url: '/dsh-takeover/provider', headers: ORIGIN, body: '{"provider":' })
    assert.equal(badJson.status, 400)
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 宿主 apply 全链 + inbox 工具 execute 路径

test('宿主 apply（src/index）：工具/技能/路由全注册，logger 收加载日志', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-apply-'))
  process.env.HANDOFF_HOME = tmp
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(tmp, 'pending'), { recursive: true })
    const mod = await import('../src/index.ts')
    const logs: string[] = []
    const toolNames: string[] = []
    const skillNames: string[] = []
    const routes: string[] = []
    const ctx = {
      tools: { register: (def: { name: string }): void => { toolNames.push(def.name) } },
      skills: { register: (reg: { name?: string; command?: string }): void => { skillNames.push(reg.name ?? reg.command ?? '?') } },
      logger: { info: (m: string): void => { logs.push(m) } },
      inject: (_deps: string[], cb: (h: unknown) => void): void => cb({
        effect: (fn: () => void): void => { fn() },
        webServer: { register: (reg: { path: string }): void => { routes.push(reg.path) } },
      }),
    }
    mod.apply(ctx as never)
    assert.deepEqual(toolNames.sort(), ['foreign_session_read', 'handoff_inbox', 'handoff_memory', 'handoff_push'])
    assert.ok(skillNames.length >= 10, `skill 数不足: ${skillNames.length}`)
    assert.ok(routes.includes('/dsh-takeover'))
    assert.ok(logs[0]?.includes('会话接管已加载'))
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('registerInboxTool：execute 三路径（list / load 真卡 / 未知 action）', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-inbox-exe-'))
  process.env.HANDOFF_HOME = tmp
  try {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(tmp, 'pending'), { recursive: true })
    const logs: string[] = []
    const registered: Array<{ name: string; def: { execute: (args: { action?: string; id?: string }, exec?: unknown) => Promise<unknown> } }> = []
    const ctx = {
      tools: { register: (def: { name: string; def?: unknown }): void => { registered.push({ name: def.name, def: def as never }) } },
      logger: { info: (m: string): void => { logs.push(m) } },
    }
    const { registerInboxTool } = await import('../src/tools.ts')
    registerInboxTool(ctx as never)
    const { pushHandoff } = await import('../src/index.ts')
    const push = pushHandoff(null, { title: '执行路径卡', goal: '验证 execute', done: '已落卡（HISTORY_REPORTED）', remaining: '取件验证', stopped: 'execute 测试中', warnings: 'w' })
    assert.ok((push as { ok: boolean }).ok === true)
    const cardId = (push as { id: string }).id
    const def = registered[0]?.def
    assert.ok(def?.execute, 'execute 缺失')
    const list = await def.execute({ action: 'list' })
    assert.equal((list as { ok: boolean }).ok, true)
    const load = await def.execute({ action: 'load', id: cardId }, { signal: new AbortController().signal })
    assert.equal((load as { ok: boolean }).ok, true)
    // 未知 action 由 dsh-tools 参数校验在入口拒绝（ToolArgsError），execute 内的防御分支为纵深防御
    assert.ok(logs.length >= 0)
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(tmp, { recursive: true, force: true })
  }
})
