/**
 * 接力总账（0.26 /ledger）测试。
 * 覆盖：链装配三态（线性/断链/成环，父卡按 .md 在场判存在不断账；解析失败父卡挂链只标空标题）/
 * 分叉与无链棒 / 三源 join 对不齐如实单列（relay.cardId ↔ lifecycle.target ↔ 卡 id）/
 * 新写 relay 扫描读侧的 fail-open（缺目录/坏 JSON/数组/null/缺 at 形态不符跳过不抛）/
 * 僵尸判定正例（relay pickup + pending 在盘）与负例（已 archived 不算、cardId 空/非 SAFE 不判）/
 * lifeboat 目标卡区分标注 / 诚实分母负向断言（输出无百分比、无评分字段、无 rate 键）/
 * 窗口标注（尾 500 封顶，窗口外不可见）/ 空目录回诚实句不编零 /
 * 隐私负向（不含卡正文/lifecycle detail 全文/绝对路径）/ 同输入同输出确定性 /
 * /ledger skill 注册形态与内容要素（确定性翻账、空账本诚实句）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listArchivedReport, listPendingReport } from '@agent-handoff/core'
import {
  aggregateLedger,
  assembleChains,
  judgeZombies,
  onDiskIdsOf,
  readRelayRecords,
  zombiesOf,
  type RelayLedgerRecord,
} from '../src/relayledger.ts'
import { LEDGER_SKILL_CONTENT, ledgerSkillRegistration } from '../skills/ledger.ts'

// ---------------------------------------------------------------- fixtures

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  mkdirSync(join(dir, 'pending'), { recursive: true })
  mkdirSync(join(dir, 'archived'), { recursive: true })
  mkdirSync(join(dir, 'relay'), { recursive: true })
  return dir
}

/** 六段合法卡（opts 拼出 supersedes / receipt.for / 标题 / 时刻 / 正文隐私标记） */
function cardText(id: string, opts?: {
  supersedes?: string
  receiptFor?: string
  title?: string
  pushedAt?: string
  bodyMarker?: string
}): string {
  const fm = [
    'handoff: 1',
    `id: ${id}`,
    'from:',
    '  agent: claude',
    '  session: sess-src',
    `  title: ${opts?.title ?? '总账fixture'}`,
    'to: any',
    'project: ledger-spec',
    'cwd: D:/nowhere-ledger-spec',
    `pushed_at: ${opts?.pushedAt ?? '2026-11-01T00:00:00.000Z'}`,
    'git:',
    '  branch: main',
    '  changed: []',
  ]
  if (opts?.supersedes !== undefined) fm.push(`supersedes: ${opts.supersedes}`)
  if (opts?.receiptFor !== undefined) {
    fm.push('receipt:')
    fm.push(`  for: ${opts.receiptFor}`)
  }
  const body = [
    '## 目标', '', '总账fixture目标', '',
    '## 涉及文件', '', '- src/relayledger.ts', '',
    '## 做到哪', '', '一段完成 CURRENT_OBSERVED', '',
    '## 还差什么', '', '还差回归', '',
    '## 停在哪', '', opts?.bodyMarker ?? '停在中途。最安全的第一步：跑测试', '',
    '## 读者警告', '', '无',
  ].join('\n')
  return `---\n${fm.join('\n')}\n---\n\n${body}\n`
}

function writeMd(home: string, where: 'pending' | 'archived', id: string, text: string): void {
  writeFileSync(join(home, where, `${id}.md`), text, 'utf-8')
}

function writeRelay(home: string, sessionId: string, data: Omit<RelayLedgerRecord, 'sessionId' | 'file'>): void {
  writeFileSync(
    join(home, 'relay', `${sessionId}.json`),
    JSON.stringify({ sessionId, provider: data.provider, sourceId: data.sourceId, cardId: data.cardId, title: data.title, at: data.at }),
    'utf-8',
  )
}

function writeLifecycle(home: string, events: Array<{ at: string; stage: string; reason: string; target: string; detail?: string }>): void {
  writeFileSync(join(home, 'lifecycle.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf-8')
}

// ---------------------------------------------------------------- ① relay 扫描读侧（本模块新写）· fail-open

describe('readRelayRecords：新写目录扫描读侧，fail-open', () => {
  test('缺目录回空不抛；好记录按（at,file）字典序', () => {
    const home = tmpHome()
    try {
      assert.deepEqual(readRelayRecords(join(home, 'no-such')), [])
      // 故意反着写时间序，验证输出排序与文件名无关
      writeRelay(home, 's2', { provider: 'zcode', sourceId: 'src2', cardId: 'ho-lin1-b002', title: '收件箱取件', at: '2026-11-01T01:00:00.000Z' })
      writeRelay(home, 's1', { provider: '', sourceId: '', cardId: '', title: '接管：目标（11-19）', at: '2026-11-01T00:00:00.000Z' })
      const rows = readRelayRecords(home)
      assert.equal(rows.length, 2)
      assert.equal(rows[0]?.cardId, '', '空 cardId 的 takeover 记录时刻更早，排最前')
      assert.equal(rows[1]?.cardId, 'ho-lin1-b002')
      assert.equal(rows[1]?.file, 's2')
      assert.equal(rows[1]?.sessionId, 's2')
      // 二次读取同输出（确定性）
      assert.deepEqual(readRelayRecords(home), rows)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('坏 JSON / 数组 / null / 缺 at 形态不符逐个跳过不抛', () => {
    const home = tmpHome()
    try {
      writeFileSync(join(home, 'relay', 'broken.json'), '{oops', 'utf-8')
      writeFileSync(join(home, 'relay', 'arr.json'), '[1,2]', 'utf-8')
      writeFileSync(join(home, 'relay', 'null.json'), 'null', 'utf-8')
      writeFileSync(join(home, 'relay', 'noat.json'), JSON.stringify({ sessionId: 'x', cardId: 'ho-lin1-a001' }), 'utf-8')
      writeFileSync(join(home, 'relay', 'atnum.json'), JSON.stringify({ sessionId: 'x', cardId: 'ho-lin1-a001', at: 42 }), 'utf-8')
      writeRelay(home, 'good', { provider: 'zcode', sourceId: 'src1', cardId: 'ho-lin1-a001', title: '收件箱取件', at: '2026-11-02T00:00:00.000Z' })
      const rows = readRelayRecords(home)
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.file, 'good')
      assert.equal(rows[0]?.provider, 'zcode')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- ② 链装配三态

describe('assembleChains：线性/断链/成环，账不断只标注', () => {
  test('线性三棒：archived→archived→pending，supersedes 逐棒相接', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'archived', 'ho-lin1-a001', cardText('ho-lin1-a001', { pushedAt: '2026-11-01T00:00:00.000Z', title: '棒一' }))
      writeMd(home, 'archived', 'ho-lin1-b002', cardText('ho-lin1-b002', { supersedes: 'ho-lin1-a001', pushedAt: '2026-11-02T00:00:00.000Z', title: '棒二' }))
      writeMd(home, 'pending', 'ho-lin1-c003', cardText('ho-lin1-c003', { supersedes: 'ho-lin1-b002', pushedAt: '2026-11-03T00:00:00.000Z', title: '棒三' }))
      const chains = assembleChains(listPendingReport(home), listArchivedReport(home))
      assert.equal(chains.length, 1)
      const c = chains[0]
      assert.ok(c !== undefined)
      assert.equal(c.cycle, false)
      assert.deepEqual(c.forks, [])
      assert.equal(c.steps.length, 3)
      assert.equal(c.steps[0]?.id, 'ho-lin1-a001')
      assert.equal(c.steps[0]?.title, '棒一')
      assert.equal(c.steps[0]?.where, 'archived')
      assert.equal(c.steps[1]?.supersedes, 'ho-lin1-a001')
      assert.equal(c.steps[2]?.supersedes, 'ho-lin1-b002')
      assert.equal(c.steps[2]?.where, 'pending')
      // 断言无 brokenTo 污染合法链
      assert.ok(c.steps.every((s) => s.brokenTo === undefined))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('断链：目标不在册 → brokenTo 标注，账不断；非法 id 形态同样标注', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'pending', 'ho-dang-c003', cardText('ho-dang-c003', { supersedes: 'ho-gone-b002', pushedAt: '2026-11-03T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-dang-d004', cardText('ho-dang-d004', { supersedes: '../escape', pushedAt: '2026-11-04T00:00:00.000Z' }))
      const chains = assembleChains(listPendingReport(home), listArchivedReport(home))
      assert.equal(chains.length, 2, '两条独立断链各自成单棒链')
      const withGone = chains.find((c) => c.steps.some((s) => s.brokenTo === 'ho-gone-b002'))
      const withEvil = chains.find((c) => c.steps.some((s) => s.brokenTo === '../escape'))
      assert.ok(withGone !== undefined, '不在册目标标注断链')
      assert.equal(withGone.steps.length, 1, '账不断：断链棒本身仍在链上')
      assert.ok(withEvil !== undefined, '非法 id 形态同样标注断链（不做盘上探测）')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('成环：两棒互指 → cycle 标注 + 环上 id，账不断', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'pending', 'ho-cycl-x001', cardText('ho-cycl-x001', { supersedes: 'ho-cycl-x002', pushedAt: '2026-11-01T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-cycl-x002', cardText('ho-cycl-x002', { supersedes: 'ho-cycl-x001', pushedAt: '2026-11-02T00:00:00.000Z' }))
      const chains = assembleChains(listPendingReport(home), listArchivedReport(home))
      assert.equal(chains.length, 1)
      const c = chains[0]
      assert.ok(c !== undefined)
      assert.equal(c.cycle, true)
      assert.deepEqual(c.cycleIds, ['ho-cycl-x001', 'ho-cycl-x002'])
      assert.equal(c.steps.length, 2, '成环不拆账：两棒都在')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('父卡按 .md 在场判存在不断账：解析失败档照常挂链，只标空标题骨架棒', () => {
    const home = tmpHome()
    try {
      // 父卡文件在盘但 frontmatter 坏 YAML → listArchivedReport 记 skipped、无卡面
      writeFileSync(join(home, 'archived', 'ho-badp-b001.md'), '---\n: : :\n---\n\n## 目标\n\n坏件\n', 'utf-8')
      writeMd(home, 'pending', 'ho-kid-c001', cardText('ho-kid-c001', { supersedes: 'ho-badp-b001', pushedAt: '2026-11-03T00:00:00.000Z' }))
      const report = { pending: listPendingReport(home), archived: listArchivedReport(home) }
      assert.equal(report.archived.skipped.length, 1, '前置：父卡确在解析失败档')
      const chains = assembleChains(report.pending, report.archived)
      assert.equal(chains.length, 1)
      const c = chains[0]
      assert.ok(c !== undefined)
      assert.equal(c.steps.length, 2, 'mdOnDisk 同判据：文件在盘 = 父卡在场，链不断')
      assert.equal(c.steps[0]?.id, 'ho-badp-b001')
      assert.equal(c.steps[0]?.title, '', '骨架棒标题诚实空串')
      assert.equal(c.steps[0]?.pushedAt, '')
      assert.equal(c.steps[1]?.supersedes, 'ho-badp-b001')
      assert.ok(c.steps.every((s) => s.brokenTo === undefined), '父卡在场 = 合法链接，不是断链')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('分叉与无链棒：forks 标注；孤立卡不进链', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'archived', 'ho-fork-p001', cardText('ho-fork-p001', { pushedAt: '2026-11-01T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-fork-c001', cardText('ho-fork-c001', { supersedes: 'ho-fork-p001', pushedAt: '2026-11-02T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-fork-c002', cardText('ho-fork-c002', { supersedes: 'ho-fork-p001', pushedAt: '2026-11-03T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-lone-b001', cardText('ho-lone-b001', { pushedAt: '2026-11-04T00:00:00.000Z' }))
      const chains = assembleChains(listPendingReport(home), listArchivedReport(home))
      assert.equal(chains.length, 1, '孤立卡不成链')
      const c = chains[0]
      assert.ok(c !== undefined)
      assert.equal(c.steps.length, 3)
      assert.deepEqual(c.forks, ['ho-fork-p001'], '被多棒接替的父棒标注分叉')
      const ledger = aggregateLedger(home)
      assert.equal(ledger.counts.chainless, 1, '孤立卡只进计数')
      assert.equal(ledger.counts.batons, 4, 'n=总棒：盘上全部 SAFE_ID 形态卡')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- ③ 僵尸判定 + lifeboat 区分

describe('judgeZombies / zombiesOf：attribution 口径 + lifeboat 区分', () => {
  test('正例（pickup+pending 在盘）、负例（已 archived 不算）、cardId 空与非 SAFE 不判', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'pending', 'ho-zomb-b001', cardText('ho-zomb-b001'))
      writeMd(home, 'archived', 'ho-arch-b001', cardText('ho-arch-b001'))
      writeRelay(home, 's1', { provider: '', sourceId: '', cardId: 'ho-zomb-b001', title: '收件箱取件', at: '2026-11-10T00:00:00.000Z' })
      writeRelay(home, 's2', { provider: '', sourceId: '', cardId: 'ho-arch-b001', title: '收件箱取件', at: '2026-11-11T00:00:00.000Z' })
      writeRelay(home, 's3', { provider: 'zcode', sourceId: 'src', cardId: '', title: '接管：目标', at: '2026-11-12T00:00:00.000Z' })
      writeRelay(home, 's4', { provider: '', sourceId: '', cardId: '../evil', title: 'x', at: '2026-11-13T00:00:00.000Z' })
      const zombies = judgeZombies(home)
      assert.equal(zombies.length, 1)
      assert.equal(zombies[0]?.id, 'ho-zomb-b001')
      assert.equal(zombies[0]?.at, '2026-11-10T00:00:00.000Z')
      assert.equal(zombies[0]?.lifeboat, false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('lifeboat 目标卡区分标注：lifecycle reason=lifeboat 命中 → lifeboat true', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'pending', 'ho-life-b001', cardText('ho-life-b001'))
      writeMd(home, 'pending', 'ho-zomb-b001', cardText('ho-zomb-b001'))
      writeRelay(home, 's1', { provider: '', sourceId: '', cardId: 'ho-life-b001', title: '收件箱取件', at: '2026-11-10T00:00:00.000Z' })
      writeRelay(home, 's2', { provider: '', sourceId: '', cardId: 'ho-zomb-b001', title: '收件箱取件', at: '2026-11-11T00:00:00.000Z' })
      writeLifecycle(home, [
        { at: '2026-11-09T10:28:27.970Z', stage: 'write', reason: 'lifeboat', target: 'ho-life-b001', detail: '面板一键抢出（不经模型）' },
      ])
      const zombies = judgeZombies(home)
      assert.equal(zombies.length, 2)
      const life = zombies.find((z) => z.id === 'ho-life-b001')
      const plain = zombies.find((z) => z.id === 'ho-zomb-b001')
      assert.equal(life?.lifeboat, true, '救生艇抢出卡区分标注——不混入普通僵尸')
      assert.equal(plain?.lifeboat, false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('zombiesOf 纯函数芯：同卡多条取件记录只记最早一条；pendingOnDisk 探针可注入', () => {
    const relay: RelayLedgerRecord[] = [
      { sessionId: 'b', provider: '', sourceId: '', cardId: 'ho-zomb-b001', title: '', at: '2026-11-12T00:00:00.000Z', file: 'b' },
      { sessionId: 'a', provider: '', sourceId: '', cardId: 'ho-zomb-b001', title: '', at: '2026-11-10T00:00:00.000Z', file: 'a' },
    ]
    const out = zombiesOf(relay, (id) => id === 'ho-zomb-b001', new Set())
    assert.equal(out.length, 1)
    assert.equal(out[0]?.at, '2026-11-10T00:00:00.000Z', '取最早取件时刻')
  })
})

// ---------------------------------------------------------------- ④ 三源 join 聚合

describe('aggregateLedger：三源 join、对不齐单列、窗口标注', () => {
  test('对不齐如实单列：relay 指向不在册卡、lifecycle 端点指向不在册卡', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'archived', 'ho-lin1-a001', cardText('ho-lin1-a001'))
      writeRelay(home, 's1', { provider: '', sourceId: '', cardId: 'ho-lin1-a001', title: '收件箱取件', at: '2026-11-01T00:00:00.000Z' })
      writeRelay(home, 's2', { provider: '', sourceId: '', cardId: 'ho-gone2-b001', title: '收件箱取件', at: '2026-11-02T00:00:00.000Z' })
      writeLifecycle(home, [
        { at: '2026-11-03T00:00:00.000Z', stage: 'pickup', reason: 'continued', target: 'ho-lin1-a001', detail: '回执卡 ho-r' },
        { at: '2026-11-04T00:00:00.000Z', stage: 'pickup', reason: 'continued', target: 'ho-roll-a001', detail: '' },
      ])
      const ledger = aggregateLedger(home)
      assert.equal(ledger.counts.continued, 2, 'continued 原样条数')
      assert.equal(ledger.counts.abandoned, 0)
      const relayRow = ledger.unjoined.find((u) => u.kind === 'relay_pickup_no_card')
      const lcRow = ledger.unjoined.find((u) => u.kind === 'lifecycle_no_card')
      assert.ok(relayRow !== undefined, 'relay 取件记录指向不在册卡 → 单列')
      assert.equal(relayRow.id, 'ho-gone2-b001')
      assert.ok(lcRow !== undefined, 'lifecycle 端点指向不在册卡 → 单列')
      assert.equal(lcRow.id, 'ho-roll-a001')
      assert.equal(ledger.unjoined.length, 2, '对得齐的两条不进单列')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('聚合正确串场：链/僵尸/回执标注/计数一体', () => {
    const home = tmpHome()
    try {
      // 链：a001←b002（回执卡，指向 a001）←c003；a001 archived
      writeMd(home, 'archived', 'ho-lin1-a001', cardText('ho-lin1-a001', { pushedAt: '2026-11-01T00:00:00.000Z' }))
      writeMd(home, 'archived', 'ho-lin1-b002', cardText('ho-lin1-b002', { supersedes: 'ho-lin1-a001', receiptFor: 'ho-lin1-a001', pushedAt: '2026-11-02T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-lin1-c003', cardText('ho-lin1-c003', { supersedes: 'ho-lin1-b002', pushedAt: '2026-11-03T00:00:00.000Z' }))
      // 僵尸 + lifeboat
      writeMd(home, 'pending', 'ho-life-b001', cardText('ho-life-b001', { title: '救生艇抢出fixture' }))
      writeRelay(home, 's1', { provider: '', sourceId: '', cardId: 'ho-life-b001', title: '收件箱取件', at: '2026-11-10T00:00:00.000Z' })
      writeLifecycle(home, [{ at: '2026-11-09T00:00:00.000Z', stage: 'write', reason: 'lifeboat', target: 'ho-life-b001', detail: '面板一键抢出（不经模型）' }])
      const ledger = aggregateLedger(home)
      assert.equal(ledger.chains.length, 1)
      assert.equal(ledger.chains[0]?.steps.length, 3)
      assert.equal(ledger.chains[0]?.steps[1]?.receiptFor, 'ho-lin1-a001', '回执卡标注延续指向')
      assert.equal(ledger.zombies.length, 1)
      assert.equal(ledger.zombies[0]?.lifeboat, true)
      assert.equal(ledger.zombies[0]?.title, '救生艇抢出fixture', '僵尸条目回填卡面标题')
      assert.equal(ledger.counts.zombie, 1)
      assert.equal(ledger.counts.zombieLifeboat, 1)
      assert.equal(ledger.counts.batons, 4)
      assert.equal(ledger.counts.chainless, 1, '救生艇抢出卡无 supersedes 链 = 无链棒（僵尸在册但不占链屏）')
      assert.equal(ledger.window.relayRecords, 1)
      assert.equal(ledger.window.relayPickups, 1)
      assert.equal(ledger.window.lifecycleEvents, 1)
      assert.match(ledger.window.note, /窗口内 1 条/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('窗口标注：lifecycle 达尾 500 上限 → 注明更早历史不可见', () => {
    const home = tmpHome()
    try {
      const events = Array.from({ length: 500 }, (_, i) => ({
        at: `2026-11-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        stage: 'write',
        reason: 'secret_gate',
        target: `t${i}`,
        detail: '',
      }))
      writeLifecycle(home, events)
      const ledger = aggregateLedger(home)
      assert.equal(ledger.window.lifecycleEvents, 500)
      assert.equal(ledger.window.lifecycleCap, 500)
      assert.match(ledger.window.note, /已达尾 500 条窗口上限，更早历史不可见/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('空目录：诚实零缺省 + 窗口 0 条；三目录全缺也不抛', () => {
    const home = tmpHome()
    const bare = mkdtempSync(join(tmpdir(), 'ledger-bare-'))
    try {
      const ledger = aggregateLedger(home)
      assert.deepEqual(ledger.chains, [])
      assert.deepEqual(ledger.zombies, [])
      assert.deepEqual(ledger.unjoined, [])
      assert.equal(ledger.counts.continued, 0)
      assert.equal(ledger.counts.zombie, 0)
      assert.equal(ledger.counts.batons, 0)
      assert.match(ledger.window.note, /窗口内 0 条/)
      const bareLedger = aggregateLedger(bare)
      assert.equal(bareLedger.counts.batons, 0)
      assert.deepEqual(bareLedger.chains, [])
    } finally {
      rmSync(home, { recursive: true, force: true })
      rmSync(bare, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- ⑤ 纪律负向断言

describe('诚实与隐私负向断言', () => {
  test('输出无百分比、无评分字段、无 rate 键（延续率评分不做）', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'pending', 'ho-lone-b001', cardText('ho-lone-b001'))
      writeRelay(home, 's1', { provider: '', sourceId: '', cardId: 'ho-lone-b001', title: '收件箱取件', at: '2026-11-01T00:00:00.000Z' })
      writeLifecycle(home, [{ at: '2026-11-02T00:00:00.000Z', stage: 'pickup', reason: 'continued', target: 'ho-lone-b001', detail: '' }])
      const json = JSON.stringify(aggregateLedger(home))
      assert.equal(/rate|ratio|score|percent|%/i.test(json), false, `输出含评分/比率痕迹：${json.slice(0, 400)}`)
      assert.equal(json.includes('延续率'), false)
      assert.equal(json.includes('评分'), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('隐私负向：不含卡正文标记、lifecycle detail 全文、绝对路径', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'pending', 'ho-lone-b001', cardText('ho-lone-b001', { bodyMarker: '隐私正文标记NEVERLEAK' }))
      writeRelay(home, 's1', { provider: '', sourceId: '', cardId: 'ho-lone-b001', title: '收件箱取件', at: '2026-11-01T00:00:00.000Z' })
      writeLifecycle(home, [{ at: '2026-11-02T00:00:00.000Z', stage: 'write', reason: 'secret_gate', target: 't1', detail: '机密细节全文NEVERLEAK' }])
      const json = JSON.stringify(aggregateLedger(home))
      assert.equal(json.includes('隐私正文标记NEVERLEAK'), false, '卡正文不落账')
      assert.equal(json.includes('机密细节全文NEVERLEAK'), false, 'lifecycle detail 不落账')
      assert.equal(json.includes(home), false, '绝对路径不落账')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('同输入同输出确定性（全要素盘面连跑两次 deepEqual）', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'archived', 'ho-lin1-a001', cardText('ho-lin1-a001', { pushedAt: '2026-11-01T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-lin1-b002', cardText('ho-lin1-b002', { supersedes: 'ho-lin1-a001', pushedAt: '2026-11-02T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-cycl-x001', cardText('ho-cycl-x001', { supersedes: 'ho-cycl-x002', pushedAt: '2026-11-03T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-cycl-x002', cardText('ho-cycl-x002', { supersedes: 'ho-cycl-x001', pushedAt: '2026-11-04T00:00:00.000Z' }))
      writeMd(home, 'pending', 'ho-life-b001', cardText('ho-life-b001'))
      writeRelay(home, 's1', { provider: '', sourceId: '', cardId: 'ho-life-b001', title: '收件箱取件', at: '2026-11-10T00:00:00.000Z' })
      writeRelay(home, 's2', { provider: '', sourceId: '', cardId: 'ho-gone2-b001', title: '收件箱取件', at: '2026-11-11T00:00:00.000Z' })
      writeLifecycle(home, [
        { at: '2026-11-09T00:00:00.000Z', stage: 'write', reason: 'lifeboat', target: 'ho-life-b001', detail: '面板一键抢出（不经模型）' },
        { at: '2026-11-12T00:00:00.000Z', stage: 'pickup', reason: 'abandoned', target: 'ho-roll-a001', detail: 'dismiss 未取件' },
      ])
      const first = aggregateLedger(home)
      const second = aggregateLedger(home)
      assert.deepEqual(second, first)
      // 断言盘面确实覆盖了断言要素（防 fixture 静默失效）
      assert.ok(first.chains.some((c) => c.cycle), 'fixture 含成环链')
      assert.ok(first.zombies.some((z) => z.lifeboat), 'fixture 含 lifeboat 僵尸')
      assert.ok(first.unjoined.length >= 2, 'fixture 含两条对不齐')
      assert.equal(first.counts.abandoned, 1)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- ⑥ onDiskIdsOf / skill 注册

describe('onDiskIdsOf 与 /ledger skill 注册', () => {
  test('onDiskIdsOf：解析成功卡 ∪ 解析失败档基名 ∪ 非法基名排除', () => {
    const home = tmpHome()
    try {
      writeMd(home, 'pending', 'ho-lone-b001', cardText('ho-lone-b001'))
      writeFileSync(join(home, 'archived', 'ho-badp-b001.md'), '---\n: : :\n---\n\n正文\n', 'utf-8')
      writeFileSync(join(home, 'archived', 'notes.txt'), 'not a card', 'utf-8')
      const ids = onDiskIdsOf(listPendingReport(home), listArchivedReport(home))
      assert.ok(ids.has('ho-lone-b001'))
      assert.ok(ids.has('ho-badp-b001'), '解析失败档 .md 在盘算在场')
      assert.equal(ids.size, 2, '非 .md 杂物不进')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('ledgerSkillRegistration：bundled 单模板，userInvocable 而非 modelInvocable', () => {
    const reg = ledgerSkillRegistration()
    assert.equal(reg.name, 'ledger')
    assert.equal(reg.source, 'bundled')
    assert.equal(reg.provider, 'dsh-takeover')
    assert.equal(reg.invocation?.userInvocable, true)
    assert.equal(reg.invocation?.modelInvocable, false)
    assert.equal(reg.content, LEDGER_SKILL_CONTENT)
  })

  test('skill 内容要素：三源/确定性翻账/链三态/僵尸口径/lifeboat 区分/闭集计数行/隐私/单机口径/空账本诚实句', () => {
    const c = LEDGER_SKILL_CONTENT
    assert.match(c, /relay\/\*\.json/)
    assert.match(c, /lifecycle\.jsonl/)
    assert.match(c, /确定性翻账/)
    assert.match(c, /断链/)
    assert.match(c, /成环/)
    assert.match(c, /救生艇抢出卡在册/)
    assert.match(c, /不得混入普通僵尸口径/)
    assert.match(c, /X continued \/ Y abandoned \/ Z zombie（n=总棒 N）/)
    assert.match(c, /绝不计算延续率、百分比或评分/)
    assert.match(c, /单机口径/)
    assert.match(c, /不落卡正文/)
    assert.match(c, /账本还是空的/)
    assert.match(c, /supersedes/)
    assert.match(c, /receipt\.for/)
  })
})
