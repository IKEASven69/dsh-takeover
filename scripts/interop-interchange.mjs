#!/usr/bin/env node
/**
 * ⑤ 互通层 · INTERCHANGE v1（dsh-chat-import）↔ handoff: 1 双向转换。
 *
 * 两个生态各自有格式：dsh-chat-import 的 INTERCHANGE v1（turns IR + .dshbundle.json
 * 双层 sha256 指纹）与 handoff: 1（六段卡 + 收件箱）。本转换器让两边互通：
 * - bundle → 卡：他们的导出物蒸馏成 handoff: 1 卡进收件箱，任何实现可取件；
 * - 卡 → bundle 侧的 interchange 文档：我们的卡转成他们可导入的 turns IR 文档。
 *
 * 蒸馏是确定性的（无 LLM）：prompt 首/尾→目标，tool-call 参数里的路径→涉及文件，
 * 尾部 assistant 文本→做到哪/停在哪；全部陈述标 HISTORY_REPORTED。
 * 用法：
 *   node scripts/interop-interchange.mjs --from-bundle <file.dshbundle.json> [--pending <dir>]
 *   node scripts/interop-interchange.mjs --from-card <card.md> [--out <doc.json>]
 * @module dsh-takeover/interop-interchange
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}

// ---------- bundle 校验（按其规范：先文件级指纹，再会话级指纹） ----------

/** 验 .dshbundle.json 双层指纹；返回 { ok, bundle, reason } */
export function verifyBundle(raw) {
  let doc
  try { doc = JSON.parse(raw) } catch (e) { return { ok: false, reason: `JSON 解析失败：${e.message}` } }
  if (doc?.bundle !== 'dsh-chat-import' || doc?.format !== 'interchange-v1') {
    return { ok: false, reason: '标记不符（bundle/format）' }
  }
  const { sha256, ...rest } = doc
  if (typeof sha256?.session !== 'string' || typeof sha256?.bundle !== 'string') {
    return { ok: false, reason: '缺双层指纹（sha256.session / sha256.bundle）' }
  }
  const sessionOk = createHash('sha256').update(doc.log ?? '', 'utf-8').digest('hex') === sha256.session
  const canonical = JSON.stringify(rest)
  const bundleOk = createHash('sha256').update(canonical, 'utf-8').digest('hex') === sha256.bundle
  return { ok: sessionOk && bundleOk, sessionOk, bundleOk, doc, reason: sessionOk && bundleOk ? '' : `指纹不符（session=${sessionOk} bundle=${bundleOk}）` }
}

// ---------- turns IR → 六段素材（确定性蒸馏） ----------

/** 从 turns IR 抽：首/尾 prompt、工具调用路径、尾部 assistant 文本 */
export function distillTurns(turns) {
  const prompts = turns.map((t) => String(t.prompt ?? '').trim()).filter((s) => s !== '')
  const files = new Map()
  const assistantTails = []
  for (const turn of turns) {
    for (const step of turn.steps ?? []) {
      for (const tc of step.toolCalls ?? []) {
        try {
          const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : (tc.arguments ?? {})
          for (const key of ['file_path', 'path', 'filePath', 'notebook_path']) {
            const v = args[key]
            if (typeof v === 'string' && v.trim() !== '') files.set(v, (files.get(v) ?? 0) + 1)
          }
        } catch { /* 坏参数串跳过 */ }
      }
      for (const c of step.content ?? []) {
        if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim() !== '') assistantTails.push(c.text.trim())
      }
    }
  }
  const first = prompts[0] ?? ''
  const last = prompts.at(-1) ?? ''
  const goal = [
    first !== '' ? `首条用户请求：${first.slice(0, 200)}` : '',
    last !== '' && last !== first ? `最后一条用户请求：${last.slice(0, 200)}` : '',
  ].filter(Boolean).join('\n') || '（bundle 无用户请求）'
  const tail = assistantTails.at(-1) ?? ''
  return {
    title: '',
    goal,
    files: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f]) => f),
    done: tail !== '' ? `- HISTORY_REPORTED 尾部进展：${tail.replace(/\s+/g, ' ').slice(0, 300)}` : '-（bundle 无 assistant 文本轮）',
    turnCount: turns.length,
    prompts: prompts.length,
  }
}

/** bundle 文档 → handoff: 1 卡 markdown（frontmatter + 六段） */
export function bundleToCardMarkdown(doc) {
  const d = distillTurns(doc.turns ?? [])
  const title = String(doc.title ?? d.title ?? doc.meta?.id ?? 'interchange 导入').slice(0, 60)
  const id = `ho-${Date.now().toString(36).slice(-7)}-${Math.random().toString(36).slice(2, 6)}`
  const cwd = typeof doc.meta?.cwd === 'string' ? doc.meta.cwd : ''
  const stamp = new Date().toISOString()
  return [
    '---',
    'handoff: 1',
    `id: ${id}`,
    'from:',
    '  agent: dsh-chat-import',
    `  session: ${JSON.stringify(doc.meta?.id ?? doc.sourceSessionId ?? '')}`,
    `  title: ${JSON.stringify(title)}`,
    'to: any',
    'project: interchange',
    `cwd: ${JSON.stringify(cwd)}`,
    `pushed_at: ${JSON.stringify(stamp)}`,
    'git:',
    '  branch: ""',
    '  changed: []',
    'tasks: []',
    '---',
    '',
    '## 目标（goal）',
    '',
    d.goal,
    '',
    '## 涉及文件（files）',
    '',
    d.files.length > 0 ? d.files.map((f) => `- ${f}`).join('\n') : '-（bundle 无工具调用路径）',
    '',
    '## 做到哪（done）',
    '',
    d.done,
    '',
    '## 还差什么（remaining）',
    '',
    `- 取件方按卡继续（源自 INTERCHANGE v1：${doc.turns?.length ?? 0} 轮 / ${d.prompts} 条用户请求）。`,
    '',
    '## 停在哪（stopped）',
    '',
    `停在源会话末轮（HISTORY_REPORTED）。最安全的第一步：核对 ${cwd !== '' ? cwd : '工作区'} 的 git 状态。`,
    '',
    '## 读者警告（warnings）',
    '',
    '- HISTORY_REPORTED 本卡由 dsh-chat-import 的 INTERCHANGE v1 bundle 确定性蒸馏，全部为推送时刻的历史快照。',
    '',
  ].join('\n')
}

// ---------- 卡 → interchange v1 文档（他们可导入的形态） ----------

/** handoff: 1 卡文本 → INTERCHANGE v1 文档（turns IR；一份卡 = 一轮） */
export function cardToInterchange(cardText) {
  const section = (names) => {
    const lines = cardText.split('\n')
    let inSec = false
    const out = []
    for (const line of lines) {
      if (line.startsWith('## ')) { inSec = names.some((n) => line.includes(n)); continue }
      if (inSec) out.push(line)
    }
    return out.join('\n').trim()
  }
  const fm = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*"?([^"\\n]*)"?,?\\s*$`, 'm').exec(cardText)
    return m?.[1]?.trim() ?? ''
  }
  const goal = section(['目标'])
  const done = section(['做到哪'])
  const remaining = section(['还差什么'])
  const promptParts = [goal, remaining !== '' ? `还差什么：\n${remaining}` : ''].filter(Boolean)
  const prompt = promptParts.join('\n\n')
  return {
    interchange: 'dsh-chat-import',
    version: 1,
    meta: {
      id: `import-${fm('id') || 'handoff-card'}`,
      createdAt: Date.now(),
      ...(fm('cwd') !== '' ? { cwd: fm('cwd') } : {}),
    },
    title: fm('title') || 'handoff card',
    provider: 'handoff-1',
    turns: [
      {
        prompt,
        steps: [
          {
            content: [
              { type: 'text', text: `## 做到哪\n\n${done}` },
            ],
            toolCalls: [],
            toolResults: [],
          },
        ],
      },
    ],
  }
}

// ---------- 主流程（仅直接执行时运行；被单测 import 只取导出的纯函数） ----------
const isMain = basename(process.argv[1] ?? '') === 'interop-interchange.mjs'
if (isMain) {
  const fromBundle = arg('from-bundle', '')
  const fromCard = arg('from-card', '')
  const pending = arg('pending', '')
  const out = arg('out', '')

  if (fromBundle !== '') {
    const raw = readFileSync(fromBundle, 'utf-8')
    const v = verifyBundle(raw)
    if (!v.ok) {
      console.error(`bundle 校验失败：${v.reason}`)
      process.exit(1)
    }
    const md = bundleToCardMarkdown(v.doc)
    if (pending !== '') {
      mkdirSync(pending, { recursive: true })
      const id = /^id:\s*(\S+)/m.exec(md)?.[1] ?? 'ho-import-0001'
      writeFileSync(join(pending, `${id}.md`), md, 'utf-8')
      console.log(`已入收件箱：${join(pending, `${id}.md`)}`)
    } else {
      console.log(md)
    }
  } else if (fromCard !== '') {
    const doc = cardToInterchange(readFileSync(fromCard, 'utf-8'))
    const json = JSON.stringify(doc, null, 2)
    if (out !== '') {
      writeFileSync(out, `${json}\n`, 'utf-8')
      console.log(`已写：${out}`)
    } else {
      console.log(json)
    }
  } else {
    console.error('用法：--from-bundle <bundle.json> [--pending <dir>] 或 --from-card <card.md> [--out <doc.json>]')
    process.exit(2)
  }
}
