/**
 * v0.2 测试：foreign_session_read 的 list / show / 歧义 / 降级，
 * 以及 /resume-* 九条 skill 的注册形态。
 * 大部分用例注入假货读取层（ForeignReaders），不碰真实 ~/.claude 等目录；
 * gemini（第 9 家）另有一组真实适配器用例：HANDOFF_ROOT_GEMINI 指向临时目录，
 * 本地构造 JSONL 新格式 / JSON 旧格式 / 子代理会话三层 fixture（corpus-golden
 * 同款约束：适配器在模块加载时读根路径，env 必须先于 readers 首次加载，
 * 因此本文件对 readers 的值导入放在 env 之后动态 await import）。
 */
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FOREIGN_PROVIDERS,
  RESUME_SKILL_SPECS,
  foreignSessionRead,
  renderForeign,
  resumeSkillContent,
  skillRegistrations,
  summarizeTurns,
  type ForeignReaders,
} from '../src/index.ts'
import { HANDOFF_SKILL_CONTENT, INBOX_SKILL_CONTENT } from '../skills/index.ts'
import type { SessionRef, Turn } from '@agent-handoff/readers'

// ---------- gemini 真实适配器 fixture（env 先于 readers 首次加载） ----------

const GEMINI_ROOT = mkdtempSync(join(tmpdir(), 'dsh-gemini-fix-'))
process.env['HANDOFF_ROOT_GEMINI'] = GEMINI_ROOT
const { makeTurn } = await import('@agent-handoff/readers')
after(() => { try { rmSync(GEMINI_ROOT, { recursive: true, force: true }) } catch { /* 临时目录尽力清 */ } })

const GEMINI_PROJ = join(GEMINI_ROOT, 'proj-a')
const GEMINI_CHATS = join(GEMINI_PROJ, 'chats')
const GEMINI_JSONL = join(GEMINI_CHATS, 'session-20261030-aa11.jsonl')
const GEMINI_JSON = join(GEMINI_CHATS, 'session-20261029-bb22.json')
const GEMINI_SUB = join(GEMINI_CHATS, 'p1', 'session-20261028-cc33.jsonl')

/** gemini 双格式 fixture：JSONL 新格式 + 整块 JSON 旧格式 + 子代理再嵌一层 */
function buildGeminiFixture(): void {
  mkdirSync(join(GEMINI_CHATS, 'p1'), { recursive: true })
  writeFileSync(join(GEMINI_PROJ, '.project_root'), 'D:\\gemini-fix\\demo\n', 'utf-8')
  // 新格式：首行 metadata → MessageRecord 行 + info/斜杠/控制行/未知行/坏行穿插
  writeFileSync(GEMINI_JSONL, [
    JSON.stringify({ sessionId: 'sess-gem-jsonl', startTime: '2026-10-30T01:00:00Z', lastUpdated: '2026-10-30T02:00:00Z', summary: '收件箱联调', directories: ['D:\\gemini-fix\\demo'], kind: 'main' }),
    JSON.stringify({ type: 'user', content: '帮我把 gemini 会话接管跑通', timestamp: '2026-10-30T01:01:00Z' }),
    JSON.stringify({ type: 'info', content: 'Quad service 初始化完成', timestamp: '2026-10-30T01:01:30Z' }),
    JSON.stringify({ type: 'user', content: '/help', timestamp: '2026-10-30T01:01:40Z' }),
    JSON.stringify({
      type: 'gemini', content: '好的，先读一下入口文件。', model: 'gemini-2.5-pro', timestamp: '2026-10-30T01:02:00Z',
      toolCalls: [
        { name: 'read_file', args: { path: 'D:\\gemini-fix\\demo\\src\\a.ts' }, result: 'const x = 1', status: 'ok', timestamp: '2026-10-30T01:02:10Z' },
        { name: 'run_shell_command', args: { command: 'npm test' }, result: 'all green', status: 'ok', timestamp: '2026-10-30T01:03:00Z' },
        { name: 'write_file', args: { file_path: 'D:\\gemini-fix\\demo\\src\\b.ts' }, result: 'disk full', status: 'error', timestamp: '2026-10-30T01:04:00Z' },
      ],
    }),
    '{"$patch":{}}',
    '{"type":"future-unknown","content":"向后兼容：未知类型行静默跳过"}',
    JSON.stringify({ type: 'user', content: '再跑一遍 e2e', timestamp: '2026-10-30T01:05:00Z' }),
    JSON.stringify({ type: 'gemini', content: [{ type: 'text', text: '跑完了，全绿。' }], timestamp: '2026-10-30T01:06:00Z' }),
    '{"broken":',
  ].join('\n'), 'utf-8')
  // 旧格式：整块 JSON（metadata + messages 单对象）
  writeFileSync(GEMINI_JSON, JSON.stringify({
    summary: '早班交接',
    lastUpdated: '2026-10-29T09:00:00Z',
    messages: [
      { type: 'user', content: '整理交接清单', timestamp: '2026-10-29T08:00:00Z' },
      { type: 'gemini', content: [{ type: 'text', text: '清单见下。' }], timestamp: '2026-10-29T08:01:00Z' },
    ],
  }), 'utf-8')
  // 子代理会话：chats/<parentShortId>/ 再嵌一层
  writeFileSync(GEMINI_SUB, [
    JSON.stringify({ sessionId: 'sess-gem-sub', startTime: '2026-10-28T07:00:00Z', lastUpdated: '2026-10-28T08:00:00Z', summary: '子代理调研', kind: 'subagent' }),
    JSON.stringify({ type: 'user', content: '调研向量库选型', timestamp: '2026-10-28T07:30:00Z' }),
    JSON.stringify({ type: 'gemini', content: '结论：用 zvec。', timestamp: '2026-10-28T08:00:00Z' }),
  ].join('\n'), 'utf-8')
}
buildGeminiFixture()

/** 造一个 SessionRef */
function ref(partial: Partial<SessionRef> & Pick<SessionRef, 'id' | 'agent'>): SessionRef {
  return {
    title: '',
    cwd: '',
    updatedAt: 0,
    fingerprint: '',
    kind: 'file',
    ...partial,
  }
}

const REFS: SessionRef[] = [
  ref({ id: 'sess-aaa-1111', agent: 'zcode', title: '收件箱开发', updatedAt: 3000, kind: 'sqlite' }),
  ref({ id: 'sess-bbb-2222', agent: 'zcode', title: '收件箱测试', updatedAt: 2000, kind: 'sqlite' }),
  ref({ id: 'sess-ccc-3333', agent: 'zcode', title: '方案文档', updatedAt: 1000, kind: 'sqlite' }),
]

const TURNS: Turn[] = [
  makeTurn({ role: 'user', text: '帮我把收件箱做完，测试要写全', ts: '2026-09-30T01:00:00Z' }),
  makeTurn({ role: 'assistant', text: '好的，先实现 handoff_inbox 工具。', ts: '2026-09-30T01:01:00Z' }),
  makeTurn({ role: 'assistant', text: 'Write: src/tools.ts', toolName: 'Write', ts: '2026-09-30T01:02:00Z' }),
  makeTurn({ role: 'assistant', text: 'Edit: src/index.ts', toolName: 'Edit', ts: '2026-09-30T01:03:00Z' }),
  makeTurn({ role: 'assistant', text: 'Write: src/tools.ts', toolName: 'Write', ts: '2026-09-30T01:04:00Z' }),
  makeTurn({ role: 'assistant', text: 'npm test', toolName: 'Bash', ts: '2026-09-30T01:05:00Z' }),
  makeTurn({ role: 'user', text: '顺便更新 README', ts: '2026-09-30T01:06:00Z' }),
  makeTurn({ role: 'assistant', text: '测试全绿，README 已更新，准备 commit。', ts: '2026-09-30T01:07:00Z' }),
]

/** 假货读取层：list/resolve/read 全可控 */
function fakeReaders(overrides?: Partial<ForeignReaders>): ForeignReaders {
  return {
    listSessions: () => REFS,
    resolve: (_agent, reference) => {
      const q = reference.trim()
      if (q === '' || q === 'latest') return { kind: 'resolved', ref: REFS[0]! }
      const hits = REFS.filter((r) => r.id.startsWith(q) || r.title.includes(q))
      if (hits.length === 1) return { kind: 'resolved', ref: hits[0]! }
      if (hits.length > 1) return { kind: 'ambiguous', candidates: hits }
      return { kind: 'not-found', reference }
    },
    readSession: () => TURNS,
    adapterNote: () => ({ supported: true, note: '' }),
    ...overrides,
  }
}

// ---------- list ----------

test('foreign list：返回候选（标题/时间/轮数），按 limit 截断', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'list', limit: 2 }, fakeReaders())
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'list') return
  assert.equal(r.total, 3)
  assert.equal(r.sessions.length, 2)
  assert.equal(r.sessions[0]?.title, '收件箱开发')
  assert.equal(r.sessions[0]?.turns, 2) // 假货 readSession 的 user 轮数
  assert.match(r.sessions[0]?.updatedAt ?? '', /^2026-|^\d{4}-/)
})

test('foreign list：该家零会话是规范空列表', async () => {
  const r = await foreignSessionRead({ provider: 'pi', action: 'list' }, fakeReaders({ listSessions: () => [] }))
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'list') return
  assert.equal(r.total, 0)
  assert.equal(r.sessions.length, 0)
})

test('foreign list：discover 抛错降级为规范错误值', async () => {
  const r = await foreignSessionRead({
    provider: 'codex',
    action: 'list',
  }, fakeReaders({
    listSessions: () => { throw new Error('db locked') },
  }))
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /db locked/)
})

// ---------- show ----------

test('foreign show：空引用=latest，返回结构化摘要 + 骨架素材，默认不给原文', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'show' }, fakeReaders())
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'show') return
  const s = r.summary
  assert.equal(s.sessionId, 'sess-aaa-1111')
  assert.equal(s.title, '收件箱开发')
  assert.equal(s.turnCount, TURNS.length)
  assert.equal(s.userTurns, 2)
  assert.match(s.firstUserMessage, /收件箱做完/)
  assert.match(s.lastUserMessage, /README/)
  assert.ok(s.tailProgress.length > 0)
  assert.match(s.tailProgress.at(-1) ?? '', /测试全绿/)
  // 涉及文件 top15：src/tools.ts 出现 2 次排最前
  assert.equal(s.files[0], 'src/tools.ts')
  assert.ok(s.files.includes('src/index.ts'))
  assert.ok(s.commands.some((c) => c.includes('npm test')))
  // 骨架六段素材齐全，警告含 HISTORY_REPORTED 纪律
  for (const k of ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings'] as const) {
    assert.notEqual(r.skeleton[k], '', `骨架缺段：${k}`)
  }
  assert.match(r.skeleton.warnings, /HISTORY_REPORTED/)
  // 默认不返回原文
  assert.equal(r.turns, undefined)
  assert.equal(r.turnsTotal, TURNS.length)
})

test('foreign show：显式 limit/offset 才分页吐原文', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'show', reference: 'sess-aaa', limit: 3, offset: 1 }, fakeReaders())
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'show') return
  assert.equal(r.turns?.length, 3)
  assert.equal(r.turnsOffset, 1)
  assert.equal(r.turns?.[0]?.index, 1)
  assert.equal(r.turns?.[0]?.role, 'assistant')
})

test('foreign show：引用歧义返回候选不猜', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'show', reference: '收件箱' }, fakeReaders())
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /歧义/)
  assert.equal(r.candidates?.length, 2)
})

test('foreign show：找不到引用是规范错误值', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'show', reference: 'sess-nope' }, fakeReaders())
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /找不到/)
})

test('foreign show：解析为空附 UNAVAILABLE 说明，仍是规范 ok 值', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'show' }, fakeReaders({ readSession: () => [] }))
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'show') return
  assert.equal(r.summary.turnCount, 0)
  assert.match(r.note ?? '', /UNAVAILABLE/)
})

// ---------- 降级 ----------

test('foreign：未知 provider / action 是规范错误值，不抛', async () => {
  const badProvider = await foreignSessionRead({ provider: 'emacs', action: 'list' }, fakeReaders())
  assert.equal(badProvider.ok, false)
  if (!badProvider.ok) assert.match(badProvider.error, /未知 provider/)

  const badAction = await foreignSessionRead({ provider: 'zcode', action: 'delete' }, fakeReaders())
  assert.equal(badAction.ok, false)
  if (!badAction.ok) assert.match(badAction.error, /未知 action/)
})

test('foreign：适配器不可用（如 Node<22 的 zcode）降级为规范错误值', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'list' }, fakeReaders({
    adapterNote: () => ({ supported: false, note: '需要 Node ≥22（node:sqlite 内建模块）' }),
  }))
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.match(r.error, /不可用/)
  assert.match(r.error, /Node ≥22/)
})

// ---------- gemini（第 9 家）：接线 + 真实适配器双格式 fixture ----------

test('foreign gemini：provider 门内（adapter=gemini），未知 provider 报错文案带全九家', async () => {
  // 门内：假货层记录 adapterNote 收到的 adapter 名
  const seen: string[] = []
  const r = await foreignSessionRead({ provider: 'gemini', action: 'list' }, fakeReaders({
    listSessions: (agent) => { seen.push(agent); return [] },
  }))
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'list') return
  assert.equal(r.provider, 'gemini')
  assert.deepEqual(seen, ['gemini'], 'provider 名必须原样映射到 readers 适配器名 gemini')
  // 门外：未知 provider 的报错候选列表要带上 gemini（九家文案）
  const bad = await foreignSessionRead({ provider: 'emacs', action: 'list' }, fakeReaders())
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.error, /gemini/)
})

test('foreign gemini list：真实适配器对双格式 + 子代理 fixture 全发现，按更新时间倒序', async () => {
  const r = await foreignSessionRead({ provider: 'gemini', action: 'list' })
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'list') return
  assert.equal(r.total, 3, 'JSONL 新格式 + JSON 旧格式 + 子代理会话都要被发现')
  assert.equal(r.sessions.length, 3)
  assert.equal(r.sessions[0]?.title, '收件箱联调')
  assert.equal(r.sessions[0]?.cwd, 'D:\\gemini-fix\\demo')
  assert.equal(r.sessions[0]?.turns, 2, 'JSONL 会话用户轮数：info / 斜杠命令不计数')
  assert.equal(r.sessions[1]?.title, '早班交接')
  assert.equal(r.sessions[1]?.turns, 1)
  assert.equal(r.sessions[2]?.title, '子代理调研')
  assert.equal(r.sessions[2]?.cwd, 'D:\\gemini-fix\\demo', '子代理沿 .project_root 逐层反查 cwd')
  // 新→旧排序（updatedAt 来自 metadata.lastUpdated）
  assert.ok(r.sessions[0]!.updatedAt > r.sessions[1]!.updatedAt)
  assert.ok(r.sessions[1]!.updatedAt > r.sessions[2]!.updatedAt)
})

test('foreign gemini show：latest 命中新格式 JSONL，摘要/骨架/分页原文齐全', async () => {
  const r = await foreignSessionRead({ provider: 'gemini', action: 'show', reference: 'latest', limit: 10 })
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'show') return
  const s = r.summary
  assert.equal(s.title, '收件箱联调')
  assert.equal(s.sessionId, GEMINI_JSONL)
  assert.equal(s.cwd, 'D:\\gemini-fix\\demo')
  assert.equal(s.turnCount, 10, 'user×2 + assistant×2 + 工具轮×3 + 工具结果轮×3')
  assert.equal(s.userTurns, 2)
  assert.equal(s.firstUserMessage, '帮我把 gemini 会话接管跑通')
  assert.equal(s.lastUserMessage, '再跑一遍 e2e')
  assert.ok(s.files.includes('D:\\gemini-fix\\demo\\src\\a.ts'), 'read_file 参数路径被正则回退抠出')
  assert.ok(s.files.includes('D:\\gemini-fix\\demo\\src\\b.ts'))
  assert.match(r.skeleton.warnings, /HISTORY_REPORTED/)
  // 分页原文：工具轮 toolName 原生名直透，status=error 记 toolFailed
  assert.equal(r.turns?.length, 10)
  assert.equal(r.turns?.[2]?.toolName, 'read_file')
  assert.equal(r.turns?.[7]?.toolFailed, true, 'status=error 的工具结果轮要标 toolFailed')
  // 坏行/控制行/未知行没混进 Turn 流
  for (const t of r.turns ?? []) assert.doesNotMatch(t.text, /future-unknown|broken|\$patch/)
})

test('foreign gemini show：旧格式 .json（整块 metadata+messages）按标题关键词命中并解析', async () => {
  const r = await foreignSessionRead({ provider: 'gemini', action: 'show', reference: '早班交接' })
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'show') return
  assert.equal(r.summary.sessionId, GEMINI_JSON)
  assert.equal(r.summary.title, '早班交接')
  assert.equal(r.summary.turnCount, 2)
  assert.equal(r.summary.userTurns, 1)
  assert.equal(r.summary.firstUserMessage, '整理交接清单')
  // content Part 数组形态取 text 部分
  assert.ok(r.summary.tailProgress.some((t) => t.includes('清单见下。')))
})

// ---------- summarizeTurns 纯函数 ----------

test('summarizeTurns：空会话不抛，各段给占位', () => {
  const { summary, skeleton } = summarizeTurns(ref({ id: 'x', agent: 'pi' }), [])
  assert.equal(summary.turnCount, 0)
  assert.equal(summary.firstUserMessage, '')
  assert.match(skeleton.goal, /无用户消息/)
  assert.match(skeleton.stopped, /空会话/)
})

test('summarizeTurns：cwd 为空时骨架 warnings 追加确认目录警告，有 cwd 则不追加', () => {
  // ref() 缺省 cwd: '' → 警告在场
  const empty = summarizeTurns(ref({ id: 'x', agent: 'pi' }), TURNS)
  assert.match(empty.skeleton.warnings, /该会话未记录工作区目录，接手前先确认目录/)
  // 有 cwd → 不追加
  const withCwd = summarizeTurns(ref({ id: 'x', agent: 'pi', cwd: 'D:\\proj' }), TURNS)
  assert.doesNotMatch(withCwd.skeleton.warnings, /未记录工作区目录/)
  assert.match(withCwd.skeleton.warnings, /HISTORY_REPORTED/) // 基线警告不受影响
})

// ---------- skill 注册形态 ----------

test('skill 注册面：/handoff /inbox + /resume-* 九条，共 11 条', () => {
  const regs = skillRegistrations()
  assert.equal(regs.length, 11)
  const names = regs.map((r) => r.name)
  assert.deepEqual(names, [
    'handoff', 'inbox',
    'resume-claude', 'resume-codex', 'resume-opencode', 'resume-zcode', 'resume-pi', 'resume-workbuddy',
    'resume-cursor', 'resume-grok', 'resume-gemini',
  ])
  for (const reg of regs) {
    assert.equal(reg.source, 'bundled')
    assert.equal(reg.provider, 'dsh-takeover')
    assert.equal(reg.invocation?.userInvocable, true)
    assert.equal(reg.invocation?.modelInvocable, false)
  }
})

test('resume skill 内容：九条共用模板，含 inert-history / 四态账本 / 六段 / verify / 寄存询问', () => {
  assert.equal(RESUME_SKILL_SPECS.length, 9)
  for (const spec of RESUME_SKILL_SPECS) {
    assert.ok(FOREIGN_PROVIDERS.includes(spec.provider))
    const content = resumeSkillContent(spec)
    assert.match(content, new RegExp(`foreign_session_read.*"${spec.provider}"`, 's'))
    assert.match(content, /inert-history 边界/)
    assert.match(content, /CURRENT_OBSERVED/)
    assert.match(content, /HISTORY_REPORTED/)
    assert.match(content, /MISMATCH/)
    assert.match(content, /UNAVAILABLE/)
    assert.match(content, /目标/)
    assert.match(content, /停在哪/)
    assert.match(content, /verify-then-continue/)
    assert.match(content, /寄存进共享收件箱/)
    assert.match(content, /handoff_push/)
    assert.match(content, /恢复边界/)
    assert.ok(content.includes(spec.recoveryBoundary), `${spec.name} 缺恢复边界文案`)
    assert.match(content, /核验降级纪律/, `${spec.name} 缺核验降级纪律`)
    assert.match(content, /永远不要尝试修复宿主环境/)
    assert.match(content, /不要为此申请提权/)
    assert.match(content, /不要加载诊断类技能/)
  }
  // gemini（第 9 家）：描述含双格式 JSONL/JSON 与子代理会话提示
  const gemini = RESUME_SKILL_SPECS.find((s) => s.provider === 'gemini')
  assert.ok(gemini !== undefined, '缺 resume-gemini 规格')
  assert.match(gemini.description, /双格式/)
  assert.match(gemini.description, /JSONL/)
  assert.match(gemini.description, /JSON/)
  assert.match(gemini.description, /子代理/)
  const geminiContent = resumeSkillContent(gemini)
  assert.match(geminiContent, /"gemini"/)
})

test('handoff / inbox skill 内容：同款核验降级纪律', () => {
  for (const content of [HANDOFF_SKILL_CONTENT, INBOX_SKILL_CONTENT]) {
    assert.match(content, /核验降级纪律/)
    assert.match(content, /永远不要尝试修复宿主环境/)
    assert.match(content, /不要为此申请提权/)
    assert.match(content, /不要加载诊断类技能/)
    assert.match(content, /UNAVAILABLE/)
  }
})

// ---------- renderForeign：模型可见文本（dsh-tools 契约：只有 render 的 content 送达模型） ----------

/** renderForeign 返回的全部 text block 拼成一个文本 */
function renderedText(value: unknown): string {
  return renderForeign({}, value).map((b) => b.text).join('\n')
}

test('render show：模型可见文本含摘要 + 骨架六段素材全文', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'show' }, fakeReaders())
  assert.equal(r.ok, true)
  if (!r.ok || r.action !== 'show') return
  const text = renderedText(r)
  // 摘要要素
  assert.match(text, /结构化摘要：收件箱开发/)
  assert.match(text, /sess-aaa-1111/)
  assert.match(text, /首条用户消息：帮我把收件箱做完/)
  assert.match(text, /最后一条用户消息：顺便更新 README/)
  assert.match(text, /测试全绿，README 已更新/)
  // 骨架六段素材全文逐段在场（不能只给一句“已返回”提示）
  for (const heading of ['目标（goal）', '涉及文件（files）', '做到哪（done）', '还差什么（remaining）', '停在哪（stopped）', '读者警告（warnings）']) {
    assert.ok(text.includes(heading), `可见文本缺骨架段标题：${heading}`)
  }
  for (const k of ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings'] as const) {
    assert.ok(text.includes(r.skeleton[k]), `可见文本缺骨架段内容：${k}`)
  }
  assert.match(text, /HISTORY_REPORTED/)
  // 不传 limit 时明示如何分页拉原文
  assert.match(text, /原文未返回（共 8 轮/)
})

test('render show：显式 limit/offset 时，模型可见文本含分页 turns 原文', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'show', reference: 'sess-aaa', limit: 3, offset: 1 }, fakeReaders())
  assert.equal(r.ok, true)
  const text = renderedText(r)
  assert.match(text, /原文分页：本页 3 轮（offset=1，共 8 轮/)
  // 每轮的序号头与原文文本都在场
  assert.match(text, /#1 \[assistant\]/)
  assert.match(text, /#2 \[assistant\/Write\]/)
  assert.match(text, /#3 \[assistant\/Edit\]/)
  assert.match(text, /好的，先实现 handoff_inbox 工具。/)
  assert.match(text, /Write: src\/tools\.ts/)
  assert.match(text, /Edit: src\/index\.ts/)
  // 骨架素材不受分页影响，依然全量在场
  assert.match(text, /读者警告（warnings）/)
})

test('render 错误值：模型可见文本含失败原因与候选', async () => {
  const r = await foreignSessionRead({ provider: 'zcode', action: 'show', reference: '收件箱' }, fakeReaders())
  assert.equal(r.ok, false)
  const text = renderedText(r)
  assert.match(text, /歧义/)
  assert.match(text, /sess-aaa-1111/)
})
