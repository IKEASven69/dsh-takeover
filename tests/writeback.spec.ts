/**
 * 写回最小闭环测试（T8 · 写回面）：handoff_absorb（记忆写回）+ handoff_env action=inject
 * （配置写回：MCP/skills）。钉死的不变量：
 * - confirm 两步强制：缺 confirm 一律拒绝并回显计划，零写盘
 * - 追加前按条目 sha 去重：目标已有内容不重写（同卡重复 absorb 幂等 = 0 追加）
 * - 写前快照可回滚：absorb → archived/absorb-backup/；inject → restore-checkpoint-inject-*（rollback 可回滚）
 * - 会话存储零写入（负向断言）：全树 diff 只允许记忆/配置目标变化；target 闭集 + 结构守门
 * - inject 只新增不覆盖：同名 MCP / 已存在 skill 文件一律跳过，如实报告
 * - 诚实边界：无映射的家（codex TOML / cursor skills）明确不做，不半吊子写
 * 全部走临时 home（源机与目标机分开）+ 临时 HANDOFF_HOME，不碰真实用户目录。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ABSORB_TARGETS, absorbCard, parseSuggestedEntries, registerAbsorbTool, renderAbsorb } from '../src/absorb.ts'
import { generateId } from '@agent-handoff/core'
import { INJECT_TARGETS, applyInject, planInject, renderInjectPlan } from '../src/configinject.ts'
import { collectScopeFiles, createBackup, listBackups, readBackupEntryBlobs, rollbackRestore } from '../src/envbackup.ts'
import { scanMemorySources, pushMemoryCard, type MemorySourceRow } from '../src/memory.ts'
import { inboxLoad, pushHandoff, registerEnvBackupTool, renderInbox } from '../src/tools.ts'
import { readLifecycleEvents } from '../src/lifecycle.ts'

const PASS = 'correct-horse-8'

function rmRf(p: string): void {
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

/** 临时目录（源机 home / 目标机 home / HANDOFF_HOME 三用） */
function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-wb-${label}-`))
}

/** 全树内容指纹（relPath（正斜杠）→ sha256）：写回面零写入断言的基准 */
function treeMap(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (rel: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(join(root, rel))
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel === '' ? e : `${rel}/${e}`
      const st = statSync(join(root, child))
      if (st.isDirectory()) walk(child)
      else out.set(child.split('\\').join('/'), createHash('sha256').update(readFileSync(join(root, child))).digest('hex'))
    }
  }
  walk('')
  return out
}

/** 源机出一张真 memory 轴卡并取件归档（两步语义第一步），返回卡 id。
 * 源机与目标机分开：卡携带的条目在目标机上默认不存在（跨机交接的现实形态）。 */
function makeArchivedMemoryCard(handoff: string, sourceHome: string, memoryLines: string[]): string {
  mkdirSync(join(sourceHome, '.claude'), { recursive: true })
  writeFileSync(join(sourceHome, '.claude', 'CLAUDE.md'), `${memoryLines.join('\n')}\n`, 'utf-8')
  const scan = (): MemorySourceRow[] => scanMemorySources({ home: sourceHome })
  const r = pushMemoryCard({ keys: ['claude-user'] }, { dir: handoff, scan })
  if (!r.ok) throw new Error(`记忆卡出卡失败：${r.error}`)
  const load = inboxLoad(r.id, { dir: handoff })
  if (!load.ok) throw new Error(`记忆卡取件失败：${load.error}`)
  return r.id
}

// --------------------------------------------------------------- absorb：confirm 闸与计划回显

test('absorb：confirm 缺省一律拒绝——计划逐条回显、零写盘、无生命周期事件', () => {
  const sourceHome = tmpDir('a-src')
  const home = tmpDir('a-dst')
  const handoff = tmpDir('a-handoff')
  try {
    const id = makeArchivedMemoryCard(handoff, sourceHome, ['偏好 bun。', '测试用例先写。'])
    const before = treeMap(home)
    const eventsBefore = readLifecycleEvents(handoff).filter((e) => e.reason === 'absorbed-write').length
    const r = absorbCard({ id, target: 'claude-user' }, { dir: handoff, home })
    assert.equal(r.ok, false, '缺 confirm 必须拒绝')
    if (r.ok) return
    // 计划回显：目标路径、每条条目、去重计数、快照说明、confirm 指引
    assert.match(r.error, /confirm: true/)
    assert.match(r.error, /将写入/)
    assert.match(r.error, /偏好 bun。/)
    assert.match(r.error, /测试用例先写。/)
    // 目标不存在：计划如实说明「新建、无快照」（absorb-backup 行只在目标已存在时出现）
    assert.match(r.error, /目标不存在，无快照/)
    // 零写盘：目标机全树指纹不变；生命周期无 absorbed-write
    assert.deepEqual(treeMap(home), before, '拒绝路径不得写任何盘')
    assert.equal(readLifecycleEvents(handoff).filter((e) => e.reason === 'absorbed-write').length, eventsBefore)
    // 显式 confirm !== true（如 false）同样拒绝
    const r2 = absorbCard({ id, target: 'claude-user', confirm: false }, { dir: handoff, home })
    assert.equal(r2.ok, false, 'confirm:false 同样必须拒绝')
  } finally {
    rmRf(sourceHome); rmRf(home); rmRf(handoff)
  }
})

// --------------------------------------------------------------- absorb：两步确认落盘 + 留痕 + 幂等去重

test('absorb：confirm:true 落盘——条目进目标记忆文件、absorbed-write 留痕、重复 absorb 幂等 0 追加', () => {
  const sourceHome = tmpDir('b-src')
  const home = tmpDir('b-dst')
  const handoff = tmpDir('b-handoff')
  try {
    const id = makeArchivedMemoryCard(handoff, sourceHome, ['偏好 bun。', '测试用例先写。', '偏好 bun。'])
    const target = join(home, '.claude', 'CLAUDE.md')
    const r = absorbCard({ id, target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(r.ok, true, `absorb 失败：${r.ok ? '' : r.error}`)
    if (!r.ok) return
    assert.equal(r.path, target)
    // 目标原本不存在 → snapshot 缺省；卡内重复行只追加一次（appended=2、卡内去重=1）
    assert.equal(r.appended, 2)
    assert.equal(r.deduped, 1)
    assert.equal(r.snapshot, undefined)
    const content = readFileSync(target, 'utf-8')
    assert.match(content, /偏好 bun。/)
    assert.match(content, /测试用例先写。/)
    // 生命周期留痕：write/absorbed-write，detail 带追加/去重计数与新建说明
    const ev = readLifecycleEvents(handoff).find((e) => e.reason === 'absorbed-write')
    assert.ok(ev, 'absorbed-write 事件应在账本')
    assert.equal(ev?.target, id)
    assert.match(ev?.detail ?? '', /追加 2 条、去重 1 条/)
    assert.match(ev?.detail ?? '', /目标原不存在/)
    // 幂等：同一张卡再 absorb → 三条条目全部命中既有内容 → 0 追加，文件逐字节不变
    const before = readFileSync(target, 'utf-8')
    const r2 = absorbCard({ id, target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(r2.ok, true)
    if (!r2.ok) return
    assert.equal(r2.appended, 0, '重复 absorb 必须全去重')
    assert.equal(r2.deduped, 3, '三条条目（含卡内重复）全命中既有内容')
    assert.equal(readFileSync(target, 'utf-8'), before, '去重不重写：文件逐字节不变')
    // 目标此时已存在 → 快照在（内容 = 首次落盘后的形态；首个快照按 id-target 确定性命名不被覆盖）
    assert.ok(r2.snapshot !== undefined && existsSync(r2.snapshot))
  } finally {
    rmRf(sourceHome); rmRf(home); rmRf(handoff)
  }
})

// --------------------------------------------------------------- absorb：写前快照与回滚

test('absorb：既有目标写前原物快照进 archived/absorb-backup/，用快照可完整回滚', () => {
  const sourceHome = tmpDir('c-src')
  const home = tmpDir('c-dst')
  const handoff = tmpDir('c-handoff')
  try {
    const original = '# 我本机的 AGENTS 口径\n\n保留的既有约定。\n'
    mkdirSync(join(home, '.claude'), { recursive: true })
    const target = join(home, '.claude', 'CLAUDE.md')
    const id = makeArchivedMemoryCard(handoff, sourceHome, ['新吸收的一条。'])
    // 推卡之后目标文件被本机改动——快照要接住的是「写盘前的最新原物」
    writeFileSync(target, original, 'utf-8')
    const r = absorbCard({ id, target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    if (!r.ok) return
    assert.equal(r.appended, 1, '推卡后本机改过的目标不含卡条目 → 应追加 1 条')
    assert.ok(r.snapshot, '既有目标应有快照')
    if (r.snapshot === undefined) return
    // 快照 = 写前原物；路径 = archived/absorb-backup/<id>-<target>.md
    assert.equal(readFileSync(r.snapshot, 'utf-8'), original)
    assert.ok(r.snapshot.endsWith(join('absorb-backup', `${id}-claude-user.md`)), `快照路径形态不符：${r.snapshot}`)
    // 落盘后目标 = 原物 + 追加（原内容不被重写）
    const merged = readFileSync(target, 'utf-8')
    assert.match(merged, /保留的既有约定/)
    assert.match(merged, /新吸收的一条。/)
    // 回滚 = 用快照覆盖目标 → 目标回到原物（追加条目消失）
    writeFileSync(target, readFileSync(r.snapshot, 'utf-8'), 'utf-8')
    assert.equal(readFileSync(target, 'utf-8'), original, '快照回滚找回原物')
    // 第二张卡再 absorb（此刻目标 = 刚回滚后的原物）：新快照按新 id 命名，且 = 该次写盘前的最新原物；
    // 第一张卡的快照（首次写前原物）永不被覆盖
    const id2 = makeArchivedMemoryCard(handoff, sourceHome, ['第二条吸收。'])
    const snap1 = r.snapshot
    const r2 = absorbCard({ id: id2, target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(r2.ok, true)
    if (!r2.ok || r2.snapshot === undefined) return
    assert.notEqual(r2.snapshot, snap1, '快照按卡 id 各留一份')
    assert.equal(readFileSync(snap1, 'utf-8'), original, '首个快照不被后续写入覆盖')
    assert.equal(readFileSync(r2.snapshot, 'utf-8'), original, '新快照 = 该次写盘前的最新原物（回滚后的原物）')
  } finally {
    rmRf(sourceHome); rmRf(home); rmRf(handoff)
  }
})

// --------------------------------------------------------------- absorb：多目标

test('absorb：同一张卡多目标落盘——各写各的记忆文件、事件与快照按目标各留一份', () => {
  const sourceHome = tmpDir('d-src')
  const home = tmpDir('d-dst')
  const handoff = tmpDir('d-handoff')
  try {
    mkdirSync(join(home, '.zcode'), { recursive: true })
    writeFileSync(join(home, '.zcode', 'AGENTS.md'), 'zcode 既有约定。\n', 'utf-8')
    const id = makeArchivedMemoryCard(handoff, sourceHome, ['跨家共享的一条。'])
    const a = absorbCard({ id, target: 'claude-user', confirm: true }, { dir: handoff, home })
    const b = absorbCard({ id, target: 'zcode-user', confirm: true }, { dir: handoff, home })
    assert.equal(a.ok, true, a.ok ? '' : a.error)
    assert.equal(b.ok, true, b.ok ? '' : b.error)
    if (!a.ok || !b.ok) return
    assert.match(readFileSync(a.path, 'utf-8'), /跨家共享的一条。/)
    assert.match(readFileSync(b.path, 'utf-8'), /跨家共享的一条。/)
    assert.match(readFileSync(b.path, 'utf-8'), /zcode 既有约定。/, '既有 zcode 记忆不丢失')
    // 快照：claude 目标原本不存在无快照；zcode 目标既有 → 有快照（按目标命名）
    assert.equal(a.snapshot, undefined)
    assert.ok(b.snapshot !== undefined && b.snapshot.endsWith(join('absorb-backup', `${id}-zcode-user.md`)))
    // 事件按目标各一条
    const evs = readLifecycleEvents(handoff).filter((e) => e.reason === 'absorbed-write')
    assert.equal(evs.length, 2)
    assert.ok(evs.some((e) => e.detail.includes('claude-user')))
    assert.ok(evs.some((e) => e.detail.includes('zcode-user')))
  } finally {
    rmRf(sourceHome); rmRf(home); rmRf(handoff)
  }
})

// --------------------------------------------------------------- absorb：会话存储零写入（负向断言）

test('absorb：会话存储零写入——全树 diff 只允许记忆目标变化；会话文件逐字节不变', () => {
  const sourceHome = tmpDir('e-src')
  const home = tmpDir('e-dst')
  const handoff = tmpDir('e-handoff')
  try {
    // 布置四家外部 harness 的会话存储（T8 硬线的负向断言靶子）
    const mkSession = (rel: string, content: string): void => {
      mkdirSync(dirname(join(home, rel)), { recursive: true })
      writeFileSync(join(home, rel), content, 'utf-8')
    }
    mkSession('.claude/projects/proj-a/sess-1.jsonl', '{"type":"user","message":{"role":"user","content":"外部会话正文"}}')
    mkSession('.codex/sessions/2026/11/rollout.jsonl', '{"payload":{}}')
    mkSession('.dsh/sessions/db.sqlite', 'SQLITE-MOCK')
    mkSession('.config/opencode/storage/session-t.json', '{"id":"t"}')
    const id = makeArchivedMemoryCard(handoff, sourceHome, ['只应进 CLAUDE.md 的一条。'])
    const before = treeMap(home)
    const r = absorbCard({ id, target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    if (!r.ok) return
    const after = treeMap(home)
    // 全树 diff：唯一变化 = 记忆目标文件（不存在→新建）
    const keys = new Set([...before.keys(), ...after.keys()])
    const diff = [...keys].filter((k) => before.get(k) !== after.get(k)).sort()
    assert.deepEqual(diff, ['.claude/CLAUDE.md'], `全树 diff 必须只有记忆目标：${diff.join('、')}`)
    // 会话文件逐字节不变（哈希逐一对账）
    for (const rel of ['.claude/projects/proj-a/sess-1.jsonl', '.codex/sessions/2026/11/rollout.jsonl', '.dsh/sessions/db.sqlite', '.config/opencode/storage/session-t.json']) {
      assert.equal(after.get(rel), before.get(rel), `会话存储被动了：${rel}`)
    }
    // 事件 target 是卡 id 而非任何路径——账本不落路径
    const ev = readLifecycleEvents(handoff).find((e) => e.reason === 'absorbed-write')
    assert.equal(ev?.target, id)
  } finally {
    rmRf(sourceHome); rmRf(home); rmRf(handoff)
  }
})

// --------------------------------------------------------------- absorb：注册表结构守门 + 拒绝面

test('absorb：目标注册表闭集无会话存储段（结构守门，AGENTS.md 族在册、hippo 不在册）', () => {
  const segBlack = new Set(['projects', 'sessions', 'storages', 'session-store', 'history'])
  const home = tmpDir('f-home')
  try {
    const keys = ABSORB_TARGETS.map((t) => t.key)
    assert.equal(keys.length, 8, 'MEMORY_SOURCES 九条去掉 hippo-db（引擎目录不可按文件写）应剩八条')
    assert.ok(keys.includes('zcode-user') && keys.includes('agents-project'), 'AGENTS.md 族事实标准在册')
    assert.ok(!keys.includes('hippo-db'), 'hippo-db 不得在册')
    for (const def of ABSORB_TARGETS) {
      const p = def.path(home, join(home, 'proj'))
      for (const seg of p.split(/[\\/]/)) {
        assert.ok(!segBlack.has(seg.toLowerCase()), `注册表路径 ${p} 命中会话存储段 ${seg}`)
      }
    }
  } finally {
    rmRf(home)
  }
})

test('absorb：拒绝面——非 memory 卡 / 未取件 / 未知 target / hippo-db / 项目级缺 cwd / 非法 id', () => {
  const home = tmpDir('g-home')
  const handoff = tmpDir('g-handoff')
  try {
    // 未取件：卡还在 pending/ → 明确拒（两步语义第一步未完成）
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'pending 态的一条。\n', 'utf-8')
    const scan = (): MemorySourceRow[] => scanMemorySources({ home })
    const pushed = pushMemoryCard({ keys: ['claude-user'] }, { dir: handoff, scan })
    assert.equal(pushed.ok, true)
    if (!pushed.ok) return
    const pend = absorbCard({ id: pushed.id, target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(pend.ok, false)
    if (!pend.ok) assert.match(pend.error, /先 handoff_inbox action=load/)
    // 取件后再来（后续子案复用这张卡的 id）
    inboxLoad(pushed.id, { dir: handoff })

    // 非 memory 轴卡（会话卡）→ 拒（dir 注入临时总线——测试绝不向真实 ~/.handoff 泄卡）
    const sess = pushHandoff(null, { goal: '会话轴验证', done: '手写完成项（HISTORY_REPORTED）', remaining: 'r', stopped: 's', warnings: 'w', title: '会话卡' }, { dir: handoff })
    assert.equal(sess.ok, true)
    if (!sess.ok) return
    inboxLoad(sess.id, { dir: handoff })
    const notMem = absorbCard({ id: sess.id, target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(notMem.ok, false)
    if (!notMem.ok) assert.match(notMem.error, /非 memory 轴卡/)

    // 未知 target（含会话形态）→ 拒，文案点名会话存储永不写
    const unknown = absorbCard({ id: pushed.id, target: 'sessions', confirm: true }, { dir: handoff, home })
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.match(unknown.error, /会话存储永不写/)
    // hippo-db → 专案拒绝（引擎目录不可按文件写回）
    const hippo = absorbCard({ id: pushed.id, target: 'hippo-db', confirm: true }, { dir: handoff, home })
    assert.equal(hippo.ok, false)
    if (!hippo.ok) assert.match(hippo.error, /zvec/)
    // 项目级缺 cwd → 拒
    const noCwd = absorbCard({ id: pushed.id, target: 'agents-project', confirm: true }, { dir: handoff, home })
    assert.equal(noCwd.ok, false)
    if (!noCwd.ok) assert.match(noCwd.error, /cwd/)
    // 非法 id（穿越形态）→ 拒
    const evil = absorbCard({ id: '../evil', target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(evil.ok, false)
    if (!evil.ok) assert.match(evil.error, /非法卡片 id/)
    // 不存在的卡 → 拒（id 用 generateId 的合法形态——形态非法在上一条已单独验过）
    const nope = absorbCard({ id: generateId(), target: 'claude-user', confirm: true }, { dir: handoff, home })
    assert.equal(nope.ok, false)
    if (!nope.ok) assert.match(nope.error, /无此卡/)
  } finally {
    rmRf(home); rmRf(handoff)
  }
})

test('parseSuggestedEntries：## 标题记来源不算条目、截断标记行跳过、空行跳过', () => {
  const text = [
    '## /tmp/a/CLAUDE.md',
    '',
    '偏好 bun。',
    '- 列表条也算一条',
    '…（超出总上限截断——请按来源清单直接读源文件补齐）',
    '## /tmp/b/AGENTS.md',
    '第二条。',
  ].join('\n')
  const entries = parseSuggestedEntries(text)
  assert.deepEqual(entries.map((e) => e.line), ['偏好 bun。', '- 列表条也算一条', '第二条。'])
  assert.equal(entries[0]?.source, '/tmp/a/CLAUDE.md')
  assert.equal(entries[2]?.source, '/tmp/b/AGENTS.md')
})

// --------------------------------------------------------------- inject：confirm 闸 + 只新增不覆盖 + checkpoint 回滚

/** 源机 root：含 .mcp.json（新/同两 server）与 skills（新/同/冲突三件）→ 出备份，返回备份文件名 */
function makeInjectBackup(handoff: string, root: string): string {
  const mk = (rel: string, content: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content, 'utf-8')
  }
  mk('.mcp.json', JSON.stringify({
    mcpServers: {
      'playwright': { command: 'npx', args: ['@playwright/mcp@latest'], env: { DEBUG: '1' } },
      'same-srv': { command: 'node', args: ['same.js'] },
    },
  }))
  mk('.agents/skills/newskill/SKILL.md', '# new skill\n')
  mk('.agents/skills/sameskill/SKILL.md', '# same skill\n')
  mk('.agents/skills/conflictkill/SKILL.md', '# remote version\n')
  mk('.dsh/settings.yaml.imported', 'x: 1')
  const r = createBackup(PASS, handoff, root)
  assert.equal(r.ok, true)
  return listBackups(handoff)[0]!.file
}

/** 目标机 home：既有 .claude.json（同 server + 别的顶层键要保住）与同/冲突 skills */
function makeTargetHome(label: string): { home: string; original: string } {
  const home = tmpDir(label)
  const original = JSON.stringify({ other: 'keep-me', mcpServers: { 'same-srv': { args: ['same.js'], command: 'node' } } }, null, 2)
  writeFileSync(join(home, '.claude.json'), `${original}\n`, 'utf-8')
  mkdirSync(join(home, '.claude', 'skills', 'sameskill'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'sameskill', 'SKILL.md'), '# same skill\n', 'utf-8')
  mkdirSync(join(home, '.claude', 'skills', 'conflictkill'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'conflictkill', 'SKILL.md'), '# local version\n', 'utf-8')
  return { home, original }
}

test('inject：confirm 缺省一律拒绝——逐条计划回显、零写盘；planInject 纯读', () => {
  const root = tmpDir('h-src')
  const handoff = tmpDir('h-handoff')
  const { home } = makeTargetHome('h-dst')
  try {
    const file = makeInjectBackup(handoff, root)
    const before = treeMap(home)
    const args = { file, passphrase: PASS, target: 'claude' }
    const p = planInject(args, { dir: handoff, home })
    assert.equal(p.ok, true, p.ok ? '' : p.error)
    if (!p.ok) return
    // 计划逐条：add/create 全列出，skip 也列明
    const adds = p.items.filter((i) => i.action === 'add')
    const creates = p.items.filter((i) => i.action === 'create')
    assert.deepEqual(adds.map((i) => i.name), ['playwright'], '只该新增 playwright（same-srv 同内容跳过）')
    assert.deepEqual(creates.map((i) => i.name), ['newskill/SKILL.md'], 'skills 只该新建 newskill')
    assert.ok(p.items.some((i) => i.kind === 'mcp' && i.name === 'same-srv' && i.action === 'skip-same'))
    assert.ok(p.items.some((i) => i.kind === 'skill' && i.name === 'sameskill/SKILL.md' && i.action === 'skip-same'))
    assert.ok(p.items.some((i) => i.kind === 'skill' && i.name === 'conflictkill/SKILL.md' && i.action === 'skip-conflict'))
    assert.match(renderInjectPlan(p), /playwright/)
    // 缺 confirm → 拒绝 + 计划全文回显 + 零写盘
    const r = applyInject(args, { dir: handoff, home })
    assert.equal(r.ok, false, '缺 confirm 必须拒绝')
    if (!r.ok) {
      assert.match(r.error, /confirm: true/)
      assert.match(r.error, /playwright/)
      assert.match(r.error, /只新增不覆盖/)
    }
    assert.deepEqual(treeMap(home), before, '拒绝路径不得写目标机任何盘')
  } finally {
    rmRf(root); rmRf(handoff); rmRf(home)
  }
})

test('inject：confirm 落盘——只新增不覆盖、既有配置键保住、checkpoint 经 rollback 可回滚、config-injected 留痕', () => {
  const root = tmpDir('i-src')
  const handoff = tmpDir('i-handoff')
  const { home, original } = makeTargetHome('i-dst')
  try {
    const file = makeInjectBackup(handoff, root)
    const r = applyInject({ file, passphrase: PASS, target: 'claude', confirm: true }, { dir: handoff, home })
    assert.equal(r.ok, true, r.ok ? '' : r.error)
    if (!r.ok) return
    assert.deepEqual(r.mcpAdded, ['playwright'])
    assert.equal(r.mcpSkipped, 1)
    assert.deepEqual(r.skillsCreated, ['newskill/SKILL.md'])
    assert.equal(r.skillsSkipped, 2)
    assert.match(r.checkpointDir ?? '', /^env-backup[\\/]restore-checkpoint-inject-/)
    // MCP：新增进表；same-srv 值未被改写；其他顶层键原样保住
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf-8')) as { other?: string; mcpServers: Record<string, unknown> }
    assert.equal(cfg.other, 'keep-me', '既有非 mcpServers 键必须原样保住')
    assert.deepEqual(cfg.mcpServers['playwright'], { command: 'npx', args: ['@playwright/mcp@latest'], env: { DEBUG: '1' } })
    assert.deepEqual(cfg.mcpServers['same-srv'], { args: ['same.js'], command: 'node' })
    // skills：新文件落地；同内容/冲突文件未被改写
    assert.equal(readFileSync(join(home, '.claude', 'skills', 'newskill', 'SKILL.md'), 'utf-8'), '# new skill\n')
    assert.equal(readFileSync(join(home, '.claude', 'skills', 'sameskill', 'SKILL.md'), 'utf-8'), '# same skill\n')
    assert.equal(readFileSync(join(home, '.claude', 'skills', 'conflictkill', 'SKILL.md'), 'utf-8'), '# local version\n', '冲突 skill 不覆盖')
    // 生命周期留痕
    const ev = readLifecycleEvents(handoff).find((e) => e.reason === 'config-injected')
    assert.ok(ev, 'config-injected 事件应在账本')
    assert.equal(ev?.target, 'inject:claude')
    // 幂等：对齐后的目标再 inject → 全部跳过，零写盘不建 checkpoint（须在回滚前——回滚会把目标拉回注入前）
    const r2 = applyInject({ file, passphrase: PASS, target: 'claude', confirm: true }, { dir: handoff, home })
    assert.equal(r2.ok, true)
    if (!r2.ok) return
    assert.deepEqual(r2.mcpAdded, [])
    assert.deepEqual(r2.skillsCreated, [])
    assert.equal(r2.checkpointDir, undefined)
    assert.match(r2.detail, /未写任何盘/)
    // 回滚：checkpoint 原物写回 → .claude.json 回到注入前（playwright 消失），skill 新建文件留在原地（结果里如实标注）
    const rolled = rollbackRestore(r.checkpointDir ?? '', handoff, home)
    assert.equal(rolled.ok, true)
    assert.equal(rolled.restored, 1)
    assert.equal(readFileSync(join(home, '.claude.json'), 'utf-8'), `${original}\n`, '回滚后 .claude.json = 注入前原物')
  } finally {
    rmRf(root); rmRf(handoff); rmRf(home)
  }
})

test('inject：无映射家诚实不做（codex TOML 语义不等价）；注册表闭集无会话存储段', () => {
  const root = tmpDir('j-src')
  const handoff = tmpDir('j-handoff')
  const home = tmpDir('j-dst')
  try {
    const file = makeInjectBackup(handoff, root)
    const before = treeMap(home)
    const r = applyInject({ file, passphrase: PASS, target: 'codex', confirm: true }, { dir: handoff, home })
    assert.equal(r.ok, false, 'codex 无 MCP/skills 等价映射必须拒绝')
    if (!r.ok) assert.match(r.error, /不等价|明确不做/)
    // 未注册 target 拒绝
    const bad = applyInject({ file, passphrase: PASS, target: 'sessions', confirm: true }, { dir: handoff, home })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.error, /会话存储永不写/)
    // 注册表结构守门：全目标解析路径无会话存储段；无映射目标必须带诚实标注
    const segBlack = new Set(['projects', 'sessions', 'storages', 'session-store', 'history'])
    for (const def of INJECT_TARGETS) {
      const paths = [def.mcp?.path(home), def.skills?.(home)].filter((p): p is string => p !== undefined)
      assert.ok(paths.length > 0 || def.limits.length > 0, '无映射目标必须有诚实标注')
      for (const p of paths) {
        for (const seg of p.split(/[\\/]/)) {
          assert.ok(!segBlack.has(seg.toLowerCase()), `inject 注册表路径 ${p} 命中会话存储段 ${seg}`)
        }
      }
    }
    assert.deepEqual(treeMap(home), before, '拒绝路径零写盘')
  } finally {
    rmRf(root); rmRf(handoff); rmRf(home)
  }
})

test('inject：SCOPE 收 .mcp.json（mcp-config 类）；readBackupEntryBlobs 取源条目、错口令诚实失败', () => {
  const root = tmpDir('k-src')
  const handoff = tmpDir('k-handoff')
  try {
    const file = makeInjectBackup(handoff, root)
    // SCOPE：.mcp.json 进备份清单（inject 的源条目前提）
    const scope = collectScopeFiles(root)
    const mcp = scope.find((f) => f.path === '.mcp.json')
    assert.ok(mcp, '.mcp.json 应在备份范围')
    assert.equal(mcp?.category, 'mcp-config')
    assert.equal(mcp?.secret, false)
    // 包内条目读取：.mcp.json + 三件 skills（settings 不在谓词内）
    const blobs = readBackupEntryBlobs(file, PASS, handoff, (rel) => rel === '.mcp.json' || rel.startsWith('.agents/skills/'))
    assert.deepEqual(blobs.map((b) => b.path).sort(), ['.agents/skills/conflictkill/SKILL.md', '.agents/skills/newskill/SKILL.md', '.agents/skills/sameskill/SKILL.md', '.mcp.json'])
    assert.match(blobs.find((b) => b.path === '.mcp.json')?.content.toString('utf-8') ?? '', /playwright/)
    // 错口令 = GCM 认证失败诚实报错（不吐内容）
    assert.throws(() => readBackupEntryBlobs(file, 'wrong-passphrase', handoff), /解密失败/)
  } finally {
    rmRf(root); rmRf(handoff)
  }
})

// --------------------------------------------------------------- 工具 execute 路径与渲染

test('handoff_absorb execute：未知 id 拒绝不写盘；renderAbsorb 两态文案', async () => {
  const handoff = tmpDir('l-handoff')
  process.env['HANDOFF_HOME'] = handoff
  try {
    const registered: Array<{ name: string; execute: (a: unknown) => Promise<unknown> }> = []
    const ctx = { tools: { register: (def: { name: string; execute: (a: unknown) => Promise<unknown> }): void => { registered.push(def) } }, logger: { info: (): void => {} } }
    registerAbsorbTool(ctx as never)
    assert.equal(registered.length, 1)
    assert.equal(registered[0]?.name, 'handoff_absorb')
    // 合法形态但不存在的 id → 「无此卡」（形态非法走 /非法卡片 id/，在核心测试里单独验）
    const out = (await registered[0]?.execute({ id: generateId(), target: 'claude-user', confirm: true })) as { ok: boolean; error?: string }
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /无此卡/)
    // 渲染两态
    const okRender = renderAbsorb({}, { ok: true, agent: 'Claude Code', path: 'X:/a/CLAUDE.md', appended: 2, deduped: 1, id: 'ho-x', snapshot: 'X:/snap.md' })
    assert.match(okRender[0]?.text ?? '', /已吸收/)
    assert.match(okRender[0]?.text ?? '', /快照/)
    const failRender = renderAbsorb({}, { ok: false, error: '计划如下' })
    assert.match(failRender[0]?.text ?? '', /未执行/)
    assert.match(failRender[0]?.text ?? '', /计划如下/)
  } finally {
    delete process.env['HANDOFF_HOME']
    rmRf(handoff)
  }
})

test('handoff_env execute action=inject：无备份规范报错；load 取件渲染带 absorb 指引', async () => {
  const handoff = tmpDir('m-handoff')
  const sourceHome = tmpDir('m-src')
  process.env['HANDOFF_HOME'] = handoff
  try {
    const registered: Array<{ name: string; execute: (a: unknown) => Promise<unknown> }> = []
    const ctx = { tools: { register: (def: { name: string; execute: (a: unknown) => Promise<unknown> }): void => { registered.push(def) } }, logger: { info: (): void => {} } }
    registerEnvBackupTool(ctx as never)
    const envDef = registered.find((d) => d.name === 'handoff_env')
    assert.ok(envDef, 'handoff_env 未注册')
    const out = (await envDef?.execute({ action: 'inject', target: 'claude', passphrase: PASS })) as { ok: boolean; error?: string }
    assert.equal(out.ok, false)
    assert.match(out.error ?? '', /没有可注入的环境备份/)
    // 取件渲染：memory 轴卡的 absorb 指引行
    mkdirSync(join(sourceHome, '.claude'), { recursive: true })
    writeFileSync(join(sourceHome, '.claude', 'CLAUDE.md'), '渲染口径的一条。\n', 'utf-8')
    const scan = (): MemorySourceRow[] => scanMemorySources({ home: sourceHome })
    const pushed = pushMemoryCard({ keys: ['claude-user'] }, { dir: handoff, scan })
    assert.equal(pushed.ok, true, '源机得有一份 CLAUDE.md 才能出卡')
    if (!pushed.ok) return
    const load = inboxLoad(pushed.id, { dir: handoff })
    assert.equal(load.ok, true)
    if (!load.ok) return
    const text = String(renderInbox({}, load)[0]?.text)
    assert.match(text, /handoff_absorb/)
    assert.match(text, /confirm: true/)
  } finally {
    delete process.env['HANDOFF_HOME']
    rmRf(handoff); rmRf(sourceHome)
  }
})

// 参数校验路径零写盘：absorb/inject 在Early-拒分支不得留下任何文件（含 lifecycle）
test('注册表解析不落盘：全部 target 校验路径零写入（HANDOFF_HOME 全树不变）', () => {
  const handoff = tmpDir('n-handoff')
  process.env['HANDOFF_HOME'] = handoff
  try {
    const before = treeMap(handoff)
    // absorb：id 校验/未知 target 早拒（不触 archived 之后的任何写路径）
    absorbCard({ id: 'ho-x', target: 'claude-user' })
    absorbCard({ id: '../evil', target: 'claude-user', confirm: true })
    // inject：缺口令/未知 target 早拒
    applyInject({ target: 'claude' })
    applyInject({ target: 'nope-target', passphrase: PASS })
    assert.deepEqual(treeMap(handoff), before, '参数校验路径不得写盘（含 lifecycle）')
  } finally {
    delete process.env['HANDOFF_HOME']
    rmRf(handoff)
  }
})
