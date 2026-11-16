#!/usr/bin/env node
/**
 * Tier 2 跨机接力演示（0.25.0）：Kiro（jsonl 族）会话从 A 机蒸馏成卡、跨机、B 机取件接着干。
 *
 * 场景 = Tier 2 适配器的最小可复现全链：
 *   ① 合成 Kiro CLI 会话 fixture（<root>/<uuid>.jsonl 事件流：Prompt / AssistantMessage
 *      的 text 与 toolUse 块 / ToolResults，引擎原生行法，tests/jsonl-family.spec.ts 同款
 *      手法），HANDOFF_ROOT_KIRO 指向该根（readers 模块加载时读环境变量，必须先行设定）；
 *   ② readers discover（action=list 列候选）→ parse（action=show 蒸馏摘要与六段骨架）；
 *   ③ 骨架六段寄存成协议卡（六段齐全、密钥闸/信封签名全套纪律照走）；
 *   ④ syncSetup + syncNow 经本地裸仓库远端推走；
 *   ⑤ B 机 setup + now 拉到卡、取件，断言 Turn 与六段齐全：
 *      turnCount 覆盖 fixture 全部事件轮、六段标题在卡上、工具轮路径进「涉及文件」。
 *
 * 纪律：全部落盘走两个临时 HANDOFF_HOME + 临时 Kiro 根 + 裸远端，不碰真实 ~/.handoff、
 * 不碰真实 ~/.kiro；断言不过就非零退出（退出码 0 = 贯通），绝不造假。
 *
 * 用法：npx tsx scripts/demo-tier2.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 断言工具：断言不过立即抛，外层统一捕获后非零退出——演示结果不造假
// ---------------------------------------------------------------------------

let step = 0
const say = (msg) => console.log(`\n【第 ${step} 步】${msg}`)
const info = (msg) => console.log(`  ${msg}`)

function must(cond, label, detail = '') {
  if (cond) {
    info(`✅ ${label}`)
    return
  }
  info(`❌ ${label}${detail !== '' ? ` —— ${detail}` : ''}`)
  throw new Error(`断言失败：${label}`)
}

// ---------------------------------------------------------------------------
// fixture：双 home + 裸远端 + Kiro 会话 jsonl（HANDOFF_ROOT_KIRO 先于 readers 加载设定）
// ---------------------------------------------------------------------------

const KIRO_ROOT = mkdtempSync(join(tmpdir(), 'dsh-tier2-kiro-'))
process.env['HANDOFF_ROOT_KIRO'] = KIRO_ROOT

// src 模块走 tsx 直跑（typecheck/test 不覆盖本脚本，见 package.json scripts.check 口径；
// 守门由 tests/tier2-demo.spec.ts 以子进程跑本脚本、断言退出码 0）
const src = (p) => import(pathToFileURL(join(REPO_ROOT, 'src', p)).href)
const { foreignSessionRead } = await src('foreign.ts')
const { pushHandoff, inboxList, inboxLoad } = await src('tools.ts')
const { syncSetup, syncNow } = await src('sync.ts')

/** 弹性清理：git 裸仓 pack/objects 只读，Windows rmSync EPERM 时 attrib 清只读再删（tests/sync.spec.ts 同款） */
function rmGit(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    try {
      execFileSync('cmd', ['/c', 'attrib', '-R', join(p, '*'), '/s', '/d'], { stdio: 'ignore' })
      rmSync(p, { recursive: true, force: true })
    } catch { /* 尽力清：临时目录留尸无害 */ }
  }
}

const A = mkdtempSync(join(tmpdir(), 'dsh-tier2-home-a-'))
const B = mkdtempSync(join(tmpdir(), 'dsh-tier2-home-b-'))
const remote = mkdtempSync(join(tmpdir(), 'dsh-tier2-sync-remote-'))
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' })

/** 合成 Kiro CLI 会话：一行一 {version, kind, data} 事件（适配器已知 kind 分派、未知行跳过）。
 * meta.timestamp 为 epoch 秒（毫秒自适应）——取当前时刻即可，mtime 驱动排序。 */
function makeKiroSession() {
  mkdirSync(KIRO_ROOT, { recursive: true })
  const jsonl = join(KIRO_ROOT, '3f2b8c1a-9d4e-4f6a-8b7c-5e1d2a3b4c5d.jsonl')
  const now = Math.floor(Date.now() / 1000)
  const event = (kind, data, ts) => JSON.stringify({ version: 1, kind, data: { ...data, meta: { timestamp: ts } } })
  const textBlock = (t) => ({ kind: 'text', data: t })
  const targetFile = join(A, 'kiro-demo-work', 'resume-notes.md')
  writeFileSync(jsonl, [
    event('Prompt', { content: [textBlock('把 Tier2 十四家的收尾做完：Kiro 会话蒸馏成卡跨机接力')] }, now),
    event('AssistantMessage', { content: [textBlock('好的，先合成 Kiro 会话 fixture 验证读取器。')] }, now + 1),
    event('AssistantMessage', { content: [{ kind: 'toolUse', data: { toolUseId: 't1', name: 'Write', input: { file_path: targetFile, content: '# 接力笔记\n' } } }] }, now + 2),
    event('ToolResults', { content: [{ kind: 'toolResult', data: { toolUseId: 't1', content: [textBlock('写入成功')], status: 'success' } }] }, now + 3),
    event('Prompt', { content: [textBlock('跨机演示跑通就准备发版')] }, now + 4),
    event('AssistantMessage', { content: [textBlock('跨机链路全绿，六段卡齐了，准备收尾发版。')] }, now + 5),
  ].join('\n'), 'utf-8')
  return { jsonl, targetFile }
}

const { jsonl, targetFile } = makeKiroSession()

try {
  // -------------------------------------------------------------------------
  say('fixture 就绪：Kiro 会话 jsonl + A/B 双 home + 裸远端（HANDOFF_ROOT_KIRO 已指向）')
  info(`Kiro 会话：${jsonl}`)
  info(`裸远端（同步端点）：${remote}`)

  // -------------------------------------------------------------------------
  step = 1
  say('readers discover：action=list 列 Kiro 候选（标题取首条用户输入前 40 字）')
  const list = await foreignSessionRead({ provider: 'kiro', action: 'list' })
  must(list.ok === true, 'foreign_session_read list 成功', list.ok ? '' : String(list.error))
  if (!list.ok) throw new Error('discover 失败，演示无法继续')
  must(list.total === 1 && list.sessions.length === 1, `候选 1/1（合成会话被 discover 命中）`, `total=${list.total}`)
  must(list.sessions[0].title.includes('Tier2 十四家的收尾'), '标题蒸馏自首条用户输入', list.sessions[0].title)

  // -------------------------------------------------------------------------
  step = 2
  say('readers parse + 蒸馏：action=show 出结构化摘要与六段骨架')
  const show = await foreignSessionRead({ provider: 'kiro', action: 'show' })
  must(show.ok === true, 'foreign_session_read show 成功', show.ok ? '' : String(show.error))
  if (!show.ok) throw new Error('parse 失败，演示无法继续')
  must(show.summary.sessionId === jsonl, 'latest 命中合成会话 jsonl')
  // Turn 齐全：Prompt×2 + AssistantMessage text×2 + toolUse×1 + ToolResults×1 = 6 轮
  must(show.summary.turnCount === 6, `Turn 全量解析：${show.summary.turnCount}/6（user/assistant/tool 三种角色都在）`)
  must(show.summary.firstUserMessage.includes('Tier2 十四家的收尾'), '首条用户请求进摘要')
  must(show.summary.lastUserMessage.includes('发版'), '最后一条用户请求进摘要')
  must(show.summary.files.some((f) => f === targetFile), '工具轮 file_path 进涉及文件（Write: <path> 摘要可抠路径）')
  for (const k of ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings']) {
    must(typeof show.skeleton[k] === 'string' && show.skeleton[k] !== '', `骨架六段有素材：${k}`)
  }

  // -------------------------------------------------------------------------
  step = 3
  say('蒸馏出卡：六段骨架寄存成协议卡（A 机 pending/）')
  const push = pushHandoff(null, {
    goal: show.skeleton.goal,
    files: show.skeleton.files,
    done: show.skeleton.done,
    remaining: show.skeleton.remaining,
    stopped: show.skeleton.stopped,
    warnings: show.skeleton.warnings,
    title: 'Kiro 会话 · Tier2 跨机演示',
    project: 'demo-tier2',
    cwd: '',
  }, { dir: A })
  must(push.ok === true, '会话卡寄存成功', push.ok ? '' : String(push.error))
  if (!push.ok) throw new Error('寄存失败，演示无法继续')
  info(`会话卡：${push.id}`)

  // -------------------------------------------------------------------------
  step = 4
  say('A 机 syncNow：卡经裸远端推走')
  const setupA = await syncSetup(remote, A)
  must(setupA.ok === true, 'A 机同步 setup 成功', setupA.ok ? '' : String(setupA.error))
  const pushA = await syncNow(A)
  must(pushA.ok === true, 'A 机 syncNow 推送成功', pushA.ok ? '' : String(pushA.error))

  // -------------------------------------------------------------------------
  step = 5
  say('B 机 setup + now + /inbox 取件：断言 Turn 与六段齐全')
  const setupB = await syncSetup(remote, B)
  must(setupB.ok === true, 'B 机同步 setup 成功（信任域随目录走：签名密钥同车）', setupB.ok ? '' : String(setupB.error))
  const pullB = await syncNow(B)
  must(pullB.ok === true, 'B 机 syncNow 拉取成功', pullB.ok ? '' : String(pullB.error))
  const listB = inboxList({ dir: B })
  must(listB.ok === true && listB.cards.length === 1, `B 机收件箱待取件 ${listB.cards.length}/1 张`)
  const load = inboxLoad(push.id, { dir: B })
  must(load.ok === true, '取件成功（消费即弃）', load.ok ? '' : String(load.error))
  if (!load.ok) throw new Error('取件失败，演示无法继续')
  must(load.sig === 'ok', '信封签名校验通过')
  for (const heading of ['## 目标', '## 涉及文件', '## 做到哪', '## 还差什么', '## 停在哪', '## 读者警告']) {
    must(load.text.includes(heading), `六段在卡上：${heading}`)
  }
  must(load.text.includes('Tier2 十四家的收尾'), '目标段带着首条用户请求（跨机不丢意图）')
  must(load.text.includes('发版'), '还差什么段带着最后一条用户请求')
  must(load.text.includes(targetFile), '涉及文件段带着工具轮路径')

  // -------------------------------------------------------------------------
  console.log('\n════════════════════════════════════════════')
  console.log('✅ Tier 2 跨机接力：Kiro discover → parse → 蒸馏 → 跨机 → 取件，全链绿。')
  console.log(`   会话卡 ${push.id}（Turn 6 轮 + 六段齐全 + 签名 ok）`)
  console.log('════════════════════════════════════════════')
  process.exitCode = 0
} catch (e) {
  console.error(`\n🛑 Tier 2 跨机演示失败：${e instanceof Error ? e.message : String(e)}`)
  console.error('   （断言不过即非零退出——演示结果不造假）')
  process.exitCode = 1
} finally {
  rmGit(A)
  rmGit(B)
  rmGit(remote)
  rmSync(KIRO_ROOT, { recursive: true, force: true })
}
