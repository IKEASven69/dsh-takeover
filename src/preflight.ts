/**
 * 接管预检「接得住吗」三档判定卡：/resume-* 注入外来会话内容**之前**先出一张判定卡——
 * 可直接接管 / 带伤接管（逐条列伤）/ 建议放弃，死活、日志完整性、体量、文件现场、
 * 读取器降级五项全查，不再接完才踩坑。
 *
 * 需求出处（docs/需求调研-1119.md）：TOP 缺口 #1（:22 逐字）「接管前死活+兼容性预检 →
 * 体检分级可直接接管/带伤接管（列伤）/拒绝」（调研裁定 0.26.1 顺位，本模块先落判定面）；
 * 双独立信号同月撞车（:14）hkkz9522#61「2 千会话里找运行中的」+ context#266
 * Running-only filter——接管前须知死活。
 *
 * 输入是集成面已取回的 foreign_session_read show 结构化摘要（README.md:84：轮数 /
 * 涉及文件 top15 / 尾部进展）+ 读取器适配注记（src/foreign.ts:39 adapterNote
 * { supported, note } 同构，本地解耦手写不 import foreign.ts）+ now + 注入式
 * 存在性探测。纯函数、确定性：同输入同判定；零子进程零写盘（负向断言随
 * tests/preflight.spec.ts）；不 import tools.ts 等七个集成面文件。
 *
 * 检查项 kind 五值闭集（新增 = 改这里 + 头注清单 + 测试）：
 * - `liveness` 死活：最近活动时刻 → 近端/远端/缺时刻三桶（启发式分桶阈值 24 小时）。
 *   绝不输出「正在运行」类断言——running 筛选列属 0.26.1 另案，这里只如实分桶
 *   「最近活动」；缺时刻/不可解析 → unknown（死活未知），绝不编造活性。
 * - `integrity` 日志完整性：foreign_session_read 返回 ok:false（读侧会话损坏/加密/
 *   格式不可恢复的规范失败值，foreign.ts 契约「绝不抛出，失败回 { ok:false }」），
 *   或空会话（轮数 0，foreign.ts 空会话按 UNAVAILABLE 口径）→ wound（建议放弃档）；
 *   返回值缺失/缺 ok 或轮数字段 → unknown，绝不冒充「完整」。
 * - `bulk` 体量：只陈述读取器原样观察值（轮数/用户轮/涉及文件在册数/尾部进展条数），
 *   非接管代价预估——context #240「估算与实际出入大」前车之鉴
 *  （docs/需求调研-1119.md:27），官方 contextPressure 投影不接就不做预估；
 *   输出文案不含任何估算词（预计/约/耗时/token，测试负向断言钉死）。
 * - `scene` 文件现场：top15 涉及文件在本盘存在性探测（探测注入可桩，缺省
 *   fs.existsSync）。跨机常态缺文件如实逐条列（「7 个涉及文件不在本盘」的第一眼
 *   价值）；探测抛错（symlink/权限等）= 未确认，不编造缺盘也不编造在盘；相对路径
 *   按摘要 cwd 解析，无 cwd 则如实未确认。
 * - `reader` 读取器降级：supported=false 或降级注记非空 → wound（README.md:62
 *   mimo/goose 两家诚实降级先例同口径：候选不命中如实标注，不粉饰成正常）。
 *
 * 三档判定立约 { verdict, checks[], wounds[], basis }（契约字段只此四件，不夹带）：
 * - `decline` 建议放弃：仅 integrity 出 wound（日志读不出/空会话，接管没有日志基础）；
 * - `wounded` 带伤接管：存在任一 wound（逐条可点：scene item=缺失文件路径、
 *   reader item=provider 名、integrity item=错误摘要）；
 * - `ready` 可直接接管：零 wound。仅 liveness unknown 也落 ready——basis 注明死活未知。
 * 检查项三态 ok / wound / unknown：unknown 是 fail-open 缺省态，只降级不升档——
 * unknown 永不产生 wound、永不触发 decline。
 *
 * fail-open 硬纪律（同 receipt.ts / flightcheck.ts：预检绝不拦真实接管）：任一检查项
 * 抛错 = 该项 unknown 如实缺省（「该项检查中断」入 detail），assessForeignTakeover
 * 整体绝不抛（坏输入/投毒 getter 均不抛）。
 *
 * 诚实边界（docs/预研-0.26.md:26-27 + src/collect.ts:42-52 封顶失真先例）：读取摘要
 * 自带封顶（files top15、tailProgress 3 条、commands 10 条），本模块只转述读取器
 * 原样字段，不推算、不补差、不预估；bulk 在册数是「读取器给到多少」不是「会话有多少」。
 *
 * 集成面接线立约（本模块不改 tools/server/client/settings/index/locales/collect 七个
 * 集成面文件；挂点归集成面，行号对 0.26 工作树）：
 * ```
 * // 工具面：foreign_session_read 取回 show 规范值之后、注入当前轮之前（挂点
 * // src/index.ts:45 registerForeignTool 的 execute 链路，或 /resume-* 模板
 * // skills/resume.ts:35 resumeSkillContent 指引模型先跑预检再注入）：
 * const read = await foreignSessionRead({ provider, action: 'show', reference })
 * const card = assessForeignTakeover({
 *   read,                                                    // show 规范值原样透传（含 ok:false）
 *   adapterNote: readers.adapterNote(PROVIDER_TO_ADAPTER[provider]),   // src/foreign.ts:39
 *   now: new Date(),
 *   // exists 缺省 fs.existsSync；沙箱/面板可注入
 * })
 * // 面板面：外部会话浏览器「接管」按钮（src/client.ts:697）按下后先调预检接口：
 * // card.verdict==='decline' → 注入前置拦停，basis 呈给用户；
 * // 'wounded' → wounds 逐条浮出（item 可点）后由用户确认放行；
 * // 'ready' → 直接放行（basis 仍含死活/未核验附注，不吞）。
 * ```
 *
 * @module dsh-takeover/preflight
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 检查项 kind 五值闭集：开集没法出固定四件套判定卡，也没法钉估算词负向断言 */
export const PREFLIGHT_KINDS = ['liveness', 'integrity', 'bulk', 'scene', 'reader'] as const
export type PreflightKind = (typeof PREFLIGHT_KINDS)[number]

/** 检查项三态：ok=过 / wound=带伤发现 / unknown=未核验（fail-open 缺省态，只降级不升档） */
export const PREFLIGHT_STATES = ['ok', 'wound', 'unknown'] as const
export type PreflightCheckState = (typeof PREFLIGHT_STATES)[number]

/** 三档判定闭集（docs/需求调研-1119.md:22 三档语言逐字：可直接接管/带伤接管（列伤）/拒绝） */
export const PREFLIGHT_VERDICTS = ['ready', 'wounded', 'decline'] as const
export type PreflightVerdict = (typeof PREFLIGHT_VERDICTS)[number]

/** 单检查项结果（checks 数组条目，固定序 [liveness, integrity, bulk, scene, reader]） */
export interface PreflightCheck {
  kind: PreflightKind
  state: PreflightCheckState
  /** 人读细节：只转述读取器原样字段与探测结果，不含估算词（预计/约/耗时/token） */
  detail: string
}

/** 单条伤（逐条可点：item = 缺失文件路径 / provider 名 / 错误摘要） */
export interface PreflightWound {
  kind: PreflightKind
  /** 可点主体：缺失文件路径 / provider 名 / 错误摘要 */
  item: string
  detail: string
}

/** 三档判定卡（立约字段只此四件，不夹带其它键） */
export interface PreflightCard {
  verdict: PreflightVerdict
  checks: PreflightCheck[]
  wounds: PreflightWound[]
  basis: string
}

export interface PreflightInput {
  /** 集成面已取回的 foreign_session_read 返回值（action=show 规范值原样透传，含 ok:false
   * 失败值）。防御式收窄：坏形态（非 object/缺字段）按该项 unknown 缺省，绝不抛 */
  read: unknown
  /** 读取器适配情况（src/foreign.ts:39 adapterNote { supported, note } 同构；缺省=unknown） */
  adapterNote?: unknown
  /** 预检时刻（可桩；缺省 new Date()——确定性断言请显式传） */
  now?: Date | string | number
  /** 存在性探测注入可桩（缺省 fs.existsSync；探测抛错 = 未确认，不编造缺盘也不编造在盘） */
  exists?: (path: string) => boolean
}

/** liveness 启发式分桶阈值：最近活动落在预检时刻前 24 小时内记「近端」，更早记「远端」。
 * 分桶只是「最近活动早晚」，不是运行状态判定——running 精判属 0.26.1 另案 */
export const LIVENESS_RECENT_MS = 24 * 60 * 60 * 1000

/** scene 检查项 detail 内联列举上限（wounds 数组仍逐条全量不封顶——top15 至多 15 条伤） */
const SCENE_LIST_MAX = 5

/** 单路径探测长度闸（超长按不合法形态跳过不做存在性断言，flightcheck FILE_REF_PATH_MAX 同款） */
const PATH_PROBE_MAX = 512

/** 外来串进卡净化截断上限（错误/注记/路径，flightcheck sanitizeLine 同款上限） */
const EMBED_MAX = 200

// ---------------------------------------------------------------------------
// 局部防御工具（本模块不 import tools.ts / flightcheck.ts，照 flightcheck 头注先例
// 按同口径实现局部净化——拖进整条管线换一行复用不值）
// ---------------------------------------------------------------------------

const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** 可靠错误文案（未知抛出物兜底成字符串；String 自身再炸也兜住） */
function readable(e: unknown): string {
  try {
    return e instanceof Error ? e.message : String(e)
  } catch {
    return '未知异常'
  }
}

/** 外来串净化成单行短串（换行压空格 + 控制字符剥离 + 截断）——错误/注记/路径进卡前过一道 */
function embed(s: unknown, max = EMBED_MAX): string {
  if (typeof s !== 'string') return ''
  return s.replace(/\r\n?|\n/g, ' ').replace(CTRL_RE, '').trim().slice(0, max)
}

/** 防御式对象收窄：null/数组/标量一律不算对象 */
function objOf(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function strOf(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 非负整数字段收窄（轮数/用户轮——负数与分数不是合法观察值） */
function intOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

/** 字符串数组字段收窄（files / tailProgress——混入非字符串条目剔除后计数） */
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** now 字段收窄：Date/ISO 串/毫秒数均可，坏形态回退 Date.now()（确定性断言须显式传） */
function nowMsOf(raw: unknown): number {
  if (raw instanceof Date) {
    const t = raw.getTime()
    return Number.isFinite(t) ? t : Date.now()
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw !== '') {
    const t = Date.parse(raw)
    if (!Number.isNaN(t)) return t
  }
  return Date.now()
}

// ---------------------------------------------------------------------------
// 五检查项（各自全防御式取数，正常路径不抛；意外抛错由 runOne 兜成 unknown）
// ---------------------------------------------------------------------------

/** liveness 死活：最近活动时刻三桶（近端/远端/缺时刻），启发式分桶非运行状态断言 */
function checkLiveness(read: unknown, nowMs: number): PreflightCheck {
  const summary = objOf(objOf(read)?.['summary'])
  const raw = summary === null ? '' : strOf(summary['updatedAt'])
  if (raw === '') {
    return {
      kind: 'liveness',
      state: 'unknown',
      detail: summary === null
        ? 'show 摘要缺失，最近活动时刻无从读取，死活未知'
        : '摘要缺最近活动时刻（读取器未提供或为空），死活未知',
    }
  }
  const t = Date.parse(raw)
  if (Number.isNaN(t)) {
    return { kind: 'liveness', state: 'unknown', detail: `最近活动时刻不可解析（${embed(raw, 60)}），死活未知` }
  }
  const near = nowMs - t <= LIVENESS_RECENT_MS
  return {
    kind: 'liveness',
    state: 'ok',
    detail: near
      ? `最近活动 ${raw}（近端：预检时刻前 24 小时内）`
      : `最近活动 ${raw}（远端：早于预检时刻 24 小时——可能已被他端弃置或久未续跑；启发式分桶，非运行状态断言）`,
  }
}

/** integrity 检查产物：check + integrity wound（decline 唯一来源） */
type IntegrityOut = { check: PreflightCheck; wounds: PreflightWound[] }

/** integrity 日志完整性：read ok:false 或空会话（轮数 0）→ wound（建议放弃档唯一来源） */
function checkIntegrity(read: unknown): IntegrityOut {
  const obj = objOf(read)
  if (obj === null) {
    return {
      check: { kind: 'integrity', state: 'unknown', detail: 'foreign_session_read 返回值缺失或非对象，日志完整性未能核验' },
      wounds: [],
    }
  }
  const ok = obj['ok']
  if (ok !== true) {
    const err = embed(obj['error'])
    if (ok === false) {
      // ok:false = 读取器规范失败值（探测/解析失败的确定性读不出），照 README.md:84 契约不抛而回失败值
      const detail = `foreign_session_read 返回失败：${err !== '' ? err : '未附错误说明'}——会话日志读不出来，接管没有日志基础`
      const item = err !== '' ? embed(obj['error'], 80) : '读取失败'
      return { check: { kind: 'integrity', state: 'wound', detail }, wounds: [{ kind: 'integrity', item, detail }] }
    }
    return {
      check: { kind: 'integrity', state: 'unknown', detail: '返回值未含确定的 ok 成败标记，日志完整性未能核验' },
      wounds: [],
    }
  }
  const summary = objOf(obj['summary'])
  if (summary === null) {
    return { check: { kind: 'integrity', state: 'unknown', detail: 'ok:true 但 show 摘要缺失，日志完整性未能核验' }, wounds: [] }
  }
  const turns = intOf(obj['turnsTotal']) ?? intOf(summary['turnCount'])
  if (turns === null) {
    return { check: { kind: 'integrity', state: 'unknown', detail: '摘要缺轮数字段，日志完整性未能核验' }, wounds: [] }
  }
  if (turns === 0) {
    // 空会话：foreign.ts 空会话口径「记录损坏、加密或格式不可恢复（按 UNAVAILABLE 处理）」
    const note = embed(obj['note'])
    const detail = `空会话：轮数为 0（记录为空、损坏或加密，按 UNAVAILABLE 处理）${note !== '' ? `：${note}` : ''}`
    return { check: { kind: 'integrity', state: 'wound', detail }, wounds: [{ kind: 'integrity', item: '空会话', detail }] }
  }
  return { check: { kind: 'integrity', state: 'ok', detail: `foreign_session_read 成功返回，${turns} 轮在册` }, wounds: [] }
}

/** bulk 体量：只陈述读取器原样观察值（轮数/用户轮/涉及文件在册数/尾部进展条数），
 * 非接管代价预估（context #240 前车之鉴）——检查项 detail 与全卡输出均不含估算词 */
function checkBulk(read: unknown): PreflightCheck {
  const obj = objOf(read)
  if (obj === null || obj['ok'] !== true) {
    return { kind: 'bulk', state: 'unknown', detail: '读取摘要未取回，体量观察值无从陈述' }
  }
  const summary = objOf(obj['summary'])
  if (summary === null) {
    return { kind: 'bulk', state: 'unknown', detail: 'show 摘要缺失，体量观察值无从陈述' }
  }
  const parts: string[] = []
  const turnCount = intOf(summary['turnCount']) ?? intOf(obj['turnsTotal'])
  if (turnCount !== null) parts.push(`轮数 ${turnCount}`)
  const userTurns = intOf(summary['userTurns'])
  if (userTurns !== null) parts.push(`用户轮 ${userTurns}`)
  if (Array.isArray(summary['files'])) parts.push(`涉及文件在册 ${strArray(summary['files']).length} 项（读取器 top15 封顶清单）`)
  if (Array.isArray(summary['tailProgress'])) parts.push(`尾部进展摘录 ${strArray(summary['tailProgress']).length} 条（读取器封顶 3 条）`)
  if (parts.length === 0) {
    return { kind: 'bulk', state: 'unknown', detail: '摘要缺观察值字段（轮数/文件清单/尾部进展），体量无从陈述' }
  }
  return { kind: 'bulk', state: 'ok', detail: `${parts.join('；')}——均为读取器原样字段转述，非本模块推算` }
}

/** scene 检查产物：check + 逐条缺文件 wound */
type SceneOut = { check: PreflightCheck; wounds: PreflightWound[] }

/** 单路径三态探测：true 在盘 / false 确认不在盘 / null 未确认（探测抛错、相对路径无 cwd） */
function probeOne(p: string, cwd: string, probe: (path: string) => boolean): boolean | null {
  const trimmed = p.trim()
  if (trimmed === '' || trimmed.length > PATH_PROBE_MAX) return null
  const absolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')
  try {
    if (absolute) return probe(trimmed) === true
    if (cwd !== '') return probe(join(cwd, trimmed)) === true
    return null // 相对路径且无 cwd：探无处可探，如实未确认（不编造缺盘）
  } catch {
    return null // symlink/权限等探测异常 = 未确认（不编造缺盘也不编造在盘）
  }
}

/** scene 文件现场：top15 涉及文件在本盘存在性，跨机常态缺文件逐条列伤 */
function checkScene(read: unknown, probe: (path: string) => boolean): SceneOut {
  const summary = objOf(objOf(read)?.['summary'])
  if (summary === null) {
    return { check: { kind: 'scene', state: 'unknown', detail: 'show 摘要缺失，无文件现场可核' }, wounds: [] }
  }
  const files = strArray(summary['files'])
  if (files.length === 0) {
    return { check: { kind: 'scene', state: 'ok', detail: '摘要无涉及文件清单，无本盘现场可核' }, wounds: [] }
  }
  const cwd = embed(summary['cwd'])
  const missing: string[] = []
  const unconfirmed: string[] = []
  for (const p of files) {
    const v = probeOne(p, cwd, probe)
    if (v === true) continue
    if (v === false) missing.push(p)
    else unconfirmed.push(p)
  }
  const wounds: PreflightWound[] = missing.map((p) => ({
    kind: 'scene',
    item: p,
    detail: `涉及文件不在本盘（跨机常态）：${p}`,
  }))
  if (missing.length > 0) {
    const listed = missing.slice(0, SCENE_LIST_MAX).join('、')
    const more = missing.length > SCENE_LIST_MAX ? `（另 ${missing.length - SCENE_LIST_MAX} 项略，wounds 逐条全列）` : ''
    const extra = unconfirmed.length > 0 ? `；另 ${unconfirmed.length} 项探测异常未能确认` : ''
    return {
      check: { kind: 'scene', state: 'wound', detail: `${missing.length}/${files.length} 个涉及文件不在本盘：${listed}${more}${extra}` },
      wounds,
    }
  }
  if (unconfirmed.length > 0) {
    return {
      check: { kind: 'scene', state: 'unknown', detail: `${unconfirmed.length}/${files.length} 项存在性未能确认（探测异常按未确认缺省，不编造在盘也不编造缺盘）` },
      wounds: [],
    }
  }
  return { check: { kind: 'scene', state: 'ok', detail: `涉及文件 ${files.length} 项全部在本盘` }, wounds: [] }
}

/** reader 检查产物：check + reader wound */
type ReaderOut = { check: PreflightCheck; wounds: PreflightWound[] }

/** reader 读取器降级：supported=false 或降级注记非空 → wound（README.md:62 mimo/goose 先例同口径） */
function checkReader(adapterNote: unknown, provider: string): ReaderOut {
  const o = objOf(adapterNote)
  if (o === null) {
    return { check: { kind: 'reader', state: 'unknown', detail: '未获读取器适配注记，支持情况未知' }, wounds: [] }
  }
  const supported = o['supported']
  const note = embed(o['note'])
  if (supported === false) {
    const detail = `读取器不可用${note !== '' ? `：${note}` : ''}——该家会话可能读不出完整原文（README 支持面分层：mimo/goose 诚实降级同口径，候选不命中如实标注）`
    return { check: { kind: 'reader', state: 'wound', detail }, wounds: [{ kind: 'reader', item: provider, detail }] }
  }
  if (supported === true) {
    if (note !== '') {
      const detail = `读取器降级注记：${note}——带注记接管，原文可能不完整`
      return { check: { kind: 'reader', state: 'wound', detail }, wounds: [{ kind: 'reader', item: provider, detail }] }
    }
    return { check: { kind: 'reader', state: 'ok', detail: '读取器支持该家且无降级注记' }, wounds: [] }
  }
  return { check: { kind: 'reader', state: 'unknown', detail: '适配注记缺 supported 字段，支持情况未知' }, wounds: [] }
}

/** 检查项产物统一形（liveness/bulk 无伤位，恒空 wounds） */
type CheckOut = { check: PreflightCheck; wounds: PreflightWound[] }

/** fail-open 执行器：任一检查项抛错 = 该项 unknown 如实缺省，绝不向上抛 */
function runOne(kind: PreflightKind, fn: () => CheckOut): CheckOut {
  try {
    return fn()
  } catch (e) {
    return {
      check: { kind, state: 'unknown', detail: `该项检查中断（预检内部异常，如实缺省）：${readable(e)}` },
      wounds: [],
    }
  }
}

// ---------------------------------------------------------------------------
// 三档判定
// ---------------------------------------------------------------------------

/** basis 组装：decline 点名 integrity 原因 / wounded 逐条点名 / ready 附死活与未核验附注 */
function composeBasis(verdict: PreflightVerdict, checks: PreflightCheck[], wounds: PreflightWound[]): string {
  const parts: string[] = []
  if (verdict === 'decline') {
    const integ = checks.find((c) => c.kind === 'integrity')
    parts.push(`建议放弃接管：${integ?.detail ?? '日志完整性未过'}`)
  } else if (verdict === 'wounded') {
    const head = wounds.slice(0, SCENE_LIST_MAX).map((w) => `[${w.kind}] ${w.item}`).join('；')
    const more = wounds.length > SCENE_LIST_MAX ? `（另 ${wounds.length - SCENE_LIST_MAX} 条略）` : ''
    parts.push(`带伤接管：${wounds.length} 处伤——${head}${more}（逐条见 wounds）`)
  } else {
    const allUnknown = checks.every((c) => c.state === 'unknown')
    parts.push(allUnknown
      ? '五项检查均未核验成功——本卡不构成健康背书，接管前请人工确认现场'
      : '可直接接管')
  }
  const live = checks.find((c) => c.kind === 'liveness')
  if (live?.state === 'unknown') parts.push(`死活未知：${live.detail}`)
  else if (live?.state === 'ok') parts.push(live.detail)
  const unknownKinds = checks.filter((c) => c.state === 'unknown' && c.kind !== 'liveness').map((c) => c.kind)
  if (unknownKinds.length > 0 && unknownKinds.length < checks.length) {
    parts.push(`${unknownKinds.join('、')} 未核验（详见 checks）`)
  }
  return parts.join('。')
}

/**
 * 接管预检三档判定（纯函数，确定性：同输入同卡）。五检查项固定序进 checks；
 * unknown 只降级不升档（永不产生 wound、永不触发 decline）；整体绝不抛（fail-open，
 * 预检绝不拦真实接管）。本模块零子进程零写盘：唯一下游是注入式存在性探测。
 */
export function assessForeignTakeover(input: PreflightInput): PreflightCard {
  try {
    const inp = objOf(input) ?? {}
    const read: unknown = inp['read']
    const nowMs = nowMsOf(inp['now'])
    const existsRaw = inp['exists']
    const probe = typeof existsRaw === 'function' ? (existsRaw as (path: string) => boolean) : ((p: string) => existsSync(p))
    const provider = embed(objOf(read)?.['provider'], 40) || 'unknown-provider'

    const live = runOne('liveness', () => ({ check: checkLiveness(read, nowMs), wounds: [] }))
    const integ = runOne('integrity', () => checkIntegrity(read))
    const bulk = runOne('bulk', () => ({ check: checkBulk(read), wounds: [] }))
    const scene = runOne('scene', () => checkScene(read, probe))
    const reader = runOne('reader', () => checkReader(inp['adapterNote'], provider))

    const checks: PreflightCheck[] = [live.check, integ.check, bulk.check, scene.check, reader.check]
    const wounds = [...integ.wounds, ...scene.wounds, ...reader.wounds]
    const verdict: PreflightVerdict = integ.check.state === 'wound'
      ? 'decline'
      : wounds.length > 0 ? 'wounded' : 'ready'
    return { verdict, checks, wounds, basis: composeBasis(verdict, checks, wounds) }
  } catch {
    // 整体兜底（单项已由 runOne 兜住；此层保证 assessForeignTakeover 契约级绝不抛）：
    // 全 unknown 如实缺省 + 基础免责 basis，绝不拦真实接管
    const checks: PreflightCheck[] = PREFLIGHT_KINDS.map((kind) => ({
      kind,
      state: 'unknown' as const,
      detail: '该项检查中断（预检自身异常，如实缺省）',
    }))
    return {
      verdict: 'ready',
      checks,
      wounds: [],
      basis: '预检自身异常，五项均未核验——本卡不构成健康背书，接管前请人工确认现场',
    }
  }
}
