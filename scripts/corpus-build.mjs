#!/usr/bin/env node
/**
 * 语料管线（① 解析层）：真实会话文件 → 结构克隆脱敏 fixtures。
 *
 * 隐私纪律（硬约束）：入库的 fixtures 只含「形状」，不含「内容」——
 * - JSON 行：键名/嵌套/数组结构/数值类型原样保留，所有字符串值替换成
 *   由 (键路径, 原长) 决定的确定性合成串；cwd 一律 /corpus/proj*；时间戳归一。
 * - 非 JSON 行（损坏行）：损坏是形状！替换成确定性假损坏行（同属不可解析），
 *   不保留原文任何字节。
 * - 超长文件在 200KB 处截断（顺带制造 casr #10 式截断场景）。
 * - 单文件结构直方图与源文件 SHA256 进 manifest.json（可溯源、不可还原）。
 *
 * 用法：node scripts/corpus-build.mjs [--source-claude <dir>] [--source-zcode <db>]
 * 缺省读本机真实路径；CI 不跑本脚本（fixtures 已入库）。
 * @module dsh-takeover/corpus-build
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dirname ?? '.', '..')
const OUT = join(ROOT, 'tests', 'fixtures', 'corpus')
const FILE_BYTES_CAP = 200 * 1024

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt
}
const sourceClaude = arg('source-claude', join(homedir(), '.claude', 'projects'))
const sourceZcode = arg('source-zcode', join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'))

/** 字符串值的确定性合成：由键路径尾段与原长决定，无任何原文信息 */
let synthSeq = 0
function synthString(keyTail, original) {
  synthSeq += 1
  const len = original.length
  const head = `${keyTail}#${len}#${synthSeq % 97}`
  return head.length >= len ? head.slice(0, len) : head + 'x'.repeat(len - head.length)
}

/** cwd/时间戳等结构语义值的特判合成。
 * 语义判别键（type/role）的合法值必须原样保留——它们决定 entryToTurns 能否
 * 识别条目，合成掉会让语料变成「全是 0 轮的空会话」（golden 揭示的首个自伤）。 */
const SEMANTIC_VALUES = new Set([
  'user', 'assistant', 'tool', 'text', 'thinking', 'tool_use', 'tool_result',
  'summary', 'system', 'progress', 'result', 'image', 'document',
])
function synthValue(keyTail, v) {
  if ((keyTail === 'type' || keyTail === 'role') && typeof v === 'string' && SEMANTIC_VALUES.has(v)) return v
  if (keyTail === 'cwd') return `/corpus/proj${synthSeq % 8}`
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v)) return `2026-01-01T00:00:${String(synthSeq % 60).padStart(2, '0')}.000Z`
  if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(v)) return `00000000-0000-4000-8000-${String(synthSeq).padStart(12, '0')}`
  return synthString(keyTail, v)
}

/** 递归克隆 JSON 值：字符串全合成，键名/结构/数值原样 */
function scrub(value, keyTail = '') {
  if (typeof value === 'string') return synthValue(keyTail, value)
  if (Array.isArray(value)) return value.map((x) => scrub(x, keyTail))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k)
    return out
  }
  return value
}

/** 单行 → 合成行。可解析：结构克隆；不可解析：确定性假损坏行（同样不可解析） */
function scrubLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return ''
  try {
    const parsed = JSON.parse(trimmed)
    return JSON.stringify(scrub(parsed, 'root'))
  } catch {
    // 损坏行保持损坏：前缀像 JSON 但语法中断（确定性，无原文）
    return `{ "corpus": "synthetic-corrupt", "bytes": ${Buffer.byteLength(line)} ` + (synthSeq % 2 === 0 ? '' : '"trunc')
  }
}

/** 读源文件 → 合成克隆文本（超长在 CAP 处截断，截断行丢弃） */
function cloneFile(srcPath) {
  const raw = readFileSync(srcPath, 'utf8')
  const lines = raw.split('\n')
  const outLines = []
  let bytes = 0
  let corrupt = 0
  const kinds = { user: 0, assistant: 0, tool: 0, other: 0 }
  for (const line of lines) {
    const cloned = scrubLine(line)
    const b = Buffer.byteLength(cloned) + 1
    if (bytes + b > FILE_BYTES_CAP) {
      outLines.push(`{ "corpus": "synthetic-truncated", "dropped_lines": ${lines.length - outLines.length} }`)
      break
    }
    bytes += b
    if (cloned.includes('"synthetic-corrupt"')) corrupt += 1
    try {
      const t = String(JSON.parse(cloned)?.type ?? 'other')
      if (t === 'user' || t === 'assistant') kinds[t] += 1
      else kinds.other += 1
    } catch { kinds.other += 1 }
    outLines.push(cloned)
  }
  return { text: outLines.join('\n'), corrupt, kinds, srcBytes: Buffer.byteLength(raw) }
}

function walkJsonl(dir, depth = 0) {
  const out = []
  if (depth > 4 || !existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walkJsonl(p, depth + 1))
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p)
  }
  return out
}

// ---- 主流程：claude JSONL ----
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const manifest = { generated: 'scripts/corpus-build.mjs', privacy: 'structural-clones-only', sources: [], files: [] }

const jsonls = walkJsonl(sourceClaude).sort()
let projN = 0
for (const src of jsonls) {
  const rel = join(sourceClaude, '..') // 占位，防未用告警
  void rel
  const proj = `proj${projN % 8}`
  const srcStat = statSync(src)
  const { text, corrupt, kinds, srcBytes } = cloneFile(src)
  const dir = join(OUT, 'claude', proj)
  mkdirSync(dir, { recursive: true })
  const name = `sess-${String(manifest.files.length).padStart(3, '0')}.jsonl`
  const dst = join(dir, name)
  writeFileSync(dst, text, 'utf8')
  // mtime 确定性递增（discover 排序稳定）
  const t = new Date(Date.UTC(2026, 0, 1, 0, manifest.files.length, 0))
  utimesSync(dst, t, t)
  manifest.files.push({
    file: `claude/${proj}/${name}`,
    lines: text.split('\n').length,
    bytes: Buffer.byteLength(text),
    corruptLines: corrupt,
    kinds,
    source: { sha256: createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 16), bytes: srcBytes, mtime: srcStat.mtimeMs },
  })
  projN += 1
}
manifest.sources.push({ kind: 'claude', files: jsonls.length })

// ---- 主流程：zcode sqlite（有 node:sqlite 且源库存在才克隆）----
try {
  const { DatabaseSync } = process.env.ZCODE_FORCE_OFF ? { DatabaseSync: null } : await import('node:sqlite')
  if (DatabaseSync !== undefined && DatabaseSync !== null && existsSync(sourceZcode)) {
    const outDir = join(OUT, 'zcode')
    mkdirSync(outDir, { recursive: true })
    const dstDb = join(outDir, 'db.sqlite')
    rmSync(dstDb, { force: true })
    const src = new DatabaseSync(sourceZcode, { readOnly: true })
    const dst = new DatabaseSync(dstDb)
    dst.exec('CREATE TABLE session (id TEXT PRIMARY KEY, path TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)')
    dst.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER, data TEXT)')
    dst.exec('CREATE TABLE part (message_id TEXT, sequence INTEGER, data TEXT)')
    const sessions = src.prepare('SELECT id, path, title, time_created, time_updated FROM session ORDER BY time_updated DESC LIMIT 12').all()
    let si = 0
    for (const s of sessions) {
      si += 1
      const sid = `sess-zcode-${String(si).padStart(3, '0')}`
      dst.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(sid, `/corpus/proj${si % 8}`, `接力语料会话 ${si}`, 1767225600000 + si, 1767225600000 + si * 10)
      const msgs = src.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY sequence').all(s.id)
      let mi = 0
      for (const m of msgs) {
        mi += 1
        let data = {}
        try { data = JSON.parse(m.data) ?? {} } catch { /* 坏消息行→空壳 */ }
        const scrubbed = scrub(data, 'data')
        dst.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`${sid}-m${mi}`, sid, mi, JSON.stringify(scrubbed))
        const parts = src.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY sequence').all(m.id)
        let pi = 0
        for (const p of parts) {
          pi += 1
          let pd = {}
          try { pd = JSON.parse(p.data) ?? {} } catch { /* 同上 */ }
          dst.prepare('INSERT INTO part VALUES (?, ?, ?)').run(`${sid}-m${mi}`, pi, JSON.stringify(scrub(pd, 'pdata')))
        }
        if (mi >= 40) break // 单会话消息数上限，控 fixture 体积
      }
    }
    src.close()
    dst.close()
    manifest.sources.push({ kind: 'zcode', sessions: sessions.length })
    manifest.files.push({ file: 'zcode/db.sqlite', sessions: sessions.length })
  }
} catch (e) {
  console.warn(`zcode 语料跳过：${e.message}`)
}

writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`语料构建完成：${manifest.files.length} 个条目 → ${OUT}`)
for (const f of manifest.files) console.log(`  - ${f.file}（${f.bytes ?? f.sessions} ${f.bytes !== undefined ? 'B' : 'sessions'}${f.corruptLines ? `，损坏行 ${f.corruptLines}` : ''}）`)
