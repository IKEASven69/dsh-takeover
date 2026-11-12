/**
 * 同步盘换机场景契约（迭代计划附录 A「跨设备同步」翻案条件的预备实测）：
 * 80% 路径 = HANDOFF_HOME 指同步盘（junction/symlink/同步目录），本文件钉住
 * 「同步产物不产生幽灵卡、不塌收件箱」的不变量：
 * - 同步服务冲突副本（Syncthing `*.sync-conflict-*` / OneDrive ` (1)`）：
 *   原件在册 → 同 id 去重只显示一次；原件已消费 → 进可见拒收清单（死亡地图）。
 * - 半截文件（同步中断写入）：解析失败可见拒收，state 不塌。
 * - HANDOFF_HOME 为链接目录：寄存→收件箱→取件→归档全链穿透。
 * 读取层一律注入假货（ForeignReaders），目录全部临时隔离。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generateId, loadCard, writeCard, type Card } from '@agent-handoff/core'
import { buildState, type TakeoverState } from '../src/settings.ts'
import type { ForeignReaders } from '../src/foreign.ts'

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'takeover-sync-'))
}

function fakeReaders(): ForeignReaders {
  return {
    listSessions: () => [],
    resolve: () => ({ kind: 'not-found', reference: '' }),
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
  }
}

function makeCard(partial?: Partial<Card>): Card {
  return {
    handoff: 1,
    id: generateId(),
    from: { agent: 'dsh', session: 'sess-x', title: '' },
    to: 'any',
    project: '',
    cwd: tmpdir(),
    pushed_at: '2026-11-12T10:00:00+08:00',
    git: { branch: '', changed: [] },
    tasks: [],
    sections: { goal: 'g', files: 'f', done: 'd', remaining: 'r', stopped: 's', warnings: 'w' },
    extras: {},
    ...partial,
  }
}

/** 稳定 id（SAFE_ID 三段式），供冲突副本按文件名手工摆放 */
const CID = 'ho-syncfix-a1b2'

/** 冲突副本注入（模拟同步服务行为：一侧内容逐字节复制，文件名加服务后缀） */
function plantConflictCopy(home: string, filename: string): void {
  mkdirSync(join(home, 'pending'), { recursive: true })
  writeFileSync(join(home, 'pending', filename), readFileSync(join(home, 'pending', `${CID}.md`), 'utf-8'), 'utf-8')
}

// ---------- 冲突副本 · 原件在册：去重不幻影 ----------

for (const [label, filename] of [
  ['Syncthing 命名', `${CID}.sync-conflict-20261112-101010.md`],
  ['OneDrive 命名', `${CID} (1).md`],
] as const) {
  test(`同步冲突副本（${label}）·原件在册：同 id 只显示一次，计 pendingDuplicates`, () => {
    const home = freshHome()
    writeCard(makeCard({ id: CID }), home)
    plantConflictCopy(home, filename)
    const st: TakeoverState = buildState(fakeReaders(), home)
    assert.equal(st.pending.length, 1, '冲突副本不得变成第二张卡')
    assert.equal(st.pending[0]?.id, CID)
    assert.equal(st.pendingDuplicates, 1, '副本要进重复计数（可见），不是静默吞掉')
    assert.equal(st.pendingSkipped, 0)
    assert.equal(st.inboxError, undefined)
  })
}

// ---------- 冲突副本 · 原件已消费：可见拒收，无幽灵卡 ----------

test('同步冲突副本·原件已消费（B 机迟到同步）：不产生幽灵卡，进可见拒收清单', () => {
  const home = freshHome()
  // 原件从未到达 B 机（已在 A 机消费并同步走），B 机只剩迟到副本
  mkdirSync(join(home, 'pending'), { recursive: true })
  writeFileSync(
    join(home, 'pending', `${CID}.sync-conflict-20261112-101010.md`),
    ['---', `id: ${CID}`, 'handoff: 1', '---', '', '# 主体', '内容'].join('\n'),
    'utf-8',
  )
  const st = buildState(fakeReaders(), home)
  // 迟到副本 id 对不上任何文件名 → core 三闸拒收并带原因（卡已消费不重放）
  assert.equal(st.pending.length, 0, '迟到副本不得变成幽灵卡')
  assert.equal(st.pendingSkipped, 1, '迟到副本必须可见地拒收，不许静默消失')
  assert.equal(st.rejections?.live.length, 1)
  assert.match(st.rejections?.live[0]?.file ?? '', /sync-conflict/)
  assert.match(st.rejections?.live[0]?.detail ?? '', /不对应/)
})

test('半截文件（同步中断写入）：拒收可见，state 不塌', () => {
  const home = freshHome()
  writeCard(makeCard({ id: CID }), home)
  const full = readFileSync(join(home, 'pending', `${CID}.md`), 'utf-8')
  // 模拟同步服务写一半：掐断在 frontmatter 中间
  const partialFile = `${CID}.sync-conflict-20261112-999999.md`
  mkdirSync(join(home, 'pending'), { recursive: true })
  writeFileSync(join(home, 'pending', partialFile), full.slice(0, Math.floor(full.length / 3)), 'utf-8')
  const st = buildState(fakeReaders(), home)
  assert.equal(st.inboxError, undefined, '坏文件降级处理，不许炸整个收件箱 state')
  assert.ok(st.pending.length <= 1, '正卡最多出现一次')
  if (st.pendingSkipped > 0) {
    // 半截文件被拒 → 必须带原因可见（死亡地图），不许静默
    assert.equal(st.rejections?.live.length, st.pendingSkipped)
    assert.ok(st.rejections?.live.every((r) => r.file === partialFile || st.pending.some((p) => r.file === `${p.id}.md`)),
      '拒收清单只含真实文件')
  }
})

// ---------- HANDOFF_HOME 为链接目录（同步盘 / junction 形态） ----------

test('HANDOFF_HOME 指链接目录：寄存→收件箱→取件→归档全链穿透', () => {
  const real = mkdtempSync(join(tmpdir(), 'takeover-syncdir-real-'))
  const linkRoot = mkdtempSync(join(tmpdir(), 'takeover-syncdir-link-'))
  const link = join(linkRoot, 'handoff')
  symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const card = makeCard({ id: CID })
    writeCard(card, link) // 寄存走链接
    const st = buildState(fakeReaders(), link) // B 机视角（路径不同，同一物理目录）
    assert.equal(st.pending.length, 1, '链接目录即收件箱：写入穿透可见')
    assert.equal(st.pending[0]?.id, CID)
    const loaded = loadCard(CID, link) // 取件走链接（消费即弃）
    assert.equal(loaded.id, CID)
    const st2 = buildState(fakeReaders(), link)
    assert.equal(st2.pending.length, 0, '消费后 pending 清空（tombstone = archived/）')
    assert.equal(st2.archivedCount, 1, '归档可追溯（另一台机器同步后同样不再重放）')
  } finally {
    rmSync(real, { recursive: true, force: true })
    rmSync(linkRoot, { recursive: true, force: true })
  }
})
