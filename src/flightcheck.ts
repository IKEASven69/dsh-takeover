/**
 * 接力体检 + 起飞章（0.26 特色功能）：出卡前对六段卡面自身做机器体检，产出一枚
 * 三档章 `extras.flight = { verdict, ran_at, checks[] }`——走 SPEC extras 持久通道
 * （core 对未知顶层字段不丢，extras 殿后渲染回 frontmatter，round-trip 不丢；
 * 先例 extras.coverage / extras.baseline / extras.axis）。
 *
 * 档位与卡面的关系（体检挂闸后——既有闸行为零改动，不放宽任何既有闸）：
 * - `blocked` = **闸拒收路径的返回值**：密钥闸命中且未旁路 / 空壳闸拒收（六段全兜底
 *   占位且未手写）时无卡可落——blocked 诊断进拒收反馈文案与 lifecycle detail
 *   （secret_gate / skeleton_gate 两理由同位），**不出现在任何卡面**；
 * - `cautioned` = 闸放行但体检有发现（allowSecrets 旁路带残留、骨架偏空但已手写、
 *   file_ref 有缺、claim 在册未验）——二值闸升级为分级章（与自家 0.4.4 密钥闸的
 *   差异点），诊断摘要经 note 追加进读者警告段；
 * - `cleared` = 四项全过。
 * 即：**真实落盘卡的卡面只有 cleared / cautioned 两档**。
 *
 * 四检查项（kind 闭集）——全部是诊断，不是新闸：
 * - `file_ref`：files 段声称的文件路径存在性（fs 探测注入可桩，相对路径按 opts.cwd 解析）；
 * - `secret`：六段密钥残留复扫——复用 scanSecrets 纯函数（15 模式+赋值判据），零新扫描面；
 * - `skeleton`：骨架完整性——照空壳闸判据（isLowInfoCardMarkdown）做诊断，非新闸；
 * - `claim_cmd`：卡内声称的命令（goal/done/remaining 段命令形态）**只登记不执行**，
 *   默认 `unverified`（agent-receipt / oracle-gate / task-passport / FerryCat 四家共识）。
 *
 * **--run-claims 执行面移出 0.26**：共享收件箱里攻击者可控文本的任意命令执行面，
 * 卫队成本超出本期材料授权——材料只给「显式才执行」原则，未给任何执行卫队设计。
 * 0.27 引入的前置条件：THREAT-MODEL 增条、execFile 定参数组不走 shell（全仓惯例
 * tools.ts:205 / patchpack.ts:172）、timeout、cwd=卡面 cwd、输出截断；届时另行评审。
 * 本模块因此不 import 任何 child_process 面（负向断言随 tests/flightcheck.spec.ts）。
 *
 * 四态字段立约（登记与回执 evidence 共用，receipt.ts 消费）：
 * `CURRENT_OBSERVED`（当下观察证实）/ `MISMATCH`（与仓库现实脱节）/ `UNAVAILABLE`
 * （无法核验）+ `unverified`（在册未验，0.26 无执行面的登记终态）。
 *
 * 防御式纪律：体检是新增写侧步骤，自身抛错 = 未盖章如实缺省（runFlightcheckSafe
 * 返 undefined）而非拦出卡——检查项内部失败一律向上抛、整章缺省，绝不把体检自身
 * 故障伪装成 blocked/cautioned 诊断（那会让落盘卡出现 blocked 卡面）；输入条件下的
 * 诚实降级（探测函数抛错=未确认存在）不属体检自身故障，照常在册。
 *
 * 集成面接线立约（本模块不改 tools.ts；挂点见 docs/计划-0.26.md §5.1）：
 * ```
 * // 出卡路径（密钥闸/空壳闸之后、extras 组装之前）：
 * const fc = runFlightcheckSafe(sections, {
 *   allowSecrets: args.allowSecrets === true,
 *   confirmSkeleton: args.confirmSkeleton === true,
 *   userWrote,      // 与 pushHandoff 内 userWrote 判据同源
 *   cwd,
 * })
 * if (fc) {
 *   // verdict==='cautioned' 时先把 fc.note 追加进 sections.warnings 再落卡
 *   // extras.flight = fc.stamp（经 opts.extras 合并位进卡）
 * }
 * // 闸拒收路径（secret_gate / skeleton_gate 返回 ok:false 前）：
 * // 同样调 runFlightcheckSafe（此时 allowSecrets/confirmSkeleton 传调用实参、
 * // extraSecretHits 传补丁/标量扫描面命中数）→ verdict='blocked'，
 * // fc.note 进拒收反馈文案与 recordLifecycleEvent detail，不落卡面。
 * ```
 *
 * @module dsh-takeover/flightcheck
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { scanSecrets } from './secretscan.ts'
import { isLowInfoCardMarkdown } from './lowinfo.ts'

/** 检查项 kind 闭集：开集没法聚合体检率，也没法出分档章 */
export const FLIGHTCHECK_KINDS = ['file_ref', 'secret', 'skeleton', 'claim_cmd'] as const
export type FlightcheckKind = (typeof FLIGHTCHECK_KINDS)[number]

/** 三档章 verdict 闭集。blocked 只活在闸拒收路径，真实落盘卡卡面只有前两档 */
export const FLIGHT_VERDICTS = ['cleared', 'cautioned', 'blocked'] as const
export type FlightVerdict = (typeof FLIGHT_VERDICTS)[number]

/**
 * 四态字段闭集（登记与回执 evidence 共用，0.26 立约交付）：
 * - `CURRENT_OBSERVED`：当下观察证实（取件时 git 核验一致）；
 * - `MISMATCH`：与仓库现实脱节（取件时 git 核验冲突）；
 * - `UNAVAILABLE`：无法核验（非 git 仓 / cwd 不在 / git 失败）；
 * - `unverified`：在册未验——claim_cmd 登记态，0.26 无执行面，登记即终态。
 * 口径与卡面覆盖率四态标记（tools.ts COVERAGE_MARKERS）同族但不混用：
 * 覆盖率管「完成陈述标没标」，这里管「声称验没验」。
 */
export const CLAIM_STATES = ['CURRENT_OBSERVED', 'MISMATCH', 'UNAVAILABLE', 'unverified'] as const
export type ClaimState = (typeof CLAIM_STATES)[number]

/** 单条命令声称登记（claim_cmd 检查项产出，回执 evidence 的 unverified 条目同构） */
export interface ClaimRecord {
  /** 声称的命令文本（净化单行 + 截断，登记原文不改写） */
  claim: string
  /** 所在段（goal/done/remaining） */
  section: string
  /** 0.26 恒 'unverified'：无执行面，登记即终态；0.27 执行面落地前不得改判 */
  state: ClaimState
}

/** 单检查项结果（进 extras.flight.checks，随卡持久化供取件方/下游读） */
export interface FlightcheckCheck {
  kind: FlightcheckKind
  /** 该项是否通过；false = 诊断有发现（是否升级档位由 verdict 判定） */
  ok: boolean
  /** 诊断细节（掩码化，不含密钥值本体——与闸反馈同款口径） */
  detail: string
  /** claim_cmd 专属：登记的命令声称（其余 kind 缺省） */
  claims?: ClaimRecord[]
}

/** 三档起飞章（extras.flight 契约字段只此三件，不夹带其它键） */
export interface FlightStamp {
  verdict: FlightVerdict
  /** 体检时刻（ISO8601，与 lifecycle 事件 at 同款 toISOString 口径） */
  ran_at: string
  checks: FlightcheckCheck[]
}

export interface FlightcheckResult {
  /** 盖进 extras.flight 的章 */
  stamp: FlightStamp
  /** 非 cleared 档的人读诊断摘要：cautioned → 追加进读者警告段；blocked → 进拒收反馈文案与 lifecycle detail；cleared 为空串 */
  note: string
}

export interface FlightcheckOptions {
  /** file_ref 相对路径的解析基准（卡面 cwd） */
  cwd?: string
  /** ran_at 可桩 */
  now?: Date
  /** 存在性探测注入可桩（缺省 fs.existsSync）；探测自身抛错按「未确认存在」计 */
  exists?: (path: string) => boolean
  /** 密钥闸旁路同款入参：true 时密钥残留不升级 blocked，降为 cautioned（镜像闸语义） */
  allowSecrets?: boolean
  /** 空壳闸旁路同款入参：true 时骨架未过不升级 blocked（镜像闸 confirmSkeleton 语义） */
  confirmSkeleton?: boolean
  /** 六段是否全为兜底占位且未手写（空壳闸 userWrote 同款口径）。
   * 缺省 true = 按已手写处理——体检绝不越权发明 blocked；
   * 集成面在空壳闸拒收路径回放判据时显式传 false。 */
  userWrote?: boolean
  /** 六段复扫面之外的密钥命中数补正（补丁 diff / title·to·project 标量——体检只扫
   * 六段，闸还扫补丁与标量；闸拒收路径把面外命中数传进来，secret 项据实判 false，
   * 避免「闸拒收但章 cleared」的假象）。出卡正常路径不传。 */
  extraSecretHits?: number
}

/** 被检六段（suggested 可选：它在卡面上渲染，同属体检面） */
export interface FlightcheckSections {
  goal?: string
  files?: string
  done?: string
  remaining?: string
  stopped?: string
  warnings?: string
  suggested?: string
}

/** 单条 evidence/claim 文本净化上限 */
export const CLAIM_TEXT_MAX = 200
/** file_ref 单个路径候选上限（超长按不合法形态跳过，不做存在性断言） */
export const FILE_REF_PATH_MAX = 512
/** 诊断摘要里逐条列举的上限（超出只给计数，防巨卡把警告段撑爆） */
export const DETAIL_LIST_MAX = 5

const ANSI_CSI = /\u001B\[[0-9;:?]*[ -/]*[@-~]/g
const ANSI_OSC = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** 净化成单行短串（ANSI/控制字符剥离 + 换行压空格 + 截断）——本模块不 import
 * tools.ts（那会拖进整条出卡管线），这里按同口径实现一份局部净化 */
export function sanitizeLine(s: unknown, max = CLAIM_TEXT_MAX): string {
  if (typeof s !== 'string') return ''
  return s.replace(/\r\n?|\n/g, ' ').replace(ANSI_CSI, '').replace(ANSI_OSC, '').replace(CTRL, '').slice(0, max)
}

/**
 * files 段单行 → 候选路径（确定性启发式，保守取向）：
 * 剥列表记号与反引号；「tool: path」形态取最后一个「: 」之后的段；
 * 候选须含路径分隔符或末段带扩展名点才算路径（裸单词/命令行不误报）；
 * 含空白的串不认（Windows 带空格路径如实漏检——启发式宁漏不造）。
 */
export function filePathCandidates(filesSection: string): string[] {
  if (typeof filesSection !== 'string' || filesSection.trim() === '') return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of filesSection.split(/\r?\n/)) {
    let t = raw.trim()
    if (t === '' || t.startsWith('#')) continue
    t = t.replace(/^[-*•]\s*/, '').replace(/^\d+[.、)]\s*/, '').replace(/^`+|`+$/g, '').trim()
    // 「Write: D:/x/y.ts」形态取最后一段；Windows 盘符「D:\x」无「: 」不受影响
    const ci = t.lastIndexOf(': ')
    if (ci >= 0) t = t.slice(ci + 2).trim()
    t = t.replace(/^["'<]+|["'>]+$/g, '').trim()
    if (t === '' || t.length > FILE_REF_PATH_MAX || /\s/.test(t)) continue
    const last = t.split(/[\\/]/).pop() ?? ''
    const pathLike = /[\\/]/.test(t) || (last.includes('.') && /\.[A-Za-z0-9]{1,12}$/.test(last))
    if (!pathLike || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

/** 命令声称首 token 形态：字母开头的命令名样（排除中文/空格起头） */
const CMD_FIRST_TOKEN = /^[A-Za-z][\w@.:+/-]*$/

/**
 * 命令声称提取（goal/done/remaining 段，确定性启发式，零执行零子进程）：
 * ①反引号包住且含空白分隔的多 token 串（单 token 视为文件/代码引用不登记），
 * 首 token 呈命令名形态；②行首 `$ ` 显式 shell 形态。
 * 启发式诚实边界：git 提交行等命令样文本也会登记为 unverified 声称——
 * 登记是廉价的诚实动作（不执行不判定），多登不罚、漏登不瞒。
 */
export function extractCommandClaims(sections: Pick<FlightcheckSections, 'goal' | 'done' | 'remaining'>): ClaimRecord[] {
  const out: ClaimRecord[] = []
  const seen = new Set<string>()
  const push = (claim: string, section: string): void => {
    const c = sanitizeLine(claim)
    if (c === '') return
    const sig = `${section}:${c}`
    if (seen.has(sig)) return
    seen.add(sig)
    out.push({ claim: c, section, state: 'unverified' })
  }
  for (const section of ['goal', 'done', 'remaining'] as const) {
    const text = sections[section]
    if (typeof text !== 'string' || text === '') continue
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      if (/^\$\s+/.test(line)) push(line.replace(/^\$\s+/, ''), section)
    }
    const re = /`([^`\n]+)`/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const span = m[1]?.trim() ?? ''
      if (span === '' || !/\s/.test(span)) continue
      const first = span.split(/\s+/)[0] ?? ''
      if (!CMD_FIRST_TOKEN.test(first)) continue
      push(span, section)
    }
  }
  return out
}

/**
 * 防御式读取 extras.flight 里的 claim_cmd 登记（receipt.ts 与下游共用）：
 * 坏数据 / 闭集外 kind / 非法形态一律忽略，绝不抛；state 恒归一为 'unverified'——
 * 0.26 无执行面，任何在册声称都未被本实现验证过，外来卡声称别的态不可信。
 */
export function claimsFromFlight(flight: unknown): ClaimRecord[] {
  if (flight === null || typeof flight !== 'object' || Array.isArray(flight)) return []
  const checks = (flight as Record<string, unknown>)['checks']
  if (!Array.isArray(checks)) return []
  const out: ClaimRecord[] = []
  for (const c of checks) {
    if (c === null || typeof c !== 'object') continue
    const rec = c as Record<string, unknown>
    if (rec['kind'] !== 'claim_cmd' || !Array.isArray(rec['claims'])) continue
    for (const r of rec['claims']) {
      if (r === null || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      if (typeof o['claim'] !== 'string' || o['claim'].trim() === '') continue
      out.push({ claim: sanitizeLine(o['claim']), section: sanitizeLine(o['section'], 40) || 'unknown', state: 'unverified' })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 四检查项（内部失败一律向上抛 → runFlightcheckSafe 整章如实缺省「未盖章」，
// 绝不把体检自身故障伪装成 blocked/cautioned 诊断——那会让落盘卡出现 blocked 卡面；
// 输入条件下的诚实降级（如探测函数抛错=未确认存在）不属内部失败，照常在册）
// ---------------------------------------------------------------------------

function checkFileRef(sections: FlightcheckSections, opts: FlightcheckOptions): FlightcheckCheck {
  const candidates = filePathCandidates(sections.files ?? '')
  if (candidates.length === 0) return { kind: 'file_ref', ok: true, detail: 'files 段无可核验的路径形态' }
  const probe = opts.exists ?? ((p: string) => existsSync(p))
  const cwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : undefined
  const existsOf = (p: string): boolean => {
    try {
      if (probe(p)) return true
      // 相对路径按卡面 cwd 解析再试一次（绝对路径重复探测无害，probe 实现自决）
      return cwd !== undefined && probe(join(cwd, p))
    } catch {
      return false // 探测自身抛错 = 未确认存在（如实缺省，不编造在盘）
    }
  }
  const missing = candidates.filter((p) => !existsOf(p))
  if (missing.length === 0) return { kind: 'file_ref', ok: true, detail: `files 段 ${candidates.length} 处路径全部在盘` }
  const listed = missing.slice(0, DETAIL_LIST_MAX).join('、')
  const more = missing.length > DETAIL_LIST_MAX ? `（另 ${missing.length - DETAIL_LIST_MAX} 处略）` : ''
  return { kind: 'file_ref', ok: false, detail: `${missing.length}/${candidates.length} 处声称路径不存在：${listed}${more}` }
}

function checkSecret(sections: FlightcheckSections, opts: FlightcheckOptions): FlightcheckCheck {
  // 复用 scanSecrets 纯函数，零新扫描面：扫六段 + suggested（卡面渲染面即体检面；
  // 补丁/标量是闸的扫描面，不在体检复扫范围——面外命中经 opts.extraSecretHits 补正）
  const hits = scanSecrets({
    goal: sections.goal,
    files: sections.files,
    done: sections.done,
    remaining: sections.remaining,
    stopped: sections.stopped,
    warnings: sections.warnings,
    suggested: sections.suggested,
  })
  const extra = typeof opts.extraSecretHits === 'number' && Number.isInteger(opts.extraSecretHits) && opts.extraSecretHits > 0
    ? opts.extraSecretHits
    : 0
  const total = hits.length + extra
  if (total === 0) return { kind: 'secret', ok: true, detail: '六段密钥残留复扫干净（scanSecrets 15 模式+赋值判据）' }
  const listed = hits.slice(0, DETAIL_LIST_MAX).map((h) => `${h.rule}@${h.section}（${h.masked}）`).join('；')
  const more = hits.length > DETAIL_LIST_MAX ? `；另 ${hits.length - DETAIL_LIST_MAX} 处略` : ''
  const outOfFace = extra > 0 ? `${hits.length > 0 ? '；另有' : '另有'} ${extra} 处面外残留（补丁/标量扫描面）` : ''
  return { kind: 'secret', ok: false, detail: `${total} 处疑似密钥残留：${listed}${more}${outOfFace}` }
}

function checkSkeleton(sections: FlightcheckSections): FlightcheckCheck {
  const joined = (['goal', 'files', 'done', 'remaining', 'stopped', 'warnings', 'suggested'] as const)
    .map((k) => sections[k] ?? '')
    .join('\n')
  // 照空壳闸判据（isLowInfoCardMarkdown）做诊断，非新闸：闸还要求「六段均未手写」
  // 才拒收，体检只报占位占比过半的空壳形态，拦不拦由闸决定
  const lowInfo = isLowInfoCardMarkdown(joined)
  return lowInfo
    ? { kind: 'skeleton', ok: false, detail: '六段占位行占比过半（空壳形态）——闸是否拒收按 userWrote/confirmSkeleton 判据' }
    : { kind: 'skeleton', ok: true, detail: '骨架完整（非空壳形态）' }
}

function checkClaimCmd(sections: FlightcheckSections): FlightcheckCheck {
  // 只登记不执行：0.26 无执行面（--run-claims 移出，见模块头），登记即 unverified 终态
  const claims = extractCommandClaims(sections)
  return {
    kind: 'claim_cmd',
    ok: true,
    detail: claims.length > 0
      ? `登记 ${claims.length} 条命令声称（unverified，零执行）`
      : '未发现命令形态声称',
    claims,
  }
}

// ---------------------------------------------------------------------------
// 三档判定
// ---------------------------------------------------------------------------

function verdictOf(checks: FlightcheckCheck[], opts: FlightcheckOptions): FlightVerdict {
  const find = (kind: FlightcheckKind): FlightcheckCheck | undefined => checks.find((c) => c.kind === kind)
  const secret = find('secret')
  const skeleton = find('skeleton')
  const allowSecrets = opts.allowSecrets === true
  const confirmSkeleton = opts.confirmSkeleton === true
  const userWrote = opts.userWrote !== false
  // blocked 只镜像两道闸的拒收判据（体检挂闸后）：密钥命中未旁路 / 空壳未确认且未手写
  if (secret !== undefined && !secret.ok && !allowSecrets) return 'blocked'
  if (skeleton !== undefined && !skeleton.ok && !userWrote && !confirmSkeleton) return 'blocked'
  if (checks.some((c) => !c.ok)) return 'cautioned'
  return 'cleared'
}

function composeNote(checks: FlightcheckCheck[], verdict: FlightVerdict): string {
  if (verdict === 'cleared') return ''
  const bad = checks.filter((c) => !c.ok)
  const head = verdict === 'blocked' ? '接力体检 blocked（闸拒收路径诊断）' : '接力体检 cautioned'
  return `${head}：${bad.map((c) => `[${c.kind}] ${c.detail}`).join('；')}`
}

/**
 * 接力体检（纯函数，确定性：同输入同章）。四项固定顺序进 checks；档位判定见模块头。
 * 检查项内部失败（外来投毒数据等）会向上抛——防御式调用走 runFlightcheckSafe。
 */
export function runFlightcheck(sections: FlightcheckSections, opts: FlightcheckOptions = {}): FlightcheckResult {
  const checks: FlightcheckCheck[] = [
    checkFileRef(sections, opts),
    checkSecret(sections, opts),
    checkSkeleton(sections),
    checkClaimCmd(sections),
  ]
  const verdict = verdictOf(checks, opts)
  return {
    stamp: {
      verdict,
      ran_at: (opts.now ?? new Date()).toISOString(),
      checks,
    },
    note: composeNote(checks, verdict),
  }
}

/**
 * 防御式包装：体检自身抛错（含外来 sections 的 getter 投毒等）= 返回 undefined，
 * 调用方未盖章如实缺省照常出卡，绝不拦出卡主流程（risk③ 硬纪律）。
 */
export function runFlightcheckSafe(sections: FlightcheckSections, opts?: FlightcheckOptions): FlightcheckResult | undefined {
  try {
    return runFlightcheck(sections, opts)
  } catch {
    return undefined
  }
}
