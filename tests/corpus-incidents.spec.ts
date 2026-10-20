/**
 * ① 解析层 · 竞品事故回归（casr #10 一族：转换产物损坏 / 截断 / 非法字节）
 * 加转录边界（BOM / CRLF / 全损坏）。全部样本在测试内确定性构造，不依赖网络。
 *
 * 冻结的行为契约：
 * - 损坏行被静默跳过，不拖垮整个会话（parseJsonl 契约）；
 * - 截断文件 = 只解析出截断前的完整行；
 * - 非法 UTF-8 字节读入变 U+FFFD 后按行处理，不抛异常；
 * - 全损坏文件 → 空轮次（上层按「会话解析为空 UNAVAILABLE」浮出，不冒充正常）。
 * @module dsh-takeover/corpus-incidents
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname ?? '.', '..')
// env 先于 readers 首次加载；事故样本在临时根下即时构造
const incidentsHome = mkdtempSync(join(tmpdir(), 'dsh-incidents-'))
const projectsDir = join(incidentsHome, 'projects', 'proj')
mkdirSync(projectsDir, { recursive: true })
process.env['HANDOFF_ROOT_CLAUDE'] = projectsDir

const { defaultForeignReaders } = await import('../src/foreign.ts')
const { summarizeTurns } = await import('../src/foreign.ts')

const readers = await defaultForeignReaders()

/** 三个合法条目（结构对齐真实 claude 转录；内容合成） */
const goodEntries = [
  { type: 'user', cwd: '/corpus/proj1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: '把登录页的错误提示改成双语' } },
  { type: 'assistant', cwd: '/corpus/proj1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', model: 'test-model', content: [{ type: 'text', text: '已定位 i18n 词典缺失的键' }, { type: 'tool_use', id: 't1', name: 'edit', input: { file_path: '/corpus/proj1/src/i18n.ts', old: 'x', new: 'y' } }] } },
  { type: 'user', cwd: '/corpus/proj1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
]

function write(name: string, content: string | Buffer): string {
  const p = join(projectsDir, name)
  writeFileSync(p, content)
  return p
}

const find = (name: string) => readers.listSessions('claude-code').find((r) => r.title === name)

test('casr #10 · 截断转录：最后一行 JSON 写一半，前面的完整行照常解析', () => {
  const truncated = goodEntries.map((e) => JSON.stringify(e)).join('\n') + '\n{"type":"user","mess'
  write('casr10-truncated.jsonl', truncated)
  const ref = find('casr10-truncated')
  assert.ok(ref, '截断文件应被 discover 发现')
  const turns = readers.readSession('claude-code', ref)
  // 前三行完整：2 user 文本/结果 + 1 assistant 文本 + 1 assistant tool_use = 4 轮
  assert.equal(turns.length, 4)
  const { summary } = summarizeTurns(ref, turns)
  assert.match(summary.firstUserMessage, /登录页/)
})

test('casr #10 · 非法 UTF-8 字节：读入变替换符，该行不可解析被跳过，不抛异常', () => {
  const buf = Buffer.concat([
    Buffer.from(goodEntries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8'),
    Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), // { 0xFF 0xFE } —— 非法序列
  ])
  write('casr10-invalid-utf8.jsonl', buf)
  const ref = find('casr10-invalid-utf8')
  assert.ok(ref, '含非法字节的文件也应被发现（发现层不做内容校验）')
  const turns = readers.readSession('claude-code', ref)
  assert.equal(turns.length, 4, '只有前三行合法：第四行坏字节行被跳过')
})

test('casr #10 · 全损坏文件：空轮次，蒸馏降级为占位骨架（不冒充正常）', () => {
  write('casr10-all-corrupt.jsonl', 'not json at all\n{"broken": true, more\n')
  const ref = find('casr10-all-corrupt')
  assert.ok(ref)
  const turns = readers.readSession('claude-code', ref)
  assert.equal(turns.length, 0)
  const { summary, skeleton } = summarizeTurns(ref, turns)
  assert.equal(summary.turnCount, 0)
  assert.match(skeleton.stopped, /空会话/)
  assert.match(skeleton.done, /HISTORY_REPORTED|无 assistant 文本轮/)
})

test('转录边界 · UTF-8 BOM：trim 的 Unicode 空白语义恰好吸收 BOM，首条目不丢（实测冻结）', () => {
  // 同步工具转存可能引入 BOM。实测：parseJsonl 的行级 trim() 按 Unicode 空白集
  // 剥掉 U+FEFF——首条目完好。这不是巧合可依赖吗？是规范行为（ES WhiteSpace 含 ZWNBSP），
  // 冻结为契约：未来若有人把 trim 换成 ASCII 版，这里红即是提醒。
  const withBom = '\uFEFF' + JSON.stringify(goodEntries[0]) + '\n' + JSON.stringify(goodEntries[1])
  write('bom-ledger.jsonl', withBom)
  const ref = find('bom-ledger')
  assert.ok(ref)
  const turns = readers.readSession('claude-code', ref)
  // entry0 = 1 轮（user）+ entry1 = 2 轮（text + tool_use）= 3 轮，BOM 未吞任何条目
  assert.equal(turns.length, 3)
  assert.match(turns[0]?.text ?? '', /登录页/)
})

test('转录边界 · CRLF：\\r 被行内 trim 吸收，解析不受影响', () => {
  write('crlf.jsonl', goodEntries.map((e) => JSON.stringify(e)).join('\r\n') + '\r\n')
  const ref = find('crlf')
  assert.ok(ref)
  const turns = readers.readSession('claude-code', ref)
  assert.equal(turns.length, 4)
})

test('转录边界 · 空行穿插：静默跳过，不影响相邻行', () => {
  write('blank-lines.jsonl', ['\n', JSON.stringify(goodEntries[0]), '', '   ', JSON.stringify(goodEntries[1]), '\n'].join('\n'))
  const ref = find('blank-lines')
  assert.ok(ref)
  const turns = readers.readSession('claude-code', ref)
  // entry0 = 1 轮；entry1 = text + tool_use = 2 轮
  assert.equal(turns.length, 3)
})

test.after?.(() => { try { rmSync(incidentsHome, { recursive: true, force: true }) } catch { /* 清理失败不挡测试报告 */ } })
