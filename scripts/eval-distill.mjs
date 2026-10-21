#!/usr/bin/env node
/**
 * ② 质量层 · 蒸馏保真度评测：六段卡相对真实转录的信息保真度（确定性，无 LLM 评判）。
 *
 * 三个指标（真相源 = 原始转录的独立解析路径，与蒸馏器实现不同源，避免循环论证）：
 * - 文件召回率：转录里真实触及的文件（tool_use 的 file_path/path/command 独立提取）
 *   有多少出现在卡的涉及文件段（top15 上限内）；
 * - 请求捕获：最后一条真实用户请求的前缀是否进了卡（goal/lastUserMessage）；
 * - 主文件在卡：转录中出现频次最高的文件是否在卡的文件清单里。
 *
 * 隐私纪律：只在本地读真实转录，输出仅聚合计数（n/均值），明细不落盘。
 * 用法：npx tsx scripts/eval-distill.mjs [--source <~/.claude/projects>] [--limit 20]
 * @module dsh-takeover/eval-distill
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { summarizeTurns } from '../src/foreign.ts'

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const source = arg('source', join(homedir(), '.claude', 'projects'))
const limit = Number(arg('limit', '20'))

// ---------- 独立真相提取（不复用 readers 的实现路径） ----------

/** 独立解析 claude jsonl：用户真实请求 + 触及文件（独立键序遍历，供交叉验证）。
 * shell 回声（<local-command-*>）与 summarizeTurns 同口径排除——独立的是文件
 * 提取路径，不是「把命令噪音当请求」这个判断。 */
export function groundTruthOf(rawText) {
  const userRequests = []
  const fileHits = new Map()
  for (const raw of rawText.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'user' && e.type !== 'assistant') continue
    const content = e.message?.content
    if (e.type === 'user') {
      // 真实用户请求：字符串正文（tool_result 数组不是用户请求；命令回声家族
      // <local-command-* / <command-name> / <command-message> 与蒸馏器同口径排除）
      if (typeof content === 'string' && content.trim() !== '' && !/^<(local-command|command-name|command-message)/.test(content.trim())) userRequests.push(content.trim())
      continue
    }
    if (!Array.isArray(content)) continue
    for (const b of content) {
      if (b?.type !== 'tool_use' || typeof b.input !== 'object' || b.input === null) continue
      for (const key of ['file_path', 'path', 'filePath', 'notebook_path']) {
        const v = b.input[key]
        if (typeof v === 'string' && v.trim() !== '') fileHits.set(v, (fileHits.get(v) ?? 0) + 1)
      }
      const cmd = b.input.command
      if (typeof cmd === 'string') {
        // 命令里显式写出的文件路径也算触及（独立于 readers 的正则）
        for (const m of cmd.matchAll(/(?:[\w.@+-]+\/)*[\w.@+-]+\.(?:ts|tsx|js|mjs|json|md|css|html|py)\b/g)) {
          fileHits.set(m[0], (fileHits.get(m[0]) ?? 0) + 1)
        }
      }
    }
  }
  return { userRequests, fileHits }
}

const norm = (p) => p.replace(/\\/g, '/')
const base = (p) => basename(norm(p))

/** 保真度评分（导出供单测）：truth（独立真相）× card（summarizeTurns 产物） */
export function fidelity(truth, card) {
  const cardFiles = new Set(card.files.map(norm))
  const cardBases = new Set(card.files.map(base))
  const truthFiles = [...truth.fileHits.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
  const truthTop = truthFiles.slice(0, 15)
  const hits = truthTop.filter((f) => cardFiles.has(norm(f)) || cardBases.has(base(f))).length
  const fileRecall = truthTop.length > 0 ? hits / truthTop.length : null
  const lastReq = truth.userRequests.at(-1) ?? ''
  const reqPrefix = lastReq.slice(0, 40)
  // 无真实请求的转录（纯命令回声/空会话）不可评——null，不得冒充 false 给蒸馏器抹黑
  const requestCaptured = reqPrefix === '' ? null : (card.goal.includes(reqPrefix) || (card.lastUserMessage ?? '').includes(reqPrefix))
  const topInCard = truthFiles.length === 0 ? null : (cardFiles.has(norm(truthFiles[0])) || cardBases.has(base(truthFiles[0])))
  return {
    filesTruth: truthTop.length,
    filesHit: hits,
    fileRecall,
    requestCaptured,
    topFileInCard: topInCard,
    userRequests: truth.userRequests.length,
  }
}

// ---------- 主流程（仅直接执行时运行；被单测 import 只取导出的纯函数） ----------
function walkJsonl(dir, depth = 0) {
  const out = []
  if (depth > 4) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJsonl(p, depth + 1))
    else if (e.isFile() && e.name.endsWith('.jsonl') && statSync(p).size > 500) out.push(p)
  }
  return out
}

const isMain = basename(process.argv[1] ?? '') === 'eval-distill.mjs'
if (isMain) {
  const files = walkJsonl(source).slice(0, limit)
  const scores = []
for (const f of files) {
  try {
    const raw = readFileSync(f, 'utf-8')
    const truth = groundTruthOf(raw)
    // 卡侧：与生产同一蒸馏器（readers parse + summarizeTurns）
    const entries = raw.split('\n').filter((l) => l.trim() !== '').flatMap((l) => {
      try { return [JSON.parse(l)] } catch { return [] }
    })
    const turns = entries.flatMap((e) => {
      const out = []
      // entryToTurns 语义的等价最小重建（user 字符串/块、assistant 三种 block）
      if (e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.trim()) {
        out.push({ role: 'user', text: e.message.content, cwd: e.cwd ?? '', ts: e.timestamp ?? '', toolName: '', toolFailed: false, model: '' })
      } else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
        for (const b of e.message.content) {
          if (b.type === 'text' && b.text?.trim()) out.push({ role: 'assistant', text: b.text, cwd: e.cwd ?? '', ts: e.timestamp ?? '', toolName: '', toolFailed: false, model: e.message.model ?? '' })
          else if (b.type === 'tool_use') out.push({ role: 'assistant', text: `${b.name}: ${JSON.stringify(b.input ?? {}).slice(0, 80)}`, cwd: e.cwd ?? '', ts: e.timestamp ?? '', toolName: b.name ?? '', toolFailed: false, model: e.message.model ?? '' })
        }
      }
      return out
    })
    const ref = { id: f, title: basename(f, '.jsonl'), cwd: '', updatedAt: statSync(f).mtimeMs, fingerprint: '', kind: 'file' }
    const { summary, skeleton } = summarizeTurns(ref, turns)
    const card = {
      files: summary.files,
      goal: skeleton.goal,
      lastUserMessage: summary.lastUserMessage,
    }
    scores.push(fidelity(truth, card))
  } catch { /* 单文件失败不计入（诚实：总数随附） */ }
}
  const withRecall = scores.filter((s) => s.fileRecall !== null)
  const withReq = scores.filter((s) => s.requestCaptured !== null)
  const avg = (xs) => xs.length > 0 ? Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)) : null
  const report = {
    transcripts: files.length,
    scored: scores.length,
    // 语料里没有工具调用的转录不参与文件召回（null 不冒充 0 分）
    avgFileRecall: avg(withRecall.map((s) => s.fileRecall)),
    avgFilesTruth: avg(withRecall.map((s) => s.filesTruth)),
    transcriptsEvaluableForFiles: withRecall.length,
    // 语料里没有真实用户请求的转录不参与请求捕获
    requestCaptureRate: withReq.length > 0 ? Number((withReq.filter((s) => s.requestCaptured).length / withReq.length).toFixed(3)) : null,
    transcriptsEvaluableForRequests: withReq.length,
    topFileInCardRate: avg(scores.filter((s) => s.topFileInCard !== null).map((s) => (s.topFileInCard ? 1 : 0))),
    generatedBy: 'scripts/eval-distill.mjs',
  }
  console.log(JSON.stringify(report, null, 2))
}
