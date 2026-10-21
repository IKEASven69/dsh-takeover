#!/usr/bin/env node
/**
 * ② 质量层 · 历史回测：archived 卡 × 后续 git 活动的延续证据。
 *
 * 问题：一张卡被消费之后，那个仓库里的工作真的被延续了吗？账本覆盖率高的卡
 * 是否更容易被延续？（此前「卡的质量」没有任何数字回答过这件事。）
 *
 * 方法（确定性，无 LLM）：对每张 archived 卡——
 * - 取 cwd：不存在/非 git 仓 → 记不可回测原因（诚实计数，不粉饰）；
 * - 延续证据：git log --since <pushed_at> --name-only，提交数 + 触及文件 ∩ 卡「涉及文件」
 *   段的文件级重叠（overlap ≥ 1 个文件 = 该卡有延续证据）；
 * - 账本相关性：extras.coverage 的 marked 比率高/低两组，各自的延续率对比。
 * 隐私纪律：输出只有聚合计数与文件 basename 样本，不落任何卡正文/路径全文；
 * 明细报告写 test-artifacts/（本地，不入库）。
 *
 * 用法：node scripts/backtest-archived.mjs [--archived <dir>] [--out <file>]
 * @module dsh-takeover/backtest-archived
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const archivedDir = arg('archived', join(homedir(), '.handoff', 'archived'))
const outPath = arg('out', join(process.cwd(), 'test-artifacts', 'backtest-report.json'))

// ---------- 卡解析（兼容新旧段标题：## 目标 / ## 目标（goal）等） ----------

/** 抽某一段的正文（到下一个 ## 或文件尾） */
export function sectionOf(cardText, names) {
  const lines = cardText.split('\n')
  let inSection = false
  const out = []
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = names.some((n) => line.includes(n))
      continue
    }
    if (inSection) out.push(line)
  }
  return out.join('\n')
}

/** 从一段文本里抠路径样 token（含引号/反引号/列表记号剥离） */
export function extractPaths(text) {
  const out = new Set()
  const re = /([A-Za-z]:[\\/][^\s'"`），。]+|\/(?:[\w.@+-]+\/)+[\w.@+-]+|[\w.@+-]+(?:[\\/][\w.@+-]+)+)/g
  for (const m of text.matchAll(re)) {
    const p = m[1].replace(/^[`'"]+|[`'"]+$/g, '').replace(/[).,]+$/, '')
    if (p.length > 3) out.add(p)
  }
  return [...out]
}

/** frontmatter 单值抽取（宽松：key: value 行） */
export function frontmatterValue(cardText, key) {
  const m = new RegExp(`^${key}:\\s*"?([^"\\n]*)"?",?\\s*$`, 'm').exec(cardText)
  return m?.[1]?.trim() ?? ''
}

/** coverage 从 extras（卡片文本里没有——extras 在信封/解析层；archived 卡本体无 extras，
 * 这里从卡的 done 段现场统计四态标注比例，与推送侧 coverageOfDone 同口径） */
export function markedRatioOf(cardText) {
  const done = sectionOf(cardText, ['做到哪'])
  const lines = done.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
  if (lines.length === 0) return null
  const marks = ['CURRENT_OBSERVED', 'HISTORY_REPORTED', 'MISMATCH', 'UNAVAILABLE']
  const marked = lines.filter((l) => marks.some((m) => l.includes(m))).length
  return { statements: lines.length, marked, ratio: marked / lines.length }
}

// ---------- 回测核心（导出供单测） ----------

/** git 延续证据：since 之后提交数 + 与卡文件的重叠（纯函数依赖注入式：cmds 由调用方给） */
export function continuationEvidence(repoEval) {
  // repoEval: { cwd, sinceIso, cardFiles } | null
  if (repoEval === null) return { measurable: false, reason: 'cwd-missing' }
  const run = (args) => {
    try {
      return execFileSync('git', ['-C', repoEval.cwd, ...args], { encoding: 'utf-8', timeout: 15_000 })
    } catch {
      return null
    }
  }
  const log = run(['log', `--since=${repoEval.sinceIso}`, '--name-only', '--pretty=format:@@'])
  if (log === null) return { measurable: false, reason: 'not-git' }
  const commits = log.split('@@').map((s) => s.trim()).filter((s) => s !== '')
  const touched = new Set()
  for (const c of commits) {
    for (const line of c.split('\n')) {
      const t = line.trim()
      if (t !== '' && !t.startsWith('Merge')) touched.add(t)
    }
  }
  const cardNames = new Set(repoEval.cardFiles.map((f) => basename(f.replace(/\\/g, '/'))))
  let overlap = 0
  for (const t of touched) if (cardNames.has(basename(t.replace(/\\/g, '/')))) overlap += 1
  return { measurable: true, commits: commits.length, touchedFiles: touched.size, overlapFiles: overlap, continued: overlap > 0 }
}

/** 回测一批卡（纯函数核心：cards 为 {id, text, pushedAt} 数组） */
export function backtest(cards, opts = {}) {
  const rows = []
  for (const c of cards) {
    const cwd = frontmatterValue(c.text, 'cwd')
    const pushedAt = frontmatterValue(c.text, 'pushed_at')
    const files = extractPaths(sectionOf(c.text, ['涉及文件']))
    const cov = markedRatioOf(c.text)
    const repoExists = cwd !== '' && existsSync(cwd)
    const ev = repoExists ? continuationEvidence({ cwd, sinceIso: pushedAt, cardFiles: files }) : { measurable: false, reason: 'cwd-missing' }
    rows.push({
      id: c.id,
      cwdExists: repoExists,
      measurable: ev.measurable,
      reason: ev.reason ?? null,
      cardFiles: files.length,
      commitsSince: ev.commits ?? null,
      overlapFiles: ev.overlapFiles ?? null,
      continued: ev.continued ?? null,
      coverage: cov,
    })
  }
  const measurable = rows.filter((r) => r.measurable)
  const continued = measurable.filter((r) => r.continued)
  // 账本相关性：有 coverage 数据的卡，按 marked 比率中位数分高低两组比延续率
  const withCov = measurable.filter((r) => r.coverage !== null)
  let correlation = null
  if (withCov.length >= 4) {
    const ratios = withCov.map((r) => r.coverage.ratio).sort((a, b) => a - b)
    const median = ratios[Math.floor(ratios.length / 2)]
    const high = withCov.filter((r) => r.coverage.ratio >= median)
    const low = withCov.filter((r) => r.coverage.ratio < median)
    correlation = {
      n: withCov.length,
      medianRatio: Number(median.toFixed(3)),
      continuationHigh: high.length > 0 ? high.filter((r) => r.continued).length / high.length : null,
      continuationLow: low.length > 0 ? low.filter((r) => r.continued).length / low.length : null,
    }
  }
  return {
    total: rows.length,
    measurable: measurable.length,
    unmeasurable: rows.length - measurable.length,
    unmeasurableReasons: rows.filter((r) => !r.measurable).reduce((acc, r) => { acc[r.reason] = (acc[r.reason] ?? 0) + 1; return acc }, {}),
    continuedCount: continued.length,
    continuationRate: measurable.length > 0 ? Number((continued.length / measurable.length).toFixed(3)) : null,
    avgCardFiles: measurable.length > 0 ? Number((measurable.reduce((s, r) => s + r.cardFiles, 0) / measurable.length).toFixed(2)) : null,
    correlation,
    rows,
  }
}

// ---------- 主流程（仅直接执行时运行；被单测 import 只取导出的纯函数） ----------
const files = existsSync(archivedDir) ? readdirSync(archivedDir).filter((f) => f.endsWith('.md')) : []
if (basename(process.argv[1] ?? '') === 'backtest-archived.mjs') {
  const cards = files.map((f) => {
    const p = join(archivedDir, f)
    return { id: f.slice(0, -3), text: readFileSync(p, 'utf-8'), mtime: statSync(p).mtimeMs }
  })
  const report = backtest(cards)
  report.archivedDirBasename = basename(archivedDir)
  report.generatedBy = 'scripts/backtest-archived.mjs'
  mkdirSync(join(outPath, '..'), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  console.log(`回测完成：${report.total} 张卡，可测 ${report.measurable}（不可测 ${report.unmeasurable}：${JSON.stringify(report.unmeasurableReasons)}）`)
  console.log(`延续率：${report.continuationRate}（${report.continuedCount}/${report.measurable}）；卡均文件数 ${report.avgCardFiles}`)
  console.log(`账本相关性：${JSON.stringify(report.correlation)}`)
  console.log(`明细：${outPath}（本地，不入库）`)
}
