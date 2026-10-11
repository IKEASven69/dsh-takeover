// UI 组件测试的 DOM 全局环境（happy-dom）：必须先于 react-dom / src/client 导入执行。
// 只在此处触碰全局对象；每个用例共用同一个 Window（组件状态互不依赖，靠 key 隔离）。
import { Window } from 'happy-dom'

const win = new Window({ url: 'http://127.0.0.1:3080/' })
const g = globalThis as unknown as Record<string, unknown>

g.window = win
g.document = win.document
g.HTMLElement = win.HTMLElement
g.HTMLInputElement = win.HTMLInputElement
g.HTMLTextAreaElement = win.HTMLTextAreaElement
g.HTMLIFrameElement = win.HTMLIFrameElement
g.SVGElement = win.SVGElement
g.Element = win.Element
g.Node = win.Node
g.Event = win.Event
g.CustomEvent = win.CustomEvent
g.MouseEvent = win.MouseEvent
g.KeyboardEvent = win.KeyboardEvent
g.MessageChannel = (win as unknown as { MessageChannel?: unknown }).MessageChannel ?? g.MessageChannel
g.getComputedStyle = win.getComputedStyle.bind(win)
g.requestAnimationFrame = ((cb: (t: number) => void): number =>
  (win.requestAnimationFrame as unknown as (c: (t: number) => void) => number)(cb)) as unknown as (cb: (t: number) => void) => number
g.cancelAnimationFrame = ((id: number): void => { (win.cancelAnimationFrame as unknown as (i: number) => void)(id) }) as unknown as (id: number) => void
g.IS_REACT_ACT_ENVIRONMENT = true

if (typeof g.URL !== 'string' && typeof (g.URL as typeof URL).createObjectURL !== 'function') {
  ;(g.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:http://127.0.0.1:3080/test'
  ;(g.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
}

// navigator：Node 全局 navigator 未必可覆写——优先整只替换，退而给宿主对象补 clipboard
try {
  g.navigator = win.navigator
} catch {
  /* Node 内置 navigator 不可写 */
}
try {
  const nav = globalThis.navigator as unknown as { clipboard?: { writeText: (t: string) => Promise<void> } }
  if (nav && nav.clipboard === undefined) {
    Object.defineProperty(nav, 'clipboard', { value: { writeText: async () => {} }, configurable: true })
  }
} catch {
  /* clipboard 桩失败时 copyText 走 textarea 降级路径，用例依旧成立 */
}

export { win as testWindow }
