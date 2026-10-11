// collect 目标事件路径：goal/change 的 clear 与 objective 写入（行覆盖 + 语义回归）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { collectFacts } from '../src/collect.ts'

test('goal/change：objective 写入 lastGoal', () => {
  const facts = collectFacts([
    { type: 'goal/change', data: { goal: { objective: '把覆盖率推上 95' } } },
  ])
  assert.equal((facts as { lastGoal?: string }).lastGoal, '把覆盖率推上 95')
})

test('goal/change：clear 清空 lastGoal', () => {
  const facts = collectFacts([
    { type: 'goal/change', data: { goal: { objective: '旧目标' } } },
    { type: 'goal/change', data: { operation: 'clear' } },
  ])
  assert.equal((facts as { lastGoal?: string }).lastGoal, '')
})

test('goal/change：坏形态（非对象 goal / objective 非串）不写不炸', () => {
  const facts = collectFacts([
    { type: 'goal/change', data: { goal: 'not-an-object' } },
    { type: 'goal/change', data: { goal: { objective: 42 } } },
  ])
  assert.ok((facts as { lastGoal?: string }).lastGoal === undefined || (facts as { lastGoal?: string }).lastGoal === '')
})
