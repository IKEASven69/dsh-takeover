/**
 * 接力年鉴（relay-almanac）测试。
 * 覆盖：fixture 账本逐 reason 对账 / provider distinct 只计非空值 / 窗口诚实字符串
 * （「尾部 500 条」「滚动 50 张」在册 + 负向无全局口吻）/ 零数据诚实句 / 确定性逐字节 /
 * 隐私负向（无卡正文·无绝对路径·无会话 id·无 detail 全文）/ 目录缺席不抛。
 * 演示数据只进测试：全部断言跑在 mkdtemp fixture 上，不碰 ~/.handoff 真实账本
 * （计数随本机排放漂移，真机数字不可入册）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAlmanac, renderAlmanac } from '../src/almanac.ts'
import { LIFECYCLE_REASONS, LIFECYCLE_LOG_MAX } from '../src/lifecycle.ts'
import { ARCHIVED_KEEP } from '@agent-handoff/core'

/** 一次性 fixture 家目录（绝不触碰真实 ~/.handoff） */
function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'almanac-'))
}

/** 账本行装配（LifecycleEvent 形态原样落盘；坏行由调用方自拼） */
function line(at: string, stage: string, reason: string, target: string, detail: string): string {
  return JSON.stringify({ at, stage, reason, target, detail })
}

function writeLifecycle(dir: string, lines: string[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'lifecycle.jsonl'), `${lines.join('\n')}\n`, 'utf-8')
}

function writeRelay(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, 'relay'), { recursive: true })
  writeFileSync(join(dir, 'relay', name), body, 'utf-8')
}

function writeArchived(dir: string, names: string[]): void {
  mkdirSync(join(dir, 'archived'), { recursive: true })
  for (const n of names) writeFileSync(join(dir, 'archived', n), 'x', 'utf-8')
}

describe('fixture 账本逐 reason 对账（直方图逐项相等）', () => {
  test('mixed reasons：闭集全量直方图与账本行逐项相等；坏行与开集理由按 reader 同口径归位', () => {
    const dir = tmpHome()
    writeLifecycle(dir, [
      line('2026-10-26T07:25:54.068Z', 'write', 'secret_gate', 'untitled', '1 hits'),
      line('2026-10-26T07:25:54.240Z', 'write', 'secret_gate', 't2', '1 hits'),
      line('2026-10-27T07:25:54.240Z', 'write', 'secret_gate', 't3', '2 hits'),
      line('2026-10-28T08:00:00.000Z', 'read', 'parse_error', 'f1.md', 'yaml 坏'),
      line('2026-10-28T08:01:00.000Z', 'read', 'parse_error', 'f2.md', 'frontmatter 坏'),
      line('2026-11-17T10:28:27.970Z', 'write', 'lifeboat', 'ho-abc-123', '面板一键抢出（不经模型）'),
      line('2026-11-18T09:00:00.000Z', 'pickup', 'drift_mismatch', 'ho-def-456', '1 处'),
      line('2026-11-18T09:30:00.000Z', 'pickup', 'continued', 'ho-def-456', '延续回执卡 ho-ghi-789（evidence 3 条）'),
      '{broken json',
      line('2026-11-18T10:00:00.000Z', 'write', '怪理由不在闭集', 'f3.md', ''),
    ])
    const stats = buildAlmanac(dir)
    // 9 行有效事件（坏行被 reader 跳过；开集「怪理由」行本身有效、被 reader 归 unknown）
    assert.equal(stats.events, 9)
    // 逐项相等：全闭集在册（缺席理由 0），命中理由与 fixture 行数一一对应
    const expected = Object.fromEntries(LIFECYCLE_REASONS.map((r) => [r, 0])) as Record<string, number>
    expected['secret_gate'] = 3
    expected['parse_error'] = 2
    expected['lifeboat'] = 1
    expected['drift_mismatch'] = 1
    expected['continued'] = 1
    expected['unknown'] = 1
    assert.deepEqual(stats.reasons, expected)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('provider distinct 只计非空值', () => {
  test('空串/缺席/纯空白不计入；同家多份去重一家；坏文件进 unread 不拖垮', () => {
    const dir = tmpHome()
    const at = '2026-11-19T00:00:00.000Z'
    writeRelay(dir, 'a.json', JSON.stringify({ sessionId: 'SESSMARKER1', provider: 'zcode', at }))
    writeRelay(dir, 'b.json', JSON.stringify({ sessionId: 's2', provider: '', at }))
    writeRelay(dir, 'c.json', JSON.stringify({ sessionId: 's3', at })) // provider 缺席
    writeRelay(dir, 'd.json', JSON.stringify({ sessionId: 's4', provider: '   ', at })) // 纯空白
    writeRelay(dir, 'e.json', JSON.stringify({ sessionId: 's5', provider: 'claude', at }))
    writeRelay(dir, 'f.json', JSON.stringify({ sessionId: 's6', provider: 'zcode', at })) // 同家第二份
    writeRelay(dir, 'g.json', '{not json') // 坏文件
    writeRelay(dir, 'h.txt', JSON.stringify({ provider: 'gemini', at })) // 非 .json 不清点
    const stats = buildAlmanac(dir)
    assert.equal(stats.relay.files, 7) // 只清点 .json（h.txt 不进）
    assert.equal(stats.relay.withProvider, 3) // zcode ×2 + claude
    assert.deepEqual(stats.relay.providers, ['claude', 'zcode']) // 字典序
    assert.equal(stats.relay.distinctProviders, 2) // 同家去重一家；空/缺席/空白不计
    assert.equal(stats.relay.unread, 1) // 坏文件 fail-open 计一笔
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('lifeboat 目标列表只含 id 不落 detail 全文', () => {
  test('targets 形态只有 id+at；detail 原文不进 stats 也不进渲染', () => {
    const dir = tmpHome()
    const detail = '面板一键抢出（不经模型）DETAIL-MARKER-不应外泄'
    writeLifecycle(dir, [
      line('2026-11-17T10:28:27.970Z', 'write', 'lifeboat', 'ho-mwkjukzf-h4e4', detail),
      line('2026-11-17T10:29:00.000Z', 'write', 'lifeboat', 'ho-second-0001', detail),
    ])
    const stats = buildAlmanac(dir)
    assert.equal(stats.lifeboat.count, 2)
    // 形态逐项断言：只有 id 与 at 两个字段
    assert.deepEqual(stats.lifeboat.targets, [
      { id: 'ho-mwkjukzf-h4e4', at: '2026-11-17T10:28:27.970Z' },
      { id: 'ho-second-0001', at: '2026-11-17T10:29:00.000Z' },
    ])
    const md = renderAlmanac(stats)
    assert.ok(md.includes('ho-mwkjukzf-h4e4'))
    assert.ok(!md.includes('DETAIL-MARKER')) // detail 全文不进年鉴
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('窗口诚实字符串（标注在册 + 负向无全局口吻）', () => {
  test('渲染必须含「尾部 500 条」「滚动 50 张」，且不以全总线口吻自夸', () => {
    const dir = tmpHome()
    writeLifecycle(dir, [line('2026-11-17T10:28:27.970Z', 'write', 'lifeboat', 'ho-x', '面板一键抢出')])
    writeArchived(dir, ['ho-x.md', 'ho-x.patch'])
    const md = renderAlmanac(buildAlmanac(dir))
    // 窗口标注逐字在册（常量驱动：LIFECYCLE_LOG_MAX=500 / ARCHIVED_KEEP=50）
    assert.ok(md.includes(`尾部 ${LIFECYCLE_LOG_MAX} 条`), '必须有账本尾部窗口标注')
    assert.ok(md.includes(`滚动 ${ARCHIVED_KEEP} 张`), '必须有归档滚动窗口标注')
    assert.ok(md.includes('以重跑为准'), '必须带「以重跑为准」漂移语义')
    // 负向：这台机器的故事，不是全总线口吻
    assert.ok(!md.includes('全总线'), '不得出现「全总线」全局口吻')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('零数据诚实句（非空报表）', () => {
  test('全新机器：出「这条总线还没有故事」诚实句，不是空报表', () => {
    const dir = tmpHome() // 目录存在但全空
    const stats = buildAlmanac(dir)
    assert.equal(stats.events, 0)
    assert.equal(stats.relay.files, 0)
    assert.equal(stats.archived.cards, 0)
    const md = renderAlmanac(stats)
    assert.ok(md.trim().length > 0, '非空报表')
    assert.ok(md.includes('这条总线还没有故事'))
    // 窗口口径照旧在册（诚实句不豁免标注）
    assert.ok(md.includes(`尾部 ${LIFECYCLE_LOG_MAX} 条`))
    assert.ok(md.includes(`滚动 ${ARCHIVED_KEEP} 张`))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('确定性（同输入同输出逐字节）', () => {
  test('buildAlmanac 同参重放 deepEqual；renderAlmanac 两次输出 ===', () => {
    const dir = tmpHome()
    writeLifecycle(dir, [
      line('2026-10-26T07:25:54.068Z', 'write', 'secret_gate', 'untitled', '1 hits'),
      line('2026-11-17T10:28:27.970Z', 'write', 'lifeboat', 'ho-x', '面板一键抢出'),
    ])
    writeRelay(dir, 'a.json', JSON.stringify({ sessionId: 's1', provider: 'zcode', at: '2026-11-19T00:00:00.000Z' }))
    writeArchived(dir, ['ho-x.md', 'ho-x.patch', 'ho-x.envelope.json'])
    const now = new Date('2026-11-20T00:00:00.000Z')
    const s1 = buildAlmanac(dir, now)
    const s2 = buildAlmanac(dir, now)
    assert.deepEqual(s1, s2)
    assert.equal(s1.generatedAt, '2026-11-20T00:00:00.000Z') // now 入参被如实采纳
    const r1 = renderAlmanac(s1)
    const r2 = renderAlmanac(s2)
    assert.equal(r1, r2) // 逐字节
    assert.equal(r1, renderAlmanac(s1)) // 同对象重放仍逐字节
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('隐私负向（无卡正文、无绝对路径，只含计数与 id 形态）', () => {
  test('渲染不含 fixture 绝对路径 / 卡正文 / 会话 id / 溯源标题', () => {
    const dir = tmpHome()
    // 密钥形靶拼接构造（takeover.spec.ts:486 同款纪律）：测试源码不出现完整密钥字面量
    // ——pushHandoff 的补丁面会吞 untracked 测试文件进扫描（tools.ts augmentPatchWithUntracked），
    // 完整字面量落盘会把本仓全部无 cwd 推送误拦在密钥闸（round-1 全量门实测教训）
    const secretShape = 'AKIA' + 'IOSFODNN7EXAMPLE'
    writeLifecycle(dir, [
      line('2026-10-26T07:25:54.068Z', 'write', 'secret_gate', `${secretShape}-形靶`, '1 hits：AWS Access Key'),
      line('2026-11-17T10:28:27.970Z', 'write', 'lifeboat', 'ho-x', '面板一键抢出'),
    ])
    writeRelay(dir, 'a.json', JSON.stringify({
      sessionId: 'SESSMARKER1', provider: 'zcode', sourceId: 'SRCIDMARKER2',
      title: 'TITLEMARKER3：目标会话标题', cardId: 'ho-x', at: '2026-11-19T00:00:00.000Z',
    }))
    writeArchived(dir, ['ho-x.md'])
    const md = renderAlmanac(buildAlmanac(dir))
    assert.ok(!md.includes(dir), '不得泄漏 fixture 绝对路径')
    assert.ok(!md.includes('AKIA'), '不得带密钥形态文本')
    assert.ok(!md.includes('SESSMARKER1'), '不得泄漏本机 sessionId')
    assert.ok(!md.includes('SRCIDMARKER2'), '不得泄漏 sourceId')
    assert.ok(!md.includes('TITLEMARKER3'), '不得泄漏会话标题')
    assert.ok(!md.includes('1 hits'), '事件 detail 原文不进年鉴')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('目录缺席不抛', () => {
  test('home 不存在：零态返回不抛、无降级附注；渲染仍出诚实句', () => {
    const absent = join(tmpdir(), `almanac-absent-${Date.now()}`)
    let stats: ReturnType<typeof buildAlmanac> | undefined
    assert.doesNotThrow(() => { stats = buildAlmanac(absent) })
    assert.equal(stats!.events, 0)
    assert.equal(stats!.relay.files, 0)
    assert.equal(stats!.archived.cards, 0)
    assert.equal(stats!.notes.length, 0) // 缺席 = 诚实零态，不是降级
    assert.ok(renderAlmanac(stats!).includes('这条总线还没有故事'))
    rmSync(absent, { recursive: true, force: true })
  })

  test('坏文件 fail-open：坏 JSON / 坏账本行 / 目录混杂逐一跳过，聚合不炸', () => {
    const dir = tmpHome()
    writeLifecycle(dir, ['{broken', line('2026-11-17T10:28:27.970Z', 'write', 'lifeboat', 'ho-x', '')])
    writeRelay(dir, 'bad.json', '{{{')
    writeArchived(dir, ['ho-x.md'])
    let stats: ReturnType<typeof buildAlmanac> | undefined
    assert.doesNotThrow(() => { stats = buildAlmanac(dir) })
    assert.equal(stats!.events, 1)
    assert.equal(stats!.relay.unread, 1)
    assert.equal(stats!.archived.cards, 1)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('归档窗口现场清点（.md 卡与侧车分开数）', () => {
  test('md 进 cards、其余进 sidecars；keep 常量如实透传', () => {
    const dir = tmpHome()
    writeArchived(dir, ['a.md', 'b.md', 'a.patch', 'a.envelope.json', 'a.hippo.jsonl'])
    const stats = buildAlmanac(dir)
    assert.equal(stats.archived.cards, 2)
    assert.equal(stats.archived.sidecars, 3)
    assert.equal(stats.archived.keep, ARCHIVED_KEEP)
    rmSync(dir, { recursive: true, force: true })
  })
})
