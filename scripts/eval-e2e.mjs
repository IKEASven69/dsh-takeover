#!/usr/bin/env node
/**
 * ② 质量层 · 端到端接力成功率（真 host + 真模型）：
 * 双卡驱动的两棒接力——
 *   卡1（步1）→ [POST takeover inbox] → 会话 A 执行步1 + handoff_push 寄存卡2
 *   卡2（步2）→ [POST takeover inbox] → 会话 B 取件执行步2
 * 完成判定 = 工作区文件的确定性断言（NOTES.md 两棒笔迹 + TODO.md 的 alpha→beta）。
 *
 * 前置：本地 DSH host 运行中（--token），其 HANDOFF_HOME 与本脚本一致（隔离目录）。
 * 用法：node scripts/eval-e2e.mjs --token <t> [--host http://127.0.0.1:3080]
 *        [--handoff-home <dir>] [--timeout-ms 480000]
 * @module dsh-takeover/eval-e2e
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const HOST = arg('host', 'http://127.0.0.1:3080')
const TOKEN = arg('token', '')
const HOME_DIR = arg('handoff-home', '')
const TIMEOUT_MS = Number(arg('timeout-ms', '480000'))
const PENDING = join(HOME_DIR, 'pending')

const workspace = join(tmpdir(), `eval-e2e-ws-${Date.now()}`)
mkdirSync(workspace, { recursive: true })
writeFileSync(join(workspace, 'TODO.md'), 'alpha\n', 'utf-8')
execFileSync('git', ['init', '-q'], { cwd: workspace })
execFileSync('git', ['-C', workspace, 'add', '-A'])
execFileSync('git', ['-C', workspace, 'config', 'user.email', 'eval@local'])
execFileSync('git', ['-C', workspace, 'config', 'user.name', 'eval'])

const t0 = Date.now()
const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`)

async function takeoverInbox(id) {
  const res = await fetch(`${HOST}/dsh-takeover/takeover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOST, host: new URL(HOST).host },
    body: JSON.stringify({ mode: 'inbox', reference: id, lang: 'zh' }),
  })
  return res.json()
}

function cardMarkdown(id, sections) {
  return [
    '---',
    'handoff: 1',
    `id: ${id}`,
    'from:',
    '  agent: eval',
    '  session: ""',
    `  title: ${sections.title}`,
    'to: any',
    'project: eval-e2e',
    `cwd: ${JSON.stringify(workspace)}`,
    'pushed_at: 2026-01-01T00:00:00+08:00',
    'git:',
    '  branch: ""',
    '  changed: []',
    'tasks: []',
    '---',
    '',
    `## 目标（goal）`,
    '',
    sections.goal,
    '',
    `## 涉及文件（files）`,
    '',
    `- ${workspace}（工作区，全部操作在此目录）`,
    '',
    `## 做到哪（done）`,
    '',
    '- CURRENT_OBSERVED 本卡由评测脚本确定性构造',
    '',
    `## 还差什么（remaining）`,
    '',
    sections.remaining,
    '',
    `## 停在哪（stopped）`,
    '',
    sections.stopped,
    '',
    `## 读者警告（warnings）`,
    '',
    '- HISTORY_REPORTED 本卡即任务书，按卡执行即可。',
    '',
  ].join('\n')
}

async function poll(fn, timeoutMs, everyMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v !== null && v !== undefined && v !== false) return v
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

const result = {
  scenario: 'two-card relay (A: step1+deposit → B: pickup+step2)',
  workspace,
  steps: {},
  success: false,
}

try {
  // 1) 卡1 进 pending
  const id1 = 'ho-eval-a1'
  writeFileSync(join(PENDING, `${id1}.md`), cardMarkdown(id1, {
    title: 'eval-e2e 步1',
    goal: `步1（只做这一步）：在 ${workspace} 里创建 NOTES.md，内容恰好一行：step1 done by agent A`,
    remaining: [
      '1. 完成步1后，立即用 handoff_push 工具寄存一张新接力卡：',
      '   - title 以 eval-e2e-step2 开头',
      `   - goal 段写明步2：在 ${workspace} 的 NOTES.md 末尾追加一行 step2 done by agent B，并把 TODO.md 中的 alpha 改成 beta`,
      '   - cwd 参数传 ' + workspace,
      '2. 寄存完成后报告新卡 id。',
    ].join('\n'),
    stopped: '你是本接力的第一棒。最安全的第一步：确认工作区目录存在。',
  }), 'utf-8')
  log(`卡1 已入 pending：${id1}`)

  // 2) 投递会话 A
  const r1 = await takeoverInbox(id1)
  if (!r1.ok) throw new Error(`卡1 投递失败：${r1.error}`)
  result.steps.sessionA = { sessionId: r1.sessionId, title: r1.title }
  log(`会话 A 已创建并投递：${r1.sessionId}`)

  // 3) 等卡2 出现（A 的寄存产物）
  const knownBefore = new Set(readdirSync(PENDING).filter((f) => f.endsWith('.md')))
  const card2 = await poll(() => {
    const now = readdirSync(PENDING).filter((f) => f.endsWith('.md') && !knownBefore.has(f))
    return now.length > 0 ? now[0] : null
  }, TIMEOUT_MS)
  if (card2 === null) throw new Error(`超时：会话 A 未在 ${TIMEOUT_MS}ms 内寄存卡2`)
  const id2 = card2.slice(0, -3)
  result.steps.card2 = { id: id2, atMs: Date.now() - t0 }
  log(`卡2 已出现：${id2}`)

  // 4) 投递会话 B
  const r2 = await takeoverInbox(id2)
  if (!r2.ok) throw new Error(`卡2 投递失败：${r2.error}`)
  result.steps.sessionB = { sessionId: r2.sessionId, title: r2.title }
  log(`会话 B 已创建并投递：${r2.sessionId}`)

  // 5) 等完成断言通过
  const done = await poll(() => {
    try {
      const notes = readFileSync(join(workspace, 'NOTES.md'), 'utf-8')
      const todo = readFileSync(join(workspace, 'TODO.md'), 'utf-8')
      const ok = notes.includes('step1 done by agent A') && notes.includes('step2 done by agent B') && todo.includes('beta') && !todo.includes('alpha')
      return ok
    } catch { return false }
  }, TIMEOUT_MS, 5_000)
  result.success = done !== null
  result.steps.finalAssert = { notes: existsSync(join(workspace, 'NOTES.md')) ? readFileSync(join(workspace, 'NOTES.md'), 'utf-8').trim() : null, todo: readFileSync(join(workspace, 'TODO.md'), 'utf-8').trim() }
  log(`完成判定：${result.success ? 'PASS' : 'FAIL'}`)
} catch (e) {
  result.error = e instanceof Error ? e.message : String(e)
  log(`失败：${result.error}`)
}
result.totalMs = Date.now() - t0
const out = join(HOME_DIR, '..', 'eval-e2e-result.json')
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')
console.log(JSON.stringify(result, null, 2))
console.log(`结果已写：${out}`)
