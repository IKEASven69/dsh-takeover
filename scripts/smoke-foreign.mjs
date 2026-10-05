#!/usr/bin/env node
/**
 * v0.2 实机冒烟（不开 dsh web）：用真实 cordis + dsh-tools + dsh-skill 服务
 * 进程内挂载本仓构建产物 lib/index.js，通过真实工具注册表 dispatch
 * foreign_session_read（list + show zcode sess_323039e9 前缀），并验证
 * /resume-* 八条 skill 注册形态。不 mock 任何宿主 API。
 *
 * 用法：node scripts/smoke-foreign.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const takeover = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

const root = new Context()
root.plugin(SystemPrompt)
root.plugin(ToolRuntime)
root.plugin(SkillRegistry)
root.plugin(UserQuestions)
root.plugin(takeover)

// cordis 服务挂载是异步的：等 inject 链全部就绪
await root.start?.()
for (let i = 0; i < 40 && (!root.get('tools') || !root.get('skills')); i++) {
  await new Promise((r) => setTimeout(r, 250))
}

const tools = root.get('tools')
const skills = root.get('skills')
if (!tools) throw new Error('tools service missing')
if (!skills) throw new Error('skills service missing')

let failed = 0
const check = (label, cond) => {
  console.log(`${cond ? '✅' : '❌'} ${label}`)
  if (!cond) failed++
}

console.log('== 1. 工具注册表 ==')
const names = tools.schemas().map((s) => s.name)
console.log('registered tools:', names)
check('foreign_session_read 已注册', names.includes('foreign_session_read'))
check('handoff_push / handoff_inbox 仍在', names.includes('handoff_push') && names.includes('handoff_inbox'))

console.log('\n== 2. skill 注册表 ==')
const skillList = await skills.list({ cwd: process.cwd() })
const ours = skillList.filter((s) => s.provider === 'dsh-takeover')
for (const s of ours) console.log(`- ${s.name} (user=${s.invocation.userInvocable}, model=${s.invocation.modelInvocable})`)
check('10 条 bundled skill（handoff+inbox+八家 resume）', ours.length === 10)
const resumeNames = ['resume-claude', 'resume-codex', 'resume-opencode', 'resume-zcode', 'resume-pi', 'resume-workbuddy', 'resume-cursor', 'resume-grok']
check('/resume-* 八条齐全', resumeNames.every((n) => ours.some((s) => s.name === n)))
check('全部 userInvocable 且非 modelInvocable', ours.every((s) => s.invocation.userInvocable === true && s.invocation.modelInvocable === false))

console.log('\n== 3. 真实 dispatch：foreign_session_read list zcode ==')
const list = await tools.execute({
  callId: 'call-list-1', signal: new AbortController().signal,
  name: 'foreign_session_read',
  arguments: { provider: 'zcode', action: 'list', limit: 5 },
})
check('list 不报错', list.isError !== true)
const listText = (list.content ?? []).map((b) => b.text ?? '').join('\n')
console.log(listText.slice(0, 600))

console.log('\n== 4. 真实 dispatch：foreign_session_read show zcode sess_323039e9（前缀引用）==')
const show = await tools.execute({
  callId: 'call-show-1', signal: new AbortController().signal,
  name: 'foreign_session_read',
  arguments: { provider: 'zcode', action: 'show', reference: 'sess_323039e9' },
})
check('show 不报错', show.isError !== true)
const showText = (show.content ?? []).map((b) => b.text ?? '').join('\n')
console.log(showText.slice(0, 1200))
check('返回结构化摘要（含轮数/首条用户消息）',
  showText.includes('结构化摘要') && showText.includes('首条用户消息'))
check('模型可见文本含骨架六段素材全文（六段标题齐全）',
  ['目标（goal）', '涉及文件（files）', '做到哪（done）', '还差什么（remaining）', '停在哪（stopped）', '读者警告（warnings）']
    .every((h) => showText.includes(h)))
check('骨架素材非空内容真的在场（不是一句“已返回”提示）',
  showText.includes('HISTORY_REPORTED') && showText.includes('首条用户请求：'))

console.log('\n== 4b. 真实 dispatch：show 带 limit 分页，原文 turns 进模型可见文本 ==')
const showTurns = await tools.execute({
  callId: 'call-show-2', signal: new AbortController().signal,
  name: 'foreign_session_read',
  arguments: { provider: 'zcode', action: 'show', reference: 'sess_323039e9', limit: 5, offset: 0 },
})
check('show+limit 不报错', showTurns.isError !== true)
const showTurnsText = (showTurns.content ?? []).map((b) => b.text ?? '').join('\n')
console.log(showTurnsText.slice(0, 800))
check('模型可见文本含原文分页（#0 序号头 + 轮次原文）',
  /原文分页：本页 \d+ 轮（offset=0/.test(showTurnsText) && showTurnsText.includes('#0 ['))

console.log('\n== 5. 真实 dispatch：歧义/找不到的规范错误值 ==')
const miss = await tools.execute({
  callId: 'call-miss-1', signal: new AbortController().signal,
  name: 'foreign_session_read',
  arguments: { provider: 'zcode', action: 'show', reference: 'sess_00000000-不存在的会话' },
})
check('找不到时 ok:false 不抛错', miss.isError !== true)
console.log((miss.content ?? []).map((b) => b.text ?? '').join('\n').slice(0, 300))

console.log(`\n${failed === 0 ? '🎉 冒烟全部通过' : `💥 ${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
