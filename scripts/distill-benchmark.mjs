/**
 * 蒸馏保真度基准（FR-5）——「跟模型升级」的工程化底座。
 * 范围（诚实声明）：本脚本钉的是**确定性蒸馏层**（foreignSessionRead show：
 * summarizeTurns 的首条请求/尾部进展/警告词表），不含模型改写质量——后者
 * 属于会话内 /resume-* 流程，走真机可见会话验证（迭代计划 §五）。
 * 用法：node --import tsx/esm scripts/distill-benchmark.mjs [--out <md路径>]
 * 会话集与探针=本机真实会话（换机器请改 CASES）；探针全中才算过，任一失守退出码 1。
 */
import { writeFileSync } from 'node:fs'
import { foreignSessionRead } from '../src/foreign.ts'

const CASES = [
  {
    label: 'zcode dsh-baton（出游学习项目，3275 轮）',
    provider: 'zcode',
    reference: 'sess_9851f021-8e34-4716-a8a6-6a3c67532e0c',
    probes: ['出游'],
  },
  {
    label: 'zcode 生产级项目灵感推荐（7284 轮）',
    provider: 'zcode',
    reference: 'sess_6d74da3d-ac07-46a3-91c8-3ed721c75de7',
    probes: ['灵感'],
  },
  {
    label: 'opencode 工作区项目扫描与整理（1310 轮）',
    provider: 'opencode',
    reference: 'ses_fa4179147fferl2nR9GymQVRA8',
    probes: ['扫描'],
  },
]

const results = []
let failed = 0
for (const c of CASES) {
  const r = await foreignSessionRead({ provider: c.provider, action: 'show', reference: c.reference })
  if (!r.ok || r.action !== 'show') {
    failed++
    results.push({ label: c.label, ok: false, error: JSON.stringify('error' in r ? r.error : r) })
    continue
  }
  const checks = []
  for (const p of c.probes) {
    checks.push({ probe: p, where: 'summary.firstUserMessage', hit: r.summary.firstUserMessage.includes(p) })
    checks.push({ probe: p, where: 'skeleton.goal', hit: r.skeleton.goal.includes(p) })
  }
  checks.push({ probe: 'HISTORY_REPORTED', where: 'skeleton.warnings（账本词表）', hit: r.skeleton.warnings.includes('HISTORY_REPORTED') })
  checks.push({ probe: '非空', where: 'summary.tailProgress', hit: r.summary.tailProgress.length > 0 })
  const misses = checks.filter((k) => !k.hit)
  if (misses.length > 0) failed++
  results.push({ label: c.label, ok: misses.length === 0, turnCount: r.summary.turnCount, userTurns: r.summary.userTurns, checks })
}

const lines = ['# 蒸馏保真度基线（确定性层）', '', `- 运行时刻：${new Date().toISOString()}`, `- 会话集：${CASES.length} 条；结果：${failed === 0 ? '全部通过' : `${failed} 条失守`}`, '']
for (const r of results) {
  lines.push(`## ${r.label} —— ${r.ok ? '✅' : '❌'}`)
  if (!r.ok && r.error !== undefined) { lines.push(`- 错误：${r.error}`, ''); continue }
  lines.push(`- 轮数 ${r.turnCount}（用户 ${r.userTurns}）`)
  for (const k of r.checks ?? []) lines.push(`- ${k.hit ? '✅' : '❌'} [${k.where}] 探针「${k.probe}」`)
  lines.push('')
}

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined
if (out !== undefined) {
  writeFileSync(out, lines.join('\n'), 'utf8')
  console.log(`报告已写入 ${out}`)
}
console.log(lines.join('\n'))
process.exitCode = failed === 0 ? 0 : 1
