/**
 * 记忆快照交接 + 交接出去（outbound）回归：
 * - memory.ts：扫描（temp home / 项目级 / hippo 特例）、六段组装、出卡（keys 过滤/
 *   密钥闸贯通）、工具注册与 execute 路径；
 * - browser-view 出站纯函数：outboundCommand / pickupCommand / humanChars；
 * - server.ts：send 路由（queue 进当前会话 / 降级带回指令）、memory-scan / memory-push
 *   路由全链、列表标题头窥（sniffTitle / looksUntitled）。
 * 全部用临时目录与假控制器，不碰真实宿主与真实 home。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  humanChars,
  outboundCommand,
  pickupCommand,
  OUTBOUND_TARGETS,
} from '../src/browser-view.ts'
import {
  MEMORY_SOURCES,
  memorySections,
  pushMemoryCard,
  registerMemoryTool,
  scanMemorySources,
  type MemorySourceRow,
} from '../src/memory.ts'
import { pushHandoff } from '../src/tools.ts'
import { looksUntitled, registerTakeoverRoutes, sniffTitle, sessionControllerOf, type SessionControllerLike } from '../src/server.ts'

// ---------- browser-view 出站纯函数 ----------

test('outboundCommand：两行式（/handoff 头 + 指示行），zh/en 各一份', () => {
  for (const lang of ['zh', 'en'] as const) {
    const cmd = outboundCommand(lang)
    const lines = cmd.split('\n')
    assert.equal(lines.length, 2)
    assert.equal(lines[0], '/handoff')
    assert.ok((lines[1] ?? '').length > 0)
    assert.doesNotMatch(lines[1]?.charAt(0) ?? '', /\s/, '指示行不得有前导空白')
  }
  assert.match(outboundCommand('zh'), /卡片编号/)
  assert.match(outboundCommand('en'), /card id/)
})

test('pickupCommand：CLI 家给一键启动行，输入框家给同句；卡 id 恒在句中', () => {
  assert.match(pickupCommand('claude', 'ho-x', 'zh'), /^claude "读 ~\/\.handoff\/pending\/ho-x\.md/)
  assert.match(pickupCommand('codex', 'ho-x', 'en'), /^codex "Read ~\/\.handoff\/pending\/ho-x\.md/)
  assert.match(pickupCommand('opencode', 'ho-x', 'zh'), /^opencode /)
  assert.match(pickupCommand('grok', 'ho-x', 'zh'), /^grok /)
  // zcode / pi / workbuddy / cursor / any：输入框同句（无二进制前缀）
  for (const tgt of ['zcode', 'pi', 'workbuddy', 'cursor', 'any']) {
    const cmd = pickupCommand(tgt, 'ho-x', 'zh')
    assert.ok(cmd.includes('~/.handoff/pending/ho-x.md'), `${tgt} 句里要有卡路径`)
    assert.ok(!cmd.includes('"'), `${tgt} 不该有 CLI 引号包裹`)
  }
  assert.ok(OUTBOUND_TARGETS.includes('any') && OUTBOUND_TARGETS.length === 9)
})

test('humanChars：7426→7.4K、1000→1K、999 原样、1.2M 档', () => {
  assert.equal(humanChars(999), '999')
  assert.equal(humanChars(1000), '1K')
  assert.equal(humanChars(7426), '7.4K')
  assert.equal(humanChars(1_200_000), '1.2M')
  assert.equal(humanChars(2_000_000), '2M')
})

// ---------- memory.ts 扫描 ----------

test('scanMemorySources：temp home 命中已存在文件、缺文件如实 exists:false；项目级仅带 cwd 才扫', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-'))
  try {
    mkdirSync(join(tmp, '.claude'), { recursive: true })
    writeFileSync(join(tmp, '.claude', 'CLAUDE.md'), '# Claude 记忆\n偏好 bun。')
    const rows = scanMemorySources({ home: tmp })
    const claude = rows.find((r) => r.key === 'claude-user')
    assert.ok(claude?.exists)
    assert.ok(claude.bytes > 0)
    assert.match(claude.preview, /偏好 bun/)
    const codex = rows.find((r) => r.key === 'codex-user')
    assert.equal(codex?.exists, false)
    // 未带 cwd：项目级一行都不出
    assert.ok(rows.every((r) => !r.key.endsWith('-project')))
    const withProject = scanMemorySources({ home: tmp, cwd: tmp })
    assert.ok(withProject.some((r) => r.key === 'agents-project'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('scanMemorySources：hippo 库存在时报存在但不读预览（二进制特例）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-hippo-'))
  try {
    mkdirSync(join(tmp, 'hippo'), { recursive: true })
    writeFileSync(join(tmp, 'hippo', 'memory.db'), Buffer.from([1, 2, 3, 0x00, 0xff]))
    process.env['DSH_HOME'] = tmp
    try {
      const rows = scanMemorySources({ home: tmp })
      const hippo = rows.find((r) => r.key === 'hippo-db')
      assert.ok(hippo?.exists)
      assert.equal(hippo?.preview, '')
      assert.ok(hippo.bytes > 0)
    } finally {
      delete process.env['DSH_HOME']
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------- memory.ts 组装与出卡 ----------

const fakeRow = (over: Partial<MemorySourceRow>): MemorySourceRow => ({
  key: 'claude-user', agent: 'Claude Code', path: '/fake/CLAUDE.md', exists: true,
  bytes: 100, mtime: '2026-10-01T00:00:00.000Z', preview: '偏好 bun', ...over,
})

test('memorySections：六段齐全、来源清单进 goal/files、正文进 suggested、hippo 行给 dump/import 指引', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-sec-'))
  try {
    const real = join(tmp, 'CLAUDE.md')
    writeFileSync(real, '偏好 bun。')
    const picks = [
      fakeRow({ path: real, bytes: 15 }),
      fakeRow({ key: 'hippo-db', agent: 'dsh-hippo 记忆库', path: '/fake/memory.db', bytes: 2048 }),
    ]
    const s = memorySections(picks, { target: 'claude', at: '2026-10-20T12:00:00.000Z' })
    assert.match(s.goal, /2 份记忆文件/)
    assert.match(s.goal, /claude/)
    assert.match(s.files, /CLAUDE\.md/)
    assert.match(s.done, /HISTORY_REPORTED/)
    assert.match(s.remaining, /吸收/)
    assert.match(s.stopped, /2026-10-20/)
    assert.match(s.warnings, /HISTORY_REPORTED/)
    assert.match(s.suggested ?? '', /偏好 bun/)
    assert.match(s.suggested ?? '', /\/memory dump/)
    assert.match(s.suggested ?? '', /\/memory import/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('pushMemoryCard：keys 过滤 + 卡真落 pending/；全不存在回规范错误', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-push-'))
  try {
    const scan = (): MemorySourceRow[] => [
      fakeRow({ key: 'claude-user', path: join(tmp, 'a.md') }),
      fakeRow({ key: 'zcode-user', agent: 'ZCode', path: join(tmp, 'b.md') }),
    ]
    // 注入 pushHandoff 真身但 dir 指临时——文件体读取会失败，正文走 UNAVAILABLE 降级，卡仍落
    const r = pushMemoryCard({ keys: ['zcode-user'], target: 'claude' }, { scan, push: pushHandoff, dir: tmp })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const pd = join(tmp, 'pending')
    assert.ok(existsSync(join(pd, `${r.id}.md`)), '卡应落 pending/')
    const text = readFileSync(join(pd, `${r.id}.md`), 'utf-8')
    assert.match(text, /handoff: 1/)
    assert.match(text, /ZCode/)
    assert.equal(r.sources, 1)
    // 全部键都不存在 → 规范错误
    const bad = pushMemoryCard({ keys: ['nope'] }, { scan, push: pushHandoff, dir: tmp })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error, /没有可带的记忆文件/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('pushMemoryCard：密钥闸贯通——记忆正文带疑似密钥被拒（留痕旁路除外）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-secret-'))
  try {
    writeFileSync(join(tmp, 'a.md'), 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    const scan = (): MemorySourceRow[] => [fakeRow({ path: join(tmp, 'a.md') })]
    const r = pushMemoryCard({ keys: ['claude-user'] }, { scan, push: pushHandoff, dir: tmp })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /密钥闸/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('registerMemoryTool：注册名 handoff_memory；execute scan/push 全路径', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-tool-'))
  process.env['HANDOFF_HOME'] = tmp
  try {
    const registered: Array<{ name: string; execute: (a: unknown) => Promise<unknown> }> = []
    const ctx = { tools: { register: (def: { name: string; execute: (a: unknown) => Promise<unknown> }): void => { registered.push(def) } }, logger: { info: (): void => {} } }
    registerMemoryTool(ctx as never)
    assert.equal(registered.length, 1)
    const def = registered[0]
    assert.ok(def, '工具未注册')
    assert.equal(def.name, 'handoff_memory')
    const scanOut = (await def.execute({ action: 'scan' })) as { ok: boolean; sources: MemorySourceRow[] }
    assert.equal(scanOut.ok, true)
    assert.ok(Array.isArray(scanOut.sources))
    // 未知 action 在 defineTool 包装层就被参数校验拦下（enum 校验先于 execute）
    await assert.rejects(() => def.execute({ action: 'wat' }), /must be one of/)
  } finally {
    delete process.env['HANDOFF_HOME']
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('MEMORY_SOURCES：清单确定（键唯一、hippo 在册、路径函数全可调用）', () => {
  const keys = MEMORY_SOURCES.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(keys.includes('hippo-db'))
  const home = homedir()
  for (const def of MEMORY_SOURCES) {
    const p = def.path(home, '/tmp/proj')
    assert.ok(typeof p === 'string' && p.length > 0)
  }
})

// ---------- server.ts 路由 ----------

function fakeController(): { controller: SessionControllerLike; calls: string[] } {
  const calls: string[] = []
  const controller: SessionControllerLike = {
    create: async () => { calls.push('create'); return { sessionId: 'sess-new' } },
    rename: async () => { calls.push('rename'); return undefined },
    prompt: async (req) => { calls.push(`prompt:${req.sessionId}:${req.mode}:${req.content[0]?.text ?? ''}`); return { accepted: true } },
  }
  return { controller, calls }
}

/** 路由调用器（registration.spec 同款 harness） */
async function routeHarness(extraCtx?: Record<string, unknown>): Promise<(o: { method?: string; url?: string; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; body: string }>> {
  let handler: ((req: unknown, res: unknown) => void) | undefined
  const host = {
    effect: (fn: () => void): void => fn(),
    webServer: { register: (reg: { handler: typeof handler }): void => { handler = reg.handler } },
  }
  const ctx = { inject: (_deps: string[], cb: (h: typeof host) => void): void => cb(host), ...extraCtx }
  registerTakeoverRoutes(ctx as never)
  assert.ok(handler, '路由未注册')
  return (o) => new Promise((resolve) => {
    const req = Object.assign(new EventEmitter(), {
      method: o.method ?? 'POST',
      url: o.url ?? '/dsh-takeover/state',
      headers: o.headers ?? {},
      socket: { remoteAddress: '127.0.0.1' },
    })
    const res = {
      statusCode: 0,
      writeHead(code: number): unknown { this.statusCode = code; return this },
      end(b?: string): void { resolve({ status: this.statusCode, body: b ?? '' }) },
    }
    ;(handler as unknown as (q: unknown, s: unknown) => void)(req, res)
    if (o.body !== undefined) req.emit('data', Buffer.from(o.body))
    req.emit('end')
  })
}

const ORIGIN = { host: 'localhost:3080', origin: 'http://localhost:3080' }

test('send 路由：queue 指令投进给定会话；缺 sessionId / 缺控制器时降级带回指令', async () => {
  const { controller, calls } = fakeController()
  const call = await routeHarness({ sessionController: controller })
  // 正常路径
  const ok = await call({ url: '/dsh-takeover/send', headers: ORIGIN, body: '{"sessionId":"sess-cur-1","lang":"zh"}' })
  assert.equal(ok.status, 200)
  assert.deepEqual(JSON.parse(ok.body), { ok: true })
  const promptCall = calls.find((c) => c.startsWith('prompt:')) ?? ''
  assert.match(promptCall, /^prompt:sess-cur-1:queue:\/handoff/)
  // 缺 sessionId：ok:false + instruction（复制路径）
  const noId = await call({ url: '/dsh-takeover/send', headers: ORIGIN, body: '{}' })
  const noIdBody = JSON.parse(noId.body) as { ok: boolean; instruction?: string }
  assert.equal(noIdBody.ok, false)
  assert.match(noIdBody.instruction ?? '', /^\/handoff/)
  // 缺控制器：同样带回指令
  const call2 = await routeHarness()
  const noCtrl = await call2({ url: '/dsh-takeover/send', headers: ORIGIN, body: '{"sessionId":"x"}' })
  const noCtrlBody = JSON.parse(noCtrl.body) as { ok: boolean; instruction?: string }
  assert.equal(noCtrlBody.ok, false)
  assert.match(noCtrlBody.instruction ?? '', /^\/handoff/)
})

test('memory-scan / memory-push 路由：GET 只读清单；POST keys 不存在回规范错误；跨源 403', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-mem-route-'))
  process.env['HANDOFF_HOME'] = tmp
  try {
    const call = await routeHarness()
    const scan = await call({ method: 'GET', url: '/dsh-takeover/memory-scan', headers: ORIGIN })
    assert.equal(scan.status, 200)
    const scanBody = JSON.parse(scan.body) as { ok: boolean; sources: MemorySourceRow[] }
    assert.equal(scanBody.ok, true)
    assert.ok(Array.isArray(scanBody.sources))
    // push：键不存在 → 200 + ok:false（业务结果不是 HTTP 事故）
    const push = await call({ url: '/dsh-takeover/memory-push', headers: ORIGIN, body: '{"keys":["nope-key"],"target":"claude"}' })
    assert.equal(push.status, 200)
    assert.equal((JSON.parse(push.body) as { ok: boolean }).ok, false)
    // 跨源：403
    const forbidden = await call({ url: '/dsh-takeover/memory-push', headers: { host: 'localhost:3080' }, body: '{"keys":[]}' })
    assert.equal(forbidden.status, 403)
  } finally {
    delete process.env['HANDOFF_HOME']
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('sessionControllerOf：ctx 直挂控制器可取（root 缺席时回退本层）', () => {
  const { controller } = fakeController()
  assert.equal(sessionControllerOf({ sessionController: controller }), controller)
  assert.equal(sessionControllerOf({}), undefined)
  assert.equal(sessionControllerOf({ sessionController: { create: 'nope' } }), undefined)
})

// ---------- server.ts 标题头窥 ----------

test('looksUntitled：文件系缺人类标题判真（stem=读取器兜底标题，交给头窥增强）；sqlite 系判假', () => {
  assert.equal(looksUntitled({ id: 'C:\\s\\a.jsonl', title: '', kind: 'file' }), true)
  assert.equal(looksUntitled({ id: 'C:\\s\\a.jsonl', title: 'C:\\s\\a.jsonl', kind: 'file' }), true)
  assert.equal(looksUntitled({ id: 'C:\\s\\a.jsonl', title: 'a.jsonl', kind: 'file' }), true)
  // 标题=stem：读取器拿文件名兜底的形态，不是人类标题——判真交给头窥
  assert.equal(looksUntitled({ id: 'C:\\s\\a.jsonl', title: 'a', kind: 'file' }), true)
  assert.equal(looksUntitled({ id: 'C:\\s\\b.jsonl', title: '90ef7f42-f671-4eaf-b0e6-c33bbb439820', kind: 'file' }), true)
  assert.equal(looksUntitled({ id: 'C:\\s\\真标题.jsonl', title: '真标题', kind: 'file' }), true)
  assert.equal(looksUntitled({ id: 'sess_abc', title: '', kind: 'sqlite' }), false)
})

test('sniffTitle：头 64KB 抓首条用户消息文本；非 jsonl/缺失回空串', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-sniff-'))
  try {
    const p = join(tmp, 'a.jsonl')
    writeFileSync(p, [
      '{"type":"summary","summary":"钩子行"}',
      '{"type":"user","message":{"role":"user","content":"修复登录页的报错提示"}}',
      '{"type":"assistant","message":{"role":"assistant"}}',
    ].join('\n'))
    assert.equal(sniffTitle(p), '修复登录页的报错提示')
    // content 数组形态
    const p2 = join(tmp, 'b.jsonl')
    writeFileSync(p2, '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"调研向量库选型"}]}}')
    assert.equal(sniffTitle(p2), '调研向量库选型')
    // 无用户行 → 空串
    const p3 = join(tmp, 'c.jsonl')
    writeFileSync(p3, '{"type":"assistant"}')
    assert.equal(sniffTitle(p3), '')
    // 非 jsonl / 不存在 → 空串
    assert.equal(sniffTitle(join(tmp, 'nope.jsonl')), '')
    assert.equal(sniffTitle(join(tmp, 'd.txt')), '')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
