/** 0.4.1 段落效用探针（行为法）纯函数测试 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
// @ts-expect-error .mjs 无声明文件
import { FACTS, probesOf, sectionUtility, armSuccess, armCardSections, assertCardCarries } from '../scripts/section-utility.mjs'

describe('probesOf：产物文件的事实存活判定', () => {
  test('全事实物化 → 三探针全中', () => {
    const p = probesOf({ todo: `${FACTS.workTodoTo}\n`, notes: `# Notes\n${FACTS.marker} ${FACTS.workNoteLine}\n` })
    assert.equal(p.todoFlipped, true)
    assert.equal(p.noteAppended, true)
    assert.equal(p.markerUsed, true)
  })
  test('改了 TODO 但 step2 行缺 marker → markerUsed=false（warnings 段未被消费）', () => {
    const p = probesOf({ todo: `${FACTS.workTodoTo}\n`, notes: `x\n${FACTS.workNoteLine}\n` })
    assert.equal(p.todoFlipped, true)
    assert.equal(p.noteAppended, true)
    assert.equal(p.markerUsed, false)
  })
  test('只追加 step2 不改 TODO → todoFlipped=false', () => {
    const p = probesOf({ todo: `${FACTS.workTodoFrom}\n`, notes: `${FACTS.workNoteLine}\n` })
    assert.equal(p.todoFlipped, false)
    assert.equal(p.noteAppended, true)
  })
  test('空产物全灭', () => {
    const p = probesOf({ todo: '', notes: '' })
    assert.deepEqual([p.todoFlipped, p.noteAppended, p.markerUsed], [false, false, false])
  })
})

describe('sectionUtility / armSuccess', () => {
  test('remaining 效用 = work 双探针合取；warnings 效用 = marker', () => {
    const full = sectionUtility({ todo: `${FACTS.workTodoTo}\n`, notes: `${FACTS.marker} ${FACTS.workNoteLine}\n` })
    assert.deepEqual(full, { remaining: { probed: true, hit: true }, warnings: { probed: true, hit: true } })
    const noMarker = sectionUtility({ todo: `${FACTS.workTodoTo}\n`, notes: `${FACTS.workNoteLine}\n` })
    assert.equal(noMarker.remaining.hit, true)
    assert.equal(noMarker.warnings.hit, false)
    assert.equal(armSuccess({ todo: `${FACTS.workTodoTo}\n`, notes: `${FACTS.workNoteLine}\n` }), true)
    assert.equal(armSuccess({ todo: '', notes: '' }), false)
  })
})

describe('armCardSections：三臂同源异构', () => {
  test('structured 臂事实分埋 remaining/warnings/done', () => {
    const s = armCardSections('structured', FACTS)
    assert.ok(s.remaining.includes(FACTS.workTodoTo) && s.remaining.includes(FACTS.workNoteLine))
    assert.ok(s.warnings.includes(FACTS.marker))
    assert.ok(s.done.includes('HISTORY_REPORTED'))
    assert.equal(s.goal.includes(FACTS.marker), false, 'goal 不应泄漏 warnings 段的 marker 事实（段落归因的前提）')
  })
  test('plain 臂同源事实全在 goal 散文里，其余段空', () => {
    const s = armCardSections('plain', FACTS)
    assert.ok(s.goal.includes(FACTS.workTodoTo) && s.goal.includes(FACTS.marker) && s.goal.includes(FACTS.workNoteLine))
    assert.equal([s.done, s.remaining, s.warnings].every((x) => x === ''), true)
  })
  test('minimal 臂零事实（仓库即全部信息）', () => {
    const s = armCardSections('minimal', FACTS)
    assert.equal(s.goal.includes(FACTS.marker), false)
    assert.equal(s.goal.includes(FACTS.workTodoTo), false)
  })
})

/**
 * 卡文自检：段标题形态漂移会让 core 解析出空卡且不报错——
 * 2026-10-26 三臂实验第 1 臂就是这样静默作废的（实测教训）。
 */
describe('assertCardCarries：交付前证明接手方真能读到六段', () => {
  const six = {
    goal: '接手上一棒的仓库收尾任务：按「还差什么」完成工作。',
    files: '- TODO.md\n- NOTES.md',
    done: `- HISTORY_REPORTED ${FACTS.contextDone}`,
    remaining: `- CURRENT_OBSERVED 把 TODO.md 里的 ${FACTS.workTodoFrom} 改成 ${FACTS.workTodoTo}`,
    stopped: '上一棒在完成 step1 后正常收尾。',
    warnings: `- CURRENT_OBSERVED 所有新增行必须以标记 ${FACTS.marker} 开头（接手方遵守）`,
  }
  const cardText = (heads: string[]): string => [
    '---',
    'handoff: 1',
    'id: ho-selftest-0001',
    'from:',
    '  agent: eval',
    '  session: ""',
    '  title: 自检卡',
    'to: any',
    'project: eval-three-arm',
    'cwd: "C:/tmp/selfcheck"',
    'pushed_at: 2026-01-01T00:00:00+08:00',
    'git:',
    '  branch: ""',
    '  changed: []',
    'tasks: []',
    '---',
    '',
    heads[0] ?? '', '', six.goal, '',
    heads[1] ?? '', '', six.files, '',
    heads[2] ?? '', '', six.done, '',
    heads[3] ?? '', '', six.remaining, '',
    heads[4] ?? '', '', six.stopped, '',
    heads[5] ?? '', '', six.warnings, '',
  ].join('\n')

  test('规范段标题（## 目标 …）→ 六段都解析得出来，自检通过', () => {
    const parsed = assertCardCarries(
      cardText(['## 目标', '## 涉及文件', '## 做到哪', '## 还差什么', '## 停在哪', '## 读者警告']),
      six,
    )
    assert.ok(parsed.sections.remaining.includes(FACTS.workTodoTo), 'remaining 段事实要活着')
    assert.ok(parsed.sections.warnings.includes(FACTS.marker), 'warnings 段 marker 要活着')
  })

  test('段标题写成「## 目标（goal）」→ core 解析成空段，自检必须炸（老坑回归）', () => {
    const bad = cardText([
      '## 目标（goal）',
      '## 涉及文件（files）',
      '## 做到哪（done）',
      '## 还差什么（remaining）',
      '## 停在哪（stopped）',
      '## 读者警告（warnings）',
    ])
    assert.throws(() => assertCardCarries(bad, six), /卡文解析漂移/)
  })
})
