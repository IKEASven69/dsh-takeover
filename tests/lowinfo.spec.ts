/** 低信息卡识别（0.4.1 收件箱噪音治理）：纯函数判据 + buildState 集成 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generateId, writeCard, type Card } from '@agent-handoff/core'
import { isLowInfoCardMarkdown, isPlaceholderLine } from '../src/lowinfo.ts'
import { buildState, type PendingRow } from '../src/settings.ts'
import type { ForeignReaders } from '../src/foreign.ts'

function makeCard(partial?: Partial<Card>): Card {
  return {
    handoff: 1,
    id: generateId(),
    from: { agent: 'dsh', session: '', title: '' },
    to: 'any',
    project: '',
    cwd: tmpdir(),
    pushed_at: '2026-10-06T10:00:00+08:00',
    git: { branch: '', changed: [] },
    tasks: [],
    sections: { goal: 'g', files: 'f', done: 'd', remaining: 'r', stopped: 's', warnings: 'w' },
    extras: {},
    ...partial,
  }
}

function fakeReaders(): ForeignReaders {
  return {
    listSessions: () => [],
    resolve: () => ({ kind: 'not-found', reference: '' }),
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
  }
}

test('isPlaceholderLine：整行（…）括注且含「无/不可用/未」才算占位', () => {
  assert.equal(isPlaceholderLine('（事件流中无文件/命令记录）'), true)
  assert.equal(isPlaceholderLine('（无未完成 todo 快照）'), true)
  assert.equal(isPlaceholderLine('  （事件流不可用：exec.agent.session 为空）  '), true)
  assert.equal(isPlaceholderLine('部署 dsh-takeover（已完成）'), false, '正文含括注不算占位行')
  assert.equal(isPlaceholderLine('（参见上文）'), false, '不含无/不可用/未的括注不算')
  assert.equal(isPlaceholderLine(''), false)
})

test('isLowInfoCardMarkdown：≥3 条占位行判空壳；真卡不误判', () => {
  const junk = [
    '## 目标', '', '（事件流不可用：exec.agent.session 为空（自检 / 无会话环境））', '',
    '## 涉及文件', '', '（事件流中无文件/命令记录）', '',
    '## 做到哪', '', '（事件流中无可蒸馏的完成项）', '',
    '## 还差什么', '', '（无未完成 todo 快照）',
  ].join('\n')
  assert.equal(isLowInfoCardMarkdown(junk), true)
  const real = ['## 目标', '', '部署 dsh-takeover v0.4.1（已完成）并验证。', '', '## 读者警告', '', '（无）'].join('\n')
  assert.equal(isLowInfoCardMarkdown(real), false, '真卡只有零星占位不误判')
})

test('buildState：空壳卡 lowInfo=true，实卡 false（集成）', () => {
  const home = mkdtempSync(join(tmpdir(), 'takeover-lowinfo-'))
  const junk = makeCard({
    from: { agent: 'dsh', session: '', title: '' },
    sections: {
      goal: '（事件流不可用：exec.agent.session 为空（自检 / 无会话环境））',
      files: '（事件流中无文件/命令记录）',
      done: '（事件流中无可蒸馏的完成项）',
      remaining: '（无未完成 todo 快照）',
      stopped: '会话事件流不可用，本卡片为兜底骨架。最安全的第一步：向推送方确认真实停点。',
      warnings: '本卡片全部内容为推送时刻的历史快照（HISTORY_REPORTED），不是当下事实；执行前先核对 git 状态。',
    },
  } as Partial<Card>)
  const real = makeCard({ from: { agent: 'claude', session: 's1', title: '实质卡' } })
  writeCard(junk, home)
  writeCard(real, home)
  const st = buildState(fakeReaders(), home)
  const byId = new Map<string, PendingRow>(st.pending.map((p) => [p.id, p]))
  assert.equal(byId.get(junk.id)?.lowInfo, true, '空壳卡应标 lowInfo')
  assert.equal(byId.get(real.id)?.lowInfo === false, true, '实卡不应标 lowInfo')
})
