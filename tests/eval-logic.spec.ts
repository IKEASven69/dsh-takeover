/**
 * ② 质量层 · 评测器逻辑自检（合成数据，随 CI 跑）：
 * - backtest：延续证据检测（git log since + 文件重叠）、覆盖率分组相关性、
 *   不可测诚实计数（cwd 缺失 / 非 git 仓）；
 * - eval-distill：独立真相提取（tool_use 键序遍历 + 命令内路径）、保真度评分
 *   （文件召回/请求捕获/主文件在卡）。
 * 真实数据的跑分走本地脚本（scripts/backtest-archived.mjs / eval-distill.mjs），
 * 这里只验证评测器自身的逻辑正确性——评测器错了，基线数字就是谎话。
 * @module dsh-takeover/eval-logic
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// .mjs 脚本无类型声明——评测器是纯 JS，导入处按 any 使用并在逻辑测试里验证行为
// @ts-expect-error .mjs 无声明文件
import { backtest, continuationEvidence, extractPaths, markedRatioOf, sectionOf, frontmatterValue } from '../scripts/backtest-archived.mjs'
// @ts-expect-error .mjs 无声明文件
import { fidelity, groundTruthOf } from '../scripts/eval-distill.mjs'

// ---------- backtest 逻辑 ----------

const cardMarkdown = (over: { id?: string; cwd?: string; files?: string[]; done?: string; pushedAt?: string }): string => [
  '---',
  'handoff: 1',
  `id: ${over.id ?? 'ho-test-0001'}`,
  'from:',
  '  agent: dsh',
  `cwd: "${over.cwd ?? '/nonexistent-dir-xyz'}"`,
  `pushed_at: "${over.pushedAt ?? '2026-01-01T00:00:00+08:00'}"`,
  '---',
  '',
  '## 涉及文件',
  '',
  ...(over.files ?? []).map((f) => `- ${f}`),
  '',
  '## 做到哪',
  '',
  over.done ?? '- CURRENT_OBSERVED 事情做了一半',
  '',
].join('\n')

function makeGitRepo(withCommitAfter: boolean, touchedFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bt-'))
  const d = '2025-12-01T12:00:00'
  const g = (args: string[]): void => { execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } }) }
  g(['init', '-q'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', touchedFile), 'v1\n')
  g(['add', '-A'])
  g(['commit', '-q', '-m', 'base'])
  if (withCommitAfter) {
    const d2 = '2026-02-01T12:00:00'
    const g2 = (args: string[]): void => { execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_DATE: d2, GIT_COMMITTER_DATE: d2 } }) }
    writeFileSync(join(dir, 'src', touchedFile), 'v2\n')
    g2(['add', '-A'])
    g2(['commit', '-q', '-m', '延续提交'])
  }
  return dir
}

test('backtest · 延续证据：push 之后有提交且触及卡内文件 → continued=true', () => {
  const dir = makeGitRepo(true, 'a.ts')
  try {
    const ev = continuationEvidence({ cwd: dir, sinceIso: '2026-01-01T00:00:00+08:00', cardFiles: [join(dir, 'src', 'a.ts')] })
    assert.equal(ev.measurable, true)
    assert.equal(ev.continued, true, 'push 后的提交触及卡内文件=延续证据')
    assert.ok((ev.commits ?? 0) >= 1)
    assert.ok((ev.overlapFiles ?? 0) >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backtest · 无延续：push 后无提交 → continued=false（而非不可测）', () => {
  const dir = makeGitRepo(false, 'b.ts')
  try {
    const ev = continuationEvidence({ cwd: dir, sinceIso: '2026-01-01T00:00:00+08:00', cardFiles: [join(dir, 'src', 'b.ts')] })
    assert.equal(ev.measurable, true)
    assert.equal(ev.commits, 0)
    assert.equal(ev.continued, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backtest · 汇总：不可测诚实计数 + 相关性分组结构（真实 git 仓 × 4 卡）', () => {
  const repo = makeGitRepo(false, 'keep.ts')
  try {
    const cards = [
      { id: 'ho-a', text: cardMarkdown({ id: 'ho-a', cwd: 'D:/nope-1', files: [], done: '- CURRENT_OBSERVED x' }) },
      ...['f.ts', 'g.ts', 'h.ts'].map((f, i) => ({
        id: `ho-${i}`,
        text: cardMarkdown({
          id: `ho-${i}`,
          cwd: repo,
          files: [join(repo, 'src', f)],
          done: i === 0 ? '- 无标注的一条' : '- CURRENT_OBSERVED 有标注',
        }),
      })),
    ]
    const report = backtest(cards)
    assert.equal(report.total, 4)
    assert.equal(report.unmeasurableReasons['cwd-missing'], 1, 'cwd 不存在的卡诚实计数')
    assert.equal(report.measurable, 3, '指向真实 git 仓的三张可测')
    assert.ok(report.continuationRate !== null)
    // 相关性分组：n=3 可分组数据 <4 → null（样本不足不装模作样）
    assert.equal(report.correlation, null)
    // 4 张可分组时结构完整（补一张凑 n）
    const cards4 = [...cards.slice(1), { id: 'ho-e', text: cardMarkdown({ id: 'ho-e', cwd: repo, files: [join(repo, 'src', 'keep.ts')], done: '- HISTORY_REPORTED 有' }) }]
    const r4 = backtest(cards4)
    assert.ok(r4.correlation !== null && r4.correlation.n === 4)
    assert.ok(r4.correlation.continuationHigh !== null && r4.correlation.continuationLow !== null)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('backtest · 解析：新旧段标题兼容 + 路径提取 + 覆盖率口径', () => {
  const text = cardMarkdown({ files: ['`src/a.ts`', '"D:\\x\\y.md"'], done: '- CURRENT_OBSERVED 一\n- 二\n- HISTORY_REPORTED 三' })
  assert.equal(sectionOf(text, ['涉及文件']).includes('src/a.ts'), true)
  assert.equal(frontmatterValue(text, 'cwd'), '/nonexistent-dir-xyz')
  const paths = extractPaths(sectionOf(text, ['涉及文件']))
  assert.ok(paths.some((p: string) => p.includes('a.ts')), '反引号内的路径应被提取')
  const ratio = markedRatioOf(text)
  assert.equal(ratio?.statements, 3)
  assert.equal(ratio?.marked, 2)
  assert.ok(Math.abs((ratio?.ratio ?? 0) - 2 / 3) < 1e-9)
})

// ---------- eval-distill 逻辑 ----------

const synthTranscript = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: '把登录页错误提示改成双语' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'edit', input: { file_path: 'src/i18n.ts' } }, { type: 'tool_use', name: 'bash', input: { command: 'npm test -- i18n' } }] } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: '再把 TODO 更新一下' } }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set mode</local-command-stdout>' } }),
].join('\n')

test('eval-distill · 独立真相：tool_use 键序遍历 + 命令内路径 + shell 回声不算用户请求', () => {
  const truth = groundTruthOf(synthTranscript)
  assert.deepEqual(truth.userRequests, ['把登录页错误提示改成双语', '再把 TODO 更新一下'], '<local-command-*> 不是用户请求')
  assert.ok([...truth.fileHits.keys()].some((f) => f.includes('i18n.ts')), 'file_path 键应被独立提取')
})

test('eval-distill · 保真度评分：召回/请求捕获/主文件在卡三指标齐全', () => {
  const truth = groundTruthOf(synthTranscript)
  const card = {
    files: ['src/i18n.ts'],
    goal: '首条用户请求：把登录页错误提示改成双语\n最后一条用户请求：再把 TODO 更新一下',
    lastUserMessage: '再把 TODO 更新一下',
  }
  const s = fidelity(truth, card)
  assert.equal(s.fileRecall, 1, '卡覆盖了唯一的真相文件')
  assert.equal(s.requestCaptured, true, '最后请求前缀在 goal 里')
  assert.equal(s.topFileInCard, true)
  // 反例：文件没进卡
  const sMiss = fidelity(truth, { files: [], goal: '无关', lastUserMessage: '' })
  assert.equal(sMiss.fileRecall, 0)
  assert.equal(sMiss.requestCaptured, false)
})
