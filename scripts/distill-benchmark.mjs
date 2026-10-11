/**
 * 蒸馏保真度基准——「跟模型升级」的工程化底座。
 * 范围（诚实声明）：本脚本钉的是**确定性蒸馏层**（foreignSessionRead show：
 * summarizeTurns 的首条请求/尾部进展/警告词表），不含模型改写质量——后者
 * 属于会话内 /resume-* 流程，走真机可见会话验证。
 *
 * 用例来自本地未入库配置 benchmark.cases.json（探测目标是你本机的真实会话，
 * 真实 id/标题不得写进仓库）。格式：
 *   [{ "label": "...", "provider": "zcode", "reference": "<会话id>",
 *      "probes": ["首条请求中的子串", "..."] }, ...]
 * 用法：node --import tsx/esm scripts/distill-benchmark.mjs [--out <md路径>]
 * 探针全中才算过，任一失守退出码 1。
 */
import { writeFileSync } from 'node:fs'
import { foreignSessionRead } from '../src/foreign.ts'

const CONFIG_PATH = 'benchmark.cases.json'
let CASES
try {
  CASES = JSON.parse(readFileSync(new URL('../../' + CONFIG_PATH, import.meta.url), 'utf8'))
} catch {
  console.error(`缺少 ${CONFIG_PATH}（探测目标是你本机的真实会话，真实 id 不入库）。`)
  console.error('格式：[{"label":"...","provider":"zcode","reference":"<会话id>","probes":["子串", ...]}, ...]')
  process.exit(2)
}
if (!Array.isArray(CASES) || CASES.length === 0) {
  console.error(`${CONFIG_PATH} 为空或不是数组。`)
  process.exit(2)
}

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
  for (const p of c.probes ?? []) {
    checks.push({ probe: p, where: 'summary.firstUserMessage', hit: r.summary.firstUserMessage.includes(p) })
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
