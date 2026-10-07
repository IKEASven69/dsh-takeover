/**
 * 外部会话浏览器（面板第五区）测试：
 * - foreignSessionsList：轻量列表（不数轮数 → 不碰 readSession）、门控、limit 夹取、假 0 哨兵；
 * - foreignSessionPreview：摘要 + 骨架素材（永不吐 turns 原文）、not-found / 歧义 / 空会话；
 * - browser-view 纯函数：过滤 / 相对时间 / 接管与寄存指令（两行式）。
 * 读取层一律注入假货，不碰真实 ~/.claude 等目录。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  foreignSessionPreview,
  foreignSessionsList,
  type ForeignReaders,
} from '../src/index.ts'
import {
  depositCommand,
  depositTail,
  filterSessions,
  relTime,
  shortId,
  takeoverCommand,
  type SessionRow,
} from '../src/browser-view.ts'
import type { SessionRef, Turn } from '@agent-handoff/readers'
import { makeTurn } from '@agent-handoff/readers'

/** 造一个 SessionRef */
function ref(partial: Partial<SessionRef> & Pick<SessionRef, 'id' | 'agent'>): SessionRef {
  return {
    title: '',
    cwd: '',
    updatedAt: 0,
    fingerprint: '',
    kind: 'file',
    ...partial,
  }
}

const REFS: SessionRef[] = [
  ref({ id: 'C:\\sess\\aaa.jsonl', agent: 'claude-code', title: '收件箱开发', updatedAt: 3000, cwd: 'D:\\work\\dsh', kind: 'file' }),
  ref({ id: 'sess-bbb-2222', agent: 'claude-code', title: '收件箱测试', updatedAt: 2000, cwd: 'D:\\work\\dsh', kind: 'sqlite' }),
  ref({ id: 'sess-ccc-3333', agent: 'claude-code', title: '方案文档', updatedAt: 1000, cwd: '', kind: 'sqlite' }),
]

const TURNS: Turn[] = [
  makeTurn({ role: 'user', text: '帮我把收件箱做完', ts: '2026-09-30T01:00:00Z' }),
  makeTurn({ role: 'assistant', text: '好的。', ts: '2026-09-30T01:01:00Z' }),
  makeTurn({ role: 'user', text: '顺便写测试', ts: '2026-09-30T01:02:00Z' }),
]

function fakeReaders(overrides?: Partial<ForeignReaders>): ForeignReaders {
  return {
    listSessions: () => REFS,
    resolve: (_agent, reference) => {
      const q = reference.trim()
      if (q === '' || q === 'latest') return { kind: 'resolved', ref: REFS[0]! }
      const hits = REFS.filter((r) => r.id.startsWith(q) || r.title.includes(q))
      if (hits.length === 1) return { kind: 'resolved', ref: hits[0]! }
      if (hits.length > 1) return { kind: 'ambiguous', candidates: hits }
      return { kind: 'not-found', reference }
    },
    readSession: () => TURNS,
    adapterNote: () => ({ supported: true, note: '' }),
    ...overrides,
  }
}

// ---------- foreignSessionsList：轻量列表 ----------

test('浏览列表：只走发现层——readSession 一次都不许被调（轻量的意义）', async () => {
  let reads = 0
  const r = await foreignSessionsList({ provider: 'claude' }, fakeReaders({
    readSession: () => { reads += 1; return TURNS },
  }))
  assert.equal(r.ok, true)
  assert.equal(reads, 0)
  if (!r.ok) return
  assert.equal(r.provider, 'claude')
  assert.equal(r.total, 3)
  assert.equal(r.sessions.length, 3)
  assert.deepEqual(
    Object.keys(r.sessions[0] ?? {}).sort(),
    ['cwd', 'id', 'kind', 'title', 'updatedAt'],
    '列表行不带 turns——轮数字段是工具侧候选的专利',
  )
})

test('浏览列表：门控三连——未知名 / 已停用 / 读取器不可用，全是规范错误值', async () => {
  const unknown = await foreignSessionsList({ provider: 'emacs' }, fakeReaders())
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.error, /未知 provider/)

  const off = await foreignSessionsList({ provider: 'claude' }, fakeReaders(), { isEnabled: () => false })
  assert.equal(off.ok, false)
  if (!off.ok) assert.match(off.error, /停用/)

  const unsup = await foreignSessionsList({ provider: 'claude' }, fakeReaders({
    adapterNote: () => ({ supported: false, note: '需要 Node ≥22' }),
  }))
  assert.equal(unsup.ok, false)
  if (!unsup.ok) assert.match(unsup.error, /读取器不可用/)
})

test('浏览列表：limit 夹取（0/负 → 默认 40，爆表 → 200）；发现失败规范错误值', async () => {
  const def = await foreignSessionsList({ provider: 'claude', limit: 0 }, fakeReaders())
  const capped = await foreignSessionsList({ provider: 'claude', limit: 9999 }, fakeReaders())
  assert.equal(def.ok && capped.ok, true)
  if (def.ok && capped.ok) {
    assert.equal(def.sessions.length, 3) // 不足默认值就全给
    assert.equal(capped.sessions.length, 3) // 夹取只看上限，不越数据
  }
  const boom = await foreignSessionsList({ provider: 'claude' }, fakeReaders({
    listSessions: () => { throw new Error('db locked') },
  }))
  assert.equal(boom.ok, false)
  if (!boom.ok) assert.match(boom.error, /db locked/)
})

test('浏览列表：假 0 哨兵随 note 下发（与支持矩阵同口径浮出）', async () => {
  const r = await foreignSessionsList({ provider: 'claude' }, fakeReaders({
    adapterNote: () => ({ supported: true, note: '存储目录存在但未发现会话' }),
    listSessions: () => [],
  }))
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.total, 0)
    assert.equal(r.sessions.length, 0)
    assert.match(r.note ?? '', /未发现会话/)
  }
})

// ---------- foreignSessionPreview：单会话结构化预览 ----------

test('预览：摘要 + 骨架素材齐全，但永不返回 turns 原文（原文是模型的深读通道）', async () => {
  const r = await foreignSessionPreview({ provider: 'claude', reference: '收件箱开发' }, fakeReaders())
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.summary.userTurns, 2)
  assert.match(r.skeleton.stopped, /停在会话最后一轮/)
  assert.match(r.skeleton.warnings, /HISTORY_REPORTED/)
  assert.equal(r.note, undefined)
  const keys = JSON.stringify(r)
  assert.doesNotMatch(keys, /turnsOffset|firstUserMessage.*tailProgress.*#0/, '响应里不得出现分页原文轮次')
})

test('预览：not-found / 歧义 / 空会话三态诚实', async () => {
  const miss = await foreignSessionPreview({ provider: 'claude', reference: 'sess-nope' }, fakeReaders())
  assert.equal(miss.ok, false)
  if (!miss.ok) assert.match(miss.error, /找不到会话/)

  const amb = await foreignSessionPreview({ provider: 'claude', reference: '收件箱' }, fakeReaders())
  assert.equal(amb.ok, false)
  if (!amb.ok) {
    assert.match(amb.error, /歧义/)
    assert.equal(amb.candidates?.length, 2)
  }

  const empty = await foreignSessionPreview({ provider: 'claude', reference: '收件箱开发' }, fakeReaders({
    readSession: () => [],
  }))
  assert.equal(empty.ok, true)
  if (empty.ok) assert.match(empty.note ?? '', /解析为空/)
})

test('预览：门控与列表同一套（停用闸先于探测）', async () => {
  const off = await foreignSessionPreview({ provider: 'claude', reference: 'x' }, fakeReaders(), { isEnabled: () => false })
  assert.equal(off.ok, false)
  if (!off.ok) assert.match(off.error, /停用/)
})

// ---------- browser-view 纯函数 ----------

const ROWS: SessionRow[] = [
  { id: 'C:\\s\\a.jsonl', title: '收件箱开发', cwd: 'D:\\work\\dsh', updatedAt: '2026-10-06T08:00:00Z', kind: 'file' },
  { id: 'sess-bbb', title: 'Research notes', cwd: 'D:\\work\\lab', updatedAt: '2026-10-05T08:00:00Z', kind: 'sqlite' },
]

test('filterSessions：标题/目录/id 子串、大小写不敏感、空 query 原样返回', () => {
  assert.equal(filterSessions(ROWS, '').length, 2)
  assert.equal(filterSessions(ROWS, '  ').length, 2)
  assert.equal(filterSessions(ROWS, '收件箱').length, 1)
  assert.equal(filterSessions(ROWS, 'research').length, 1) // 大小写不敏感
  assert.equal(filterSessions(ROWS, 'LAB').length, 1) // 目录命中
  assert.equal(filterSessions(ROWS, 'BBB').length, 1) // id 命中
  assert.equal(filterSessions(ROWS, '不存在的词').length, 0)
})

test('relTime：分钟/小时/天分桶 + 超月回退绝对日期 + 双语', () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0)
  assert.equal(relTime('2026-10-06T11:59:30Z', now, 'zh'), '刚刚')
  assert.equal(relTime('2026-10-06T11:00:00Z', now, 'zh'), '1小时前')
  assert.equal(relTime('2026-10-06T11:00:00Z', now, 'en'), '1h ago')
  assert.equal(relTime('2026-10-04T12:00:00Z', now, 'zh'), '2天前')
  assert.match(relTime('2026-08-01T00:00:00Z', now, 'zh'), /^2026-08-01$/)
  assert.equal(relTime('', now, 'en'), '(no time)')
  assert.equal(relTime('不是时间', now, 'zh'), '不是时间') // 解析失败诚实回原串
})

test('指令生成：接管单行；寄存两行式——第二行是给模型的指示，不是引用', () => {
  assert.equal(takeoverCommand('claude', 'C:\\s\\a.jsonl'), '/resume-claude C:\\s\\a.jsonl')
  const dep = depositCommand('zcode', 'sess-1', 'zh')
  const lines = dep.split('\n')
  assert.equal(lines.length, 2)
  assert.equal(lines[0], '/resume-zcode sess-1')
  assert.match(lines[1] ?? '', /寄存/)
  // 构建管线回归哨兵：esbuild 未压缩构建曾把模板内 \n 煮成「真换行+缩进」，
  // 第二行混入前导 tab——第二行首字符必须直接是指示文本
  assert.match(lines[1]?.charAt(0) ?? '', /[\u4e00-\u9fff]/, '第二行不得有前导空白')
  assert.match(depositTail('en'), /deposit/i)
})

test('shortId：文件系只显示文件名，SQLite 系原样', () => {
  assert.equal(shortId(ROWS[0]!), 'a.jsonl')
  assert.equal(shortId(ROWS[1]!), 'sess-bbb')
})
