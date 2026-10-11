// client.ts UI 组件树的 DOM 渲染与交互测试（happy-dom + react-dom/client）。
// 目标：组件渲染体、事件处理器与数据路径进入覆盖——配合纯函数单测把自研行覆盖推上 95%。
import './ui-dom-setup.ts'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, type ReactElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import * as client from '../src/client.ts'
import { DICTS, interpolate } from '../src/locales.ts'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { TakeoverState, PendingRow, ProviderRow } from '../src/settings.ts'
import type { SessionListBody } from '../src/browser-view.ts'

// ---------------------------------------------------------------- fixtures

const t = ((key: string, params?: Record<string, unknown>) =>
  interpolate(DICTS.zh[String(key)] ?? String(key), params)) as unknown as Translate

const provider = (name: string, over: Partial<ProviderRow> = {}): ProviderRow => ({
  name: name as ProviderRow['name'], supported: true, sessions: 3, enabled: true, note: '', ...over,
})

const pendingRow = (over: Partial<PendingRow> = {}): PendingRow => ({
  id: 'ho-test-0001', agent: 'dsh', title: '交接卡 A', project: 'demo',
  pushedAt: '2026-10-11T10:00:00+08:00', preview: '目标：把收件箱功能做完', lowInfo: false,
  ...over,
})

const stateFixture = (): TakeoverState => ({
  home: 'C:/Users/demo/.handoff',
  pending: [
    pendingRow(),
    pendingRow({ id: 'ho-test-0002', title: '空壳卡', preview: '（无实质内容）', lowInfo: true }),
    pendingRow({ id: 'ho-test-0003', title: '接力卡 B', supersedes: 'ho-test-0001' }),
  ],
  pendingSkipped: 0,
  pendingDuplicates: 1,
  archivedCount: 5,
  coverage: { statements: 12, marked: 10, unmarked: 2 },
  envelopeChars: 7426,
  providers: [provider('claude', { sessions: 3 }), provider('zcode', { sessions: 172 })],
})

// ---------------------------------------------------------------- 环境与桩

const { testWindow } = await import('./ui-dom-setup.ts')
const doc = testWindow.document
const g = globalThis as unknown as Record<string, unknown>

type Call = { url: string; method: string; body: string }
const calls: Call[] = []
let stateOnce: TakeoverState = stateFixture()
const stubPlan: Record<string, Stub> = {}
type Stub = { status?: number; body?: unknown }
;(g as { fetch: unknown }).fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
  const urlStr = String(url)
  calls.push({ url: urlStr, method: init?.method ?? 'GET', body: init?.body ?? '' })
  const key = urlStr.split('?')[0] ?? ''
  const plan = stubPlan[key]
  const status = plan?.status ?? 200
  const body = plan?.body
    ?? (key === '/dsh-takeover/state'
      ? stateOnce
      : key === '/dsh-takeover/provider'
        ? { ok: true, state: stateOnce }
        : key === '/dsh-takeover/sessions'
        ? { ok: true, provider: 'zcode', total: 1, sessions: [
            { id: 'sess_aaaabbbb', title: '样例会话', cwd: 'D:/demo', updatedAt: '2026-10-11T09:00:00Z', kind: 'uuid' },
          ] }
        : init?.method === 'POST'
          ? { ok: true, sessionId: 'sess_new', title: '新会话' }
          : { ok: true })
  return { ok: status < 400, status, json: async () => body }
}) as unknown as typeof fetch

function resetCalls(): void { calls.length = 0 }
function lastBody(url: string): unknown {
  const hit = [...calls].reverse().find((c) => c.url === url)
  return hit ? JSON.parse(hit.body || '{}') : null
}

if (typeof (URL.prototype as unknown as { createObjectURL?: unknown }).createObjectURL !== 'function') {
  ;(URL.prototype as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:http://127.0.0.1:3080/x'
  ;(URL.prototype as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
}

// ---------------------------------------------------------------- 渲染工具

let root: Root | null = null
const container = doc.createElement('div')
doc.body.appendChild(container)

async function render(el: ReactElement): Promise<void> {
  if (root === null) root = createRoot(container as never)
  await act(async () => { root!.render(el) })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
}

function text(): string {
  // textContent 会把 <style> 的 CSS 文本一并算进来（面板会注入样式块）——断言前剔除
  let s = container.textContent ?? ''
  for (const st of [...container.querySelectorAll('style')]) s = s.split(st.textContent ?? '§§never§§').join('')
  return s
}
function has(s: string): boolean { return text().includes(s) }
// happy-dom 与 react-dom 的 DOM 类型互不相认——事件派发走 unknown 通道
function fireClick(el: unknown): void { (el as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }
function fireChange(el: unknown): void { (el as { dispatchEvent: (e: unknown) => boolean }).dispatchEvent(new window.Event('change', { bubbles: true })) }
async function clickButton(match: string | RegExp): Promise<void> {
  const btn = [...container.querySelectorAll('button')]
    .find((b) => typeof match === 'string' ? (b.textContent ?? '').includes(match) : match.test(b.textContent ?? ''))
  assert.ok(btn, `按钮不存在: ${String(match)}`)
  await act(async () => { fireClick(btn) })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}
async function flush(ms = 20): Promise<void> { await act(async () => { await new Promise((r) => setTimeout(r, ms)) }) }
async function waitText(s: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (has(s)) return
    if (Date.now() > deadline) return
    await flush(50)
  }
}

const navigate = (sessionId: string): boolean => sessionId.length > 0

// ---------------------------------------------------------------- Panel

test('Panel（slim）：命令速览 + 支持矩阵 + 指引行，不渲染收件箱与浏览器', async () => {
  await render(createElement(client.Panel, { t, locale: undefined, navigate, slim: true }))
  assert.ok(has('命令速览'))
  assert.ok(has('支持矩阵'))
  assert.ok(has('输入框内'))
  assert.ok(!has('收件箱概览'))
  assert.ok(!has('外部会话浏览器'))
})

test('Panel（非 slim 降级）：工作台内嵌，收件箱行与浏览器在场', async () => {
  await render(createElement(client.Panel, { t, locale: undefined, navigate, slim: false }))
  assert.ok(has('收件箱概览'))
  assert.ok(has('外部会话浏览器'))
  assert.ok(has('交接卡 A'))
})

test('ProviderMatrix：开关点击发起 provider POST', async () => {
  await render(createElement(client.Panel, { t, locale: undefined, navigate, slim: true }))
  await waitText('Claude Code')
  resetCalls()
  const sw = container.querySelector('[role="switch"]') as HTMLElement | null
  assert.ok(sw, '矩阵开关不存在')
  await act(async () => { fireClick(sw) })
  await flush()
  assert.ok(calls.some((c) => c.url === '/dsh-takeover/provider'), 'provider POST 未发起')
})

// ---------------------------------------------------------------- 工作台

test('WorkspaceBody：统计条 / 接力链徽标 / 低信息折叠组全渲染', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  assert.ok(has('待取件 3'), '待取件徽标缺失')
  assert.ok(has('已消费 5'), '已消费徽标缺失')
  assert.ok(has('覆盖率 10/12'), '覆盖率徽标缺失')
  assert.ok(has('← 接力自 ho-test-0001'), '接力链徽标缺失')
  assert.ok(has('导出全部'), '导出按钮缺失')
  assert.ok(has('导出 HTML 报告'))
})

test('WorkspaceBody：展开卡行点「一键取件」——POST takeover 带卡 id，成功出确认横幅', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  resetCalls()
  // 行标题是 div 而非 button——点击行本体展开
  const title = [...container.querySelectorAll('.bt-pending-title')]
    .find((e) => (e.textContent ?? '').includes('交接卡 A'))
  assert.ok(title, '目标行标题不存在')
  await act(async () => { fireClick(title) })
  await flush()
  await clickButton('一键取件')
  await flush()
  const sent = lastBody('/dsh-takeover/takeover') as { reference?: string } | null
  assert.ok(sent, 'takeover POST 未发起')
  assert.equal(sent?.reference, 'ho-test-0001')
  assert.ok(has('已创建会话'), '确认横幅未出现')
})

test('WorkspaceBody：清空已消费二次确认后发起 clear-archived', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  resetCalls()
  await clickButton('清空已消费')
  await clickButton('确认清空')
  await flush()
  assert.ok(calls.some((c) => c.url === '/dsh-takeover/clear-archived'), 'clear POST 未发起')
})

test('WorkspaceBody：导出全部与 HTML 报告点击不抛错（blob 下载路径）', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  await clickButton('导出全部')
  await clickButton('导出 HTML 报告')
  assert.ok(true)
})

test('WorkspaceBody：过滤框输入即筛（接力卡 B 命中后只留其行）', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  assert.ok(has('交接卡 A'))
  const filter = container.querySelector('input[type="search"]') as HTMLInputElement | null
  assert.ok(filter, '过滤框不存在')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(filter!, '接力卡 B')
    filter!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.ok(has('接力卡 B'))
  assert.ok(!has('交接卡 A'))
})

// ---------------------------------------------------------------- 浏览器

test('ForeignBrowser：provider chip 点击拉取列表并渲染行与接管按钮', async () => {
  await render(createElement(client.ForeignBrowser, {
    state: stateFixture(), t, lang: 'zh' as const,
    onError: () => {}, onNotice: () => {}, navigate,
  }))
  resetCalls()
  await clickButton('ZCode')
  await flush()
  assert.ok(calls.some((c) => c.url.startsWith('/dsh-takeover/sessions?provider=zcode')), 'sessions GET 未发起')
  assert.ok(has('样例会话'))
  assert.ok(has('接管并寄存'))
})

test('ForeignBrowser：停用的 provider 点击不发起会话请求', async () => {
  const st = stateFixture()
  st.providers = [provider('claude', { enabled: false })]
  await render(createElement(client.ForeignBrowser, {
    state: st, t, lang: 'zh' as const,
    onError: () => {}, onNotice: () => {}, navigate,
  }))
  resetCalls()
  await clickButton('Claude Code')
  await flush()
  assert.ok(!calls.some((c) => c.url.startsWith('/dsh-takeover/sessions')), '停用家不应发起会话请求')
})

// ---------------------------------------------------------------- chip 与边界

test('ComposerChip：收起/展开/遮罩关闭三态', async () => {
  await render(createElement(client.ComposerChip, { t, locale: undefined, navigate }))
  assert.ok(has('接力') && !has('接力工作台'), '收起态应只有 chip')
  await clickButton('接力')
  assert.ok(has('接力工作台'))
  const backdrop = container.querySelector('div[style*="z-index: 9998"]')
  assert.ok(backdrop, '遮罩不存在')
  await act(async () => { fireClick(backdrop) })
  await flush()
  assert.ok(!has('接力工作台'), '遮罩点击后应关闭')
})

test('PanelBoundary：子树抛错渲染错误卡而非白屏', async () => {
  function Bomb(): never { throw new Error('boom') }
  await render(createElement(client.PanelBoundary, { t, children: createElement(Bomb) }))
  assert.ok(has('渲染出错'))
  assert.ok(has('boom'))
})

test('静态词典回退：缺宿主 locale 时 t 输出 zh 文案', () => {
  assert.ok(String(DICTS.zh.appTitle).includes('dsh-takeover'))
  assert.ok(String(DICTS.en.browserTitle ?? '').length > 0)
})

after(() => { try { root?.unmount() } catch { /* 已卸载 */ } })
