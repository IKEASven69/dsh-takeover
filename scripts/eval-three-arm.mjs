#!/usr/bin/env node
/**
 * 0.4.1 归因版 · 三臂对照实验（真 host + 真模型）。
 *
 * 假设：同等信息量下，结构化六段卡的接手成功率高于纯文本段与最小对照；
 * 且 warnings 段携带的 marker 事实只有结构化臂会物化（段落效用探针）。
 *
 * 设计（预注册口径，见 eval/README.md）：
 *  - 单跳接力：前置工作由脚本确定性写入仓库（排除寄存侧模型噪声），
 *    三臂只变动「接手方收到的交接物」：
 *      structured = 六段结构化卡（事实分埋 remaining/warnings/done）
 *      plain      = 薄卡：同源事实全部并入 goal 一段散文，其余段空
 *      minimal    = 最小对照：只有「继续这个仓库里的工作」，仓库即全部信息
 *  - 每臂 3 轮（--rounds 可调），共 9 次真模型接手；判定全部为产物文件断言
 *  - 统计口径：n=3/臂 为方向性证据，不做显著性宣称（预注册声明，加轮次
 *    用同脚本 --rounds 延长）
 *  - 阴性结果也是合法结果：minimal 臂若不输，如实报告
 *
 * 前置：本地 DSH host 运行中（--token），其 HANDOFF_HOME 与 --handoff-home 一致。
 * 用法：node scripts/eval-three-arm.mjs --token <t> [--host http://127.0.0.1:3080]
 *        [--handoff-home <dir>] [--rounds 3] [--timeout-ms 300000]
 *        [--out test-artifacts/three-arm-report.json] [--arms structured,plain,minimal]
 * @module dsh-takeover/eval-three-arm
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FACTS, armCardSections, probesOf, armSuccess, assertCardCarries } from './section-utility.mjs'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const HOST = arg('host', 'http://127.0.0.1:3080')
const TOKEN = arg('token', '')
const HOME_DIR = arg('handoff-home', '')
const ROUNDS = Math.max(1, Number(arg('rounds', '3')))
const TIMEOUT_MS = Number(arg('timeout-ms', '300000'))
const OUT = arg('out', join(process.cwd(), 'test-artifacts', 'three-arm-report.json'))
const ARMS = arg('arms', 'structured,plain,minimal').split(',')

const PENDING = join(HOME_DIR, 'pending')
const t0 = Date.now()
const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!TOKEN) {
  console.error('缺 --token（host web token）')
  process.exit(1)
}

async function takeoverInbox(id) {
  const res = await fetch(`${HOST}/dsh-takeover/takeover`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: HOST, host: new URL(HOST).host },
    body: JSON.stringify({ mode: 'inbox', reference: id, lang: 'zh' }),
  })
  return res.json()
}

/**
 * 卡片正文：段标题必须是规范形态（## 目标 / ## 涉及文件 / …）。
 *
 * 实测教训（2026-10-26）：此处曾写成「## 目标（goal）」形态——core 的
 * parseSections 只认「## 目标」，六段全被解析成空字符串且不报错，接手方收到
 * 一张空卡（事实 gamma / [TX-77] 全在仓库里找不到），三臂实验静默作废。
 * 交付前有 assertCardCarries 回读自检兜底（见下方投递处）。
 */
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
    'project: eval-three-arm',
    `cwd: ${JSON.stringify(wsDir())}`,
    'pushed_at: 2026-01-01T00:00:00+08:00',
    'git:',
    '  branch: ""',
    '  changed: []',
    'tasks: []',
    '---',
    '',
    '## 目标', '',
    sections.goal, '',
    '## 涉及文件', '',
    sections.files, '',
    '## 做到哪', '',
    sections.done, '',
    '## 还差什么', '',
    sections.remaining, '',
    '## 停在哪', '',
    sections.stopped, '',
    '## 读者警告', '',
    sections.warnings, '',
  ].join('\n')
}

let WS = ''
function wsDir() { return WS }

/** 每轮确定性前置：git 仓库 + step1 产物（前置工作不经过模型，排除寄存侧噪声） */
function makeWorkspace(round, arm) {
  const dir = join(tmpdir(), `three-arm-${arm}-${round}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'TODO.md'), `${FACTS.workTodoFrom}\n`, 'utf-8')
  writeFileSync(join(dir, 'NOTES.md'), `# Notes\n${FACTS.contextDone}\n`, 'utf-8')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'eval@local'])
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'eval'])
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'step1 by predecessor'])
  return dir
}

/** 等待产物就绪（轮询 TODO/NOTES，超时返回当前快照） */
async function waitOutput(dir, deadline) {
  while (Date.now() < deadline) {
    const todo = existsSync(join(dir, 'TODO.md')) ? readFileSync(join(dir, 'TODO.md'), 'utf-8') : ''
    const notes = existsSync(join(dir, 'NOTES.md')) ? readFileSync(join(dir, 'NOTES.md'), 'utf-8') : ''
    if (armSuccess({ todo, notes })) return { todo, notes, settled: true }
    await sleep(10_000)
  }
  return {
    todo: existsSync(join(dir, 'TODO.md')) ? readFileSync(join(dir, 'TODO.md'), 'utf-8') : '',
    notes: existsSync(join(dir, 'NOTES.md')) ? readFileSync(join(dir, 'NOTES.md'), 'utf-8') : '',
    settled: false,
  }
}

const report = { generatedAt: new Date().toISOString(), host: HOST, rounds: ROUNDS, timeoutMs: TIMEOUT_MS, arms: {} }
let sessionIdCount = 0

for (const arm of ARMS) {
  const armResult = { rounds: [] }
  for (let round = 1; round <= ROUNDS; round++) {
    WS = makeWorkspace(round, arm)
    // SAFE_ID = ho-<8位小写字母数字>-<4位>。曾生成四段式 id（ho-ta01-stru-xxxx）
    // 被收件箱工具整批拒收——模型只能绕路直接读文件，消费即弃被架空（实测教训）
    const rnd = Math.random().toString(36).slice(2, 10).padEnd(8, '0')
    const id = `ho-ta${round}${arm[0]}${rnd.slice(0, 4)}-${rnd.slice(4, 8)}`
    const sections = armCardSections(arm, FACTS)
    const cardText = cardMarkdown(id, sections)
    // 交付前自检：卡文必须能被 core 解析出六段内容（否则接手方拿到空卡，实验作废）
    assertCardCarries(cardText, sections)
    writeFileSync(join(PENDING, `${id}.md`), cardText, 'utf-8')
    log(`[${arm}#${round}] 卡已投递 ${id}`)
    const r = await takeoverInbox(id)
    if (!r.ok) {
      log(`[${arm}#${round}] takeover 失败：${r.error ?? '?'}`)
      armResult.rounds.push({ round, id, error: r.error ?? 'takeover-failed' })
      continue
    }
    sessionIdCount += 1
    log(`[${arm}#${round}] 会话 ${r.sessionId} 已建，等待产物（≤${Math.round(TIMEOUT_MS / 1000)}s）`)
    const output = await waitOutput(WS, Date.now() + TIMEOUT_MS)
    const probes = probesOf(output)
    const success = armSuccess(output)
    armResult.rounds.push({ round, id, sessionId: r.sessionId, success, probes, output })
    log(`[${arm}#${round}] ${success ? '✅ 成功' : '❌ 未完成'}（todo=${probes.todoFlipped} note=${probes.noteAppended} marker=${probes.markerUsed}）`)
  }
  const ok = armResult.rounds.filter((r) => r.success === true).length
  armResult.successCount = ok
  armResult.total = armResult.rounds.length
  report.arms[arm] = armResult
  log(`[${arm}] 成功 ${ok}/${armResult.total}`)
}

// 汇总（n=3/臂 为方向性证据——预注册声明，不做显著性宣称）
report.summary = Object.fromEntries(Object.entries(report.arms).map(([a, r]) => [a, `${r.successCount}/${r.total}`]))
mkdirSync(join(OUT, '..'), { recursive: true })
writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf-8')
console.log(`\n三臂结果：${JSON.stringify(report.summary)} → ${OUT}`)
console.log(`共创建 ${sessionIdCount} 个真模型会话；会话留在宿主可自行查看/停止。`)
