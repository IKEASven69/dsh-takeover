/**
 * 0.25 sqlite/文件族扩容六家（copilot / devin / mimo / aider / cline / continue）
 * 真实适配器 fixture：HANDOFF_ROOT_<名> 指向临时合成目录，discover 命中 + parse
 * 归一 Turn + 根缺省降级 + note 诚实标注。（jsonl-family 同手法：适配器在模块加载时
 * 读根路径，env 必须先于 readers 首次加载，因此对 readers 的值导入放在 env 之后
 * 动态 await import；fixture 布局出处：copilot = ~/.copilot/session-store.db 明文
 * SQLite（sessions/turns 表）、devin = XDG 数据根 cli/sessions.db（sessions 表 +
 * main_chain_id 血缘，逐轮表规格未在册——fixture 如实只建 sessions 表验证诚实降级）、
 * mimo = ~/.local/share 应用数据目录 SQLite（目录名未完全核实，走候选扫描口径）、
 * aider = 项目根 .aider.chat.history.md / .aider.input.history 半结构化 markdown、
 * cline = VS Code 变体 globalStorage tasks/<taskId>/api_conversation_history.json
 * （Anthropic 风格消息数组）、continue = ~/.continue/sessions 索引 + 会话文件。）
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

const FAMILY_ROOT = mkdtempSync(join(tmpdir(), 'dsh-sqlite-file-family-'))
const COPILOT_DB = join(FAMILY_ROOT, '.copilot', 'session-store.db')
const DEVIN_DB = join(FAMILY_ROOT, 'xdg-share', 'devin', 'cli', 'sessions.db')
const MIMO_DB = join(FAMILY_ROOT, '.local-share', 'mimo-code', 'mimo.db')
const AIDER_START = join(FAMILY_ROOT, 'workspace', 'proj', 'nested')
const CLINE_ROOT = join(FAMILY_ROOT, 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')
const CONTINUE_ROOT = join(FAMILY_ROOT, '.continue', 'sessions')
process.env['HANDOFF_ROOT_COPILOT'] = COPILOT_DB
process.env['HANDOFF_ROOT_DEVIN'] = DEVIN_DB
process.env['HANDOFF_ROOT_MIMO'] = MIMO_DB
process.env['HANDOFF_ROOT_AIDER'] = AIDER_START
process.env['HANDOFF_ROOT_CLINE'] = CLINE_ROOT
process.env['HANDOFF_ROOT_CONTINUE'] = CONTINUE_ROOT
const readers = await import('@agent-handoff/readers')
const { AGENTS, listSessions, readSession, parseAiderHistoryText, parseAiderInputText, parseClineConversationText, parseContinueSessionText, parseCopilotSession, parseDevinSession, parseMimoSession, resolveMimoDb } = readers
after(() => { try { rmSync(FAMILY_ROOT, { recursive: true, force: true }) } catch { /* 临时目录尽力清 */ } })

// ---------- fixture 合成（照各家真实布局） ----------

const SEC = 1790000000 // 2026-09-21T14:13:20Z
const MS = SEC * 1000
const ISO = '2026-11-01T01:00:00.000Z'

function write(path: string, data: string, mtimeMs = MS): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data, 'utf-8')
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000) // 布局里没有文件内时间的字段靠 mtime 排序
}

/** copilot：sessions + turns（列名即真实命名的探测基线：id/title/cwd/created_at/updated_at + session_id/role/content/created_at） */
function buildCopilotFixture(): void {
  mkdirSync(join(COPILOT_DB, '..'), { recursive: true })
  const db = new DatabaseSync(COPILOT_DB)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER)')
  db.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at INTEGER)')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('cp-1', 'copilot 联调', 'D:\\copilot-fix\\demo', MS - 5000, MS + 2000)
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('cp-2', null, null, MS - 4000, MS - 1000)
  const t = db.prepare('INSERT INTO turns (session_id, role, content, created_at) VALUES (?, ?, ?, ?)')
  t.run('cp-1', 'user', '帮我把 copilot 会话接管跑通', MS - 4000)
  t.run('cp-1', 'assistant', '好的，先看 session-store。', MS - 3000)
  t.run('cp-1', 'copilot', '再来一遍 e2e 输出。', MS - 2000) // 品牌角色别名 → assistant
  t.run('cp-1', 'assistant', '   ', MS - 1900) // 纯空白正文跳过
  t.run('cp-1', 'future_role', '未知角色不进流', MS - 1800)
  db.close()
}

/** devin：sessions 表（main_chain_id 血缘）——逐轮记录表规格未在册，如实只建会话表验证诚实降级 */
function buildDevinFixture(): void {
  mkdirSync(join(DEVIN_DB, '..'), { recursive: true })
  const db = new DatabaseSync(DEVIN_DB)
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, main_chain_id TEXT, updated_at TEXT)')
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('dv-1', 'devin 联调', 'D:\\devin-fix\\demo', 'chain-0009', ISO)
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('dv-2', '链式后继', 'D:\\devin-fix\\demo', 'chain-0009', '2026-11-01T02:00:00.000Z')
  db.close()
}

/** mimo：单数 session 表 + events 逐轮表（列名故意偏离基线：session/body/sender/time，验证探测自适应） */
function buildMimoFixture(): void {
  mkdirSync(join(MIMO_DB, '..'), { recursive: true })
  const db = new DatabaseSync(MIMO_DB)
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, path TEXT, created_at INTEGER)')
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, session TEXT, sender TEXT, body TEXT, time TEXT)')
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('mm-1', 'mimo 探测', 'D:\\mimo-fix\\demo', MS + 1000)
  const t = db.prepare('INSERT INTO events (session, sender, body, time) VALUES (?, ?, ?, ?)')
  t.run('mm-1', 'user', '把 mimo 会话接管跑通', ISO)
  t.run('mm-1', 'assistant', '好的，先扫候选目录。', '2026-11-01T01:01:00.000Z')
  db.close()
}

/** aider：嵌套两层项目根——proj 有 chat markdown，proj/nested 只有 input history（向上探测各自命中） */
function buildAiderFixture(): void {
  write(join(FAMILY_ROOT, 'workspace', 'proj', '.aider.chat.history.md'), [
    '# Aider chat conversation started at 2026-11-01T00:00:00',
    '',
    '> 帮我把 aider 会话接管跑通',
    '',
    '好的，先读历史文件。',
    '',
    '### 小标题不断开 assistant 正文',
    '',
    '继续同一段正文。',
    '',
    '> 再跑一遍测试',
    '',
    '测试红了，先修。',
    '',
  ].join('\n'), MS + 3000)
  write(join(AIDER_START, '.aider.input.history'), [
    '### 2026-11-01T02:00:00 ###',
    '/add a.ts',
    '_HiStOrY_V2_',
    '只留下输入历史的项目',
    '',
  ].join('\n'), MS + 4000)
}

/** cline：双任务目录——task-a 有 api 历史，task-b 空目录是 decoy（无 api 文件不进候选） */
function buildClineFixture(): void {
  write(join(CLINE_ROOT, 'task-abc00001', 'api_conversation_history.json'), JSON.stringify([
    { role: 'user', content: [{ type: 'text', text: '<task>\n把 cline 会话接管跑通\n</task>\n<environment_details>cwd 未记</environment_details>' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '内部推演 cline' },
      { type: 'text', text: '好的，先看任务目录。' },
      { type: 'tool_use', id: 'tu1', name: 'write_to_file', input: { path: 'D:\\cline-fix\\src\\a.ts' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
    { role: 'system', content: '系统提示不进流' },
  ]), MS + 5000)
  mkdirSync(join(CLINE_ROOT, 'task-xyz00002'), { recursive: true })
}

/** continue：索引 + 会话文件；索引里第二条 sessionId 没有对应文件（缺席条目不进候选） */
function buildContinueFixture(): void {
  write(join(CONTINUE_ROOT, 'sessions.json'), JSON.stringify([
    { sessionId: 'ct-1', title: 'continue 联调', date: ISO, workspace: 'file:///D:/continue-fix' },
    { sessionId: 'ct-missing', title: '索引里有但文件缺席' },
  ]), MS + 6000)
  write(join(CONTINUE_ROOT, 'ct-1.json'), JSON.stringify({
    sessionId: 'ct-1',
    title: 'continue 联调',
    history: [
      { message: { role: 'user', content: '把 continue 会话接管跑通' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: '好的，先读索引。' }, { type: 'context', item: { name: '未核实块不进流' } }] } },
      { message: { role: 'system', content: '系统提示不进流' } },
    ],
  }), MS + 7000)
}

buildCopilotFixture()
buildDevinFixture()
buildMimoFixture()
buildAiderFixture()
buildClineFixture()
buildContinueFixture()

/** 按 id 前缀取 SessionRef（discover 已按新→旧排序） */
function refOf(refs: SessionRef[], prefix: string): SessionRef {
  const hit = refs.find((r) => r.id.replace(/\\/g, '/').includes(prefix))
  assert.ok(hit !== undefined, `缺会话 ${prefix}`)
  return hit
}

// ---------- AGENTS 注册 ----------

test('sqlite/文件族六家在册：AGENTS 末尾追加（声明序 copilot→continue），root 指向 HANDOFF_ROOT_<名>', () => {
  assert.deepEqual(AGENTS.map((a) => a.name).slice(-6), ['copilot', 'devin', 'mimo', 'aider', 'cline', 'continue'])
  assert.equal(AGENTS.length, 19)
  for (const [name, root] of [
    ['copilot', COPILOT_DB], ['devin', DEVIN_DB], ['mimo', MIMO_DB],
    ['aider', AIDER_START], ['cline', CLINE_ROOT], ['continue', CONTINUE_ROOT],
  ] as const) {
    const a = AGENTS.find((x) => x.name === name)
    assert.ok(a !== undefined, `缺适配器 ${name}`)
    assert.equal(a.root, root, `${name} root 必须吃 HANDOFF_ROOT_${name.toUpperCase()} 覆盖`)
  }
})

// ---------- copilot（sqlite：sessions + turns） ----------

test('copilot discover：双会话命中（sqlite kind、标题缺省回 id 前缀），supported 随 node:sqlite', () => {
  const refs = listSessions('copilot')
  assert.equal(refs.length, 2)
  const a = refOf(refs, 'cp-1')
  assert.equal(a.title, 'copilot 联调')
  assert.equal(a.cwd, 'D:\\copilot-fix\\demo')
  assert.equal(a.kind, 'sqlite')
  assert.equal(a.updatedAt, MS + 2000, 'updated_at epoch 毫秒原样透出')
  const b = refOf(refs, 'cp-2')
  assert.equal(b.title, 'cp-2', '标题列 NULL 回 id 前缀（zcode 同款）')
  const adapter = AGENTS.find((x) => x.name === 'copilot')
  assert.equal(adapter?.supported, true, 'Node ≥22 冒烟环境 node:sqlite 必在')
  assert.equal(adapter?.note, undefined)
})

test('copilot parse：turns 归一（品牌角色别名→assistant、空白正文/未知角色跳过），dbPath 注入同结果', () => {
  const refs = listSessions('copilot')
  const turns = readSession('copilot', refOf(refs, 'cp-1'))
  assert.equal(turns.length, 3, 'user + assistant×2；空白正文与未知角色不进流')
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '帮我把 copilot 会话接管跑通')
  assert.match(turns[0]?.ts ?? '', /^2026-09-21/, 'created_at epoch 毫秒转 ISO')
  assert.equal(turns[1]?.text, '好的，先看 session-store。')
  assert.equal(turns[2]?.text, '再来一遍 e2e 输出。', 'role=copilot 是 assistant 别名')
  // 注入式 parse（单测钩子）与 readSession 同源同结果
  assert.deepEqual(parseCopilotSession('cp-1', COPILOT_DB), turns)
  assert.deepEqual(parseCopilotSession('nope', COPILOT_DB), [], '未知会话 id = 空流不抛')
  assert.deepEqual(parseCopilotSession('cp-1', join(FAMILY_ROOT, 'missing.db')), [], '库文件缺失 = 空流不抛')
})

// ---------- devin（sqlite：sessions 表 + main_chain_id 血缘） ----------

test('devin discover：sessions 表命中（main_chain_id 血缘字段在册），逐轮表缺席 → note 诚实标注、parse 恒空', () => {
  const refs = listSessions('devin')
  assert.equal(refs.length, 2, '链式会话按 sessions 表逐条展示（链首尾不合并不猜）')
  const a = refOf(refs, 'dv-2')
  assert.equal(a.title, '链式后继')
  assert.equal(a.cwd, 'D:\\devin-fix\\demo')
  assert.equal(a.kind, 'sqlite')
  assert.equal(a.updatedAt, Date.parse('2026-11-01T02:00:00.000Z'), 'ISO 字符串时间列自适应')
  const adapter = AGENTS.find((x) => x.name === 'devin')
  assert.match(
    adapter?.note ?? '',
    /未识别逐轮记录表/,
    '逐轮表规格未在册：note 必须诚实浮出（不粉饰成正常）',
  )
  assert.deepEqual(readSession('devin', a), [], '正文解析为空是预期降级')
  assert.deepEqual(parseDevinSession('dv-1', DEVIN_DB), [])
})

// ---------- mimo（sqlite：候选扫描口径 + 单数 session 表） ----------

test('mimo：HANDOFF_ROOT_MIMO 直指生效（supported=true），单数 session 表 + 偏形列名探测解析', () => {
  const refs = listSessions('mimo')
  assert.equal(refs.length, 1)
  const a = refOf(refs, 'mm-1')
  assert.equal(a.title, 'mimo 探测')
  assert.equal(a.cwd, 'D:\\mimo-fix\\demo', 'cwd 列名 path 也能探测命中')
  assert.equal(a.kind, 'sqlite')
  const turns = readSession('mimo', a)
  assert.equal(turns.length, 2, 'events 表（session/body/sender/time 偏形列名）归一 2 轮')
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '把 mimo 会话接管跑通')
  assert.equal(turns[1]?.text, '好的，先扫候选目录。')
  assert.deepEqual(parseMimoSession('mm-1', MIMO_DB), turns)
})

test('mimo resolveMimoDb 测试钩子：env 直指优先；env 撤销且候选全不命中 → null（诚实扫描）', () => {
  assert.equal(resolveMimoDb(), MIMO_DB, 'env 在册时直指返回')
  const saved = process.env['HANDOFF_ROOT_MIMO']
  delete process.env['HANDOFF_ROOT_MIMO']
  try {
    assert.equal(resolveMimoDb(), null, '本机无 MiMo 应用数据目录 → 候选扫描诚实回 null（supported=false + note 的静态口径）')
  } finally {
    if (saved !== undefined) process.env['HANDOFF_ROOT_MIMO'] = saved
  }
})

// ---------- aider（文件：项目根 markdown 历史，向上探测） ----------

test('aider discover：从起点向上探测两层项目根（chat 优先于 input），标题取首条用户输入', () => {
  const refs = listSessions('aider')
  assert.equal(refs.length, 2, 'nested（input-only）与 proj（chat）各自命中；根链上再无别家')
  // refOf 把 id 反斜杠归一成 / 再匹配——prefix 一律用正斜杠形态
  const nested = refOf(refs, 'proj/nested')
  const proj = refOf(refs, 'proj/.aider.chat.history.md')
  assert.equal(proj.title, '帮我把 aider 会话接管跑通', '首条 `> ` 行作标题（前 40 字）')
  assert.equal(proj.cwd, join(FAMILY_ROOT, 'workspace', 'proj'), 'cwd = 历史文件所在项目根（真实在册，非反解）')
  assert.equal(nested.title, 'nested', 'input-only 无标题可抠 → 回项目目录名')
  assert.ok(nested.id.endsWith('.aider.input.history'), 'input-only 会话 id = 输入历史文件')
  assert.ok(refs.indexOf(nested) < refs.indexOf(proj), 'mtime 新→旧排序（nested 更晚写）')
  const adapter = AGENTS.find((x) => x.name === 'aider')
  assert.match(adapter?.note ?? '', /半结构化/, 'note 恒标注半结构化（尽力而为口径）')
})

test('aider parse：markdown 历史归一（`> ` 聚用户轮、assistant 正文跨空行与小标题合并），input-only 走兜底', () => {
  const refs = listSessions('aider')
  const chat = readSession('aider', refOf(refs, '.aider.chat.history.md'))
  assert.equal(chat.length, 4, 'user×2 + assistant×2；会话头行不进流')
  assert.equal(chat[0]?.role, 'user')
  assert.equal(chat[0]?.text, '帮我把 aider 会话接管跑通')
  assert.equal(chat[1]?.text, '好的，先读历史文件。\n\n### 小标题不断开 assistant 正文\n\n继续同一段正文。', '空行与小标题留在 assistant 正文内')
  assert.equal(chat[2]?.text, '再跑一遍测试')
  assert.equal(chat[3]?.text, '测试红了，先修。')
  const nested = readSession('aider', refOf(refs, 'nested'))
  // makeTurn 全字段形状（cwd/ts/toolName/toolFailed/model 缺省）
  const bare = (role: 'user', text: string) => ({ role, text, cwd: '', ts: '', toolName: '', toolFailed: false, model: '' })
  assert.deepEqual(nested, [
    bare('user', '/add a.ts'),
    bare('user', '只留下输入历史的项目'),
  ], 'input 历史：### 时间戳行与 _HiStOrY_V2_ 头标记跳过，每条输入一个用户轮')
  // 纯函数钩子：会话头边界 + 坏形态容错
  assert.equal(parseAiderHistoryText('# Aider chat conversation started at x\n\n> 独行\n\n答。').length, 2)
  assert.deepEqual(parseAiderHistoryText(''), [])
  assert.deepEqual(parseAiderInputText('### ts ###\n\n_hiStOrY_V2_\nhISTORY_V2 小写变体也跳'), [
    bare('user', 'hISTORY_V2 小写变体也跳'),
  ], '头标记匹配不分大小写')
})

// ---------- cline（文件：VS Code 变体 globalStorage tasks） ----------

test('cline discover：tasks 目录命中 api 历史会话（空任务目录 decoy 不进），标题剥 <task> 壳', () => {
  const refs = listSessions('cline')
  assert.equal(refs.length, 1, 'task-xyz00002 无 api_conversation_history.json → 不进候选')
  const a = refOf(refs, 'task-abc00001')
  assert.equal(a.title, '把 cline 会话接管跑通', '首个 text 块剥 <task> 壳后取前 40 字')
  assert.equal(a.cwd, '', 'api 历史没有 cwd 字段 → 如实留空（上层有空 cwd 警告兜底）')
  assert.equal(a.kind, 'file')
})

test('cline parse：Anthropic 风格数组复用 Claude 同族归一（thinking 标记 / 工具调用 / 结果），system 与坏 JSON 降级', () => {
  const refs = listSessions('cline')
  const turns = readSession('cline', refOf(refs, 'task-abc00001'))
  assert.equal(turns.length, 5, 'user + thinking + 文本 + 工具调用 + 工具结果；system 不进流')
  assert.equal(turns[0]?.role, 'user')
  assert.match(turns[0]?.text ?? '', /<task>/, '正文忠实保留记录原样（<task> 壳只在标题剥离）')
  assert.equal(turns[1]?.text, '[thinking] 内部推演 cline')
  assert.equal(turns[2]?.text, '好的，先看任务目录。')
  assert.equal(turns[3]?.toolName, 'write_to_file', 'tool_use 原生名直透（永不回放）')
  assert.equal(turns[4]?.role, 'tool')
  assert.equal(turns[4]?.text, 'ok')
  assert.deepEqual(parseClineConversationText('{"not":"array"}'), [], '非数组 JSON = 空流')
  assert.deepEqual(parseClineConversationText('{"broken":'), [], '坏 JSON = 空流')
})

// ---------- continue（文件：sessions.json 索引 + 会话文件） ----------

test('continue discover：索引命中（缺席文件的条目跳过），file:// workspace 解码为 cwd', () => {
  const refs = listSessions('continue')
  assert.equal(refs.length, 1, '索引里 ct-missing 无对应文件 → 不进候选')
  const a = refOf(refs, 'ct-1')
  assert.equal(a.title, 'continue 联调')
  assert.equal(a.cwd, 'D:/continue-fix', 'file:/// URL 尽力解码（fileUrlToPath）')
  assert.equal(a.updatedAt, Date.parse(ISO), '索引 date 字段优先于 mtime')
  assert.equal(a.kind, 'file')
})

test('continue parse：history 消息流取 user/assistant 文本（块数组取 text 块，system 跳过）；索引缺席退化目录扫描', () => {
  const refs = listSessions('continue')
  const turns = readSession('continue', refOf(refs, 'ct-1'))
  assert.equal(turns.length, 2)
  assert.equal(turns[0]?.role, 'user')
  assert.equal(turns[0]?.text, '把 continue 会话接管跑通')
  assert.equal(turns[1]?.text, '好的，先读索引。', '块数组只取 text 部分；context 等未核实块跳过')
  assert.deepEqual(parseContinueSessionText('{"broken":'), [], '坏 JSON = 空流')
  // 索引缺席 → 目录扫描兜底（sessions.json 自身排除；索引在场时缺席条目也不复活）
  rmSync(join(CONTINUE_ROOT, 'sessions.json'))
  const scanned = listSessions('continue')
  assert.equal(scanned.length, 1)
  assert.equal(scanned[0]?.title, 'continue 联调', '兜底扫描从文件头 title 字段抠标题')
})

// ---------- 接线（工具轴 / 注册表轴 / 交接目标轴） ----------

test('接线：FOREIGN_PROVIDERS 十九家带六家，adapter 映射同名，六家不进 OUTBOUND_TARGETS', () => {
  for (const p of ['copilot', 'devin', 'mimo', 'aider', 'cline', 'continue'] as const) {
    assert.ok(FOREIGN_PROVIDERS.includes(p), `缺 ${p}`)
    assert.equal(PROVIDER_TO_ADAPTER[p], p, `${p} 的适配器与 provider 同名`)
    assert.ok(!(OUTBOUND_TARGETS as readonly string[]).includes(p), `${p} 不进交接目标轴`)
  }
  assert.equal(FOREIGN_PROVIDERS.length, 19)
})

test('接线：foreignSessionRead 用真实适配器走通 copilot list / aider show（标题关键词命中）', async () => {
  const listed = await foreignSessionRead({ provider: 'copilot', action: 'list', limit: 5 })
  assert.equal(listed.ok, true)
  if (!listed.ok || listed.action !== 'list') return
  assert.equal(listed.total, 2)
  assert.equal(listed.sessions[0]?.title, 'copilot 联调')
  assert.equal(listed.sessions[0]?.turns, 1, '主会话用户轮数（空白/未知角色不计数）')
  const shown = await foreignSessionRead({ provider: 'aider', action: 'show', reference: '帮我把 aider 会话接管跑通' })
  assert.equal(shown.ok, true)
  if (!shown.ok || shown.action !== 'show') return
  assert.equal(shown.summary.turnCount, 4)
  assert.ok(shown.summary.cwd.includes('proj'), 'aider 的 cwd 是真实项目根')
  assert.equal(shown.summary.firstUserMessage, '帮我把 aider 会话接管跑通')
})

// ---------- 根缺省降级（放最后：fixture 会被删除/清空） ----------

test('根缺省降级：删根 → 空列表不抛；文件族空根 → 假 0 哨兵 note；supported 不因缺根翻转', () => {
  // aider 单独处理：它的会话在根链沿途，删整条 workspace 链才算根缺省
  const adapter = AGENTS.find((a) => a.name === 'aider')
  assert.ok(adapter !== undefined)
  rmSync(join(FAMILY_ROOT, 'workspace'), { recursive: true, force: true })
  assert.deepEqual(listSessions('aider'), [], 'aider 根链全缺省 = 正常静默空列表')
  assert.equal(adapter.supported, true, '纯文件布局不因根缺省变 unsupported')
  assert.match(adapter.note ?? '', /半结构化/, 'aider note 恒为半结构化标注（无会话库是产品形态，不是布局迁移信号）')
  for (const [name, root, kind] of [
    ['copilot', COPILOT_DB, 'sqlite'], ['devin', DEVIN_DB, 'sqlite'], ['mimo', MIMO_DB, 'sqlite'],
    ['cline', CLINE_ROOT, 'file'], ['continue', CONTINUE_ROOT, 'file'],
  ] as const) {
    const a = AGENTS.find((x) => x.name === name)
    assert.ok(a !== undefined)
    const supportedBefore = a.supported
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(listSessions(name), [], `${name} 根缺省 = 正常静默空列表`)
    assert.equal(a.supported, supportedBefore, `${name} 不因根缺省翻转 supported`)
    if (kind === 'file') {
      // 文件族：根目录在册但无会话 → 假 0 哨兵（盲写布局迁移的防线）
      mkdirSync(root, { recursive: true })
      assert.deepEqual(listSessions(name), [], `${name} 空根 = 0 会话`)
      assert.match(a.note ?? '', /存储目录存在但未发现会话/, `${name} 触发假 0 哨兵`)
    }
  }
})
