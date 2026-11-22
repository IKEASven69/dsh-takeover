/**
 * 定向投递纯函数层（0.26 提前波）：machine.json 机器身份 sidecar + machine: 寻址
 * 约定 + 收件箱三桶分组。可脱离 DOM 单测（src/inbox-view.ts:2 同款分层先例），
 * 零 DOM / 零 npm 依赖；client/tools 的接线与 /sendto 技能注册次日波归集成面
 * （七集成文件零占用——本波唯一既有文件改动是 src/sync.ts SYNC_GITIGNORE 一行）。
 *
 * 需求出处与裁定披露（docs/需求调研-1119.md 实读）：:31 原文对「单卡定向投递到
 * 指定机器收件箱」整项裁「→ 0.27」，:73 的 0.27 清单原文为「单卡定向投递+在线
 * 握手（sev/interconnect）」——本波把其中「投卡本体 + machine: 寻址约定」提前
 * 执行，**在线握手与投递回执仍留 0.27**。因此约定寻址无握手：目标机未装插件/
 * 未开换机同步时卡到盘但无人认领（卡面 to 字段可查是诚实缺省）；文案只说
 * 「已投递到同步」，不得声明对方已收到。
 *
 * 三块能力：
 * - 机器身份 sidecar：读 <HANDOFF_HOME>/machine.json 拿本机名（pins.json 同款
 *   sidecar 先例，src/inboxtriage.ts:40-47）；缺文件/坏 JSON/形态不符/名字消毒
 *   不过一律 fail-open 回 os.hostname()（tools.ts:1067 信封 host.hostname 同源），
 *   损坏必 console.warn 留痕。机器身份**绝不入同步端点**（src/sync.ts
 *   SYNC_GITIGNORE 已排除——否则两台机同名互 claim）；两台机器同名时 mine 桶会
 *   误收他机点名卡，machine.json 手工改名可缓解（本波无自动去重，诚实缺省）。
 * - machine: 寻址约定：Card.to 本是自由串字段（@agent-handoff/core dist/
 *   index.d.mts:38 实读；handoff_push 已收该参数，src/tools.ts:998/:1494），
 *   machine:<机器名> 是纯约定不占协议位。parseAddress 消毒：非 machine: 前缀
 *   原样返回不碰（agent 名寻址照旧）；machine: 名 trim + 大小写规约（小写）+
 *   禁路径分隔符 + 空名拒（中文错，生产者侧诚实拒绝）。
 * - 三桶分组：bucketOf(row, selfName) 把待取件行分 mine（点名本机，第一眼看到）
 *   / others（点名别机，不冒领）/ any（缺省、any、agent 名或坏数据）三桶；
 *   坏数据归 any 不抛（防御式纪律）。/inbox 列表行已带 to（src/tools.ts:1141），
 *   InboxItem 可直接结构化喂入。
 * @module dsh-takeover/directed
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { resolveHome } from '@agent-handoff/core'

/** machine: 寻址前缀（Card.to 自由串里的约定寻址头，大小写敏感——Machine: 不是点名） */
export const MACHINE_SCHEME = 'machine:'

/** machine.json 文件名（置于 <HANDOFF_HOME>/ 下，与 pins.json/config.json 同屋） */
export const MACHINE_FILE = 'machine.json'

/** machine.json 路径：HANDOFF_HOME 优先，否则 ~/.handoff（resolveHome 同款解析） */
export function machinePath(dir?: string): string {
  return join(resolveHome(dir), MACHINE_FILE)
}

// ---------------------------------------------------------------------------
// 机器名规约（两侧共用：sidecar 读取、parseAddress 消毒、bucketOf 比较）
// ---------------------------------------------------------------------------

/**
 * 机器名规约化（不抛）：trim + 小写 + 禁路径分隔符。空名或含 / \\ 回空串
 * ——调用方各自决定 fail-open（读侧回 hostname）还是拒绝（写侧抛中文错）。
 */
function normalizeMachineName(input: unknown): string {
  const s = String(input ?? '').trim().toLowerCase()
  if (s === '' || /[\\/]/.test(s)) return ''
  return s
}

/**
 * 机器名消毒（严格，抛中文错）：生产者侧（saveMachineName / parseAddress）用
 * ——空名与含路径分隔符的名字当场拒绝，规约化后返回。错误信息不回显全名
 * （截 40 字，防长串刷屏）。
 */
function sanitizeMachineName(input: unknown): string {
  const s = String(input ?? '').trim()
  if (s === '') throw new Error('机器名不能为空：to=machine:<机器名>，机器名必填')
  if (/[\\/]/.test(s)) throw new Error(`机器名不得含路径分隔符（/ 或 \\）：${s.slice(0, 40)}`)
  return s.toLowerCase()
}

// ---------------------------------------------------------------------------
// ① 机器身份 sidecar：machine.json（本机事实，不入同步端点）
// ---------------------------------------------------------------------------

/** hostname 兜底的规约化（hostname() 理论上不空，防御式再兜一层 localhost） */
function machineFallback(): string {
  try {
    const h = normalizeMachineName(hostname())
    return h !== '' ? h : 'localhost'
  } catch {
    return 'localhost'
  }
}

/**
 * 读本机机器名：<HANDOFF_HOME>/machine.json 的 { name } 字段。缺文件/坏 JSON/
 * 形态不符/name 消毒不过 → fail-open 回 os.hostname()（机器身份是本机便利面，
 * 坏了绝不拦主流程——pins.json 同款纪律），损坏必 console.warn 留痕。
 * 返回规约化（小写）名字；bucketOf 比较与 machine: 寻址都用同一规约，两处
 * 不会各说各话。
 */
export function readMachineName(dir?: string): string {
  const path = machinePath(dir)
  if (!existsSync(path)) return machineFallback()
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[dsh-takeover] machine.json 形态不符（应为 {"name":"..."}），按本机 hostname 处理')
      return machineFallback()
    }
    const rawName: unknown = (parsed as { name?: unknown }).name
    if (typeof rawName !== 'string') {
      console.warn('[dsh-takeover] machine.json 的 name 缺席或非字符串，按本机 hostname 处理')
      return machineFallback()
    }
    const name = normalizeMachineName(rawName)
    if (name === '') {
      console.warn('[dsh-takeover] machine.json 的 name 为空或含路径分隔符，按本机 hostname 处理')
      return machineFallback()
    }
    return name
  } catch (e) {
    console.warn(`[dsh-takeover] machine.json 损坏，按本机 hostname 处理：${e instanceof Error ? e.message : String(e)}`)
    return machineFallback()
  }
}

/**
 * 写本机机器名（tmp+rename 原子替换，saveSyncConfig 同模板——进程中断不留
 * 半截文件）。名字消毒与 parseAddress 同规：空名/含路径分隔符抛中文错，
 * 调用方给诚实两态。两台机器必须用不同名字——同名会让 mine 桶互 claim
 * （本波无自动去重，靠机器间约定）。
 */
export function saveMachineName(name: string, dir?: string): void {
  const clean = sanitizeMachineName(name)
  const target = machinePath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ name: clean }, null, 2) + '\n', 'utf-8')
    renameSync(tmp, target)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 尽力清临时件 */ }
    throw e instanceof Error ? e : new Error(String(e))
  }
}

// ---------------------------------------------------------------------------
// ② machine: 寻址约定（Card.to 自由串上的消毒，协议位零改动）
// ---------------------------------------------------------------------------

/**
 * 解析 to 地址：machine:<机器名> 约定寻址。非 machine: 前缀**原样返回不碰**
 * （含首尾空白——agent 名寻址与既有 to 值一字不动）；machine: 名 trim + 小写
 * 规约 + 禁路径分隔符 + 空名拒（中文错）。返回规约化后的完整地址
 * （machine:<小写机器名>）。生产者侧用（写卡前规约）；前缀带首尾空白的
 * 输入不视作点名（原样返回），桶分组侧的防御式识别见 bucketOf。
 */
export function parseAddress(to: string): string {
  const raw = String(to ?? '')
  if (!raw.startsWith(MACHINE_SCHEME)) return raw
  return MACHINE_SCHEME + sanitizeMachineName(raw.slice(MACHINE_SCHEME.length))
}

/** 由裸机器名组 machine: 地址（同一消毒；saveMachineName/parseAddress 共规） */
export function toMachineAddress(name: string): string {
  return MACHINE_SCHEME + sanitizeMachineName(name)
}

// ---------------------------------------------------------------------------
// ③ 三桶分组：mine（点名本机）/ others（点名别机）/ any（缺省或坏数据）
// ---------------------------------------------------------------------------

/** 三桶：mine=点名本机（第一眼看到）；others=点名别机（不冒领）；any=其余 */
export type AddressBucket = 'mine' | 'others' | 'any'

/**
 * 待取件行的最小形态：只依赖 to 字段。PendingRow（src/settings.ts:121）当前
 * 不带 to（集成面次日波补），InboxItem（src/tools.ts:1117）已带——两者都
 * 结构化兼容；字段缺席/坏形态按 any 处理。
 */
export interface AddressedRow {
  /** Card.to 自由串（machine:<机器名> 点名 / agent 名 / any / 缺省） */
  to?: unknown
  [k: string]: unknown
}

/**
 * 三桶分组（防御式，绝不抛）：to 非 string / 非 machine: 前缀 / machine: 名
 * 消毒不过（空名、含路径分隔符）一律归 any——坏数据不藏也不冒领，落回通用
 * 桶人眼可查。点名比较大小写不敏感（两侧同规约化）；本机名缺席（空串）时
 * 点名卡归 others（绝不误收）。前缀识别前先 trim（手写 to 带首尾空白也能
 * 正确分组，与 parseAddress 的严格「原样」纪律各司其职）。
 */
export function bucketOf(row: AddressedRow | null | undefined, selfName: string): AddressBucket {
  const to = row?.to
  if (typeof to !== 'string') return 'any'
  const trimmed = to.trim()
  if (!trimmed.startsWith(MACHINE_SCHEME)) return 'any'
  const name = normalizeMachineName(trimmed.slice(MACHINE_SCHEME.length))
  if (name === '') return 'any'
  const self = normalizeMachineName(selfName)
  return name === self ? 'mine' : 'others'
}
