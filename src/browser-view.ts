/**
 * 外部会话浏览器的纯函数层（client 面板与服务端共享语义，零 DOM / 零 cordis 依赖）：
 * - 会话行的即时过滤（标题 / 目录 / id 子串，大小写不敏感）；
 * - 相对时间（行内扫读友好：刚刚 / N分钟前 / …；超 30 天回退绝对日期）；
 * - 接管 / 寄存指令生成——/resume-* 的引用解析在首个换行前截断（skills/resume 同轮修订），
 *   所以寄存指令是「引用行 + 指示行」两行式：一行塞尾巴会把尾巴吞进引用导致解析失败。
 * 不碰会话内容本体——浏览是只读的，接管与蒸馏都在会话里由模型完成。
 * @module dsh-takeover/browser-view
 */

export type Lang = 'zh' | 'en'

/** 会话行（服务端 /dsh-takeover/sessions 的 sessions[] 元素；轻量——不含轮数与内容） */
export interface SessionRow {
  id: string
  title: string
  cwd: string
  /** ISO 时间串（服务端 toIso 产物；空串 = 无时间） */
  updatedAt: string
  kind: string
}

/** 标题增强用的最小行形状（服务端 sniff 只需要这三个字段） */
export interface SessionRowLike {
  id: string
  title: string
  kind: string
}

/**
 * 即时过滤：query 按 ASCII 大小写不敏感（中文原样比较），
 * 命中标题 / 目录 / id 任一子串即保留；空 query 返回全量（原数组，不复制）。
 */
export function filterSessions(rows: SessionRow[], query: string): SessionRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows
  return rows.filter((r) =>
    r.title.toLowerCase().includes(q)
    || r.cwd.toLowerCase().includes(q)
    || r.id.toLowerCase().includes(q),
  )
}

/**
 * 相对时间：扫一行会话列表时「3小时前」比绝对时刻好用；
 * 超过 30 天退回绝对日期（相对量失去直觉）。ts 解析失败回原串（诚实降级）。
 */
export function relTime(ts: string, nowMs: number, lang: Lang): string {
  if (ts === '') return lang === 'en' ? '(no time)' : '（无时间）'
  const ms = new Date(ts).getTime()
  if (!Number.isFinite(ms)) return ts
  const diff = nowMs - ms
  if (diff < 0) return lang === 'en' ? 'just now' : '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return lang === 'en' ? 'just now' : '刚刚'
  if (min < 60) return lang === 'en' ? `${min}m ago` : `${min}分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return lang === 'en' ? `${h}h ago` : `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return lang === 'en' ? `${d}d ago` : `${d}天前`
  const dt = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
}

/** 接管指令：/resume-* 的引用 = slash token 之后首个换行前的文本（skills/resume 纪律） */
export function takeoverCommand(provider: string, id: string): string {
  return `/resume-${provider} ${id}`
}

/** 寄存的追加指示（指令第二行；模型在接管完成后把六段卡寄存进收件箱） */
export function depositTail(lang: Lang): string {
  return lang === 'en'
    ? 'When the takeover is done, deposit the six-section handoff card into the shared inbox.'
    : '接管完成后，把六段交接卡寄存进共享收件箱。'
}

// ---------------------------------------------------------------------------
// 交接出去（outbound）：DSH 会话 → 共享收件箱 → 别的 agent 接手。
// 方向与接管相反：指令投进「当前会话」（queue 模式），模型用 handoff_push
// 蒸馏寄存；对面按 pickupCommand 的指引取卡。全部纯文案，无 I/O。
// ---------------------------------------------------------------------------

/** 交接出去的接收方（any = 不指定，任何 agent 可取） */
export const OUTBOUND_TARGETS = ['any', 'claude', 'codex', 'opencode', 'zcode', 'pi', 'workbuddy', 'cursor', 'grok'] as const
export type OutboundTarget = (typeof OUTBOUND_TARGETS)[number]

/** 接收方展示名（与 PROVIDER_LABEL 同风格；any 是协议词不是 provider） */
export const OUTBOUND_LABELS: Record<OutboundTarget, { zh: string; en: string }> = {
  any: { zh: '任意 agent', en: 'Any agent' },
  claude: { zh: 'Claude Code', en: 'Claude Code' },
  codex: { zh: 'Codex CLI', en: 'Codex CLI' },
  opencode: { zh: 'OpenCode', en: 'OpenCode' },
  zcode: { zh: 'ZCode', en: 'ZCode' },
  pi: { zh: 'Pi', en: 'Pi' },
  workbuddy: { zh: 'WorkBuddy', en: 'WorkBuddy' },
  cursor: { zh: 'Cursor', en: 'Cursor' },
  grok: { zh: 'Grok CLI', en: 'Grok CLI' },
}

/** 投进当前会话的寄存指令（queue 模式打给本会话的 agent）。
 * 两行式（同 depositCommand 的换行纪律）：引用/命令行在前，指示行在后。 */
export function outboundCommand(lang: Lang): string {
  const head = '/handoff'
  return lang === 'en'
    ? `${head}\nWhen the deposit is done, tell me the card id.`
    : `${head}\n寄存完成后，把卡片编号发给我。`
}

/** 对面取卡指引：在目标 agent 的输入框里粘贴这句话，它读完卡即接手。
 * CLI 系给可直接启动的一行命令；输入框系给同句。路径用 ~（POSIX/Windows 均按
 * 目标 agent 的 home 展开习惯），卡 id 恒在句中。 */
export function pickupCommand(target: string, id: string, lang: Lang): string {
  const card = `~/.handoff/pending/${id}.md`
  const zhSentence = `读 ${card}，按卡接手。`
  const enSentence = `Read ${card} and continue per the card.`
  const sentence = lang === 'en' ? enSentence : zhSentence
  switch (target) {
    case 'claude':
      return lang === 'en' ? `claude "${enSentence}"` : `claude "${zhSentence}"`
    case 'codex':
      return lang === 'en' ? `codex "${enSentence}"` : `codex "${zhSentence}"`
    case 'opencode':
      return lang === 'en' ? `opencode "${enSentence}"` : `opencode "${zhSentence}"`
    case 'grok':
      return lang === 'en' ? `grok "${enSentence}"` : `grok "${zhSentence}"`
    default:
      // zcode / pi / workbuddy / cursor / any：在输入框粘贴同句（装了本插件的
      // DSH 侧则直接工作台收件箱点取件，指引卡另有说明）
      return sentence
  }
}

/** 字数人性化：7426 → 7.3K；1200000 → 1.2M；<1000 原样。统计条不再出现 6 位数字墙。 */
export function humanChars(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n)
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** 接管并寄存指令：两行式——第二行是给模型的本轮指示，不是引用的一部分。
 * 拼接而非模板字面量：客户端包 esbuild 未压缩构建会把模板内的 \n 转义煮成
 * 「真换行 + wrapper 缩进」（实测污染复制内容），普通字符串转义则保真。 */
export function depositCommand(provider: string, id: string, lang: Lang): string {
  return takeoverCommand(provider, id) + '\n' + depositTail(lang)
}

/** 预览展开体（/dsh-takeover/session-preview 的响应体） */
export interface SessionPreviewBody {
  ok: true
  provider: string
  summary: {
    title: string
    sessionId: string
    cwd: string
    turnCount: number
    userTurns: number
    firstUserMessage: string
    tailProgress: string[]
    files: string[]
  }
  skeleton: { stopped: string; warnings: string }
  note?: string
}

/** 会话列表响应体（/dsh-takeover/sessions） */
export interface SessionListBody {
  ok: true
  provider: string
  total: number
  sessions: SessionRow[]
  note?: string
}

/**
 * id 的短展示：文件系 id 是绝对路径，行内只显示文件名（完整 id 悬浮 + 点击复制）；
 * SQLite 系（已是会话 uuid）原样显示。
 */
export function shortId(row: SessionRow): string {
  if (row.kind === 'file') {
    const base = row.id.split(/[\\/]/).pop() ?? row.id
    return base !== '' ? base : row.id
  }
  return row.id
}

/**
 * 子代理/工作流会话判定（确定性，零猜测）：id 与标题的既见模式。
 * 证据：agent-sessions #49 与 cc-sessions #3 两家用户各自请求隐藏此类会话；
 * 本机真实样本：`sess_subagent_*`、`sess_dwf-*`、标题 `workflow subagent actor#N@M`。
 * 标题只认 `workflow subagent` 前缀（加 actor 备选会误收「Workflow actor
 * refactor」这类正经会话——宁可漏收不可错收）。
 */
export function isSubagentSession(row: SessionRow): boolean {
  if (row.id.startsWith('sess_subagent_')) return true
  if (/^sess_dwf-/.test(row.id)) return true
  return /^workflow subagent/i.test(row.title)
}

/** cwd（项目）facet：basename 展示 + 完整 cwd 过滤键，按多→少排序（空 cwd 归「—」桶） */
export function cwdFacets(rows: SessionRow[]): Array<{ cwd: string; label: string; count: number }> {
  const freq = new Map<string, { label: string; count: number }>()
  for (const r of rows) {
    const label = r.cwd === '' ? '—' : (r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd)
    const hit = freq.get(r.cwd)
    if (hit !== undefined) hit.count += 1
    else freq.set(r.cwd, { label, count: 1 })
  }
  return [...freq.entries()]
    .map(([cwd, v]) => ({ cwd, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/** cwd facet 过滤：null = 不过滤（原数组返回，不复制） */
export function filterByCwd(rows: SessionRow[], cwd: string | null): SessionRow[] {
  if (cwd === null) return rows
  return rows.filter((r) => r.cwd === cwd)
}

/**
 * 一键接管闭环（v2）：投递成功后让整个应用切换到新会话——uiWorkspace 是宿主
 * 客户端的导航服务（官方 sidebar 即 ctx.get("uiWorkspace").openSession(id)）。
 * 返回是否切换成功；服务缺席/形态不符回 false（降级：面板展示「去会话树找」），
 * 全程不抛出。ctx 以 unknown 进出——本模块保持零依赖（无 react/cordis 值引入）。
 */
export function uiNavigatorOf(ctx: unknown): (sessionId: string) => boolean {
  return (sessionId: string): boolean => {
    try {
      const nav = (ctx as { get?: (name: string) => unknown }).get?.('uiWorkspace') as
        | { openSession?: (id: string) => void }
        | undefined
      if (nav === null || typeof nav !== 'object') return false
      if (typeof (nav as { openSession?: unknown }).openSession !== 'function') return false
      ;(nav as { openSession: (id: string) => void }).openSession(sessionId)
      return true
    } catch {
      return false
    }
  }
}
