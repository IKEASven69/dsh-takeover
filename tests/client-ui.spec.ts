// client.ts UI 组件树的 DOM 渲染与交互测试（happy-dom + react-dom/client）。
// 目标：组件渲染体、事件处理器与数据路径进入覆盖——配合纯函数单测把自研行覆盖推上 95%。
import './ui-dom-setup.ts'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { cloneElement, createElement, type ReactElement } from 'react'
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

let renderSeq = 0
async function render(el: ReactElement): Promise<void> {
  if (root === null) root = createRoot(container as never)
  // 同类型组件在同一个 root 上 render 会保留 useState（newOnly/openIds 跨测试泄漏，
  // 曾让 newOnly 系测试顺序依赖）——每次渲染换 key 强制全新挂载
  const keyed = cloneElement(el, { key: `render-${++renderSeq}` })
  await act(async () => { root!.render(keyed) })
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
  assert.ok(has('已存档 5'), '已存档徽标缺失（0.4.0 起口径改为存档数——保留策略封顶 50，不再叫已消费）')
  assert.ok(has('可查证 10/12'), '覆盖率徽标缺失（0.3.0 改版：覆盖率→可查证）')
  assert.ok(has('← 接力自 ho-test-0001'), '接力链徽标缺失')
  assert.ok(has('导出 ▾'), '导出菜单按钮缺失')
  assert.ok(has('只看新卡'), '未读开关缺失')
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

test('WorkspaceBody：导出▾菜单开合与两个导出项点击不抛错（blob 下载路径）', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  // 菜单收起时两个导出项不在 DOM——先点开菜单
  assert.ok(!has('导出全部'), '菜单未开时导出项不应渲染')
  await clickButton('导出 ▾')
  assert.ok(has('导出全部'), '菜单打开后缺「导出全部」项')
  assert.ok(has('导出 HTML 报告'), '菜单打开后缺「导出 HTML 报告」项')
  await clickButton('导出全部')
  await clickButton('导出 ▾')
  await clickButton('导出 HTML 报告')
  assert.ok(true)
})

test('WorkspaceBody：只看新卡是独立复选框开关——看过且收起的卡被滤掉，展开中的卡保留', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  // 展开看 A → 记已见 → 收起（分诊完成：seen + 非展开态）
  const title = [...container.querySelectorAll('.bt-pending-title')]
    .find((e) => (e.textContent ?? '').includes('交接卡 A'))
  assert.ok(title, '目标行标题不存在')
  const rowA = title!.closest('[role="button"]') as HTMLElement | null
  assert.ok(rowA, '行本体不存在')
  await act(async () => { fireClick(rowA) })
  await flush()
  // 收起前必须重查节点：React 重渲染会替换行 DOM，旧引用已脱离文档（点击会落空）
  const rowA2 = [...container.querySelectorAll('[role="button"]')]
    .find((e) => (e.textContent ?? '').includes('交接卡 A')) as unknown as HTMLElement | null
  assert.ok(rowA2, '收起前行节点不存在')
  await act(async () => { fireClick(rowA2) })
  await flush()
  // 勾选只看新卡（React 的 checkbox onChange 由 click 合成触发——原生 change 不够）
  const box = container.querySelector('.bt-newonly input') as HTMLInputElement | null
  assert.ok(box, '只看新卡复选框不存在')
  await act(async () => { fireClick(box) })
  await flush()
  assert.ok(box.checked, '点击后复选框未勾上')
  // 已看过且已收起的 A 被滤掉（分诊完成）；B 未读保留
  assert.ok(!has('交接卡 A'), '已分诊的 A 仍显示——未读过滤未生效')
  assert.ok(has('接力卡 B'), '未读的接力卡 B 不应被滤掉')
  // 展开中的行不蒸发（0.4.3 语义：展开 = 正在分诊，收起才算完成）
  const openId = 'ho-test-0001'
  // 取消勾选恢复
  await act(async () => { fireClick(box) })
  await flush()
  assert.ok(has('交接卡 A'), '取消勾选后 A 未恢复')
  // 来源 chips 里不再混「只看新卡」按钮（它现在是复选框）
  const chipsGroup = container.querySelector('[aria-label="按来源筛选待取件"]')
  assert.ok(chipsGroup, '来源筛选组不存在')
  assert.ok(!chipsGroup!.textContent!.includes('只看新卡'), '只看新卡不应混进来源 chips 组')
  void openId
})

test('WorkspaceBody：只看新卡下展开的行不消失（0.4.3 交互回归：展开即记已见会蒸发行）', async () => {
  // 自建状态流程（不依赖 localStorage——测试环境无 localStorage，seen 走模块级内存 store，
  // 该 store 跨测试共享，因此流程必须自洽：本测试展开+收起第一行 = 它进入「已分诊」态）
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  // 展开第一行再收起：进入「已分诊」（seen + 非展开态）
  const row1 = container.querySelector('.bt-pending-title')?.closest('[role="button"]') as unknown as HTMLElement | null
  const t1 = container.querySelector('.bt-pending-title')?.textContent ?? ''
  assert.ok(row1 && t1 !== '', '首行不存在')
  await act(async () => { fireClick(row1) })
  await flush()
  await act(async () => { fireClick(row1) })
  await flush()
  // 勾选只看新卡：已分诊的行被滤掉
  const box = container.querySelector('.bt-newonly input') as HTMLInputElement | null
  assert.ok(box, '只看新卡复选框不存在')
  const dbgRows = () => [...container.querySelectorAll('.bt-pending')].map((r) => (r.className.includes('bt-pending-open') ? '[开]' : '') + (r.querySelector('.bt-pending-title')?.textContent?.slice(0, 6) ?? '?')).join(',')
  console.log('DBG before-newonly:', dbgRows(), '| checked:', box.checked)
  await act(async () => { fireClick(box) })
  await flush()
  console.log('DBG after-newonly:', dbgRows(), '| checked:', box.checked)
  assert.ok(!has(t1), '已分诊的行未被过滤')
  // 展开「另一张」未读卡（点击 = 记已见）——展开中的行不得蒸发（本轮修复的核心断言）
  const row2 = [...container.querySelectorAll('.bt-pending-title')]
    .find((e) => (e.textContent ?? '') !== t1)
  assert.ok(row2, '未读行不存在')
  const t2 = row2!.textContent ?? ''
  await act(async () => { fireClick(row2!.closest('[role="button"]') as unknown as HTMLElement) })
  await flush()
  assert.ok(has(t2), '展开中的行在只看新卡下蒸发了（应保留至收起）')
  const openRow = container.querySelector('.bt-pending-open')
  assert.ok(openRow, '展开态丢失')
  // 收尾：恢复未勾选（同 root 同类型组件的 useState 跨 render 保留——测试结尾必须复位）
  await act(async () => { fireClick(box) })
  await flush()
  assert.ok(!box.checked, '收尾未恢复未勾选')
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

// ---------------------------------------------------------------- 0.3.0 新三卡（交接出去 / 记忆快照 / 帮助）

test('WorkspaceBody：帮助默认隐藏（[?] 切换）；交接出去/记忆快照齐渲染；统计条改版；pills 带图标', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false, sessionId: 'sess-cur-1', showHelp: true }))
  assert.ok(has('新手帮助 / FAQ'), '帮助卡应渲染（showHelp=true）')
  assert.ok(has('交接出去'), '出站卡应渲染')
  assert.ok(has('记忆快照'), '记忆卡应渲染')
  assert.ok(has('可查证'), '覆盖率徽标应改为「可查证」')
  assert.ok(has('信封附件 7.4K'), '信封字数应人性化（7426→7.4K，0.4.0 改称信封附件）')
  // 外部会话浏览器 pills（state.providers 两家）：应带品牌 svg 图标
  const icons = container.querySelectorAll('.bt-chip svg')
  assert.ok(icons.length >= 2, `浏览器 pills 应有品牌图标，实得 ${icons.length}`)
  // 默认隐藏：不带 showHelp 时帮助卡不占行
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  assert.ok(!has('新手帮助 / FAQ'), '帮助默认隐藏，不占行')
})

test('SendCard：无 sessionId 复制降级不发请求；有 sessionId 一键 POST send', async () => {
  const copied: string[] = []
  const nav = globalThis.navigator as unknown as { clipboard?: { writeText: (s: string) => Promise<void> } }
  if (nav.clipboard !== undefined) nav.clipboard.writeText = async (s: string) => { copied.push(s) }
  // 复制降级路径（老宿主座位不带 sessionId）
  await render(createElement(client.SendCard, { t, lang: 'zh' as const, onError: () => {}, onNotice: () => {} }))
  resetCalls()
  await clickButton('交接出去')
  await flush()
  assert.ok(copied.some((s) => s.startsWith('/handoff')), '无 sessionId 应复制寄存指令')
  assert.ok(!calls.some((c) => c.url.startsWith('/dsh-takeover/send')), '无 sessionId 不应发请求')
  // 一键路径（key 换新实例：前一步「已复制」状态不复位）
  await render(createElement(client.SendCard, { key: 'b', t, lang: 'zh' as const, sessionId: 'sess-cur-9', onError: () => {}, onNotice: () => {} }))
  resetCalls()
  await clickButton('交接出去')
  await flush()
  assert.deepEqual(lastBody('/dsh-takeover/send'), { sessionId: 'sess-cur-9', lang: 'zh', target: 'any' })
})

test('MemoryCard：展开即扫描、不存在的来源不可选、出卡 POST memory-push 只带勾选项', async () => {
  stubPlan['/dsh-takeover/memory-scan'] = { body: { ok: true, sources: [
    { key: 'claude-user', agent: 'Claude Code', path: 'C:/u/.claude/CLAUDE.md', exists: true, bytes: 1200, mtime: '', preview: '偏好 bun' },
    { key: 'codex-user', agent: 'Codex CLI', path: 'C:/u/.codex/AGENTS.md', exists: false, bytes: 0, mtime: '', preview: '' },
  ] } }
  stubPlan['/dsh-takeover/memory-push'] = { body: { ok: true, sources: 1, id: 'ho-mem-1', path: 'x' } }
  // 初始展开（defaultOpen）经挂载副作用触发扫描；toggle 事件路径在真实浏览器走 onToggle
  resetCalls()
  await render(createElement(client.MemoryCard, { t, lang: 'zh' as const, onError: () => {}, onNotice: () => {}, onPushed: () => {}, defaultOpen: true }))
  await flush()
  assert.ok(calls.some((c) => c.url.startsWith('/dsh-takeover/memory-scan')), '展开应触发扫描')
  await waitText('CLAUDE.md')
  assert.ok(has('CLAUDE.md') && has('1 KB'), '扫描行应渲染（路径 + 大小）')
  assert.ok(has('另有 1 处常见记忆路径'), '缺失来源应只报个数')
  // 不存在的来源不渲染（用户反馈：没装 hippo 的机器不该看到 hippo 行）
  assert.ok(!has('.codex/AGENTS.md'), '不存在的来源不应渲染')
  const boxes = [...container.querySelectorAll('input[type="checkbox"]')] as unknown as HTMLInputElement[]
  assert.equal(boxes.length, 1)
  assert.equal(boxes[0]?.disabled, false)
  // 出卡
  await clickButton('生成记忆交接卡')
  await flush()
  const pushed = lastBody('/dsh-takeover/memory-push') as { keys: string[]; target: string }
  assert.deepEqual(pushed.keys, ['claude-user'], '不存在的来源不应入选')
  assert.equal(pushed.target, 'any')
  delete stubPlan['/dsh-takeover/memory-scan']
  delete stubPlan['/dsh-takeover/memory-push']
})

test('HelpCard：8 条问答渲染，zh 词典齐全（en 同键）', async () => {
  await render(createElement(client.HelpCard, { t }))
  assert.ok(has('三步上手'))
  assert.ok(has('隐私'))
  for (const lang of ['zh', 'en'] as const) {
    for (let i = 1; i <= 8; i++) {
      assert.ok(String(DICTS[lang][`qa${i}q`] ?? '').length > 0, `${lang} qa${i}q 缺失`)
      assert.ok(String(DICTS[lang][`qa${i}a`] ?? '').length > 0, `${lang} qa${i}a 缺失`)
    }
  }
})

// ---------------------------------------------------------------- 0.4.5 评审修复回归

function fireKey(el: unknown, key: string, init: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}): boolean {
  // 返回值 = dispatchEvent 的返回：被 preventDefault 即 false（用来断言「输入态放行」vs「截断」）
  return (el as { dispatchEvent: (e: unknown) => boolean })
    .dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
}
const active = (): Element | null => doc.activeElement as unknown as Element | null

test('ProviderMatrix：状态 pill 分类——绿支持 / 假 0 哨兵黄待确认且行全亮 / 探测失败黄待确认 / 0 会话无哨兵灰行 / 不支持灰行黄不可用', async () => {
  const rows = [
    provider('claude', { sessions: 3, note: '' }),
    provider('zcode', { sessions: 0, note: '目录存在但 0 会话（布局迁移提示）' }),
    provider('codex', { sessions: -1, note: '' }),
    provider('gemini', { sessions: 0, note: '' }),
    provider('pi', { supported: false, sessions: -1, note: '' }),
  ]
  await render(createElement(client.ProviderMatrix, { rows, busy: null, onToggle: () => {}, t }))
  const mx = [...container.querySelectorAll('.tk-mxr')]
  assert.equal(mx.length, 5, '矩阵行数')
  const pill = (i: number): string => mx[i]!.querySelector('.tk-pill')?.textContent ?? ''
  const pillCls = (i: number): string => mx[i]!.querySelector('.tk-pill')?.className ?? ''
  const idle = (i: number): boolean => mx[i]!.classList.contains('tk-mxr-idle')
  // 绿「支持」= 可用且发现了会话
  assert.equal(pill(0), '支持'); assert.ok(pillCls(0).includes('tk-pill-ok')); assert.ok(!idle(0))
  // 假 0 哨兵（0 会话 + note 非空）：黄「待确认」且行保持全亮——旧版一律绿支持+灰行，行为已变，在此钉住
  assert.equal(pill(1), '待确认'); assert.ok(pillCls(1).includes('tk-pill-warn')); assert.ok(!idle(1), '待确认行不许灰')
  assert.ok(mx[1]!.querySelector('.tk-mnote')?.textContent?.includes('布局迁移'), '哨兵 note 要浮出为行内黄字')
  // 会话数探测失败（<0）：黄「待确认」（低信息），不灰
  assert.equal(pill(2), '待确认'); assert.ok(pillCls(2).includes('tk-pill-warn')); assert.ok(!idle(2))
  // 0 会话且无哨兵：本机未装/暂无会话 → 灰行，pill 仍是绿「支持」
  assert.equal(pill(3), '支持'); assert.ok(idle(3), '0 会话无哨兵应灰行')
  // 不支持：灰行 + 黄「不可用」
  assert.equal(pill(4), '不可用'); assert.ok(pillCls(4).includes('tk-pill-warn')); assert.ok(idle(4))
})

test('WorkspaceBody：`/` 与 Ctrl/⌘+K 聚焦过滤框（DESIGN.md §5）；输入态下 `/` 放行；其他视图下先切回收件箱', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  const filter = container.querySelector('input[type="search"]') as HTMLInputElement | null
  assert.ok(filter, '过滤框不存在')
  const navInbox = container.querySelector('[data-view="inbox"]') as HTMLElement | null
  assert.ok(navInbox, '导航项不存在')
  // 焦点在工作台内非输入元素上按 `/` → 聚焦过滤框，且事件被截断（Firefox 快速查找不抢）
  await act(async () => { navInbox!.focus() })
  let passed = true
  await act(async () => { passed = fireKey(navInbox, '/') })
  assert.equal(passed, false, '`/` 应被 preventDefault')
  assert.equal(active(), filter, '`/` 后焦点应落在过滤框')
  // 输入态：在过滤框里再按 `/` 照常输入（不截断）
  await act(async () => { passed = fireKey(filter, '/') })
  assert.equal(passed, true, '输入态 `/` 不许截断')
  // Ctrl+K 不分焦点一律聚焦过滤框
  await act(async () => { navInbox!.focus() })
  await act(async () => { passed = fireKey(navInbox, 'k', { ctrlKey: true }) })
  assert.equal(passed, false, 'Ctrl+K 应被截断')
  assert.equal(active(), filter, 'Ctrl+K 后焦点应落在过滤框')
  // 其他视图下按 `/`：先切回收件箱再聚焦（display:none 的输入框 focus 会落空）
  const navBrowse = container.querySelector('[data-view="browse"]') as HTMLElement | null
  assert.ok(navBrowse)
  await act(async () => { fireClick(navBrowse) })
  await flush()
  assert.equal(navBrowse!.getAttribute('aria-pressed'), 'true', '应已切到会话浏览器视图')
  await act(async () => { navBrowse!.focus(); fireKey(navBrowse, '/') })
  await flush(30)
  assert.equal(navInbox!.getAttribute('aria-pressed'), 'true', '`/` 应把视图切回收件箱')
  const filter2 = container.querySelector('input[type="search"]') as HTMLInputElement | null
  assert.equal(active(), filter2, '切回后焦点应落在过滤框')
})

test('WorkspaceBody：导航轨 ↑/↓ 循环、Home/End 首尾，落焦即切视图（DESIGN.md §4）', async () => {
  await render(createElement(client.WorkspaceBody, { t, locale: undefined, navigate, chrome: false }))
  await waitText('待取件 3')
  const item = (k: string): HTMLElement => container.querySelector(`[data-view="${k}"]`) as unknown as HTMLElement
  await act(async () => { item('inbox').focus() })
  await act(async () => { fireKey(item('inbox'), 'ArrowDown') })
  await flush()
  assert.equal(active(), item('browse'), '↓ 应落焦会话浏览器')
  assert.equal(item('browse').getAttribute('aria-pressed'), 'true', '↓ 落焦即切视图')
  await act(async () => { fireKey(item('browse'), 'End') })
  await flush()
  assert.equal(active(), item('guide'), 'End 应落焦上手指南')
  assert.ok(has('三步上手'), 'End 切到指南视图应渲染帮助卡')
  await act(async () => { fireKey(item('guide'), 'ArrowDown') })
  await flush()
  assert.equal(active(), item('inbox'), '↓ 从末项应循环回收件箱')
  await act(async () => { fireKey(item('inbox'), 'ArrowUp') })
  await flush()
  assert.equal(active(), item('guide'), '↑ 从首项应循环到末项')
  await act(async () => { fireKey(item('guide'), 'Home') })
  await flush()
  assert.equal(active(), item('inbox'), 'Home 应回首项')
})

test('ComposerChip 模态契约：打开焦点入壳、Tab/Shift+Tab 圈闭、Escape 关闭、焦点归还 chip', async () => {
  await render(createElement(client.ComposerChip, { t, locale: undefined, navigate }))
  await clickButton('接力')
  await flush(30)
  const dlg = container.querySelector('[role="dialog"]') as HTMLElement | null
  assert.ok(dlg, '浮层不存在')
  assert.equal(dlg!.getAttribute('aria-modal'), 'true')
  // 打开即焦点入壳：落在当前视图的导航项（`/` 立即可用）
  const first = dlg!.querySelector('.tk-navitem[aria-pressed="true"]') as HTMLElement | null
  assert.ok(first, '当前视图导航项不存在')
  assert.equal(active(), first, '打开后焦点应落在当前视图导航项')
  // Tab 圈闭：从壳内最后一个可聚焦元素 Tab → 回到第一个；第一个 Shift+Tab → 到最后一个
  await waitText('待取件 3')
  const focusables = [...dlg!.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')]
    .filter((el) => !(el as { disabled?: boolean }).disabled && el.getAttribute('tabindex') !== '-1' && el.closest('[hidden]') === null)
  assert.ok(focusables.length >= 3, `可聚焦元素过少：${focusables.length}`)
  const head = focusables[0]!
  const tail = focusables[focusables.length - 1]!
  await act(async () => { tail.focus() })
  assert.equal(active(), tail)
  await act(async () => { fireKey(tail, 'Tab') })
  assert.equal(active(), head, 'Tab 从末元素应回到首元素（圈闭）')
  await act(async () => { fireKey(head, 'Tab', { shiftKey: true }) })
  assert.equal(active(), tail, 'Shift+Tab 从首元素应到末元素（圈闭）')
  // 过滤框有字时 Escape 先清空不关壳；再按才关
  const filter = dlg!.querySelector('input[type="search"]') as HTMLInputElement | null
  assert.ok(filter, '过滤框不存在')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(filter!, '接力卡 B')
    filter!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.ok(!has('交接卡 A'), '过滤应已生效')
  await act(async () => { filter!.focus(); fireKey(filter, 'Escape') })
  await flush()
  assert.ok(container.querySelector('[role="dialog"]') !== null, '有字时 Escape 不应关壳')
  assert.ok(has('交接卡 A'), '有字时 Escape 应清空过滤')
  await act(async () => { fireKey(dlg, 'Escape') })
  await flush(30)
  assert.ok(container.querySelector('[role="dialog"]') === null, '空过滤后 Escape 应关壳')
  // 焦点归还唤出 chip
  const chip = container.querySelector('button.bt-chip') as HTMLElement | null
  assert.ok(chip, 'chip 不存在')
  assert.equal(active(), chip, '关闭后焦点应归还 chip')
})

test('视图头 h2 id 走 useId：两实例同挂不撞 id，aria-labelledby 可解析', async () => {
  await render(createElement('div', null,
    createElement(client.WorkspaceBody, { key: 'a', t, locale: undefined, navigate, chrome: false }),
    createElement(client.WorkspaceBody, { key: 'b', t, locale: undefined, navigate, chrome: false }),
  ))
  await waitText('待取件 3')
  const heads = [...container.querySelectorAll('h2.tk-h')]
  assert.ok(heads.length >= 8, `两实例视图头数：${heads.length}`)
  const ids = heads.map((h) => h.id)
  assert.equal(new Set(ids).size, ids.length, `视图头 id 撞车：${ids.join(',')}`)
  assert.ok(ids.every((id) => id !== '' && !id.startsWith('tk-h-')), '不应再是固定 tk-h-* id')
  for (const sec of container.querySelectorAll('section.tk-view')) {
    const ref = sec.getAttribute('aria-labelledby') ?? ''
    assert.ok(ref !== '' && container.querySelector(`[id="${ref}"]`) !== null, `aria-labelledby 悬空：${ref}`)
  }
})

after(() => { try { root?.unmount() } catch { /* 已卸载 */ } })
