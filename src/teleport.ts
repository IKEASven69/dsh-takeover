/**
 * 云端门内 teleport spike（0.26 · WS-4，预研 §5.2 / 计划-0.26 WS-4）。
 *
 * 定位：验证「以官方 CLI 形态为接入面」——包装 `claude --teleport` 把云会话拉回本地。
 * 本模块是 spike 桩：三件纯函数 + runner 注入，**零接线**（不进注册表 / 路由 / exports，
 * 0.26 只评估不接线；产品化是 0.27 决策点，决策输入 = spike 结论 + cloudroom 动向）。
 *
 * 三件纯函数：
 * 1. 命令组装：`claude --teleport`（交互 picker，人工路径）/ `claude --teleport <session-id>`
 *    （直取）；session-id 经 assertSafeSessionId 消毒（与 core assertSafeId 同级：闭集正则 +
 *    例外即拒）防参数逃逸——id 槽位永远不可能长出 `--flag`、空格、路径段或 shell 元字符。
 * 2. 落盘探测：验证产物是否落 `~/.claude/projects/<project>/<session-id>.jsonl`。
 *    该路径是材料推断（预研附录 B #4，sessions.md:268 存储规则），本模块只做探测与
 *    分类，不据此排产。本机实测（CLI 2.1.220）：本地会话确实落此布局（12 个
 *    `<uuid>.jsonl`，目录名 munge 规则 4/4 吻合）；teleport 产物适用同规则仍待云会话实测。
 * 3. 拉回会话发现对齐评估：扫描 projects 根 → UUID 文件名候选 → 头行 sessionId 对齐，
 *    并给出与既有接管会话读取面（collect.ts collectFacts）的字段模型差异结论。
 *    0.26 只评估——发现结果不喂给任何既有面。
 *
 * runner 注入：runTeleport / runTeleportProbe 接受与 promisify(execFile) 同款签名的
 * runner（(cmd, args, opts) => Promise<{stdout, stderr}>，失败即 reject）——spawn 惯例
 * 先例 sync.ts:144（参数数组不走 shell / 超时硬杀 SIGKILL / windowsHide / maxBuffer）。
 * 单测全走桩，不真跑 claude。
 *
 * 诚实边界：`claude -p --teleport` 未文档化（本机 2.1.220 help 不列），仅 changelog
 * v2.1.323 有一处修复提及（材料引文截断）；本机实测该组合静默失败（exit 1 / 无任何
 * 诊断输出，详见 docs/spike-teleport-0.26.md）——非交互形态不可依赖，本模块不据此排产。
 * 明确不追求（材料已判死）：teleport 双向同步回云、接管私有云接口。
 * @module dsh-takeover/teleport
 */
import { execFile as execFileCb } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

/** claude 进程超时：teleport 含云侧取会话 + git fetch，可能慢，但绝不挂死（对齐 sync.ts 网络面 30s） */
export const TELEPORT_TIMEOUT_MS = 30_000
/** 发现面头行读取上限：只读首行判定 sessionId 对齐，不整读大文件 */
export const TELEPORT_HEAD_MAX_BYTES = 65_536
/** 行数统计上限：超过此字节的文件不数行（lineCount=null），避免大转写拖住发现面 */
export const TELEPORT_LINECOUNT_MAX_BYTES = 5 * 1024 * 1024

// ---------- 会话 id 消毒（assertSafeId 同级：闭集正则 + 例外即拒） ----------

/**
 * claude 本地会话文件名是严格小写 UUID（本机 2.1.220 实测 12/12 全吻合）；
 * 云会话 id 与之同形（picker / claude.ai 复制命令里的 <session-id>）。
 * 闭集：只收 UUID，其余一律拒——参数逃逸面（`--flag`、空格、`;`、路径段、`..`）
 * 全部长不成合法 UUID，天然挡死。
 */
const SAFE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 校验并归一化会话 id：合法 UUID 原样小写返回；其余抛中文错（同级形态照 core
 * assertSafeId——闭集正则不匹配即 throw，不做容错截断）。
 */
export function assertSafeSessionId(id: string): string {
  const norm = typeof id === 'string' ? id.trim().toLowerCase() : ''
  if (!SAFE_SESSION_ID.test(norm)) {
    throw new Error(`非法会话 id：${String(id).slice(0, 60)}（只允许 UUID 形态——防参数逃逸，非 UUID 一律拒收）`)
  }
  return norm
}

/** 文件名形态的 UUID 判定（发现面用，不抛错） */
export function isSafeSessionId(id: string): boolean {
  return SAFE_SESSION_ID.test(id)
}

// ---------- ① 命令组装（纯函数） ----------

/** 组装出的 claude 命令（cmd 固定 'claude'，args 数组不走 shell） */
export interface TeleportCommand {
  cmd: 'claude'
  args: string[]
}

/**
 * ① 命令组装：无 id → `claude --teleport`（交互 picker，人工路径，自动化不可依赖——
 * 预研 §5.2 问 1：文档化自动化获取渠道不存在）；有 id → `claude --teleport <id>`（直取）。
 * id 经 assertSafeSessionId 消毒，任何形态不合法直接抛。
 */
export function buildTeleportCommand(sessionId?: string): TeleportCommand {
  if (sessionId === undefined || sessionId === '') return { cmd: 'claude', args: ['--teleport'] }
  return { cmd: 'claude', args: ['--teleport', assertSafeSessionId(sessionId)] }
}

/**
 * ④ 非交互探针命令：`claude -p --teleport <id>`。该组合未文档化（仅 changelog
 * v2.1.323 修复提及），本机 2.1.220 实测静默失败——此组装只服务 spike 实测，
 * 不构成可用自动化面（详见 docs/spike-teleport-0.26.md 问 4）。
 */
export function buildTeleportProbeCommand(sessionId: string): TeleportCommand {
  return { cmd: 'claude', args: ['-p', '--teleport', assertSafeSessionId(sessionId)] }
}

// ---------- runner（promisify(execFile) 同款签名，注入可桩） ----------

/** 与 promisify(execFile) 同款：成功 resolve {stdout, stderr}，失败 reject（code 携带退出码/ENOENT） */
export type TeleportRunner = (
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>

/** 默认 runner：参数数组不走 shell + 超时硬杀 SIGKILL + windowsHide + maxBuffer（先例 sync.ts:144-154） */
export const defaultTeleportRunner: TeleportRunner = (cmd, args, opts) =>
  execFile(cmd, args, {
    encoding: 'utf-8',
    timeout: opts?.timeoutMs ?? TELEPORT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })

/** runner 执行结果三态分类：ok / cli-missing（ENOENT）/ nonzero（非零退出，含超时硬杀） */
export interface TeleportOutcome {
  ok: boolean
  kind: 'ok' | 'cli-missing' | 'nonzero'
  stdout: string
  stderr: string
  /** 中文说明：CLI 缺席 / 失败细节（静默失败时如实标注「无诊断输出」） */
  error?: string
}

/** 统一分类：runner reject → ENOENT = CLI 缺席；killed = 超时硬杀；其余 = 非零退出。绝不 throw */
function classify(run: Promise<{ stdout: string; stderr: string }>): Promise<TeleportOutcome> {
  return run.then(
    (r) => ({ ok: true, kind: 'ok' as const, stdout: r.stdout, stderr: r.stderr }),
    (e: unknown) => {
      const err = e as { code?: unknown; killed?: boolean; message?: string; stderr?: string; stdout?: string }
      if (err?.code === 'ENOENT') {
        return { ok: false, kind: 'cli-missing', stdout: '', stderr: '', error: 'claude CLI 不在 PATH——teleport 前提缺失（安装/登录属用户环境）' }
      }
      const detail = (err?.stderr ?? err?.stdout ?? '').trim()
      if (err?.killed === true) {
        return { ok: false, kind: 'nonzero', stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), error: `claude 超时被硬杀（${TELEPORT_TIMEOUT_MS / 1000}s）——网络不可达或进程挂死` }
      }
      // 本机 2.1.220 实测：-p --teleport 静默失败（exit 1 / 无 stdout / 无 stderr）——如实标注，不粉饰
      const where = detail !== '' ? detail.slice(0, 400) : '无诊断输出（静默失败形态）'
      return { ok: false, kind: 'nonzero', stdout: String(err?.stdout ?? ''), stderr: String(err?.stderr ?? ''), error: `claude 非零退出：${where}` }
    },
  )
}

/**
 * 执行直取形态 `claude --teleport <id>`（runner 可注入；单测全走桩）。
 * 注意：picker 形态（无 id）是交互人工路径，自动化面不暴露——需要 id 才能跑。
 */
export function runTeleport(
  opts: { sessionId: string; timeoutMs?: number },
  runner: TeleportRunner = defaultTeleportRunner,
): Promise<TeleportOutcome> {
  const { cmd, args } = buildTeleportCommand(opts.sessionId)
  return classify(runner(cmd, args, { timeoutMs: opts.timeoutMs }))
}

/** 执行非交互探针 `claude -p --teleport <id>`（spike 实测专用，见 buildTeleportProbeCommand 注记） */
export function runTeleportProbe(
  opts: { sessionId: string; timeoutMs?: number },
  runner: TeleportRunner = defaultTeleportRunner,
): Promise<TeleportOutcome> {
  const { cmd, args } = buildTeleportProbeCommand(opts.sessionId)
  return classify(runner(cmd, args, { timeoutMs: opts.timeoutMs }))
}

// ---------- ② 落盘探测（纯函数 + fs 注入，fail-open 分类不抛） ----------

/**
 * 项目路径 → claude projects 目录名 munge。规则系推断（预研附录 B #4）：非
 * `[A-Za-z0-9_-]` 字符折叠为 `-`。本机 2.1.220 实测 4/4 目录吻合（此处以中性
 * 路径示意）：`D:\CodingProjects\sample-proj` → `D--CodingProjects-sample-proj`、
 * `C:\Users\someone` → `C--Users-someone`。
 * 非官方文档规则，上游可变（spike 报告问 3 有注记）。
 */
export function mungeProjectDir(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9_-]/g, '-')
}

/** 推断的 teleport 产物 JSONL 路径（纯路径组合，不碰 fs）：<root>/projects/<munged>/<id>.jsonl */
export function teleportJsonlPath(
  sessionId: string,
  deps?: { projectPath: string; home?: string; claudeRoot?: string },
): string {
  const id = assertSafeSessionId(sessionId)
  const root = deps?.claudeRoot ?? join(deps?.home ?? homedir(), '.claude')
  return join(root, 'projects', mungeProjectDir(deps?.projectPath ?? ''), `${id}.jsonl`)
}

/** 落盘探测结果四态：invalid-id / missing / found / unreadable（越权与 IO 错误 fail-open 分类，绝不 throw） */
export type TeleportArtifactProbe =
  | { state: 'invalid-id'; path: string; note: string }
  | { state: 'missing'; path: string; note: string }
  | { state: 'found'; path: string; size: number; mtimeMs: number; note: string }
  | { state: 'unreadable'; path: string; note: string }

export interface TeleportArtifactDeps {
  /** 拉回会话所属项目（决定 munge 目录），必填——本模块不偷读 process.cwd() */
  projectPath: string
  home?: string
  claudeRoot?: string
  exists?: (p: string) => boolean
  stat?: (p: string) => { size: number; mtimeMs: number }
}

/**
 * ② 落盘探测：推断路径上有没有 `<session-id>.jsonl`。逐层防御：
 * id 非法 → invalid-id（fs 注入桩根本不被触碰）；不存在 → missing；
 * stat 抛错（EPERM/越权/竞态）→ unreadable（fail-open 收编为规范值）；存在 → found。
 * 探测到 found 只说明「本地有同 id 转写」，**不证明**它来自 teleport（本地会话同布局）——
 * 溯源是 0.27 决策点（见 spike 报告问 3）。
 */
export function probeTeleportArtifact(sessionId: string, deps: TeleportArtifactDeps): TeleportArtifactProbe {
  const root = deps.claudeRoot ?? join(deps.home ?? homedir(), '.claude')
  let path: string
  try {
    path = teleportJsonlPath(sessionId, { projectPath: deps.projectPath, home: deps.home, claudeRoot: deps.claudeRoot })
  } catch (e) {
    return { state: 'invalid-id', path: '', note: e instanceof Error ? e.message : String(e) }
  }
  // 纵深防御：组合出的路径必须仍落在 <root>/projects 解析域内（id 已闭集消毒，理论不可达，
  // 但 claudeRoot 等入参来自调用方——越权组合直接拒收为 invalid-id，不碰 fs）
  const domain = resolve(root, 'projects')
  const abs = resolve(path)
  if (!abs.startsWith(domain + sep)) {
    return { state: 'invalid-id', path, note: '组合路径越出 projects 解析域（纵深防御拒收）' }
  }
  const exists = deps.exists ?? existsSync
  if (!exists(abs)) {
    return { state: 'missing', path: abs, note: '推断路径无产物——teleport 未执行、落点与推断不符、或该会话本就不存在' }
  }
  try {
    const st = (deps.stat ?? ((p: string) => {
      const s = statSync(p)
      return { size: s.size, mtimeMs: s.mtimeMs }
    }))(abs)
    return { state: 'found', path: abs, size: st.size, mtimeMs: st.mtimeMs, note: '' }
  } catch (e) {
    return { state: 'unreadable', path: abs, note: `产物存在但不可读（越权/占用/竞态，fail-open）：${e instanceof Error ? e.message.slice(0, 200) : String(e)}` }
  }
}

// ---------- ③ 拉回会话发现对齐评估（0.26 只评估不接线） ----------

export interface TeleportCandidate {
  path: string
  /** 文件名去扩展名；严格 UUID 才有 sessionId，其余 null（不采信） */
  sessionId: string | null
  size: number | null
  mtimeMs: number | null
  /** 文件行数（压缩截断评估的原始量：teleport 产物行数显著偏短 = 被摘要截断的旁证）；超限/读不了为 null */
  lineCount: number | null
  /** 头行 JSON 的 sessionId 字段值（本机实测：claude JSONL 每行携带 sessionId） */
  headSessionId: string | null
  /** 对齐锚点：文件名 UUID === 头行 sessionId（读不出头行时 false 并注记） */
  aligns: boolean
  note: string
}

export interface TeleportAlignmentReport {
  ok: boolean
  scannedRoot: string
  projectDirs: number
  candidates: TeleportCandidate[]
  /** 与既有接管会话读取面的对齐评估结论（静态、材料+实测依据，见 ALIGNMENT_NOTES） */
  alignmentNotes: readonly string[]
  /** projects 根不存在等场景：探测本身无异常但结果为空（fail-open 规范值，对齐 collect.ts ProbeResult 形态） */
  skipped: boolean
  note: string
}

/**
 * 对齐评估结论（0.26 只评估不接线——这些 note 就是接线差距清单，0.27 决策输入）。
 * 依据：collect.ts:132 collectFacts 消费 `{type, time, data}` 事件模型（probeSessionEvents
 * 契约）；本机 2.1.220 实测 claude 本地转写行形为 `{type, timestamp, sessionId, ...}`
 * （首行 type=queue-operation）。字段模型不同 → 接线必须写显式适配层，非零成本。
 */
export const ALIGNMENT_NOTES: readonly string[] = [
  '字段模型不同：既有接管面（collect.ts collectFacts，事件形 {type,time,data}）与 claude 本地转写行形 {type,timestamp,sessionId,message…} 不是同一模型——拉回会话纳入接管模型需要显式适配层（映射 + 蒸馏上限复用），0.26 不写。',
  '会话对象来源不同：接管面吃宿主注入的 session 对象（probeSessionEvents），teleport 拉回的是落盘 JSONL——需要一个「从 JSONL 构造只读会话视图」的桥，稳定性取决于上游转写格式（上游语义可变风险，changelog v2.0.41/v2.1.323 均有先例）。',
  '发现面本身零障碍：文件名=严格 UUID、目录=munge 项目路径、每行携带 sessionId 可作对齐锚点（本机 12/12 实测吻合）——若 0.27 决定接线，发现层可直接复用本模块纯函数。',
]

export interface TeleportDiscoveryDeps {
  home?: string
  claudeRoot?: string
  /** 直接指定扫描根（测试桩用）；缺省 <claudeRoot>/projects */
  projectsRoot?: string
  listDir?: (p: string) => string[]
  readHead?: (p: string, maxBytes: number) => string
  stat?: (p: string) => { size: number; mtimeMs: number }
  /** 全文件行数（压缩截断旁证）；超上限/读不了返回 null */
  countLines?: (p: string) => number | null
}

/**
 * ③ 发现对齐评估：扫 projects 根 → 逐目录收 `*.jsonl` → 文件名严格 UUID 判候选 →
 * 头行 sessionId 对齐 → 附对齐结论。任何一层失败都 fail-open 收编（根不存在 =
 * skipped 规范值；单文件读不了 = 留名录但 aligns=false + 注记），绝不 throw。
 * 0.26 只评估：返回值不进任何注册表/路由/state。
 */
export function evaluateTeleportDiscovery(deps?: TeleportDiscoveryDeps): TeleportAlignmentReport {
  const root = deps?.claudeRoot ?? join(deps?.home ?? homedir(), '.claude')
  const projectsRoot = deps?.projectsRoot ?? join(root, 'projects')
  const listDir = deps?.listDir ?? ((p: string) => readdirSync(p))
  const readHead = deps?.readHead ?? ((p: string, maxBytes: number) => {
    // 只读前 maxBytes 字节（open/read 定长读，大转写不整载）
    let fd: number | undefined
    try {
      fd = openSync(p, 'r')
      const buf = Buffer.alloc(maxBytes)
      const n = readSync(fd, buf, 0, maxBytes, 0)
      return buf.subarray(0, n).toString('utf-8')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  })
  const stat = deps?.stat ?? ((p: string) => {
    const s = statSync(p)
    return { size: s.size, mtimeMs: s.mtimeMs }
  })
  const countLines = deps?.countLines ?? ((p: string): number | null => {
    try {
      const buf = readFileSync(p)
      if (buf.length > TELEPORT_LINECOUNT_MAX_BYTES) return null // 超大转写不数行（如实留空）
      let n = 0
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++
      return n
    } catch {
      return null
    }
  })

  let projectDirs: string[]
  try {
    projectDirs = listDir(projectsRoot).filter((d) => d !== '.' && d !== '..')
  } catch (e) {
    return {
      ok: true,
      scannedRoot: projectsRoot,
      projectDirs: 0,
      candidates: [],
      alignmentNotes: ALIGNMENT_NOTES,
      skipped: true,
      note: `projects 根不可达（claude 未安装或无本地会话，fail-open）：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
    }
  }

  const candidates: TeleportCandidate[] = []
  for (const dir of projectDirs) {
    let files: string[]
    try {
      files = listDir(join(projectsRoot, dir))
    } catch {
      continue // 单目录不可读：跳过（fail-open）
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const base = f.slice(0, -'.jsonl'.length)
      const path = join(projectsRoot, dir, f)
      const sessionId = isSafeSessionId(base) ? base : null
      const cand: TeleportCandidate = {
        path,
        sessionId,
        size: null,
        mtimeMs: null,
        lineCount: null,
        headSessionId: null,
        aligns: false,
        note: sessionId === null ? '文件名非 UUID——不是 claude 本地会话命名，不采信' : '',
      }
      try {
        const st = stat(path)
        cand.size = st.size
        cand.mtimeMs = st.mtimeMs
      } catch (e) {
        cand.note = `stat 失败（fail-open）：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`
        candidates.push(cand)
        continue
      }
      try {
        const head = readHead(path, TELEPORT_HEAD_MAX_BYTES)
        const nl = head.indexOf('\n')
        const firstLine = nl === -1 ? head : head.slice(0, nl)
        try {
          const o = JSON.parse(firstLine) as { sessionId?: unknown }
          if (typeof o?.sessionId === 'string' && isSafeSessionId(o.sessionId)) cand.headSessionId = o.sessionId
        } catch {
          cand.note = '头行非 JSON（fail-open，照录不采信）'
        }
        if (cand.size !== null && cand.size <= TELEPORT_LINECOUNT_MAX_BYTES) {
          cand.lineCount = countLines(path)
        }
      } catch (e) {
        cand.note = `头行读取失败（fail-open）：${e instanceof Error ? e.message.slice(0, 120) : String(e)}`
      }
      cand.aligns = cand.sessionId !== null && cand.headSessionId === cand.sessionId
      candidates.push(cand)
    }
  }

  return {
    ok: true,
    scannedRoot: projectsRoot,
    projectDirs: projectDirs.length,
    candidates,
    alignmentNotes: ALIGNMENT_NOTES,
    skipped: false,
    note: '',
  }
}
