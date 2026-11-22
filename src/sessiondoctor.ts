/**
 * 0.26 扩展波 · 会话医生（~/.handoff 总线只读自检）。
 *
 * 问题：总线是多写方共享目录（本插件 + core 参考实现 + 任何 handoff: 1 第三方实现），
 * 取件即消费 + 面板 30s 轮询的活性视图会静默跳过坏卡、清扫孤儿侧车，接力链断了也只有
 * 「无前缀无痕迹」的 fail-open 容忍——总线上积累了什么损伤、链在哪里断的，没有任何一个
 * 面向人的体检出口。本模块给一次性的只读体检：scanStore(dir) 逐张列出发现。
 *
 * 检查闭集（对齐体检三问：损坏段 / 孤儿侧车 / 链异常；kind 六值，全部只读，
 * 绝不写盘/删盘/搬盘）：
 * - `corrupt`（损坏段）：pending/archived 的 .md 逐张按 core 读侧同款口径验——解析失败
 *   （坏 YAML 等 parseCardLenient 抛错）、超 MAX_CARD_BYTES 尺寸闸、卡内 id 非法或与文件名
 *   不对应（load 无从寻址）、文件读取失败。与 core listDirCards 的跳过规则逐条对齐，
 *   core 会跳过的这里逐张点名，core 能取的不冤枉（零口径漂移：解析直接复用
 *   core parseCardLenient，不自写 YAML——SPEC 口径分歧是误报的头号来源）；
 * - `shape`（形态）：解析成功但卡面缺 SPEC 二、六段必备标题（目标/涉及文件/做到哪/
 *   还差什么/停在哪/读者警告，conformance C4 同名单），或有 frontmatter 的卡缺 C4 必填
 *   字段（handoff / from.agent / from.session）。无 frontmatter 的宽松卡不查字段缺失
 *   （C8 明文豁免：纯 Markdown 也能取），只查六段。这只违反生产义务、不违反消费容忍
 *  （SPEC 语义 3：缺段给空、缺字段默认值），取件不受影响——severity 恒为 warn；
 * - `orphan-sidecar`（孤儿侧车）：.envelope.json / .patch / .patch.gz / .patch.NNN.gz
 *   （分块，settings PATCH_CHUNK_GZ_RE 同款正则）/ .hippo.jsonl 在 pending 找不到同名
 *   主卡（写侧中断残留；archived 有同 id 主卡则为取件中断残留），或 archived 侧车没有
 *   同名主卡（滚动清理只滚 .md 不滚侧车——trimArchived 只删 .md，审计残留属预期产物，
 *   severity 降为 info）。活性判据与 settings 伴生孤儿清扫同款：只看对应 .md 是否真在盘
 *   （解析失败但仍在册的卡不算孤儿主卡缺失——core 对这类卡明确「保留在收件箱」）。
 *   另：信封按取件语义是消费即删（consumeEnvelope 只删 pending），archived 里的信封
 *   一律按残留点名（info），不问主卡在不在。
 * - `chain-dangling` / `chain-cycle` / `chain-fork`（链异常）：supersedes 指向在册不存在
 *   的 id（warn——取件侧对缺席父卡本就按无前缀容忍，且父卡可能只是被 archived 滚动清理；
 *   ARCHIVED_KEEP=50）、supersedes 成环含自环（error——合法取件/回执流程不可能产生：
 *   回执卡 supersedes=已取件源卡，源卡不会再指向新卡）、一张卡被多张卡 supersedes
 *   （warn——接力分叉，手工接力叠加自动回执时真实可发生）。
 *
 * supersedes 数据源（与仓库既有两通道同口径）：
 * - 卡面 extras.supersedes 是持久通道（tools inboxHistory 口径：信封取件即弃，卡面才是
 *   持久通道）——pending 与 archived 都读；
 * - pending 信封兜底（settings 链数据源同口径）：卡面没有时读 <id>.envelope.json 顶层
 *   supersedes，只读 ≤64KB 的信封（S6 尺寸闸同款），坏 JSON/超尺寸 fail-open 跳过。
 * 目标存在性按文件论（<id>.md 是否在 pending/archived 任一盘上）——与 tools
 * inheritParentRemaining 的「pending 优先、archived 兜底读文件」同判据；解析失败的父卡
 * 文件在场就不算断链（取件侧对解析失败父卡同样容忍）。
 *
 * 分级语义：
 * - `error` = 确定性破缺：取件必受影响（pending 损坏段）或链语义不可能由合法流程产生（环）；
 * - `warn`  = 真实缺陷但不阻断取件：形态不合规、活动收件箱里的孤儿残留、断链/分叉；
 * - `info`  = 预期滚动的审计残留（archived 孤儿侧车/误置信封），可手工清理。
 * `ok` = 本次扫描 issues 为空（ok:true 即零发现；扫描自身降级如实进 notes，不冒充 ok）。
 *
 * 防御式纪律（与 lifecycle/flightcheck 同款 fail-open）：单文件读炸/解析炸只产出一张
 * issue，不拖垮整轮扫描；目录读炸记 notes 后继续扫另一个目录；本模块自身代码的意外异常
 * 记 notes（doctor 自身故障不伪装成总线发现）；~/.handoff 不存在 = 全新总线，干净返回。
 *
 * @module dsh-takeover/sessiondoctor
 */
import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import {
  ARCHIVED_KEEP,
  MAX_CARD_BYTES,
  SAFE_ID,
  archivedDir,
  parseCardLenient,
  pendingDir,
  yamlParse,
  type Card,
} from '@agent-handoff/core'

/** 发现严重级：error=确定性破缺 / warn=真实缺陷不阻断取件 / info=预期滚动的审计残留 */
export type DoctorSeverity = 'error' | 'warn' | 'info'

/** 发现种类闭集（新增 = 改这里 + 头注三类检查清单 + 测试） */
export const DOCTOR_KINDS = [
  'corrupt', // 损坏段：解析失败/超尺寸/id 坏/读失败（core 读侧会跳过的卡，逐张点名）
  'shape', // 形态：缺六段必备标题 / 有 frontmatter 的卡缺 C4 必填字段（取件不受影响）
  'orphan-sidecar', // 孤儿侧车：侧车无同名主卡 / archived 误置信封
  'chain-dangling', // 链异常：supersedes 指向在册不存在的 id
  'chain-cycle', // 链异常：supersedes 成环（含自环）
  'chain-fork', // 链异常：一张卡被多张卡 supersedes（接力分叉）
] as const
export type DoctorKind = (typeof DOCTOR_KINDS)[number]

export interface DoctorIssue {
  kind: DoctorKind
  /** 问题主体的可寻址名：卡 id / 侧车 owner id / 文件名（id 不可辨时） */
  id: string
  /** 发现细节（文件名/原因/建议去向），不落卡正文 */
  detail: string
  severity: DoctorSeverity
}

export interface DoctorReport {
  /** issues 为空 = true（零发现）；扫描自身降级以 notes 如实附注 */
  ok: boolean
  issues: DoctorIssue[]
  /** 扫描覆盖面（原始计数，含损坏项——口径是「见到多少」，不是「健康多少」） */
  scanned: { pendingCards: number; archivedCards: number; pendingSidecars: number; archivedSidecars: number }
  /** 扫描自身降级附注（目录/单项内部异常）；零降级时缺省。不冒充总线发现 */
  notes?: string[]
}

/** gzip 分块侧车名尾段（settings PATCH_CHUNK_GZ_RE / patchpack CHUNK_NAME_RE 同款） */
const PATCH_CHUNK_GZ_RE = /\.patch\.(\d+)\.gz$/

/** SPEC 二、六段必备标题（conformance run.mjs C4 同名单；「建议加载」为可选段不查） */
const REQUIRED_HEADINGS = ['目标', '涉及文件', '做到哪', '还差什么', '停在哪', '读者警告'] as const

/** 拆 frontmatter 与正文（core splitFrontmatter 同款正则——判定「有没有/正文是哪段」用，
 * 真解析仍交 core）；无 frontmatter 返回 null */
const FM_SPLIT_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/

/** pending 信封兜底读入尺寸闸（settings S6 同款：巨信封只跳过不读入） */
const ENVELOPE_READ_MAX_BYTES = 65536

/** 侧车家族：从文件名取 owner id；非协议侧车名（.claim/杂项）返回 null 不进体检闭集
 *（.claim 由 core sweepClaims 自愈；其余杂项文件不是协议面） */
export function sidecarOwnerOf(name: string): string | null {
  const gzChunk = PATCH_CHUNK_GZ_RE.exec(name)
  if (name.endsWith('.envelope.json')) return name.slice(0, -'.envelope.json'.length) || null
  if (gzChunk !== null) return name.slice(0, name.length - gzChunk[0].length) || null
  if (name.endsWith('.patch.gz')) return name.slice(0, -'.patch.gz'.length) || null
  if (name.endsWith('.patch')) return name.slice(0, -'.patch'.length) || null
  if (name.endsWith('.hippo.jsonl')) return name.slice(0, -'.hippo.jsonl'.length) || null
  return null
}

/** 单目录扫描产物：issues + 链检查所需素材（盘上 id 集 / 卡面 supersedes / 孤儿候选） */
interface DirScanOut {
  issues: DoctorIssue[]
  /** 盘上 .md 可寻址 id：SAFE_ID 形态文件名基 ∪ 解析成功卡的卡内 id（冲突档按卡内 id） */
  fileIds: Set<string>
  /** 解析成功卡的卡面 supersedes（id → 前置卡 id） */
  faceSup: Map<string, string>
  /** 孤儿候选：owner id → 侧车文件名（主卡在不在由 scanStore 跨目录裁决） */
  orphans: Map<string, string[]>
  /** SAFE_ID 形态文件名基（信封兜底的 key = 文件名基，与信封命名同源） */
  bases: Set<string>
}

/** 相对 core 读侧跳过规则的 severity 取向：pending 是活动收件箱（取件必受影响）= error，
 * archived 是历史档（history 检索跳过、取件无关）= warn */
function corruptSeverity(which: 'pending' | 'archived'): DoctorSeverity {
  return which === 'pending' ? 'error' : 'warn'
}

/** 可靠错误文案（未知抛出物兜底成字符串） */
function readable(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 抽卡面 supersedes（tools inboxHistory 同口径：extras.supersedes 非空字符串才算） */
function faceSupersedesOf(card: Card): string | undefined {
  const sup = (card.extras as Record<string, unknown> | undefined)?.['supersedes']
  return typeof sup === 'string' && sup.trim() !== '' ? sup.trim() : undefined
}

/** 六段必备标题逐一按行锚定正则查在场（子串查会误认正文引用/前端注释里的同名行） */
function missingHeadingsOf(body: string): string[] {
  const missing: string[] = []
  for (const h of REQUIRED_HEADINGS) {
    if (new RegExp(`^##\\s+${h}\\s*$`, 'm').test(body) !== true) missing.push(h)
  }
  return missing
}

/** 形态检查：解析成功卡的六段 + 有 frontmatter 卡的 C4 必填字段；产出 issue 或 null */
function shapeIssueOf(text: string, card: Card): DoctorIssue | null {
  const m = FM_SPLIT_RE.exec(text)
  const hasFront = m !== null
  const body = hasFront ? m[2] ?? '' : text
  const missing: string[] = []
  const missingHeadings = missingHeadingsOf(body)
  if (missingHeadings.length > 0) {
    missing.push(`缺必备段（SPEC 二、六段必选）：${missingHeadings.join('、')}`)
  }
  if (hasFront && m !== null) {
    // 解析成功 = core 的 yamlParse 已在此 front 上成功过，这里不会抛（同正则同输入）
    const fm = yamlParse(m[1] ?? '')
    const missingFields: string[] = []
    if (!('handoff' in fm)) missingFields.push('handoff')
    const from = fm['from']
    const fromMap = from !== null && typeof from === 'object' && !Array.isArray(from) ? (from as Record<string, unknown>) : undefined
    if (fromMap === undefined || !('agent' in fromMap)) missingFields.push('from.agent')
    if (fromMap === undefined || !('session' in fromMap)) missingFields.push('from.session')
    if (missingFields.length > 0) {
      missing.push(`缺 frontmatter 必填（C4 生产义务）：${missingFields.join('、')}`)
    }
  }
  if (missing.length === 0) return null
  return {
    kind: 'shape',
    id: card.id,
    detail: `${missing.join('；')}——解析与取件不受影响（SPEC 语义 3：消费侧缺段给空、缺字段给默认值），仅卡面形态不合规`,
    severity: 'warn',
  }
}

/** 单张 .md 全套检查（corrupt 四因 + shape）：读失败/解析失败短路（无卡可给）；
 * 解析成功时把 Card 一并带回（fileIds/faceSup 复用，不在外层二次读盘二次解析） */
function scanMdFile(dirPath: string, name: string, which: 'pending' | 'archived'): { issue: DoctorIssue | null; card?: Card } {
  const base = name.slice(0, -3)
  const sev = corruptSeverity(which)
  let st: Stats | undefined
  try {
    st = statSync(join(dirPath, name))
  } catch { /* stat 失败不短路：读的时候一并暴露 */ }
  if (st !== undefined && !st.isFile()) {
    return { issue: { kind: 'corrupt', id: base, detail: `同名目录项冒充 .md（读取必失败，core 读侧会跳过）`, severity: sev } }
  }
  if (st !== undefined && st.size > MAX_CARD_BYTES) {
    // 与 core 读侧同款：不读入内容（多写方共享目录，巨文件不进内存）
    return {
      issue: {
        kind: 'corrupt',
        id: base,
        detail: `卡片超过 ${MAX_CARD_BYTES} 字节尺寸闸（${Math.round(st.size / 1024 / 1024)} MiB）——core 拒载、保留在原处，取件无从进行`,
        severity: sev,
      },
    }
  }
  let text: string
  try {
    text = readFileSync(join(dirPath, name), 'utf-8')
  } catch (e) {
    return { issue: { kind: 'corrupt', id: base, detail: `文件读取失败：${readable(e)}——core 读侧会跳过`, severity: sev } }
  }
  let card: Card
  try {
    card = parseCardLenient(text, { filename: name })
  } catch (e) {
    return {
      issue: {
        kind: 'corrupt',
        id: SAFE_ID.test(base) ? base : name,
        detail: `解析失败：${readable(e)}——core 读侧会跳过（坏卡修好即从跳过清单消失）`,
        severity: sev,
      },
    }
  }
  // id 双闸与 core listDirCards 逐条对齐：卡内 id 非法 / 卡内 id 与盘上主卡名不对应
  if (SAFE_ID.test(card.id) !== true) {
    return { card, issue: { kind: 'corrupt', id: base, detail: `卡内 id「${card.id}」不合法（SAFE_ID 形态）——load 必败，core 读侧会跳过`, severity: sev } }
  }
  if (!existsSync(join(dirPath, `${card.id}.md`))) {
    return {
      card,
      issue: {
        kind: 'corrupt',
        id: base,
        detail: `卡内 id「${card.id}」与文件名不对应（盘上无 ${card.id}.md）——load 无从寻址，core 读侧会跳过`,
        severity: sev,
      },
    }
  }
  return { card, issue: shapeIssueOf(text, card) }
}

/** 单目录扫描：.md 逐张 + 侧车登记；目录读炸整体降级为空（notes 记录） */
function scanOneDir(dirPath: string, which: 'pending' | 'archived', notes: string[], scanned: DoctorReport['scanned']): DirScanOut {
  const out: DirScanOut = { issues: [], fileIds: new Set(), faceSup: new Map(), orphans: new Map(), bases: new Set() }
  let names: string[]
  try {
    names = readdirSync(dirPath)
  } catch (e) {
    // 目录不存在 = 全新/未建总线，不算发现；存在但读不动才记降级
    if (existsSync(dirPath)) notes.push(`${which}/ 目录读取失败，本轮未覆盖该目录：${readable(e)}`)
    return out
  }
  for (const name of names) {
    try {
      if (name.endsWith('.md')) {
        if (which === 'pending') scanned.pendingCards++
        else scanned.archivedCards++
        const base = name.slice(0, -3)
        if (SAFE_ID.test(base)) {
          out.bases.add(base)
          out.fileIds.add(base)
        }
        const { issue, card } = scanMdFile(dirPath, name, which)
        if (issue !== null) out.issues.push(issue)
        // 解析成功才有卡内 id（解析失败的卡，盘上文件名基已入 fileIds——主卡在盘就是链上的活节点）
        if (card !== undefined) {
          out.fileIds.add(card.id)
          const sup = faceSupersedesOf(card)
          if (sup !== undefined) out.faceSup.set(card.id, sup)
        }
        continue
      }
      const owner = sidecarOwnerOf(name)
      if (owner === null) continue // .claim / 杂项不在体检闭集
      if (which === 'pending') scanned.pendingSidecars++
      else scanned.archivedSidecars++
      const files = out.orphans.get(owner)
      if (files === undefined) out.orphans.set(owner, [name])
      else files.push(name)
    } catch (e) {
      // 单项检查链路的意外异常：doctor 自身故障不伪装成总线发现，记 notes 继续
      notes.push(`${which}/${name} 检查中断（doctor 内部异常）：${readable(e)}`)
    }
  }
  return out
}

/** pending 信封兜底：卡面没有 supersedes 的卡读 <base>.envelope.json 顶层 supersedes
 *（settings 链数据源同口径 + S6 尺寸闸同款；坏 JSON/超尺寸/读炸一律 fail-open 跳过） */
function envelopeSupersedesOf(dirPath: string, base: string): string | undefined {
  try {
    const p = join(dirPath, `${base}.envelope.json`)
    if (!existsSync(p)) return undefined
    if (statSync(p).size > ENVELOPE_READ_MAX_BYTES) return undefined
    const env = JSON.parse(readFileSync(p, 'utf-8')) as { supersedes?: unknown }
    if (typeof env.supersedes === 'string' && env.supersedes.trim() !== '') return env.supersedes.trim()
    return undefined
  } catch {
    return undefined
  }
}

/** 链检查：edges 素材 → dangling / cycle / fork 三类 issue */
function scanChainIssues(pend: DirScanOut, arch: DirScanOut, pd: string, ad: string): DoctorIssue[] {
  // 边集：from → supersedes 目标（同 id 两目录各一份副本去重为一条边）
  const edges = new Map<string, Set<string>>()
  const addEdge = (from: string, to: string): void => {
    if (from === '' || to === '') return
    const set = edges.get(from)
    if (set === undefined) edges.set(from, new Set([to]))
    else set.add(to)
  }
  for (const [id, sup] of pend.faceSup) addEdge(id, sup)
  for (const [id, sup] of arch.faceSup) addEdge(id, sup)
  // 信封兜底（pending only）：卡面没有的 id 逐个试信封
  for (const base of pend.bases) {
    if (pend.faceSup.has(base) || edges.has(base)) continue
    const sup = envelopeSupersedesOf(pd, base)
    if (sup !== undefined) addEdge(base, sup)
  }
  const issues: DoctorIssue[] = []
  const mdOnDisk = (id: string): boolean => existsSync(join(pd, `${id}.md`)) || existsSync(join(ad, `${id}.md`))

  // ① dangling：目标 id 在 pending/archived 均无主卡文件（与 inheritParentRemaining 同判据）。
  // supersedes 值是外来输入：非 SAFE_ID 形态的目标直接按断链报（不可能在册），不做盘上
  // 探测——不为路径穿越形态的值打开 existsSync 探面
  for (const from of [...edges.keys()].sort()) {
    for (const to of [...edges.get(from) ?? []].sort()) {
      const malformed = SAFE_ID.test(to) !== true
      if (!malformed && mdOnDisk(to)) continue
      issues.push({
        kind: 'chain-dangling',
        id: from,
        detail: malformed
          ? `本卡 supersedes 指向「${to}」，id 形态非法（SAFE_ID 形态才可能成为在册卡）——手工编辑或外部写入的坏链值；取件侧按无前缀容忍（继承降级不炸）`
          : `本卡 supersedes 指向「${to}」，在册不存在（pending/archived 均无 ${to}.md）——可能已被 archived 滚动清理（ARCHIVED_KEEP=${ARCHIVED_KEEP}）或 id 笔误；取件侧按无前缀容忍（继承降级不炸），但链可视化在此断链`,
        severity: 'warn',
      })
    }
  }

  // ② fork：同一张卡被多张卡 supersedes（接力分叉）
  const forkTargets = new Map<string, string[]>()
  for (const [from, tos] of edges) {
    for (const to of tos) {
      const froms = forkTargets.get(to)
      if (froms === undefined) forkTargets.set(to, [from])
      else froms.push(from)
    }
  }
  for (const to of [...forkTargets.keys()].sort()) {
    const froms = (forkTargets.get(to) ?? []).sort()
    if (froms.length < 2) continue
    issues.push({
      kind: 'chain-fork',
      id: to,
      detail: `被 ${froms.length} 张卡接替：${froms.join('、')}——接力分叉（一张卡正常只被一张后继卡接替；手工接力叠加自动回执时可能真实发生，取件不受影响，链语义按分叉如实呈现）`,
      severity: 'warn',
    })
  }

  // ③ cycle：supersedes 成环（含自环）。灰度 DFS，环成员标黑去重，一环一条 issue
  const color = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const seenCycles = new Set<string>()
  const dfs = (n: string): void => {
    color.set(n, 1)
    stack.push(n)
    for (const t of [...edges.get(n) ?? []].sort()) {
      const c = color.get(t) ?? 0
      if (c === 1) {
        const at = stack.indexOf(t)
        const members = at >= 0 ? stack.slice(at) : [t]
        const key = [...members].sort().join('→')
        if (at >= 0 && !seenCycles.has(key)) {
          seenCycles.add(key)
          issues.push({
            kind: 'chain-cycle',
            id: [...members].sort()[0] ?? t,
            detail: `supersedes 环：${[...members, t].join(' → ')}——接力链成环（合法流程不可能产生：回执卡 supersedes=已取件源卡，源卡不会再指向新卡），多为手工编辑或外部写入产物`,
            severity: 'error',
          })
        }
      } else if (c === 0) {
        dfs(t)
      }
    }
    stack.pop()
    color.set(n, 2)
  }
  for (const n of [...edges.keys()].sort()) {
    if ((color.get(n) ?? 0) === 0) dfs(n)
  }
  return issues
}

/**
 * 总线只读体检：pending/ + archived/ 全量逐张（损坏段 + 形态）→ 孤儿侧车跨目录裁决 →
 * 接力链三查（dangling/cycle/fork）。绝不写盘；单文件失败不拖垮扫描；issues 按
 * (kind, id) 排序保证跨次运行可 diff。
 */
export function scanStore(dir?: string): DoctorReport {
  const notes: string[] = []
  const issues: DoctorIssue[] = []
  const scanned: DoctorReport['scanned'] = { pendingCards: 0, archivedCards: 0, pendingSidecars: 0, archivedSidecars: 0 }
  const pd = pendingDir(dir)
  const ad = archivedDir(dir)

  const pend = scanOneDir(pd, 'pending', notes, scanned)
  const arch = scanOneDir(ad, 'archived', notes, scanned)
  issues.push(...pend.issues, ...arch.issues)

  // 孤儿侧车跨目录裁决：pending 侧车看 pending 主卡（活性判据与 settings 伴生孤儿清扫同款：
  // 只看 .md 是否真在盘，解析失败但在册的卡不算主卡缺失）
  for (const owner of [...pend.orphans.keys()].sort()) {
    const files = (pend.orphans.get(owner) ?? []).sort()
    if (existsSync(join(pd, `${owner}.md`))) {
      // 主卡在册——pending 侧车不是孤儿。信封是正常随卡件；archived 误置在下面单独裁
      continue
    }
    const archivedHasMd = existsSync(join(ad, `${owner}.md`))
    issues.push({
      kind: 'orphan-sidecar',
      id: owner,
      detail: archivedHasMd
        ? `伴生侧车 ${files.join('、')} 无 pending 主卡，但 archived 有同 id 主卡——取件中断残留（侧车未随卡搬完；面板轮询的伴生孤儿清扫会自动删除此类残留）`
        : `伴生侧车 ${files.join('、')} 无同名主卡（pending/archived 均无 ${owner}.md）——写侧中断残留或外来残留；面板轮询的伴生孤儿清扫会自动删除`,
      severity: 'warn',
    })
  }
  // archived 侧车：无同名主卡 = 孤儿（滚动清理只滚 .md 的预期产物，info）；信封误置一律点名
  for (const owner of [...arch.orphans.keys()].sort()) {
    const files = (arch.orphans.get(owner) ?? []).sort()
    const isEnvelope = files.some((f) => f.endsWith('.envelope.json'))
    if (existsSync(join(ad, `${owner}.md`))) {
      if (!isEnvelope) continue // 主卡在册的非信封侧车 = 正常随卡件（补丁/蒸馏侧车归档形态）
      issues.push({
        kind: 'orphan-sidecar',
        id: owner,
        detail: `机器信封 ${files.join('、')} 出现在 archived——信封按取件语义是消费即删（consumeEnvelope 只删 pending/），旧实现或手工搬移残留；无害，可手工清理`,
        severity: 'info',
      })
      continue
    }
    issues.push({
      kind: 'orphan-sidecar',
      id: owner,
      detail: isEnvelope
        ? `机器信封 ${files.join('、')} 出现在 archived 且无同名主卡——信封按取件语义是消费即删（不应进入 archived，更不应无主卡）；无害残留，可手工清理`
        : `archived 侧车 ${files.join('、')} 无同名主卡——主卡可能已被滚动清理出 archived（ARCHIVED_KEEP=${ARCHIVED_KEEP} 只滚 .md，侧车不随之清理）：审计残留，可手工清理；不影响取件`,
      severity: 'info',
    })
  }

  // 链三查（自身 fail-open：病理输入（如万卡级深链的递归溢出）只记降级附注，
  // 绝不把 doctor 自身故障抛给调用方——损坏段/孤儿侧车的发现照常返回）
  try {
    issues.push(...scanChainIssues(pend, arch, pd, ad))
  } catch (e) {
    notes.push(`接力链检查中断（doctor 内部异常，链三查本轮未覆盖）：${readable(e)}`)
  }

  issues.sort((a, b) => (a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id) || a.detail.localeCompare(b.detail)))
  return { ok: issues.length === 0, issues, scanned, ...(notes.length > 0 ? { notes } : {}) }
}
