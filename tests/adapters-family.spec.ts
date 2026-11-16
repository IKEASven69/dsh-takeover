/**
 * 适配器收尾四家（qwen / antigravity / openclaw / goose）真实适配器 fixture：
 * HANDOFF_ROOT_<名> 指向临时合成目录，discover 命中 + parse 归一 Turn + 根缺省降级
 * + note 诚实标注。（jsonl-family / sqlite-file-family 同手法：适配器在模块加载时读
 * 根路径，env 必须先于 readers 首次加载，因此对 readers 的值导入放在 env 之后动态
 * await import；另外把 USERPROFILE / APPDATA 一并指向临时根——win32 的 os.homedir()
 * 与 goose 的 %APPDATA% 候选都在调用时读这两个变量，避免真实 home 的同名目录把
 * fixture 计数冲脏。fixture 布局出处（全部 2026-11 当日对上游核实）：
 * qwen = QwenLM/qwen-code storage-paths-lite.ts + storage.ts + chatRecordingService.ts
 * （新 projects/<cwd>/chats/<sessionId>.jsonl ChatRecord 树记录；旧 tmp/<hash>/chats/
 * 是 Gemini 族遗产——v0.0.14 源码核实连类型名都是 user/gemini），
 * antigravity = dpavlin/agy-explore（conversation_summaries.db 表结构 + transcript
 * 行法 + <USER_REQUEST> 壳）+ mjacobs/agy-reader / fliberty 实测（brain 双布局），
 * openclaw = openclaw/openclaw docs/concepts/session.md「Where state lives」+
 * src/state/openclaw-agent-schema.sql（session_nodes / transcript_events）+
 * qa/scenarios/jsonl-replay 实录 fixture（{message:{role,content}} 行），
 * goose = aaif-goose/goose session_manager.rs（sessions.db 建表语句）+ legacy.rs
 * 实录 fixture（首行元数据 + {role,created,content[{type:text}]} 行）+ config/paths.rs
 * （etcetera 候选推导）。
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FOREIGN_PROVIDERS, PROVIDER_TO_ADAPTER, foreignSessionRead } from '../src/foreign.ts'
import { OUTBOUND_TARGETS } from '../src/browser-view.ts'
import type { SessionRef } from '@agent-handoff/readers'

// ---------- env 先于 readers 首次加载（模块加载时读根路径） ----------

const FAMILY_ROOT = mkdtempSync(join(tmpdir(), 'dsh-adapters-family-'))
const QWEN_ROOT = join(FAMILY_ROOT, '.qwen')
const ANTIGRAVITY_ROOT = join(FAMILY_ROOT, '.gemini', 'antigravity-cli')
const OPENCLAW_ROOT = join(FAMILY_ROOT, '.openclaw')
const GOOSE_ROOT = join(FAMILY_ROOT, '.goose')
process.env['HANDOFF_ROOT_QWEN'] = QWEN_ROOT
process.env['HANDOFF_ROOT_ANTIGRAVITY'] = ANTIGRAVITY_ROOT
process.env['HANDOFF_ROOT_OPENCLAW'] = OPENCLAW_ROOT
process.env['HANDOFF_ROOT_GOOSE'] = GOOSE_ROOT
// homedir() 与 %APPDATA% 同步指向临时根（win32 两者都在调用时读 env）：固定 goose
// 候选扫描与 antigravity 第二 brain 候选（IDE 布局），fixture 不落真实 home
process.env['USERPROFILE'] = FAMILY_ROOT
process.env['APPDATA'] = join(FAMILY_ROOT, 'appdata')
const readers = await import('@agent-handoff/readers')
const { AGENTS, listSessions, readSession, parseQwenText, parseQwenSession, parseAntigravityTranscriptText, parseOpenclawTranscriptText, parseOpenclawSession, parseGooseSession, parseGooseLegacyText, resolveGooseRoot } = readers
after(() => { try { rmSync(FAMILY_ROOT, { recursive: true, force: true }) } catch { /* 临时目录尽力清 */ } })

// ---------- fixture 合成（照各家真实布局） ----------

const SEC = 1790000000 // 2026-09-21T14:13:20Z（goose / openclaw 的时间戳基线）
const MS = SEC * 1000
const ISO = '2026-11-01T01:00:00.000Z'

function write(path: string, data: string, mtimeMs = MS): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data, 'utf-8')
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000) // 布局里没有文件内时间的字段靠 mtime 排序
}

/** qwen：三份会话——旧 .json（Gemini 族整块）、旧 .jsonl（Gemini 族流式）、新 ChatRecord JSONL */
function buildQwenFixture(): void {
  // 旧布局 tmp/<hash>/chats/session-*.json：metadata + messages 单对象（summary 作标题）
  write(join(QWEN_ROOT, 'tmp', 'hashlegacy', 'chats', 'session-20261101T1200-abc12345.json'), JSON.stringify({
    sessionId: 'gs-1', projectHash: 'hashlegacy', startTime: ISO, lastUpdated: '2026-11-01T02:00:00.000Z', summary: 'qwen 旧格式联调',
    messages: [
      { type: 'user', content: '帮我把 qwen 旧会话跑通', timestamp: ISO },
      { type: 'gemini', content: [{ text: '好的，先看旧格式。' }], model: 'qwen-legacy', timestamp: '2026-11-01T01:01:00.000Z' },
    ],
  }), MS + 3000)
  // 旧布局流式 .jsonl：metadata 行 + 控制行 + 消息行（gemini 同族）
  write(join(QWEN_ROOT, 'tmp', 'hashlegacy', 'chats', 'session-20261101T1300-def67890.jsonl'), [
    JSON.stringify({ type: 'metadata', sessionId: 'gs-2', startTime: ISO, lastUpdated: '2026-11-01T03:00:00.000Z', summary: 'qwen 流式旧格式' }),
    JSON.stringify({ $patch: {} }),
    JSON.stringify({ type: 'user', content: '流式旧格式一行', timestamp: '2026-11-01T01:30:00.000Z' }),
    JSON.stringify({ type: 'gemini', content: '直接字符串正文', timestamp: '2026-11-01T01:31:00.000Z' }),
    '{"broken":',
  ].join('\n') + '\n', MS + 4000)
  // 新布局 projects/<cwd 转义>/chats/<sessionId>.jsonl：ChatRecord 树记录（每条带 cwd）
  const rec = (id: string, extra: Record<string, unknown>) =>
    ({ uuid: id, parentUuid: null, sessionId: 'qs-1', timestamp: ISO, cwd: 'D:\\qwen-fix\\demo', version: '0.27.0', ...extra })
  write(join(QWEN_ROOT, 'projects', 'D--qwen-fix-demo', 'chats', 'qs-1.jsonl'), [
    JSON.stringify(rec('u1', { type: 'user', message: { role: 'user', parts: [{ text: '把 qwen 会话接管跑通' }] } })),
    JSON.stringify(rec('a1', { type: 'assistant', model: 'qwen3-max', message: { role: 'assistant', parts: [{ text: '好的，先读布局。' }] } })),
    JSON.stringify(rec('a2', { type: 'assistant', model: 'qwen3-max', message: { role: 'assistant', parts: [{ thought: true, text: '内部推演 qwen' }, { functionCall: { id: 't1', name: 'read_file', args: { path: 'D:\\qwen-fix\\src\\a.ts' } } }] } })),
    JSON.stringify(rec('t1', { type: 'tool_result', toolCallResult: { status: 'error' }, message: { role: 'tool', parts: [{ functionResponse: { name: 'read_file', response: { error: 'disk full' } } }] } })),
    JSON.stringify(rec('c1', { type: 'user', subtype: 'agent_mention', message: { role: 'user', parts: [{ text: 'agent_mention 不进流' }] } })),
    JSON.stringify(rec('c2', { type: 'user', provenance: 'mod_prompt', message: { role: 'user', parts: [{ text: 'mod 提交不进流' }] } })),
    JSON.stringify(rec('c3', { type: 'system', subtype: 'chat_compression', systemPayload: { note: 'system 记录不进流' } })),
  ].join('\n') + '\n', MS + 5000)
  // 新布局 runtime sidecar 不读（<sessionId>.runtime.json 不进候选）
  write(join(QWEN_ROOT, 'projects', 'D--qwen-fix-demo', 'chats', 'qs-1.runtime.json'), JSON.stringify({ status: 'running' }), MS + 5000)
}

/** antigravity：跨端索引库（workspace 映射）+ brain 双布局 transcript（.system_generated 主形态 / logs 直下简形态） */
function buildAntigravityFixture(): void {
  mkdirSync(ANTIGRAVITY_ROOT, { recursive: true })
  const db = new DatabaseSync(join(ANTIGRAVITY_ROOT, 'conversation_summaries.db'))
  db.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT)')
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('conv-aaaa', '["file:///D:/antigravity-fix/demo"]')
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('conv-bbbb', '["file:///D:/antigravity-fix/demo2"]')
  db.close()
  const step = (offsetSec: number, extra: Record<string, unknown>) =>
    ({ created_at: new Date(SEC * 1000 + offsetSec * 1000).toISOString(), ...extra })
  // 主形态：.system_generated/logs/transcript.jsonl（agy-explore 核实；transcript_full 变体同族）
  write(join(ANTIGRAVITY_ROOT, 'brain', 'conv-aaaa', '.system_generated', 'logs', 'transcript.jsonl'), [
    JSON.stringify(step(0, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>把 antigravity 会话接管跑通</USER_REQUEST>' })),
    JSON.stringify(step(1, { source: 'MODEL', type: 'PLANNER_RESPONSE', content: '好的，先看 brain 目录。', thinking: '内部推演 antigravity' })),
    JSON.stringify(step(2, { source: 'MODEL', type: 'TOOL_EXECUTION', tool_calls: [{ name: 'read_file', args: { path: 'D:\\antigravity-fix\\src\\a.ts' } }] })),
    '{"broken":',
  ].join('\n') + '\n', MS + 6000)
  // 简形态：logs/ 直下（ask 口径布局）
  write(join(ANTIGRAVITY_ROOT, 'brain', 'conv-bbbb', 'logs', 'transcript.jsonl'), [
    JSON.stringify(step(3, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'antigravity 简形态会话' })),
  ].join('\n') + '\n', MS + 7000)
  // 无 transcript 的 brain 目录（孤儿会话目录不进候选）
  mkdirSync(join(ANTIGRAVITY_ROOT, 'brain', 'conv-orphan'), { recursive: true })
}

/** openclaw：新版 sqlite（session_nodes + transcript_events）+ 旧版索引/JSONL + 索引缺席目录扫描兜底 */
function buildOpenclawFixture(): void {
  mkdirSync(join(OPENCLAW_ROOT, 'agents', 'main', 'agent'), { recursive: true })
  const db = new DatabaseSync(join(OPENCLAW_ROOT, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'))
  db.exec('CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, label TEXT, display_name TEXT, entry_json TEXT, updated_at INTEGER)')
  db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)')
  db.prepare('INSERT INTO session_nodes VALUES (?, ?, ?, ?, ?, ?)').run('main-session', 'sess-1', 'openclaw 联调', null, '{"subject":"entry 键不覆盖 label"}', MS + 2000)
  db.prepare('INSERT INTO session_nodes VALUES (?, ?, ?, ?, ?, ?)').run('group-2', 'sess-2', null, null, '{"label":"entry_json 标题兜底"}', MS + 1000)
  const ev = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?)')
  ev.run('sess-1', 1, JSON.stringify({ message: { role: 'user', content: '把 openclaw 会话接管跑通' } }), MS)
  ev.run('sess-1', 2, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: '好的，先读库。' }] } }), MS + 1000)
  ev.run('sess-1', 3, JSON.stringify({ 'not-a-message': true }), MS + 1500) // 非消息事件静默跳过
  db.close()
  // 旧版：sessions.json 索引 + <sessionId>.jsonl（pi 族 {type:'session'} 头行给 cwd）
  write(join(OPENCLAW_ROOT, 'agents', 'legacy', 'sessions', 'sessions.json'), JSON.stringify([
    { sessionId: 'oc-old-1', label: '旧版索引联调', updatedAt: MS + 3000 },
    { sessionId: 'oc-missing', label: '索引有文件无' },
  ]), MS + 6000)
  write(join(OPENCLAW_ROOT, 'agents', 'legacy', 'sessions', 'oc-old-1.jsonl'), [
    JSON.stringify({ type: 'session', cwd: 'D:\\openclaw-fix\\demo' }),
    JSON.stringify({ message: { role: 'user', content: '旧版 openclaw 流' } }),
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: '好的，读旧版。' }] } }),
    '{"broken":',
  ].join('\n') + '\n', MS + 8000)
  // 索引缺席 → 目录扫描兜底（标题出自正文首条用户输入）
  write(join(OPENCLAW_ROOT, 'agents', 'fallback', 'sessions', 'oc-scan.jsonl'), [
    JSON.stringify({ message: { role: 'user', content: '索引缺席兜底扫描' } }),
  ].join('\n') + '\n', MS + 9000)
}

/** goose：新版 sessions.db（sessions + messages，goose 真实列名）+ 旧版时间戳 .jsonl */
function buildGooseFixture(): void {
  mkdirSync(join(GOOSE_ROOT, 'sessions'), { recursive: true })
  const db = new DatabaseSync(join(GOOSE_ROOT, 'sessions', 'sessions.db'))
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT, created_at INTEGER, updated_at INTEGER)')
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content_json TEXT, created_timestamp INTEGER)')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('goose-1', 'goose 联调', 'D:\\goose-fix\\demo', MS - 1000, MS + 2000)
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('goose-2', '', 'D:\\goose-fix\\demo', MS - 500, MS - 100)
  const msg = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
  msg.run(1, 'goose-1', 'user', JSON.stringify([{ type: 'text', text: '把 goose 会话接管跑通' }]), SEC)
  msg.run(2, 'goose-1', 'assistant', JSON.stringify([{ type: 'text', text: '好的，先看库。' }]), SEC + 1)
  msg.run(3, 'goose-1', 'model', JSON.stringify([{ type: 'text', text: '品牌角色别名' }]), SEC + 2) // goose Role::Model → assistant
  db.close()
  write(join(GOOSE_ROOT, 'sessions', '20261101_120000.jsonl'), [
    JSON.stringify({ description: '旧版 goose 会话', id: '20261101_120000', created_at: '2026-11-01T12:00:00Z', updated_at: '2026-11-01T12:30:00Z', message_count: 2 }),
    JSON.stringify({ id: 'm1', role: 'user', created: SEC, content: [{ type: 'text', text: '旧版 goose 流' }] }),
    JSON.stringify({ id: 'm2', role: 'assistant', created: SEC + 1, content: [{ type: 'text', text: '好的，读旧版。' }] }),
    '{"broken":',
  ].join('\n') + '\n', MS + 7000)
}

buildQwenFixture()
buildAntigravityFixture()
buildOpenclawFixture()
buildGooseFixture()

/** 按 id 前缀取 SessionRef（discover 已按新→旧排序） */
function refOf(refs: SessionRef[], prefix: string): SessionRef {
  const hit = refs.find((r) => r.id.replace(/\\/g, '/').includes(prefix))
  assert.ok(hit !== undefined, `缺会话 ${prefix}`)
  return hit
}

// ---------- AGENTS 注册 ----------

test('收尾四家在册：AGENTS 末尾追加（声明序 qwen→goose，19..22），root 指向 HANDOFF_ROOT_<名>', () => {
  assert.deepEqual(AGENTS.map((a) => a.name).slice(-4), ['qwen', 'antigravity', 'openclaw', 'goose'])
  assert.equal(AGENTS.length, 23)
  for (const [name, root] of [
    ['qwen', QWEN_ROOT], ['antigravity', ANTIGRAVITY_ROOT], ['openclaw', OPENCLAW_ROOT], ['goose', GOOSE_ROOT],
  ] as const) {
    const a = AGENTS.find((x) => x.name === name)
    assert.ok(a !== undefined, `缺适配器 ${name}`)
    assert.equal(a.root, root, `${name} root 必须吃 HANDOFF_ROOT_${name.toUpperCase()} 覆盖`)
    assert.equal(a.supported, true, `${name} 在 env 直指下可用`)
  }
})

// ---------- qwen ----------

test('qwen discover：双布局三会话命中（旧 .json / 旧 .jsonl / 新 ChatRecord），runtime sidecar 不进候选', () => {
  const refs = listSessions('qwen')
  assert.equal(refs.length, 3)
  const legacyJson = refOf(refs, 'session-20261101T1200-abc12345.json')
  assert.equal(legacyJson.title, 'qwen 旧格式联调', '整块 .json 的 summary 字段作标题')
  const legacyJsonl = refOf(refs, 'session-20261101T1300-def67890.jsonl')
  assert.equal(legacyJsonl.title, 'qwen 流式旧格式', '流式 .jsonl 头部窗口抠 metadata.summary')
  const modern = refOf(refs, 'qs-1.jsonl')
  assert.equal(modern.title, '把 qwen 会话接管跑通', '新布局标题 = 首条用户输入前 40 字')
  assert.equal(modern.cwd, 'D:\\qwen-fix\\demo', 'cwd 取自 ChatRecord 记录本身')
  assert.equal(refs.filter((r) => r.id.endsWith('.runtime.json')).length, 0, 'runtime sidecar 不进候选')
  // 新→旧排序：文件内 lastUpdated 优先于 mtime（gemini 族口径）——流式 03:00 > 整块 02:00 > 新布局 mtime
  assert.deepEqual(refs.map((r) => r.title), ['qwen 流式旧格式', 'qwen 旧格式联调', '把 qwen 会话接管跑通'])
})

test('qwen parse：新 ChatRecord 归一 5 轮（thinking 标记 / 工具调用 / 失败标记），控制 subtype 与 mod 提交不进流', () => {
  const turns = readSession('qwen', refOf(listSessions('qwen'), 'qs-1.jsonl'))
  assert.equal(turns.length, 5, 'user + 文本 + thinking + 工具调用 + 工具结果')
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '把 qwen 会话接管跑通')
  assert.equal(turns[1]?.text, '好的，先读布局。')
  assert.equal(turns[1]?.model, 'qwen3-max', 'model 字段透传')
  assert.equal(turns[2]?.text, '[thinking] 内部推演 qwen', 'thought 块以 [thinking] 标记保留')
  assert.equal(turns[3]?.toolName, 'read_file')
  assert.equal(turns[4]?.role, 'tool')
  assert.equal(turns[4]?.toolFailed, true, 'toolCallResult.status=error → toolFailed')
  assert.equal(turns[4]?.text, 'disk full', 'response.error 兜底成结果正文')
  for (const t of turns) {
    assert.doesNotMatch(t.text, /agent_mention|mod 提交|system 记录|broken/, '控制 subtype / 代提交 / system / 坏行不进 Turn 流')
    assert.equal(t.cwd, 'D:\\qwen-fix\\demo')
  }
})

test('qwen parse：旧 Gemini 族两格式复用 gemini 归一（整块 .json 走 parseGeminiJson、流式 .jsonl 控制行跳过）', () => {
  const jsonTurns = readSession('qwen', refOf(listSessions('qwen'), 'session-20261101T1200-abc12345.json'))
  assert.equal(jsonTurns.length, 2, 'user + gemini 各一轮')
  assert.equal(jsonTurns[0]?.text, '帮我把 qwen 旧会话跑通')
  assert.equal(jsonTurns[1]?.text, '好的，先看旧格式。')
  assert.equal(jsonTurns[1]?.model, 'qwen-legacy')
  const jsonlTurns = readSession('qwen', refOf(listSessions('qwen'), 'session-20261101T1300-def67890.jsonl'))
  assert.equal(jsonlTurns.length, 2)
  assert.equal(jsonlTurns[1]?.text, '直接字符串正文', 'content 字符串形态直取')
  for (const t of jsonlTurns) assert.doesNotMatch(t.text, /broken|\$patch/, '坏行与控制行不进流')
  // 纯函数钩子：parseQwenText 双形态分派与 parseQwenSession 路径入口同源
  assert.deepEqual(parseQwenSession(refOf(listSessions('qwen'), 'abc12345.json').id), jsonTurns)
  assert.deepEqual(parseQwenText('{"type":"user","content":"独行"}', ''), [{ role: 'user', text: '独行', cwd: '', ts: '', toolName: '', toolFailed: false, model: '' }])
  assert.deepEqual(parseQwenText('{"broken":'), [])
})

// ---------- antigravity ----------

test('antigravity discover：brain 双布局命中（孤儿目录不进），cwd 出自跨端索引库 workspace_uris', () => {
  const refs = listSessions('antigravity')
  assert.equal(refs.length, 2, 'conv-orphan 无 transcript 不算')
  const a = refOf(refs, 'conv-aaaa')
  assert.equal(a.title, '把 antigravity 会话接管跑通', '标题 = 首条用户输入（索引库没有标题列）')
  assert.equal(a.cwd, 'D:/antigravity-fix/demo', 'workspace_uris JSON 数组首项 file:// 解码')
  const b = refOf(refs, 'conv-bbbb')
  assert.equal(b.title, 'antigravity 简形态会话')
  assert.equal(b.cwd, 'D:/antigravity-fix/demo2', 'logs/ 直下简形态同样命中')
  assert.equal(a.kind, 'file')
})

test('antigravity parse：USER_EXPLICIT 剥壳 + thinking 标记 + tool_calls 摘要轮，坏行不进流', () => {
  const turns = readSession('antigravity', refOf(listSessions('antigravity'), 'conv-aaaa'))
  assert.equal(turns.length, 4, 'user + thinking + assistant + 工具调用')
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '把 antigravity 会话接管跑通', '<USER_REQUEST> 壳剥离（agy-explore 同口径）')
  assert.equal(turns[1]?.text, '[thinking] 内部推演 antigravity', 'thinking 在该步正文之前')
  assert.equal(turns[2]?.text, '好的，先看 brain 目录。')
  assert.equal(turns[3]?.toolName, 'read_file', 'tool_calls 原生名直透（永不回放）')
  for (const t of turns) {
    assert.doesNotMatch(t.text, /broken/)
    assert.equal(t.cwd, 'D:/antigravity-fix/demo', 'parse 期 cwd 也出自索引库映射')
  }
  assert.deepEqual(parseAntigravityTranscriptText('{"broken":'), [], '纯函数钩子：坏 JSONL = 空流')
})

// ---------- openclaw ----------

test('openclaw discover：新版 sqlite + 旧版索引 + 目录扫描兜底三源齐发，索引缺席条目不复活', () => {
  const refs = listSessions('openclaw')
  assert.equal(refs.length, 4, 'sqlite×2 + 旧版索引×1 + 兜底扫描×1；oc-missing 无文件不进')
  const s1 = refOf(refs, 'sess-1')
  assert.equal(s1.title, 'openclaw 联调', 'label 列优先')
  assert.equal(s1.kind, 'sqlite', '新版形态 kind=sqlite')
  const s2 = refOf(refs, 'sess-2')
  assert.equal(s2.title, 'entry_json 标题兜底', 'label/display_name 缺席时 entry_json 兜底')
  const old1 = refOf(refs, 'oc-old-1')
  assert.equal(old1.title, '旧版索引联调', 'sessions.json 索引 label 作标题')
  assert.equal(old1.kind, 'file')
  const scan = refOf(refs, 'oc-scan')
  assert.equal(scan.title, '索引缺席兜底扫描', '兜底扫描标题出自正文首条用户输入')
})

test('openclaw parse：sqlite transcript_events 只取消息事件；旧版 JSONL 吃 {type:session} 头行 cwd', () => {
  const s1Turns = readSession('openclaw', refOf(listSessions('openclaw'), 'sess-1'))
  assert.equal(s1Turns.length, 2, 'user + assistant；not-a-message 事件跳过')
  assert.equal(s1Turns[0]?.text, '把 openclaw 会话接管跑通')
  assert.equal(s1Turns[1]?.text, '好的，先读库。', 'content 块数组取 text')
  const oldTurns = readSession('openclaw', refOf(listSessions('openclaw'), 'oc-old-1'))
  assert.equal(oldTurns.length, 2)
  assert.equal(oldTurns[0]?.text, '旧版 openclaw 流')
  for (const t of oldTurns) {
    assert.equal(t.cwd, 'D:\\openclaw-fix\\demo', 'pi 族头行 cwd 透传')
    assert.doesNotMatch(t.text, /broken/)
  }
  // 注入式 parse（单测钩子）与 readSession 同源同结果；未知 id = 空流不抛
  assert.deepEqual(parseOpenclawSession('sess-1', join(OPENCLAW_ROOT, 'agents', 'main', 'agent', 'openclaw-agent.sqlite')), s1Turns)
  assert.deepEqual(parseOpenclawSession('nope', join(OPENCLAW_ROOT, 'agents', 'main', 'agent', 'openclaw-agent.sqlite')), [])
  assert.deepEqual(parseOpenclawTranscriptText('{"broken":'), [])
})

// ---------- goose ----------

test('goose discover：sessions.db 命中（working_dir 列探测，空 name 回 id 前缀）+ 旧版 .jsonl 元数据标题', () => {
  const refs = listSessions('goose')
  assert.equal(refs.length, 3, 'db 两会话 + 旧版 JSONL 一会话')
  const a = refOf(refs, 'goose-1')
  assert.equal(a.title, 'goose 联调')
  assert.equal(a.cwd, 'D:\\goose-fix\\demo', 'working_dir 列名探测命中（sqlite-common 候选已含）')
  assert.equal(a.kind, 'sqlite')
  assert.equal(a.updatedAt, MS + 2000, 'updated_at epoch 毫秒原样透出')
  const b = refOf(refs, 'goose-2')
  assert.equal(b.title, 'goose-2', 'name 列空串回 id 前缀（zcode 同款）')
  const legacy = refOf(refs, '20261101_120000.jsonl')
  assert.equal(legacy.title, '旧版 goose 会话', '首行元数据 description 作标题')
  assert.equal(legacy.updatedAt, Date.parse('2026-11-01T12:30:00Z'), 'updated_at ISO 自适应优先于 mtime')
})

test('goose parse：db content_json 解 text 块（Role::Model 别名→assistant）；旧版首行元数据跳过、created epoch 转 ISO', () => {
  const turns = readSession('goose', refOf(listSessions('goose'), 'goose-1'))
  assert.equal(turns.length, 3, 'user + assistant + 品牌角色别名')
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '把 goose 会话接管跑通')
  assert.match(turns[0]?.ts ?? '', /^2026-09-21/, 'created_timestamp epoch 秒转 ISO')
  assert.equal(turns[2]?.role, 'assistant', 'role=model 是 assistant 别名（copilot 同款口径）')
  assert.deepEqual(parseGooseSession('goose-1', join(GOOSE_ROOT, 'sessions', 'sessions.db')), turns, '注入式 parse 与 readSession 同源')
  assert.deepEqual(parseGooseSession('nope', join(GOOSE_ROOT, 'sessions', 'sessions.db')), [])
  const legacyTurns = readSession('goose', refOf(listSessions('goose'), '20261101_120000.jsonl'))
  assert.equal(legacyTurns.length, 2)
  assert.equal(legacyTurns[0]?.text, '旧版 goose 流')
  assert.equal(legacyTurns[1]?.text, '好的，读旧版。')
  for (const t of legacyTurns) {
    assert.doesNotMatch(t.text, /broken|message_count/)
    assert.match(t.ts ?? '', /^2026-09-21/, 'created epoch 秒自适应')
  }
  assert.deepEqual(parseGooseLegacyText('{"broken":'), [])
})

test('goose resolveGooseRoot 测试钩子：env 直指优先；env 撤销且候选全不命中 → null（诚实扫描）', () => {
  assert.equal(resolveGooseRoot(), GOOSE_ROOT, 'env 在册时直指返回')
  const saved = process.env['HANDOFF_ROOT_GOOSE']
  delete process.env['HANDOFF_ROOT_GOOSE']
  try {
    assert.equal(resolveGooseRoot(), null, 'USERPROFILE/APPDATA 已指临时根 + 本机无 Goose 候选 → 候选扫描诚实回 null（supported=false + note 的静态口径）')
  } finally {
    if (saved !== undefined) process.env['HANDOFF_ROOT_GOOSE'] = saved
  }
})

// ---------- 接线（工具轴 / 注册表轴 / 交接目标轴） ----------

test('接线：FOREIGN_PROVIDERS 二十三家带四家，adapter 映射同名，四家不进 OUTBOUND_TARGETS', () => {
  for (const p of ['qwen', 'antigravity', 'openclaw', 'goose'] as const) {
    assert.ok(FOREIGN_PROVIDERS.includes(p), `缺 ${p}`)
    assert.equal(PROVIDER_TO_ADAPTER[p], p, `${p} 的适配器与 provider 同名`)
    assert.ok(!(OUTBOUND_TARGETS as readonly string[]).includes(p), `${p} 不进交接目标轴`)
  }
  assert.equal(FOREIGN_PROVIDERS.length, 23)
})

test('接线：foreignSessionRead 用真实适配器走通 goose list / antigravity show（标题关键词命中）', async () => {
  const listed = await foreignSessionRead({ provider: 'goose', action: 'list', limit: 5 })
  assert.equal(listed.ok, true)
  if (!listed.ok || listed.action !== 'list') return
  assert.equal(listed.total, 3)
  assert.equal(listed.sessions[0]?.title, '旧版 goose 会话')
  assert.equal(listed.sessions[0]?.turns, 1, '旧版会话用户轮数（元数据行/坏行不计数）')
  const shown = await foreignSessionRead({ provider: 'antigravity', action: 'show', reference: '把 antigravity 会话接管跑通' })
  assert.equal(shown.ok, true)
  if (!shown.ok || shown.action !== 'show') return
  assert.equal(shown.summary.turnCount, 4)
  assert.equal(shown.summary.cwd, 'D:/antigravity-fix/demo')
  assert.equal(shown.summary.firstUserMessage, '把 antigravity 会话接管跑通')
})

// ---------- 根缺省降级（放最后：fixture 会被删除/清空） ----------

test('根缺省降级：删根 → 空列表不抛；空根 → 假 0 哨兵 note，supported 不翻转', () => {
  for (const [name, root, emptyDir] of [
    ['qwen', QWEN_ROOT, QWEN_ROOT], ['antigravity', ANTIGRAVITY_ROOT, join(ANTIGRAVITY_ROOT, 'brain')],
    ['openclaw', OPENCLAW_ROOT, join(OPENCLAW_ROOT, 'agents')], ['goose', GOOSE_ROOT, join(GOOSE_ROOT, 'sessions')],
  ] as const) {
    const adapter = AGENTS.find((a) => a.name === name)
    assert.ok(adapter !== undefined)
    const supportedBefore = adapter.supported
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(listSessions(name), [], `${name} 根缺省 = 正常静默空列表`)
    assert.equal(adapter.supported, supportedBefore, `${name} 不因根缺省翻转 supported（goose 的 supported 取决于加载期候选探测）`)
    mkdirSync(emptyDir, { recursive: true })
    assert.deepEqual(listSessions(name), [], `${name} 空根 = 0 会话`)
    assert.match(
      adapter.note ?? '',
      /存储目录存在但未发现会话/,
      `${name} 触发假 0 哨兵（盲写布局迁移的防线）`,
    )
  }
})
