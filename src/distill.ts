/**
 * 记忆蒸馏闭环（0.26 / 侧车格式 v2）：hippo 记忆库 13 字段 JSONL 快照的生产与消费。
 *
 * 生产端（源机）：出卡成功后（接线归集成面，plan §5.1 蒸馏挂点①）以注入式 runner
 * 跑 `hippo export -f jsonl`，把全库 JSONL 快照落 MEMORY_STORES 既有约定路径
 * <数据目录>/hippo-memory.jsonl——文件一旦在场，storeBody 掏条目进「建议加载」段
 * 是既有机制（src/memory.ts:187-194），零改动自动生效。同时把快照组装为
 * **侧车格式 v2** 写为 <id>.hippo.jsonl 落 pending/ 随卡走（物质层随卡先例：补丁
 * sidecar <id>.patch）。v2 格式（0.26.1，需求侧实证：docs/需求调研-1119.md §25
 * 「随卡记忆 schema v2」——auto-memory 四段交接账本实战迭代、memory-evolve #106
 * 归属错位）：
 * - 文件头第一行 meta 行（无 text 字段）：{meta,version:2,at,entries,workspace?}；
 * - 条目行 = 原 13 字段（dsh-hippo transfer.ts EXPORT_FIELDS，值级保真）+ 可选
 *   workspace（归属，来自卡 cwd）/ weight（使用权重，缺省 1，由来源 strength 推导）/
 *   section（四段账本标签 state/goals/dead_ends/next_step，可缺省，来源在场则透传）。
 * 铁律：只动侧车格式，不动六段卡面协议（memorySections 卡面组装零改动）；
 * 读侧 v1/v2 双兼容（v1 无 meta 无新字段照常吸收）；幂等记账键不变（侧车 sha）；
 * MEMORY_STORES 约定与 data-dir 解析零改动；约定路径文件本身是 hippo 所有物，
 * 蒸馏只读不写，v2 组装只发生在侧车。hippo import 对 v2 的兼容性有实测背书：
 * dsh-hippo transfer.ts:114-146 importJsonl 只取已知字段（未知字段忽略）、缺 text
 * 行按坏行跳过（不拒收整文件）；0.3.0 CLI 实测（临时 HIPPO_DATA_DIR，不碰真库）：
 * meta 行 `line 1 skipped: missing text`、两条 v2 富集条目全数 created、退出码 0。
 * CLI 缺席 / 非零退出 / 超时 / 超尺寸 → 全部 fail-open：退回 guidance 回退
 * （现状行为），绝不拦出卡、绝不抛异常。
 *
 * 取件搬移（接线归集成面 §5.1 挂点②，本模块只出纯函数）：consumeDistillSidecar
 * 与 tools.ts consumePatch 同款 pending→archived 同步搬移；搬移失败不拦取件，
 * 侧车留 pending 并回 state='move-failed' 供取件结果如实附注（WS-2 风险⑤）。
 *
 * 消费端（目标机）：locateHippoSidecar / hippoImportRun 供 absorb.ts 对
 * target='hippo-db' 的 confirm 两步后执行 `hippo import <archived>/<id>.hippo.jsonl`。
 * 幂等分层：hippo 层由 dedup-reinforce 语义承担（重复条目强化合并、不覆盖，
 * dsh-hippo transfer.ts:4-8）；takeover 层由 absorb 按侧车 sha 记账（hippo-import-ledger
 * 记账本，同卡重复 absorb 直接跳过）。绝不写 zvec 引擎目录本身——只调 hippo 官方
 * CLI（T8 硬线不变）；supersede 推翻链的旁路索引重建归属 hippo import 行为，
 * 本模块不承诺、文案如实标注「推翻链以 hippo 侧为准」。
 *
 * 已知边界（诚实入册）：execFileSync 不经 shell 直接 spawn，Windows 上 npm 全局
 * 安装的 hippo（.cmd 形态）会 spawn 失败——按「CLI 缺席/失败」fail-open 退 guidance，
 * 不为可执行性引入 shell:true 的注入面。测试全部走桩 runner，绝不真 spawn hippo。
 * @module dsh-takeover/distill
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { MAX_CARD_BYTES, archivedDir, assertSafeId, pendingDir } from '@agent-handoff/core'
import { recordLifecycleEvent } from './lifecycle.ts'
import { MEMORY_STORES, hippoDataDir, readStoreEntries, type MemorySourceRow } from './memory.ts'

/** hippo JSONL 侧车固定命名尾段：<pending|archived>/<卡id>.hippo.jsonl（同屋先例：补丁 sidecar <id>.patch） */
export const HIPPO_SIDECAR_SUFFIX = '.hippo.jsonl'

/** 单次 hippo CLI 调用超时（毫秒）：与 patchpack GIT_DIFF_TIMEOUT_MS 同纪律——挂死的 CLI / 慢盘
 * 不拖垮出卡；export 是全库 JSONL 写出，比 git diff 留一倍余量。超时按导出失败 fail-open。 */
export const HIPPO_CLI_TIMEOUT_MS = 30_000

/** 导入记账本文件名（archived/absorb-backup/ 下，与写前快照同居——absorb 的状态目录） */
const HIPPO_LEDGER_FILE = 'hippo-import-ledger.json'

/**
 * 注入式 runner（与 execFileSync 同签名，零依赖；真实实现 realHippoRunner，
 * 测试全走桩——成功返回 stdout、非零退出/CLI 缺席/超时抛 Error（ENOENT code = CLI 缺席））。
 */
export type HippoRunner = (file: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number }) => string

/** 真实 runner：execFileSync 不走 shell（卡面/路径外来输入，shell 拼接是注入面），超时/编码同仓惯例 */
export const realHippoRunner: HippoRunner = (file, args, opts) =>
  execFileSync(file, args, {
    encoding: 'utf-8',
    timeout: opts.timeout ?? HIPPO_CLI_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  })

/** runner 错误是否为「可执行文件不存在」（execFileSync spawn 失败的 ENOENT 口径） */
function isEnoent(e: unknown): boolean {
  return e instanceof Error && (e as { code?: unknown }).code === 'ENOENT'
}

/** err → 简短消息（Error.message / 字符串化，runner 桩与系统错误通吃） */
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 条目 JSONL 约定路径解析——**单点真源**：不从本模块复写路径约定，把「扫描行」形态
 * 交给 MEMORY_STORES 的 entriesFile 函数解析（hippo 项 = <数据目录>/hippo-memory.jsonl），
 * 与扫描、出卡组装共用同一套（src/memory.ts:99 注释口径「与扫描同一套三级解析，
 * 不重复实现」）；注册表未来改约定，distill 零改动跟随。
 */
export function hippoEntriesFile(dataDir: string): string {
  const store = MEMORY_STORES.find((s) => s.id === 'hippo-db')
  const row: MemorySourceRow = {
    key: 'hippo-db', agent: 'dsh-hippo 记忆库', path: join(dataDir, 'memories'),
    exists: false, bytes: 0, mtime: '', preview: '',
  }
  return store?.entriesFile?.(row) ?? join(dataDir, 'hippo-memory.jsonl')
}

// ---------------------------------------------------------------------------
// 侧车格式 v2：meta 行 + 条目级 workspace/weight/section（读写两侧的唯一真源）
// ---------------------------------------------------------------------------

/** 侧车格式版本：meta 行 version 字段的写侧取值；读侧 version≥2 一律按 v2 族处理 */
export const DISTILL_SIDECAR_VERSION = 2

/** 四段账本标签闭集（v2 section 字段）：auto-memory「handoff, not compression」四段交接账本口径 */
export type DistillSection = 'state' | 'goals' | 'dead_ends' | 'next_step'

export const DISTILL_SECTIONS: readonly DistillSection[] = ['state', 'goals', 'dead_ends', 'next_step']

function isDistillSection(v: unknown): v is DistillSection {
  return typeof v === 'string' && (DISTILL_SECTIONS as readonly string[]).includes(v)
}

/** 侧车 meta 行对象（v2 文件头第一行）。设计约束：**不带 text 字段**——hippo
 * importJsonl 对缺 text 行按坏行跳过（dsh-hippo transfer.ts:126；0.3.0 CLI 实测
 * `line 1 skipped: missing text`，其余条目照常入库、退出码 0），takeover
 * readStoreEntries 同口径跳过——meta 行对两侧消费者都无害，不需要任何一方升级。 */
export interface DistillSidecarMeta {
  version: number
  /** 生成时刻（ISO） */
  at: string
  /** 有效条目数（与侧车内条目行数一致；坏行不计） */
  entries: number
  /** 卡 cwd 归属（produceSnapshot opts.cwd；缺省不带） */
  workspace?: string
}

/** meta 行序列化（单行 JSON，无换行尾——调用方负责拼行）。workspace 空/缺省不写键。 */
export function distillMetaLine(meta: DistillSidecarMeta): string {
  const o: Record<string, unknown> = {
    meta: 'dsh-takeover-distill',
    version: meta.version,
    at: meta.at,
    entries: meta.entries,
  }
  if (meta.workspace !== undefined && meta.workspace !== '') o['workspace'] = meta.workspace
  return JSON.stringify(o)
}

/**
 * 读 meta 行（只看首个非空行）。判定闭集：合法 JSON 对象 + **无非空 text** +
 * 数值 version≥2，三者齐备才算 v2 meta；否则 undefined（meta 行缺失/首行是条目/
 * 坏行/空文件 → 按 v1 处理——「meta 缺失按 v1」的口径单点）。绝不抛。
 */
export function parseSidecarMeta(raw: string): DistillSidecarMeta | undefined {
  const first = raw.split(/\r?\n/).find((l) => l.trim() !== '')
  if (first === undefined) return undefined
  try {
    const o = JSON.parse(first) as Record<string, unknown>
    if (typeof o['text'] === 'string' && o['text'].trim() !== '') return undefined
    const version = o['version']
    if (typeof version !== 'number' || !Number.isFinite(version) || version < DISTILL_SIDECAR_VERSION) return undefined
    return {
      version,
      at: typeof o['at'] === 'string' ? o['at'] : '',
      entries: typeof o['entries'] === 'number' ? o['entries'] : 0,
      ...(typeof o['workspace'] === 'string' && o['workspace'] !== '' ? { workspace: o['workspace'] } : {}),
    }
  } catch {
    return undefined
  }
}

/** v2 条目回读形态：完整原始条目对象（13 字段 + 任意来源 extra，不丢不重排）+ 解出的 v2 字段 */
export interface DistillSidecarEntryV2 {
  record: Record<string, unknown>
  text: string
  workspace?: string
  weight?: number
  section?: DistillSection
}

/**
 * v2 条目回读（读侧双兼容的回读面）：逐行解析侧车，条目行（非空 text 对象）→
 * 原始 record + v2 字段（缺省不带，v1 条目自然不带）。meta 行与坏行跳过。
 * v2 字段各自独立校验：workspace 非空串、weight 正有限数（缺省语义 = 1，不伪造）、
 * section 必在四段闭集内（非法标签不冒充账本计数）。
 */
export function readSidecarEntriesV2(raw: string): DistillSidecarEntryV2[] {
  const out: DistillSidecarEntryV2[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (t === '') continue
    try {
      const rec = JSON.parse(t) as Record<string, unknown>
      const text = typeof rec['text'] === 'string' ? rec['text'] : ''
      if (text === '') continue
      const e: DistillSidecarEntryV2 = { record: rec, text }
      if (typeof rec['workspace'] === 'string' && rec['workspace'] !== '') e.workspace = rec['workspace']
      if (typeof rec['weight'] === 'number' && Number.isFinite(rec['weight']) && rec['weight'] > 0) e.weight = rec['weight']
      if (isDistillSection(rec['section'])) e.section = rec['section']
      out.push(e)
    } catch { /* 坏行跳过：侧车是外来数据，单行坏不拦整份 */ }
  }
  return out
}

/** 侧车格式事实（absorb 计划回显/结果如实带的汇总口径）。version：meta 行缺席/坏行按 1。 */
export interface DistillSidecarFacts {
  version: number
  /** meta 行声明的归属 workspace（v1 / meta 未带则缺省） */
  metaWorkspace?: string
  /** 条目级 workspace 去重清单（meta 行不计；归属事实以条目为准） */
  workspaces: string[]
  /** 四段账本计数（section 在场条目按标签计数；缺省/非法标签不计——不是账本条目不硬塞） */
  sections: Partial<Record<DistillSection, number>>
  /** 条目级 weight 事实：显式带正权重的条目数与合计（缺省权重 1 不计入——不伪造数据） */
  weights: { count: number; total: number }
}

/** 读侧格式事实汇总（纯函数；条目级字段逐条校验后计数） */
export function readSidecarFacts(raw: string): DistillSidecarFacts {
  const meta = parseSidecarMeta(raw)
  const ws = new Set<string>()
  const sections: Partial<Record<DistillSection, number>> = {}
  let weightCount = 0
  let weightTotal = 0
  for (const e of readSidecarEntriesV2(raw)) {
    if (e.workspace !== undefined) ws.add(e.workspace)
    if (e.section !== undefined) sections[e.section] = (sections[e.section] ?? 0) + 1
    if (e.weight !== undefined) {
      weightCount += 1
      weightTotal += e.weight
    }
  }
  return {
    version: meta?.version ?? 1,
    ...(meta?.workspace !== undefined ? { metaWorkspace: meta.workspace } : {}),
    workspaces: [...ws],
    sections,
    weights: { count: weightCount, total: weightTotal },
  }
}

/**
 * v2 侧车组装（纯函数，生产端唯一写侧）：meta 行 + 逐条目 v2 富集。
 * - 13 字段**值级保真**：条目行 JSON.parse → 原键序保留（新增键追加键尾）→ 重编码；
 *   值不丢不改，round-trip 由 distill.spec 钉。约定路径文件本身（hippo 所有物）不动。
 * - workspace（归属）：opts.workspace（卡 cwd）非空时**写/覆盖**每条条目——侧车随
 *   哪张卡走，归属就是那张卡的 cwd（memory-evolve #106 归属错位的正解：卡级真源
 *   优先于条目旧值）；opts 不带 cwd 时不动条目已有 workspace（无卡级真源不覆盖来源）。
 * - weight（使用权重）：条目已带正有限 weight → 保留（不覆盖）；否则由来源 strength
 *   推导（dsh-hippo 的使用/强化计数：起步 1、每次强化 +1，src/hippo/memory.ts:199）；
 *   两者皆缺 → 不写键（读侧缺省语义 = 1，不伪造 1）。非法 weight（0/负/非数）消毒剔除。
 * - section（四段账本标签）：来源在场且合法 → 透传；非法值消毒剔除（写侧保证发出的
 *   section 必在闭集内）。生产端不发明映射——hippo type（fact/decision/lesson/preference）
 *   与四段账本是两套语义，硬映射就是名词失真。
 * - 非条目行（坏行）原样保留（hippo import 本就按行跳过，不丢来源字节）；空行剔除（无数据）。
 * - 幂等：同一输入 + 同一 opts 重复组装字节不变（已富集条目不重复加键、不改值）。
 */
export function toV2Sidecar(raw: string, opts?: { workspace?: string; at?: string }): { jsonl: string; entries: number } {
  const workspace = (opts?.workspace ?? '').trim()
  const allLines = raw.split(/\r?\n/)
  // 写侧拥有文件头：输入已带 v2 meta 行（重复组装/再蒸馏产物）时剥掉旧头再重造——否则会叠双头，
  // 幂等组装（同输入同 opts 字节不变）被破坏。只剥首非空行的 meta；文件中段的非条目行照旧原样保留。
  const headOffset = parseSidecarMeta(raw) !== undefined
    ? allLines.findIndex((l) => l.trim() !== '') + 1
    : 0
  const lines: string[] = []
  let entries = 0
  for (const line of allLines.slice(headOffset)) {
    const t = line.trim()
    if (t === '') continue
    let enriched: string | undefined
    try {
      const rec = JSON.parse(t) as Record<string, unknown>
      const text = typeof rec['text'] === 'string' ? rec['text'] : ''
      if (text !== '') {
        if (workspace !== '') rec['workspace'] = workspace
        const cur = typeof rec['weight'] === 'number' && Number.isFinite(rec['weight']) && rec['weight'] > 0
          ? rec['weight']
          : undefined
        const strength = typeof rec['strength'] === 'number' && Number.isFinite(rec['strength']) && rec['strength'] > 0
          ? rec['strength']
          : undefined
        const weight = cur ?? strength
        if (weight !== undefined) rec['weight'] = weight
        else delete rec['weight']
        if (!isDistillSection(rec['section'])) delete rec['section']
        enriched = JSON.stringify(rec)
        entries += 1
      }
    } catch { /* 坏行原样保留 */ }
    lines.push(enriched ?? t)
  }
  const head = distillMetaLine({
    version: DISTILL_SIDECAR_VERSION,
    at: opts?.at ?? new Date().toISOString(),
    entries,
    ...(workspace !== '' ? { workspace } : {}),
  })
  const body = lines.join('\n')
  return { jsonl: body === '' ? `${head}\n` : `${head}\n${body}\n`, entries }
}

// ---------------------------------------------------------------------------
// A. 生产端：hippo export 落约定路径 + 侧车随卡
// ---------------------------------------------------------------------------

export interface ProduceSnapshotOptions {
  /** 已出卡成功的卡 id（侧车命名 <id>.hippo.jsonl）；缺省 = 只导出约定路径，不出侧车 */
  cardId?: string
  /** 卡的工作区 cwd（v2 workspace 归属来源——出卡接线传卡 cwd；缺省/空 = 侧车不带 workspace 字段） */
  cwd?: string
  /** 注入 runner（测试桩；缺省 realHippoRunner 真跑 hippo CLI） */
  runner?: HippoRunner
  /** 用户 home（数据目录三级解析基座；缺省真实 home） */
  home?: string
  /** HANDOFF_HOME（侧车落 pending/；缺省按 core resolveHome 链） */
  dir?: string
  /** 生命周期事件与 v2 侧车 meta.at 的时刻（oversize 留痕 / meta 时间戳定钟；缺省当前时刻） */
  now?: Date
}

/** 生产结果：ok=false 是 fail-open（guidance 回退），调用方只取 note 如实附注，绝不拦出卡 */
export type DistillProduceResult =
  | {
      ok: true
      /** 三级解析出的数据目录（与扫描同一套解析） */
      dataDir: string
      /** 条目 JSONL 约定路径（MEMORY_STORES entriesFile 单点解析） */
      entriesFile: string
      /** 导出文件字节数 */
      bytes: number
      /** 有效条目数（readStoreEntries 同口径解析；坏行不计） */
      entries: number
      /** 侧车落盘路径（超尺寸闸 / 未给卡 id / 落盘失败时缺省） */
      sidecar?: string
      /** v2 侧车实际字节数（meta 行 + 条目富集，≥ 导出文件字节；未出侧车时缺省） */
      sidecarBytes?: number
      /** 如实说明（导出计数、侧车随卡、超尺寸未随卡等） */
      note: string
    }
  | {
      ok: false
      /** cli-missing=未装 hippo CLI（spawn ENOENT）；export-failed=非零退出/超时/文件未落 */
      state: 'cli-missing' | 'export-failed'
      dataDir: string
      entriesFile: string
      /** 诚实说明 + 手动补救命令（fail-open，出卡照常） */
      note: string
    }

/**
 * 生产端唯一入口：跑 `hippo export -f jsonl -o <约定路径>`，成功后按需出侧车。
 * 单 options 对象签名（cardId 与注入面同对象）——出卡接线传 { cardId }，测试传
 * { runner, home, dir }，没有 args/deps 双位形参的错位面（错位会静默真跑 CLI）。
 * - 数据目录与约定路径都走 memory.ts 既有解析（三级链 + MEMORY_STORES 注册表），
 *   不重复实现；子进程 env 钉 HIPPO_DATA_DIR=解析结果——hippo CLI 自己只认 env
 *   （dsh-hippo store.ts dataDir(): env ?? ~/.hippo，不读 data-dir.txt），不钉的话
 *   解析链走 data-dir.txt 分支时 CLI 会开错目录，与扫描口径分叉。
 * - 侧车 = 约定文件内容的 **v2 组装**（meta 行 + 条目级 workspace/weight/section，
 *   13 字段值级保真；约定路径文件本身是 hippo 所有物，只读不动）；超 MAX_CARD_BYTES
 *   走尺寸闸（闸算在 v2 侧车实际字节上）：不出侧车 + lifecycle oversize 留痕
 *  （闭集既有理由），条目仍按 storeBody 既有 64KB 截断口径进卡。
 * - 任何失败 fail-open：回 ok:false 与两态文案（未装 CLI / 导出失败），不抛异常。
 */
export function produceSnapshot(opts?: ProduceSnapshotOptions): DistillProduceResult {
  const home = opts?.home ?? homedir()
  // 与扫描共用三级解析（env HIPPO_DATA_DIR → data-dir.txt → 回退 ~/.hippo），不重复实现
  const dataDir = hippoDataDir(home)
  const entriesFile = hippoEntriesFile(dataDir)
  try {
    const runner = opts?.runner ?? realHippoRunner
    try {
      runner('hippo', ['export', '-f', 'jsonl', '-o', entriesFile], { env: { HIPPO_DATA_DIR: dataDir }, timeout: HIPPO_CLI_TIMEOUT_MS })
    } catch (e) {
      if (isEnoent(e)) {
        return {
          ok: false, state: 'cli-missing', dataDir, entriesFile,
          note: `本机未装 hippo CLI：快照未导出，本卡按 guidance 指引回退（不拦出卡）。装好 dsh-hippo 后重新出卡即自动导出随卡；也可手动补：hippo export -f jsonl -o "${entriesFile}"。`,
        }
      }
      return {
        ok: false, state: 'export-failed', dataDir, entriesFile,
        note: `hippo export 失败（${msg(e)}）：本卡按 guidance 指引回退（不拦出卡）。可手动补：hippo export -f jsonl -o "${entriesFile}"，补齐后重新出卡。`,
      }
    }
    // 以磁盘实况结账：runner 谎报成功但约定文件不在场 = 导出失败，绝不造「已导出」假象
    let bytes = 0
    try {
      bytes = statSync(entriesFile).size
    } catch {
      return { ok: false, state: 'export-failed', dataDir, entriesFile, note: `hippo export 退出码 0 但约定文件未落盘（${entriesFile}）：按导出失败处理（guidance 回退，不拦出卡）。` }
    }
    // 条目计数与出卡组装同一套解析（readStoreEntries）；空导出如实报，不粉饰产量
    const read = readStoreEntries(entriesFile)
    const entries = read?.entries.length ?? 0
    const notes: string[] = [
      entries > 0
        ? `hippo 快照已导出：${entries} 条条目（${Math.max(1, Math.round(bytes / 1024))} KB）落约定路径，重新出卡即按条目随卡。`
        : `hippo 快照已导出但 0 条有效条目（空库或全坏行，${bytes} 字节）：记忆卡仍走 guidance 指引（如实空态）`,
    ]
    let sidecar: string | undefined
    let sidecarBytes: number | undefined
    const cardId = typeof opts?.cardId === 'string' ? opts.cardId.trim() : ''
    if (cardId === '') {
      notes.push('未给卡 id：只导出约定路径，未出侧车。')
    } else if (!isSafeCardId(cardId)) {
      notes.push(`卡 id 形态非法（${cardId.slice(0, 48)}…）：侧车未随卡（防御：侧车名锚在卡 id 上，非法 id 不落盘）。`)
    } else {
      try {
        const pend = pendingDir(opts?.dir)
        mkdirSync(pend, { recursive: true })
        // v2 侧车组装：meta 行 + 条目级 workspace/weight/section（约定路径文件是 hippo
        // 所有物，只读不动——v2 组装只发生在侧车这一份拷贝上）
        const raw = readFileSync(entriesFile, 'utf-8')
        const cwd = (opts?.cwd ?? '').trim()
        const v2 = toV2Sidecar(raw, { workspace: cwd, ...(opts?.now !== undefined ? { at: opts.now.toISOString() } : {}) })
        const v2Bytes = Buffer.byteLength(v2.jsonl, 'utf-8')
        if (v2Bytes > MAX_CARD_BYTES) {
          // 尺寸闸：超 MAX_CARD_BYTES 的 v2 侧车不随卡（收件箱读侧同款上限），oversize 留痕。
          // 闸算在 v2 实际字节上（meta 行 + 富集后的随卡物），不是导出文件——随卡的是它
          recordLifecycleEvent({
            stage: 'write',
            reason: 'oversize',
            target: cardId,
            detail: `hippo 侧车（v2）${v2Bytes} 字节超 MAX_CARD_BYTES（${MAX_CARD_BYTES}），未随卡`,
          }, opts?.dir, opts?.now)
          notes.push(`v2 快照 ${v2Bytes} 字节超 MAX_CARD_BYTES（${MAX_CARD_BYTES}）：侧车未随卡（oversize 留痕）；条目仍按 64KB 截断口径进卡「建议加载」段，全量以 hippo CLI 导入/导出为准。`)
        } else {
          const dest = join(pend, `${cardId}${HIPPO_SIDECAR_SUFFIX}`)
          writeFileSync(dest, v2.jsonl, 'utf-8')
          sidecar = dest
          sidecarBytes = v2Bytes
          notes.push(`v2 快照侧车随卡：${basename(dest)}（meta version 2 + ${v2.entries} 条条目${cwd !== '' ? '，workspace 归属随卡' : ''}；13 字段值保真，导入走 hippo CLI——meta 行由 hippo 按坏行跳过，实测不拒收）。`)
        }
      } catch (e) {
        notes.push(`侧车落盘失败（卡片本体与导出不受影响）：${msg(e)}`)
      }
    }
    return {
      ok: true, dataDir, entriesFile, bytes, entries,
      ...(sidecar !== undefined ? { sidecar } : {}),
      ...(sidecarBytes !== undefined ? { sidecarBytes } : {}),
      note: notes.join(' '),
    }
  } catch (e) {
    return { ok: false, state: 'export-failed', dataDir, entriesFile, note: `蒸馏生产端异常（fail-open，出卡不受影响）：${msg(e)}` }
  }
}

/** 卡 id 形态闸（assertSafeId 的布尔包装——非法 id 只降级不出侧车，不抛） */
function isSafeCardId(id: string): boolean {
  try {
    assertSafeId(id)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// B. 取件搬移：侧车 pending → archived（纯函数；接线归集成面 inboxLoad，consumePatch 同位）
// ---------------------------------------------------------------------------

export type ConsumeDistillResult =
  | { state: 'moved'; path: string; bytes: number }
  /** pending/ 没有侧车（无快照卡/旧卡，常态不是异常） */
  | { state: 'absent' }
  /** rename 失败：侧车留 pending，取件主流程照旧成功，调用方按本态如实附注 */
  | { state: 'move-failed'; error: string }

/**
 * 取件时同步搬侧车：pending/<id>.hippo.jsonl → archived/（与 .md 同步搬）。
 * 与 consumePatch 同款 fail-open：任何一步失败都只回状态，绝不影响取件成败；
 * 侧车留 pending 时收件箱列表不受影响（core 列表只认 .md）。
 */
export function consumeDistillSidecar(id: string, dir?: string): ConsumeDistillResult {
  try {
    if (!isSafeCardId(id)) return { state: 'absent' }
    const src = join(pendingDir(dir), `${id}${HIPPO_SIDECAR_SUFFIX}`)
    if (!existsSync(src)) return { state: 'absent' }
    const arch = archivedDir(dir)
    const dest = join(arch, `${id}${HIPPO_SIDECAR_SUFFIX}`)
    try {
      // 防御：正常接线（inboxLoad 内 loadCard 之后）archived/ 必已存在；不依赖调用顺序，缺席就建
      mkdirSync(arch, { recursive: true })
      renameSync(src, dest)
      return { state: 'moved', path: dest, bytes: statSync(dest).size }
    } catch (e) {
      return { state: 'move-failed', error: `侧车搬移失败（留 pending/${id}${HIPPO_SIDECAR_SUFFIX}）：${msg(e)}` }
    }
  } catch (e) {
    return { state: 'move-failed', error: msg(e) }
  }
}

// ---------------------------------------------------------------------------
// C. 消费端：archived 侧车定位 / 记账本 / hippo import 执行器（absorb 的 hippo-db 分支用）
// ---------------------------------------------------------------------------

/** 导入记账条目：同卡幂等在 takeover 侧的凭据（sha 对得上 = 已导入过，直接跳过） */
export interface HippoLedgerEntry {
  /** 导入时侧车内容的 sha256 */
  sha256: string
  /** 导入时刻（ISO） */
  at: string
  /** 侧车有效条目数（导入口径） */
  entries: number
  /** 侧车字节数 */
  bytes: number
}

/** 记账本路径：archived/absorb-backup/hippo-import-ledger.json（与写前快照同居） */
export function hippoLedgerPath(dir?: string): string {
  return join(archivedDir(dir), 'absorb-backup', HIPPO_LEDGER_FILE)
}

/** 读记账本（坏文件/读失败回空账——宁可重导入，hippo dedup 兜底幂等，不丢条目） */
export function readHippoLedger(dir?: string): Record<string, HippoLedgerEntry> {
  try {
    const raw = readFileSync(hippoLedgerPath(dir), 'utf-8')
    const o = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, HippoLedgerEntry> = {}
    for (const [k, v] of Object.entries(o)) {
      const e = v as Partial<HippoLedgerEntry> | null
      if (e !== null && typeof e === 'object' && typeof e['sha256'] === 'string' && typeof e['at'] === 'string') {
        out[k] = {
          sha256: e['sha256'],
          at: e['at'],
          entries: typeof e['entries'] === 'number' ? e['entries'] : 0,
          bytes: typeof e['bytes'] === 'number' ? e['bytes'] : 0,
        }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** 记账（导入成功后调用）。返回如实附注：''=记账成功；非空=记账失败的诚实说明
 * （导入本身不回滚——hippo dedup-reinforce 保证重复导入仍幂等，只是下次会再跑一遍 CLI）。 */
export function recordHippoLedger(id: string, entry: HippoLedgerEntry, dir?: string): string {
  try {
    const path = hippoLedgerPath(dir)
    mkdirSync(dirname(path), { recursive: true })
    const next = { ...readHippoLedger(dir), [id]: entry }
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    return ''
  } catch (e) {
    return `导入记账失败（导入已生效）：${msg(e)}——同卡重复 absorb 会再跑一次 hippo import，幂等由 hippo dedup-reinforce 兜底。`
  }
}

/** located 侧车信息（absorb 计划回显与执行共用；v1/v2 双兼容——格式事实随侧车如实带出） */
export interface HippoSidecarInfo {
  /** archived/ 下侧车绝对路径 */
  sidecar: string
  /** 内容 sha256（takeover 侧同卡幂等凭据——v1/v2 同一机制，键不变） */
  sha256: string
  bytes: number
  /** 有效条目数（readStoreEntries 同口径；坏行不计——v2 meta 行也按无 text 行跳过） */
  entries: number
  /** 三级解析出的目标数据目录（env 钉给 hippo CLI 用；takeover 从不直接写它） */
  dataDir: string
  /** 侧车格式版本（meta 行缺失/坏行按 1——「meta 缺失按 v1 处理」口径；v2 族 ≥2） */
  sidecarVersion: number
  /** v2 meta 行声明的归属 workspace（v1 / meta 未带则缺省） */
  v2Workspace?: string
  /** 四段账本计数（v2 section 在场条目的标签计数；v1 恒空对象） */
  v2Sections: Partial<Record<DistillSection, number>>
}

/**
 * 纯读定位 archived 侧车并算凭据（confirm 计划回显用；零写盘、零子进程）。
 * 定位失败回 { error }：侧车缺失是最常见的诚实态（无快照卡/搬移失败卡），
 * 文案如实说明「不静默假装导入过」并给回源机重出的指引。
 */
export function locateHippoSidecar(id: string, deps?: { dir?: string; home?: string }): HippoSidecarInfo | { error: string } {
  if (!isSafeCardId(id)) return { error: `非法卡片 id：${id.slice(0, 48)}…` }
  const sidecar = join(archivedDir(deps?.dir), `${id}${HIPPO_SIDECAR_SUFFIX}`)
  if (!existsSync(sidecar)) {
    return {
      error: [
        `卡 ${id} 没有随卡的 hippo 快照侧车（archived/${id}${HIPPO_SIDECAR_SUFFIX} 不在场）。`,
        'hippo-db 是 zvec 原生引擎目录（proxima 向量索引 + rocksdb FTS），绝不按文件写回（T8 硬线）；absorb 只导入出卡时真的随卡走的快照，不静默假装导入过。',
        '要带记忆库：源机装 hippo CLI 后重新出卡（出卡自动 hippo export 并挂侧车）；本机也可手动导入已有快照：hippo import <快照.jsonl>（幂等）。',
      ].join(''),
    }
  }
  let raw: string
  try {
    raw = readFileSync(sidecar, 'utf-8')
  } catch (e) {
    return { error: `侧车读取失败：${msg(e)}` }
  }
  const read = readStoreEntries(sidecar)
  if (read === undefined) {
    return { error: `侧车 0 条有效条目（空快照或全坏行）：无可导入内容，按导入失败处理（不假装导入过）。` }
  }
  // v1/v2 双兼容：格式事实随侧车如实解出（meta 缺失按 v1，不虚构 v2 字段）
  const facts = readSidecarFacts(raw)
  return {
    sidecar,
    sha256: createSha256(raw),
    bytes: Buffer.byteLength(raw, 'utf-8'),
    entries: read.entries.length,
    dataDir: hippoDataDir(deps?.home ?? homedir()),
    sidecarVersion: facts.version,
    ...(facts.metaWorkspace !== undefined ? { v2Workspace: facts.metaWorkspace } : {}),
    v2Sections: facts.sections,
  }
}

function createSha256(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex')
}

export type HippoImportRunResult =
  | { ok: true; dataDir: string; entries: number; note: string }
  | { ok: false; state: 'cli-missing' | 'import-failed'; error: string }

/**
 * 导入执行器（absorb 的 confirm 闸通过后才调）：`hippo import <archived>/<id>.hippo.jsonl`。
 * - 子进程 env 钉 HIPPO_DATA_DIR=解析结果（与生产端同理由：hippo CLI 只认 env，不钉会开错库）；
 * - 幂等：hippo 层 dedup-reinforce（重复条目强化合并不覆盖）；执行器本身无状态可重入；
 * - v2 侧车兼容有实测背书（dsh-hippo transfer.ts:114-146 只取已知字段、缺 text 行按坏行
 *   跳过；0.3.0 CLI 对 v2 形态实测：meta 行 skipped 1、条目全数入库、退出码 0）；
 * - supersede 推翻链的旁路索引重建归属 hippo import 行为——本函数只取退出码，不深解析
 *   输出（材料在 import 返回值处截断），note 如实标注「推翻链以 hippo 侧为准」；
 * - CLI 缺席 / 非零退出 / 超时 → ok:false + 诚实指引（现状降级底座），不抛异常。
 */
export function hippoImportRun(info: HippoSidecarInfo, deps?: { runner?: HippoRunner; home?: string; dir?: string; now?: Date }): HippoImportRunResult {
  const runner = deps?.runner ?? realHippoRunner
  try {
    runner('hippo', ['import', info.sidecar], { env: { HIPPO_DATA_DIR: info.dataDir }, timeout: HIPPO_CLI_TIMEOUT_MS })
  } catch (e) {
    if (isEnoent(e)) {
      return {
        ok: false, state: 'cli-missing',
        error: `本机未装 hippo CLI：导入未执行（侧车原样留在 ${info.sidecar}，可随时重试）。降级指引：装好 dsh-hippo 后 handoff_absorb({ id, target: 'hippo-db', confirm: true })，或手动导入 hippo import "${info.sidecar}"（幂等）。`,
      }
    }
    return {
      ok: false, state: 'import-failed',
      error: `hippo import 失败（${msg(e)}）：侧车原样留在 ${info.sidecar}（未记账，可修复后重试同一调用）。手动通路：hippo import "${info.sidecar}"（幂等，重复条目强化合并不覆盖）。`,
    }
  }
  return {
    ok: true,
    dataDir: info.dataDir,
    entries: info.entries,
    note: `hippo import 退出码 0：${info.entries} 条条目交 hippo 入库（重复条目由 dedup-reinforce 强化合并、不覆盖）；${info.sidecarVersion >= 2 ? 'v2 侧车的 meta 行会被 hippo 按「缺 text 坏行」跳过（skipped 计 1，实测不拒收）——v2 字段（workspace/weight/section）对 hippo 是未知字段，忽略不库；' : ''}supersede 推翻链以 hippo 侧为准（takeover 不重建旁路索引）。`,
  }
}
