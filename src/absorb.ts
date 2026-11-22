/**
 * 记忆写回最小闭环（0.2.x）：handoff_absorb——把**已取件**的 memory 轴记忆卡
 * （payload='files'，「建议加载」段条目）写进目标 harness 的记忆文件。
 *
 * 硬线（THREAT-MODEL T8 · 写回面）：
 * 1. 外部 harness 的**会话存储永不写**——目标闭集 = MEMORY_SOURCES 的文件型记忆路径
 *    （CLAUDE.md / AGENTS.md / .cursorrules 族），无自由路径入参；hippo-db 是 zvec
 *    引擎目录，不是可写的记忆文件——0.26 起不再硬拒收：对出卡时真的随卡走的
 *    <id>.hippo.jsonl 侧车，confirm 两步后调 hippo 官方 CLI `hippo import` 幂等导入
 *    （执行器在 src/distill.ts）；接管侧从不直接写 zvec 引擎目录（T8 不变），
 *    侧车不在场时诚实报错不假装导入过。侧车格式 v1/v2 双兼容（v2 = meta 行 +
 *    workspace/weight/section 条目字段，格式细节归 distill.ts；meta 缺失按 v1 照常吸收）。
 * 2. 写回 = 显式授权动作：confirm 两步确认（先 handoff_inbox load 看卡，再 absorb
 *    落盘），confirm 非 true 一律拒绝并把「将写什么」的计划原样回显。
 * 3. 追加前按条目 sha256 去重——目标文件已有的条目不重写（幂等：同一张卡重复
 *    absorb 第二次必为 0 追加）。
 * 4. 写前把目标文件原物快照进 archived/absorb-backup/<id>-<target>.md（可回滚；
 *    同名快照已存在时不覆盖——保留的永远是第一次写入前的原物）。
 * 5. 落盘 tmp+rename 原子替换；写后 lifecycle 记 absorbed-write 事件留痕。
 *
 * 卡源只认 archived/（已取件）：pending/ 里的卡还没看过就被落盘违反两步语义，
 * 明确拒绝并提示先取件。卡面 extras.axis !== 'memory' 的卡一律拒收。
 * @module dsh-takeover/absorb
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { archivedDir, assertSafeId, parseCardLenient } from '@agent-handoff/core'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { recordLifecycleEvent } from './lifecycle.ts'
import { MEMORY_SOURCES } from './memory.ts'
import { DISTILL_SECTIONS, hippoImportRun, locateHippoSidecar, readHippoLedger, recordHippoLedger, type DistillSection, type HippoRunner } from './distill.ts'

/** 卡 id 长度上限（与 tools.ts MAX_ID_CHARS 同口径——absorb 不反向依赖 tools，避免环） */
const ABSORB_ID_MAX = 64
/** 单次吸收追加总字符上限（与 memory.ts SUGGESTED_TOTAL_MAX 同量级：写回也要封顶，最坏有界） */
export const ABSORB_TOTAL_MAX = 120_000
/** 会话存储路径段黑名单（结构守门：目标注册表解析出的任何路径都不得命中——未来改注册表时在运行时兜底） */
const SESSION_STORE_SEGMENTS = new Set(['projects', 'sessions', 'storages', 'session-store', 'history'])

/** 吸收目标定义：从 MEMORY_SOURCES 选（复用同一份路径真源），hippo-db（引擎目录）除外 */
export interface AbsorbTargetDef {
  key: string
  agent: string
  scope: 'user' | 'project'
  path: (home: string, cwd: string) => string
}

/**
 * 吸收目标注册表：MEMORY_SOURCES 的文件型子集，AGENTS.md 族事实标准优先排序
 * （展示口径——工具错误文案按此序列候选）。hippo-db 特意不在册：zvec 原生目录
 * 不接受文件写回（写了就是砸库），它走专用分支——confirm 两步后 hippo CLI import
 * 随卡侧车（src/distill.ts 执行器），不进文件写回注册表。
 */
export const ABSORB_TARGETS: readonly AbsorbTargetDef[] = MEMORY_SOURCES
  .filter((d): d is typeof d & { key: string } => d.key !== 'hippo-db')
  .map((d) => ({ key: d.key, agent: d.agent, scope: d.scope, path: d.path }))
  .sort((a, b) => {
    const rank = (k: string): number => (k.includes('agents') || k === 'zcode-user' || k === 'codex-user' || k === 'opencode-user' ? 0 : 1)
    return rank(a.key) - rank(b.key) || a.key.localeCompare(b.key)
  })

/** 解析出的目标路径做会话存储结构守门：路径段命中黑名单即拒（防注册表未来改动引入会话路径） */
function assertNotSessionStore(p: string): void {
  const segs = p.split(/[\\/]/).map((s) => s.toLowerCase())
  for (const seg of segs) {
    if (SESSION_STORE_SEGMENTS.has(seg)) {
      throw new Error(`写回目标命中会话存储路径段（${seg}）——外部 harness 的会话存储永不写（T8 硬线），注册表配置有误`)
    }
  }
}

/** 规范错误（readableError 不引依赖的本地简版：absorb 自产错误全是中文文案，系统错误包 errno 口径） */
function readable(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return `文件系统错误（${code}）：${e.message}`
    return e.message
  }
  return String(e)
}

/** 「建议加载」段条目：一行为一条（空行/段标题/截断标记行不算条目），sha 取 trim 后内容的 sha256 */
export interface AbsorbEntry {
  line: string
  sha256: string
  /** 条目来自卡内哪个来源块（`## <路径>` 标题；无标题块为「未标注来源」） */
  source: string
}

/**
 * 解析「建议加载」段为条目列表（确定性）：
 * - `## <路径>` 行是来源块标题（memorySections 的组装形态），不算条目，只记来源；
 * - 其余非空行各算一条（trim 后参与哈希与追加）；
 * - 截断标记行（`…（`开头，memory.ts 截断口径的产物）与块内小节标题形态跳过；
 * - 无任何 `##` 标题的外来卡：整段按「未标注来源」单块处理。
 */
export function parseSuggestedEntries(suggested: string): AbsorbEntry[] {
  const entries: AbsorbEntry[] = []
  let source = '未标注来源'
  for (const raw of suggested.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(raw)
    if (heading !== null) {
      source = heading[1]?.trim() ?? ''
      continue
    }
    const line = raw.trim()
    if (line === '' || line.startsWith('…（')) continue
    entries.push({ line, sha256: createHash('sha256').update(line, 'utf-8').digest('hex'), source })
  }
  return entries
}

/** 目标文件既有条目 sha 集合（非空行 trim 后哈希——与 parseSuggestedEntries 同口径） */
function existingShas(content: string): Set<string> {
  const out = new Set<string>()
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    out.add(createHash('sha256').update(line, 'utf-8').digest('hex'))
  }
  return out
}

/** absorb 参数（工具面与核心函数共用） */
export interface AbsorbArgs {
  id?: string
  target?: string
  confirm?: boolean
  /** project 级目标必填：目标记忆文件所在项目目录 */
  cwd?: string
}

/** absorb 依赖注入（测试用：dir=HANDOFF_HOME、home=user home、now=事件时刻；runner=hippo CLI 桩） */
export interface AbsorbDeps {
  dir?: string
  home?: string
  now?: Date
  /** hippo CLI runner 桩（target=hippo-db 导入用；缺省 realHippoRunner 真跑 CLI） */
  runner?: HippoRunner
}

export type AbsorbResult =
  | {
      ok: true
      action: 'absorb'
      id: string
      target: string
      agent: string
      /** 落盘的记忆文件绝对路径 */
      path: string
      /** 实际追加条数 */
      appended: number
      /** 按 sha 去重跳过的条数（目标已有，未重写） */
      deduped: number
      /** 写前原物快照路径（目标原本不存在时缺省） */
      snapshot?: string
      detail: string
    }
  | {
      ok: true
      action: 'absorb'
      id: string
      target: 'hippo-db'
      agent: string
      /** 已导入（或已记账跳过）的 archived 侧车路径 */
      sidecar: string
      /** 侧车格式版本（meta 缺失按 1——读侧 v1/v2 双兼容的如实面） */
      sidecarVersion: number
      /** 侧车有效条目数（交 hippo 入库的导入口径） */
      entries: number
      /** hippo 数据目录（三级解析；只经官方 CLI 写，takeover 从不直接写它） */
      dataDir: string
      /** true = 记账本 sha 对上，重复 absorb 直接跳过（未再调 hippo CLI） */
      repeat: boolean
      detail: string
    }
  | { ok: false; error: string }

/** hippo-db 目标的展示名（与 memory.ts MEMORY_STORES hippo 项 label 同口径） */
const HIPPO_AGENT = 'dsh-hippo 记忆库'

/** 四段账本计数 → 展示串（闭集固定顺序，缺席标签计 0——「没有」也是如实值） */
function fmtSections(s: Partial<Record<DistillSection, number>>): string {
  return DISTILL_SECTIONS.map((k) => `${k} ${s[k] ?? 0}`).join(' / ')
}

/** 侧车格式事实行（v1/v2 双兼容——各自如实两态，不虚构 v2 字段） */
function sidecarVersionLine(info: { sidecarVersion: number; v2Workspace?: string; v2Sections: Partial<Record<DistillSection, number>> }): string {
  return info.sidecarVersion >= 2
    ? `侧车格式 v2（meta 声明 workspace=${info.v2Workspace ?? '（无）'}；四段账本条目：${fmtSections(info.v2Sections)}；缺 section 标签的条目不属于四段账本。）`
    : '侧车格式 v1（无 meta 行与 v2 字段，照常导入——读侧 v1/v2 双兼容）。'
}

/**
 * 读 archived 卡并验 memory 轴（文件目标与 hippo-db 目标共用；两步语义第一步未完成即拒）。
 * 错误文案与拆分前逐字一致（既有测试钉与降级底座不动）。
 */
function readArchivedMemoryCard(id: string, dir?: string): { ok: true; axis: unknown; suggested: string } | { ok: false; error: string } {
  const archivedPath = join(archivedDir(dir), `${id}.md`)
  if (!existsSync(archivedPath)) {
    const pendingPath = join(archivedDir(dir).replace(/[\\/]archived$/, ''), 'pending', `${id}.md`)
    if (existsSync(pendingPath)) {
      return { ok: false, error: `卡 ${id} 还在 pending/（未取件）：两步语义是先 handoff_inbox action=load 看卡，再 absorb 落盘——先取件` }
    }
    return { ok: false, error: `archived/ 无此卡：${id}（absorb 只吸收已取件归档的卡；id 以 handoff_inbox 输出为准）` }
  }
  let axis: unknown
  let suggested = ''
  try {
    const card = parseCardLenient(readFileSync(archivedPath, 'utf-8'), { filename: `${id}.md` })
    axis = (card.extras as Record<string, unknown> | undefined)?.['axis']
    suggested = card.sections.suggested ?? ''
  } catch (e) {
    return { ok: false, error: `卡解析失败：${readable(e)}` }
  }
  if (axis !== 'memory') {
    return { ok: false, error: `非 memory 轴卡（axis=${String(axis ?? '缺省')}）：handoff_absorb 只吸收记忆卡（extras.axis='memory'）；会话卡/配置卡各有自己的消费通路` }
  }
  return { ok: true, axis, suggested }
}

/**
 * hippo-db 分支（0.26 蒸馏闭环）：confirm 两步后执行 `hippo import <archived>/<id>.hippo.jsonl`。
 * - 硬线不变：绝不写 zvec 引擎目录本身——只调 hippo 官方 CLI（执行器 src/distill.ts，
 *   子进程 env 钉 HIPPO_DATA_DIR=三级解析结果），T8 对引擎目录照样成立；
 * - 侧车不在场（无快照卡 / 取件搬移失败卡）诚实报错，不静默假装导入过；
 * - 侧车格式 v1/v2 双兼容：格式事实（版本 / meta workspace / 四段账本计数）随计划回显
 *   与结果 detail 如实带出，meta 行缺失按 v1 处理（不虚构 v2 字段）；幂等记账键不变
 *   （侧车 sha，v1/v2 同一机制）；
 * - 幂等分层：hippo 层 dedup-reinforce（重复条目强化合并不覆盖，transfer.ts:4-8）；
 *   takeover 层按侧车 sha 记账（hippo-import-ledger），同卡重复 absorb 直接跳过；
 * - 落 absorbed-write 生命周期事件（闭集既有理由）；supersede 推翻链以 hippo 侧为准。
 */
function absorbHippoDb(id: string, args: AbsorbArgs, deps?: AbsorbDeps): AbsorbResult {
  const card = readArchivedMemoryCard(id, deps?.dir)
  if (!card.ok) return card
  const info = locateHippoSidecar(id, { dir: deps?.dir, home: deps?.home })
  if ('error' in info) return { ok: false, error: info.error }
  // takeover 侧幂等：记账本 sha 对上 = 已导入过，直接跳过（不调 CLI、不重复记账、不重复留痕）
  const prior = readHippoLedger(deps?.dir)[id]
  if (prior !== undefined && prior.sha256 === info.sha256) {
    return {
      ok: true,
      action: 'absorb',
      id,
      target: 'hippo-db',
      agent: HIPPO_AGENT,
      sidecar: info.sidecar,
      sidecarVersion: info.sidecarVersion,
      entries: info.entries,
      dataDir: info.dataDir,
      repeat: true,
      detail: `${sidecarVersionLine(info)}记账本记录本卡侧车已导入过（sha256 对上，${prior.at}）：本次跳过——未再调 hippo CLI、不重复记账。重复 absorb 同一张卡是幂等的。`,
    }
  }
  // confirm 闸：缺省一律拒绝，计划原样回显（与文件目标同款两步语义），零写盘
  if (args.confirm !== true) {
    const planLines = [
      `将导入：hippo 记忆库（数据目录 ${info.dataDir}）——只调 hippo 官方 CLI import，绝不写 zvec 引擎目录本身（T8 硬线）`,
      `侧车：${info.sidecar}（${info.entries} 条条目 / ${Math.max(1, Math.round(info.bytes / 1024))} KB）`,
      sidecarVersionLine(info),
      `命令：hippo import ${info.sidecar}`,
      prior === undefined
        ? '记账本无本卡导入记录（首次导入）。'
        : `记账本已有本卡记录但侧车 sha 变了（${prior.at} 记录）：将重新导入——hippo dedup-reinforce 对重复条目强化合并不覆盖，仍然幂等`,
      '幂等分层：hippo 层 dedup-reinforce（重复条目强化合并、不覆盖已有记录）；takeover 层导入后按侧车 sha 记账，同卡重复 absorb 直接跳过。',
      '推翻链（supersede）以 hippo 侧为准：旁路索引重建归属 hippo import 行为，takeover 不承诺重建结果。',
      '两步确认：先 handoff_inbox action=load 看过卡，确认无误后带 confirm: true 重试。本调用未写任何盘。',
    ]
    return { ok: false, error: planLines.join('\n') }
  }
  const run = hippoImportRun(info, { runner: deps?.runner, dir: deps?.dir, home: deps?.home })
  if (!run.ok) return { ok: false, error: run.error }
  // 记账（失败不回滚导入——hippo dedup 兜底幂等，附注如实带回）→ 留痕（闭集既有理由）
  const at = (deps?.now ?? new Date()).toISOString()
  const ledgerNote = recordHippoLedger(id, { sha256: info.sha256, at, entries: info.entries, bytes: info.bytes }, deps?.dir)
  recordLifecycleEvent({
    stage: 'write',
    reason: 'absorbed-write',
    target: id,
    detail: `${HIPPO_AGENT}（hippo-db）hippo import 导入 ${info.entries} 条（侧车 sha ${info.sha256.slice(0, 8)}…）；${ledgerNote === '' ? '已记账' : ledgerNote}`,
  }, deps?.dir, deps?.now)
  return {
    ok: true,
    action: 'absorb',
    id,
    target: 'hippo-db',
    agent: HIPPO_AGENT,
    sidecar: info.sidecar,
    sidecarVersion: info.sidecarVersion,
    entries: info.entries,
    dataDir: info.dataDir,
    repeat: false,
    detail: `${sidecarVersionLine(info)}${run.note}${ledgerNote !== '' ? ` ${ledgerNote}` : ''}重复 absorb 同一张卡将按记账 sha 直接跳过（幂等）。`,
  }
}

/**
 * 记忆卡吸收核心（可脱离 host 单测）。全流程：
 * 参数校验 → 目标解析（target=hippo-db 走专用 CLI 导入分支 absorbHippoDb；
 * 文件目标走闭集注册表 + 会话存储守门）→ 读 archived 卡（未取件明确拒）
 * → axis=memory 校验 → 建议段解析 + sha 去重 → confirm 闸（缺省拒 + 计划回显）
 * → 快照 → tmp+rename 落盘 → lifecycle absorbed-write 留痕。
 * 任何失败都只回 { ok: false, error }，不抛异常。
 */
export function absorbCard(args: AbsorbArgs, deps?: AbsorbDeps): AbsorbResult {
  try {
    const id = (args.id ?? '').trim()
    if (id === '') return { ok: false, error: 'id 不能为空：先 handoff_inbox action=load 取件记忆卡，再 absorb 落盘' }
    if (id.length > ABSORB_ID_MAX) {
      return { ok: false, error: `非法卡片 id（长度 ${id.length} 超上限 ${ABSORB_ID_MAX}）：${id.slice(0, 48)}…` }
    }
    try {
      assertSafeId(id)
    } catch (e) {
      return { ok: false, error: `非法卡片 id：${readable(e)}` }
    }
    const targetKey = (args.target ?? '').trim()
    if (targetKey === '') {
      const keys = ABSORB_TARGETS.map((t) => t.key).join(' / ')
      return { ok: false, error: `target 不能为空：从注册表选一个（AGENTS.md 族事实标准优先）——${keys}；hippo 记忆库走 target=hippo-db（confirm 两步后 hippo CLI 导入随卡侧车）；建议先 handoff_memory action=scan 看本机哪些记忆文件在场` }
    }
    if (targetKey === 'hippo-db') return absorbHippoDb(id, args, deps)
    const def = ABSORB_TARGETS.find((t) => t.key === targetKey)
    if (def === undefined) {
      const keys = ABSORB_TARGETS.map((t) => t.key).join(' / ')
      return { ok: false, error: `未知 target：${targetKey}（注册表只有 ${keys}；会话存储路径不是合法目标——外部会话存储永不写）` }
    }
    const cwd = (args.cwd ?? '').trim()
    if (def.scope === 'project' && cwd === '') {
      return { ok: false, error: `target=${targetKey} 是项目级记忆文件，必须给 cwd（项目目录）` }
    }
    const home = deps?.home ?? homedir()
    const abs = def.path(home, cwd)
    assertNotSessionStore(abs)

    // 卡源只认 archived/ + memory 轴闸（文件目标与 hippo-db 目标共用同一套闸）
    const card = readArchivedMemoryCard(id, deps?.dir)
    if (!card.ok) return card
    if (card.suggested.trim() === '') {
      return { ok: false, error: '本卡没有「建议加载」段，无可吸收条目' }
    }
    const entries = parseSuggestedEntries(card.suggested)
    if (entries.length === 0) {
      return { ok: false, error: '「建议加载」段没有可吸收的条目（全是标题/空行/截断标记）' }
    }

    // 去重：目标已有内容（trim 行 sha）命中的条目跳过；卡内重复条目也只追加一次
    let existing = ''
    let targetExists = false
    try {
      const st = statSync(abs)
      if (st.isFile()) {
        targetExists = true
        existing = readFileSync(abs, 'utf-8')
      }
    } catch { /* 目标不存在：全新建 */ }
    const shas = existingShas(existing)
    const seen = new Set<string>()
    const toAppend: AbsorbEntry[] = []
    let deduped = 0
    let totalChars = 0
    let truncated = false
    for (const e of entries) {
      if (shas.has(e.sha256) || seen.has(e.sha256)) {
        deduped += 1
        continue
      }
      if (totalChars + e.line.length + 1 > ABSORB_TOTAL_MAX) {
        truncated = true
        break
      }
      seen.add(e.sha256)
      toAppend.push(e)
      totalChars += e.line.length + 1
    }

    // confirm 闸：缺省一律拒绝，计划原样回显（两步语义第二步要模型/用户亲授）
    if (args.confirm !== true) {
      const planLines = [
        `将写入：${abs}（${def.agent}，${targetExists ? `已有 ${existing.length} 字符，追加` : '文件不存在，新建'}）`,
        ...toAppend.slice(0, 10).map((e) => `  + ${e.line}${e.source !== '未标注来源' ? `（来自 ${e.source}）` : ''}`),
        toAppend.length > 10 ? `  …共 ${toAppend.length} 条` : '',
        `去重跳过 ${deduped} 条（目标已有，不重写）${truncated ? `；超 ${ABSORB_TOTAL_MAX} 字符上限截断` : ''}`,
        targetExists ? `写前快照：archived/absorb-backup/${id}-${targetKey}.md（可回滚）` : '目标不存在，无快照',
        '两步确认：先 handoff_inbox action=load 看过卡，确认无误后带 confirm: true 重试。本调用未写任何盘。',
      ].filter(Boolean)
      return { ok: false, error: planLines.join('\n') }
    }

    // 写前三件套：快照（首个快照不被覆盖，永远是第一次写入前的原物）→ tmp+rename → 留痕
    mkdirSync(dirname(abs), { recursive: true })
    let snapshot: string | undefined
    if (targetExists) {
      const backupDir = join(archivedDir(deps?.dir), 'absorb-backup')
      mkdirSync(backupDir, { recursive: true })
      snapshot = join(backupDir, `${id}-${targetKey}.md`)
      if (!existsSync(snapshot)) copyFileSync(abs, snapshot)
    }
    let content = existing
    if (content !== '' && !content.endsWith('\n')) content += '\n'
    content += toAppend.map((e) => e.line).join('\n')
    if (toAppend.length > 0) content += '\n'
    const tmp = `${abs}.${process.pid}.tmp`
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, abs)

    recordLifecycleEvent({
      stage: 'write',
      reason: 'absorbed-write',
      target: id,
      detail: `${def.agent}（${targetKey}）追加 ${toAppend.length} 条、去重 ${deduped} 条；${snapshot !== undefined ? `快照 ${basename(snapshot)}` : '目标原不存在（新建）'}${truncated ? '；超限截断' : ''}`,
    }, deps?.dir, deps?.now)

    return {
      ok: true,
      action: 'absorb',
      id,
      target: targetKey,
      agent: def.agent,
      path: abs,
      appended: toAppend.length,
      deduped,
      ...(snapshot !== undefined ? { snapshot } : {}),
      detail: `${def.agent} 记忆文件已按条目吸收（追加 ${toAppend.length} / 去重 ${deduped}）${truncated ? `，超 ${ABSORB_TOTAL_MAX} 字符部分截断` : ''}${snapshot !== undefined ? `；写前原物快照在 ${snapshot}（回滚 = 用快照覆盖目标文件）` : '；目标为新建，无快照'}。重复 absorb 同一张卡是幂等的（全部去重，0 追加）。`,
    }
  } catch (e) {
    return { ok: false, error: readable(e) }
  }
}

/** execute 规范值 → 模型可见文本 */
export function renderAbsorb(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as {
    ok?: boolean; id?: string; agent?: string; path?: string; appended?: number; deduped?: number; snapshot?: string; detail?: string
    target?: string; sidecar?: string; entries?: number; repeat?: boolean; error?: unknown
  }
  if (v.ok !== true) {
    return [{ type: 'text', text: `❌ 吸收未执行：${typeof v.error === 'string' ? v.error : JSON.stringify(v.error)}` }]
  }
  if (v.target === 'hippo-db') {
    const lines = [
      `${v.repeat === true ? '✅ 已导入过，幂等跳过' : '🧠 已导入 hippo 记忆库'}：${v.sidecar ?? ''}`,
      `卡片 ${v.id ?? ''}：${v.entries ?? 0} 条条目交 hippo 入库（幂等由 dedup-reinforce 承担：重复条目强化合并、不覆盖已有记录）`,
    ]
    if (typeof v.detail === 'string' && v.detail !== '') lines.push(v.detail)
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const lines = [
    `🧠 已吸收进 ${v.agent ?? ''} 记忆文件：${v.path ?? ''}`,
    `卡片 ${v.id ?? ''}：追加 ${v.appended ?? 0} 条、去重跳过 ${v.deduped ?? 0} 条（已有内容不重写）`,
  ]
  if (typeof v.snapshot === 'string' && v.snapshot !== '') lines.push(`↩️ 写前原物快照：${v.snapshot}（回滚 = 用快照覆盖目标文件）`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 注册 handoff_absorb 工具（写回面唯一记忆入口：confirm 两步 + 去重 + 快照 + 留痕） */
export function registerAbsorbTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'handoff_absorb',
    description: '记忆写回（显式授权动作）：把已取件（archived/）的 memory 轴记忆卡吸收进目标记忆存放处。文件型目标 = MEMORY_SOURCES 的文件路径闭集（claude/codex/opencode/zcode 的 AGENTS.md 与 CLAUDE.md 族、.cursorrules、项目级三件），外部 harness 的会话存储永不写；target=hippo-db 走 hippo 官方 CLI 幂等导入出卡随卡的 <id>.hippo.jsonl 快照侧车（接管侧从不直接写 zvec 引擎目录）。confirm 两步强制：先 handoff_inbox action=load 看卡，再 absorb 落盘；缺 confirm 一律拒绝并回显「将写什么/将导入什么」计划。文件目标追加前按条目 sha 去重（已有内容不重写）、写前原物快照进 archived/absorb-backup/（可回滚）；hippo 目标按侧车 sha 记账，同卡重复 absorb 幂等跳过。写后记 absorbed-write 生命周期事件。返回 { ok, path|sidecar, appended|entries, deduped, snapshot?, repeat? } 规范值。',
    parameters: {
      id: { type: 'string', required: true, description: '已取件记忆卡的 id（handoff_inbox action=load 后在 archived/）' },
      target: { type: 'string', required: true, description: '目标键：文件型 claude-user / zcode-user / codex-user / opencode-user / cursor-user / agents-project / claude-project / cursor-project；hippo-db = hippo 记忆库（confirm 两步后 hippo CLI 导入随卡侧车，需本机装 hippo CLI）' },
      confirm: { type: 'boolean', description: '必须显式 true 才落盘（两步确认：先 load 看卡再 absorb；缺省拒绝并回显计划）' },
      cwd: { type: 'string', description: '项目级目标（*-project）必填：项目目录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '是否已落盘（false = 拒绝/计划回显，未写盘）' },
          action: { type: 'string', description: '动作名（absorb）' },
          id: { type: 'string', description: '吸收的卡片 id' },
          target: { type: 'string', description: '目标键' },
          agent: { type: 'string', description: '目标 agent 名' },
          path: { type: 'string', description: '落盘的记忆文件绝对路径' },
          appended: { type: 'number', description: '实际追加条数（文件型目标）' },
          deduped: { type: 'number', description: '按 sha 去重跳过条数（文件型目标）' },
          sidecar: { type: 'string', description: '已导入的 archived 侧车路径（hippo-db 目标）' },
          sidecarVersion: { type: 'number', description: '侧车格式版本（meta 行缺失按 1；v2 = meta 行 + workspace/weight/section 条目字段）' },
          entries: { type: 'number', description: '侧车有效条目数（hippo-db 目标）' },
          dataDir: { type: 'string', description: 'hippo 数据目录（hippo-db 目标；只经官方 CLI 写）' },
          repeat: { type: 'boolean', description: 'true = 记账本 sha 对上，重复 absorb 幂等跳过（hippo-db 目标）' },
          snapshot: { type: 'string', description: '写前原物快照路径（目标原本不存在时缺省）' },
          error: { type: 'json', description: '拒绝/失败原因（confirm 缺省时含「将写什么」计划）' },
        },
      },
      render: renderAbsorb,
    },
    async execute(args: AbsorbArgs): Promise<AbsorbResult> {
      return absorbCard(args)
    },
  }))
}
