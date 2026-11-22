/**
 * 设置卡支撑层（host 半，可脱离 cordis 单测）：
 * - provider 开关：持久化在 <HANDOFF_HOME>/config.json（与 pending/archived 同屋，每次调用现读、改动即刻生效，
 *   重启生效）；foreign_session_read 对停用家返回规范错误值「已停用」。
 * - buildState：设置卡 /dsh-takeover/state 的组装逻辑——收件箱概览 + 二十三家支持矩阵。
 * - clearArchived：清空 archived/ 全部 .md，返回清除份数。
 * 任何一步失败都回规范值 / 降级值，绝不抛出。
 * @module dsh-takeover/settings
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archivedDir, listPendingReport, resolveHome } from '@agent-handoff/core'
import { isLowInfoCardMarkdown } from './lowinfo.ts'
import { readLifecycleEvents, reasonFromCoreSkip, LIFECYCLE_STATE_MAX } from './lifecycle.ts'
import { FOREIGN_PROVIDERS, PROVIDER_TO_ADAPTER, type ForeignProvider, type ForeignReaders } from './foreign.ts'
import { syncStatusOf, type SyncStatus } from './sync.ts'
import { listBackups, type AutoUpgradeSnapshotValue, type BackupRow } from './envbackup.ts'
import type { ContexthealthReport } from './contexthealth.ts'
import { listPins, type InboxSearchResult } from './inboxtriage.ts'
import { scanStore, type DoctorReport } from './sessiondoctor.ts'
import { readMachineName } from './directed.ts'
import type { RelayLedger } from './relayledger.ts'

// 停用规范错误值文案在 foreign.ts（disabledError），本模块只管开关存取与状态组装

/** 开关文件形态：只记停用名单（默认全开，未知条目载入时丢弃） */
export interface TakeoverSwitches {
  disabledProviders: string[]
}

/** 补丁 gzip 分块文件名尾段（<id>.patch.NNN.gz）；单块 <id>.patch.gz 无序号段不匹配 */
const PATCH_CHUNK_GZ_RE = /\.patch\.(\d+)\.gz$/

/** config.json 路径（HANDOFF_HOME 优先，否则 ~/.handoff） */
export function switchesPath(dir?: string): string {
  return join(resolveHome(dir), 'config.json')
}

/** 读开关：文件缺失/损坏一律视为默认全开（fail-open 是有文档的取舍），
 * 但损坏必须告警——隐私开关被无声恢复是不可接受的静默 */
export function loadSwitches(dir?: string): TakeoverSwitches {
  try {
    const p = switchesPath(dir)
    if (!existsSync(p)) return { disabledProviders: [] }
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as { disabledProviders?: unknown }
    const list = Array.isArray(raw.disabledProviders) ? raw.disabledProviders : []
    return {
      disabledProviders: list.filter(
        (x): x is string => typeof x === 'string' && (FOREIGN_PROVIDERS as readonly string[]).includes(x),
      ),
    }
  } catch (e) {
    console.warn(`config.json 读取失败，按默认全开处理：${e instanceof Error ? e.message : String(e)}`)
    return { disabledProviders: [] }
  }
}

/** 写开关：tmp+rename 原子替换（进程中断不再留下半截 config.json） */
export function saveSwitches(switches: TakeoverSwitches, dir?: string): void {
  const home = resolveHome(dir)
  mkdirSync(home, { recursive: true })
  const target = switchesPath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(switches, null, 2)}\n`, 'utf-8')
  try {
    renameSync(tmp, target)
  } catch (e) {
    // rename 失败（跨设备等）退回直写；临时文件尽力清掉
    try { rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
    throw e
  }
}

/** 某家是否启用（默认启用；只认注册表名单内的停用条目） */
export function isProviderEnabled(provider: string, dir?: string): boolean {
  return !loadSwitches(dir).disabledProviders.includes(provider)
}

/** 切某家开关并持久化；未知 provider 抛中文错（路由层转 400） */
export function setProviderEnabled(provider: string, enabled: boolean, dir?: string): TakeoverSwitches {
  if (!(FOREIGN_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`未知 provider：${provider}（支持：${FOREIGN_PROVIDERS.join(' / ')}）`)
  }
  const cur = loadSwitches(dir)
  const set = new Set(cur.disabledProviders)
  if (enabled) set.delete(provider)
  else set.add(provider)
  const next: TakeoverSwitches = { disabledProviders: [...set].sort() }
  saveSwitches(next, dir)
  return next
}

// ---------------------------------------------------------------------------
// 云端导出落盘（exports 目录探测器）
// ---------------------------------------------------------------------------

/**
 * 云端导出落盘计数：<HANDOFF_HOME>/exports/<provider>/ 下的常规文件数。
 * 约定（README「跨机器 / 云端」）：各家云端会话凡能「导出成文件」的，按该家本地
 * 记录的原生格式丢进对应子目录，即被读取器吃掉（readers 侧 exports 同款探测，
 * 两轴独立：本计数只管矩阵显示，读取器并网不看它）。目录缺失 / 读失败 = 0——
 * 无导出是常态两态之一，不是错误，绝不抛出。
 */
export function exportsCountOf(provider: string, dir?: string): number {
  try {
    const p = join(resolveHome(dir), 'exports', provider)
    let n = 0
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.isFile()) n += 1
    }
    return n
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// /dsh-takeover/state 组装
// ---------------------------------------------------------------------------

/** 收件箱概览的待取件行 */
export interface PendingRow {
  id: string
  agent: string
  title: string
  project: string
  pushedAt: string
  /** 目标段（sections.goal）预览，截 240 字；空段回退 done 段 */
  preview: string
  /** preview 实际取自 done 段（目标段为空的回退）——导出侧据此归段，避免段级错位 */
  previewFromDone?: boolean
  /** 空壳卡：六段全是兜底占位文本（噪音治理判据，客户端据此打标/折叠） */
  lowInfo: boolean
  /** 接力链：本卡接替的前置卡 id（信封 extras.supersedes——协议设计只随信封走，卡片本体不含；链可视化）。非接力卡缺省 */
  supersedes?: string
  /** 0.26 第三波接线（directed 立约）：Card.to 自由串原样透传（machine:<机器名> 点名 /
   * agent 名 / any）。客户端按 machine: 前缀做三桶分组（mine=点名本机 / others=别机点名 /
   * any=其余；bucketOf 同口径，inbox-view.addressBucketOf 局部实现有一致性钉）。
   * 空串/缺省不落字段（老 host 缺省，客户端防御式消费）。 */
  to?: string
}

/** 预览截断长度（服务端截，避免长卡片把 state 撑大） */
const PREVIEW_MAX = 240

function previewOf(c: { sections: { goal: string; done: string } }): { text: string; fromDone: boolean } {
  const fromDone = c.sections.goal === ''
  const raw = fromDone ? c.sections.done : c.sections.goal
  return {
    text: raw.length > PREVIEW_MAX ? `${raw.slice(0, PREVIEW_MAX)}…` : raw,
    fromDone,
  }
}

/** 支持矩阵行：本机是否支持 / 发现的会话数 / 启用开关 / 云端导出落盘数 */
export interface ProviderRow {
  name: ForeignProvider
  supported: boolean
  /** 发现的会话数；探测失败为 -1（前端显示「—」） */
  sessions: number
  enabled: boolean
  note: string
  /** 云端导出落盘：<HANDOFF_HOME>/exports/<provider>/ 下的导出文件数（读取器已并网；
   * 目录缺失 / 家不参与（纯 SQLite 四家）= 0，矩阵该行不出导出标）。 */
  exports: number
}

export interface TakeoverState {
  /** 解析后的 HANDOFF_HOME 绝对路径（默认 ~/.handoff）：客户端 localStorage
   * 已见卡集合的键散列数据源（0.3.0 新卡徽标），同源连不同机器不串扰 */
  home: string
  pending: PendingRow[]
  /** 收件箱概览里被跳过的坏卡数（不再静默） */
  pendingSkipped: number
  /** 同 frontmatter id 的重复文件数（已按首见去重；多方可写收件箱的防御计数） */
  pendingDuplicates: number
  /** 收件箱概览不可用时的降级说明（pending 位置异常等）；正常时缺省 */
  inboxError?: string
  archivedCount: number
  /** 待取件卡账本覆盖聚合（各卡 extras.coverage 求和）；无数据缺省。
   * 口径纪律：只聚合不强制——防「为覆盖率假标」污染账本 */
  coverage?: { statements: number; marked: number; unmarked: number }
  /** 待取件机器信封字符总量（*.envelope.json 文件字节数求和）；无信封缺省 */
  envelopeChars?: number
  providers: ProviderRow[]
  /** 0.4.1 死亡地图：卡片生命周期拒收证据（结构化闭集理由）。
   * live = 读侧当前跳过（state 现算，修好即消失）；persisted = 写侧/取侧持久事件
   * （lifecycle.jsonl 尾 50 条，多写方排障用）；persistedTotal = 日志总条数。
   * 全空（无坏卡且无日志）时缺省。 */
  rejections?: {
    live: Array<{ file: string; reason: string; detail: string }>
    persisted: Array<{ at: string; stage: string; reason: string; target: string; detail: string }>
    persistedTotal: number
  }
  /** 0.2.0 换机同步状态（零网络：sync.json + sync-state.json + 本地脏计数）。
   * 未启用时缺省——客户端整个换机块不渲染。 */
  syncStatus?: SyncStatus
  /** 0.2.0 环境备份清单（env-backup/ 目录只读枚举，不解密）；无备份缺省。
   * 0.26 snapshot 接线增 autoUpgradeSnapshot：启动触发器最近一次结果旁证
   * （created/same/skipped 三态，detail 给人看；index.ts 激活处写入 holder）。 */
  envBackup?: { backups: BackupRow[]; autoUpgradeSnapshot?: AutoUpgradeSnapshotValue }
  /** 0.26 上下文预警（contextHealth 探针报告）。**buildState 不探测会话对象**：
   * 组装保持纯读盘，contextHealth 由路由层展开——GET state / 写侧动作带可选 sessionId
   * 且会话在场时，路由把 probeContexthealth(session) 展开到本字段（server.ts，
   * 集成裁定取「路由层展开」而非 buildState 新入参：buildState 的全部既有调用方
   * （settings.spec / recovery.spec / 面板 30s 轮询）零改动）。无参 / 无会话 /
   * 探测降级（level='unknown' 照报）之外的抛错路径字段缺省。 */
  contextHealth?: ContexthealthReport
  /** 0.26 triage 接线：当前有效置顶卡 id（pins.json 懒清理后的盘面现实，新置顶在前）。
   * 老 host 缺省——客户端防御式消费（inboxtriage.listPins fail-open：sidecar 损坏回空）。 */
  pins?: string[]
  /** 0.26 triage 接线：收件箱检索结果（GET state 带可选 q 参数时由路由层展开，
   * includeBody=1 时逐卡读正文——inboxtriage.searchInbox 立约：空 query 空命中、
   * 枚举失败回规范 error 值绝不抛）。无 q 参数字段缺省（无参请求响应零变化）。 */
  inboxQuery?: InboxSearchResult
  /** 0.26 doctor 接线：总线只读体检报告（scanStore：损坏段/形态/孤儿侧车/链三查，
   * issues 按 severity 分级 error/warn/info，ok=true 即零发现）。buildState 每次现扫
   * （pending+archived 全量只读；与收件箱概览同一量级——ARCHIVED_KEEP=50 封顶）；
   * 扫描自身异常字段缺省（scanStore 承诺不抛，此处兜绝对意外）。 */
  doctor?: DoctorReport
  /** 0.26 第三波接线：本机机器名（<HANDOFF_HOME>/machine.json 的 { name }，缺席/损坏
   * fail-open 回 os.hostname——directed.readMachineName 立约，fail-open 必 warn 留痕）。
   * 收件箱点名分组（mine=to=machine:本机名）的判定源；客户端防御式消费。 */
  machineName?: string
  /** 0.26 第三波接线：接力总账（aggregateLedger 三源翻账）。**buildState 不算总账**——
   * 组装保持既有读面，总账由路由层按需展开：GET state 带 ?ledger=1 时
   * aggregateLedger() 并入本字段（inboxQuery 同款「无参请求响应零变化」扩展）；
   * 聚合自身承诺绝不抛，路由层仍兜绝对意外字段缺省。 */
  ledger?: RelayLedger
}

// ---------------------------------------------------------------------------
// 升级保险快照旁证 holder（0.26 snapshot 接线）：index.ts 插件激活处的启动触发器
// fire-and-forget 异步完成，buildState 是同步纯函数拿不到它——经本单槽 holder 交接。
// 每次启动至多触发一次，后写覆盖前值（进程内单例语义）；进程重启自然重来。
// ---------------------------------------------------------------------------

let autoUpgradeSnapshotEvidence: AutoUpgradeSnapshotValue | undefined

/** 启动触发器回写最近一次 maybeAutoUpgradeSnapshot 结果（index.ts 激活处调用；
 * undefined = 清空，如触发器自身异常时让 state 不残留上一进程的旧话） */
export function setAutoUpgradeSnapshotEvidence(v: AutoUpgradeSnapshotValue | undefined): void {
  autoUpgradeSnapshotEvidence = v
}
/**
 * 组装设置卡状态（纯函数核心，读取层与目录都可注入）：
 * 单家探测失败只影响该行，不拖垮整体。
 */
export function buildState(readers: ForeignReaders, dir?: string): TakeoverState {
  const switches = loadSwitches(dir)

  // 收件箱概览单独降级：pending 位置被同名文件占据等异常，只说明缺口，不炸整个设置卡
  // （settings 头注释契约「任何一步失败都回规范值，绝不抛出」此前在 listPending/listArchived 上失守）
  let pending: PendingRow[] = []
  let pendingSkipped = 0
  let pendingDuplicates = 0
  let inboxError: string | undefined
  // 收件箱聚合：待取件卡的账本覆盖求和 + 机器信封字符总量（0.4.0，显示位在 client 侧防御消费）。
  // 聚合失败只影响这两个字段，不拖垮整体 state（settings 头注释契约同款）。
  let coverage: TakeoverState['coverage']
  let envelopeChars: number | undefined
  // 死亡地图读侧活性跳过（report 在 try 内，外层变量带回 return）
  let live: NonNullable<TakeoverState['rejections']>['live'] = []
  try {
    const report = listPendingReport(dir)
    live = report.skipped.map((sk) => ({ file: sk.file, reason: reasonFromCoreSkip(sk.reason), detail: sk.reason }))
    // 同 frontmatter id 的重复文件只保留首次出现（core 宽松解析放行，重复会让
    // React key 冲突、覆盖率重复计数——0.4.0 审计 F1）
    const seenCardIds = new Set<string>()
    const uniqueCards = report.cards.filter((c) => {
      if (seenCardIds.has(c.id)) return false
      seenCardIds.add(c.id)
      return true
    })
    pendingSkipped = report.skipped.length
    pendingDuplicates = report.cards.length - uniqueCards.length

    const pd = join(resolveHome(dir), 'pending')
    // 目录缺失 = 空收件箱（与 listDirCards 同语义）：全新安装首次 push 前不该显示降级态
    const pdExists = existsSync(pd)
    const cardTexts = new Map<string, string>()
    if (pdExists) {
      for (const f of readdirSync(pd)) {
        if (!f.endsWith('.md')) continue
        try {
          // 读侧尺寸闸：与 core MAX_CARD_BYTES 同口径——巨文件（含 core 跳过的坏卡）
          // 不全量读进内存，30s 轮询的 state 不被单文件放大
          if (statSync(join(pd, f)).size > 8 * 1024 * 1024) continue
          cardTexts.set(f.slice(0, -3), readFileSync(join(pd, f), 'utf-8'))
        } catch { /* 单项读失败按未知，不强判低信息 */ }
      }
    }
    pending = uniqueCards.map((c) => {
      const pv = previewOf(c)
      const raw = cardTexts.get(c.id)
      return {
        id: c.id,
        agent: c.from.agent, // 空串交给客户端词典渲染兜底文案（host 侧中文字面量会漏进 EN 界面与导出）
        title: c.from.title,
        project: c.project,
        pushedAt: c.pushed_at,
        preview: pv.text,
        previewFromDone: pv.fromDone,
        lowInfo: raw !== undefined ? isLowInfoCardMarkdown(raw) : false,
        // 0.26 第三波接线（directed 立约）：Card.to 原样透传（machine: 点名分组的数据源）；
        // 空串/缺省不落字段——客户端按「字段缺席=any 桶」防御式消费
        ...(typeof c.to === 'string' && c.to !== '' ? { to: c.to } : {}),
      }
    })

    for (const c of uniqueCards) {
      const cov = (c.extras as { coverage?: { statements?: unknown; marked?: unknown; unmarked?: unknown } } | undefined)?.coverage
      if (cov && [cov.statements, cov.marked, cov.unmarked].every((x) => typeof x === 'number' && Number(x) >= 0)) {
        coverage ??= { statements: 0, marked: 0, unmarked: 0 }
        coverage.statements += Number(cov.statements)
        coverage.marked += Number(cov.marked)
        coverage.unmarked += Number(cov.unmarked)
      }
    }
    if (pdExists) {
      // 活性判据 = 对应 .md 是否真在盘上。此前用「解析成功卡集合」，
      // 会把超尺寸/解析失败但仍在册的卡的信封误当孤儿销毁（supersedes 链等机器层
      // 元数据不可恢复）——core 对这类卡明确「保留在收件箱」
      const supersedesByOwner = new Map<string, string>()
      // 伴生文件孤儿清扫：信封（*.envelope.json）与补丁（*.patch，含 0.4.x gzip 形态
      // *.patch.gz 与分块 *.patch.NNN.gz）是纯派生物，仅当对应 .md 确实不在盘上
      //（已被任何实现取走，含不认识伴生文件的旧版）才删。补丁孤儿是真实崩溃窗口的
      // 产物：inboxLoad 顺序是 md→信封→补丁，中途崩溃会留下列表永不显示（列表只认
      // .md）、永不消费的僵尸补丁——清扫是恢复语义的最后一环
      for (const f of readdirSync(pd)) {
        const gzChunk = PATCH_CHUNK_GZ_RE.exec(f)
        if (!f.endsWith('.envelope.json') && !f.endsWith('.patch') && !f.endsWith('.patch.gz') && gzChunk === null) continue
        const ownerId = f.endsWith('.envelope.json')
          ? f.slice(0, -'.envelope.json'.length)
          : gzChunk !== null
            ? f.slice(0, f.length - gzChunk[0].length)
            : f.endsWith('.patch.gz')
              ? f.slice(0, -'.patch.gz'.length)
              : f.slice(0, -'.patch'.length)
        const hasMd = existsSync(join(pd, `${ownerId}.md`))
        try {
          if (!hasMd) {
            rmSync(join(pd, f))
            continue
          }
          const st = statSync(join(pd, f))
          if (f.endsWith('.envelope.json')) {
            envelopeChars = (envelopeChars ?? 0) + st.size
            // 链数据源 + S6 尺寸闸：supersedes 按协议设计只随信封走（卡片本体
            // 不含，卡片侧注入不算数）；信封超 64KB 只计字符不读入（30s 轮询不被
            // 外来巨信封阻塞），坏 JSON 不拦统计
            if (supersedesByOwner.size < 200 && st.isFile() && st.size <= 65536) {
              try {
                const env = JSON.parse(readFileSync(join(pd, f), 'utf-8')) as { supersedes?: unknown }
                if (typeof env.supersedes === 'string' && env.supersedes !== '') supersedesByOwner.set(ownerId, env.supersedes)
              } catch { /* 单信封解析失败不影响统计 */ }
            }
          }
        } catch {
          /* 单项 stat/删除失败不计入 */
        }
      }
      for (const p of pending) {
        const sup = supersedesByOwner.get(p.id)
        if (sup !== undefined) p.supersedes = sup
      }
    }
  } catch (e) {
    inboxError = `收件箱概览不可用：${e instanceof Error ? e.message : String(e)}`
    console.warn(`[dsh-takeover] buildState：${inboxError}`)
  }

  const providers: ProviderRow[] = FOREIGN_PROVIDERS.map((name) => {
    const adapter = PROVIDER_TO_ADAPTER[name]
    let supported = false
    let note = ''
    let sessions = -1
    try {
      const n = readers.adapterNote(adapter)
      supported = n.supported
      note = n.note
    } catch (e) {
      note = e instanceof Error ? e.message : String(e)
    }
    if (supported) {
      try {
        sessions = readers.listSessions(adapter).length
      } catch {
        sessions = -1
      }
      // note 在探测后重取：真实读取层的假 0 哨兵由 discover() 写回适配器 note，
      // 只用探测前的值会漏掉本轮发现（首轮渲染即见哨兵）；假货读取层两次调用同值，无感
      try {
        note = readers.adapterNote(adapter).note
      } catch {
        /* 保留探测前的 note，不让注释查询拖垮状态组装 */
      }
    }
    return {
      name,
      supported,
      sessions,
      enabled: !switches.disabledProviders.includes(name),
      note,
      exports: exportsCountOf(name, dir),
    }
  })

  // 死亡地图（0.4.1）：读侧活性跳过 + 持久事件尾 50 条；全空时整个 rejections 缺省
  const persistedAll = readLifecycleEvents(dir)
  const rejections = live.length > 0 || persistedAll.length > 0
    ? { live, persisted: persistedAll.slice(-LIFECYCLE_STATE_MAX), persistedTotal: persistedAll.length }
    : undefined
  // 换机同步状态（0.2.0）：未启用缺省；内部自带 try/catch，不拖垮 state 组装
  const syncStatus = syncStatusOf(dir)
  // 环境备份清单（只读目录枚举，listBackups 自带容错，不拖垮 state）
  const backups = listBackups(dir)
  // 0.26 triage 接线：当前有效置顶（listPins 自带懒清理 + fail-open 空集，不拖垮 state）
  let pins: string[] = []
  try {
    pins = listPins(dir)
  } catch { /* 绝对意外兜底：置顶视图缺省，不拦 state */ }
  // 0.26 doctor 接线：总线体检报告（scanStore 承诺不抛，此处兜绝对意外——字段缺省）
  let doctor: DoctorReport | undefined
  try {
    doctor = scanStore(dir)
  } catch { /* 体检自身异常：字段缺省（不伪装成零发现） */ }
  const snapshotEvidence = autoUpgradeSnapshotEvidence
  // 0.26 第三波接线：本机机器名（readMachineName 自带 fail-open + 损坏 warn 留痕；
  // 读失败回 hostname 兜底，绝不拖垮 state 组装）
  let machineName: string | undefined
  try {
    machineName = readMachineName(dir)
  } catch { /* readMachineName 契约不抛；兜绝对意外：字段缺省 */ }
  return {
    home: resolveHome(dir),
    pending,
    pendingSkipped,
    pendingDuplicates,
    inboxError,
    archivedCount: countArchived(dir),
    coverage,
    envelopeChars,
    providers,
    ...(rejections !== undefined ? { rejections } : {}),
    ...(syncStatus !== undefined ? { syncStatus } : {}),
    ...(backups.length > 0 || snapshotEvidence !== undefined
      ? {
          envBackup: {
            backups,
            ...(snapshotEvidence !== undefined ? { autoUpgradeSnapshot: snapshotEvidence } : {}),
          },
        }
      : {}),
    pins,
    ...(doctor !== undefined ? { doctor } : {}),
    ...(machineName !== undefined && machineName !== '' ? { machineName } : {}),
  }
}


/** archived 计数：按目录枚举+stat，不逐卡解析（此前为个数全量 parse 每张归档卡） */
function countArchived(dir?: string): number {
  const ad = archivedDir(dir)
  if (!existsSync(ad)) return 0
  let n = 0
  for (const f of readdirSync(ad)) {
    if (!f.endsWith('.md')) continue
    try {
      if (statSync(join(ad, f)).isFile()) n += 1
    } catch {
      /* 单项 stat 失败不计入 */
    }
  }
  return n
}

/** 清空 archived/：删除全部 .md 文件，返回清除份数（目录不存在=0，不视为错误）。
 * *.md 目录等异常项：跳过不删（应用层删不动，留给人工），单删失败也继续清其余——
 * 此前一个 *.md 目录就让整个清空操作抛 EISDIR，违背「绝不抛出」且永远 500。 */
export function clearArchived(dir?: string): number {
  const ad = archivedDir(dir)
  if (!existsSync(ad)) return 0
  let cleared = 0
  for (const f of readdirSync(ad)) {
    if (!f.endsWith('.md')) continue
    const p = join(ad, f)
    try {
      if (!statSync(p).isFile()) continue
      rmSync(p)
      cleared += 1
    } catch {
      /* 单项失败跳过：部分成功好过整单失败 */
    }
  }
  return cleared
}

/** 忽略一张待取件卡：卡与信封原样移入 archived/（保留审计轨迹，不计为取件消费）。
 *  pending 只能被消费、没有退出出口，共享总线用久必攒垃圾（2026-10-29 实测 6 张
 *  测试残留卡无处可去）——这是那条出口。找不到/已被取走回规范错误值。 */
export function dismissPending(id: string, dir?: string): { ok: boolean; moved?: number; error?: string } {
  const safe = String(id ?? '').trim().replace(/[\\/]/g, '')
  if (safe === '') return { ok: false, error: 'id 不能为空' }
  const home = resolveHome(dir)
  // archived/ 可能尚不存在（全新总线只有 pending/——push 不建 archived）：先补目录
  try {
    mkdirSync(join(home, 'archived'), { recursive: true })
  } catch (e) {
    return { ok: false, error: `archived 目录创建失败（${e instanceof Error ? e.message : String(e)}）` }
  }
  let moved = 0
  // 0.26 蒸馏侧车（<id>.hippo.jsonl）入列固定扩展名枚举：侧车随卡同搬，
  // 不改则 dismiss 后补吸收（handoff_absorb target='hippo-db'）拿不到快照
  for (const ext of ['.md', '.envelope.json', '.patch', '.patch.gz', '.hippo.jsonl'] as const) {
    const src = join(home, 'pending', safe + ext)
    if (!existsSync(src)) continue
    try {
      renameSync(src, join(home, 'archived', safe + ext))
      moved += 1
    } catch (e) {
      return { ok: false, error: `移动失败：${safe}${ext}（${e instanceof Error ? e.message : String(e)}）` }
    }
  }
  // gzip 分块（.patch.NNN.gz）带序号，固定扩展名枚举盖不住——按名单逐个搬
  try {
    const prefix = `${safe}.patch.`
    for (const f of readdirSync(join(home, 'pending'))) {
      if (!f.startsWith(prefix) || !f.endsWith('.gz')) continue
      if (!/^\d+\.gz$/.test(f.slice(prefix.length))) continue
      try {
        renameSync(join(home, 'pending', f), join(home, 'archived', f))
        moved += 1
      } catch (e) {
        return { ok: false, error: `移动失败：${f}（${e instanceof Error ? e.message : String(e)}）` }
      }
    }
  } catch { /* pending 目录读失败不追加失败面：固定扩展名已搬完 */ }
  if (moved === 0) return { ok: false, error: `pending 里没有这张卡：${safe}（可能已被取件）` }
  return { ok: true, moved }
}
