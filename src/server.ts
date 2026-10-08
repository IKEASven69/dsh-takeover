/**
 * host 侧 /dsh-takeover/ JSON API（dsh-hippo 同款 webServer 路由桥先例）：
 *   GET  /dsh-takeover/state           设置卡状态（收件箱概览 + 支持矩阵）
 *   GET  /dsh-takeover/sessions        外部会话浏览列表 ?provider=&limit=（轻量发现层，不读内容）
 *   GET  /dsh-takeover/session-preview 单会话结构化预览 ?provider=&reference=（摘要+骨架素材，不吐原文轮次）
 *   POST /dsh-takeover/takeover        一键接管/取件 {mode, provider?, reference?}——宿主会话控制器建新会话并投递指令
 *   POST /dsh-takeover/provider        切 provider 开关 {provider, enabled}
 *   POST /dsh-takeover/clear-archived  清空 archived/
 * POST 一律过同源守卫；响应 { ok, ... } 规范值，失败不抛异常。
 * @module dsh-takeover/server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context.webServer merge（宿主由 web bundle 提供，不打进产物）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defaultForeignReaders, foreignResolveOne, foreignSessionPreview, foreignSessionsList, type ForeignProvider } from './foreign.ts'
import { depositCommand, takeoverCommand } from './browser-view.ts'
import { buildState, clearArchived, isProviderEnabled, setProviderEnabled } from './settings.ts'

function sendJson(response: ServerResponse, code: number, body: unknown): void {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
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
        resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>)
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

// ---------------------------------------------------------------------------
// FR-1 一键接管：宿主会话控制器的最小面 + 投递核心。
// 访问形态与官方包同款（dsh-schedule 直接 ctx.sessionController；cordis 对
// 未挂载服务的属性访问会 throw——防御式取用，缺席即 FR-1 规范降级）。
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

/** 防御式取宿主会话控制器：服务挂在根 ctx（本插件 ctx 未 inject 该服务名，
 * 直接取会 throw「cannot get property without inject」——root 层即可达）。
 * 缺席/形态不符回 undefined（FR-1 规范降级），绝不抛出。 */
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
  | { ok: false; error: string }

const TAKEOVER_TITLE_MAX = 48

/**
 * 投递核心（可脱离 cordis 单测）：建新会话 → 改可找标题 → queue 模式投递指令。
 * 指令与浏览器复制的载荷同一出处（browser-view 的 takeoverCommand/depositCommand），
 * 「点按钮」和「手动粘贴」永远等价；mode=inbox 投递裸 /inbox（最小输入纪律）。
 * 任何一步失败回规范错误值；已建会话的 id 随错误带出（不隐瞒孤儿会话）。
 */
export async function admitTakeover(
  controller: SessionControllerLike,
  args: { mode: TakeoverMode; provider?: string; reference?: string },
  deps?: { resolve?: typeof foreignResolveOne; random?: () => string },
): Promise<TakeoverOutcome> {
  let instruction: string
  let title: string
  if (args.mode === 'inbox') {
    instruction = '/inbox'
    title = '收件箱取件'
  } else {
    const resolve = deps?.resolve ?? foreignResolveOne
    const resolved = await resolve({ provider: args.provider, reference: args.reference })
    if (!resolved.ok) return resolved
    const provider = String(args.provider)
    instruction = args.mode === 'take_deposit'
      ? depositCommand(provider, resolved.ref.id, 'zh')
      : takeoverCommand(provider, resolved.ref.id)
    title = `接管：${resolved.ref.title || resolved.ref.id}`.slice(0, TAKEOVER_TITLE_MAX)
  }
  try {
    const created = await controller.create({})
    const sessionId = (created as { sessionId?: unknown } | undefined)?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
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
    return { ok: true, sessionId, title }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 注册 /dsh-takeover/ 前缀路由。webServer 是宿主可选服务（CLI 形态没有），
 * 走 ctx.inject 缺席即跳过，不影响工具与 skill 注册面。
 */
export function registerTakeoverRoutes(ctx: Context): void {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => host.webServer.register({
      kind: 'prefix',
      // 注意不能带尾斜杠：匹配规则是 pathname === prefix 或 startsWith(prefix + '/')，
      // '/dsh-takeover/' 会要求 '/dsh-takeover//' 才命中（dsh-hippo 的 '/dsh-hippo/app' 先例）。
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
          void stateBody().then(
            (state) => { sendJson(response, 200, state) },
            (error: unknown) => { sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) }) },
          )
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
          const env = { isEnabled: (p: ForeignProvider) => isProviderEnabled(p) }
          // 规范值（含 ok:false）一律 200——停用/未知名是业务结果不是 HTTP 事故；意外异常才 500
          const body: Promise<unknown> = sub === 'sessions'
            ? (() => {
                const limitRaw = Number(q.get('limit') ?? '')
                return foreignSessionsList(
                  { provider: q.get('provider') ?? '', limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined },
                  undefined,
                  env,
                )
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
              const controller = sessionControllerOf(ctx)
              if (controller === undefined) {
                // 规范降级：面板收到后自动退回复制指令路径
                sendJson(response, 200, { ok: false, error: '宿主缺会话控制器，一键接管不可用——请改用复制指令' })
                return
              }
              const mode = String(body['mode'] ?? '')
              if (mode !== 'take' && mode !== 'take_deposit' && mode !== 'inbox') {
                sendJson(response, 200, { ok: false, error: `未知 mode：${mode}（支持 take / take_deposit / inbox）` })
                return
              }
              void admitTakeover(controller, {
                mode,
                provider: String(body['provider'] ?? ''),
                reference: String(body['reference'] ?? ''),
              }).then(
                (r) => { sendJson(response, 200, r) },
              )
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

        sendJson(response, 404, { error: `未知路由：/dsh-takeover/${sub}（支持 state / sessions / session-preview / takeover / provider / clear-archived）` })
      },
    }))
  })
}
