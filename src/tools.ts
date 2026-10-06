/**
 * host 侧两个工具：
 * - handoff_push：把当前 DSH 会话按 handoff: 1 协议导出成卡片，落 ~/.handoff/pending/。
 *   段内容优先用 agent 传入的蒸馏文本；缺省段从事件流确定性兜底（不调 LLM）。
 * - handoff_inbox：list 列待取件；load 取件（消费即弃）+ verifyGit 核验警告。
 * 所有返回值走 { ok, ... } 规范值；任何失败不抛异常，只回 { ok: false, error }。
 * @module dsh-takeover/tools
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-skill'
// Type-only：触发 Context 声明合并（ctx.userQuestions: UserQuestionService）。
// 运行时由宿主提供；旧宿主缺席走 safeUserQuestions 防御降级，绝不阻断主流程。
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import {
  collectGitSnapshot,
  generateId,
  listPendingReport,
  loadCard,
  pendingDir,
  renderCard,
  verifyGit,
  writeCard,
  type Card,
  type CardSections,
  type TaskSnapshot,
} from '@agent-handoff/core'
import { collectFacts, probeSessionEvents, todoToTasks, type SessionFacts } from './collect.ts'

// ---------------------------------------------------------------------------
// 共享收件箱的输入净化与上限：卡片正文/段落是外来输入，落盘后被 list/state
// 每次全量重读——无界段落放大成宿主 OOM；`## 标题`/ANSI 是注入面。
// ---------------------------------------------------------------------------

/** 单段字符上限（七段合计约 0.9MB，30s 轮询全量重读仍在毫秒级） */
export const MAX_SECTION_CHARS = 128 * 1024
/** 标量字段（title/to/project）字符上限 */
export const MAX_SCALAR_CHARS = 500
/** cwd 字符上限 */
export const MAX_CWD_CHARS = 1024
/** 卡片 id 长度上限（SAFE_ID 形态不限长，超长 id 的错误文案会回显全长） */
export const MAX_ID_CHARS = 64

const ANSI_CSI = /\u001B\[[0-9;:?]*[ -/]*[@-~]/g
const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g

/** 剥离 ANSI 转义序列与其余 C0/C1 控制字符（保留 \n \r \t） */
export function stripControlChars(s: string): string {
  return s
    .replace(ANSI_CSI, '')
    .replace(ANSI_OSC, '')
    // eslint-disable-next-line no-control-regex -- 正是要清的控制字符
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** 解除段内标题形态：core parseSections 按行首 `## 标题` 切段，正文里的
 * 伪标题会被切成「真」协议段（段注入）。行首垫一格即可解除，内容零丢失。 */
export function defuseHeadingLines(s: string): string {
  return s.split('\n').map((l) => (/^\s*#{1,6}\s/.test(l) ? ` ${l}` : l)).join('\n')
}

/** 规范错误文案：系统级错误（带 errno code）包一层中文口径，模块自产中文错原样透传 */
export function readableError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return `文件系统错误（${code}）：${e.message}`
    return e.message
  }
  return String(e)
}

// ---------------------------------------------------------------------------
// A. 四态覆盖率统计（审计语义产品化）
// ---------------------------------------------------------------------------

/** 四态证据标记（README「四态审计」口径：CURRENT_OBSERVED / HISTORY_REPORTED / MISMATCH / UNAVAILABLE） */
export const COVERAGE_MARKERS = ['CURRENT_OBSERVED', 'HISTORY_REPORTED', 'MISMATCH', 'UNAVAILABLE'] as const

/** 覆盖率统计：done 段的完成/交付陈述总数与其中带四态标注的条数 */
export interface CoverageStats {
  statements: number
  marked: number
  unmarked: number
  // 索引签名：让输出满足 defineTool 的 JsonValue 契约（InboxItem 同款）
  [k: string]: number
}

/**
 * 四态覆盖率统计（确定性、纯函数）。
 *
 * 口径纪律：只统计，不强制。这里只产出数字供取件方参考，push 侧绝不做
 * 「覆盖率不达标就拒卡/改写」一类的强制——一旦把覆盖率当门槛，就会诱导
 * 推送方「为覆盖率假标」（给每行无脑贴 HISTORY_REPORTED），污染账本本身，
 * 比未标注危害更大。未标注行的消费口径由取件侧兜底：按 HISTORY_REPORTED 处理。
 *
 * 计数规则：done 段按行拆分，空行与 # 开头的小节标题行不计；其余每行算一条
 * 完成/交付陈述，行内含任一四态标记计 marked，否则计 unmarked。
 */
export function coverageOfDone(done: string): CoverageStats {
  if (typeof done !== 'string') return { statements: 0, marked: 0, unmarked: 0 }
  let statements = 0
  let marked = 0
  for (const raw of done.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    statements += 1
    if (COVERAGE_MARKERS.some((m) => line.includes(m))) marked += 1
  }
  return { statements, marked, unmarked: statements - marked }
}

/** 防御式取数：非负整数三字段齐才认；外来卡/坏数据一律 undefined（不渲染不报错） */
function normalizeCoverage(v: unknown): CoverageStats | undefined {
  if (v === null || typeof v !== 'object') return undefined
  const { statements, marked, unmarked } = v as Record<string, unknown>
  if (typeof statements !== 'number' || !Number.isInteger(statements) || statements < 0) return undefined
  if (typeof marked !== 'number' || !Number.isInteger(marked) || marked < 0) return undefined
  if (typeof unmarked !== 'number' || !Number.isInteger(unmarked) || unmarked < 0) return undefined
  return { statements, marked, unmarked }
}

/** 从卡片 extras 防御式取覆盖率（core parseCard 把顶层未知键收进 extras） */
export function coverageFromExtras(extras: unknown): CoverageStats | undefined {
  if (extras === null || typeof extras !== 'object') return undefined
  return normalizeCoverage((extras as Record<string, unknown>).coverage)
}

/** 「账本覆盖：…」提示行；无有效统计返回 null（渲染侧静默省行） */
export function renderCoverageLine(coverage: unknown): string | null {
  const c = normalizeCoverage(coverage)
  if (c === undefined) return null
  return `账本覆盖：${c.marked}/${c.statements} 条已标注状态（${c.unmarked} 条未标——取件方按 HISTORY_REPORTED 处理）`
}

// ---------------------------------------------------------------------------
// B. 机器信封（双形态输出：人的卡片 .md + 机器的接手信封 .envelope.json）
// ---------------------------------------------------------------------------

/** 接手信封：卡片纯派生物，机器消费用（token 受限接手场景），可随时由卡片重建 */
export interface HandoffEnvelope {
  handoff: 1
  kind: 'envelope'
  id: string
  from: { agent: string; title: string }
  goal: string
  done: string
  remaining: string
  stopped: string
  warnings: string
  files: string[]
}

/**
 * 协议扩展提案（CHANGELOG 0.4.0）：handoff: 1 SPEC 一字不动——信封是独立第二文件
 * 而非 frontmatter 扩展，不认识它的旧实现（core listDirCards 只认 .md）天然忽略，
 * 收件箱语义零影响；认识它的实现取件消费 .md 时同步删除信封。
 */

/** 信封各段确定性截断上限。段上限合计（300+300+200+200+200）+ files/元信息
 * 决定了「总 JSON ≤1200 字」在典型蒸馏文本下可达；四段全顶着上限时会超——
 * 上限的职责是封顶（最坏有界），≤1200 是目标不是硬保证，这里如实声明。 */
export const ENVELOPE_GOAL_MAX = 300
export const ENVELOPE_DONE_MAX = 300
export const ENVELOPE_REMAINING_MAX = 200
export const ENVELOPE_STOPPED_MAX = 200
/** 截断清单未列 warnings 段；沿用 200 档——放任 128K 警告直通会击穿任何预算 */
export const ENVELOPE_WARNINGS_MAX = 200
/** from 字段防御性上限（卡片侧标量上限 500，信封里收得更紧） */
export const ENVELOPE_FROM_MAX = 100
/** files 段取前 10 条非空行 */
export const ENVELOPE_FILES_MAX = 10
/** files 单条行上限（防超长单行把数组撑爆） */
export const ENVELOPE_FILE_LINE_MAX = 120

/** buildEnvelope 的结构化入参：Card 天然满足，单测可用最小字面量 */
export interface EnvelopeSource {
  id?: string
  from?: { agent?: string; title?: string }
  sections: { goal?: string; done?: string; remaining?: string; stopped?: string; warnings?: string; files?: string }
}

/** 卡片 → 接手信封（确定性：同一张卡永远产出同一个 JSON） */
export function buildEnvelope(card: EnvelopeSource): HandoffEnvelope {
  const clip = (v: unknown, max: number): string => {
    const s = typeof v === 'string' ? v : ''
    return s.length > max ? s.slice(0, max) : s
  }
  const sec = card?.sections ?? {}
  const files = typeof sec.files === 'string'
    ? sec.files
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .slice(0, ENVELOPE_FILES_MAX)
      .map((l) => l.slice(0, ENVELOPE_FILE_LINE_MAX))
    : []
  return {
    handoff: 1,
    kind: 'envelope',
    id: clip(card?.id, MAX_ID_CHARS),
    from: { agent: clip(card?.from?.agent, ENVELOPE_FROM_MAX), title: clip(card?.from?.title, ENVELOPE_FROM_MAX) },
    goal: clip(sec.goal, ENVELOPE_GOAL_MAX),
    done: clip(sec.done, ENVELOPE_DONE_MAX),
    remaining: clip(sec.remaining, ENVELOPE_REMAINING_MAX),
    stopped: clip(sec.stopped, ENVELOPE_STOPPED_MAX),
    warnings: clip(sec.warnings, ENVELOPE_WARNINGS_MAX),
    files,
  }
}

/** 信封落盘路径（与卡片同屋 pending/，取件时同步消费） */
export function envelopePath(id: string, dir?: string): string {
  return join(pendingDir(dir), `${id}.envelope.json`)
}

/**
 * 取件时同步消费信封：读出字符数（供人渲染）后删除 pending/ 下的信封文件。
 * 只在 loadCard 成功后调用（id 已过 SAFE_ID 闸，无路径穿越面）；信封是纯派生物，
 * 残留无害（core 列表只认 .md），读/删任一步失败都吞掉，绝不影响取件主流程成败。
 */
function consumeEnvelope(id: string, dir?: string): number | undefined {
  const p = envelopePath(id, dir)
  try {
    if (!existsSync(p)) return undefined
    let chars: number | undefined
    try {
      // 读侧尺寸闸：外来巨信封不整体读进内存——信封是 ≤1200 字目标的派生物，超限直接按异常丢弃
      if (statSync(p).size <= 8 * 1024 * 1024) chars = readFileSync(p, 'utf-8').length
    } catch { /* 读失败不挡删除 */ }
    try {
      rmSync(p, { force: true })
    } catch { /* 删失败也不挡取件：残留信封会被列表忽略 */ }
    return chars
  } catch {
    return undefined
  }
}

/** 渲染：execute 返回规范值对象，render 包成中文 text block（导出仅为单测） */
export function renderPush(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { ok?: boolean; id?: string; path?: string; skipped?: boolean; note?: string; coverage?: unknown; error?: unknown }
  if (v?.ok === true) {
    const lines = [`✅ 交接卡片已寄存：${v.id ?? ''}`, `路径：${v.path ?? ''}`]
    const coverageLine = renderCoverageLine(v.coverage)
    if (coverageLine !== null) lines.push(coverageLine)
    if (typeof v.note === 'string' && v.note !== '') lines.push(`⚠️ ${v.note}`)
    lines.push('任何 agent 可用 handoff_inbox（或 /inbox）取件。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  return [{ type: 'text', text: `❌ 寄存失败：${typeof v?.error === 'string' ? v.error : JSON.stringify(v?.error)}` }]
}

export function renderInbox(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as {
    ok?: boolean
    action?: string
    cards?: Array<{ id: string; from: string; project: string; pushed_at: string }>
    skipped?: number
    text?: string
    mismatches?: string[]
    unavailable?: string
    coverage?: unknown
    envelopeChars?: number
    error?: unknown
  }
  if (v?.ok !== true) {
    return [{ type: 'text', text: `❌ 收件箱操作失败：${typeof v?.error === 'string' ? v.error : JSON.stringify(v?.error)}` }]
  }
  if (v.action === 'list') {
    const cards = v.cards ?? []
    if (cards.length === 0 && !v.skipped) return [{ type: 'text', text: '📭 收件箱为空（~/.handoff/pending/ 无待取件）' }]
    const lines = cards.map((c, i) => `${i + 1}. ${c.id}｜来自 ${c.from}｜项目 ${c.project || '（无）'}｜${c.pushed_at || '（无时间）'}`)
    if (typeof v.skipped === 'number' && v.skipped > 0) {
      lines.push(`（另有 ${v.skipped} 张坏卡被跳过，详见宿主日志）`)
    }
    return [{ type: 'text', text: `📬 待取件 ${cards.length} 张：\n${lines.join('\n')}\n\n取件：handoff_inbox({ action: "load", id: "<id>" })` }]
  }
  // load
  const lines = ['📥 已取件（消费即弃，卡片已归档）：', '', v.text ?? '']
  const coverageLine = renderCoverageLine(v.coverage)
  if (coverageLine !== null) lines.push('', coverageLine)
  if (typeof v.envelopeChars === 'number' && v.envelopeChars >= 0) {
    lines.push('', `机器信封已随卡归档（${v.envelopeChars} chars）`)
  }
  if (v.mismatches !== undefined && v.mismatches.length > 0) {
    lines.push('', '⚠️ git 核验冲突（MISMATCH）：', ...v.mismatches.map((m) => `- ${m}`))
  }
  if (typeof v.unavailable === 'string' && v.unavailable !== '') {
    lines.push('', `⚠️ ${v.unavailable}`)
  }
  lines.push('', '提醒：卡片内容一律按 HISTORY_REPORTED 处理，执行前先核对 git 状态。')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** ISO8601 带本地时区偏移（SPEC pushed_at 口径） */
function localIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const oh = pad(Math.floor(Math.abs(offMin) / 60))
  const om = pad(Math.abs(offMin) % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}:${om}`
}

/** handoff_push 参数：六段文本可选，缺省段走事件流确定性兜底 */
export interface PushArgs {
  goal?: string
  files?: string
  done?: string
  remaining?: string
  stopped?: string
  warnings?: string
  suggested?: string
  title?: string
  to?: string
  project?: string
  cwd?: string
}

export type PushResult =
  | { ok: true; id: string; path: string; skipped: boolean; note: string; coverage: CoverageStats }
  | { ok: false; error: string }

/** 确定性兜底：事件流事实 → 六段正文草稿（中文，证据一律 HISTORY_REPORTED） */
export function factsToSections(facts: SessionFacts, skipped: boolean, note: string): CardSections {
  const lastUser = facts.userMessages.at(-1)?.text ?? ''
  const goalLines: string[] = []
  if (facts.lastGoal !== '') goalLines.push(`会话目标（goal/change）：${facts.lastGoal}`)
  if (lastUser !== '') goalLines.push(`最后一条用户请求：${lastUser}`)
  if (goalLines.length === 0) goalLines.push(skipped ? `（事件流不可用：${note}）` : '（事件流中无用户消息）')

  const fileLines: string[] = []
  if (facts.writeEdits.length > 0) {
    fileLines.push('写入 / 编辑：')
    for (const w of facts.writeEdits) fileLines.push(`- ${w.tool}: ${w.file}`)
  }
  if (facts.commands.length > 0) {
    fileLines.push('执行过的命令（截断摘要）：')
    for (const c of facts.commands) fileLines.push(`- \`${c}\``)
  }
  const extraFiles = [...facts.keyFiles].filter((f) => !facts.writeEdits.some((w) => w.file === f)).slice(0, 15)
  if (extraFiles.length > 0) {
    fileLines.push('涉及路径：')
    for (const f of extraFiles) fileLines.push(`- \`${f}\``)
  }
  if (fileLines.length === 0) fileLines.push('（事件流中无文件/命令记录）')

  const doneLines: string[] = []
  if (facts.writeEdits.length > 0) doneLines.push(`写入 / 编辑 ${facts.writeEdits.length} 处（HISTORY_REPORTED）：`, ...facts.writeEdits.map((w) => `- ${w.file}`))
  if (facts.gitCommits.length > 0) doneLines.push('git 提交（HISTORY_REPORTED）：', ...facts.gitCommits.map((c) => `- \`${c}\``))
  if (doneLines.length === 0) doneLines.push('（事件流中无可蒸馏的完成项）')

  const tasks = todoToTasks(facts)
  const openTasks = tasks.filter((t) => t.status !== 'completed')
  const remainingLines = openTasks.length > 0
    ? openTasks.map((t) => `- [${t.status}] ${t.text}`)
    : ['（无未完成 todo 快照）']

  const stopped = skipped
    ? `会话事件流不可用（${note}），本卡片为兜底骨架。最安全的第一步：向推送方确认真实停点。`
    : `停在 handoff_push 工具调用时刻（共 ${facts.eventCount} 条事件）。最安全的第一步：核对当前 git 分支与 dirty 文件是否与本卡片快照一致。`

  const warnings = [
    '本卡片全部内容为推送时刻的历史快照（HISTORY_REPORTED），不是当下事实；执行前先核对 git 状态。',
    skipped ? `事件流探测降级：${note}。` : '',
  ].filter(Boolean).join('\n')

  return {
    goal: goalLines.join('\n'),
    files: fileLines.join('\n'),
    done: doneLines.join('\n'),
    remaining: remainingLines.join('\n'),
    stopped,
    warnings,
  }
}

/**
 * 推送核心（可脱离 host 单测）：组装协议卡片写入 pending/。
 * session 可以是任何形态——探测失败只降级，不抛错。
 * 外来段落净化（ANSI/控制字符剥离、伪标题解除形态）并限量（单段 128K 字符，
 * 标量 500）——共享收件箱的卡会被 inboxList/buildState 每次全量重读，不设上限
 * 就是把宿主内存/CPU 交给任意一次 push。
 */
export function pushHandoff(session: unknown, args: PushArgs, opts?: { dir?: string }): PushResult {
  try {
    const probe = probeSessionEvents(session)
    const facts = probe.skipped
      ? { userMessages: [], writeEdits: [], commands: [], gitCommits: [], keyFiles: new Set<string>(), lastTodo: null, lastGoal: '', eventCount: 0 }
      : collectFacts(probe.events)

    const s = session as { id?: unknown; header?: { cwd?: unknown } } | null | undefined
    const sessionId = s && s.id != null ? String(s.id) : ''
    const rawCwd = (typeof args.cwd === 'string' && args.cwd.trim() !== '' && args.cwd.trim())
      || (typeof s?.header?.cwd === 'string' ? s.header.cwd : '')
      || process.cwd()
    const cwd = stripControlChars(rawCwd).slice(0, MAX_CWD_CHARS)

    const fallback = factsToSections(facts, probe.skipped, probe.note)
    const pick = (v: string | undefined, dflt: string): string => (typeof v === 'string' && v.trim() !== '' ? v.trim() : dflt)
    const truncated: string[] = []
    const section = (v: string | undefined, dflt: string): string => {
      const clean = defuseHeadingLines(stripControlChars(pick(v, dflt)))
      if (clean.length <= MAX_SECTION_CHARS) return clean
      truncated.push(`「${clean.slice(0, 12)}…」段超 ${MAX_SECTION_CHARS} 字符已截断`)
      return `${clean.slice(0, MAX_SECTION_CHARS)}\n…（超长截断）`
    }
    const scalar = (v: string | undefined, dflt: string): string => {
      const clean = stripControlChars(pick(v, dflt))
      return clean.length > MAX_SCALAR_CHARS ? clean.slice(0, MAX_SCALAR_CHARS) : clean
    }
    const sections: CardSections = {
      goal: section(args.goal, fallback.goal),
      files: section(args.files, fallback.files),
      done: section(args.done, fallback.done),
      remaining: section(args.remaining, fallback.remaining),
      stopped: section(args.stopped, fallback.stopped),
      warnings: section(args.warnings, fallback.warnings),
    }
    const suggested = pick(args.suggested, '')
    if (suggested !== '') sections.suggested = section(suggested, '')

    // 四态覆盖率：只统计不强制（纪律见 coverageOfDone 注释），随卡进 extras 持久化，
    // 取件侧 parseCard 后可从 extras.coverage 读回
    const coverage = coverageOfDone(sections.done)
    const card: Card = {
      handoff: 1,
      id: generateId(),
      from: { agent: 'dsh', session: sessionId, title: scalar(args.title, '') },
      to: scalar(args.to, 'any'),
      project: scalar(args.project, ''),
      cwd,
      pushed_at: localIso(new Date()),
      git: collectGitSnapshot(cwd),
      tasks: todoToTasks(facts).filter((t): t is TaskSnapshot => true),
      sections,
      extras: { coverage },
    }
    const path = writeCard(card, opts?.dir)
    // 机器信封（协议扩展提案，handoff: 1 SPEC 不动）：卡片落盘成功后落第二文件。
    // 信封是纯派生物——写失败只降级进 note，不回滚已寄存的卡片
    let envelopeNote = ''
    try {
      writeFileSync(envelopePath(card.id, opts?.dir), JSON.stringify(buildEnvelope(card)), 'utf-8')
    } catch (e) {
      envelopeNote = `机器信封落盘失败（卡片本体已寄存）：${readableError(e)}`
    }
    const note = [probe.note, ...truncated, envelopeNote].filter(Boolean).join('；')
    return { ok: true, id: card.id, path, skipped: probe.skipped, note, coverage }
  } catch (e) {
    return { ok: false, error: readableError(e) }
  }
}

export interface InboxItem {
  id: string
  from: string
  title: string
  to: string
  project: string
  pushed_at: string
  taskCount: number
  // 索引签名：让输出满足 defineTool 的 JsonValue 契约
  [k: string]: string | number
}

export type InboxListResult =
  | { ok: true; action: 'list'; cards: InboxItem[]; skipped: number }
  | { ok: false; error: string }

/** 列出 pending 待取件（新→旧），只读不消费；坏卡跳过并计数（skipped），不再静默 */
export function inboxList(opts?: { dir?: string }): InboxListResult {
  try {
    const report = listPendingReport(opts?.dir)
    const cards = report.cards.map((c) => ({
      id: c.id,
      from: c.from.agent !== '' ? `${c.from.agent}${c.from.title !== '' ? `（${c.from.title}）` : ''}` : '（未知来源）',
      title: c.from.title,
      to: c.to,
      project: c.project,
      pushed_at: c.pushed_at,
      taskCount: c.tasks.length,
    }))
    return { ok: true, action: 'list', cards, skipped: report.skipped.length }
  } catch (e) {
    return { ok: false, error: readableError(e) }
  }
}

export type InboxLoadResult =
  | {
      ok: true
      action: 'load'
      id: string
      text: string
      mismatches: string[]
      unavailable?: string
      /** 卡内 extras.coverage（防御式提取，外来卡/坏数据缺省） */
      coverage?: CoverageStats
      /** 随卡消费的机器信封 JSON 字符数；卡无信封（旧卡/外写卡）缺省 */
      envelopeChars?: number
    }
  | { ok: false; error: string }

/** 取件（消费即弃）：pending → archived，附 verifyGit 的 MISMATCH/UNAVAILABLE 警告 */
export function inboxLoad(id: string, opts?: { dir?: string }): InboxLoadResult {
  const trimmed = (id ?? '').trim()
  if (trimmed === '') return { ok: false, error: 'id 不能为空' }
  // 超长 id 早拒：SAFE_ID 形态不限长度，500 字符合法形态 id 会把全长回显进错误文案
  if (trimmed.length > MAX_ID_CHARS) {
    return { ok: false, error: `非法卡片 id（长度 ${trimmed.length} 超上限 ${MAX_ID_CHARS}）：${trimmed.slice(0, 48)}…` }
  }
  try {
    const card = loadCard(trimmed, opts?.dir)
    const check = verifyGit(card)
    // 机器信封随卡消费：core 的 loadCard 只搬 .md，信封生命周期归本插件管
    const envelopeChars = consumeEnvelope(trimmed, opts?.dir)
    const coverage = coverageFromExtras(card.extras)
    const out: InboxLoadResult = {
      ok: true,
      action: 'load',
      id: card.id,
      text: renderCard(card),
      mismatches: check.mismatches,
    }
    if (check.unavailable !== undefined) out.unavailable = check.unavailable
    if (coverage !== undefined) out.coverage = coverage
    if (envelopeChars !== undefined) out.envelopeChars = envelopeChars
    return out
  } catch (e) {
    // core 层中文错误（收件箱无此待取件等）原样透传；系统错误包中文口径
    return { ok: false, error: readableError(e) }
  }
}

/** 会话探测：exec.agent 的 session（dsh-handoff 同款 typeof 防御） */
function sessionOf(exec: { agent?: Agent } | undefined): unknown {
  return exec?.agent?.session ?? null
}

/** 寄存/取件后的宿主通知（docs/需求调研-1003.md P2-3）：
 * DSH 宿主无 toast / 系统通知的插件挂点，最接近形态是 ctx.userQuestions.ask
 * 的阻塞式问答面板（规范调用样例：dsh-tool-ask-user，agent: exec.agent + signal: exec.signal）。
 * 尽力而为，绝不阻断寄存/取件主流程：
 * - 服务缺席（旧宿主）→ safeUserQuestions 返 undefined，直接跳过；
 * - Web 客户端离线 / 会话无 open turn（NO_PROVIDER）、subagent 持有 agent（DELEGATED_CALLER）、
 *   中止（ASK_ABORTED）→ ask reject，静默降级为工具结果文本。 */
export async function handoffHostNotice(
  userQuestions: unknown,
  action: 'push' | 'load',
  id: string,
  exec?: { agent?: Agent; signal?: AbortSignal },
  log?: (msg: string) => void,
): Promise<void> {
  // 观测双通道：console.*（stdout / web-baton 日志可查）+ ctx.logger（宿主日志汇），
  // 哪条可见用哪条。0.2.0 期间 ctx.logger 从未落到 stdout 文件（8 次启动 0 命中，已实测）。
  const say = (msg: string): void => {
    try {
      console.info(`[dsh-takeover] ${msg}`)
    } catch { /* 忽略 */ }
    try {
      log?.(msg)
    } catch { /* 忽略 */ }
  }
  if (userQuestions === null || typeof userQuestions !== 'object') {
    say(`${action} 通知跳过：userQuestions 服务缺席（${id}）`)
    return
  }
  const ask = (userQuestions as { ask?: unknown }).ask
  if (typeof ask !== 'function') {
    say(`${action} 通知跳过：ask 非函数（${id}）`)
    return
  }
  const pushed = action === 'push'
  // id 来自卡内 frontmatter（外来可写），消毒成单行短串再进面板文案与日志
  const safeId = String(id).replace(/[\r\n\u0000-\u001F]+/g, ' ').slice(0, 100)
  const request: AskUserQuestionRequest = {
    questions: [{
      id: pushed ? 'handoff-pushed' : 'handoff-picked',
      question: pushed ? `已寄存会话卡片 handoff:${safeId}，需继续吗？` : `已取件会话卡片 handoff:${safeId}，需继续吗？`,
      options: [{ label: '继续' }],
    }],
    ...(exec?.agent !== undefined ? { agent: exec.agent } : {}),
    signal: exec?.signal,
  }
  say(`${action} 通知 ask 开始（${id}，agent=${exec?.agent !== undefined ? '有' : '无'}）`)
  try {
    const answer = await (ask as (req: AskUserQuestionRequest) => Promise<unknown>).call(userQuestions, request)
    // 有人接受并回答了——记录回答内容（谁在消费通知请求的关键观测）
    say(`${action} 通知 ask 已解答（${safeId}）：${JSON.stringify(answer)?.slice(0, 400)}`)
  } catch (e) {
    // NO_PROVIDER / DELEGATED_CALLER / ASK_ABORTED / 无 open turn：通知降级，主流程照常。
    // 降级码进日志（e.code 区分未认领 vs 已中止），为 0.3.x 通知形态结论留观测。
    const err = e as { code?: string; name?: string; message?: string }
    say(`${action} 通知降级（${safeId}）：${err.code ?? err.name ?? 'unknown'} ${err.message ?? ''}`.trim())
  }
}

/** 防御式取 ctx.userQuestions：cordis 对未挂载服务的属性访问会直接 throw（client.ts resolveLocale 同款） */
function safeUserQuestions(ctx: Context): unknown {
  try {
    const uq: unknown = ctx.userQuestions
    return uq
  } catch {
    return undefined
  }
}

/** 注册 handoff_push 工具 */
export function registerPushTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'handoff_push',
    description: '把当前 DSH 会话寄存为一张 handoff: 1 交接卡片到共享收件箱 ~/.handoff/pending/（任何 agent 可取件）。六段文本（goal/files/done/remaining/stopped/warnings）+ 可选 suggested（建议加载段，非协议段）可选传入；留空段从会话事件流确定性兜底，不调 LLM。另落机器信封 <id>.envelope.json（协议扩展提案）并对 done 段产出四态覆盖率统计 coverage（只统计不强制）。返回 { ok, id, path, coverage } 规范值。',
    parameters: {
      goal: { type: 'string', description: '「目标」段：会话在做什么、最后一条用户请求' },
      files: { type: 'string', description: '「涉及文件」段：碰过的文件/命令；计划文档只写路径' },
      done: { type: 'string', description: '「做到哪」段：已完成事项 + 证据状态' },
      remaining: { type: 'string', description: '「还差什么」段：未完成事项' },
      stopped: { type: 'string', description: '「停在哪」段：精确停止点 + 最安全的第一步' },
      warnings: { type: 'string', description: '「读者警告」段：过期信息、坑、redact 说明' },
      suggested: { type: 'string', description: '「建议加载」段（可选）：下个会话该预载的 skill/上下文' },
      title: { type: 'string', description: '会话标题（给人看的，可选）' },
      to: { type: 'string', description: '目标 agent/项目，默认 any' },
      project: { type: 'string', description: '项目名（可选，默认空）' },
      cwd: { type: 'string', description: '卡片归属的工作目录，缺省取当前会话工作区' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '是否成功寄存' },
          id: { type: 'string', description: '卡片 id（文件名去 .md）' },
          path: { type: 'string', description: '落盘绝对路径' },
          coverage: { type: 'json', description: '四态覆盖率统计 { statements, marked, unmarked }（只统计不强制）' },
          skipped: { type: 'boolean', description: '事件流不可用时为 true' },
          note: { type: 'string', description: '降级说明' },
          error: { type: 'json', description: '失败原因' },
        },
      },
      render: renderPush,
    },
    async execute(args: PushArgs, exec: { agent?: Agent; signal?: AbortSignal }) {
      const result = pushHandoff(sessionOf(exec), args)
      // 寄存成功后的宿主通知（阻塞式问答面板；服务缺席/客户端离线静默降级）
      if (result.ok) {
        // 通知 fire-and-forget：面板弹在客户端，agent 不等应答（阻塞式通知会让
        // 回合无限挂起——0.4.0 真机实锤）；面板留存客户端直到用户处理
        void handoffHostNotice(safeUserQuestions(ctx), 'push', result.id, exec, (m) => ctx.logger.info(m))
          .catch(() => { /* 降级已内部处理 */ })
      }
      return result
    },
  }))
}

/** 注册 handoff_inbox 工具 */
export function registerInboxTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'handoff_inbox',
    description: '交接卡片收件箱：action=list 列 ~/.handoff/pending/ 待取件（id/来源/项目/时间）；action=load + id 取件（消费即弃，卡片移到 archived/，随卡消费机器信封，附 git 核验 MISMATCH/UNAVAILABLE 警告与四态覆盖率）。返回 { ok, ... } 规范值。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'load'], description: 'list 列待取件；load 取件（消费即弃）' },
      id: { type: 'string', description: 'load 必填：卡片 id' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '操作是否成功' },
          action: { type: 'string', description: '实际执行的动作' },
          cards: { type: 'json', description: 'list：待取件摘要数组' },
          id: { type: 'string', description: 'load：取到的卡片 id' },
          text: { type: 'string', description: 'load：卡片全文（frontmatter + 六段）' },
          mismatches: { type: 'json', description: 'load：git 核验冲突（MISMATCH）' },
          unavailable: { type: 'string', description: 'load：无法核验说明（UNAVAILABLE）' },
          coverage: { type: 'json', description: 'load：卡片 extras.coverage 的四态覆盖率统计（无则缺省）' },
          envelopeChars: { type: 'number', description: 'load：随卡消费的机器信封 JSON 字符数（卡无信封时缺省）' },
          error: { type: 'json', description: '失败原因' },
        },
      },
      render: renderInbox,
    },
    async execute(args: { action?: string; id?: string }, exec: { agent?: Agent; signal?: AbortSignal }) {
      if (args.action === 'list') return inboxList()
      if (args.action === 'load') {
        const result = inboxLoad(args.id ?? '')
        // 取件成功后的宿主通知（同 push：阻塞式问答面板，失败静默降级）
        if (result.ok) {
          // 通知 fire-and-forget：同 push 侧
          void handoffHostNotice(safeUserQuestions(ctx), 'load', result.id, exec, (m) => ctx.logger.info(m))
            .catch(() => { /* 降级已内部处理 */ })
        }
        return result
      }
      return { ok: false, error: `未知 action：${String(args.action)}（支持 list / load）` }
    },
  }))
}
