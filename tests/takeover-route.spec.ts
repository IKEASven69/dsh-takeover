/**
 * FR-1..4 回归：一键接管投递核心（admitTakeover）+ 会话控制器防御访问 +
 * foreignResolveOne 门控 + 子代理判定/项目 facet（browser-view）+ PendingRow.supersedes。
 * 会话控制器一律注入假货，不碰真实宿主。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  admitTakeover,
  foreignResolveOne,
  sessionControllerOf,
  type SessionControllerLike,
} from '../src/index.ts'
import { cwdFacets, filterByCwd, isSubagentSession, type SessionRow } from '../src/browser-view.ts'

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
