/**
 * 覆盖率统计（A：四态账本产品化）与机器信封（B：双形态输出）单测。
 * 纯函数直测 + pushHandoff/inboxLoad 集成；落盘一律走临时 HANDOFF_HOME，不碰真实 ~/.handoff。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCard, writeCard, type Card } from '@agent-handoff/core'
import {
  COVERAGE_MARKERS,
  ENVELOPE_DONE_MAX,
  ENVELOPE_FILES_MAX,
  ENVELOPE_FILE_LINE_MAX,
  ENVELOPE_FROM_MAX,
  ENVELOPE_GOAL_MAX,
  ENVELOPE_REMAINING_MAX,
  ENVELOPE_STOPPED_MAX,
  ENVELOPE_WARNINGS_MAX,
  buildEnvelope,
  coverageFromExtras,
  coverageOfDone,
  envelopePath,
  inboxLoad,
  pushHandoff,
  renderCoverageLine,
  renderInbox,
  renderPush,
} from '../src/tools.ts'

/** 造一个独立 HANDOFF_HOME 临时目录（用例结束清理） */
function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-coverage-test-'))
}

// ---------------------------------------------------------------------------
// A. coverageOfDone：确定性统计（ask 用例逐条覆盖）
// ---------------------------------------------------------------------------

test('统计：三行一标两不标 → {statements:3, marked:1, unmarked:2}', () => {
  const stats = coverageOfDone('第一行没标\n第二行（HISTORY_REPORTED）\n第三行没标')
  assert.deepEqual(stats, { statements: 3, marked: 1, unmarked: 2 })
})

test('统计：全标 → unmarked:0（四个标记逐一都认）', () => {
  for (const marker of COVERAGE_MARKERS) {
    const stats = coverageOfDone(`a（${marker}）\nb（${marker}）`)
    assert.deepEqual(stats, { statements: 2, marked: 2, unmarked: 0 }, `标记 ${marker} 未被识别`)
  }
})

test('统计：空 done → 全零', () => {
  assert.deepEqual(coverageOfDone(''), { statements: 0, marked: 0, unmarked: 0 })
  assert.deepEqual(coverageOfDone('\n\n  \n'), { statements: 0, marked: 0, unmarked: 0 })
})

test('统计：空行与 # 小节标题行不计入陈述；CRLF 按行拆', () => {
  const stats = coverageOfDone('## 做到哪\r\n\r\n改动一（HISTORY_REPORTED）\r\n## 子标题\r\n改动二')
  assert.deepEqual(stats, { statements: 2, marked: 1, unmarked: 1 })
})

test('统计：非字符串输入防御回零（不抛）', () => {
  assert.deepEqual(coverageOfDone(undefined as unknown as string), { statements: 0, marked: 0, unmarked: 0 })
})

// ---------------------------------------------------------------------------
// A. push/inbox 集成：extras.coverage 随卡持久化 + 双向渲染行
// ---------------------------------------------------------------------------

test('push：coverage 进 PushResult 与卡片 extras，取件 parseCard 可读回', () => {
  const dir = tmpHome()
  try {
    const r = pushHandoff(null, {
      done: '改完 tools.ts（HISTORY_REPORTED）\n测试全绿（CURRENT_OBSERVED）\n还差文档',
    }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.deepEqual(r.coverage, { statements: 3, marked: 2, unmarked: 1 })

    // YAML frontmatter round-trip：extras.coverage 落盘后经 parseCard 读回等值
    const card = parseCard(readFileSync(r.path, 'utf-8'))
    assert.deepEqual(coverageFromExtras(card.extras), r.coverage)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderPush：coverage 有效输出「账本覆盖」行，缺省省行', () => {
  const withCoverage = renderPush({}, {
    ok: true, id: 'ho-x-0001', path: '/tmp/ho-x-0001.md', skipped: false, note: '',
    coverage: { statements: 3, marked: 1, unmarked: 2 },
  })
  assert.deepEqual(withCoverage, [{
    type: 'text',
    text: assertTextContains(
      String(withCoverage[0]?.text),
      '账本覆盖：1/3 条已标注状态（2 条未标——取件方按 HISTORY_REPORTED 处理）',
    ),
  }])

  const withoutCoverage = renderPush({}, { ok: true, id: 'ho-x-0001', path: '/p.md', skipped: false, note: '' })
  assert.equal(String(withoutCoverage[0]?.text).includes('账本覆盖'), false, '无统计不应渲染空行')

  // 坏形态（外来卡/漂移数据）静默省行，不渲染不报错
  const bad = renderPush({}, { ok: true, id: 'ho-x-0001', path: '/p.md', coverage: { statements: 'x' } })
  assert.equal(String(bad[0]?.text).includes('账本覆盖'), false)
})

/** 断言 hay 包含 needle 并原样返回 hay（让 deepEqual 的期望文本可读） */
function assertTextContains(hay: string, needle: string): string {
  assert.ok(hay.includes(needle), `期望包含：${needle}\n实际：${hay}`)
  return hay
}

test('inbox：load 返回卡内 extras.coverage，renderInbox 输出同款一行', () => {
  const dir = tmpHome()
  try {
    const r = pushHandoff(null, { done: '一（MISMATCH）\n二' }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return

    const loaded = inboxLoad(r.id, { dir })
    assert.equal(loaded.ok, true)
    if (!loaded.ok) return
    assert.deepEqual(loaded.coverage, { statements: 2, marked: 1, unmarked: 1 })

    const text = String(renderInbox({}, loaded)[0]?.text)
    assert.ok(text.includes('账本覆盖：1/2 条已标注状态（1 条未标——取件方按 HISTORY_REPORTED 处理）'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('coverageFromExtras / renderCoverageLine：坏形态一律 undefined / null', () => {
  assert.equal(coverageFromExtras(undefined), undefined)
  assert.equal(coverageFromExtras(null), undefined)
  assert.equal(coverageFromExtras('x'), undefined)
  assert.equal(coverageFromExtras({ coverage: null }), undefined)
  assert.equal(coverageFromExtras({ coverage: { statements: 1, marked: -1, unmarked: 0 } }), undefined)
  assert.equal(coverageFromExtras({ coverage: { statements: 1.5, marked: 1, unmarked: 0.5 } }), undefined)
  assert.deepEqual(coverageFromExtras({ coverage: { statements: 2, marked: 0, unmarked: 2 } }), { statements: 2, marked: 0, unmarked: 2 })
  assert.equal(renderCoverageLine('3/8'), null)
  assert.equal(
    renderCoverageLine({ statements: 8, marked: 3, unmarked: 5 }),
    '账本覆盖：3/8 条已标注状态（5 条未标——取件方按 HISTORY_REPORTED 处理）',
  )
})

// ---------------------------------------------------------------------------
// B. 机器信封：buildEnvelope 纯函数（确定性 + 截断上限）
// ---------------------------------------------------------------------------

test('信封：最小输入全缺省，输出结构确定', () => {
  const env = buildEnvelope({ sections: {} })
  assert.deepEqual(env, {
    handoff: 1,
    kind: 'envelope',
    id: '',
    from: { agent: '', title: '' },
    goal: '',
    done: '',
    remaining: '',
    stopped: '',
    warnings: '',
    files: [],
  })
  // 确定性：同一输入永远同一 JSON
  assert.equal(JSON.stringify(buildEnvelope({ sections: {} })), JSON.stringify(env))
})

test('信封：各段截断上限（goal/done 300，remaining/stopped/warnings 200，from 100）', () => {
  const env = buildEnvelope({
    id: 'ho-x-0001',
    from: { agent: 'dsh', title: 'T'.repeat(ENVELOPE_FROM_MAX + 100) },
    sections: {
      goal: 'G'.repeat(ENVELOPE_GOAL_MAX + 100),
      done: 'D'.repeat(ENVELOPE_DONE_MAX + 100),
      remaining: 'R'.repeat(ENVELOPE_REMAINING_MAX + 100),
      stopped: 'S'.repeat(ENVELOPE_STOPPED_MAX + 100),
      warnings: 'W'.repeat(ENVELOPE_WARNINGS_MAX + 100),
    },
  })
  assert.equal(env.goal.length, ENVELOPE_GOAL_MAX)
  assert.equal(env.done.length, ENVELOPE_DONE_MAX)
  assert.equal(env.remaining.length, ENVELOPE_REMAINING_MAX)
  assert.equal(env.stopped.length, ENVELOPE_STOPPED_MAX)
  assert.equal(env.warnings.length, ENVELOPE_WARNINGS_MAX)
  assert.equal(env.from.title.length, ENVELOPE_FROM_MAX)
  assert.equal(env.from.agent, 'dsh')
  // 顶格不截：恰好等于上限时原样保留
  const exact = buildEnvelope({ sections: { goal: 'G'.repeat(ENVELOPE_GOAL_MAX) } })
  assert.equal(exact.goal.length, ENVELOPE_GOAL_MAX)
})

test('信封：files 段取前 10 条非空行，单条截 120', () => {
  const longLine = 'P'.repeat(ENVELOPE_FILE_LINE_MAX + 80)
  const lines = [
    '  - write: src/tools.ts  ', // 前后空白应 trim
    '', // 空行不计
    '   ',
    longLine,
    ...Array.from({ length: ENVELOPE_FILES_MAX + 4 }, (_, i) => `- file-${i}.ts`),
  ]
  const env = buildEnvelope({ sections: { files: lines.join('\n') } })
  assert.equal(env.files.length, ENVELOPE_FILES_MAX)
  assert.equal(env.files[0], '- write: src/tools.ts')
  assert.equal(env.files[1]?.length, ENVELOPE_FILE_LINE_MAX)
  assert.equal(env.files[2], '- file-0.ts')
  assert.equal(env.files.at(-1), '- file-7.ts', '只取前 10 条（file-8 及以后不进）')
  // files 段缺失/非字符串 → 空数组
  assert.deepEqual(buildEnvelope({ sections: {} }).files, [])
})

// ---------------------------------------------------------------------------
// B. 机器信封：push 落盘 / load 同步消费（集成）
// ---------------------------------------------------------------------------

test('push：envelope 文件存在、JSON 可解析、结构字段正确', () => {
  const dir = tmpHome()
  try {
    const r = pushHandoff(null, { title: '信封测试', goal: 'g', done: 'd（HISTORY_REPORTED）' }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const p = envelopePath(r.id, dir)
    assert.ok(existsSync(p), `信封未落盘：${p}`)
    assert.equal(p, join(dir, 'pending', `${r.id}.envelope.json`))

    const env = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    assert.deepEqual(Object.keys(env).sort(), [
      'done', 'files', 'from', 'goal', 'handoff', 'id', 'kind', 'remaining', 'stopped', 'warnings',
    ])
    assert.equal(env.handoff, 1)
    assert.equal(env.kind, 'envelope')
    assert.equal(env.id, r.id)
    assert.deepEqual(env.from, { agent: 'dsh', title: '信封测试' })
    assert.equal(env.done, 'd（HISTORY_REPORTED）')
    assert.ok(Array.isArray(env.files))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('push：信封各段随卡截断（长段进卡 128K 上限内，进信封按段上限截）', () => {
  const dir = tmpHome()
  try {
    const files = Array.from({ length: ENVELOPE_FILES_MAX + 5 }, (_, i) => `- src/file-${i}.ts`).join('\n')
    const r = pushHandoff(null, {
      goal: 'G'.repeat(ENVELOPE_GOAL_MAX + 50),
      done: 'D'.repeat(ENVELOPE_DONE_MAX + 50),
      remaining: 'R'.repeat(ENVELOPE_REMAINING_MAX + 50),
      stopped: 'S'.repeat(ENVELOPE_STOPPED_MAX + 50),
      warnings: 'W'.repeat(ENVELOPE_WARNINGS_MAX + 50),
      files,
    }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const env = JSON.parse(readFileSync(envelopePath(r.id, dir), 'utf-8')) as {
      goal: string; done: string; remaining: string; stopped: string; warnings: string; files: string[]
    }
    assert.equal(env.goal.length, ENVELOPE_GOAL_MAX)
    assert.equal(env.done.length, ENVELOPE_DONE_MAX)
    assert.equal(env.remaining.length, ENVELOPE_REMAINING_MAX)
    assert.equal(env.stopped.length, ENVELOPE_STOPPED_MAX)
    assert.equal(env.warnings.length, ENVELOPE_WARNINGS_MAX)
    assert.equal(env.files.length, ENVELOPE_FILES_MAX)
    for (const f of env.files) assert.ok(f.length <= ENVELOPE_FILE_LINE_MAX)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('push：典型蒸馏文本下信封总 JSON ≤1200 字（目标口径）', () => {
  const dir = tmpHome()
  try {
    const r = pushHandoff(null, {
      title: '收件箱开发',
      goal: '把收件箱功能做完并跑绿全部测试',
      done: '- src/tools.ts 改完（HISTORY_REPORTED）\n- 测试 84/84 绿（HISTORY_REPORTED）',
      remaining: '- 写发版说明',
      stopped: '停在 handoff_push 工具调用时刻',
      warnings: '本卡片全部内容为推送时刻的历史快照，执行前先核对 git 状态',
      files: '- write: src/tools.ts\n- edit: src/index.ts\n- bash: npm run check',
    }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const raw = readFileSync(envelopePath(r.id, dir), 'utf-8')
    assert.ok(raw.length <= 1200, `典型信封 ${raw.length} 字，超出 ≤1200 目标`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load：信封随卡同步消失，envelopeChars 为落盘字节数，pending 清空', () => {
  const dir = tmpHome()
  try {
    const r = pushHandoff(null, { goal: 'g' }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const p = envelopePath(r.id, dir)
    const before = readFileSync(p, 'utf-8')

    const loaded = inboxLoad(r.id, { dir })
    assert.equal(loaded.ok, true)
    if (!loaded.ok) return
    assert.equal(loaded.envelopeChars, before.length)
    assert.equal(existsSync(p), false, '取件后信封应同步删除')
    assert.equal(readdirSync(join(dir, 'pending')).length, 0, 'pending 应清空（.md 与信封都不留）')
    assert.equal(existsSync(join(dir, 'archived', `${r.id}.md`)), true)

    const text = String(renderInbox({}, loaded)[0]?.text)
    assert.ok(text.includes(`机器信封已随卡归档（${before.length} chars）`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load：无信封的卡（外写 .md）照常取件，envelopeChars 缺省不渲染信封行', () => {
  const dir = tmpHome()
  try {
    const card: Card = {
      handoff: 1,
      id: 'ho-noenv-0001',
      from: { agent: 'dsh', session: '', title: '手写卡' },
      to: 'any',
      project: '',
      cwd: process.cwd(),
      pushed_at: '2026-10-04T00:00:00+08:00',
      git: { branch: '', changed: [] },
      tasks: [],
      sections: { goal: '手写卡目标', files: '', done: '', remaining: '', stopped: '', warnings: '' },
      extras: {},
    }
    writeCard(card, dir)
    const loaded = inboxLoad(card.id, { dir })
    assert.equal(loaded.ok, true, `取件失败：${loaded.ok ? '' : (loaded as { error: string }).error}`)
    if (!loaded.ok) return
    assert.equal(loaded.envelopeChars, undefined)
    const text = String(renderInbox({}, loaded)[0]?.text)
    assert.equal(text.includes('机器信封'), false, '无信封不应渲染信封行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('load：外写 .md + 手放信封也被同步消费（信封生命周期归本插件）', () => {
  const dir = tmpHome()
  try {
    mkdirSync(join(dir, 'pending'), { recursive: true })
    writeFileSync(join(dir, 'pending', 'ho-manual-0001.md'), '---\nhandoff: 1\nid: ho-manual-0001\n---\n## 目标\n\n手写\n', 'utf-8')
    const envRaw = '{"handoff":1,"kind":"envelope","id":"ho-manual-0001"}'
    writeFileSync(join(dir, 'pending', 'ho-manual-0001.envelope.json'), envRaw, 'utf-8')

    const loaded = inboxLoad('ho-manual-0001', { dir })
    assert.equal(loaded.ok, true)
    if (!loaded.ok) return
    assert.equal(loaded.envelopeChars, envRaw.length)
    assert.equal(existsSync(join(dir, 'pending', 'ho-manual-0001.envelope.json')), false)
    assert.equal(readdirSync(join(dir, 'pending')).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
