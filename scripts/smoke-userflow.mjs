#!/usr/bin/env node
/**
 * 真用户旅程实机测试（不开 dsh web，用真实 cordis + dsh-tools + dsh-skill 服务
 * 进程内挂载本仓构建产物 lib/index.js，真实 dispatch 全链路）：
 *
 *   第一幕  用户：「/resume-opencode 拉我上次的 opencode 会话」
 *           → list 候选 → show latest 结构化摘要 → 按 /resume-* 纪律蒸馏六段卡
 *           → 用户：「寄存了，我换台机器接着干」→ handoff_push（覆盖率 + 机器信封）
 *   第二幕  另一个 agent（另一台机器）：「/inbox 接着干」
 *           → list 看到卡 → load 取件（六段完整 / coverage 行 / 信封随卡消费）
 *           → 二次取件报规范错误值（消费即弃）
 *   第三幕  反向同链路：/resume-zcode 拉真实 zcode 会话 → 寄存 → 取件
 *   第四幕  用户会踩的边界：歧义前缀列候选不猜 / 全空段寄存的确定性骨架兜底
 *   第五幕  浏览器面：运行中宿主的 /dsh-takeover/state 收件箱概览可见新卡（不可达则跳过）
 *
 * 纪律：只用真实本机会话存储（opencode opencode.db / zcode db.sqlite）；
 *       收件箱用真实 ~/.handoff/，但只取件本脚本自己推的卡，绝不碰既有待取件。
 *
 * 用法：node scripts/smoke-userflow.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const takeover = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

const root = new Context()
root.plugin(SystemPrompt)
root.plugin(ToolRuntime)
root.plugin(SkillRegistry)
root.plugin(UserQuestions)
root.plugin(takeover)

await root.start?.()
for (let i = 0; i < 40 && (!root.get('tools') || !root.get('skills')); i++) {
  await new Promise((r) => setTimeout(r, 250))
}
const tools = root.get('tools')
if (!tools) throw new Error('tools service missing')

let failed = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failed++
}
const textOf = (res) => (res.content ?? []).map((b) => b.text ?? '').join('\n')
const call = (name, args, id) => tools.execute({
  callId: id ?? `call-${name}-${Math.random().toString(36).slice(2, 8)}`,
  signal: new AbortController().signal, name, arguments: args,
})

/** show 文本的段标题 → handoff_push 协议键名。 */
const SECTION_MAP = [
  ['目标（goal）', 'goal'], ['涉及文件（files）', 'files'], ['做到哪（done）', 'done'],
  ['还差什么（remaining）', 'remaining'], ['停在哪（stopped）', 'stopped'], ['读者警告（warnings）', 'warnings'],
]
const SECTION_HEADS = SECTION_MAP.map(([h]) => h)
/** 卡片/取件文本里的纯中文段标题（cardMarkdown 渲染形态）。 */
const CARD_HEADS = ['## 目标', '## 涉及文件', '## 做到哪', '## 还差什么', '## 停在哪', '## 读者警告']
const HANDOFF = process.env['HANDOFF_HOME'] ?? join(homedir(), '.handoff')

/** 从 show 的模型可见文本里抠骨架六段素材（模型蒸馏的确定性数据源），按协议键返回。 */
function extractSections(showText) {
  const lines = showText.split(/\r?\n/)
  const out = {}
  for (const [head, key] of SECTION_MAP) {
    const start = lines.findIndex((l) => l.includes(head))
    if (start < 0) continue
    const body = []
    for (let i = start + 1; i < lines.length; i++) {
      if (SECTION_HEADS.some((h) => lines[i].includes(h))) break
      body.push(lines[i])
    }
    out[key] = body.join('\n').trim()
  }
  return out
}

/** 用户旅程第一步：/resume-<家> 拉取 + 蒸馏。返回骨架六段（push 的实参）。 */
async function resumeJourney(provider) {
  console.log(`\n── 用户：「/resume-${provider}，拉我上次那个会话」 ──`)
  const list = await call('foreign_session_read', { provider, action: 'list', limit: 5 })
  const listText = textOf(list)
  check(`[${provider}] list 候选不报错`, list.isError !== true, listText.split('\n')[0] ?? '')
  if (list.isError === true) return null
  console.log(listText.split('\n').slice(0, 6).join('\n'))

  console.log(`── agent 调 show（空引用 = latest），拿结构化摘要蒸馏 ──`)
  const show = await call('foreign_session_read', { provider, action: 'show', reference: 'latest' })
  const showText = textOf(show)
  check(`[${provider}] show 结构化摘要不报错`, show.isError !== true)
  check(`[${provider}] 六段骨架素材齐全`, SECTION_HEADS.every((h) => showText.includes(h)))
  check(`[${provider}] 素材带证据账本标注（HISTORY_REPORTED 在场）`, showText.includes('HISTORY_REPORTED'))
  const sections = extractSections(showText)
  const keys = SECTION_MAP.map(([, k]) => k)
  const got = keys.filter((k) => (sections[k] ?? '') !== '')
  check(`[${provider}] 蒸馏数据源非空段 ≥4`, got.length >= 4, `非空段：${got.length}/${keys.length}`)
  return sections
}

/** 用户旅程第二步：寄存（/handoff 收尾），返回 push 结果文本。 */
async function pushJourney(provider, sections) {
  console.log(`── 用户：「好，寄存了，我换台机器接着干」 ──`)
  const t0 = Date.now()
  const push = await call('handoff_push', sections)
  const ms = Date.now() - t0
  const pushText = textOf(push)
  check(`[${provider}] push 返回 ok 且不被通知拖住（<5s，fire-and-forget）`, push.isError !== true && ms < 5000, `${ms}ms`)
  const id = /handoff[:：]?\s*(ho-[A-Za-z0-9_-]+)/.exec(pushText)?.[1] ?? /ho-[A-Za-z0-9_-]+/.exec(pushText)?.[0]
  check(`[${provider}] push 得到卡 id`, Boolean(id), id ?? '')
  check(`[${provider}] push 结果含覆盖率行`, /账本覆盖/.test(pushText), (pushText.match(/账本覆盖[^\n]*/) ?? [''])[0])
  const cov = /(\d+)\/(\d+) 条已标注/.exec(pushText)
  check(`[${provider}] 覆盖率统计真实算过（statements>0）`, Boolean(cov) && Number(cov[2]) > 0, cov ? `${cov[1]}/${cov[2]}` : '未匹配')
  // 六段实参真实流入：卡片不得退化成兜底骨架；骨架 done 段自带 HISTORY_REPORTED 标注，
  // 真蒸馏卡的 marked 必须为正——这是覆盖率特性吃到真实数据的端到端验证。
  check(`[${provider}] 实参六段流入（卡非兜底骨架）`, !/事件流不可用：exec\.agent\.session 为空/.test(pushText))
  check(`[${provider}] 覆盖率 marked ≥1（HISTORY_REPORTED 行被真实标注）`, Boolean(cov) && Number(cov[1]) >= 1, cov ? `marked=${cov[1]}` : '未匹配')
  return { id, pushText }
}

/** 用户旅程第三步：另一个 agent 开局取件（/inbox）。 */
async function inboxJourney(provider, id) {
  console.log(`── 另一个 agent：「/inbox，接着上次的干」 ──`)
  const list = await call('handoff_inbox', { action: 'list' })
  const listText = textOf(list)
  check(`[${provider}] inbox list 不报错且本卡在场`, list.isError !== true && listText.includes(id))
  const load = await call('handoff_inbox', { action: 'load', id })
  const loadText = textOf(load)
  check(`[${provider}] load 取件成功`, load.isError !== true, loadText.split('\n')[0] ?? '')
  check(`[${provider}] 取件文本六段齐全`, CARD_HEADS.every((h) => loadText.includes(h)))
  check(`[${provider}] 取件文本含覆盖率行`, /账本覆盖/.test(loadText))
  check(`[${provider}] 信封随卡消费提示在场`, /机器信封/.test(loadText), (loadText.match(/机器信封[^\n]*/) ?? [''])[0])
  const envGone = !existsSync(join(HANDOFF, 'pending', `${id}.envelope.json`))
  const cardGone = !existsSync(join(HANDOFF, 'pending', `${id}.md`))
  check(`[${provider}] 卡与信封都已移出 pending（消费即弃）`, envGone && cardGone)
  const again = await call('handoff_inbox', { action: 'load', id })
  check(`[${provider}] 二次取件报规范错误值不抛错`, again.isError !== true && textOf(again).includes('收件箱无此待取件'))
}

console.log('======== 第一/二幕：opencode 全链路 ========')
const oc = await resumeJourney('opencode')
let ocId
if (oc) {
  const pushed = await pushJourney('opencode', oc)
  ocId = pushed.id
  // 寄存后、取件前：卡与信封都在盘上且形态正确
  if (ocId) {
    const cardPath = join(HANDOFF, 'pending', `${ocId}.md`)
    check('[opencode] 卡片文件落在 pending/', existsSync(cardPath))
    if (existsSync(cardPath)) {
      const card = readFileSync(cardPath, 'utf8')
      check('[opencode] 卡 frontmatter 带 handoff: 1', /handoff:\s*1/.test(card))
      check('[opencode] 卡正文六段齐全', CARD_HEADS.every((h) => card.includes(h)))
      check('[opencode] 卡正文非兜底骨架（实参六段落卡）', !card.includes('事件流不可用：exec.agent.session 为空'))
    }
    const envPath = join(HANDOFF, 'pending', `${ocId}.envelope.json`)
    check('[opencode] 机器信封落在 pending/', existsSync(envPath))
    if (existsSync(envPath)) {
      const envRaw = readFileSync(envPath, 'utf8')
      const env = JSON.parse(envRaw)
      check('[opencode] 信封形态正确（handoff:1 + kind:envelope + id 对上）', env['handoff'] === 1 && env['kind'] === 'envelope' && env['id'] === ocId)
      check('[opencode] 信封体量受控（<2000 chars，目标 ≤1200）', envRaw.length < 2000, `${envRaw.length} chars`)
    }
    await inboxJourney('opencode', ocId)
  }
}

console.log('\n======== 第三幕：zcode 反向全链路 ========')
const zc = await resumeJourney('zcode')
let zcId
if (zc) {
  zcId = (await pushJourney('zcode', zc)).id
  if (zcId) await inboxJourney('zcode', zcId)
}

console.log('\n======== 第四幕：用户会踩的边界 ========')
console.log('── 用户：「resume-opencode 1234」（随手敲个不存在的引用） ──')
const miss = await call('foreign_session_read', { provider: 'opencode', action: 'show', reference: 'sess_00000000-不存在' })
check('找不到 → ok:false 规范错误值不抛错', miss.isError !== true && /ok:\s*false|找不到|未发现/.test(textOf(miss)))

console.log('── 用户：什么都没说直接 push（无会话环境）→ 空壳卡守门拦截，确认后才落盘 ──')
const gatedBare = await call('handoff_push', {})
check('裸 push 被守门拦截（理由回喂带 confirmSkeleton）', textOf(gatedBare).includes('空壳卡守门') && textOf(gatedBare).includes('confirmSkeleton'))
const bare = await call('handoff_push', { confirmSkeleton: true })
check('确认后空壳 push 是 ok 值且有 id/path', bare.isError !== true && /ho-[A-Za-z0-9_-]+/.test(textOf(bare)))
const bareId = /ho-[A-Za-z0-9_-]+/.exec(textOf(bare))?.[0]
if (bareId) {
  // 兜底卡也要能被正常取走，不留僵尸卡
  const del = await call('handoff_inbox', { action: 'load', id: bareId })
  check('兜底卡可正常取件（不产生僵尸卡）', del.isError !== true, textOf(del).split('\n')[0] ?? '')
}

console.log('\n======== 第五幕：浏览器面（运行中宿主的设置卡数据源） ========')
try {
  const res = await fetch('http://127.0.0.1:3080/dsh-takeover/state', { signal: AbortSignal.timeout(4000) })
  const state = await res.json()
  check('宿主 state API 可达且自报 home', res.ok && typeof state['home'] === 'string' && state['home'] !== '', state['home'])
  const sameHome = String(state['home']).replaceAll('\\', '/').toLowerCase() === HANDOFF.replaceAll('\\', '/').toLowerCase()
  if (sameHome) {
    const ids = (state['pending'] ?? []).map((p) => p['id'])
    check('寄存的新卡在设置卡收件箱概览可见', ids.some((x) => [ocId, zcId].includes(x)), `pending=${ids.length}`)
    check('archived 计数已含本轮取件（≥3）', Number(state['archivedCount'] ?? 0) >= 3, `archivedCount=${state['archivedCount']}`)
  } else {
    console.log(`⏭ 运行中宿主是隔离屋（${state['home']}），与旅程屋（${HANDOFF}）不同——分屋是设计行为，跳过可见性断言`)
  }
} catch (e) {
  console.log(`⏭ 宿主 3080 不可达（${e.message}），跳过浏览器面——非阻塞项`)
}

console.log(`\n${failed === 0 ? '🎉 真用户旅程全部通过' : `💥 ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
