/** 0.4.1 段落效用探针（行为法）纯函数测试 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { FACTS, probesOf, sectionUtility, armSuccess, armCardSections } from '../scripts/section-utility.mjs'

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
