// 接力溯源记录：对真 @deepseek-ai/dsh-session（≥0.2.1-alpha.2）的 append/read
// 回路 + 旧宿主降级 + admitTakeover 的 sessions 钩子接线。
import assert from 'node:assert/strict'
import test from 'node:test'
import * as client from '../src/client.ts'
import { admitTakeover, registerTakeoverRoutes } from '../src/index.ts'
import { appendRelayRecord, relayRecordOf } from '../src/relay-records.ts'

const dshSession = await import('@deepseek-ai/dsh-session')
const hasRecordApi = typeof (dshSession as { appendPluginRecord?: unknown }).appendPluginRecord === 'function'

test('真包回路：appendRelayRecord 落日志，pluginRecordOf 读回原样', { skip: hasRecordApi ? false : '宿主实验会话包未安装' }, async () => {
  const sess = dshSession.Session.create('sess-relay-spec' as never)
  const ok = await appendRelayRecord(sess, 'takeover', {
    provider: 'zcode', sourceId: 'sess_src_1', title: '接管：目标会话（10-16 12:00）', at: '2026-10-16T12:00:00Z',
  })
  assert.equal(ok, true)
  const events = sess.snapshotEvents() as unknown as Array<Record<string, unknown>>
  const last = events[events.length - 1]
  const rec = relayRecordOf(last)
  assert.equal(rec?.kind, 'takeover')
  assert.equal(rec?.data.provider, 'zcode')
  assert.equal(rec?.data.sourceId, 'sess_src_1')
  // 官方读取器同口径（跨实现验证）
  const official = dshSession.pluginRecordOf(last as never)
  assert.equal((official as { type: string }).type, 'plugin:dsh-takeover/takeover')
})

test('三种记录类型文法全部合法并各自落日志', { skip: hasRecordApi ? false : '宿主实验会话包未安装' }, async () => {
  const sess = dshSession.Session.create('sess-relay-spec-2' as never)
  for (const kind of ['takeover', 'take_deposit', 'pickup'] as const) {
    const ok = await appendRelayRecord(sess, kind, { cardId: 'ho-x', at: '2026-10-16T12:00:00Z' } as never)
    assert.equal(ok, true, `${kind} 追加失败`)
  }
  const kinds = (sess.snapshotEvents() as never as Array<Record<string, unknown>>)
    .map((e) => relayRecordOf(e)?.kind).filter(Boolean)
  assert.deepEqual(kinds, ['takeover', 'take_deposit', 'pickup'])
})

test('降级：记录数据不可序列化（BigInt）→ false 不上抛', async () => {
  const sess = hasRecordApi ? dshSession.Session.create('sess-relay-spec-3' as never) : {}
  const ok = await appendRelayRecord(sess, 'takeover', { at: 'x', note: 1n as unknown as string } as never)
  assert.equal(ok, false)
})

test('admitTakeover：deps.sessions 在场时投递成功即追加接力溯源', async () => {
  if (!hasRecordApi) return
  const sess = dshSession.Session.create('sess-relay-spec-4' as never)
  const appended: string[] = []
  const controller = {
    create: async () => ({ sessionId: 'sess-new-relay' }),
    rename: async () => undefined,
    prompt: async () => ({ accepted: true }),
  }
  const r = await admitTakeover(
    controller as never,
    { mode: 'take', provider: 'zcode', reference: 'sess-abc' },
    {
      resolve: async () => ({ ok: true, ref: { id: 'sess-abc', agent: 'zcode', title: '目标会话', cwd: '', updatedAt: 0, fingerprint: '', kind: 'sqlite' } }),
      sessions: { get: () => sess },
    },
  )
  assert.equal(r.ok, true)
  for (const e of sess.snapshotEvents() as never as Array<Record<string, unknown>>) {
    const rec = relayRecordOf(e)
    if (rec) appended.push(rec.kind)
  }
  assert.deepEqual(appended, ['takeover'])
})

test('admitTakeover：deps.sessions 缺席时投递照常成功（降级不写）', async () => {
  const controller = {
    create: async () => ({ sessionId: 'sess-new-plain' }),
    rename: async () => undefined,
    prompt: async () => ({ accepted: true }),
  }
  const r = await admitTakeover(
    controller as never,
    { mode: 'take', provider: 'zcode', reference: 'sess-abc' },
    { resolve: async () => ({ ok: true, ref: { id: 'sess-abc', agent: 'zcode', title: 't', cwd: '', updatedAt: 0, fingerprint: '', kind: 'sqlite' } }) },
  )
  assert.equal(r.ok, true)
})

test('路由接线：rootSessionsOf 从 ctx.root 取 sessions（冒烟）', async () => {
  let handler: ((req: unknown, res: unknown) => void) | undefined
  const host = {
    effect: (fn: () => void): void => fn(),
    webServer: { register: (reg: { handler: typeof handler }): void => { handler = reg.handler } },
  }
  const ctx = {
    inject: (_deps: string[], cb: (h: typeof host) => void): void => cb(host),
    root: { sessions: { get: () => undefined } },
  }
  registerTakeoverRoutes(ctx as never)
  assert.ok(handler, '路由未注册')
  void client // client.ts 在同进程已加载（UI 规格），此处仅占位引用
})
