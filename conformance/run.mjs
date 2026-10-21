#!/usr/bin/env node
/**
 * handoff: 1 协议符合性套件（conformance suite）——独立于任何实现，零依赖。
 *
 * 被测实现以「适配器」接入：一个 .mjs 文件导出
 *   {
 *     name: string,
 *     home(): string,                          // 当前生效的 ~/.handoff 根
 *     writeCard(text?: string): { id: string },// 写一张合法卡（缺省用内置向量），返回 id
 *     listPending(): string[],                 // pending 里的 id 清单
 *     load(id): { text: string },              // 消费即弃取件；失败必须 throw
 *     writeRaw(filename, text): void,          // 把任意文本放进 pending/（边界向量用）
 *   }
 * 适配器文件在 HANDOFF_HOME 已设置之后才被 import（模块加载时读 env 的实现也能测）。
 *
 * 用法：HANDOFF_HOME=<temp> node conformance/run.mjs --adapter <path.mjs> [--json <out>]
 * 结果：MUST 全过 → exit 0（符合）；任一 MUST 红 → exit 1；SHOULD 红只记 notes。
 * @module handoff-conformance
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const adapterPath = resolve(arg('adapter', ''))
const jsonOut = arg('json', '')

if (!existsSync(adapterPath)) {
  console.error(`适配器不存在：${adapterPath}`)
  process.exit(2)
}

const HOME = mkdtemp()
function mkdtemp() {
  const dir = join(process.env.TEMP ?? '/tmp', `handoff-conf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
process.env['HANDOFF_HOME'] = HOME

const VECTOR_CARD = readFileSync(join(import.meta.dirname ?? '.', 'vectors', 'valid-card.md'), 'utf-8')

const results = []
let current = null
function check(level, id, title, fn) {
  current = { level, id, title, status: 'pass', detail: '' }
  try {
    fn()
  } catch (e) {
    current.status = 'fail'
    current.detail = String(e instanceof Error ? e.message : e).slice(0, 300)
  }
  results.push(current)
  const mark = current.status === 'pass' ? '✔' : (level === 'MUST' ? '✖' : '▽')
  console.log(`${mark} [${level}] ${id} ${title}${current.detail !== '' ? ` — ${current.detail}` : ''}`)
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

// 适配器在 env 设置后加载
const adapter = (await import(`file:///${adapterPath.replace(/\\/g, '/')}`)).default ?? (await import(`file:///${adapterPath.replace(/\\/g, '/')}`))
if (adapter === null || typeof adapter !== 'object') {
  console.error('适配器必须 default 导出对象')
  process.exit(2)
}

// ---------- C1 目录与环境 ----------
check('MUST', 'C1', 'HANDOFF_HOME 环境变量覆盖目录根（SPEC 一、）', () => {
  const h = String(adapter.home())
  assert(resolve(h) === resolve(HOME), `home()=${h} 应等于 ${HOME}`)
  assert(existsSync(join(HOME, 'pending')) || typeof adapter.listPending === 'function', 'pending 目录语义应在')
})

// ---------- C2/C3 写入与 id 形态 ----------
check('MUST', 'C2', '写入即投递：合法卡落 pending 后可列出（SPEC 一、）', () => {
  const { id } = adapter.writeCard()
  assert(adapter.listPending().includes(id), `写入的 ${id} 应出现在 listPending`)
})

check('MUST', 'C3', '文件名即卡片 id：ho-<36进制时间戳>-<随机4位> 形态且 frontmatter id 与文件名一致', () => {
  const { id } = adapter.writeCard()
  assert(/^ho-[0-9a-z]{7,}-[0-9a-z]{4}$/.test(id), `id 形态不合 SPEC：${id}`)
  const text = readFileSync(join(HOME, 'pending', `${id}.md`), 'utf-8')
  const m = /^id:\s*(\S+)/m.exec(text)
  assert(m !== null && m[1] === id, 'frontmatter id 必须与文件名一致')
})

// ---------- C4 卡片格式 ----------
check('MUST', 'C4', '六段必选标题按序在场（SPEC 二、）', () => {
  const text = VECTOR_CARD
  const heads = ['## 目标', '## 涉及文件', '## 做到哪', '## 还差什么', '## 停在哪', '## 读者警告']
  let last = -1
  for (const h of heads) {
    const i = text.indexOf(h)
    assert(i > last, `缺段或乱序：${h}`)
    last = i
  }
  const fm = text.split('---')[1] ?? ''
  for (const key of ['handoff: 1', 'id:', 'from:', 'agent:', 'session:']) assert(fm.includes(key), `frontmatter 缺 ${key}`)
})

// ---------- C5/C6 宽松与未知字段（SPEC 四、版本纪律） ----------
check('MUST', 'C5', '缺字段 frontmatter：给默认值不报错', () => {
  const id = 'ho-confm-m001'
  adapter.writeRaw(`${id}.md`, '---\nhandoff: 1\nid: ' + id + '\nfrom:\n  agent: test\n---\n\n## 目标\n\nx\n')
  const { text } = adapter.load(id)
  assert(typeof text === 'string' && text.length > 0)
})

check('MUST', 'C6', '未知字段保留不报错；更高 handoff 版本容错不硬失败', () => {
  const id = 'ho-connk-m002'
  adapter.writeRaw(`${id}.md`, '---\nhandoff: 2\nid: ' + id + '\nfrom:\n  agent: test\nfuture_field: {"x": 1}\n---\n\n## 目标\n\nx\n')
  const { text } = adapter.load(id)
  assert(typeof text === 'string')
})

// ---------- C7 消费即弃（SPEC 三、语义 3） ----------
check('MUST', 'C7', '消费即弃：load 后进 archived、离开 pending；二次取件必报错', () => {
  const { id } = adapter.writeCard()
  const { text } = adapter.load(id)
  assert(typeof text === 'string' && text.length > 0, 'load 应返回卡文本')
  assert(!adapter.listPending().includes(id), '消费后应离开 pending')
  assert(existsSync(join(HOME, 'archived', `${id}.md`)), '消费后应在 archived')
  let threw = false
  try { adapter.load(id) } catch { threw = true }
  assert(threw, '二次取件必须报错')
})

// ---------- C8 宽松模式（SPEC 三、语义 3） ----------
check('MUST', 'C8', '宽松模式：无 frontmatter 纯 Markdown 也能取（id 从文件名）', () => {
  const id = 'ho-cleni-m003'
  adapter.writeRaw(`${id}.md`, '## 目标\n\n无 frontmatter 的临时卡\n\n## 涉及文件\n\n## 做到哪\n\n## 还差什么\n\n## 停在哪\n\n## 读者警告\n')
  assert(adapter.listPending().includes(id), '宽松卡应可列出')
  const { text } = adapter.load(id)
  assert(typeof text === 'string')
})

// ---------- C9 路径安全 ----------
check('MUST', 'C9', '路径穿越 id：取件必须拒绝，不触碰 pending 外文件', () => {
  let threw = false
  try { adapter.load('../victim') } catch { threw = true }
  assert(threw, '穿越 id 必须报错')
  assert(!existsSync(join(HOME, 'victim.md')), '不得把文件搬到根')
})

// ---------- C10 滚动归档（SHOULD，SPEC 一、） ----------
check('SHOULD', 'C10', 'archived 滚动保留 50 份（执行归档方删最旧）', () => {
  const ids = []
  for (let i = 0; i < 52; i++) ids.push(adapter.writeCard().id)
  for (const id of ids) adapter.load(id)
  const archived = readdirSync(join(HOME, 'archived')).filter((f) => f.endsWith('.md'))
  assert(archived.length <= 50, `archived ${archived.length} 份超出滚动上限`)
})

// ---------- C11 并发单胜（SHOULD——SPEC 未明示，消费即弃的推论） ----------
check('SHOULD', 'C11', '并发取件单胜者：两线程同时 load 同一 id，恰好一胜（实现如未支持会在 detail 注明）', async () => {
  const { Worker } = await import('node:worker_threads')
  const { id } = adapter.writeCard()
  const coreUrl = 'file:///' + adapterPath.replace(/\\/g, '/')
  const src = `
    const { parentPort, workerData } = require('node:worker_threads')
    import(workerData.adapterUrl).then((m) => {
      const a = m.default
      try { a.load(workerData.id); parentPort.postMessage('WIN') } catch { parentPort.postMessage('LOSE') }
    })
  `
  const workers = [1, 2].map(() => new Worker(src, { eval: true, workerData: { adapterUrl: coreUrl, id } }))
  await new Promise((r) => setTimeout(r, 600))
  const results = await Promise.all(workers.map((w) => new Promise((resolve, reject) => { w.on('message', resolve); w.on('error', reject) })))
  const wins = results.filter((r) => r === 'WIN').length
  assert(wins === 1, `并发取件应恰好一胜，实得 ${JSON.stringify(results)}`)
})

// ---------- 汇总 ----------
const musts = results.filter((r) => r.level === 'MUST')
const mustFails = musts.filter((r) => r.status === 'fail')
const shouldFails = results.filter((r) => r.level === 'SHOULD' && r.status === 'fail')
const report = {
  adapter: adapter.name ?? basename(adapterPath),
  adapterPath,
  results,
  mustTotal: musts.length,
  mustFailed: mustFails.length,
  shouldFailed: shouldFails.length,
  conformant: mustFails.length === 0,
}
if (jsonOut !== '') writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
console.log(`\n符合性结论：${report.conformant ? '✅ 符合 handoff: 1（MUST ' + musts.length + '/' + musts.length + '）' : '❌ 不符合（MUST 失败 ' + mustFails.length + '/' + musts.length + '）'}；SHOULD 未达 ${shouldFails.length}`)
rmSync(HOME, { recursive: true, force: true })
process.exit(report.conformant ? 0 : 1)
