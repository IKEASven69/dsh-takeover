/**
 * 事件流确定性收集（不调 LLM、不读时钟之外的副作用）。
 * 借道 npm 包 dsh-handoff v0.1.0 的探测思路：全程 typeof 防御，
 * 任何结构偏差都不抛错——探测失败由调用方降级为规范值，绝不 throw。
 * @module dsh-takeover/collect
 */

/** 探测结果：events 不可用/无法适配时 skipped=true 并附中文说明 */
export interface ProbeResult {
  events: unknown[]
  skipped: boolean
  note: string
}

/** 收集到的会话事实（全部来自事件流的确定性蒸馏） */
export interface SessionFacts {
  /** 直接用户消息（source.kind === 'user'），截 200 字 */
  userMessages: Array<{ time: number; text: string }>
  /** 写过的文件/编辑清单 */
  writeEdits: Array<{ tool: string; file: string }>
  /** 执行过的命令摘要（bash 系，截 120 字，最多 10 条） */
  commands: string[]
  /** bash 里的 git commit 命令 */
  gitCommits: string[]
  /** 工具调用参数里出现的工作区路径（去重） */
  keyFiles: Set<string>
  /** 最近一次 todo/write 的快照（原样条目） */
  lastTodo: Array<Record<string, unknown>> | null
  /** 最近一次 goal/change 的目标文本 */
  lastGoal: string
  /** 事件总数（探测成功时） */
  eventCount: number
}

const truncate = (s: unknown, n: number): string => {
  const str = typeof s === 'string' ? s : String(s ?? '')
  return str.length > n ? `${str.slice(0, n)}…` : str
}

/** 蒸馏上限：事件流可被构造出任意规模，写卡片会全量落盘并被 list/state 每次全量重读——
 * 列表不设条数上限就是把宿主内存/CPU 交给单次 push（对照：commands 一直限 10 条） */
export const MAX_WRITE_EDITS = 200
export const MAX_USER_MESSAGES = 100
export const MAX_GIT_COMMITS = 100
/** 单条 file 路径上限 */
const FILE_PATH_MAX = 200
/** tasks 快照上限：条数与单条字段都封顶——tasks 是六段之外唯一全量入卡的结构，不能成为「push 50MB」的漏网侧门 */
export const MAX_TASKS = 50
export const TASK_TEXT_MAX = 120
export const TASK_PRIORITY_MAX = 10
/** keyFiles 去重集合上限（collectPaths 无上限累加，长会话可膨胀到数千条） */
export const MAX_KEY_FILES = 200

/** 从 content block 数组里抽出可见文本 */
function contentText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const b of blocks) {
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') out += t
    }
  }
  return out
}

/** 视作「文件写入/编辑」的工具名集合（参数常带 file_path/path） */
const FILE_MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** 执行命令的工具名集合 */
const COMMAND_TOOLS = new Set(['bash', 'shell', 'run_command'])

/**
 * 探测会话事件流：优先 session.snapshotEvents()（dsh-session 正式 API），
 * 退回 session.events 数组（dsh-handoff 探测过的形态），再退回降级。
 */
export function probeSessionEvents(session: unknown): ProbeResult {
  if (session === null || session === undefined || typeof session !== 'object') {
    return { events: [], skipped: true, note: 'exec.agent.session 为空（自检 / 无会话环境）' }
  }
  const s = session as Record<string, unknown>
  if (typeof s['snapshotEvents'] === 'function') {
    try {
      const out = (s['snapshotEvents'] as () => unknown)()
      if (Array.isArray(out)) return { events: out, skipped: false, note: '' }
    } catch {
      // 快照失败继续试 events 字段
    }
  }
  const events = s['events']
  if (Array.isArray(events)) {
    if (events.length > 0 && events.every((e) => !(e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string'))) {
      return { events: [], skipped: true, note: 'events 结构无法识别：事件缺少 type 字段' }
    }
    return { events, skipped: false, note: '' }
  }
  return { events: [], skipped: true, note: `events 结构无法识别：typeof=${typeof events}，期望数组或 snapshotEvents()` }
}

/** 从工具调用参数 JSON 里收集路径与命令 */
function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function collectPaths(parsed: Record<string, unknown>, into: Set<string>): void {
  for (const key of ['file_path', 'path', 'dest']) {
    const v = parsed[key]
    if (typeof v === 'string' && v !== '' && !/^https?:\/\//i.test(v)) {
      if (into.size >= MAX_KEY_FILES) return
      into.add(v)
    }
  }
}

function extractFile(parsed: Record<string, unknown> | null): string {
  if (!parsed) return ''
  for (const key of ['file_path', 'path']) {
    if (typeof parsed[key] === 'string' && parsed[key] !== '') return truncate(parsed[key], FILE_PATH_MAX)
  }
  return ''
}

/** 遍历事件流收集会话事实；单条事件结构不符就跳过，绝不抛错 */
export function collectFacts(events: unknown[]): SessionFacts {
  const facts: SessionFacts = {
    userMessages: [],
    writeEdits: [],
    commands: [],
    gitCommits: [],
    keyFiles: new Set(),
    lastTodo: null,
    lastGoal: '',
    eventCount: events.length,
  }

  for (const ev of events) {
    if (!ev || typeof ev !== 'object' || typeof (ev as { type?: unknown }).type !== 'string') continue
    const e = ev as { type: string; time?: unknown; data?: unknown }
    const data = e.data as Record<string, unknown> | undefined

    switch (e.type) {
      case 'user/message': {
        const source = data?.['source'] as { kind?: unknown } | undefined
        if (source && source.kind === 'user') {
          const text = contentText(data?.['content']).trim()
          if (text !== '') {
            // 保尾弃头：goal 段取 at(-1) 标注「最后一条用户请求」——保头会让长会话取到几百轮前的旧请求
            if (facts.userMessages.length >= MAX_USER_MESSAGES) facts.userMessages.shift()
            facts.userMessages.push({ time: Number.isFinite(e.time) ? (e.time as number) : 0, text: truncate(text, 200) })
          }
        }
        break
      }

      case 'tool/call': {
        const toolName = typeof data?.['name'] === 'string' ? data['name'] : ''
        const parsed = parseArgs(data?.['arguments'])
        if (parsed) collectPaths(parsed, facts.keyFiles)
        if (toolName !== '' && FILE_MUTATING_TOOLS.has(toolName) && facts.writeEdits.length < MAX_WRITE_EDITS) {
          const file = extractFile(parsed)
          if (file !== '') facts.writeEdits.push({ tool: toolName, file })
        }
        if (toolName !== '' && COMMAND_TOOLS.has(toolName) && parsed && typeof parsed['command'] === 'string') {
          const cmd = truncate(parsed['command'], 120)
          if (facts.commands.length >= 10) facts.commands.shift()
          facts.commands.push(cmd)
          if (/\bgit\s+commit\b/.test(parsed['command'])) {
            if (facts.gitCommits.length >= MAX_GIT_COMMITS) facts.gitCommits.shift()
            facts.gitCommits.push(truncate(parsed['command'], 160))
          }
        }
        break
      }

      case 'todo/write': {
        const todos = data?.['todos']
        if (Array.isArray(todos)) {
          facts.lastTodo = todos.filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
        }
        break
      }

      case 'goal/change': {
        if (data && typeof data === 'object') {
          if (data['operation'] === 'clear') {
            facts.lastGoal = ''
          } else {
            const goal = data['goal'] as { objective?: unknown } | undefined
            if (typeof goal?.objective === 'string') facts.lastGoal = goal.objective
          }
        }
        break
      }

      default:
        break
    }
  }

  return facts
}

/** todo 条目 → 协议 tasks 快照（text + status 最小公分母，语义 4：迁快照不迁现场） */
export function todoToTasks(facts: SessionFacts): Array<{ text: string; status: string; priority?: string }> {
  if (!facts.lastTodo) return []
  const VALID = new Set(['pending', 'in_progress', 'completed'])
  const out: Array<{ text: string; status: string; priority?: string }> = []
  for (const t of facts.lastTodo) {
    if (out.length >= MAX_TASKS) break
    const text = typeof t['text'] === 'string' ? t['text'] : typeof t['content'] === 'string' ? t['content'] : ''
    if (text === '') continue
    const rawStatus = typeof t['status'] === 'string' ? t['status'] : 'pending'
    const snap: { text: string; status: string; priority?: string } = {
      text: truncate(text, TASK_TEXT_MAX),
      status: VALID.has(rawStatus) ? rawStatus : 'pending',
    }
    if (typeof t['priority'] === 'string' && t['priority'] !== '') snap.priority = truncate(t['priority'], TASK_PRIORITY_MAX)
    out.push(snap)
  }
  return out
}
