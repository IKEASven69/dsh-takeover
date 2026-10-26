/**
 * 0.4.1 归因版 · 卡片生命周期事件层（死亡地图）测试。
 * 覆盖：闭集理由映射 / JSONL 读写与坏行容忍 / 尾部封顶 / 写侧闸拒收记录 /
 * 取侧核验记录 / state.rejections 组装（live+persisted）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordLifecycleEvent, readLifecycleEvents, reasonFromCoreSkip, lifecyclePath, LIFECYCLE_LOG_MAX } from '../src/lifecycle.ts'
import { buildState } from '../src/settings.ts'
import { pushHandoff } from '../src/tools.ts'

const READERS = {
  listSessions: () => [],
  resolve: () => { throw new Error('n/a') },
  readSession: () => [],
  adapterNote: () => ({ supported: true, note: '' }),
} as never

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-'))
  mkdirSync(join(dir, 'pending'), { recursive: true })
  return dir
}

describe('reasonFromCoreSkip：core 自由文本 → 闭集', () => {
  test('尺寸类命中 oversize，解析类命中 parse_error，其余 unknown', () => {
    assert.equal(reasonFromCoreSkip('文件超过 MAX_CARD_BYTES 8 MiB 上限'), 'oversize')
    assert.equal(reasonFromCoreSkip('card too big'), 'oversize')
    assert.equal(reasonFromCoreSkip('frontmatter yaml 解析失败'), 'parse_error')
    assert.equal(reasonFromCoreSkip('malformed id'), 'parse_error')
    assert.equal(reasonFromCoreSkip('什么都不是的怪话'), 'unknown')
    assert.equal(reasonFromCoreSkip(''), 'unknown')
  })
})

describe('recordLifecycleEvent / readLifecycleEvents', () => {
  test('追加 + 读回保真；坏行跳过不炸', () => {
    const dir = tmpHome()
    recordLifecycleEvent({ stage: 'write', reason: 'secret_gate', target: 't1', detail: '2 hits' }, dir, new Date('2026-10-26T00:00:00Z'))
    recordLifecycleEvent({ stage: 'pickup', reason: 'drift_mismatch', target: 'ho-x', detail: '1 处' }, dir, new Date('2026-10-26T00:01:00Z'))
    const ev = readLifecycleEvents(dir)
    assert.equal(ev.length, 2)
    assert.equal(ev[0]!.reason, 'secret_gate')
    assert.equal(ev[1]!.stage, 'pickup')
    // 手工插坏行
    const p = lifecyclePath(dir)
    writeFileSync(p, readFileSync(p, 'utf-8') + '{broken json\n', 'utf-8')
    assert.equal(readLifecycleEvents(dir).length, 2)
  })

  test('理由不在闭集 → 落盘为 unknown（写读一致）', () => {
    const dir = tmpHome()
    recordLifecycleEvent({ stage: 'read', reason: '怪理由' as never, target: 'f.md', detail: '' }, dir)
    assert.equal(readLifecycleEvents(dir)[0]!.reason, 'unknown')
  })

  test('尾部封顶：超 LIFECYCLE_LOG_MAX 只留最新段', () => {
    const dir = tmpHome()
    for (let i = 0; i < LIFECYCLE_LOG_MAX + 30; i++) {
      recordLifecycleEvent({ stage: 'read', reason: 'parse_error', target: `f${i}`, detail: '' }, dir, new Date(2026, 0, 1, 0, 0, i % 60, i))
    }
    const ev = readLifecycleEvents(dir)
    assert.equal(ev.length, LIFECYCLE_LOG_MAX)
    assert.equal(ev[ev.length - 1]!.target, `f${LIFECYCLE_LOG_MAX + 29}`)
  })
})

describe('写侧闸拒收 → 生命周期记录', () => {
  test('密钥闸命中即记 secret_gate（确认旁路则不记拒收）', () => {
    const dir = tmpHome()
    const secret = 'warnings: AKIAIOSFODNN7EXAMPLE'
    const r1 = pushHandoff(null, {
      goal: 'g', files: 'f', done: 'd', remaining: 'r', stopped: 's',
      warnings: 'aws key AKIAIOSFODNN7EXAMPLE 在正文',
    }, { dir })
    assert.equal(r1.ok, false)
    assert.equal(readLifecycleEvents(dir).some((e) => e.stage === 'write' && e.reason === 'secret_gate'), true)
    // 旁路落盘成功——不应新增拒收事件
    const before = readLifecycleEvents(dir).length
    pushHandoff(null, {
      goal: 'g', files: 'f', done: 'd', remaining: 'r', stopped: 's',
      warnings: 'aws key AKIAIOSFODNN7EXAMPLE 在正文', allowSecrets: true,
    }, { dir })
    assert.equal(readLifecycleEvents(dir).length, before)
  })

  test('空壳闸命中记 skeleton_gate；确认旁路不记', () => {
    const dir = tmpHome()
    const r = pushHandoff(null, {}, { dir })
    assert.equal(r.ok, false)
    assert.equal(readLifecycleEvents(dir).some((e) => e.reason === 'skeleton_gate'), true)
    pushHandoff(null, { confirmSkeleton: true }, { dir })
    assert.equal(readLifecycleEvents(dir).filter((e) => e.reason === 'skeleton_gate').length, 1)
  })
})

describe('state.rejections 组装', () => {
  test('live（坏卡）与 persisted（事件日志）都在场；全空时缺省', () => {
    const dir = tmpHome()
    // persisted 一条
    recordLifecycleEvent({ stage: 'write', reason: 'secret_gate', target: 't', detail: '' }, dir)
    // live 一张超尺寸坏卡（lenient 解析器容错太强，文本垃圾也能兜底——真正稳定触发
    // 读侧跳过的是 8MiB 尺寸闸）
    writeFileSync(join(dir, 'pending', 'ho-bigcard-0001.md'), 'x'.repeat(8 * 1024 * 1024 + 1))
    const st = buildState(READERS, dir)
    assert.equal(st.rejections?.live.length, 1)
    assert.equal(st.rejections?.live[0]!.reason, 'oversize')
    assert.equal(st.rejections?.persisted.length, 1)
    assert.equal(st.rejections?.persistedTotal, 1)
    // 全空 → rejections 缺省
    const empty = mkdtempSync(join(tmpdir(), 'lifecycle-empty-'))
    mkdirSync(join(empty, 'pending'), { recursive: true })
    const st2 = buildState(READERS, empty)
    assert.equal(st2.rejections, undefined)
    assert.ok(!existsSync(lifecyclePath(empty)), '全空目录不应产生日志文件')
  })
})
