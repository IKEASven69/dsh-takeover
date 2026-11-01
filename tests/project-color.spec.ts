/**
 * 项目身份色：同一项目在筛选 chips 与会话行里永远同色（cwd 确定性哈希 → 10 色板）。
 * 空 cwd 归中性灰不占色板。纯函数，无运行时依赖。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { cwdFacets, PROJECT_NEUTRAL, PROJECT_PALETTE, projectColor } from '../src/browser-view.ts'

test('同 cwd 同色：跨调用确定性（身份色的底线）', () => {
  const a = projectColor('D:/coding/dsh-takeover')
  const b = projectColor('D:/coding/dsh-takeover')
  assert.equal(a.hex, b.hex)
  assert.equal(a.rgb, b.rgb)
})

test('返回值必在色板内（hex 与 rgb 三元组成对）', () => {
  for (const cwd of ['D:/coding', 'C:/x/y', '/home/u/kb', 'Z:\\混合\\路径', 'a']) {
    const c = projectColor(cwd)
    assert.ok(PROJECT_PALETTE.some((p) => p.hex === c.hex && p.rgb === c.rgb), `${cwd} → ${c.hex} 不在色板`)
  }
})

test('空 cwd 归中性灰，且中性灰不在色板里（不占身份位）', () => {
  assert.equal(projectColor('').hex, PROJECT_NEUTRAL.hex)
  assert.ok(!PROJECT_PALETTE.some((p) => p.hex === PROJECT_NEUTRAL.hex))
})

test('分布：50 个合成 cwd 至少用到 6 种色——哈希塌缩到一色即失效', () => {
  const used = new Set<string>()
  for (let i = 0; i < 50; i++) used.add(projectColor(`/ws/proj-${i}`).hex)
  assert.ok(used.size >= 6, `50 个项目只用到 ${used.size} 种色`)
})

test('相邻路径不同色概率：同目录树下各项目间有区分度（20 取样 ≥10 种）', () => {
  const used = new Set<string>()
  for (const name of ['dsh-takeover', 'dsh-hippo', 'dsh-sensenova-image', 'kb-scout', 'dsh-termfleet', 'dsh-notch',
    'agent-handoff', 'deepseek-harness', 'laya-patrol-pilot', 'filefind', 'kool-cast', 'dawn-defense',
    'dsh-trust-list', 'mystery-museum', 'typing-cultivation', 'dsh-plugins', 'coding', 'workspace', 'tmp', 'docs']) {
    used.add(projectColor(`D:/coding/${name}`).hex)
  }
  assert.ok(used.size >= 10, `20 个真实形态项目名只用到 ${used.size} 种色`)
})

test('cwdFacets label 与行内项目标取段口径一致（末段，斜杠族通吃）', () => {
  const rows = [
    { cwd: 'D:/coding/dsh-takeover' },
    { cwd: 'D:/coding/dsh-takeover' },
    { cwd: 'D:\\coding\\dsh-hippo' },
    { cwd: '' },
  ] as unknown as Parameters<typeof cwdFacets>[0]
  const facets = cwdFacets(rows)
  // 同为 1 张时按 label localeCompare：'—' 排在 'dsh-hippo' 前（cwdFacets 既有排序口径）
  assert.deepEqual(facets.map((f) => f.label), ['dsh-takeover', '—', 'dsh-hippo'])
})
