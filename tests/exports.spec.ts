/**
 * 云端导出落盘过渡通路（exports 目录探测）测试：
 * - readers 侧：<HANDOFF_HOME>/exports/<provider>/ 的导出文件被现有文件系适配器
 *   原样吃掉（gemini 发现+解析直证；claude 走 provider 名目录 exports/claude、
 *   适配器别名同吃；纯 SQLite 四家不参与——诚实边界，不假装能吃）；
 * - 插件侧：buildState 支持矩阵两态——有导出文件该行出 exports 计数，
 *   无导出（目录缺失）全 0 且行为不变。
 * env（HANDOFF_HOME）必须先于 readers 首次加载（模块加载时读 exports 根，
 * 与 jsonl-family.spec 的 HANDOFF_ROOT_* 同手法；node --test 每文件独立进程）。
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foreignSessionRead, type ForeignReaders } from '../src/foreign.ts'
import { buildState, exportsCountOf } from '../src/settings.ts'

// ---------- env 先于 readers 首次加载（exports 根在模块加载时读） ----------

const HOME = mkdtempSync(join(tmpdir(), 'dsh-exports-'))
process.env['HANDOFF_HOME'] = HOME
const readers = await import('@agent-handoff/readers')
const { listSessions, readSession } = readers
after(() => { try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 临时目录尽力清 */ } })

const exportsPath = (provider: string, name: string): string => join(HOME, 'exports', provider, name)
const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const MS = 1790000000000 // 2026-09-21T14:13:20Z 附近（mtime 排序用，非断言依赖）

function writeExport(provider: string, name: string, data: string): void {
  mkdirSync(join(HOME, 'exports', provider), { recursive: true })
  writeFileSync(exportsPath(provider, name), data, 'utf-8')
}

// ---------- readers 侧：导出文件被现有适配器吃掉 ----------

test('exports（readers）：gemini 导出文件按原生格式丢进 exports/gemini/ 即被发现并解析', () => {
  writeExport('gemini', 'session-1760000000-abcd1234.jsonl', jsonl([
    { type: 'user', timestamp: '2026-11-01T01:00:00.000Z', content: '把云端导出的 gemini 会话吃掉' },
    { type: 'gemini', timestamp: '2026-11-01T01:01:00.000Z', content: [{ text: '好的，已读取。' }] },
  ]))
  const refs = listSessions('gemini')
  const hit = refs.find((r) => r.id === exportsPath('gemini', 'session-1760000000-abcd1234.jsonl'))
  assert.ok(hit, '导出文件应进 gemini 会话发现')
  assert.equal(hit?.kind, 'file')
  assert.equal(hit?.cwd, '', '导出文件无 cwd 记录，如实留空（不猜）')
  const turns = readSession('gemini', hit!.id)
  assert.deepEqual(
    turns.map((t) => `${t.role}:${t.text}`),
    ['user:把云端导出的 gemini 会话吃掉', 'assistant:好的，已读取。'],
    '解析应走 gemini 既有 parse（零新增解析面）',
  )
})

test('exports（readers）：claude 走 provider 名目录 exports/claude/，claude-code 适配器直吃', () => {
  writeExport('claude', 'exported-session.jsonl', jsonl([
    { type: 'user', message: { role: 'user', content: 'claude 云端导出的会话' } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: '已接手。' }] } },
  ]))
  const refs = listSessions('claude-code')
  const hit = refs.find((r) => r.id === exportsPath('claude', 'exported-session.jsonl'))
  assert.ok(hit, 'provider 名目录（claude）应被 claude-code 适配器发现')
  const turns = readSession('claude-code', hit!.id)
  assert.equal(turns[0]?.role, 'user')
  assert.match(turns[0]?.text ?? '', /claude 云端导出的会话/)
})

test('exports（readers）：纯 SQLite 四家不参与——导出文件不入册（诚实边界）', () => {
  writeExport('zcode', 'junk.jsonl', 'not-a-sqlite-file')
  const zcodeRoot = join(HOME, 'exports')
  const refs = listSessions('zcode')
  assert.ok(
    refs.every((r) => !r.id.startsWith(zcodeRoot)),
    'zcode 的 parse 只认库内会话 id，导出文件不得混入',
  )
})

test('exports（readers）：目录缺失=无导出，listSessions 照常返回（不炸不抛）', () => {
  // 本文件 fixture 只造了 gemini/claude/zcode 三家；qoder 家目录不存在
  assert.ok(Array.isArray(listSessions('qoder')))
})

// ---------- 插件侧：buildState 支持矩阵两态 ----------

function fakeReaders(): ForeignReaders {
  return {
    listSessions: () => [],
    resolve: () => ({ kind: 'not-found', reference: '' }),
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
  }
}

test('exports（buildState 两态）：有导出文件该行出计数，无导出（目录缺失）全 0', () => {
  // 态一：用前文测试未碰过的家（kimi / qoder）各写一个导出文件，计数精确到 1
  writeExport('kimi', 'two-state-a.jsonl', jsonl([{ type: 'turn.prompt', time: 1, input: [{ type: 'text', text: 'x' }] }]))
  writeExport('qoder', 'two-state-b.jsonl', jsonl([{ type: 'user', uuid: 'u', timestamp: '2026-11-01T01:00:00.000Z', message: { role: 'user', content: 'y' } }]))
  const st = buildState(fakeReaders(), HOME)
  assert.equal(st.providers.length, 23)
  const kimi = st.providers.find((p) => p.name === 'kimi')
  const qoder = st.providers.find((p) => p.name === 'qoder')
  const pi = st.providers.find((p) => p.name === 'pi')
  assert.equal(kimi?.exports, 1, 'kimi 行应显示 exports=1')
  assert.equal(qoder?.exports, 1, 'qoder 行应显示 exports=1')
  assert.equal(pi?.exports, 0, '无导出目录的家 = 0（两态之二：不出导出标）')
  // 态二：全新 home 无 exports/ 目录——全部行为 0，其余字段照常
  const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-exports-empty-'))
  try {
    const stEmpty = buildState(fakeReaders(), emptyHome)
    assert.ok(stEmpty.providers.every((p) => p.exports === 0), '无 exports 目录时全 0')
    assert.equal(stEmpty.inboxError, undefined)
  } finally {
    rmSync(emptyHome, { recursive: true, force: true })
  }
})

test('exports（exportsCountOf）：子目录不计、目录缺失=0、绝不抛出', () => {
  // 专属家（goose）：本文件其他测试不碰它的 exports 目录，计数可精确断言
  writeExport('goose', 'count-a.jsonl', jsonl([{ type: 'user', message: { role: 'user', content: 'x' } }]))
  mkdirSync(join(HOME, 'exports', 'goose', 'nested-dir'), { recursive: true })
  assert.equal(exportsCountOf('goose', HOME), 1, '子目录不是导出文件，不计')
  assert.equal(exportsCountOf('no-such-provider', HOME), 0, '目录缺失 = 0（不是错误）')
  assert.equal(exportsCountOf('goose', join(HOME, 'missing-home')), 0, 'home 缺失 = 0')
})

// ---------- 端到端：foreign_session_read（真实 readers）看见导出会话 ----------

test('exports（端到端）：foreign_session_read list 里能看到导出的 gemini 会话', async () => {
  const r = await foreignSessionRead({ provider: 'gemini', action: 'list' })
  if (!r.ok || r.action !== 'list') {
    assert.fail(`应为 list 规范值：${JSON.stringify(r).slice(0, 200)}`)
    return
  }
  const hit = r.sessions.find((s) => s.id === exportsPath('gemini', 'session-1760000000-abcd1234.jsonl'))
  assert.ok(hit, '工具发现层应并入导出落盘的会话')
  assert.equal(hit?.kind, 'file')
})
