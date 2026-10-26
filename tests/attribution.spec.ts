/** 0.4.1 死亡地图 · attributeCard 闭集归因纯函数测试 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { attributeCard } from '../scripts/attribution.mjs'

const base = { lifecycleEvents: [], relayPickups: [], backtest: null }

describe('attributeCard：每卡恰好一个闭集结局', () => {
  test('还在 pending → in_inbox（未到结局）', () => {
    const a = attributeCard({ id: 'x', inPending: true, ...base })
    assert.equal(a.outcome, 'in_inbox')
  })

  test('写侧拒收（target 命中且从未被取件）→ write_rejected', () => {
    const a = attributeCard({
      id: 'x', inPending: false,
      lifecycleEvents: [{ at: '', stage: 'write', reason: 'secret_gate', target: 'x', detail: '' }],
      relayPickups: [], backtest: null,
    })
    assert.equal(a.outcome, 'write_rejected')
    assert.equal(a.reason, 'secret_gate')
  })

  test('写侧拒收但后来又被取件（改后重投）→ 不判写拒，按取件证据走', () => {
    const a = attributeCard({
      id: 'x', inPending: false,
      lifecycleEvents: [{ at: '', stage: 'write', reason: 'secret_gate', target: 'x', detail: '' }],
      relayPickups: ['x'],
      backtest: { consumed: true, measurable: true, continued: true },
    })
    assert.equal(a.outcome, 'survived')
  })

  test('已消费 + git 延续证据成立 → survived', () => {
    const a = attributeCard({ id: 'x', inPending: false, ...base, backtest: { consumed: true, measurable: true, continued: true } })
    assert.equal(a.outcome, 'survived')
  })

  test('已消费 + 无延续证据 → died_at_execution（最值得归因的一格）', () => {
    const a = attributeCard({ id: 'x', inPending: false, ...base, backtest: { consumed: true, measurable: true, continued: false } })
    assert.equal(a.outcome, 'died_at_execution')
  })

  test('已消费但 cwd 缺失 → unmeasurable（如实计数不粉饰）', () => {
    const a = attributeCard({ id: 'x', inPending: false, ...base, backtest: { consumed: true, measurable: false, continued: null, reason: 'cwd-missing' } })
    assert.equal(a.outcome, 'unmeasurable')
  })

  test('不在册、无写侧记录、无取件 → in_inbox 兜底（no-pickup-record）', () => {
    const a = attributeCard({ id: 'x', inPending: false, ...base })
    assert.equal(a.outcome, 'in_inbox')
    assert.equal(a.reason, 'no-pickup-record')
  })
})
