/**
 * 设置卡支撑层（host 半，可脱离 cordis 单测）：
 * - provider 开关：持久化在 <HANDOFF_HOME>/config.json（与 pending/archived 同屋，
 *   重启生效）；foreign_session_read 对停用家返回规范错误值「已停用」。
 * - buildState：设置卡 /dsh-takeover/state 的组装逻辑——收件箱概览 + 八家支持矩阵。
 * - clearArchived：清空 archived/ 全部 .md，返回清除份数。
 * 任何一步失败都回规范值 / 降级值，绝不抛出。
 * @module dsh-takeover/settings
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { archivedDir, listPendingReport, resolveHome } from '@agent-handoff/core'
import { FOREIGN_PROVIDERS, PROVIDER_TO_ADAPTER, type ForeignProvider, type ForeignReaders } from './foreign.ts'

// 停用规范错误值文案在 foreign.ts（disabledError），本模块只管开关存取与状态组装

/** 开关文件形态：只记停用名单（默认全开，未知条目载入时丢弃） */
export interface TakeoverSwitches {
  disabledProviders: string[]
}

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

/** 某家是否启用（默认启用；只认八家名单内的停用条目） */
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
}

/** 预览截断长度（服务端截，避免长卡片把 state 撑大） */
const PREVIEW_MAX = 240

function previewOf(c: { sections: { goal: string; done: string } }): string {
  const raw = c.sections.goal !== '' ? c.sections.goal : c.sections.done
  return raw.length > PREVIEW_MAX ? `${raw.slice(0, PREVIEW_MAX)}…` : raw
}

/** 支持矩阵行：本机是否支持 / 发现的会话数 / 启用开关 */
export interface ProviderRow {
  name: ForeignProvider
  supported: boolean
  /** 发现的会话数；探测失败为 -1（前端显示「—」） */
  sessions: number
  enabled: boolean
  note: string
}

export interface TakeoverState {
  /** 解析后的 HANDOFF_HOME 绝对路径（默认 ~/.handoff）：客户端 localStorage
   * 已见卡集合的键散列数据源（0.3.0 新卡徽标），同源连不同机器不串扰 */
  home: string
  pending: PendingRow[]
  /** 收件箱概览里被跳过的坏卡数（不再静默） */
  pendingSkipped: number
  /** 收件箱概览不可用时的降级说明（pending 位置异常等）；正常时缺省 */
  inboxError?: string
  archivedCount: number
  /** 待取件卡账本覆盖聚合（各卡 extras.coverage 求和）；无数据缺省。
   * 口径纪律：只聚合不强制——防「为覆盖率假标」污染账本 */
  coverage?: { statements: number; marked: number; unmarked: number }
  /** 待取件机器信封字符总量（*.envelope.json 文件字节数求和）；无信封缺省 */
  envelopeChars?: number
  providers: ProviderRow[]
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
  let inboxError: string | undefined
  // 收件箱聚合：待取件卡的账本覆盖求和 + 机器信封字符总量（0.4.0，显示位在 client 侧防御消费）。
  // 聚合失败只影响这两个字段，不拖垮整体 state（settings 头注释契约同款）。
  let coverage: TakeoverState['coverage']
  let envelopeChars: number | undefined
  try {
    const report = listPendingReport(dir)
    pending = report.cards.map((c) => ({
      id: c.id,
      agent: c.from.agent !== '' ? c.from.agent : '（未知来源）',
      title: c.from.title,
      project: c.project,
      pushedAt: c.pushed_at,
      preview: previewOf(c),
    }))
    pendingSkipped = report.skipped.length

    const pd = join(resolveHome(dir), 'pending')
    for (const c of report.cards) {
      const cov = (c.extras as { coverage?: { statements?: unknown; marked?: unknown; unmarked?: unknown } } | undefined)?.coverage
      if (cov && [cov.statements, cov.marked, cov.unmarked].every((x) => typeof x === 'number' && Number(x) >= 0)) {
        coverage ??= { statements: 0, marked: 0, unmarked: 0 }
        coverage.statements += Number(cov.statements)
        coverage.marked += Number(cov.marked)
        coverage.unmarked += Number(cov.unmarked)
      }
    }
    for (const f of readdirSync(pd)) {
      if (!f.endsWith('.envelope.json')) continue
      try {
        envelopeChars = (envelopeChars ?? 0) + statSync(join(pd, f)).size
      } catch {
        /* 单项 stat 失败不计入 */
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
    return { name, supported, sessions, enabled: !switches.disabledProviders.includes(name), note }
  })

  return { home: resolveHome(dir), pending, pendingSkipped, inboxError, archivedCount: countArchived(dir), coverage, envelopeChars, providers }
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
