// 0.26 第三波集成接线守门：四个新模块（ledger / sendto / almanac / preflight）进宿主面 +
// 「运行中」筛选（需求缺口 hkkz9522#61 + context#266）。覆盖面：
// - 三桶分组立约一致性（host 半 directed.bucketOf ↔ 客户端面 inbox-view.addressBucketOf）；
// - 运行证据纯函数（宿主存活面 × relay 溯源 → 正向证据集，绝不编否定）；
// - 路由面：GET state?ledger=1 展开（无参零变化）、GET preflight 三档判定卡；
// - state 面：PendingRow.to 透传 + state.machineName；
// - DOM 面：收件箱点名徽标/筛选、浏览器运行中筛选、接管预检前置闸三态。
import './ui-dom-setup.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cloneElement, createElement, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { generateId, writeCard, type Card } from '@agent-handoff/core'

// ---------------------------------------------------------------- host 半纯函数

import { bucketOf, readMachineName } from '../src/directed.ts'
import { addressBucketOf, pointedMachineOf } from '../src/inbox-view.ts'
import { runningSourceIdsOf, relaySourceIdOf, attachRunningIds, RUNNING_LIVE_MAX } from '../src/server.ts'
import { buildState, type TakeoverState } from '../src/settings.ts'
import type { ForeignReaders } from '../src/foreign.ts'
import {
  skillRegistrations,
  LEDGER_SKILL_CONTENT,
  SENDTO_SKILL_CONTENT,
  ALMANAC_SKILL_CONTENT,
  registerTakeoverRoutes,
} from '../src/index.ts'

// ---------- 三桶分组：立约（directed.bucketOf）与客户端面（inbox-view.addressBucketOf）一致 ----------

const CASES: Array<{ name: string; to: unknown; self: string; want: 'mine' | 'others' | 'any' }> = [
  { name: '点名本机（小写同名）', to: 'machine:lap-b', self: 'lap-b', want: 'mine' },
  { name: '点名本机（大小写不敏感）', to: 'machine:LAP-B', self: 'lap-b', want: 'mine' },
  { name: '点名别机', to: 'machine:lap-c', self: 'lap-b', want: 'others' },
  { name: 'to 带首尾空白仍正确分组', to: '  machine:lap-b  ', self: 'lap-b', want: 'mine' },
  { name: '空机器名 → any', to: 'machine:', self: 'lap-b', want: 'any' },
  { name: '机器名含路径分隔符 → any（不冒领坏数据）', to: 'machine:../etc', self: 'lap-b', want: 'any' },
  { name: 'agent 名寻址 → any', to: 'claude', self: 'lap-b', want: 'any' },
  { name: '缺省 any → any', to: 'any', self: 'lap-b', want: 'any' },
  { name: 'to 缺席 → any', to: undefined, self: 'lap-b', want: 'any' },
  { name: 'to 非串 → any', to: 42, self: 'lap-b', want: 'any' },
  { name: '本机名缺席 → 点名卡归 others（绝不误收）', to: 'machine:lap-b', self: '', want: 'others' },
  { name: 'null 行 → any', to: 'machine:lap-b', self: 'lap-b', want: 'any' },
]

test('三桶分组：directed.bucketOf 与 inbox-view.addressBucketOf 对照矩阵逐案一致', () => {
  for (const c of CASES) {
    const row = { to: c.to }
    const a = c.name === 'null 行 → any' ? bucketOf(null, c.self) : bucketOf(row, c.self)
    const b = c.name === 'null 行 → any' ? addressBucketOf(null, c.self) : addressBucketOf(row, c.self)
    assert.equal(a, c.want, `directed.bucketOf：${c.name}`)
    assert.equal(b, c.want, `inbox-view.addressBucketOf：${c.name}`)
  }
})

test('pointedMachineOf：machine: 地址抠点名机器名（小写规约）；非点名/消毒不过回空串', () => {
  assert.equal(pointedMachineOf('machine:LAP-B'), 'lap-b')
  assert.equal(pointedMachineOf('  machine:lap-c  '), 'lap-c')
  assert.equal(pointedMachineOf('any'), '')
  assert.equal(pointedMachineOf('machine:'), '')
  assert.equal(pointedMachineOf(undefined), '')
})

// ---------- 运行证据：宿主存活面 × relay 溯源（正向证据集） ----------

test('runningSourceIdsOf：存活会话的溯源 sourceId 进集（去重字典序）；缺 id / 无溯源跳过不编', () => {
  const sessions = [
    { id: 'dsh-1' }, // 溯源 → ext-b
    { id: 'dsh-2' }, // 溯源 → ext-a
    { id: 'dsh-3' }, // 溯源缺席（空串）→ 无证据
    { id: '' }, // 空 id 跳过
    'not-an-object', // 非对象跳过
    null,
  ]
  const out = runningSourceIdsOf(sessions, (id) => (id === 'dsh-1' ? 'ext-b' : id === 'dsh-2' ? 'ext-a' : ''))
  assert.deepEqual(out, ['ext-a', 'ext-b'])
})

test('runningSourceIdsOf：封顶 RUNNING_LIVE_MAX——异常膨胀的存活清单不放大读', () => {
  const big = Array.from({ length: RUNNING_LIVE_MAX + 50 }, (_, i) => ({ id: `dsh-${i}` }))
  let calls = 0
  const out = runningSourceIdsOf(big, (id) => { calls += 1; return `ext-${id}` })
  assert.equal(calls, RUNNING_LIVE_MAX, '溯源读取次数被存活封顶截住')
  assert.equal(out.length, RUNNING_LIVE_MAX)
})

test('relaySourceIdOf：relay/<id>.json 的 sourceId（隔离 HOME）；缺文件/坏 JSON/形态不符回空串不抛', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-wiring-relay-'))
  const prev = process.env.HANDOFF_HOME
  process.env.HANDOFF_HOME = home
  try {
    assert.equal(relaySourceIdOf('nope'), '', '缺文件 → 空串（无证据）')
    mkdirSync(join(home, 'relay'), { recursive: true })
    writeFileSync(join(home, 'relay', 'dsh-1.json'), JSON.stringify({ sessionId: 'dsh-1', sourceId: 'ext-9', provider: 'claude', at: '2026-11-20T00:00:00Z' }))
    assert.equal(relaySourceIdOf('dsh-1'), 'ext-9')
    writeFileSync(join(home, 'relay', 'dsh-2.json'), '{broken')
    assert.equal(relaySourceIdOf('dsh-2'), '', '坏 JSON → 空串')
    writeFileSync(join(home, 'relay', 'dsh-3.json'), JSON.stringify({ sessionId: 'dsh-3' }))
    assert.equal(relaySourceIdOf('dsh-3'), '', 'sourceId 缺席 → 空串')
    writeFileSync(join(home, 'relay', 'dsh-4.json'), JSON.stringify([1, 2]))
    assert.equal(relaySourceIdOf('dsh-4'), '', '数组形态 → 空串')
  } finally {
    if (prev === undefined) delete process.env.HANDOFF_HOME
    else process.env.HANDOFF_HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
})

test('attachRunningIds：ok:true 附 runningIds；ok:false 不附；供数抛错字段缺省不拦列表', () => {
  const ok = attachRunningIds({ ok: true, sessions: [] }, () => ['ext-1'])
  assert.deepEqual((ok as { runningIds?: string[] }).runningIds, ['ext-1'])
  const fail = attachRunningIds({ ok: false, error: 'x' }, () => ['ext-1'])
  assert.equal('runningIds' in fail, false, '失败值没有列表，没有证据位')
  const boom = attachRunningIds({ ok: true, sessions: [] }, () => { throw new Error('宿主炸了') })
  assert.equal('runningIds' in boom, false, '供数意外 → 字段缺省（证据是增益不是前置）')
})

// ---------- 路由面：state?ledger=1 展开 / preflight 三档判定卡 ----------

function routeHandler(ctxExtra?: Record<string, unknown>, opts?: Parameters<typeof registerTakeoverRoutes>[1]): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void {
  let handler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) | undefined
  const host = {
    effect: (fn: () => void): void => fn(),
    webServer: { register: (reg: { handler: typeof handler }): void => { handler = reg.handler } },
  }
  const ctx = { inject: (_deps: string[], cb: (h: typeof host) => void): void => cb(host), ...ctxExtra }
  registerTakeoverRoutes(ctx as never, opts)
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
      method: o.method ?? 'GET',
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
    settle = (r) => resolve(r)
    handler(req as unknown as import('node:http').IncomingMessage, res as unknown as import('node:http').ServerResponse)
    if (o.body !== undefined) req.emit('data', Buffer.from(o.body))
    req.emit('end')
  })
}

const GUARD = { host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }

test('路由：GET state 无参零变化（ledger 缺省）；?ledger=1 → 附 state.ledger 五键聚合', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-wiring-ledger-'))
  process.env.HANDOFF_HOME = home
  try {
    const handler = routeHandler()
    const bare = await callRoute(handler, { url: '/dsh-takeover/state', headers: GUARD })
    assert.equal(bare.status, 200)
    assert.equal('ledger' in (JSON.parse(bare.body) as Record<string, unknown>), false, '无参请求响应零变化（inboxQuery 同款扩展纪律）')

    const withLedger = await callRoute(handler, { url: '/dsh-takeover/state?ledger=1', headers: GUARD })
    assert.equal(withLedger.status, 200)
    const body = JSON.parse(withLedger.body) as { ledger?: Record<string, unknown> }
    assert.ok(body.ledger !== undefined && typeof body.ledger === 'object', '?ledger=1 → state.ledger 在场')
    // 立约五键：{chains, zombies, counts, unjoined, window}（aggregateLedger 输出面闭合）
    for (const k of ['chains', 'zombies', 'counts', 'unjoined', 'window']) {
      assert.ok(k in body.ledger!, `state.ledger 缺键 ${k}`)
    }
    const counts = body.ledger!['counts'] as Record<string, unknown>
    assert.equal(counts['batons'], 0, '空 home 诚实零（不编数字）')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('路由：GET preflight——未知 provider 的 read 落 ok:false → decline 判定卡（integrity 唯一 decline 源）；守卫与 405', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-wiring-preflight-'))
  process.env.HANDOFF_HOME = home
  try {
    const handler = routeHandler()
    const r = await callRoute(handler, { url: '/dsh-takeover/preflight?provider=bogus-not-a-provider&reference=x', headers: GUARD })
    assert.equal(r.status, 200, '规范值一律 200（业务结果不是 HTTP 事故）')
    const b = JSON.parse(r.body) as { ok: boolean; card?: { verdict?: string; wounds?: Array<{ kind?: string }>; basis?: string; checks?: unknown[] } }
    assert.equal(b.ok, true)
    assert.equal(b.card?.verdict, 'decline', 'read ok:false → integrity wound → decline（唯一来源）')
    assert.ok(Array.isArray(b.card?.checks) && (b.card?.checks as unknown[]).length === 5, '五检查项闭集固定序进卡')
    assert.ok(b.card?.basis !== '', 'basis 在场（拦停理由呈给用户不吞）')

    const forbidden = await callRoute(handler, { url: '/dsh-takeover/preflight?provider=bogus', headers: { host: 'localhost:3080', 'sec-fetch-site': 'cross-site' } })
    assert.equal(forbidden.status, 403, '跨站读拒（与 session-preview 同一读守卫）')
    const post = await callRoute(handler, { method: 'POST', url: '/dsh-takeover/preflight', headers: { ...GUARD }, body: '{}' })
    assert.equal(post.status, 405)
    const missing404 = await callRoute(handler, { url: '/dsh-takeover/unknown-sub', headers: GUARD })
    const nf = JSON.parse(missing404.body) as { error: string }
    assert.match(nf.error, /preflight/, '404 兜底文案补列 preflight')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------- state 面：PendingRow.to 透传 + state.machineName ----------

function makeCard(partial?: Partial<Card>): Card {
  return {
    handoff: 1,
    id: generateId(),
    from: { agent: 'dsh', session: 'sess-x', title: '' },
    to: 'any',
    project: '',
    cwd: process.env.HANDOFF_HOME ?? '',
    pushed_at: '2026-11-20T10:00:00+08:00',
    git: { branch: '', changed: [] },
    tasks: [],
    sections: { goal: 'g', files: 'f', done: 'd', remaining: 'r', stopped: 's', warnings: 'w' },
    extras: {},
    ...partial,
  }
}

function fakeReaders(): ForeignReaders {
  return {
    listSessions: () => [],
    resolve: () => ({ kind: 'not-found', reference: '' }),
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
  }
}

test('buildState：PendingRow.to 原样透传（machine: 点名的分组数据源）；machine.json 名进 state.machineName', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = mkdtempSync(join(tmpdir(), 'dsh-wiring-state-'))
  try {
    writeCard(makeCard({ to: 'machine:lap-b', id: 'ho-wir-aaaa' }), home)
    writeCard(makeCard({ to: '', id: 'ho-wir-bbbb' }), home)
    writeFileSync(join(home, 'machine.json'), JSON.stringify({ name: 'lap-b' }))
    const st: TakeoverState = buildState(fakeReaders(), home)
    assert.equal(st.pending.find((p) => p.id === 'ho-wir-aaaa')?.to, 'machine:lap-b', '点名卡 to 原样透传')
    assert.equal(st.pending.find((p) => p.id === 'ho-wir-bbbb')?.to, undefined, '空 to 不落字段（字段缺席=any 桶）')
    assert.equal(st.machineName, 'lap-b', 'machine.json 名进 state.machineName（收件箱分组判定源）')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------- skills 面：三张新注册卡的内容红线 ----------

test('skills：/ledger /sendto /almanac 注册进数组且 userInvocable；内容红线在册', () => {
  const regs = skillRegistrations()
  for (const name of ['ledger', 'sendto', 'almanac']) {
    const reg = regs.find((r) => r.name === name)
    assert.ok(reg !== undefined, `${name} 未注册进 skillRegistrations()`)
    assert.equal(reg?.invocation?.userInvocable, true)
    assert.equal(reg?.invocation?.modelInvocable, false)
  }
  assert.match(LEDGER_SKILL_CONTENT, /绝不计算延续率、百分比或评分/, '总账红线：不评分')
  assert.match(LEDGER_SKILL_CONTENT, /账本还是空的/, '总账红线：空账本诚实句')
  assert.match(SENDTO_SKILL_CONTENT, /已投递到同步/, '投递口径：只说已投递到同步')
  assert.match(SENDTO_SKILL_CONTENT, /不得声明对方已收到/, '投递红线：无握手不声明已收到')
  assert.match(ALMANAC_SKILL_CONTENT, /只计数、不评分/, '年鉴红线：只计数不评分')
  assert.match(ALMANAC_SKILL_CONTENT, /这台机器/, '年鉴红线：本机口径（不得夸成全总线）')
})

// ---------------------------------------------------------------- DOM 面

const t = ((key: string, params?: Record<string, unknown>) => {
  // 轻量词典桩：直接用真词典（zh）+ interpolate 同款替换，键缺失回键名（缺译当场暴露）
  const dict = (globalThis as { __WIRING_ZH__?: Record<string, string> }).__WIRING_ZH__
  let s = dict?.[key] ?? key
  if (params !== undefined) {
    for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
  }
  return s
}) as never as import('@deepseek-ai/dsh-client-ui-slots').Translate

const { DICTS } = await import('../src/locales.ts')
;(globalThis as { __WIRING_ZH__?: Record<string, string> }).__WIRING_ZH__ = DICTS.zh

// fetch 桩：按 url 基（? 前）计划响应，记录全部调用（本文件独立进程，不污染其他 spec）
type Call = { url: string; method: string; body: string }
const calls: Call[] = []
const stubPlan: Record<string, { status?: number; body?: unknown }> = {}
const g = globalThis as unknown as Record<string, unknown>
;(g as { fetch: unknown }).fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
  const urlStr = String(url)
  calls.push({ url: urlStr, method: init?.method ?? 'GET', body: init?.body ?? '' })
  const key = urlStr.split('?')[0] ?? ''
  const plan = stubPlan[key]
  const status = plan?.status ?? 200
  const body = plan?.body ?? { ok: true }
  return { ok: status < 400, status, json: async () => body }
}) as unknown as typeof fetch

let root: Root | null = null
const doc = (g.document as typeof document)
const container = doc.createElement('div')
doc.body.appendChild(container)
let renderSeq = 0
async function render(el: ReactElement): Promise<void> {
  if (root === null) root = createRoot(container as never)
  const keyed = cloneElement(el, { key: `wiring-${++renderSeq}` })
  await act(async () => { root!.render(keyed) })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
}
function text(): string {
  let s = container.textContent ?? ''
  for (const st of [...container.querySelectorAll('style')]) s = s.split(st.textContent ?? '§§never§§').join('')
  return s
}
function has(s: string): boolean { return text().includes(s) }
function fireClick(el: unknown): void { (el as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }
async function flush(ms = 30): Promise<void> { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
async function clickButton(match: string): Promise<void> {
  const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(match))
  assert.ok(btn, `按钮不存在: ${match}`)
  await act(async () => { fireClick(btn) })
  await flush()
}
/** 总账/历史块头是 div[role=button]（非 <button>）——按角色点 */
async function clickRoleButton(match: string): Promise<void> {
  const btn = [...container.querySelectorAll('[role="button"]')].find((b) => (b.textContent ?? '').includes(match))
  assert.ok(btn, `role=button 不存在: ${match}`)
  await act(async () => { fireClick(btn) })
  await flush()
}
function resetCalls(): void { calls.length = 0 }
const postedTakeover = (): boolean => calls.some((c) => c.method === 'POST' && (c.url.split('?')[0] ?? '') === '/dsh-takeover/takeover')

const client = await import('../src/client.ts')
type PendingRowLike = import('../src/settings.ts').PendingRow
const row = (over: Partial<PendingRowLike>): PendingRowLike => ({
  id: 'ho-wiring-0001', agent: 'dsh', title: '普通卡', project: 'demo',
  pushedAt: '2026-11-20T10:00:00+08:00', preview: '目标：接线', lowInfo: false, ...over,
})

test('收件箱点名三桶：mine 徽标 + mine 浮最前（pin 之外）+ 点名筛选', async () => {
  const rows: PendingRowLike[] = [
    row({ id: 'ho-w-any', title: '通用卡' }), // 无 to → any
    row({ id: 'ho-w-mine', title: '点名我', to: 'machine:lap-b' }), // mine（self=lap-b）
    row({ id: 'ho-w-other', title: '别机卡', to: 'machine:lap-c' }), // others
  ]
  await render(createElement(client.PendingList, {
    rows, query: '', home: '/tmp/h', t, lang: 'zh',
    onExport: () => {}, onChainFilter: () => {}, onTakeInbox: () => {}, takeBusyId: null,
    onDismiss: () => {}, dismissBusyId: null, pins: [], onPin: () => {}, onUnpin: () => {}, pinBusyId: null,
    includeBody: false, onToggleIncludeBody: () => {}, bodyHits: null, bodyBusy: false, bodyErr: null,
    machineName: 'lap-b',
  }))
  assert.ok(has('点名给我'), '点名徽标缺失（mine 桶）')
  assert.ok(has('别机点名'), '别机点名徽标缺失（others 桶）')
  // mine 浮最前：DOM 序首个 .bt-pending-title 是「点名我」
  const titles = [...container.querySelectorAll('.bt-pending-title')].map((e) => e.textContent ?? '')
  assert.equal(titles.find((s) => s !== '')?.trim(), '点名我', 'mine 桶应浮在列表最前')
  // 点名筛选 chip 在场（有点名卡才出现）且只 mine 计数
  const mineBox = [...container.querySelectorAll('.bt-newonly')]
    .find((l) => (l.textContent ?? '').includes('点名给我'))?.querySelector('input') as HTMLInputElement | null
  assert.ok(mineBox, '点名给我开关缺失')
  await act(async () => { fireClick(mineBox) })
  await flush()
  assert.ok(has('点名我'), '筛选后 mine 卡应保留')
  assert.ok(!has('通用卡'), '筛选后 any 卡应被滤掉')
  assert.ok(!has('别机卡'), '筛选后 others 卡应被滤掉（不冒领）')
})

test('收件箱点名：selfName 缺席（老 host）不出徽标不出筛选——防御式零变化', async () => {
  const rows: PendingRowLike[] = [row({ id: 'ho-w-mine2', title: '点名我', to: 'machine:lap-b' })]
  await render(createElement(client.PendingList, {
    rows, query: '', home: '/tmp/h2', t, lang: 'zh',
    onExport: () => {}, onChainFilter: () => {}, onTakeInbox: () => {}, takeBusyId: null,
    onDismiss: () => {}, dismissBusyId: null, pins: [], onPin: () => {}, onUnpin: () => {}, pinBusyId: null,
    includeBody: false, onToggleIncludeBody: () => {}, bodyHits: null, bodyBusy: false, bodyErr: null,
  }))
  assert.ok(!has('点名给我'), 'machineName 缺席时不得出点名徽标/筛选（老宿主零变化）')
  assert.ok(has('点名我'), '行本身照常渲染')
})

// ---------- 浏览器：运行中筛选 ----------

const providerState = (): TakeoverState => ({
  home: '/tmp/h3',
  pending: [],
  pendingSkipped: 0,
  pendingDuplicates: 0,
  archivedCount: 0,
  providers: [{ name: 'zcode' as never, supported: true, sessions: 2, enabled: true, note: '', exports: 0 }],
})

test('浏览器运行中筛选：runningIds 在场 → 有证据行出徽标；开启筛选只剩有证据行', async () => {
  stubPlan['/dsh-takeover/sessions'] = {
    body: {
      ok: true, provider: 'zcode', total: 2,
      sessions: [
        { id: 'sess_run_1', title: '运行中的会话', cwd: 'D:/demo', updatedAt: '2026-11-20T09:00:00Z', kind: 'uuid' },
        { id: 'sess_idle_1', title: '闲置会话', cwd: 'D:/demo', updatedAt: '2026-11-19T09:00:00Z', kind: 'uuid' },
      ],
      runningIds: ['sess_run_1'],
    },
  }
  await render(createElement(client.ForeignBrowser, {
    state: providerState(), t, lang: 'zh',
    onError: () => {}, onNotice: () => {}, navigate: () => true, bare: true, active: true,
  }))
  await flush(80)
  assert.ok(has('运行中的会话') && has('闲置会话'), '两行都在场')
  assert.ok(has('运行中'), '运行中 chip/徽标在场')
  const badge = [...container.querySelectorAll('.bt-fsess .bt-tag')].map((e) => e.textContent ?? '')
  assert.ok(badge.includes('运行中'), '有证据行出运行徽标')
  // 开启筛选
  const chip = [...container.querySelectorAll('button.bt-chip')].find((b) => (b.textContent ?? '').includes('运行中'))
  assert.ok(chip, '运行中筛选 chip 不存在')
  await act(async () => { fireClick(chip) })
  await flush()
  assert.ok(has('运行中的会话'), '筛选后有证据行保留')
  assert.ok(!has('闲置会话'), '筛选后无证据行被滤掉')
})

test('浏览器运行中：runningIds 全空 → 筛选开不出诚实空态；runningIds 缺席（旧宿主）→ chip 停用「状态不可知」', async () => {
  // 空集：诚实零
  stubPlan['/dsh-takeover/sessions'] = {
    body: {
      ok: true, provider: 'zcode', total: 1,
      sessions: [{ id: 'sess_x', title: '独会话', cwd: '', updatedAt: '2026-11-20T09:00:00Z', kind: 'uuid' }],
      runningIds: [],
    },
  }
  await render(createElement(client.ForeignBrowser, {
    state: providerState(), t, lang: 'zh',
    onError: () => {}, onNotice: () => {}, navigate: () => true, bare: true, active: true,
  }))
  await flush(80)
  const chip = [...container.querySelectorAll('button.bt-chip')].find((b) => (b.textContent ?? '').includes('运行中')) as HTMLButtonElement | null
  assert.ok(chip !== null && chip.disabled === false, 'runningIds 在场（含空集）→ chip 可点')
  await act(async () => { fireClick(chip) })
  await flush()
  assert.ok(has('没有可判定的运行中会话'), '空证据集出诚实空态横幅（绝不编）')
  // 缺席：旧宿主
  stubPlan['/dsh-takeover/sessions'] = {
    body: {
      ok: true, provider: 'zcode', total: 1,
      sessions: [{ id: 'sess_x', title: '独会话', cwd: '', updatedAt: '2026-11-20T09:00:00Z', kind: 'uuid' }],
    },
  }
  await render(createElement(client.ForeignBrowser, {
    state: providerState(), t, lang: 'zh',
    onError: () => {}, onNotice: () => {}, navigate: () => true, bare: true, active: true,
  }))
  await flush(80)
  const chip2 = [...container.querySelectorAll('button.bt-chip')].find((b) => (b.textContent ?? '').includes('运行中')) as HTMLButtonElement | null
  assert.ok(chip2 !== null && chip2.disabled === true, 'runningIds 缺席 → chip 停用（状态不可知）')
  assert.ok((chip2?.getAttribute('title') ?? '').includes('状态不可知'), '停用态标题如实「状态不可知」')
})

// ---------- 接管预检前置闸 ----------

const browserWithRow = async (): Promise<void> => {
  stubPlan['/dsh-takeover/sessions'] = {
    body: {
      ok: true, provider: 'zcode', total: 1,
      sessions: [{ id: 'sess_gate_1', title: '要接管的会话', cwd: 'D:/demo', updatedAt: '2026-11-20T09:00:00Z', kind: 'uuid' }],
      runningIds: [],
    },
  }
  await render(createElement(client.ForeignBrowser, {
    state: providerState(), t, lang: 'zh',
    onError: (m) => { errs.push(m) }, onNotice: (m) => { notes.push(m) }, navigate: () => true, bare: true, active: true,
  }))
  await flush(80)
}
let errs: string[] = []
let notes: string[] = []

test('预检闸 decline：拦截投递（不 POST takeover），basis 进错误横幅', async () => {
  errs = []; notes = []
  stubPlan['/dsh-takeover/preflight'] = {
    body: { ok: true, card: { verdict: 'decline', wounds: [{ kind: 'integrity', item: '读取失败', detail: '读不出来' }], checks: [], basis: '会话日志读不出来，接管没有日志基础' } },
  }
  await browserWithRow()
  resetCalls()
  await clickButton('接管')
  await flush()
  assert.equal(postedTakeover(), false, 'decline 必须拦停投递')
  assert.ok(errs.some((m) => m.includes('建议放弃接管') && m.includes('日志读不出来')), 'basis 呈给用户不吞')
})

test('预检闸 wounded：浮伤待确认（不直接投递），「仍要接管」确认后照常投递', async () => {
  errs = []; notes = []
  stubPlan['/dsh-takeover/preflight'] = {
    body: { ok: true, card: { verdict: 'wounded', wounds: [{ kind: 'scene', item: 'D:/x.ts', detail: '涉及文件不在本盘' }], checks: [], basis: '带伤接管：1 处伤' } },
  }
  await browserWithRow()
  resetCalls()
  await clickButton('接管')
  await flush()
  assert.equal(postedTakeover(), false, 'wounded 先出待确认门，不直接投递')
  assert.ok(has('带伤接管'), 'wound 门横幅在场')
  assert.ok(has('[scene]'), '伤条目 kind 可读')
  assert.ok(has('D:/x.ts'), '伤条目 item（缺失文件路径）可读')
  await clickButton('仍要接管')
  await flush()
  assert.equal(postedTakeover(), true, '用户确认放行 → 投递照常')
})

test('预检闸 ready+unknown：放行且 basis 附注经通知浮出（不吞）；预检端点缺席 → fail-open 放行并如实说明', async () => {
  errs = []; notes = []
  stubPlan['/dsh-takeover/preflight'] = {
    body: { ok: true, card: { verdict: 'ready', wounds: [], checks: [{ kind: 'liveness', state: 'unknown', detail: '死活未知' }], basis: '可直接接管。死活未知：…' } },
  }
  await browserWithRow()
  resetCalls()
  await clickButton('接管')
  await flush()
  assert.equal(postedTakeover(), true, 'ready 直接放行')
  assert.ok(notes.some((m) => m.includes('预检通过') && m.includes('死活未知')), 'unknown 附注不吞')

  errs = []; notes = []
  stubPlan['/dsh-takeover/preflight'] = { status: 404, body: { error: '未知路由' } }
  await browserWithRow()
  resetCalls()
  await clickButton('接管')
  await flush()
  assert.equal(postedTakeover(), true, '预检不可用按 fail-open 放行（预检绝不拦真实接管）')
  assert.ok(notes.some((m) => m.includes('预检不可用')), '放行原因如实说明（不静默假装查过）')
})

// ---------- 总账块（懒加载 DOM） ----------

test('接力总账块：懒加载 state?ledger=1；空账本诚实句；僵尸条目救生艇抢出区分标注', async () => {
  // 空账本
  stubPlan['/dsh-takeover/state'] = {
    body: {
      home: '/tmp/h4', pending: [], pendingSkipped: 0, pendingDuplicates: 0, archivedCount: 0, providers: [],
      ledger: {
        chains: [], zombies: [],
        counts: { continued: 0, abandoned: 0, zombie: 0, zombieLifeboat: 0, chainless: 0, batons: 0 },
        unjoined: [],
        window: { lifecycleEvents: 0, lifecycleCap: 500, relayRecords: 0, relayPickups: 0, note: '窗口内 0 条' },
      },
    },
  }
  await render(createElement(client.RelayLedgerBlock, { t, lang: 'zh' }))
  await clickRoleButton("接力总账")
  await flush()
  assert.ok(calls.some((c) => (c.url.split('?')[0] ?? '') === '/dsh-takeover/state' && c.url.includes('ledger=1')), '懒加载带 ?ledger=1')
  assert.ok(has('账本还是空的'), '空账本诚实句（不编 0 表格）')

  // 有账 + 救生艇区分
  stubPlan['/dsh-takeover/state'] = {
    body: {
      home: '/tmp/h4', pending: [], pendingSkipped: 0, pendingDuplicates: 0, archivedCount: 0, providers: [],
      ledger: {
        chains: [{ steps: [{ id: 'ho-a', title: 'T', pushedAt: '', where: 'pending' }, { id: 'ho-b', title: '', pushedAt: '', where: 'archived', supersedes: 'ho-a', receiptFor: 'ho-a' }], cycle: false, cycleIds: [], forks: [] }],
        zombies: [
          { id: 'ho-z1', at: '2026-11-20T00:00:00Z', title: '普通僵尸', lifeboat: false },
          { id: 'ho-z2', at: '2026-11-20T00:00:00Z', title: '', lifeboat: true },
        ],
        counts: { continued: 3, abandoned: 1, zombie: 2, zombieLifeboat: 1, chainless: 4, batons: 10 },
        unjoined: [{ kind: 'relay_pickup_no_card', id: 'ho-gone', at: '2026-11-19T00:00:00Z', detail: '取件记录指向在册不存在的卡' }],
        window: { lifecycleEvents: 65, lifecycleCap: 500, relayRecords: 16, relayPickups: 13, note: '单机口径' },
      },
    },
  }
  await render(createElement(client.RelayLedgerBlock, { t, lang: 'zh' }))
  await clickRoleButton("接力总账")
  await flush()
  assert.ok(has('3 continued / 1 abandoned / 2 zombie'), '闭集计数行原样')
  assert.ok(has('总棒 n=10'), 'n=总棒')
  assert.ok(has('救生艇抢出 1 张'), '救生艇抢出子计数括注')
  assert.ok(has('普通僵尸'), '僵尸标题渲染')
  assert.ok(has('ho-z2'), '空标题僵尸回退 id（诚实缺省）')
  assert.ok(has('ho-a ← ho-b'), '链行棒序箭头')
  assert.ok(has('relay_pickup_no_card'), '对不齐单列 kind 原样')
  assert.ok(has('单机口径'), '窗口口径标注照抄 host')
})
