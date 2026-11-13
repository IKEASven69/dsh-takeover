/**
 * host 侧两个工具：
 * - handoff_push：把当前 DSH 会话按 handoff: 1 协议导出成卡片，落 ~/.handoff/pending/。
 *   段内容优先用 agent 传入的蒸馏文本；缺省段从事件流确定性兜底（不调 LLM）。
 * - handoff_inbox：list 列待取件；load 取件（消费即弃）+ verifyGit 核验警告。
 * 所有返回值走 { ok, ... } 规范值；任何失败不抛异常，只回 { ok: false, error }。
 * @module dsh-takeover/tools
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isLowInfoCardMarkdown } from './lowinfo.ts'
import { scanSecrets } from './secretscan.ts'
import { augmentPatchWithUntracked, resolvePatchText, restoreGzipPatch, writePatchSidecar, type RestoredPatch } from './patchpack.ts'
import { recordLifecycleEvent } from './lifecycle.ts'
import { loadOrCreateSigningKey, signEnvelope, verifyEnvelopeSig, type SigVerdict } from './signing.ts'
import { syncNow, syncPull, syncPush, syncSetup, syncStatusLine, syncStatusOf, type SyncOutcome, type SyncStatus } from './sync.ts'
import { applyRestore, createBackup, dryRunRestore, listBackups, readBackupManifest, rollbackRestore, type BackupRow, type RestoreDiffRow } from './envbackup.ts'
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
  collectPatch,
  generateId,
  listArchivedReport,
  listPendingReport,
  loadCard,
  pendingDir,
  renderCard,
  archivedDir,
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
// A2. 四轴 IR 立约 + 仓库基线
// ---------------------------------------------------------------------------

/**
 * 四轴 IR 立约——axis：这张卡是哪根轴的载荷。
 * 'session'=会话轴（工作交接卡，六段接续工作）；'memory'=记忆轴（记忆快照卡，按条目吸收）；
 * 'config'=环境配置轴（环境/配置交接卡，预留）。取件方据此决定消费姿态。
 * 走 extras 通道持久化：core parseCard 把顶层未知键收进 extras，extras 殿后渲染回 frontmatter——
 * 不认识 axis 的旧实现按未知字段原样保留，round-trip 不丢（既有版本纪律）。
 */
export type CardAxis = 'session' | 'memory' | 'config'

/**
 * 四轴 IR 立约——payload：载荷形态。
 * 'files'=原文件正文（卡里带原始文件内容，取件方原样吸收整份）；
 * 'distilled'=蒸馏条目（卡里带甄别过的条目，取件方按条目入库）；
 * 'manifest'=清单+指针（配置轴：卡里只带文件清单/哈希/类别与密文包指针，
 * 不带货本体——本体在卡外按指针取，口令永不进卡）。
 */
export type CardPayload = 'files' | 'distilled' | 'manifest'

/**
 * 寄存时刻的仓库基线：remote/head/branch 三元组。取件方据此在新机器上
 * clone → checkout → apply 补丁 → 跑测试，复原寄存时的代码现场。
 * 各字段如实缺省（拿不到就是 null/空串），绝不用占位值冒充。
 * （type 别名而非 interface：命名别名才有隐式索引签名，过 defineTool 的 JsonValue 契约——SyncToolValue 同款）
 */
export type RepoBaseline = {
  /** origin 远端 URL；无 origin（纯本地仓）/ 非 git 仓为 null */
  remote: string | null
  /** 寄存时刻 HEAD commit；unborn 分支（无提交）/ 命令失败为 null */
  head: string | null
  /** 寄存时刻分支名（复用 GitSnapshot.branch，同一次采集；非 git 仓为空串） */
  branch: string
}

/** 基线采集单命令超时（毫秒）：cwd 是外来输入，挂死的 git / 慢盘不能拖垮寄存主流程 */
const GIT_BASELINE_TIMEOUT_MS = 15_000

/**
 * 基线采集：origin URL 与 HEAD commit。两条命令各自 try/catch + 15s 超时，
 * 失败/空输出如实 null，绝不 throw（基线拿不到不阻塞寄存）。
 * `-c core.fsmonitor=false` 与 core 同款纪律：卡片 cwd 是外来输入，仓库本地
 * fsmonitor 钩子是卡片作者可布置的命令执行面，基线采集一样不豁免。
 */
function collectRepoBaseline(cwd: string): { remote: string | null; head: string | null } {
  const one = (args: string[]): string | null => {
    try {
      const out = execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
        encoding: 'utf-8',
        timeout: GIT_BASELINE_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
      return out === '' ? null : out
    } catch {
      return null
    }
  }
  return {
    remote: one(['remote', 'get-url', 'origin']),
    head: one(['rev-parse', 'HEAD']),
  }
}

/** 从卡片 extras 防御式取基线（core parseCard 把顶层未知键收进 extras；外来卡/坏数据一律 undefined） */
export function baselineFromExtras(extras: unknown): RepoBaseline | undefined {
  if (extras === null || typeof extras !== 'object') return undefined
  const b = (extras as Record<string, unknown>).baseline
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return undefined
  const { remote, head, branch } = b as Record<string, unknown>
  if (typeof remote !== 'string' && remote !== null) return undefined
  if (typeof head !== 'string' && head !== null) return undefined
  if (typeof branch !== 'string') return undefined
  return { remote, head, branch }
}

/** 从卡片 extras 防御式取四轴标记（闭集外/坏数据一律 undefined——外来卡无 axis 按旧卡处理） */
export function axisFromExtras(extras: unknown): CardAxis | undefined {
  if (extras === null || typeof extras !== 'object') return undefined
  const a = (extras as Record<string, unknown>)['axis']
  return a === 'session' || a === 'memory' || a === 'config' ? a : undefined
}

/** 恢复指引单值净化：控制字符压成空格 + 截断——多行/超长的外来值不打碎四步行结构 */
function guidanceValue(v: string): string {
  return v.replace(/[\r\n\u0000-\u001F]+/g, ' ').slice(0, 300)
}

/** 「🧭 基线恢复指引」四步（clone → checkout → apply 补丁 → 跑测试）。
 * baseline 与 patch/testCommand 任一缺席都如实降级为说明行，不渲染空壳步骤。 */
export function renderBaselineGuidance(baseline: RepoBaseline, patchPath: string | undefined, testCommand: string | undefined): string[] {
  const lines = ['🧭 基线恢复指引（extras.baseline）：']
  const remote = typeof baseline.remote === 'string' && baseline.remote !== '' ? guidanceValue(baseline.remote) : null
  lines.push(remote !== null
    ? `  1. git clone ${remote} <目标目录>`
    : '  1. git clone：卡片未带 origin 远端（remote 缺省），先向寄存方要仓库地址')
  const head = typeof baseline.head === 'string' && baseline.head !== '' ? guidanceValue(baseline.head) : null
  lines.push(head !== null
    ? `  2. git checkout ${head}（寄存时刻 HEAD）`
    : '  2. git checkout：卡片未带 HEAD（unborn 分支或采集失败），clone 后按分支看工作区')
  lines.push(patchPath !== undefined
    ? `  3. git apply ${patchPath}（复原未提交改动）`
    : '  3. git apply：本卡无随卡补丁，跳过')
  lines.push(typeof testCommand === 'string' && testCommand !== ''
    ? `  4. 跑测试（${testCommand}）对比寄存基线，漂移即 MISMATCH 处理`
    : '  4. 跑测试：信封未带基线测试命令，按项目惯例自跑并记录')
  return lines
}

// ---------------------------------------------------------------------------
// B. 机器信封（双形态输出：人的卡片 .md + 机器的接手信封 .envelope.json）
// ---------------------------------------------------------------------------

/**
 * 补丁随卡信息（PushResult / 信封 extra / HandoffEnvelope.patch 三处共用）。
 * patchFormat/chunks 是 0.4.x gzip/分块扩展：patchFormat='gzip' = 补丁以 gzip 压缩形态
 * 随卡（.patch.gz 或分块 .patch.NNN.gz），chunks>1 = 分块数；旧消费者天然忽略，
 * bytes 恒为未压缩补丁全文的字节数（压缩块字节数进取件面 patchBytes）。
 */
export type PatchInfo = {
  bytes: number
  truncated: boolean
  sidecar: boolean
  patchFormat?: 'gzip'
  chunks?: number
}

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
  /** ── 0.4.1 物质层扩展（全部可选，旧消费者天然忽略）── */
  /** 未提交改动补丁随卡情况 */
  patch?: PatchInfo
  /** 未跟踪且未被 ignore 的新文件清单（只列不带货） */
  untracked?: Array<{ file: string; bytes: number }>
  /** 源机标识 */
  host?: { hostname: string; platform: string }
  /** 基线测试命令提示 */
  test?: { command: string }
  /** 本卡接替的前置卡 id */
  supersedes?: string
  /** 卡片 .md 文件字节哈希（sha256 hex）——签名面覆盖到卡本体：取侧回读比对，非持钥篡改卡面可检出 */
  cardSha256?: string
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


/** 基线测试提示：源目录 package.json 有 test 脚本 → 信封记录命令（取件方先跑基线再对比，漂移即警告） */
function testHint(cwd: string): { test?: { command: string } } {
  try {
    const raw = readFileSync(join(cwd, 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { scripts?: { test?: unknown } }
    if (typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim() !== '') {
      return { test: { command: 'npm test' } }
    }
  } catch { /* 无 package.json / 坏 JSON：无提示 */ }
  return {}
}

/** buildEnvelope 的结构化入参：Card 天然满足，单测可用最小字面量 */
export interface EnvelopeExtra {
  /** 未提交改动补丁随卡情况（bytes/truncated/sidecar，gzip/分块扩展见 PatchInfo） */
  patch?: PatchInfo
  /** 未跟踪且未被 ignore 的新文件清单（只列不带货） */
  untracked?: Array<{ file: string; bytes: number }>
  /** 源机标识（跨机接管时判断路径体系/OS） */
  host?: { hostname: string; platform: string }
  /** 基线测试命令提示（来自源目录 package.json scripts.test） */
  test?: { command: string }
  /** 本卡接替的前置卡 id（接力链） */
  supersedes?: string
  /** 卡片 .md 文件字节哈希（sha256 hex，落卡后回读计算）——进签名面 */
  cardSha256?: string
}

export interface EnvelopeSource {
  id?: string
  from?: { agent?: string; title?: string }
  sections: { goal?: string; done?: string; remaining?: string; stopped?: string; warnings?: string; files?: string }
}

/** 卡片 → 接手信封（确定性：同一张卡永远产出同一个 JSON）；extra 为物质层扩展字段 */
export function buildEnvelope(card: EnvelopeSource, extra?: EnvelopeExtra): HandoffEnvelope {
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
    ...(extra?.patch ? { patch: extra.patch } : {}),
    ...(extra?.untracked && extra.untracked.length > 0 ? { untracked: extra.untracked } : {}),
    ...(extra?.host ? { host: extra.host } : {}),
    ...(extra?.test ? { test: extra.test } : {}),
    ...(extra?.supersedes ? { supersedes: extra.supersedes } : {}),
    ...(extra?.cardSha256 ? { cardSha256: extra.cardSha256 } : {}),
  }
}

/** 信封落盘路径（与卡片同屋 pending/，取件时同步消费） */
export function envelopePath(id: string, dir?: string): string {
  return join(pendingDir(dir), `${id}.envelope.json`)
}

/** 卡片 .md 文件的 sha256（hex）；读不了回 undefined——签名是尽力而为，缺哈希不阻断 */
function fileSha256(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * 取件时同步消费信封：读出字符数（供人渲染）后删除 pending/ 下的信封文件。
 * 只在 loadCard 成功后调用（id 已过 SAFE_ID 闸，无路径穿越面）；信封是纯派生物，
 * 残留无害（core 列表只认 .md），读/删任一步失败都吞掉，绝不影响取件主流程成败。
 */
function consumeEnvelope(id: string, dir?: string): { chars: number; data?: Record<string, unknown> } | undefined {
  const p = envelopePath(id, dir)
  try {
    if (!existsSync(p)) return undefined
    let chars: number | undefined
    let data: Record<string, unknown> | undefined
    try {
      // 读侧尺寸闸：外来巨信封不整体读进内存——信封是 ≤1200 字目标的派生物，超限直接按异常丢弃
      if (statSync(p).size <= 8 * 1024 * 1024) {
        const raw = readFileSync(p, 'utf-8')
        chars = raw.length
        try {
          const parsed = JSON.parse(raw) as unknown
          if (parsed !== null && typeof parsed === 'object') data = parsed as Record<string, unknown>
        } catch { /* 坏 JSON：只有 chars，无字段 */ }
      }
    } catch { /* 读失败不挡删除 */ }
    try {
      rmSync(p, { force: true })
    } catch { /* 删失败也不挡取件：残留信封会被列表忽略 */ }
    return chars === undefined ? undefined : { chars, data }
  } catch {
    return undefined
  }
}

/** 补丁 sidecar 路径（与卡片同屋 pending/，取件时随卡搬去 archived/） */
function patchPath(id: string, dir?: string): string {
  return join(pendingDir(dir), `${id}.patch`)
}

/**
 * 取件时同步消费补丁：pending → archived（与 .md 同步搬），返回归档后路径供 apply 指引。
 * 0.4.x 物质层补全：gzip 单块（<id>.patch.gz）与 gzip 分块（<id>.patch.NNN.gz）按
 * gzip magic（1f 8b）识别，多块按序重组解压后写归档 <id>.patch——apply 指引路径不变；
 * 解压失败时压缩块原样归档并回 warn（绝不静默丢弃材料）。旧纯文本 .patch 原样搬移。
 */
function consumePatch(id: string, dir?: string): RestoredPatch | undefined {
  try {
    const src = patchPath(id, dir)
    if (existsSync(src)) {
      const dest = join(archivedDir(dir), `${id}.patch`)
      try {
        renameSync(src, dest)
        return { path: dest, bytes: statSync(dest).size }
      } catch { /* 搬失败不挡取件：残留补丁会被列表忽略（列表只认 .md） */ }
      return undefined
    }
    return restoreGzipPatch(id, dir)
  } catch { /* 整体失败只降级 */ }
  return undefined
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
    cards?: Array<{ id: string; from?: string; title?: string; project?: string; pushed_at: string; stopped?: string; supersedes?: string }>
    total?: number
    skipped?: number
    text?: string
    axis?: CardAxis
    mismatches?: string[]
    unavailable?: string
    coverage?: unknown
    envelopeChars?: number
    sig?: SigVerdict
    patchPath?: string
    patchBytes?: number
    patchFormat?: 'gzip' | 'gzip-chunked'
    patchChunks?: number
    patchWarn?: string
    testCommand?: string
    supersedes?: string
    crossOS?: { source: string; local: string }
    baseline?: RepoBaseline
    error?: unknown
  }
  if (v?.ok !== true) {
    return [{ type: 'text', text: `❌ 收件箱操作失败：${typeof v?.error === 'string' ? v.error : JSON.stringify(v?.error)}` }]
  }
  if (v.action === 'list') {
    const cards = v.cards ?? []
    if (cards.length === 0 && !v.skipped) return [{ type: 'text', text: '📭 收件箱为空（~/.handoff/pending/ 无待取件）' }]
    const lines = cards.map((c, i) => `${i + 1}. ${c.id}｜来自 ${c.from ?? '（未知来源）'}｜项目 ${c.project || '（无）'}｜${c.pushed_at || '（无时间）'}`)
    if (typeof v.skipped === 'number' && v.skipped > 0) {
      lines.push(`（另有 ${v.skipped} 张坏卡被跳过，详见宿主日志）`)
    }
    return [{ type: 'text', text: `📬 待取件 ${cards.length} 张：\n${lines.join('\n')}\n\n取件：handoff_inbox({ action: "load", id: "<id>" })` }]
  }
  // history：卡链检索（archived/ 按时间正序，接力链 supersedes 一并报出）
  if (v.action === 'history') {
    const cards = v.cards ?? []
    if (cards.length === 0) return [{ type: 'text', text: '🗂️ 卡链历史为空（archived/ 无匹配卡——用 project / cwd 缩小或放宽过滤）' }]
    const lines = cards.map((c, i) =>
      `${i + 1}. ${c.id}｜${c.title || '（无标题）'}｜${c.pushed_at || '（无时间）'}${typeof c.supersedes === 'string' && c.supersedes !== '' ? `｜接替 ${c.supersedes}` : ''}\n   停在：${c.stopped || '（无停点记录）'}`,
    )
    const total = typeof v.total === 'number' ? v.total : cards.length
    return [{ type: 'text', text: `🕘 卡链历史（archived/ 匹配 ${total} 张，时间正序取尾 ${cards.length} 张）：\n${lines.join('\n')}` }]
  }
  // load
  const lines = ['📥 已取件（消费即弃，卡片已归档）：', '', v.text ?? '']
  // 吸收回执提示：memory 轴卡取件即注入完成，按建议加载段吸收（生命周期已记 memory-absorbed）
  if (v.axis === 'memory') {
    lines.push('🧠 记忆已随卡注入，按建议加载段吸收')
  }
  const patchPath = typeof v.patchPath === 'string' ? v.patchPath : undefined
  if (patchPath !== undefined) {
    const kb = typeof v.patchBytes === 'number' ? `${Math.max(1, Math.round(v.patchBytes / 1024))} KB` : '? KB'
    lines.push(`🩹 补丁随卡归档（${kb} 未提交改动）：先 \"git apply --check ${patchPath}\" 验证可干净应用，再 \"git apply ${patchPath}\" 复原；--check 失败（目标仓已前进）时用 \"git apply -3 ${patchPath}\" 三方合并尝试自助解决冲突`)
    // gzip/分块形态如实告知：解压重组已在本机完成，apply 指引针对解压后的纯文本补丁
    if (v.patchFormat === 'gzip' || v.patchFormat === 'gzip-chunked') {
      const n = typeof v.patchChunks === 'number' && v.patchChunks > 1 ? `${v.patchChunks} 块已按序重组，` : ''
      lines.push(`🧯 补丁以 gzip 压缩形态随卡（${n}取件时已自动解压为纯文本）——上方 git apply 指引针对解压后的归档补丁`)
    }
  }
  if (typeof v.patchWarn === 'string' && v.patchWarn !== '') {
    lines.push(`⚠️ 补丁还原降级：${v.patchWarn}`)
  }
  if (typeof v.testCommand === 'string' && v.testCommand !== '') {
    lines.push(`🧪 基线测试提示（来自寄存方信封）：接手后先跑 \"${v.testCommand}\" 对比寄存时状态，漂移即 MISMATCH 处理`)
  }
  if (typeof v.supersedes === 'string' && v.supersedes !== '') {
    lines.push(`🔗 本卡接替前置卡 ${v.supersedes}（接力链）`)
  }
  if (v.crossOS !== undefined) {
    lines.push(`🖥️ 跨 OS 接手：源卡来自 ${v.crossOS.source}，本机是 ${v.crossOS.local}——卡内路径需人工映射后才能执行`)
  }
  // 基线恢复指引（extras.baseline 在场才渲染）：clone → checkout → apply → 跑测试
  if (v.baseline !== undefined) {
    lines.push('', ...renderBaselineGuidance(v.baseline, patchPath, typeof v.testCommand === 'string' ? v.testCommand : undefined))
  }
  const coverageLine = renderCoverageLine(v.coverage)
  if (coverageLine !== null) lines.push('', coverageLine)
  if (typeof v.envelopeChars === 'number' && v.envelopeChars >= 0) {
    lines.push('', `机器信封已随卡归档（${v.envelopeChars} chars）`)
  }
  if (v.sig === 'ok') {
    lines.push('🔐 信封签名校验通过（HMAC-SHA256）——六段内容与补丁元信息自写侧落卡后未被更动')
  } else if (v.sig === 'tampered') {
    lines.push('🚨 信封签名校验失败：信封内容与写侧签名不符——可能被越权改写或传输损坏。卡片按最高怀疑处理：关键陈述逐条对 git 当面核实后再动手。')
  } else if (v.sig === 'no-key') {
    lines.push('🔐 信封带签名但本机总线无对应密钥（跨信任域取件），未验签。')
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
  /** 本卡接替的前置卡 id（接力寄存）：只进信封不进 SPEC frontmatter */
  supersedes?: string
  /** 空壳卡守门旁路：六段全是兜底占位时，确认要寄存空壳卡 */
  confirmSkeleton?: boolean
  /** 密钥闸旁路：扫描命中疑似密钥时，确认带密寄存（留痕进返回值） */
  allowSecrets?: boolean
}

export type PushResult =
  | {
      ok: true
      id: string
      path: string
      skipped: boolean
      note: string
      coverage: CoverageStats
      /** 未提交改动补丁随卡情况；undefined = 源目录非 git 仓库 */
      patch?: PatchInfo
      /** 本卡接替的前置卡 id（透传进信封） */
      supersedes?: string
      /** 空壳卡（守门旁路后落盘）：调用方/下游可据此提示 */
      skeleton?: boolean
      /** 密钥闸旁路留痕：命中规则名列表 */
      secretsBypass?: string[]
    }
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
 * opts.extras 是插件侧内部出卡通道（pushMemoryCard 等程序化调用方覆盖 axis/payload
 * 立约缺省）：不进 handoff_push 工具入参面，模型输入到不了 extras，密钥闸不旁路。
 */
export function pushHandoff(session: unknown, args: PushArgs, opts?: { dir?: string; extras?: Record<string, unknown> }): PushResult {
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
    // 物质层采集：未提交改动补丁（非 git 目录 null）——先于 sections 组装，
    // 便于把「非 git 仓」如实写进警告段而不是让 git 字段静默为空
    const patchBundle = collectPatch(cwd)
    // 补丁全文解析：vendor 超 512KB 整份拒带（patch 为空串）时按 core 同款口径自采
    // diff 全文，交给 gzip/分块打包管线带走——绝不静默丢补丁；自采失败才如实降级
    const fullPatch = resolvePatchText(cwd, patchBundle)
    // untracked 小文件内容旅行：清单里单文件 <64KB 的项手拼「新增文件 diff」追加进
    // 补丁全文（追加部分与 tracked diff 同过密钥闸）；大文件/二进制/不可读仍只列清单
    const inline = patchBundle !== null
      ? augmentPatchWithUntracked(cwd, fullPatch, patchBundle.untracked)
      : { patch: '', inlined: [], leftOut: [] }
    const finalPatch = inline.patch
    const finalPatchBytes = Buffer.byteLength(finalPatch, 'utf-8')
    const sections: CardSections = {
      goal: section(args.goal, fallback.goal),
      files: section(args.files, fallback.files),
      done: section(args.done, fallback.done),
      remaining: section(args.remaining, fallback.remaining),
      stopped: section(args.stopped, fallback.stopped),
      warnings: section(args.warnings, fallback.warnings),
    }
    if (patchBundle === null && cwd !== '') {
      const honest = `源目录未识别为 git 仓库（cwd=${cwd}），文件改动无法随卡携带、取件侧也无法做 git 核验。`
      sections.warnings = sections.warnings === '' ? honest : `${sections.warnings}
${honest}`
    }
    const suggested = pick(args.suggested, '')
    if (suggested !== '') sections.suggested = section(suggested, '')

    // 密钥闸（先例：gitleaks/Push Protection——阻断为默认 + 留痕旁路）：卡随同步盘跨机传播
    // 并进入下游会话上下文，比 git 更宽的泄漏面；命中即拒，理由回喂调用方
    // title/to/project 标量也进扫描——密钥从 title 侧门出盘等于没闸
    // 补丁 diff 同扫（T2-P，红队驱动）：diff 全是源码行，密钥走补丁走私等于没闸；
    // 扫描口径是增补后的补丁全文——untracked 小文件的手拼 diff 一样过闸，不成走私侧门
    const secretHits = [
      ...scanSecrets({
        ...sections,
        suggested: sections.suggested,
        title: args.title,
        to: args.to,
        project: args.project,
      }),
      ...(finalPatch !== '' ? scanSecrets({ patch: finalPatch }) : []),
    ]
    if (secretHits.length > 0 && args.allowSecrets !== true) {
      const detail = secretHits.map((h) => `${h.rule}@${h.section}（${h.masked}）`).join('；')
      // 死亡地图：写侧拒收进生命周期事件层（target 用标题，detail 不落密钥值只落规则名）
      recordLifecycleEvent({ stage: 'write', reason: 'secret_gate', target: scalar(args.title, '') || 'untitled', detail: `${secretHits.length} hits：${secretHits.map((h) => `${h.rule}@${h.section}`).join('；')}` }, opts?.dir)
      return {
        ok: false,
        error: `密钥闸：发现 ${secretHits.length} 处疑似密钥——${detail}。请 redact 后重试；确要带密寄存，传 allowSecrets: true（旁路会留痕）。`,
      }
    }
    // 空壳卡守门（42% 噪音的根因在生产者侧）：六段全是兜底占位 = 无会话环境且无手写段。
    // 拦截理由回喂——模型可亲手蒸馏重试，或确认空壳旁路；不破坏「诚实的空卡」场景
    // 判据与文案对齐：「均未手写」按字面执行——任一段有手写内容就不算空壳
    //（部分手写+部分兜底的卡由取件侧 lowInfo 徽标兜底，不在生产者侧拦截）
    const userWrote = [args.goal, args.files, args.done, args.remaining, args.stopped, args.warnings, args.suggested]
      .some((v) => typeof v === 'string' && v.trim() !== '')
    const skeleton = !userWrote && isLowInfoCardMarkdown(
      ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings', 'suggested']
        .map((k) => (sections as unknown as Record<string, string | undefined>)[k] ?? '')
        .join('\n'),
    )
    if (skeleton && args.confirmSkeleton !== true) {
      // 死亡地图：空壳拒收也是写侧事件（噪音治理的归因数据源）
      recordLifecycleEvent({ stage: 'write', reason: 'skeleton_gate', target: scalar(args.title, '') || 'untitled', detail: '六段全兜底占位且未手写' }, opts?.dir)
      return {
        ok: false,
        error: '空壳卡守门：六段全是兜底占位文本（无会话环境且六段均未手写）。请按 /handoff 纪律亲手蒸馏六段后重试；确要寄存空壳卡（如「无在途工作」声明），传 confirmSkeleton: true。',
      }
    }
    // 四态覆盖率：只统计不强制（纪律见 coverageOfDone 注释），随卡进 extras 持久化，
    // 取件侧 parseCard 后可从 extras.coverage 读回
    const coverage = coverageOfDone(sections.done)
    // git 快照一次采集两处用：card.git 与基线 branch（同一次采集口径一致，不会各说各话）
    const gitSnapshot = collectGitSnapshot(cwd)
    // 仓库基线（四轴 IR 立约）：remote/head/branch 三元组进 extras.baseline，取件方据此
    // clone → checkout → apply → 跑测试复原有现场。remote 与 head 都拿不到
    //（非 git 仓 / unborn 且无远端）→ 整字段如实缺省，不写空壳假基线
    const baselineSrc = collectRepoBaseline(cwd)
    const baseline: RepoBaseline | undefined = baselineSrc.remote !== null || baselineSrc.head !== null
      ? { remote: baselineSrc.remote, head: baselineSrc.head, branch: gitSnapshot.branch }
      : undefined
    const card: Card = {
      handoff: 1,
      id: generateId(),
      from: { agent: 'dsh', session: sessionId, title: scalar(args.title, '') },
      to: scalar(args.to, 'any'),
      project: scalar(args.project, ''),
      cwd,
      pushed_at: localIso(new Date()),
      git: gitSnapshot,
      tasks: todoToTasks(facts).filter((t): t is TaskSnapshot => true),
      sections,
      extras: {
        // 四轴 IR 立约缺省：会话卡。内部出卡通道（opts.extras）可覆盖为 memory/config
        axis: 'session' satisfies CardAxis,
        coverage,
        ...(secretHits.length > 0 && args.allowSecrets === true ? { secretsBypass: secretHits.map((h) => `${h.rule}@${h.section}`) } : {}),
        ...(baseline !== undefined ? { baseline } : {}),
        // 接力链进 extras：信封随取件消费即弃，archived 卡只剩卡面——卡链检索
        // （handoff_inbox action=history）要报 supersedes 就得靠这个持久通道
        ...(typeof args.supersedes === 'string' && args.supersedes.trim() !== '' ? { supersedes: args.supersedes.trim() } : {}),
        ...(opts?.extras ?? {}),
      },
    }
    const path = writeCard(card, opts?.dir)
    // 物质层第二文件：补丁边车（密钥闸已扫过增补全文；打包管线按尺寸选纯文本/gzip/分块——
    // 超 512KB 不再整份拒带，先压缩、仍超则 480KB 分块，最需要带的时刻也带得走）
    const patchNotes: string[] = []
    let patchInfo: PatchInfo | undefined
    if (finalPatch !== '') {
      try {
        const packed = writePatchSidecar(card.id, finalPatch, opts?.dir)
        patchInfo = packed.format === 'gzip-chunked'
          ? { bytes: finalPatchBytes, truncated: false, sidecar: true, patchFormat: 'gzip', chunks: packed.chunks }
          : packed.format === 'gzip'
            ? { bytes: finalPatchBytes, truncated: false, sidecar: true, patchFormat: 'gzip' }
            : { bytes: finalPatchBytes, truncated: false, sidecar: true }
        patchNotes.push(
          packed.format === 'gzip-chunked'
            ? `未提交 diff 过大（${Math.round(finalPatchBytes / 1024)} KB），gzip 分 ${packed.chunks} 块随卡（.patch.001.gz…）：取件侧自动重组解压后给出 git apply 指引`
            : packed.format === 'gzip'
              ? `未提交 diff 过大（${Math.round(finalPatchBytes / 1024)} KB），gzip 压缩后单块随卡（${Math.max(1, Math.round(packed.writtenBytes / 1024))} KB .patch.gz）：取件侧自动解压后给出 git apply 指引`
              : `补丁随卡（${Math.max(1, Math.round(finalPatchBytes / 1024))} KB 未提交改动）：取件时会给出 git apply 指引`,
        )
      } catch (e) {
        patchNotes.push(`补丁随卡失败（卡片本体已寄存）：${readableError(e)}`)
      }
    } else if (patchBundle !== null && patchBundle.truncated) {
      // vendor 拒带且自采也失败：如实降级为未随卡，绝不假称已带
      patchInfo = { bytes: patchBundle.bytes, truncated: true, sidecar: false }
      patchNotes.push(`未提交 diff 过大（${Math.round(patchBundle.bytes / 1024)} KB 超上限）且自采失败未随卡——请自行 git commit/push 携带`)
    }
    if (patchBundle !== null && patchBundle.untracked.length > 0) {
      const total = patchBundle.untracked.length
      const names = inline.leftOut.slice(0, 5).map((u: { file: string }) => u.file).join('、')
      if (inline.leftOut.length === 0) {
        patchNotes.push(`未跟踪新文件 ${total} 个已随补丁携带（单文件 <64KB 手拼新增 diff）——清单仍进机器信封备核`)
      } else if (inline.inlined.length > 0) {
        patchNotes.push(`未跟踪新文件 ${total} 个中 ${inline.inlined.length} 个小文件已随补丁携带，${inline.leftOut.length} 个超大/二进制不随卡${inline.leftOut.length > 5 ? `（前 5：${names}…）` : `（${names}）`}——请自行提交或携带`)
      } else {
        patchNotes.push(`未跟踪新文件 ${total} 个不随卡${total > 5 ? `（前 5：${names}…）` : `（${names}）`}——请自行提交或携带`)
      }
    }
    // 机器信封（协议扩展提案，handoff: 1 SPEC 不动）：卡片落盘成功后落第二文件。
    // 信封是纯派生物——写失败只降级进 note，不回滚已寄存的卡片
    let envelopeNote = ''
    try {
      const extra = {
        ...(patchInfo ? { patch: patchInfo } : {}),
        ...(patchBundle !== null && patchBundle.untracked.length > 0 ? { untracked: patchBundle.untracked } : {}),
        host: { hostname: hostname(), platform: process.platform },
        ...testHint(cwd),
        ...(typeof args.supersedes === 'string' && args.supersedes.trim() !== '' ? { supersedes: args.supersedes.trim() } : {}),
      }
      // 尽力签名：密钥生成/读取失败回 null，信封照常落盘（无 sig 字段 = 旧卡兼容形态）。
      // 签名面含卡本体：落卡回读算 sha256 一起签——取侧回读比对，非持钥改卡面也抓得到。
      const key = loadOrCreateSigningKey(opts?.dir)
      const env = buildEnvelope(card, {
        ...extra,
        cardSha256: fileSha256(join(pendingDir(opts?.dir), `${card.id}.md`)),
      })
      writeFileSync(envelopePath(card.id, opts?.dir), JSON.stringify(key === null ? env : signEnvelope(env as unknown as Record<string, unknown>, key)), 'utf-8')
    } catch (e) {
      envelopeNote = `机器信封落盘失败（卡片本体已寄存）：${readableError(e)}`
    }
    const bypassNote = secretHits.length > 0 && args.allowSecrets === true
      ? `密钥闸旁路留痕：${secretHits.map((h) => `${h.rule}@${h.section}`).join('；')}`
      : ''
    const note = [probe.note, ...truncated, ...patchNotes, envelopeNote, bypassNote, skeleton ? '空壳卡（已确认寄存）' : ''].filter(Boolean).join('；')
    return {
      ok: true,
      id: card.id,
      path,
      skipped: probe.skipped,
      note,
      coverage,
      ...(patchInfo ? { patch: patchInfo } : {}),
      ...(typeof args.supersedes === 'string' && args.supersedes.trim() !== '' ? { supersedes: args.supersedes.trim() } : {}),
      ...(skeleton ? { skeleton: true } : {}),
      ...(secretHits.length > 0 && args.allowSecrets === true ? { secretsBypass: secretHits.map((h) => h.rule) } : {}),
    }
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

// ---------------------------------------------------------------------------
// A2b. 卡链检索：archived/ 已归档卡按 project / cwd 回查（接力链可溯）
// ---------------------------------------------------------------------------

/** 卡链历史单卡上限条数（与 core ARCHIVED_KEEP=50 同量级——再早的已被滚动归档淘汰） */
export const HISTORY_TAIL_MAX = 50
/** stopped 摘要截断（够辨认停点，不把卡正文搬进返回值） */
export const HISTORY_STOPPED_MAX = 120

/** 卡链历史单行（type 别名：JsonValue 契约要隐式索引签名，InboxItem 同款） */
export type HistoryItem = {
  id: string
  title: string
  pushed_at: string
  /** 「停在哪」段摘要（截 HISTORY_STOPPED_MAX；控制字符已剥离） */
  stopped: string
  /** 本卡接替的前置卡 id（extras.supersedes；旧卡/无接力缺省） */
  supersedes?: string
}

export type InboxHistoryResult =
  | { ok: true; action: 'history'; cards: HistoryItem[]; total: number; project?: string; cwd?: string }
  | { ok: false; error: string }

/**
 * 卡链检索：按 project 或 cwd 查 archived/ 已归档卡（复用 core listArchivedReport，
 * 坏卡照旧跳过并忽略）。时间正序（pushed_at 字典序——同机卡共享时区口径），取尾
 * HISTORY_TAIL_MAX 条；两个过滤条件都给 = AND，都不给 = 全量回查。
 * supersedes 取自卡面 extras（寄存时随 extras 持久化——信封取件即弃，卡面才是持久通道）。
 */
export function inboxHistory(opts?: { dir?: string; project?: string; cwd?: string }): InboxHistoryResult {
  try {
    const project = typeof opts?.project === 'string' ? opts.project.trim() : ''
    const cwd = typeof opts?.cwd === 'string' ? opts.cwd.trim() : ''
    const report = listArchivedReport(opts?.dir)
    const rows: HistoryItem[] = report.cards
      .filter((c) => (project === '' || c.project === project) && (cwd === '' || c.cwd === cwd))
      .map((c) => {
        const sup = (c.extras as Record<string, unknown> | undefined)?.['supersedes']
        return {
          id: c.id,
          title: c.from.title,
          pushed_at: c.pushed_at,
          stopped: stripControlChars(c.sections.stopped ?? '').slice(0, HISTORY_STOPPED_MAX),
          ...(typeof sup === 'string' && sup !== '' ? { supersedes: sup } : {}),
        }
      })
      .sort((a, b) => a.pushed_at.localeCompare(b.pushed_at))
    return {
      ok: true,
      action: 'history',
      cards: rows.slice(-HISTORY_TAIL_MAX),
      total: rows.length,
      ...(project !== '' ? { project } : {}),
      ...(cwd !== '' ? { cwd } : {}),
    }
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
      /** 卡内 extras.axis 四轴标记（防御式提取，外来旧卡缺省） */
      axis?: CardAxis
      /** 卡内 extras.coverage（防御式提取，外来卡/坏数据缺省） */
      coverage?: CoverageStats
      /** 随卡消费的机器信封 JSON 字符数；卡无信封（旧卡/外写卡）缺省 */
      envelopeChars?: number
      /** 随卡归档的未提交改动补丁路径（git apply 可复原；gzip 形态已自动解压为纯文本）；卡无补丁缺省 */
      patchPath?: string
      patchBytes?: number
      /** 补丁 gzip 压缩随卡形态（取件时已自动解压重组）；旧纯文本 .patch 缺省 */
      patchFormat?: 'gzip' | 'gzip-chunked'
      /** gzip 块数（单块=1、分块=N） */
      patchChunks?: number
      /** 补丁还原降级说明（解压失败等，压缩块已原样归档）；正常还原缺省 */
      patchWarn?: string
      /** 信封提示的基线测试命令 */
      testCommand?: string
      /** 本卡接替的前置卡 id */
      supersedes?: string
      /** 跨 OS 接手：源卡 OS 与本机不同（路径体系需人工映射） */
      crossOS?: { source: string; local: string }
      /** 卡内 extras.baseline 的仓库基线（防御式提取，外来卡/坏数据缺省） */
      baseline?: RepoBaseline
      /** 信封验签结论：unsigned=无签名（旧卡/外写卡），no-key=有签名但本机无对应密钥 */
      sig?: SigVerdict
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
    // 卡面哈希要在 loadCard 搬走 .md 之前取（load 后文件在 archived/，内容相同但口径以取件瞬间为准）
    const cardShaBeforeLoad = fileSha256(join(pendingDir(opts?.dir), `${trimmed}.md`))
    const card = loadCard(trimmed, opts?.dir)
    const check = verifyGit(card)
    // 机器信封随卡消费：core 的 loadCard 只搬 .md，信封生命周期归本插件管
    const envelope = consumeEnvelope(trimmed, opts?.dir)
    const envelopeChars = envelope?.chars
    const env = envelope?.data ?? {}
    // 物质层随卡：补丁 sidecar 与 .md 同步搬去 archived/
    const patchArchived = consumePatch(trimmed, opts?.dir)
    const coverage = coverageFromExtras(card.extras)
    const baseline = baselineFromExtras(card.extras)
    const axis = axisFromExtras(card.extras)
    // 吸收回执：memory 轴卡取件即「记忆已随卡注入」——正向生命周期事件（闭集
    // 'memory-absorbed'），取件方按建议加载段吸收的账本留痕；detail 不落卡正文
    if (axis === 'memory') {
      recordLifecycleEvent({ stage: 'read', reason: 'memory-absorbed', target: card.id, detail: 'memory 轴卡已取件，按建议加载段吸收' }, opts?.dir)
    }
    // 信封验签：sig 缺席（旧卡/外写卡）不算异常；mac 不合或卡面哈希与签名面不符 = 篡改/损坏，进警告 + 死亡地图
    const sigVerdict: SigVerdict = envelope?.data !== undefined
      ? verifyEnvelopeSig(envelope.data, opts?.dir, cardShaBeforeLoad)
      : 'unsigned'
    if (sigVerdict === 'tampered') {
      recordLifecycleEvent({ stage: 'pickup', reason: 'sig_tampered', target: card.id, detail: '信封 HMAC 验签失败' }, opts?.dir)
    }
    const out: InboxLoadResult = {
      ok: true,
      action: 'load',
      id: card.id,
      text: renderCard(card),
      mismatches: check.mismatches,
      ...(sigVerdict !== 'unsigned' ? { sig: sigVerdict } : {}),
    }
    if (check.unavailable !== undefined) out.unavailable = check.unavailable
    // 死亡地图：取侧核验异常进生命周期事件层（MISMATCH 与 UNAVAILABLE 都算「卡面与仓库现实脱节」）
    if (check.mismatches.length > 0) {
      recordLifecycleEvent({ stage: 'pickup', reason: 'drift_mismatch', target: card.id, detail: `${check.mismatches.length} 处核验冲突` }, opts?.dir)
    } else if (check.unavailable !== undefined && check.unavailable !== '') {
      recordLifecycleEvent({ stage: 'pickup', reason: 'git_unavailable', target: card.id, detail: check.unavailable.slice(0, 120) }, opts?.dir)
    }
    if (axis !== undefined) out.axis = axis
    if (coverage !== undefined) out.coverage = coverage
    if (baseline !== undefined) out.baseline = baseline
    if (envelopeChars !== undefined) out.envelopeChars = envelopeChars
    if (patchArchived !== undefined) {
      if (patchArchived.path !== undefined) {
        out.patchPath = patchArchived.path
        try {
          out.patchBytes = patchArchived.bytes ?? statSync(patchArchived.path).size
        } catch { /* stat 失败不挡取件 */ }
      }
      if (patchArchived.format !== undefined) {
        out.patchFormat = patchArchived.format
        out.patchChunks = patchArchived.chunks
      }
      if (patchArchived.warn !== undefined) out.patchWarn = patchArchived.warn
    }
    if (typeof env['test'] === 'object' && env['test'] !== null) {
      const cmd = (env['test'] as { command?: unknown })['command']
      if (typeof cmd === 'string' && cmd !== '') out.testCommand = cmd
    }
    if (typeof env['supersedes'] === 'string' && env['supersedes'] !== '') out.supersedes = env['supersedes']
    // 跨 OS 接手：源卡 OS 与本机不同 → 路径体系不同（D:\… vs /mnt/…），提示人工映射
    if (typeof env['host'] === 'object' && env['host'] !== null) {
      const srcPlatform = (env['host'] as { platform?: unknown })['platform']
      if (typeof srcPlatform === 'string' && srcPlatform !== '' && srcPlatform !== process.platform) {
        out.crossOS = { source: srcPlatform, local: process.platform }
      }
    }
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

/** 寄存/取件后的宿主通知（对齐 Claude Code 通知习惯）：
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
    description: '把当前 DSH 会话寄存为一张 handoff: 1 交接卡片到共享收件箱 ~/.handoff/pending/（任何 agent 可取件）。六段文本（goal/files/done/remaining/stopped/warnings）+ 可选 suggested（建议加载段，非协议段）可选传入；留空段从会话事件流确定性兜底，不调 LLM。内置两道守门：密钥扫描（云厂商 key/私钥头/高熵赋值，命中拒绝并回喂理由，allowSecrets 留痕旁路；扫描覆盖补丁全文含未跟踪小文件的手拼新增 diff）与空壳卡守门（六段全是兜底占位时拒绝，confirmSkeleton 旁路）。若源目录是 git 仓库且有未提交改动，同步落补丁 <id>.patch（取件方 git apply 可复原；diff 超 512KB 先 gzip 压缩随卡、压缩后仍超则 480KB 分块 .patch.NNN.gz，取件侧按 gzip magic 自动解压重组；未跟踪清单里单文件 <64KB 的小文件手拼新增 diff 随补丁携带，超大/二进制仍只列清单）。另落机器信封 <id>.envelope.json（含源机标识/未跟踪清单/基线测试提示，协议扩展提案）并对 done 段产出四态覆盖率统计 coverage（只统计不强制）。卡片 extras 带四轴立约标记 axis（本工具恒为 session）与仓库基线 baseline（origin/HEAD/分支，拿不到如实缺省）。返回 { ok, id, path, coverage, patch? } 规范值。',
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
      supersedes: { type: 'string', description: '本卡接替的前置卡 id（接力寄存时传）：记录进机器信封，取件侧提示接力链' },
      confirmSkeleton: { type: 'boolean', description: '空壳卡守门旁路：六段全是兜底占位被拦截时，确认要寄存空壳卡传 true' },
      allowSecrets: { type: 'boolean', description: '密钥闸旁路：扫描命中疑似密钥被拦截时，确认带密寄存传 true（旁路留痕）' },
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
    description: '交接卡片收件箱：action=list 列 ~/.handoff/pending/ 待取件（id/来源/项目/时间）；action=load + id 取件（消费即弃，卡片移到 archived/，随卡消费机器信封，附 git 核验 MISMATCH/UNAVAILABLE 警告与四态覆盖率；卡带仓库基线 baseline 时输出 clone → checkout → apply → 跑测试四步恢复指引；memory 轴卡输出「记忆已随卡注入」吸收提示）；action=history 按 project 或 cwd 回查 archived/ 已归档卡（卡链检索：id/标题/寄存时刻/停点摘要/接替 supersedes，时间正序尾 50 条）。返回 { ok, ... } 规范值。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'load', 'history'], description: 'list 列待取件；load 取件（消费即弃）；history 卡链检索（查 archived/）' },
      id: { type: 'string', description: 'load 必填：卡片 id' },
      project: { type: 'string', description: 'history：按项目名过滤 archived/ 卡（与 cwd 同时给则为 AND）' },
      cwd: { type: 'string', description: 'history：按工作目录过滤 archived/ 卡（与 project 同时给则为 AND）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '操作是否成功' },
          action: { type: 'string', description: '实际执行的动作' },
          cards: { type: 'json', description: 'list：待取件摘要数组；history：卡链历史数组 [{ id, title, pushed_at, stopped, supersedes? }]' },
          total: { type: 'number', description: 'history：过滤命中的总数（返回值为时间正序尾 50 条）' },
          id: { type: 'string', description: 'load：取到的卡片 id' },
          text: { type: 'string', description: 'load：卡片全文（frontmatter + 六段）' },
          mismatches: { type: 'json', description: 'load：git 核验冲突（MISMATCH）' },
          unavailable: { type: 'string', description: 'load：无法核验说明（UNAVAILABLE）' },
          coverage: { type: 'json', description: 'load：卡片 extras.coverage 的四态覆盖率统计（无则缺省）' },
          baseline: { type: 'json', description: 'load：卡片 extras.baseline 的仓库基线 { remote, head, branch }（无则缺省）' },
          envelopeChars: { type: 'number', description: 'load：随卡消费的机器信封 JSON 字符数（卡无信封时缺省）' },
          error: { type: 'json', description: '失败原因' },
        },
      },
      render: renderInbox,
    },
    async execute(args: { action?: string; id?: string; project?: string; cwd?: string }, exec: { agent?: Agent; signal?: AbortSignal }) {
      if (args.action === 'list') return inboxList()
      if (args.action === 'history') return inboxHistory({ project: args.project, cwd: args.cwd })
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
      return { ok: false, error: `未知 action：${String(args.action)}（支持 list / load / history）` }
    },
  }))
}

/**
 * 换机上下文同步（0.2.0）：HANDOFF_HOME 的卡与签名密钥经 git 仓库端点跨机同步。
 * setup 启用（url 必填）；now = pull→push 一步闭环；status 只读零网络。
 * 凭据永不入参不入盘（userinfo 形态 URL 直接拒收），凭据走系统 git。
 */
export function registerSyncTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'handoff_sync',
    description: '换机上下文同步：把 ~/.handoff 的待取件/已归档卡与签名密钥经用户配置的 git 仓库跨机同步（A 机寄存+now，B 机 now 后 /inbox 取件即接续）。action=setup 首次启用（url 必填，https / ssh / 本地裸仓库路径，拒绝 user:pass@ 形态）；action=now 拉推一步到位；push / pull 单向；status 只读状态（零网络）。返回 { ok, ... } 规范值。',
    parameters: {
      action: { type: 'string', required: true, enum: ['setup', 'now', 'push', 'pull', 'status'], description: 'setup 首次启用（url 必填）；now 拉推闭环；push/pull 单向；status 只读' },
      url: { type: 'string', description: 'setup 必填：git 仓库地址（https://… / git@host:path / 本地裸仓库路径）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '操作是否成功' },
          action: { type: 'string', description: '实际执行的动作' },
          detail: { type: 'string', description: '动作后状态摘要' },
          ahead: { type: 'number', description: '待推送提交数' },
          behind: { type: 'number', description: '待拉取提交数' },
          status: { type: 'json', description: '同步状态对象（每次返回都附最新）' },
          error: { type: 'string', description: '失败原因' },
        },
      },
      render: renderSync,
    },
    async execute(args: { action?: string; url?: string }): Promise<SyncToolValue> {
      const action = args.action ?? 'status'
      try {
        if (action === 'setup') return withSyncStatus(await syncSetup(args.url ?? ''))
        if (action === 'now') return withSyncStatus(await syncNow())
        if (action === 'push') return withSyncStatus(await syncPush())
        if (action === 'pull') return withSyncStatus(await syncPull())
        if (action === 'status') {
          const st = syncStatusOf()
          if (st === undefined) return { ok: false, action, error: '换机同步未启用：先执行 action=setup 并给 url' }
          return { ok: true, action, status: st, detail: syncStatusLine(st) }
        }
        return { ok: false, action, error: `未知 action：${action}（支持 setup / now / push / pull / status）` }
      } catch (e) {
        return { ok: false, action, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }))
}

/** 工具返回面形状（对齐 output.schema：全部字段 JSON 值；type 别名才有隐式索引签名，interface 会挂 defineTool） */
type SyncToolValue = {
  ok?: boolean
  action?: string
  detail?: string
  ahead?: number
  behind?: number
  status?: SyncStatus
  error?: string
}

/** 动作结果附最新状态（工具返回面统一带 status，agent 一次调用看全貌） */
function withSyncStatus(r: SyncOutcome): SyncToolValue {
  const st = syncStatusOf()
  return {
    ok: r.ok,
    action: r.action,
    detail: r.detail ?? (st !== undefined ? syncStatusLine(st) : undefined),
    ahead: r.ahead,
    behind: r.behind,
    error: r.error,
    ...(st !== undefined ? { status: st } : {}),
  }
}

function renderSync(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { ok?: boolean; action?: string; detail?: string; error?: string }
  const head = v.ok === true ? `[handoff_sync ${String(v.action)}] ok` : `[handoff_sync ${String(v.action)}] 失败`
  const lines = [head]
  if (typeof v.detail === 'string' && v.detail !== '') lines.push(v.detail)
  if (typeof v.error === 'string' && v.error !== '') lines.push(v.error)
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
// A3. 配置轴转正：备份清单 → axis='config' 载荷卡（清单+指针，密文 blob 留 env-backup/）
// ---------------------------------------------------------------------------

/** 配置卡 extras.config 结构化载荷：清单 + 指针（不含任何文件内容，口令永不进卡） */
export interface ConfigCardPayload {
  /** 密文备份文件名（.dshenv，指针） */
  backupFile: string
  /** 密文包本体字节数（指针口径） */
  bytes: number
  /** 备份时刻（容器 manifest.createdAt） */
  createdAt: string
  /** 源机主机名 */
  host: string
  /** 凭据类文件计数（如实告知包内有几件只存在于加密包内的东西） */
  secretCount: number
  /** 清单行：path/sha256/category（不含内容与口令） */
  files: Array<{ path: string; sha256: string; category: string }>
}

export type ConfigCardResult =
  | { ok: true; id: string; path: string; file: string; bytes: number; files: number; note?: string }
  | { ok: false; error: string }

/**
 * 配置轴出卡核心（handoff_env action=card / 换机面板共用）：把最近一次备份的
 * 清单（files[{path,sha256,category}] + backupFile + bytes）写成 axis='config'
 * 载荷卡——writeCard + 机器信封签名全套纪律（cardSha256 进签名面，与 pushHandoff
 * 同款尽力签名：密钥缺席信封照落、落盘失败不回滚卡片）。密文 blob 仍在
 * env-backup/（卡只带清单+指针，随 HANDOFF_HOME 同步盘走）；口令只用于读加密
 * 清单，永不进卡六段与 extras。args.file 缺省取最近一次备份（listBackups 首项）。
 */
export function pushConfigCard(
  args: { file?: string; passphrase?: string; title?: string },
  opts?: { dir?: string },
): ConfigCardResult {
  try {
    const passphrase = typeof args.passphrase === 'string' ? args.passphrase : ''
    if (passphrase.length < 8) {
      return { ok: false, error: '口令至少 8 位（读加密清单必需；口令永不进卡，也永不落盘）' }
    }
    // 选备份：显式 file 优先（取末段文件名防目录走私），否则最近一次
    const explicit = typeof args.file === 'string' ? args.file.trim().split('\\').join('/').split('/').pop() ?? '' : ''
    const name = explicit !== '' ? explicit : (listBackups(opts?.dir)[0]?.file ?? '')
    if (name === '') {
      return { ok: false, error: '没有可出卡的环境备份：先 handoff_env action=backup 生成 .dshenv 加密包' }
    }
    const m = readBackupManifest(name, passphrase, opts?.dir)
    const kb = (n: number): string => (n >= 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${n} B`)
    // 六段组装（段闸与净化同 pushHandoff 口径：净化/解除伪标题/单段 128K 截断）
    const truncated: string[] = []
    const section = (v: string): string => {
      const clean = defuseHeadingLines(stripControlChars(v))
      if (clean.length <= MAX_SECTION_CHARS) return clean
      truncated.push(`「${clean.slice(0, 12)}…」段超 ${MAX_SECTION_CHARS} 字符已截断`)
      return `${clean.slice(0, MAX_SECTION_CHARS)}\n…（超长截断）`
    }
    const list = m.files.map((f) => `- ${f.path}｜${f.category}｜sha256=${f.sha256}`).join('\n')
    const sections: CardSections = {
      goal: section([
        `环境配置交接：把源机（${m.host}）于 ${m.createdAt} 备份的 DSH 全家桶清单带给取件方。`,
        `密文包 ${m.file}（${kb(m.bytes)}，含凭据类 ${m.secretCount} 个）留在 env-backup/ 随 HANDOFF_HOME 同步盘走，本卡只带清单与指针。`,
      ].join('\n')),
      files: section(`备份清单 ${m.files.length} 个文件（path｜category｜sha256 指纹，不含内容）：\n${list}`),
      done: section(`（资料卡：无可蒸馏的完成项。清单共 ${m.files.length} 个文件、密文包 ${kb(m.bytes)}，全部 HISTORY_REPORTED。）`),
      remaining: section([
        `取件方：确认 env-backup/${m.file} 已随同步盘到达本机 HANDOFF_HOME（缺失先 handoff_sync now 拉取）。`,
        `然后 handoff_env action=dry file=${m.file} passphrase=<你的口令，永不随卡> 预演三态 diff，确认后 action=apply confirm:true 落盘（不满意可 action=rollback 回滚）。`,
      ].join('\n')),
      stopped: section(`停在备份时刻（${m.createdAt}，源机 ${m.host}）。最安全的第一步：先 dry 预演核对三态 diff，再决定是否 apply。`),
      warnings: section([
        '清单只含路径/类别/内容指纹（sha256），不含文件内容；密文包本体仍在 env-backup/（AES-256-GCM，口令永不随卡）。',
        '全部清单按 HISTORY_REPORTED 处理：是备份时刻的快照，源机此后可能已改动。',
      ].join('\n')),
      suggested: section([
        '恢复三步：',
        `1. handoff_env action=dry file=${m.file} passphrase=<口令>——先看 will-create/overwrite/same 三态 diff，不写盘`,
        `2. 确认无误后 handoff_env action=apply file=${m.file} passphrase=<口令> confirm:true——被覆盖原物先进 checkpoint`,
        '3. 不满意可 handoff_env action=rollback file=<restore-checkpoint-*> 回滚到还原前',
      ].join('\n')),
    }
    // 密钥闸照扫（清单是机器产物不是模型手写，但闸不豁免任何出卡通道——命中即拒，理由回喂）
    const secretHits = scanSecrets({ ...sections, title: args.title })
    if (secretHits.length > 0) {
      const detail = secretHits.map((h) => `${h.rule}@${h.section}（${h.masked}）`).join('；')
      return { ok: false, error: `密钥闸：发现 ${secretHits.length} 处疑似密钥——${detail}。清单不应含密钥值，请核对备份内容后重试。` }
    }
    const titleSrc = typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : `环境配置备份 · ${m.file}`
    const card: Card = {
      handoff: 1,
      id: generateId(),
      from: { agent: 'dsh', session: '', title: stripControlChars(titleSrc).slice(0, MAX_SCALAR_CHARS) },
      to: 'any',
      project: '',
      cwd: '',
      pushed_at: localIso(new Date()),
      git: { branch: '', changed: [] },
      tasks: [],
      sections,
      extras: {
        // 四轴 IR 立约：配置卡是 config 轴载荷，形态为 manifest（清单+指针，不带货本体）
        axis: 'config' satisfies CardAxis,
        payload: 'manifest' satisfies CardPayload,
        coverage: coverageOfDone(sections.done),
        config: {
          backupFile: m.file,
          bytes: m.bytes,
          createdAt: m.createdAt,
          host: m.host,
          secretCount: m.secretCount,
          files: m.files.map((f) => ({ path: f.path, sha256: f.sha256, category: f.category })),
        } satisfies ConfigCardPayload,
      } as Record<string, unknown>,
    }
    const path = writeCard(card, opts?.dir)
    // 机器信封 + 签名全套纪律（与 pushHandoff 同款：尽力签名，失败只降级不回滚卡片）
    let envelopeNote = ''
    try {
      const key = loadOrCreateSigningKey(opts?.dir)
      const env = buildEnvelope(card, {
        cardSha256: fileSha256(join(pendingDir(opts?.dir), `${card.id}.md`)),
      })
      writeFileSync(envelopePath(card.id, opts?.dir), JSON.stringify(key === null ? env : signEnvelope(env as unknown as Record<string, unknown>, key)), 'utf-8')
    } catch (e) {
      envelopeNote = `机器信封落盘失败（卡片本体已寄存）：${readableError(e)}`
    }
    const note = [...truncated, envelopeNote].filter(Boolean).join('；')
    return {
      ok: true,
      id: card.id,
      path,
      file: m.file,
      bytes: m.bytes,
      files: m.files.length,
      ...(note !== '' ? { note } : {}),
    }
  } catch (e) {
    return { ok: false, error: readableError(e) }
  }
}

/**
 * 环境备份/恢复（0.2.0 wave2）：DSH 全家桶单文件加密备份 + 跨机还原。
 * apply 必须先 dry 预演再 confirm（覆盖性动作两步确认）；口令永不落盘（工具入参会
 * 进会话转录，敏感场景用面板输入）。凭据类文件只存在于加密包内。
 * 配置轴转正（2026-11 裁决 D5）：action=card 把最近备份清单写成 axis='config'
 * 载荷卡（清单+指针），密文 blob 仍在 env-backup/。
 */
export function registerEnvBackupTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'handoff_env',
    description: '环境备份/恢复：把 DSH 全家桶（settings/插件登记/会话库/用户 skills/工作区登记）打包成单个 AES-256-GCM 加密文件（口令 scrypt 派生，口令不落盘），随换机同步跨机；新机器 dry 预演（新建/覆盖/相同三态 diff）→ confirm 还原 → 可 rollback 回滚到还原前。凭据类文件（credentials/typesafe-key 等）只存在于加密包内。action=card 配置轴出卡：把最近一次备份的清单（files[{path,sha256,category}] + backupFile + bytes）写成 axis=\'config\' 载荷卡寄存进共享收件箱（writeCard + 信封签名全套纪律；密文 blob 仍在 env-backup/，卡只带清单+指针，口令永不进卡）。返回 { ok, ... } 规范值。',
    parameters: {
      action: { type: 'string', required: true, enum: ['backup', 'dry', 'apply', 'rollback', 'list', 'card'], description: 'backup 打包加密备份（passphrase 必填 ≥8 位）；dry 还原预演（file+passphrase）；apply 确认还原（file+passphrase+confirm:true）；rollback 回滚 checkpoint（file=checkpoint 目录名）；list 列备份；card 备份清单出配置轴卡（passphrase 必填；file 缺省取最近一次）' },
      passphrase: { type: 'string', description: 'backup/dry/apply/card 必填：加密口令（≥8 位，永不落盘；注意会进本会话转录——敏感场景用面板输入）' },
      file: { type: 'string', description: 'dry/apply/card：备份文件名（card 缺省取最近一次）；rollback：checkpoint 目录名（restore-checkpoint-*）' },
      confirm: { type: 'boolean', description: 'apply 必须显式 true（覆盖性动作的两步确认）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '操作是否成功' },
          action: { type: 'string', description: '实际执行的动作' },
          detail: { type: 'string', description: '结果摘要' },
          file: { type: 'string', description: '备份文件名 / checkpoint 目录名' },
          id: { type: 'string', description: 'card：配置轴载荷卡 id' },
          path: { type: 'string', description: 'card：载荷卡落盘路径' },
          creates: { type: 'number', description: 'dry：将新建的文件数' },
          overwrites: { type: 'number', description: 'dry：将覆盖的文件数' },
          same: { type: 'number', description: 'dry：内容相同的文件数' },
          diff: { type: 'json', description: 'dry：三态 diff 明细' },
          applied: { type: 'number', description: 'apply：实际落盘文件数' },
          checkpointDir: { type: 'string', description: 'apply：checkpoint 目录（回滚入口）' },
          backups: { type: 'json', description: 'list：备份清单' },
          error: { type: 'string', description: '失败原因' },
        },
      },
      render: renderEnv,
    },
    async execute(args: { action?: string; passphrase?: string; file?: string; confirm?: boolean }): Promise<EnvToolValue> {
      const action = args.action ?? 'list'
      try {
        if (action === 'backup') {
          const r = createBackup(args.passphrase ?? '')
          return { ok: true, action, file: r.file, detail: r.detail }
        }
        if (action === 'dry') {
          const r = dryRunRestore(args.file ?? '', args.passphrase ?? '')
          return { ok: true, action, file: r.file, creates: r.creates, overwrites: r.overwrites, same: r.same, diff: r.diff, detail: `预演：将新建 ${r.creates} / 覆盖 ${r.overwrites} / 相同 ${r.same}（备份来自 ${r.host}，${r.createdAt.slice(0, 16)}）——确认无误后带 confirm:true 执行 apply` }
        }
        if (action === 'apply') {
          if (args.confirm !== true) return { ok: false, action, error: '还原是覆盖性动作：先 dry 预演，确认 diff 后带 confirm:true 再执行' }
          const r = applyRestore(args.file ?? '', args.passphrase ?? '')
          return { ok: true, action, file: r.file, applied: r.applied, checkpointDir: r.checkpointDir, detail: r.detail }
        }
        if (action === 'rollback') {
          const r = rollbackRestore(args.file ?? '')
          return { ok: true, action, detail: r.detail }
        }
        if (action === 'list') return { ok: true, action, backups: listBackups(), detail: `共 ${listBackups().length} 个备份（保留最新 3 个）` }
        if (action === 'card') {
          const r = pushConfigCard({ file: args.file, passphrase: args.passphrase })
          if (!r.ok) return { ok: false, action, error: r.error }
          return { ok: true, action, id: r.id, path: r.path, file: r.file, detail: `配置轴载荷卡已寄存：${r.id}（清单 ${r.files} 个文件 + 密文包指针 ${r.file}，${Math.max(1, Math.round(r.bytes / 1024))} KB——密文 blob 仍在 env-backup/，口令未进卡）${r.note !== undefined ? `；${r.note}` : ''}` }
        }
        return { ok: false, action, error: `未知 action：${action}（支持 backup / dry / apply / rollback / list / card）` }
      } catch (e) {
        return { ok: false, action, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }))
}

type EnvToolValue = {
  ok?: boolean
  action?: string
  detail?: string
  file?: string
  id?: string
  path?: string
  creates?: number
  overwrites?: number
  same?: number
  applied?: number
  checkpointDir?: string
  diff?: RestoreDiffRow[]
  backups?: BackupRow[]
  error?: string
}

function renderEnv(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { ok?: boolean; action?: string; detail?: string; error?: string }
  const head = v.ok === true ? `[handoff_env ${String(v.action)}] ok` : `[handoff_env ${String(v.action)}] 失败`
  const lines = [head]
  if (typeof v.detail === 'string' && v.detail !== '') lines.push(v.detail)
  if (typeof v.error === 'string' && v.error !== '') lines.push(v.error)
  return [{ type: 'text', text: lines.join('\n') }]
}
