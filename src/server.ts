/**
 * host 侧 /dsh-takeover/ JSON API（webServer 路由桥）：
 *   GET  /dsh-takeover/state           设置卡状态（收件箱概览 + 支持矩阵；可选 ?sessionId=
 *                                      附当前会话上下文预警 contextHealth——0.26 集成接线，
 *                                      无参/会话缺席时字段缺省，无参请求响应零变化；
 *                                      可选 ?ledger=1 附接力总账 state.ledger——0.26 第三波
 *                                      接线（aggregateLedger 三源翻账），无参请求响应零变化）
 *   GET  /dsh-takeover/history         卡链历史 ?project=&cwd=（archived/ 已归档卡回查，
 *                                      与 handoff_inbox action=history 同一读取层）
 *   GET  /dsh-takeover/sessions        外部会话浏览列表 ?provider=&limit=（轻量发现层，不读内容；
 *                                      响应附 runningIds——「被本机接管且接管会话仍存活」的
 *                                      正向运行证据集，0.26 第三波接线；服务缺席=空集不编）
 *   GET  /dsh-takeover/session-preview 单会话结构化预览 ?provider=&reference=（摘要+骨架素材，不吐原文轮次）
 *   GET  /dsh-takeover/preflight       接管预检 ?provider=&reference=（foreign_session_read show
 *                                      之后 assessForeignTakeover 三档判定卡——面板「接管」
 *                                      按钮的前置闸，0.26 第三波接线；预检绝不拦真实接管：
 *                                      端点异常由客户端 fail-open 放行）
 *   POST /dsh-takeover/takeover        一键接管/取件 {mode, provider?, reference?}——宿主会话控制器建新会话并投递指令
 *   POST /dsh-takeover/provider        切 provider 开关 {provider, enabled}
 *   POST /dsh-takeover/clear-archived  清空 archived/
 *   POST /dsh-takeover/dismiss-pending 忽略一张待取件卡 {id}——原样移入 archived/（审计轨迹保留，不计消费）
 *   POST /dsh-takeover/lifeboat        救生艇：{sessionId}——不经模型把当前会话事件流确定性抢出成卡
 *                                      （pushHandoff 直调，空壳闸放行；同步启用时自动 syncNow）
 * POST 一律过同源守卫；响应 { ok, ... } 规范值，失败不抛异常。
 * @module dsh-takeover/server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context.webServer merge（宿主由 web bundle 提供，不打进产物）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defaultForeignReaders, foreignResolveOne, foreignSessionRead, foreignSessionPreview, foreignSessionsList, PROVIDER_TO_ADAPTER, type ForeignProvider } from './foreign.ts'
import { depositCommand, outboundCommand, OUTBOUND_LABELS, takeoverCommand, type Lang, type SessionRowLike } from './browser-view.ts'
import { relayProvenancePath, writeRelayProvenance } from './relay-records.ts'
import { pushMemoryCard, scanMemorySources } from './memory.ts'
import { pushHandoff, inboxHistory } from './tools.ts'
import { recordLifecycleEvent } from './lifecycle.ts'
import { probeContexthealth, type ContexthealthReport } from './contexthealth.ts'
import { restoreFromArchived, searchInbox, setPin, unsetPin, type InboxSearchResult } from './inboxtriage.ts'
import { buildState, clearArchived, dismissPending, isProviderEnabled, setProviderEnabled } from './settings.ts'
import { loadSyncConfig, syncNow, syncPull, syncPush, syncSetup, type SyncOutcome } from './sync.ts'
import { applyRestore, createBackup, dryRunRestore, listBackups, rollbackRestore } from './envbackup.ts'
import { aggregateLedger, type RelayLedger } from './relayledger.ts'
import { assessForeignTakeover, type PreflightCard } from './preflight.ts'

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

// ---------------------------------------------------------------------------
// 列表标题增强（文件系会话缺人类标题时的头窥取）：读文件头 64KB 找首条用户
// 消息文本。尽力而为——任何一步失败回空串按原行展示，列表页永不因此变慢报错。
// ---------------------------------------------------------------------------

/** 判「没有人类标题」：空串 / 标题就是 id（或其文件名 stem）/ UUID 形态 */
export function looksUntitled(r: SessionRowLike): boolean {
  if (r.kind !== 'file') return false
  const base = r.id.split(/[\\/]/).pop() ?? ''
  const stem = base.replace(/\.jsonl$/i, '')
  return r.title === '' || r.title === r.id || r.title === base || r.title === stem || /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(r.title)
}

/** 头窥标题：首条含 "type":"user" 的行里抠 text / content 字符串值（JSON 转义最简还原） */
export function sniffTitle(id: string): string {
  try {
    if (!id.toLowerCase().endsWith('.jsonl') || !existsSync(id)) return ''
    const fd = openSync(id, 'r')
    try {
      const buf = Buffer.alloc(65536)
      const n = readSync(fd, buf, 0, 65536, 0)
      for (const line of buf.toString('utf-8', 0, n).split('\n')) {
        if (!line.includes('"type":"user"')) continue
        const raw = /"text":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1]
          ?? /"content":"((?:[^"\\]|\\.)*)"/.exec(line)?.[1]
        if (raw === undefined || raw.trim() === '') continue
        const text = raw
          .replace(/\\n/g, ' ')
          .replace(/\\"/g, '"')
          .replace(/\\u[0-9a-fA-F]{4}/g, '')
          .replace(/\\t/g, ' ')
          .trim()
        if (text !== '') return text.slice(0, 80)
      }
    } finally { closeSync(fd) }
  } catch { /* 尽力而为 */ }
  return ''
}

/** Host 头是否指向本机回环。面板只服务本机：DNS rebinding 下 Host 是攻击者域，
 * 与 Origin 同域比对无法识别——直接要求 Host 是回环（127.0.0.1/[::1]/localhost）。 */
function loopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  const hostname = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0] ?? h
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost'
}

/** TCP 对端是否本机回环。请求头（Host/Origin/Sec-Fetch-Site）对非浏览器客户端全部可伪造，
 * 唯一伪造不了的是连接本身：宿主按一等配置可能绑 0.0.0.0（LAN 可达），此时只看头部等于没防——
 * 连接源地址不是回环一律 403，与头部无关。导出仅为测试。 */
export function isLoopbackRemote(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
}

/** provider 开关写队列：读-改-写 config.json 的串行化——两个并发 POST 同基线改写会丢失更新
 * （同时停 A/B 只停了 B），链式串行消除同进程竞态。 */
let providerWriteQueue: Promise<unknown> = Promise.resolve()

// ---------------------------------------------------------------------------
// 运行证据（0.26 第三波接线，需求缺口「2 千会话里找运行中的」hkkz9522#61 + context#266）：
// 外部家会话文件不携带「正在运行」标志，原生侧运行状态**不可知**——能拿到的唯一
// 正向证据是「该外部会话被本机接管过，且承接它的宿主会话此刻还活着」（宿主
// sessions 存活面 × relay/<sessionId>.json 溯源）。这里只产出正向证据集：
// 不在场 = 无证据 = 不作任何断言，UI 一律「状态不可知」，绝不编否定也绝不把
// 「接管会话存活」夸成「正在运行」（面板口径行如实写判定依据）。
// ---------------------------------------------------------------------------

/** 存活会话枚举封顶（防御式：宿主会话库异常膨胀时不放大读） */
export const RUNNING_LIVE_MAX = 500

/**
 * 运行证据集（纯函数，可脱离路由单测）：存活宿主会话对象数组 × 溯源读取器 →
 * 被本机接管且接管会话仍存活的外部会话 id 集（relay sourceId，字典序去重）。
 * 会话对象缺 id / 溯源缺席（旧宿主、接管前落盘失败）→ 该项无证据，跳过不编。
 */
export function runningSourceIdsOf(
  liveSessions: readonly unknown[],
  sourceIdOf: (sessionId: string) => string,
): string[] {
  const out = new Set<string>()
  for (const s of liveSessions.slice(0, RUNNING_LIVE_MAX)) {
    const id = s !== null && typeof s === 'object' ? (s as { id?: unknown }).id : undefined
    if (typeof id !== 'string' || id === '') continue
    const src = sourceIdOf(id)
    if (src !== '') out.add(src)
  }
  return [...out].sort()
}

/** 溯源读取（尽力而为，IO 壳）：relay/<sessionId>.json 的 sourceId；
 * 缺文件 / 坏 JSON / 形态不符 / sourceId 非串 → 空串（无证据），绝不抛。 */
export function relaySourceIdOf(sessionId: string): string {
  try {
    const p = relayProvenancePath(sessionId)
    if (existsSync(p) !== true) return ''
    const o: unknown = JSON.parse(readFileSync(p, 'utf-8'))
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return ''
    const v = (o as Record<string, unknown>)['sourceId']
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** 列表响应附运行证据（纯函数，可单测）：ok:true 的列表响应原样带上 runningIds
 * （供数函数注入，路由传 runningIdsOf）；ok:false 失败值不附（没有列表就没有证据位）。
 * 供数意外（宿主服务抛错等）→ 字段缺省不拦列表——证据是增益，不是列表的前置。 */
export function attachRunningIds<T>(res: T, runningIdsOf: () => string[]): T {
  try {
    if (res !== null && typeof res === 'object' && (res as { ok?: unknown }).ok === true) {
      ;(res as { runningIds?: string[] }).runningIds = runningIdsOf()
    }
  } catch { /* 证据计算意外：字段缺省 */ }
  return res
}

/**
 * env-backup 写队列入队（0.26 snapshot 接线）：启动旁路的升级保险快照触发器与面板
 * 手动备份/还原共用同一条串行队列（createBackup/还原都是重 I/O，不并发互踩）。
 * fn 自身的异常被吞进队列链（队列健康优先，不毒化后续写），异常经返回的 promise 透传
 * 给调用方（index.ts 兜 fail-open 降级）。
 */
export function enqueueEnvBackupWrite<T>(fn: () => T): Promise<T> {
  const queued = providerWriteQueue.then(fn) as Promise<T>
  providerWriteQueue = queued.catch(() => { /* 队列健康优先 */ })
  return queued
}

/** 同源守卫：带 Origin 的请求必须与 Host 一致，且 Host 必须回环（防跨站 POST 与 rebinding）。
 * 不再裸比 `new URL(origin).host === Host`——Host 头客户端完全可控，等价于没防。 */
function sameOrigin(request: { headers: { origin?: string; host?: string } }): boolean {
  const { origin, host } = request.headers
  if (origin === undefined || host === undefined) return false
  if (!loopbackHost(host)) return false
  try {
    const u = new URL(origin)
    return u.host === host.toLowerCase() && loopbackHost(u.host)
  } catch {
    return false
  }
}

/** 读守卫（GET state）：Host 回环之外，浏览器跨站 no-cors 请求带 Sec-Fetch-Site: cross-site
 * （forbidden header name，页面脚本改不了），非浏览器客户端（curl/CLI）不带该头放行——
 * 监听面在本机回环，Host 已验证。30s 轮询的面板自身 fetch 是 same-origin，不受影响。 */
function readGuard(request: { headers: { host?: string; 'sec-fetch-site'?: string } }): boolean {
  const host = request.headers.host
  if (host === undefined || !loopbackHost(host)) return false
  const site = request.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}

/** 读取 JSON 请求体（上限 4 KiB，超限拒绝）。 */
function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 4096) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim()
        const parsed: unknown = raw === '' ? {} : JSON.parse(raw)
        // 极端形态防御：null/数组/标量一律归 {}——下游按字段取值，
        // 不让 `body['mode']` 这类访问把 unhandled rejection 打进宿主事件循环
        resolve(
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        )
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}

async function stateBody(): Promise<ReturnType<typeof buildState>> {
  return buildState(await defaultForeignReaders())
}

/**
 * state + 上下文预警展开（0.26 集成接线 §5.1①，裁定取「路由层展开」而非 buildState
 * 新入参——buildState 保持纯读盘，全部既有调用方零改动）：会话对象在场时把
 * probeContexthealth 结果展开到 state.contextHealth。0.26 probe 接线：第二参传宿主
 * tokenMeter 服务（官方代价投影直读；缺席即投影「不可达」诚实两态，探针绝不自算）。
 * 探针自身承诺绝不抛，此处仍兜绝对意外——探测异常时字段缺省，绝不拖垮 state。
 */
function withContextHealth<T extends ReturnType<typeof buildState>>(state: T, session: unknown, tokenMeter: unknown): T {
  try {
    ;(state as { contextHealth?: ContexthealthReport }).contextHealth = probeContexthealth(session, tokenMeter)
  } catch { /* 探测异常：字段缺省 */ }
  return state
}

/**
 * state + 收件箱检索展开（0.26 triage 接线）：GET state 带可选 q 参数时把
 * searchInbox 结果展开到 state.inboxQuery（includeBody=1 时逐卡读正文）。
 * 检索层承诺绝不抛出（枚举失败回规范 error 值），此处仍兜绝对意外——异常字段缺省。
 * 无 q 参数不走本函数（无参请求响应零变化钉不受影响）。
 */
function withInboxQuery<T extends ReturnType<typeof buildState>>(state: T, q: string, includeBody: boolean): T {
  try {
    ;(state as { inboxQuery?: InboxSearchResult }).inboxQuery = searchInbox(q, { includeBody })
  } catch { /* 检索异常：字段缺省 */ }
  return state
}

/**
 * state + 接力总账展开（0.26 第三波接线）：GET state 带 ?ledger=1 时把
 * aggregateLedger 三源翻账展开到 state.ledger（面板「接力总账」懒加载块的数据源——
 * 30s 轮询的主请求不背这笔账，展开式扩展同 inboxQuery：无参请求响应零变化）。
 * 聚合层承诺绝不抛（底层读取器全 fail-open，聚合面再兜绝对意外），此处仍兜——
 * 异常字段缺省，不编数字。
 */
function withLedger<T extends ReturnType<typeof buildState>>(state: T): T {
  try {
    ;(state as { ledger?: RelayLedger }).ledger = aggregateLedger()
  } catch { /* 聚合异常：字段缺省 */ }
  return state
}

// ---------------------------------------------------------------------------
// 一键接管：宿主会话控制器的最小面 + 投递核心。
// 访问形态与官方包同款（dsh-schedule 直接 ctx.sessionController；cordis 对
// 未挂载服务的属性访问会 throw——防御式取用，缺席即规范降级）。
// ---------------------------------------------------------------------------

/** 会话控制器最小面（对齐 dsh-api-session-controller 0.2.0-rc.2 的 Remote 形状；多退少补） */
export interface SessionControllerLike {
  create(request?: { cwd?: string; workspaceId?: string }): Promise<{ sessionId: string }>
  rename(request: { sessionId: string; title: string }): Promise<unknown>
  prompt(request: {
    requestId: string
    sessionId: string
    mode: 'queue' | 'steer'
    content: Array<{ type: 'text'; text: string }>
    clientTimeZone?: string
  }, signal?: AbortSignal): Promise<{ accepted: true }>
}

/** 宿主存活会话服务最小面（SessionStore 结构子集，多退少补）：
 * get 按 id 查存活会话；list 枚举全部存活会话（0.26 第三波接线运行证据用——
 * 旧宿主可能没有，缺席即枚举面降级，get 面不受影响）。 */
export interface LiveSessionsLike {
  get?: (id: string) => unknown
  list?: () => unknown
}

/** 防御式取宿主会话控制器：服务挂在根 ctx（本插件 ctx 未 inject 该服务名，
 * 直接取会 throw「cannot get property without inject」——root 层即可达）。
 * 缺席/形态不符回 undefined（ 规范降级），绝不抛出。 */
export function sessionControllerOf(ctx: unknown): SessionControllerLike | undefined {
  const layers: unknown[] = []
  try { layers.push((ctx as { root?: unknown }).root) } catch { /* root 不可达就试本层 */ }
  layers.push(ctx)
  for (const layer of layers) {
    if (layer === null || typeof layer !== 'object') continue
    try {
      const sc: unknown = (layer as { sessionController?: unknown }).sessionController
      if (sc === null || typeof sc !== 'object') continue
      const o = sc as Record<string, unknown>
      if (typeof o['create'] !== 'function' || typeof o['rename'] !== 'function' || typeof o['prompt'] !== 'function') {
        continue
      }
      return sc as SessionControllerLike
    } catch { /* 该层未注入（without inject），试下一层 */ }
  }
  return undefined
}

export type TakeoverMode = 'take' | 'take_deposit' | 'inbox'

export type TakeoverOutcome =
  | { ok: true; sessionId: string; title: string }
  | { ok: false; error: string; /** create 成功但后续失败的孤儿会话 id（不隐瞒，可循此清理） */ sessionId?: string }

const TAKEOVER_TITLE_MAX = 48
const TAKEOVER_MODES: readonly TakeoverMode[] = ['take', 'take_deposit', 'inbox']

/**
 * 投递核心（可脱离 cordis 单测）：建新会话 → 改可找标题 → queue 模式投递指令。
 * 指令与浏览器复制的载荷同一出处（browser-view 的 takeoverCommand/depositCommand），
 * 「点按钮」和「手动粘贴」永远等价；mode=inbox 投递裸 /inbox（最小输入纪律），
 * 带reference 时升级为定向取件（/inbox + 指明编号——行级按钮必须取那一张）。
 * 任何一步失败回规范错误值；已建会话的 id 随错误带出（不隐瞒孤儿会话）。
 */
export async function admitTakeover(
  controller: SessionControllerLike,
  args: { mode: TakeoverMode; provider?: string; reference?: string; lang?: 'zh' | 'en' },
  deps?: {
    resolve?: typeof foreignResolveOne
    random?: () => string
    /** 停用闸环境（与读路由同口径）：停用家一键接管同样拒绝 */
    env?: Parameters<typeof foreignResolveOne>[2]
    /** 会话查找（可选）：在场时投递成功后向会话日志追加接力溯源记录
     * （依托宿主 ≥0.2.1-alpha.2 的实验性 plugin record API，缺席即跳过） */
    sessions?: { get?: (id: string) => unknown; flush?: (session: unknown) => unknown }
  },
): Promise<TakeoverOutcome> {
  if (!TAKEOVER_MODES.includes(args.mode)) {
    return { ok: false, error: `未知 mode：${String(args.mode)}（支持 ${TAKEOVER_MODES.join(' / ')}）` }
  }
  const lang: 'zh' | 'en' = args.lang === 'en' ? 'en' : 'zh'
  let instruction: string
  let title: string
  // 接力溯源数据（resolve 块内填充；inbox 模式只带卡 id）
  let sourceAgent = ''
  let sourceId = ''
  if (args.mode === 'inbox') {
    const ref = String(args.reference ?? '').trim()
    instruction = ref === '' ? '/inbox' : `/inbox\n取编号 ${ref} 这张卡，消费即取。`
    title = lang === 'en' ? 'Inbox pickup' : '收件箱取件'
  } else {
    // provider 与解析层同一归一化：传 "ZCode" 解析得过、指令里却会是
    // 无法识别的 /resume-ZCode——先归一化再进指令
    const provider = String(args.provider ?? '').trim().toLowerCase()
    const resolve = deps?.resolve ?? foreignResolveOne
    const resolved = await resolve({ provider, reference: args.reference }, undefined, deps?.env)
    if (!resolved.ok) return resolved
    sourceAgent = provider
    sourceId = resolved.ref.id
    instruction = args.mode === 'take_deposit'
      ? depositCommand(provider, resolved.ref.id, lang)
      : takeoverCommand(provider, resolved.ref.id)
    // 同一会话可被多次接管——标题带分/级时间戳避免树里同名堆积（P1-3）。
    // 手工拼 MM-DD HH:mm：toLocaleString 随 locale 产出 / 或 - 分隔，测试与展示都要确定性
    const d = new Date()
    const p2 = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    title = `接管：${resolved.ref.title || resolved.ref.id}（${stamp}）`.slice(0, TAKEOVER_TITLE_MAX)
  }
  let sessionId = ''
  try {
    const created = await controller.create({})
    sessionId = (created as { sessionId?: unknown } | undefined)?.sessionId as string | undefined ?? ''
    if (sessionId === '') {
      return { ok: false, error: '会话创建结果缺少 sessionId（宿主会话控制器形态变化）' }
    }
    const random = deps?.random ?? randomUUID
    await controller.rename({ sessionId, title })
    // prompt 的 @Remote 签名是 (request, signal)——本地直调也要给不中止的 signal
    await controller.prompt({
      requestId: random(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: instruction }],
    }, new AbortController().signal)
    // 接力溯源双层持久化：保底层写 <HANDOFF_HOME>/relay/<sessionId>.json（本插件
    // 完全可控，跨机随 HANDOFF_HOME 同步）；增益层尽力追加宿主实验性 plugin record
    // （ignorable 事件不进模型上下文，fork/resume 随行；rc.2 无此 API 静默跳过）。
    // 两层任何失败都不影响投递结果。
    const kind = args.mode === 'inbox' ? 'pickup' : args.mode === 'take_deposit' ? 'take_deposit' : 'takeover'
    const provenance = {
      provider: sourceAgent,
      sourceId,
      cardId: args.mode === 'inbox' ? args.reference ?? '' : '',
      title,
      at: new Date().toISOString(),
    }
    writeRelayProvenance(sessionId, provenance)
    // 增益层后台追加：非阻塞——投递响应立即返回，后台等会话挂载进 sessions
    // 服务（agent 循环启动即挂载）后写入 plugin record 并 flush。全程尽力而为。
    void (async () => {
      let session: unknown
      for (let i = 0; i < 24 && session === undefined; i++) {
        session = deps?.sessions?.get?.(sessionId)
        if (session === undefined) await new Promise((r) => setTimeout(r, 5000))
      }
      if (session === undefined) return
      const { appendRelayRecord } = await import('./relay-records.ts')
      await appendRelayRecord(session, kind, provenance)
      await deps?.sessions?.flush?.(session)
    })()
    return { ok: true, sessionId, title }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // create 已成功的失败（rename/prompt 阶段）：孤儿会话 id 随错误带出，不隐瞒
    return sessionId === ''
      ? { ok: false, error: msg }
      : { ok: false, error: `${msg}（已建会话 ${sessionId}「${title}」，可在会话树删除）`, sessionId }
  }
}

/**
 * 注册 /dsh-takeover/ 前缀路由。webServer 是宿主可选服务（CLI 形态没有），
 * 走 ctx.inject 缺席即跳过，不影响工具与 skill 注册面。
 * opts.takeoverEnv：provider 停用闸（全部路由共用，缺省读真实设置开关；
 * 测试注入假闸——isProviderEnabled 直读真实 HOME，测试不碰）。
 */
export function registerTakeoverRoutes(
  ctx: Context,
  opts?: { takeoverEnv?: { isEnabled: (p: ForeignProvider) => boolean } },
): void {
  /** 会话查找（防御式）：增益层的接力溯源追加 + 运行证据枚举用。走 root 上的 sessions
   * 服务（每次属性访问独立 try——注入纪律代理会抛），缺席即整体跳过；get 在手即返回
   * （list 可选——旧宿主没有时运行证据枚举面降级，查找面不受影响）。 */
  const rootSessionsOf = (): LiveSessionsLike | undefined => {
    const read = (get: () => unknown): unknown => { try { return get() } catch { return undefined } }
    const rootObj = read(() => (ctx as unknown as { root?: unknown }).root) as unknown
    const rootSessions = read(() => (rootObj as { sessions?: unknown })?.sessions)
    const ctxSessions = read(() => (ctx as unknown as { sessions?: unknown })?.sessions)
    const cand = (rootSessions ?? ctxSessions) as { get?: unknown; list?: unknown } | undefined
    if (cand && typeof cand.get === 'function') {
      return {
        get: cand.get as (id: string) => unknown,
        ...(typeof cand.list === 'function' ? { list: cand.list as () => unknown } : {}),
      }
    }
    return undefined
  }
  /** 运行证据集（0.26 第三波接线）：宿主存活会话 × relay 溯源 → 外部会话 id 集。
   * 服务缺席 / list 缺席（旧宿主）/ 枚举抛错 → 空集（诚实零，不编）。 */
  const runningIdsOf = (): string[] => {
    const sessions = rootSessionsOf()
    let live: unknown[] = []
    try {
      const listed = sessions?.list?.()
      if (Array.isArray(listed)) live = listed
    } catch { /* 注入纪律代理可能抛：按无枚举面 */ }
    return runningSourceIdsOf(live, relaySourceIdOf)
  }
  const env = opts?.takeoverEnv ?? { isEnabled: (p: ForeignProvider) => isProviderEnabled(p) }
  /** 会话按 id 查找（0.26 集成接线 §5.1①）：与救生艇同款 rootSessionsOf().get 先例，
   * get 自身抛错（注入纪律代理）也按会话缺席处理；空 id 直接缺席。 */
  const sessionById = (sessionId: string): unknown => {
    const id = sessionId.trim()
    if (id === '') return undefined
    try {
      return rootSessionsOf()?.get?.(id) ?? undefined
    } catch {
      return undefined
    }
  }
  /** 宿主 tokenMeter 服务的防御式取用（0.26 probe 接线）：@deepseek-ai/dsh-token-meter
   * 由 dsh-base bundle 挂载在根层（ctx.root.tokenMeter）；cordis 对未挂载服务的属性访问
   * 会抛（精简 profile 可能缺席）——root 层优先、本层兜底，两层都不可达回 undefined
   * （探针侧投影走「不可达，未接入」诚实两态，绝不自算）。 */
  const tokenMeterOf = (): unknown => {
    const layers: Array<() => unknown> = [
      () => (ctx as unknown as { root?: unknown }).root,
      () => ctx,
    ]
    for (const read of layers) {
      try {
        const layer = read()
        if (layer === null || typeof layer !== 'object') continue
        const tm: unknown = (layer as { tokenMeter?: unknown }).tokenMeter
        if (tm !== null && tm !== undefined) return tm
      } catch { /* 该层未挂载（纪律代理抛错）：试下一层 */ }
    }
    return undefined
  }
  // S8 短窗去重：同 (mode|provider|reference) 5 秒内的重复点击复用同一次投递——
  // 双标签页/快速重试不再产生 N 个重复会话；admitTakeover 永不 reject，缓存安全
  const takeoverMemo = new Map<string, { at: number; run: Promise<TakeoverOutcome> }>()
  ctx.inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({
      kind: 'prefix',
      // 注意不能带尾斜杠：匹配规则是 pathname === prefix 或 startsWith(prefix + '/')，
      // '/dsh-takeover/' 会要求 '/dsh-takeover//' 才命中（先例：前缀不带尾斜杠）。
      path: '/dsh-takeover',
      handler: (request, response) => {
        // 连接级回环闸先行：源地址非本机一律 403（0.0.0.0 绑定下 LAN 请求在此被拒，
        // 头部守卫只对已进门的回环连接继续做浏览器面防护）
        if (!isLoopbackRemote(request.socket.remoteAddress)) {
          sendJson(response, 403, { error: '面板仅服务本机回环连接' })
          return
        }
        const sub = (request.url ?? '/').replace(/^\/dsh-takeover\/?/, '').split('?')[0] ?? ''

        if (sub === 'state') {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          // state 一直全裸（返回 HANDOFF_HOME 绝对路径与卡片预览，且每请求全量扫盘）——补读守卫
          if (!readGuard(request)) {
            sendJson(response, 403, { error: '仅接受本机同源读取' })
            return
          }
          // 0.26 集成接线 §5.1①：可选 ?sessionId=（救生艇同款会话查找）——有参有会话时
          // 附 contextHealth（主挂点：客户端 30s 轮询呈现的预警真相走这条链）；无参/
          // 无会话/探测异常 → 字段缺省，无参请求响应零变化（向后兼容扩展）。
          // 0.26 triage 接线：可选 ?q=（&includeBody=1 读正文）——带检索词时附 inboxQuery。
          // 0.26 第三波接线：可选 ?ledger=1——带参时附接力总账 state.ledger（aggregateLedger
          // 三源翻账，面板「接力总账」懒加载块按需拉，30s 轮询主请求不背这笔账）。
          const q = new URL(request.url ?? '/', 'http://localhost').searchParams
          const session = sessionById(q.get('sessionId') ?? '')
          const searchQ = q.get('q') ?? ''
          const includeBody = q.get('includeBody') === '1'
          const wantLedger = q.get('ledger') === '1'
          void stateBody().then(
            (state) => {
              let out = session !== undefined && session !== null ? withContextHealth(state, session, tokenMeterOf()) : state
              if (searchQ.trim() !== '') out = withInboxQuery(out, searchQ, includeBody)
              if (wantLedger) out = withLedger(out)
              sendJson(response, 200, out)
            },
            (error: unknown) => { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'history') {
          // 卡链历史（工作台收件箱「历史」视图的数据源）：handoff_inbox action=history
          // 同一读取层（archived/ 已归档卡按 project/cwd 过滤回查）。只读面，与 state
          // 同一读守卫；查询参数可选，全缺省 = 全量回查
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          if (!readGuard(request)) {
            sendJson(response, 403, { error: '仅接受本机同源读取' })
            return
          }
          const q = new URL(request.url ?? '/', 'http://localhost').searchParams
          const body = inboxHistory({ project: q.get('project') ?? '', cwd: q.get('cwd') ?? '' })
          sendJson(response, 200, body)
          return
        }

        if (sub === 'sessions' || sub === 'session-preview') {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          // 与 state 同一读守卫：会话元数据/摘要与卡片预览同级敏感
          if (!readGuard(request)) {
            sendJson(response, 403, { error: '仅接受本机同源读取' })
            return
          }
          const q = new URL(request.url ?? '/', 'http://localhost').searchParams
          // 规范值（含 ok:false）一律 200——停用/未知名是业务结果不是 HTTP 事故；意外异常才 500
          const body: Promise<unknown> = sub === 'sessions'
            ? (() => {
                const limitRaw = Number(q.get('limit') ?? '')
                return foreignSessionsList(
                  { provider: q.get('provider') ?? '', limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined },
                  undefined,
                  env,
                ).then((res) => {
                  // 标题增强：缺人类标题的文件系会话头窥首条用户消息（同步、每行 ≤64KB、失败原样）
                  if (res.ok) {
                    for (const r of res.sessions) {
                      if (!looksUntitled(r)) continue
                      const t = sniffTitle(r.id)
                      if (t !== '') r.title = t
                    }
                  }
                  return attachRunningIds(res, runningIdsOf)
                })
              })()
            : foreignSessionPreview(
                { provider: q.get('provider') ?? '', reference: q.get('reference') ?? '' },
                undefined,
                env,
              )
          void body.then(
            (r) => { sendJson(response, 200, r) },
            (error: unknown) => { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'preflight') {
          // 接管预检（0.26 第三波接线）：foreign_session_read action=show 取回规范值之后
          // assessForeignTakeover 出三档判定卡——面板「接管」按钮的前置闸。只读面与
          // session-preview 同级敏感（wounds 含涉及文件路径），过同一读守卫。
          // 判定模块契约级绝不抛，读取层规范值返回（含 ok:false）——此处只兜绝对意外。
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          if (!readGuard(request)) {
            sendJson(response, 403, { error: '仅接受本机同源读取' })
            return
          }
          const q = new URL(request.url ?? '/', 'http://localhost').searchParams
          void (async () => {
            try {
              const provider = q.get('provider') ?? ''
              const read = await foreignSessionRead(
                { provider, action: 'show', reference: q.get('reference') ?? '' },
                undefined,
                env,
              )
              // 读取器适配注记（preflight reader 检查项数据源）：provider 门内才有适配器名
              // 可查；读取器面缺席/未知 provider → 注记缺省（该项落 unknown 诚实降级）
              let adapterNote: { supported: boolean; note: string } | undefined
              try {
                const adapter = PROVIDER_TO_ADAPTER[provider.trim().toLowerCase() as ForeignProvider]
                if (adapter !== undefined) adapterNote = (await defaultForeignReaders()).adapterNote(adapter)
              } catch { /* 读取器面缺席：注记缺省 */ }
              const card: PreflightCard = assessForeignTakeover({ read, adapterNote, now: new Date() })
              sendJson(response, 200, { ok: true, card })
            } catch (e) {
              sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
            }
          })()
          return
        }

        if (sub === 'takeover') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              try {
                const controller = sessionControllerOf(ctx)
                if (controller === undefined) {
                  // 规范降级：面板收到后自动退回复制指令路径
                  sendJson(response, 200, { ok: false, error: '宿主缺会话控制器，一键接管不可用——请改用复制指令' })
                  return
                }
                const mode = String(body['mode'] ?? '')
                if (!(TAKEOVER_MODES as readonly string[]).includes(mode)) {
                  sendJson(response, 200, { ok: false, error: `未知 mode：${mode}（支持 ${TAKEOVER_MODES.join(' / ')}）` })
                  return
                }
                const provider = String(body['provider'] ?? '')
                const reference = String(body['reference'] ?? '')
                const lang = body['lang'] === 'en' ? 'en' : 'zh'
                const key = `${mode}|${provider}|${reference}`
                // 成功响应附全量 state（0.26 §5.2 集成：lifeboat/provider/sync 端点同款
                // 「免等 30s 轮询」）——预警态（contextHealth，body 带 sessionId 且会话在场时
                // 随 state 展开）随投递响应即时回显；state 组装失败不吞投递结果（降级不带 state）
                const sendResult = (r: TakeoverOutcome): Promise<void> => (async () => {
                  if (!r.ok) {
                    sendJson(response, 200, r)
                    return
                  }
                  let state: ReturnType<typeof buildState> | undefined
                  try {
                    const session = sessionById(String(body['sessionId'] ?? ''))
                    const base = await stateBody()
                    state = session !== undefined && session !== null ? withContextHealth(base, session, tokenMeterOf()) : base
                  } catch { /* 降级：不带 state */ }
                  sendJson(response, 200, { ...r, ...(state !== undefined ? { state } : {}) })
                })()
                const cached = takeoverMemo.get(key)
                if (cached !== undefined && Date.now() - cached.at < 5000) {
                  void cached.run.then(sendResult)
                  return
                }
                const run = admitTakeover(controller, { mode: mode as TakeoverMode, provider, reference, lang }, { env, sessions: rootSessionsOf() })
                takeoverMemo.set(key, { at: Date.now(), run })
                // 结果落地 10s 后清条目（去重窗 5s 之内仍可命中）：Map 不随使用历史无界增长
                void run.then(
                  (r) => {
                    void sendResult(r)
                    setTimeout(() => {
                      const cur = takeoverMemo.get(key)
                      if (cur !== undefined && cur.run === run) takeoverMemo.delete(key)
                    }, 10_000)
                  },
                  // admitTakeover 承诺不 reject——此 catch 只兜绝对意外，不让 unhandled rejection 出门
                  (e: unknown) => { sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) }) },
                )
              } catch (e) {
                sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
              }
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'send') {
          // 交接出去：把寄存指令 queue 进「当前会话」——本会话的 agent 蒸馏寄存后，
          // 卡进共享收件箱，对面按取件指引接手。与 takeover 反向：不建新会话。
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              try {
                const lang: 'zh' | 'en' = body['lang'] === 'en' ? 'en' : 'zh'
                // target 是 chips 键（claude/any/…），换算成展示名进指令
                const targetKey = String(body['target'] ?? 'any')
                const targetLabel = (OUTBOUND_LABELS as Record<string, { zh: string; en: string }>)[targetKey]?.[lang] ?? targetKey
                const sessionId = String(body['sessionId'] ?? '').trim()
                if (sessionId === '') {
                  sendJson(response, 200, { ok: false, error: '缺少当前会话 id（老宿主座位不带 sessionId 时走复制路径）', instruction: outboundCommand(lang, targetLabel) })
                  return
                }
                const controller = sessionControllerOf(ctx)
                if (controller === undefined) {
                  // 规范降级：带指令回包，面板自动退回复制路径
                  sendJson(response, 200, { ok: false, error: '宿主缺会话控制器，一键交接不可用——请复制指令粘进输入框', instruction: outboundCommand(lang, targetLabel) })
                  return
                }
                void controller.prompt({
                  requestId: randomUUID(),
                  sessionId,
                  mode: 'queue',
                  content: [{ type: 'text', text: outboundCommand(lang, targetLabel) }],
                }, new AbortController().signal).then(
                  () => { sendJson(response, 200, { ok: true }) },
                  (e: unknown) => {
                    sendJson(response, 200, {
                      ok: false,
                      error: e instanceof Error ? e.message : String(e),
                      instruction: outboundCommand(lang, targetLabel),
                    })
                  },
                )
              } catch (e) {
                sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
              }
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'memory-scan') {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' })
            response.end()
            return
          }
          if (!readGuard(request)) {
            sendJson(response, 403, { error: '仅接受本机同源读取' })
            return
          }
          // 只读扫描：清单确定（已知路径逐个探测），不猜测目录内容
          sendJson(response, 200, { ok: true, sources: scanMemorySources() })
          return
        }

        if (sub === 'memory-push') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              try {
                const keys = Array.isArray(body['keys']) ? body['keys'].map((x: unknown) => String(x)) : undefined
                const result = pushMemoryCard({ keys, target: String(body['target'] ?? ''), title: String(body['title'] ?? '') })
                sendJson(response, 200, result)
              } catch (e) {
                sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
              }
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'provider') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              // 写操作进串行队列：上一个 provider 写完成（含回读 state）才开始下一个
              providerWriteQueue = providerWriteQueue.then(async () => {
                try {
                  const provider = String(body['provider'] ?? '').trim().toLowerCase()
                  const enabled = body['enabled'] === true
                  setProviderEnabled(provider as ForeignProvider | string, enabled)
                  sendJson(response, 200, { ok: true, state: await stateBody() })
                } catch (e) {
                  sendJson(response, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
                }
              })
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'clear-archived') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          try {
            const cleared = clearArchived()
            sendJson(response, 200, { ok: true, cleared })
          } catch (e) {
            sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
          }
          return
        }

        if (sub === 'dismiss-pending') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              try {
                const rawId = String(body['id'] ?? '')
                const r = dismissPending(rawId)
                if (r.ok) {
                  // 延续账本（0.26 集成接线 §5.2）：弃置也是账本事件——未取件即清落
                  // abandoned（receipt.ts 模块头立约的落账形态；target 落卡 id，无正文）
                  recordLifecycleEvent({ stage: 'pickup', reason: 'abandoned', target: rawId.trim().replace(/[\\/]/g, ''), detail: 'dismiss 未取件' })
                }
                sendJson(response, r.ok ? 200 : 400, r)
              } catch (e) {
                sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
              }
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'pin' || sub === 'unpin') {
          // 置顶 / 取消置顶（0.26 triage 接线）：pins.json 本机视图 sidecar（新置顶在前）。
          // 卡被取件/弃置后 pin 由 listPins 懒清理自动失效——两个端点都是幂等的本机便利
          // 视图写侧，sameOrigin 门 + id 消毒（inboxtriage 模块内同 dismissPending 口径）
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              try {
                const id = String(body['id'] ?? '')
                const r = sub === 'pin' ? setPin(id) : unsetPin(id)
                sendJson(response, r.ok ? 200 : 400, { ...r, action: sub })
              } catch (e) {
                sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
              }
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'restore-archived') {
          // 弃置恢复（0.26 triage 接线）：archived/ 整卡按 dismiss 同一扩展名枚举反向搬回
          // pending/（取件中断/弃置后悔的逆操作出口）。pending 已有同名文件时一次都不搬
          //（预检拒绝覆盖）；成功落 lifecycle 'restored' 正向回执。
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              try {
                const r = restoreFromArchived(String(body['id'] ?? ''))
                sendJson(response, r.ok ? 200 : 400, { ...r, action: 'restore-archived' })
              } catch (e) {
                sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
              }
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'sync') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              // 与 provider 写同队列串行：git index.lock 不容并发动作（两次同时 push 会互相锁）
              providerWriteQueue = providerWriteQueue.then(async () => {
                try {
                  const action = String(body['action'] ?? 'now')
                  const url = typeof body['url'] === 'string' ? body['url'] : ''
                  let r: SyncOutcome
                  if (action === 'setup') r = await syncSetup(url)
                  else if (action === 'now') r = await syncNow()
                  else if (action === 'push') r = await syncPush()
                  else if (action === 'pull') r = await syncPull()
                  else r = { ok: false, action, error: `未知动作：${action}（支持 setup / now / push / pull）` }
                  // 带全量 state：同步状态就地刷新，免等 30s 轮询（provider 端点同款）
                  sendJson(response, r.ok ? 200 : 400, { ...r, state: await stateBody() })
                } catch (e) {
                  sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
                }
              })
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'env-backup') {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              // 写盘动作与 provider/sync 同队列串行：备份/还原都是重 I/O，不并发
              providerWriteQueue = providerWriteQueue.then(async () => {
                const action = String(body['action'] ?? '')
                const passphrase = String(body['passphrase'] ?? '')
                const file = String(body['file'] ?? '')
                try {
                  if (action === 'create') {
                    const r = createBackup(passphrase)
                    sendJson(response, 200, { ...r, backups: listBackups() })
                  } else if (action === 'dry') {
                    sendJson(response, 200, dryRunRestore(file, passphrase))
                  } else if (action === 'apply') {
                    if (body['confirm'] !== true) {
                      sendJson(response, 400, { ok: false, error: '还原是覆盖性动作：先 dry 预演，再带 confirm:true 落盘' })
                      return
                    }
                    const r = applyRestore(file, passphrase)
                    sendJson(response, 200, { ...r, backups: listBackups() })
                  } else if (action === 'rollback') {
                    sendJson(response, 200, rollbackRestore(file))
                  } else if (action === 'list') {
                    sendJson(response, 200, { ok: true, backups: listBackups() })
                  } else {
                    sendJson(response, 400, { ok: false, error: `未知动作：${action}（支持 create / dry / apply / rollback / list）` })
                  }
                } catch (e) {
                  sendJson(response, 400, { ok: false, error: e instanceof Error ? e.message : String(e) })
                }
              })
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        if (sub === 'lifeboat') {
          // 救生艇：上下文炸了也不经模型把运行态抢出来——按 sessionId 取当前会话，
          // 直接 pushHandoff 做事件流确定性蒸馏（不调 LLM），空壳闸按救生艇语义放行
          //（confirmSkeleton: true，PushArgs 已有参数）。会话缺席回规范错误；
          // 事件流不可读走 probeSessionEvents 的 fail-open 降级（兜底骨架照常出卡）。
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' })
            response.end()
            return
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { error: '仅接受同源请求' })
            return
          }
          void readJsonBody(request).then(
            (body) => {
              void (async () => {
                try {
                  const sessionId = String(body['sessionId'] ?? '').trim()
                  if (sessionId === '') {
                    sendJson(response, 200, { ok: false, error: '缺少 sessionId（老宿主座位不带当前会话 id，面板不出救生艇按钮）' })
                    return
                  }
                  // 会话查找与 admitTakeover 同款（rootSessionsOf().get）；get 自身抛错也按缺席处理
                  const sessions = rootSessionsOf()
                  let session: unknown
                  try {
                    session = sessions?.get?.(sessionId)
                  } catch { /* 注入纪律代理可能抛：视作会话缺席 */ }
                  if (session === undefined || session === null) {
                    sendJson(response, 200, { ok: false, error: `会话 ${sessionId} 不在场（宿主会话服务未挂载或会话已关闭）——救生艇需要活的会话事件流` })
                    return
                  }
                  // 0.26 probe 接线：写侧探测同享官方代价投影（tokenMeter 在手即传，缺席诚实降级）
                  const result = pushHandoff(session, { confirmSkeleton: true }, { tokenMeter: tokenMeterOf() })
                  if (!result.ok) {
                    // 写侧闸拒收（密钥闸等）：规范错误值原样回，拦截理由不隐瞒
                    //（闸内已自记 lifecycle 事件，这里不重复记）
                    sendJson(response, 200, result)
                    return
                  }
                  // 死亡地图：救生艇出卡也是写侧事件（reason 闭集新增 'lifeboat'，target 落卡 id）
                  recordLifecycleEvent({
                    stage: 'write',
                    reason: 'lifeboat',
                    target: result.id,
                    detail: result.skipped ? '事件流降级——兜底骨架卡（空壳闸放行）' : '面板一键抢出（不经模型）',
                  })
                  // 换机同步已启用 → 自动拉推一步闭环（与 sync 路由同队列串行：
                  // git index.lock 不容并发动作）；同步失败不吞卡——ok:true 照回，synced 带失败详情
                  let synced: SyncOutcome | undefined
                  if (loadSyncConfig().enabled) {
                    const queued = providerWriteQueue.then(async () => { synced = await syncNow() }).catch(() => { /* 队列健康优先；syncNow 内部已转规范值 */ })
                    providerWriteQueue = queued
                    await queued
                  }
                  // 带全量 state：新卡即刻在收件箱可见，免等 30s 轮询（provider/sync 端点同款）；
                  // state 组装失败不吞卡——state 缺席由前端退回 30s 轮询补。
                  // 0.26 集成接线：state 展开 contextHealth（会话在手，预警态随动作响应即时回显）
                  let state: ReturnType<typeof buildState> | undefined
                  try { state = withContextHealth(await stateBody(), session, tokenMeterOf()) } catch { /* 降级：不带 state */ }
                  sendJson(response, 200, {
                    ok: true,
                    id: result.id,
                    detail: result.note,
                    ...(synced !== undefined ? { synced } : {}),
                    ...(state !== undefined ? { state } : {}),
                  })
                } catch (e) {
                  sendJson(response, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
                }
              })()
            },
            (error: unknown) => { sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) },
          )
          return
        }

        sendJson(response, 404, { error: `未知路由：/dsh-takeover/${sub}（支持 state / history / sessions / session-preview / preflight / takeover / send / memory-scan / memory-push / provider / clear-archived / dismiss-pending / pin / unpin / restore-archived / sync / env-backup / lifeboat）` })
      },
    }))
  })
}
