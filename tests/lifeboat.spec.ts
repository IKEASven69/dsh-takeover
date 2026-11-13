// 救生艇（lifeboat）回归：POST /dsh-takeover/lifeboat——上下文炸了也不经模型把运行态抢出成卡。
// 覆盖：假 session（snapshotEvents 合成事件）直出卡 / 事件流降级兜底骨架仍出卡（空壳闸放行）/
// lifecycle 事件落盘（write/lifeboat）/ sameOrigin 拒绝 / 会话缺席规范错误 / 换机同步启用自动 syncNow。
// 全程临时 HANDOFF_HOME；假 session 不碰真实宿主、不调任何模型。
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { registerTakeoverRoutes } from '../src/server.ts'
import { readLifecycleEvents } from '../src/lifecycle.ts'
import { saveSyncConfig } from '../src/sync.ts'

// ---------------------------------------------------------------- 路由测试架（takeover-route.spec 同款形态）

function routeHandler(ctxExtra?: Record<string, unknown>): (req: IncomingMessage, res: ServerResponse) => void {
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
  const host = {
    effect: (fn: () => void): void => fn(),
    webServer: { register: (reg: { handler: typeof handler }): void => { handler = reg.handler } },
  }
  const ctx = { inject: (_deps: string[], cb: (h: typeof host) => void): void => cb(host), ...ctxExtra }
  registerTakeoverRoutes(ctx as never)
  if (handler === undefined) throw new Error('路由未注册')
  return handler
}

async function callLifeboat(
  handler: ReturnType<typeof routeHandler>,
  o: { headers?: Record<string, string>; body?: string; method?: string },
): Promise<{ status: number; body: string }> {
  return await new Promise((resolve) => {
    const req = Object.assign(new EventEmitter(), {
      method: o.method ?? 'POST',
      url: '/dsh-takeover/lifeboat',
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

// ---------------------------------------------------------------- 假 session（事件流全合成）

/** 合成事件流：一条用户请求 + 一次 write + 一个未完成 todo——蒸馏素材全确定，无模型参与 */
const EVENTS = [
  { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把登录页的提交按钮修好' }] } },
  { type: 'tool/call', time: 2, data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/login.ts' }) } },
  { type: 'todo/write', time: 3, data: { todos: [{ text: '给提交按钮补回归测试', status: 'in_progress' }] } },
]

/** 好会话：snapshotEvents 给合成事件；cwd 指向非 git 临时目录（隔离本仓工作区） */
function goodSession(cwd: string): unknown {
  return { id: 'sess-lb-good', header: { cwd }, snapshotEvents: () => EVENTS }
}

/** 事件流已炸的会话：snapshotEvents 抛错且无 events 数组——probe fail-open 降级 */
function degradedSession(cwd: string): unknown {
  return { id: 'sess-lb-degraded', header: { cwd }, snapshotEvents: () => { throw new Error('事件流已炸') } }
}

/** 独立 HANDOFF_HOME（pending/ 就位，用例结束清理） */
function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lifeboat-'))
  mkdirSync(join(dir, 'pending'), { recursive: true })
  return dir
}

interface LifeboatBody {
  ok?: boolean
  id?: string
  detail?: string
  error?: string
  synced?: { ok?: boolean; detail?: string; error?: string }
  state?: { pending?: Array<{ id?: string }> }
}

// ---------------------------------------------------------------- 用例

test('救生艇：假 session 合成事件流——不经模型直接出卡，响应带 id/detail/state（state.pending 带新卡）', async () => {
  const home = tmpHome()
  process.env.HANDOFF_HOME = home
  try {
    const handler = routeHandler({ root: { sessions: { get: (id: string) => (id === 'sess-lb-good' ? goodSession(home) : undefined) } } })
    const r = await callLifeboat(handler, { headers: { ...ORIGIN }, body: '{"sessionId":"sess-lb-good"}' })
    assert.equal(r.status, 200)
    const b = JSON.parse(r.body) as LifeboatBody
    assert.equal(b.ok, true, b.error ?? '')
    assert.match(b.id ?? '', /^ho-[a-z0-9]+-[a-z0-9]{4}$/, '出卡 id 应是协议卡 id 形态')
    assert.equal(typeof b.detail, 'string', 'detail（寄存 note）必须在场')
    // 带全量 state 免轮询：新卡即刻可查
    assert.ok(b.state?.pending?.some((p) => p.id === b.id), 'state.pending 应带刚抢出的卡')
    // 换机同步未启用：synced 缺省（不硬造同步结论）
    assert.equal('synced' in b, false, '未启用同步时 synced 应缺省')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('救生艇：事件流降级仍出卡——兜底骨架（probe fail-open + 空壳闸放行），不抛规范错误', async () => {
  const home = tmpHome()
  process.env.HANDOFF_HOME = home
  try {
    const handler = routeHandler({ root: { sessions: { get: (id: string) => (id === 'sess-lb-degraded' ? degradedSession(home) : undefined) } } })
    const r = await callLifeboat(handler, { headers: { ...ORIGIN }, body: '{"sessionId":"sess-lb-degraded"}' })
    assert.equal(r.status, 200)
    const b = JSON.parse(r.body) as LifeboatBody
    assert.equal(b.ok, true, `事件流炸了也要出卡：${b.error}`)
    assert.match(b.detail ?? '', /空壳卡（已确认寄存）/, '兜底骨架卡应带「已确认寄存」留痕（confirmSkeleton 语义）')
    assert.match(b.detail ?? '', /结构无法识别/, '探测降级说明（probe.note）应如实进 detail')
    assert.ok(b.state?.pending?.some((p) => p.id === b.id), '骨架卡照常进收件箱')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('救生艇：lifecycle 事件落盘——stage=write、reason=lifeboat、target=卡 id', async () => {
  const home = tmpHome()
  process.env.HANDOFF_HOME = home
  try {
    const handler = routeHandler({ root: { sessions: { get: (id: string) => (id === 'sess-lb-good' ? goodSession(home) : undefined) } } })
    const r = await callLifeboat(handler, { headers: { ...ORIGIN }, body: '{"sessionId":"sess-lb-good"}' })
    const b = JSON.parse(r.body) as LifeboatBody
    assert.equal(b.ok, true, b.error ?? '')
    const events = readLifecycleEvents(home)
    const last = events.at(-1)
    assert.ok(last, 'lifecycle.jsonl 应有事件')
    assert.equal(last!.stage, 'write')
    assert.equal(last!.reason, 'lifeboat', 'reason 闭集应含 lifeboat 且落盘原样')
    assert.equal(last!.target, b.id, 'target 落卡 id（lifecycle 隐私纪律）')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('救生艇：sameOrigin 拒绝（无 Origin 403）+ GET 405', async () => {
  const home = tmpHome()
  process.env.HANDOFF_HOME = home
  try {
    const handler = routeHandler()
    const forbidden = await callLifeboat(handler, { headers: { host: 'localhost:3080' }, body: '{"sessionId":"sess-x"}' })
    assert.equal(forbidden.status, 403)
    const notAllowed = await callLifeboat(handler, { method: 'GET', headers: { ...ORIGIN } })
    assert.equal(notAllowed.status, 405)
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('救生艇：缺 sessionId / 会话缺席 / sessions 服务缺席——全部规范错误（200 + ok:false），不崩宿主', async () => {
  const home = tmpHome()
  process.env.HANDOFF_HOME = home
  try {
    // 缺 sessionId
    const noId = await callLifeboat(routeHandler(), { headers: { ...ORIGIN }, body: '{}' })
    assert.equal(noId.status, 200)
    assert.equal((JSON.parse(noId.body) as LifeboatBody).ok, false)
    assert.match((JSON.parse(noId.body) as LifeboatBody).error ?? '', /缺少 sessionId/)

    // sessions 服务在、会话不在场
    const handler = routeHandler({ root: { sessions: { get: () => undefined } } })
    const absent = await callLifeboat(handler, { headers: { ...ORIGIN }, body: '{"sessionId":"sess-gone"}' })
    assert.equal(absent.status, 200)
    const absentBody = JSON.parse(absent.body) as LifeboatBody
    assert.equal(absentBody.ok, false)
    assert.match(absentBody.error ?? '', /不在场/)

    // sessions 服务整体缺席（老宿主）：同样规范错误
    const noSessions = await callLifeboat(routeHandler(), { headers: { ...ORIGIN }, body: '{"sessionId":"sess-gone"}' })
    assert.equal(noSessions.status, 200)
    assert.equal((JSON.parse(noSessions.body) as LifeboatBody).ok, false)
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
  }
})

test('救生艇：换机同步已启用——响应带 synced（本地裸仓端点真跑 syncNow）', async () => {
  const home = tmpHome()
  // 本地裸仓库端点（sync.spec 同款）：零网络，只吃本机 git
  const remote = mkdtempSync(join(tmpdir(), 'lifeboat-remote-'))
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' })
  process.env.HANDOFF_HOME = home
  try {
    saveSyncConfig({ enabled: true, remote }, home)
    const handler = routeHandler({ root: { sessions: { get: (id: string) => (id === 'sess-lb-good' ? goodSession(home) : undefined) } } })
    const r = await callLifeboat(handler, { headers: { ...ORIGIN }, body: '{"sessionId":"sess-lb-good"}' })
    assert.equal(r.status, 200)
    const b = JSON.parse(r.body) as LifeboatBody
    assert.equal(b.ok, true, b.error ?? '')
    assert.ok(b.synced, '启用同步时响应应带 synced 结果')
    assert.equal(b.synced!.ok, true, `自动同步应成功：${b.synced?.error}`)
    assert.ok(typeof b.synced!.detail === 'string' && b.synced!.detail !== '', '同步摘要应如实带出')
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(remote, { recursive: true, force: true })
  }
})
