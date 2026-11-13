// 注册表一致性：src/providers.ts 是九家外部 provider 的单一真源。
// 消费面——foreign.ts 的名单与适配器映射、skills/resume.ts 的 skill 规格、
// brand-icons.ts 的图标与显示名、browser-view.ts 的交接目标轴、client.ts 的
// /resume-* chips 名单——必须与注册表逐字段一致；任何一边手抄漂移在此红灯。
// 双轴独立在此钉住：gemini 进读取器轴、不进交接目标轴（注册表显式声明）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { PROVIDERS, RESUME_PROVIDERS } from '../src/providers.ts'
import { FOREIGN_PROVIDERS, PROVIDER_TO_ADAPTER } from '../src/foreign.ts'
import { BRAND_MARKS, BRAND_FULL_SVG, PROVIDER_LABEL } from '../src/brand-icons.ts'
import { OUTBOUND_TARGETS, OUTBOUND_LABELS } from '../src/browser-view.ts'
import { RESUME_SKILL_SPECS, resumeSkillRegistrations } from '../skills/resume.ts'

test('注册表九家：name / adapter / label 显式齐全，声明序 = 历史 FOREIGN_PROVIDERS 序', () => {
  assert.equal(PROVIDERS.length, 9)
  assert.deepEqual(PROVIDERS.map((p) => p.name), [
    'claude', 'codex', 'opencode', 'zcode', 'pi', 'workbuddy', 'cursor', 'grok', 'gemini',
  ])
  assert.deepEqual(Object.fromEntries(PROVIDERS.map((p) => [p.name, p.adapter])), {
    claude: 'claude-code', codex: 'codex', opencode: 'opencode', zcode: 'zcode',
    pi: 'pi', workbuddy: 'workbuddy', cursor: 'cursor', grok: 'grok', gemini: 'gemini',
  })
  assert.deepEqual(Object.fromEntries(PROVIDERS.map((p) => [p.name, p.label])), {
    claude: 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode', zcode: 'ZCode',
    pi: 'Pi', workbuddy: 'WorkBuddy', cursor: 'Cursor', grok: 'Grok CLI', gemini: 'Gemini CLI',
  })
})

test('读取器轴：foreign.ts 的 FOREIGN_PROVIDERS / PROVIDER_TO_ADAPTER 与注册表派生一致', () => {
  assert.deepEqual([...FOREIGN_PROVIDERS], [...PROVIDERS.map((p) => p.name)])
  assert.deepEqual(PROVIDER_TO_ADAPTER, Object.fromEntries(PROVIDERS.map((p) => [p.name, p.adapter])))
})

test('/resume-* 轴：RESUME_SKILL_SPECS 与注册表 resume 段逐字段一致', () => {
  assert.equal(RESUME_SKILL_SPECS.length, PROVIDERS.length)
  RESUME_SKILL_SPECS.forEach((spec, i) => {
    const p = PROVIDERS[i]!
    assert.equal(spec.name, `resume-${p.name}`, 'skill id = resume-<name>')
    assert.equal(spec.provider, p.name)
    assert.equal(spec.product, p.resume.product)
    assert.equal(spec.description, p.resume.description)
    assert.equal(spec.recoveryBoundary, p.resume.recoveryBoundary)
  })
  // 注册面顺序同注册表
  assert.deepEqual(
    resumeSkillRegistrations().map((r) => r.name),
    PROVIDERS.map((p) => p.resume.id),
  )
})

test('图标轴：BRAND_MARKS / BRAND_FULL_SVG / PROVIDER_LABEL 与注册表 icon / label 派生一致', () => {
  for (const p of PROVIDERS) {
    assert.equal(PROVIDER_LABEL[p.name], p.label, `label ${p.name}`)
    if (p.icon.kind === 'mark') {
      assert.deepEqual(BRAND_MARKS[p.name], p.icon.mark, `mark ${p.name}`)
      assert.ok(!(p.name in BRAND_FULL_SVG), `${p.name} 不该同时有完整 SVG`)
    } else if (p.icon.kind === 'full') {
      assert.equal(BRAND_FULL_SVG[p.name], p.icon.svg, `full svg ${p.name}`)
      assert.ok(!(p.name in BRAND_MARKS), `${p.name} 不该同时有 tile 标`)
    } else {
      // 无在册官方矢量的家（gemini）：两个图标表都不得出现——冒牌标纪律
      assert.ok(!(p.name in BRAND_MARKS) && !(p.name in BRAND_FULL_SVG), `${p.name} 无在册矢量却进了图标表`)
    }
  }
  // 图标表无注册表之外的漏网条目
  const marks = PROVIDERS.filter((p) => p.icon.kind === 'mark').map((p) => p.name)
  assert.deepEqual(Object.keys(BRAND_MARKS).sort(), [...marks, 'dsh'].sort())
  const fulls = PROVIDERS.filter((p) => p.icon.kind === 'full').map((p) => p.name)
  assert.deepEqual(Object.keys(BRAND_FULL_SVG).sort(), fulls)
  // 显示名表 = 注册表九家 + 宿主自有 dsh（dsh 不是外部 provider，不进注册表）
  assert.deepEqual(Object.keys(PROVIDER_LABEL).sort(), [...PROVIDERS.map((p) => p.name), 'dsh'].sort())
  assert.equal(PROVIDER_LABEL.dsh, 'DeepSeek Harness')
  assert.ok('dsh' in BRAND_MARKS, '宿主自有 dsh tile 标保留')
})

test('交接目标轴：OUTBOUND_TARGETS / OUTBOUND_LABELS 与注册表 outboundEligible 派生一致', () => {
  const eligible = PROVIDERS.filter((p) => p.outboundEligible)
  assert.equal(PROVIDERS.filter((p) => !p.outboundEligible).length, 1, '不进交接轴的恰好一家（gemini）')
  assert.deepEqual([...OUTBOUND_TARGETS], ['any', ...eligible.map((p) => p.name)])
  assert.deepEqual(OUTBOUND_LABELS.any, { zh: '任意 agent', en: 'Any agent' })
  for (const p of eligible) {
    assert.deepEqual(OUTBOUND_LABELS[p.name], { zh: p.label, en: p.label }, `label ${p.name}`)
  }
  // 双轴独立：gemini 在读取器轴在场、在交接轴缺席
  assert.ok(FOREIGN_PROVIDERS.includes('gemini'))
  assert.ok(!(OUTBOUND_TARGETS as readonly string[]).includes('gemini'))
  assert.ok(!('gemini' in OUTBOUND_LABELS))
})

test('client /resume-* chips 名单（RESUME_PROVIDERS）与注册表同源同序', () => {
  assert.deepEqual([...RESUME_PROVIDERS], [...PROVIDERS.map((p) => p.name)])
  assert.deepEqual([...RESUME_PROVIDERS], [...FOREIGN_PROVIDERS])
})
