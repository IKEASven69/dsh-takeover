/**
 * 0.3.0 jsonl 族扩容四家（kimi / codebuddy / qoder / kiro）真实适配器 fixture：
 * HANDOFF_ROOT_<名> 指向临时合成目录，discover 命中 + parse 归一 Turn + 根缺省降级。
 * （foreign.spec 同手法：适配器在模块加载时读根路径，env 必须先于 readers 首次加载，
 * 因此对 readers 的值导入放在 env 之后动态 await import；fixture 布局出处：
 * kimi = MoonshotAI/kimi-code wire 事件流（claude-replay / uniflo / ai-toolbox 交叉核实）、
 * codebuddy = WorkBuddy 内核记录族（uniflo 核实）、qoder = Claude Code 同族记录
 * （ChatCrystal / uniflo / dsh-config-manager 交叉核实）、kiro = kiro-cli 2.22.0 事件流
 * （hstry 对实录核对 / codeburn / uniflo 交叉核实）。）
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FOREIGN_PROVIDERS, PROVIDER_TO_ADAPTER, foreignSessionRead } from '../src/foreign.ts'
import { OUTBOUND_TARGETS } from '../src/browser-view.ts'
import type { SessionRef } from '@agent-handoff/readers'

// ---------- env 先于 readers 首次加载（模块加载时读根路径） ----------

const FAMILY_ROOT = mkdtempSync(join(tmpdir(), 'dsh-jsonl-family-'))
const KIMI_ROOT = join(FAMILY_ROOT, '.kimi-code', 'sessions')
const CODEBUDDY_ROOT = join(FAMILY_ROOT, '.codebuddy', 'projects')
const QODER_ROOT = join(FAMILY_ROOT, '.qoder', 'projects')
const KIRO_ROOT = join(FAMILY_ROOT, '.kiro', 'sessions', 'cli')
process.env['HANDOFF_ROOT_KIMI'] = KIMI_ROOT
process.env['HANDOFF_ROOT_CODEBUDDY'] = CODEBUDDY_ROOT
process.env['HANDOFF_ROOT_QODER'] = QODER_ROOT
process.env['HANDOFF_ROOT_KIRO'] = KIRO_ROOT
const readers = await import('@agent-handoff/readers')
const { AGENTS, listSessions, readSession } = readers
after(() => { try { rmSync(FAMILY_ROOT, { recursive: true, force: true }) } catch { /* 临时目录尽力清 */ } })

// ---------- fixture 合成（照各家真实布局） ----------

const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const SEC = 1790000000 // 2026-09-21T14:13:20Z（kiro / kimi 的事件流时间戳是 epoch 秒）
const MS = SEC * 1000
const ISO = '2026-11-01T01:00:00.000Z' // qoder / codebuddy 记录自带 ISO / epoch 毫秒

function write(path: string, data: string, mtimeMs = MS): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data, 'utf-8')
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000) // 布局里没有文件内时间的字段靠 mtime 排序
}

/** kimi：双会话——带 state.json 的主会话 + 只有 wire 流的裸会话（索引兜底元数据） */
function buildKimiFixture(): void {
  const wd = join(KIMI_ROOT, 'wd_demo_ab12cd34')
  const sessA = 'session_aa000000-0000-7000-8000-000000000001'
  const sessB = 'session_aa000000-0000-7000-8000-000000000002'
  write(join(wd, sessA, 'agents', 'main', 'wire.jsonl'), jsonl([
    { type: 'metadata', protocol_version: '1.3', created_at: MS },
    { type: 'turn.prompt', time: SEC, input: [{ type: 'text', text: '帮我把 kimi 会话接管跑通' }], origin: { kind: 'user' } },
    { type: 'context.append_loop_event', time: SEC + 1, event: { type: 'step.begin', uuid: 's1' } },
    { type: 'context.append_loop_event', time: SEC + 2, event: { type: 'content.part', part: { type: 'text', text: '好的，先读 wire 流。' } } },
    { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: '内部推演 kimi' } } },
    { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 't1', name: 'read_file', args: { path: 'D:\\kimi-fix\\src\\a.ts' } } },
    { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't1', result: { output: 'const x = 1', isError: false } } },
    { type: 'context.append_loop_event', event: { type: 'tool.call', toolCallId: 't2', name: 'write_file', args: { file_path: 'D:\\kimi-fix\\src\\b.ts' } } },
    { type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 't2', result: { output: 'disk full', isError: true } } },
    { type: 'context.append_loop_event', event: { type: 'step.end' } },
    { type: 'turn.prompt', time: SEC + 10, input: [{ type: 'text', text: '再跑一遍 e2e' }], origin: { kind: 'user' } },
    '{"broken":',
  ]), MS + 2000)
  write(join(wd, sessA, 'state.json'), JSON.stringify({
    createdAt: ISO, title: '收件箱联调', isCustomTitle: true, workDir: 'D:\\kimi-fix\\demo',
  }), MS + 2000)
  // 裸会话：只有 wire 流（首条用户输入当标题），cwd 由 session_index.jsonl 兜底
  write(join(wd, sessB, 'agents', 'main', 'wire.jsonl'), jsonl([
    { type: 'metadata', protocol_version: '1.3', created_at: MS },
    { type: 'turn.prompt', time: SEC + 20, input: [{ type: 'text', text: 'kimi 裸会话只有 wire 流' }], origin: { kind: 'user' } },
  ]), MS + 1000)
  // 全局索引在 sessions 的上级（~/.kimi-code/session_index.jsonl），一行一会话
  write(join(FAMILY_ROOT, '.kimi-code', 'session_index.jsonl'), jsonl([
    { sessionId: sessA, workDir: 'D:\\kimi-fix\\demo' },
    { sessionId: sessB, workDir: 'D:\\kimi-fix\\demo2' },
  ]))
}

/** codebuddy：WorkBuddy 内核记录族；subagents/ 子目录是 decoy（本期不进候选） */
function buildCodebuddyFixture(): void {
  const dir = join(CODEBUDDY_ROOT, 'D--codebuddy-fix-demo')
  // 该内核每条记录都带 cwd / sessionId（uniflo 同构）：cwd 取自记录本身
  const cbRec = (id: string, extra: Record<string, unknown>) =>
    ({ id, timestamp: MS, cwd: 'D:\\codebuddy-fix\\demo', sessionId: 'fx-codebuddy', ...extra })
  write(join(dir, 'fx-codebuddy.jsonl'), jsonl([
    cbRec('u1', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '把 codebuddy 会话接管跑通' }] }),
    cbRec('a1', { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '好的，先看布局。' }], providerData: { model: 'cb-model' } }),
    cbRec('t1', { type: 'function_call', name: 'read', arguments: '{"file_path":"D:\\\\codebuddy-fix\\\\src\\\\a.ts"}' }),
    cbRec('t1r', { type: 'function_call_result', name: 'read', status: 'completed', output: { type: 'text', text: 'const x = 1' } }),
    cbRec('t2', { type: 'function_call', name: 'write', arguments: '{"file_path":"D:\\\\codebuddy-fix\\\\src\\\\b.ts"}' }),
    cbRec('t2r', { type: 'function_call_result', name: 'write', status: 'error', output: { type: 'text', text: 'disk full' } }),
    cbRec('ttl', { type: 'ai-title', aiTitle: '接力联调' }),
  ]))
  // decoy：子代理 transcript 一律不发现（主会话优先）
  write(join(dir, 'fx-codebuddy', 'subagents', 'agent-1.jsonl'), jsonl([
    { id: 's1', timestamp: MS, type: 'message', role: 'user', content: [{ type: 'input_text', text: '子代理会话不该被发现' }] },
  ]))
}

/** qoder：Claude Code 同族记录；<sessionId>/subagents/ 目录 decoy */
function buildQoderFixture(): void {
  const dir = join(QODER_ROOT, 'D--qoder-fix-demo')
  write(join(dir, 'fx-qoder.jsonl'), jsonl([
    { type: 'user', uuid: 'u1', timestamp: ISO, cwd: 'D:\\qoder-fix\\demo', sessionId: 'fx-qoder', message: { role: 'user', content: '把 qoder 会话接管跑通' } },
    { type: 'assistant', uuid: 'a1', timestamp: '2026-11-01T01:01:00.000Z', sessionId: 'fx-qoder', message: { id: 'm1', role: 'assistant', model: 'qoder-model', content: [{ type: 'text', text: '好的，先读入口。' }] } },
    { type: 'assistant', uuid: 'a2', timestamp: '2026-11-01T01:02:00.000Z', sessionId: 'fx-qoder', message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'D:\\qoder-fix\\src\\a.ts' } }] } },
    { type: 'user', uuid: 'u2', timestamp: '2026-11-01T01:03:00.000Z', sessionId: 'fx-qoder', message: { role: 'user', content: [{ type: 'tool_result', content: 'const x = 1' }] } },
    { type: 'ai-title', aiTitle: '体检联调' },
  ]))
  write(join(dir, 'fx-qoder', 'subagents', 'agent-1.jsonl'), jsonl([
    { type: 'user', uuid: 's1', timestamp: ISO, message: { role: 'user', content: '子代理会话不该被发现' } },
  ]))
}

/** kiro：事件流 + 伴生 .json / .history / 无关文件都只算 decoy（只读 .jsonl） */
function buildKiroFixture(): void {
  const id = '11111111-2222-4333-8444-555555555555'
  write(join(KIRO_ROOT, `${id}.jsonl`), jsonl([
    { version: 'v1', kind: 'Prompt', data: { message_id: 'm1', content: [{ kind: 'text', data: '把 kiro 会话接管跑通' }], meta: { timestamp: SEC } } },
    { version: 'v1', kind: 'AssistantMessage', data: { message_id: 'm2', content: [{ kind: 'text', data: '先看事件流。' }, { kind: 'toolUse', data: { toolUseId: 't1', name: 'shell', input: { command: 'npm test' } } }], meta: { timestamp: SEC + 1 } } },
    { version: 'v1', kind: 'ToolResults', data: { message_id: 'm3', content: [{ kind: 'toolResult', data: { toolUseId: 't1', content: [{ kind: 'json', data: { exit_status: 'exit status: 1' } }, { kind: 'text', data: 'FAIL' }], status: 'error' } }], meta: { timestamp: SEC + 2 } } },
    { version: 'v1', kind: 'AssistantMessage', data: { message_id: 'm4', content: [{ kind: 'text', data: '测试红了，先修。' }], meta: { timestamp: SEC + 3 } } },
  ]), MS + 3000)
  // 伴生文件与无 jsonl 伴身的孤儿都不得成为候选
  write(join(KIRO_ROOT, `${id}.json`), JSON.stringify({ session_id: id, cwd: 'D:\\kiro-fix\\demo', title: '伴生里的标题不读' }), MS + 3000)
  write(join(KIRO_ROOT, `${id}.history`), '历史伴生不读\n')
  write(join(KIRO_ROOT, '99999999-9999-4999-8999-999999999999.json'), JSON.stringify({ session_id: 'orphan' }))
}

buildKimiFixture()
buildCodebuddyFixture()
buildQoderFixture()
buildKiroFixture()

/** 按 id 前缀取 SessionRef（discover 已按新→旧排序） */
function refOf(refs: SessionRef[], prefix: string): SessionRef {
  const hit = refs.find((r) => r.id.replace(/\\/g, '/').includes(prefix))
  assert.ok(hit !== undefined, `缺会话 ${prefix}`)
  return hit
}

// ---------- AGENTS 注册 ----------

test('jsonl 族四家在册：AGENTS 末尾追加，root 指向 HANDOFF_ROOT_<名>', () => {
  assert.deepEqual(AGENTS.map((a) => a.name).slice(-4), ['kimi', 'codebuddy', 'qoder', 'kiro'])
  assert.equal(AGENTS.length, 13)
  for (const [name, root] of [
    ['kimi', KIMI_ROOT], ['codebuddy', CODEBUDDY_ROOT], ['qoder', QODER_ROOT], ['kiro', KIRO_ROOT],
  ] as const) {
    const a = AGENTS.find((x) => x.name === name)
    assert.ok(a !== undefined, `缺适配器 ${name}`)
    assert.equal(a.root, root, `${name} root 必须吃 HANDOFF_ROOT_${name.toUpperCase()} 覆盖`)
    assert.equal(a.supported, true, `${name} 是纯文件布局，无 sqlite 依赖，supported 常真`)
  }
})

// ---------- kimi ----------

test('kimi discover：双会话命中，标题出自 state.json / 裸会话取首条输入，cwd 由索引兜底', () => {
  const refs = listSessions('kimi')
  assert.equal(refs.length, 2)
  const a = refOf(refs, 'session_aa000000-0000-7000-8000-000000000001')
  assert.equal(a.title, '收件箱联调', 'state.json 的 title 优先')
  assert.equal(a.cwd, 'D:\\kimi-fix\\demo')
  assert.equal(a.kind, 'file')
  assert.match(new Date(a.updatedAt).toISOString(), /^2026-09-21/, 'updatedAt 取 wire.jsonl mtime')
  // 裸会话：无 state.json → 标题 = 首条用户输入；cwd = session_index.jsonl 按 sessionId 兜底
  const b = refOf(refs, 'session_aa000000-0000-7000-8000-000000000002')
  assert.equal(b.title, 'kimi 裸会话只有 wire 流')
  assert.equal(b.cwd, 'D:\\kimi-fix\\demo2')
  // mtime 新→旧排序（A 比 B 晚写）
  assert.ok(refs.indexOf(a) < refs.indexOf(b))
})

test('kimi parse：wire 流归一 8 轮（文本/think 标记/工具调用/结果/失败标记），坏行与控制行不进 Turn', () => {
  const a = refOf(listSessions('kimi'), 'session_aa000000-0000-7000-8000-000000000001')
  const turns = readSession('kimi', a)
  assert.equal(turns.length, 8, 'user×2 + 文本 + think + 工具×2 + 结果×2')
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '帮我把 kimi 会话接管跑通')
  assert.match(turns[0]?.ts ?? '', /^2026-09-21/, 'epoch 秒自适应转 ISO')
  assert.equal(turns[1]?.text, '好的，先读 wire 流。')
  assert.equal(turns[2]?.text, '[thinking] 内部推演 kimi', 'think 块以 [thinking] 标记保留')
  assert.equal(turns[3]?.toolName, 'read_file')
  assert.equal(turns[4]?.role, 'tool')
  assert.equal(turns[4]?.toolFailed, false)
  assert.equal(turns[5]?.toolName, 'write_file')
  assert.equal(turns[6]?.toolFailed, true, 'result.isError → toolFailed')
  assert.equal(turns[6]?.text, 'disk full')
  assert.equal(turns[7]?.role, 'user')
  assert.equal(turns[7]?.text, '再跑一遍 e2e')
  for (const t of turns) {
    assert.doesNotMatch(t.text, /broken|metadata|step\./, '坏行 / 控制行不进 Turn 流')
    assert.equal(t.cwd, 'D:\\kimi-fix\\demo')
  }
})

// ---------- codebuddy ----------

test('codebuddy discover：只扫 cwd 转义目录一层（subagents decoy 不进候选），标题/cwd 出自记录头', () => {
  const refs = listSessions('codebuddy')
  assert.equal(refs.length, 1, '主会话文件一条；subagents/agent-1.jsonl 不算')
  assert.equal(refs[0]?.title, '接力联调', 'ai-title 行进 discover 标题')
  assert.equal(refs[0]?.cwd, 'D:\\codebuddy-fix\\demo')
  assert.ok(refs[0]?.id.endsWith('fx-codebuddy.jsonl'))
})

test('codebuddy parse：WorkBuddy 内核归一 6 轮，function_call_result 的 error 状态记失败', () => {
  const refs = listSessions('codebuddy')
  const turns = readSession('codebuddy', refs[0]!)
  assert.equal(turns.length, 6, 'user + assistant + 调用×2 + 结果×2；ai-title 不产生 Turn')
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '把 codebuddy 会话接管跑通')
  assert.equal(turns[1]?.role, 'assistant')
  assert.equal(turns[1]?.text, '好的，先看布局。')
  assert.equal(turns[2]?.toolName, 'read')
  assert.equal(turns[3]?.toolFailed, false, 'status=completed 不标失败')
  assert.equal(turns[3]?.text, 'const x = 1')
  assert.equal(turns[5]?.toolName, 'write')
  assert.equal(turns[5]?.toolFailed, true, 'status=error → toolFailed')
  assert.equal(turns[5]?.text, 'disk full')
  for (const t of turns) assert.equal(t.cwd, 'D:\\codebuddy-fix\\demo', 'cwd 取自记录本身')
})

// ---------- qoder ----------

test('qoder discover：项目目录一层命中主会话（subagents decoy 不进），ai-title 标题 + realCwd', () => {
  const refs = listSessions('qoder')
  assert.equal(refs.length, 1, '主会话文件一条；fx-qoder/subagents/ 不算')
  assert.equal(refs[0]?.title, '体检联调')
  assert.equal(refs[0]?.cwd, 'D:\\qoder-fix\\demo', 'cwd 取自记录本身（目录名不反解、不猜）')
})

test('qoder parse：Claude 同族记录复用归一（文本轮 + 工具轮 + 结果轮），模型字段透传', () => {
  const refs = listSessions('qoder')
  const turns = readSession('qoder', refs[0]!)
  assert.equal(turns.length, 4)
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '把 qoder 会话接管跑通')
  assert.equal(turns[1]?.text, '好的，先读入口。')
  assert.equal(turns[1]?.model, 'qoder-model')
  assert.equal(turns[2]?.toolName, 'Read')
  assert.equal(turns[3]?.role, 'tool')
  assert.equal(turns[3]?.text, 'const x = 1')
})

// ---------- kiro ----------

test('kiro discover：只认 <uuid>.jsonl（伴生 .json / .history / 孤儿 header 不进候选）', () => {
  const refs = listSessions('kiro')
  assert.equal(refs.length, 1, '三个 decoy 文件全部不发现')
  assert.ok(refs[0]?.id.endsWith('.jsonl'))
  assert.equal(refs[0]?.title, '把 kiro 会话接管跑通', '标题出自正文首条 Prompt（伴生 .json 的 title 不读）')
  assert.equal(refs[0]?.cwd, '', '事件流没有 cwd 字段 → 如实留空')
})

test('kiro parse：Prompt / AssistantMessage / ToolResults 归一 5 轮，status=error 记失败', () => {
  const refs = listSessions('kiro')
  const turns = readSession('kiro', refs[0]!)
  assert.equal(turns.length, 5, 'user + 文本 + 工具调用 + 工具结果 + 文本')
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '把 kiro 会话接管跑通')
  assert.equal(turns[1]?.text, '先看事件流。')
  assert.equal(turns[2]?.toolName, 'shell')
  assert.match(turns[2]?.text ?? '', /npm test/, 'toolUse 成摘要轮（永不回放）')
  assert.equal(turns[3]?.role, 'tool')
  assert.equal(turns[3]?.toolFailed, true, 'status=error → toolFailed')
  assert.match(turns[3]?.text ?? '', /FAIL/, 'toolResult 的 text/json 块拼正文')
  assert.match(turns[3]?.ts ?? '', /^2026-09-21/, 'meta.timestamp epoch 秒自适应')
  assert.equal(turns[4]?.text, '测试红了，先修。')
})

// ---------- 接线（工具轴 / 注册表轴 / 交接目标轴） ----------

test('接线：FOREIGN_PROVIDERS 十三家带四家，adapter 映射同名，四家不进 OUTBOUND_TARGETS', () => {
  for (const p of ['kimi', 'codebuddy', 'qoder', 'kiro'] as const) {
    assert.ok(FOREIGN_PROVIDERS.includes(p), `缺 ${p}`)
    assert.equal(PROVIDER_TO_ADAPTER[p], p, `${p} 的适配器与 provider 同名`)
    assert.ok(!(OUTBOUND_TARGETS as readonly string[]).includes(p), `${p} 不进交接目标轴`)
  }
  assert.equal(FOREIGN_PROVIDERS.length, 13)
})

test('接线：foreignSessionRead 用真实适配器走通 kimi list / qoder show（标题关键词命中）', async () => {
  const listed = await foreignSessionRead({ provider: 'kimi', action: 'list', limit: 5 })
  assert.equal(listed.ok, true)
  if (!listed.ok || listed.action !== 'list') return
  assert.equal(listed.total, 2)
  assert.equal(listed.sessions[0]?.title, '收件箱联调')
  assert.equal(listed.sessions[0]?.turns, 2, '主会话的用户轮数（info/坏行不计数）')
  const shown = await foreignSessionRead({ provider: 'qoder', action: 'show', reference: '体检联调' })
  assert.equal(shown.ok, true)
  if (!shown.ok || shown.action !== 'show') return
  assert.equal(shown.summary.turnCount, 4)
  assert.equal(shown.summary.cwd, 'D:\\qoder-fix\\demo')
  assert.equal(shown.summary.firstUserMessage, '把 qoder 会话接管跑通')
})

// ---------- 根缺省降级（放最后：fixture 会被删除/清空） ----------

test('根缺省降级：删根 → 空列表不抛（正常静默）；空根 → 假 0 哨兵 note，supported 仍真', () => {
  for (const [name, root] of [
    ['kimi', KIMI_ROOT], ['codebuddy', CODEBUDDY_ROOT], ['qoder', QODER_ROOT], ['kiro', KIRO_ROOT],
  ] as const) {
    const adapter = AGENTS.find((a) => a.name === name)
    assert.ok(adapter !== undefined)
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(listSessions(name), [], `${name} 根缺省 = 正常静默空列表`)
    assert.equal(adapter.supported, true, '纯文件布局不因根缺省变 unsupported')
    mkdirSync(root, { recursive: true })
    assert.deepEqual(listSessions(name), [], `${name} 空根 = 0 会话`)
    assert.match(
      adapter.note ?? '',
      /存储目录存在但未发现会话/,
      `${name} 触发假 0 哨兵（盲写布局迁移的防线）`,
    )
  }
})
