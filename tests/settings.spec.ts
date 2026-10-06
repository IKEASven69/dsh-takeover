/**
 * 设置卡测试：
 * - 开关状态读写（loadSwitches / setProviderEnabled，临时目录隔离，不碰真实 ~/.handoff）
 * - 停用 provider 的 foreign_session_read 规范错误值
 * - buildState 组装（pending 概览 / archived 计数 / 支持矩阵）与 clearArchived
 * 读取层一律注入假货（ForeignReaders）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generateId, writeCard, loadCard, type Card } from '@agent-handoff/core'
import { foreignSessionRead, type ForeignReaders } from '../src/foreign.ts'
import {
  buildState,
  clearArchived,
  isProviderEnabled,
  loadSwitches,
  setProviderEnabled,
  switchesPath,
} from '../src/settings.ts'
import { disabledError } from '../src/foreign.ts'

/** 隔离的 HANDOFF_HOME（临时目录） */
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'takeover-settings-'))
}

/** 造一张最小合法卡片 */
function makeCard(partial?: Partial<Card>): Card {
  return {
    handoff: 1,
    id: generateId(),
    from: { agent: 'dsh', session: 'sess-x', title: '' },
    to: 'any',
    project: '',
    cwd: tmpdir(),
    pushed_at: '2026-10-01T10:00:00+08:00',
    git: { branch: '', changed: [] },
    tasks: [],
    sections: { goal: 'g', files: 'f', done: 'd', remaining: 'r', stopped: 's', warnings: 'w' },
    extras: {},
    ...partial,
  }
}

/** 假货读取层：支持情况 / 会话数全可控 */
function fakeReaders(overrides?: Partial<ForeignReaders>): ForeignReaders {
  return {
    listSessions: () => [],
    resolve: () => ({ kind: 'not-found', reference: '' }),
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
    ...overrides,
  }
}

// ---------- 开关读写 ----------

test('开关：缺省全开；config.json 缺失/损坏都视为全开', () => {
  const home = freshHome()
  assert.equal(isProviderEnabled('claude', home), true)
  assert.deepEqual(loadSwitches(home), { disabledProviders: [] })
  // 损坏的 config.json 不炸，回默认
  mkdirSync(home, { recursive: true })
  writeFileSync(switchesPath(home), 'not json{', 'utf-8')
  assert.equal(isProviderEnabled('codex', home), true)
})

test('开关：setProviderEnabled 持久化，重读后仍生效（重启语义）', () => {
  const home = freshHome()
  setProviderEnabled('grok', false, home)
  setProviderEnabled('pi', false, home)
  // 模拟重启：重新从磁盘读
  assert.equal(isProviderEnabled('grok', home), false)
  assert.equal(isProviderEnabled('pi', home), false)
  assert.equal(isProviderEnabled('claude', home), true)
  assert.deepEqual(loadSwitches(home).disabledProviders, ['grok', 'pi'])
  // 重新启用
  setProviderEnabled('grok', true, home)
  assert.equal(isProviderEnabled('grok', home), true)
  assert.deepEqual(loadSwitches(home).disabledProviders, ['pi'])
})

test('开关：未知 provider 抛中文错；损坏文件里的未知条目载入时丢弃', () => {
  const home = freshHome()
  assert.throws(() => setProviderEnabled('emacs', false, home), /未知 provider/)
  mkdirSync(home, { recursive: true })
  writeFileSync(switchesPath(home), JSON.stringify({ disabledProviders: ['emacs', 'cursor', 42] }), 'utf-8')
  assert.deepEqual(loadSwitches(home).disabledProviders, ['cursor'])
})

// ---------- 停用规范错误值 ----------

test('停用 provider：foreign_session_read 返回规范错误值「已停用」，list/show 同闸', async () => {
  const env = { isEnabled: (p: string) => p !== 'claude' }
  const listed = await foreignSessionRead({ provider: 'claude', action: 'list' }, fakeReaders(), env)
  assert.equal(listed.ok, false)
  if (!listed.ok) {
    assert.match(listed.error, /在设置中停用/)
    assert.match(listed.error, /claude/)
    assert.equal(listed.error, disabledError('claude'))
  }
  const shown = await foreignSessionRead({ provider: 'claude', action: 'show' }, fakeReaders(), env)
  assert.equal(shown.ok, false)
  if (!shown.ok) assert.match(shown.error, /在设置中停用/)
  // 未停用的家照常工作
  const ok = await foreignSessionRead({ provider: 'codex', action: 'list' }, fakeReaders(), env)
  assert.equal(ok.ok, true)
})

// ---------- buildState / clearArchived ----------

test('buildState：pending 概览 + archived 计数 + 支持矩阵八行', () => {
  const home = freshHome()
  const c1 = makeCard({ from: { agent: 'claude', session: 's1', title: '修收件箱' }, project: 'takeover', pushed_at: '2026-10-01T10:00:00+08:00' })
  const c2 = makeCard({ from: { agent: 'codex', session: 's2', title: '' }, pushed_at: '2026-10-02T10:00:00+08:00' })
  writeCard(c1, home)
  writeCard(c2, home)
  // 取件一张 → 进 archived
  loadCard(c1.id, home)

  setProviderEnabled('zcode', false, home)

  const readers = fakeReaders({
    adapterNote: (agent) => agent === 'zcode'
      ? { supported: false, note: '需要 Node ≥22（node:sqlite 内建模块）' }
      : { supported: true, note: '' },
    listSessions: (agent) => (agent === 'claude-code' ? [{}, {}, {}] : []) as never,
  })

  const st = buildState(readers, home)
  assert.equal(st.home, home) // 0.3.0：state 携带解析后的 HANDOFF_HOME（客户端已见集合键散列用）
  assert.equal(st.pending.length, 1)
  assert.equal(st.pending[0]?.id, c2.id)
  assert.equal(st.pending[0]?.agent, 'codex')
  assert.equal(st.pending[0]?.pushedAt, '2026-10-02T10:00:00+08:00')
  assert.equal(st.pending[0]?.preview, 'g') // goal 段进预览
  assert.equal(st.archivedCount, 1)

  assert.equal(st.providers.length, 8)
  const claude = st.providers.find((p) => p.name === 'claude')
  assert.equal(claude?.supported, true)
  assert.equal(claude?.sessions, 3)
  assert.equal(claude?.enabled, true)
  const zcode = st.providers.find((p) => p.name === 'zcode')
  assert.equal(zcode?.supported, false)
  assert.match(zcode?.note ?? '', /Node ≥22/)
  assert.equal(zcode?.enabled, false) // 开关停用
  assert.equal(zcode?.sessions, -1) // 不支持的家不探测
})

test('buildState：preview 空 goal 回退 done 段；超 240 字截断', () => {
  const home = freshHome()
  const long = '长'.repeat(300)
  const c1 = makeCard({ sections: { goal: '', files: '', done: long, remaining: '', stopped: '', warnings: '' } })
  const c2 = makeCard({ sections: { goal: '', files: '', done: '兜底内容', remaining: '', stopped: '', warnings: '' } })
  writeCard(c1, home)
  writeCard(c2, home)
  const st = buildState(fakeReaders(), home)
  const p1 = st.pending.find((p) => p.id === c1.id)
  const p2 = st.pending.find((p) => p.id === c2.id)
  assert.equal(p1?.preview.length, 241) // 240 字 + 省略号
  assert.match(p1?.preview ?? '', /…$/)
  assert.equal(p2?.preview, '兜底内容')
})

test('buildState：单家探测抛错只降级该行，不拖垮整体', () => {
  const home = freshHome()
  const readers = fakeReaders({
    listSessions: (agent) => {
      if (agent === 'cursor') throw new Error('db locked')
      return []
    },
  })
  const st = buildState(readers, home)
  const cursor = st.providers.find((p) => p.name === 'cursor')
  assert.equal(cursor?.sessions, -1)
  assert.equal(st.providers.filter((p) => p.sessions === 0).length, 7)
})

test('buildState：note 在探测后重取——discover 写回的假 0 哨兵首轮渲染即见', () => {
  const home = freshHome()
  // 模拟真实读取层：listSessions（discover）把假 0 哨兵写回适配器 note
  const notes = new Map<string, string>()
  const readers = fakeReaders({
    adapterNote: (agent) => ({ supported: true, note: notes.get(agent) ?? '' }),
    listSessions: (agent) => {
      notes.set(agent, '存储目录存在但未发现会话——上游可能已迁移存储布局（参考 opencode 1.18 迁 SQLite）')
      return []
    },
  })
  const st = buildState(readers, home)
  const claude = st.providers.find((p) => p.name === 'claude')
  assert.match(claude?.note ?? '', /存储目录存在但未发现会话/)
  assert.equal(claude?.sessions, 0)
})

test('clearArchived：清空归档并返回份数；目录不存在=0 不视为错误', () => {
  const home = freshHome()
  assert.equal(clearArchived(home), 0)
  const a1 = makeCard()
  const a2 = makeCard()
  writeCard(a1, home)
  writeCard(a2, home)
  loadCard(a1.id, home)
  loadCard(a2.id, home)
  assert.equal(clearArchived(home), 2)
  assert.equal(buildState(fakeReaders(), home).archivedCount, 0)
})

test('buildState：coverage 聚合（extras.coverage 求和），坏形态不计入', () => {
  const home = freshHome()
  const good1 = makeCard({ extras: { coverage: { statements: 3, marked: 2, unmarked: 1 } } })
  const good2 = makeCard({ extras: { coverage: { statements: 4, marked: 1, unmarked: 2 } } })
  const badShape = makeCard({ extras: { coverage: { statements: 'x' } } })
  writeCard(good1, home)
  writeCard(good2, home)
  writeCard(badShape, home)
  const st = buildState(fakeReaders(), home)
  assert.deepEqual(st.coverage, { statements: 7, marked: 3, unmarked: 3 })
})

test('buildState：无 coverage 卡时不产出 coverage 字段', () => {
  const home = freshHome()
  writeCard(makeCard(), home)
  const st = buildState(fakeReaders(), home)
  assert.equal(st.coverage, undefined)
})

// 回归（0.4.1）：全新安装首次 push 前 pending/ 不存在，buildState 曾误报「收件箱概览不可用：ENOENT」
test('buildState：全新安装（pending/ 不存在）不进降级态，矩阵照常', () => {
  const home = mkdtempSync(join(tmpdir(), 'takeover-fresh-'))
  const st = buildState(fakeReaders(), home)
  assert.equal(st.inboxError, undefined)
  assert.equal(st.pending.length, 0)
  assert.equal(st.providers.length, 8)
})

// 回归（0.4.1）：孤儿信封（对应 .md 已被任何实现取走）由 buildState 顺手清扫，envelopeChars 只计有主信封
test('buildState：孤儿信封被清扫，有主信封计入 envelopeChars', () => {
  const home = freshHome()
  const c = makeCard({ from: { agent: 'claude', session: 's9', title: '有主卡' } })
  writeCard(c, home)
  const pd = join(home, 'pending')
  writeFileSync(join(pd, `${c.id}.envelope.json`), '{"handoff":1,"kind":"envelope"}')
  writeFileSync(join(pd, 'ho-orphan-0001.envelope.json'), '{"handoff":1,"kind":"envelope"}')
  const st = buildState(fakeReaders(), home)
  assert.equal(existsSync(join(pd, 'ho-orphan-0001.envelope.json')), false, '孤儿信封应被删除')
  assert.ok(existsSync(join(pd, `${c.id}.envelope.json`)), '有主信封保留')
  assert.equal(st.envelopeChars, '{"handoff":1,"kind":"envelope"}'.length)
})
