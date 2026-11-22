/**
 * dsh-takeover 测试：卡片渲染/落盘、消费即弃、事件流探测降级、规范错误值。
 * 落盘一律走 HANDOFF_HOME 指到临时目录，不碰真实 ~/.handoff。
 */
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { archivedDir, parseCard, loadCard, listPending, listArchived, renderCard } from '@agent-handoff/core'
import {
  collectFacts,
  handoffHostNotice,
  inboxHistory,
  inboxList,
  inboxLoad,
  probeSessionEvents,
  pushHandoff,
  todoToTasks,
} from '../src/index.ts'
import { renderInbox } from '../src/tools.ts'
import { readLifecycleEvents } from '../src/lifecycle.ts'

/** 造一个独立 HANDOFF_HOME 临时目录 */
function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-takeover-test-'))
}

/** 造一个仿真 session（snapshotEvents 形态，对齐 dsh-session API） */
function fakeSession(events: unknown[]): unknown {
  return {
    id: 'sess-test-1',
    header: { cwd: process.cwd() },
    snapshotEvents: () => events,
  }
}

const SAMPLE_EVENTS: unknown[] = [
  { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把收件箱做完' }] } },
  { type: 'tool/call', time: 2, data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/tools.ts' }) } },
  { type: 'tool/call', time: 3, data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/index.ts' }) } },
  { type: 'tool/call', time: 4, data: { name: 'bash', arguments: JSON.stringify({ command: 'git commit -m "feat: inbox"' }) } },
  { type: 'tool/call', time: 5, data: { name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) } },
  {
    type: 'todo/write', time: 6, data: {
      todos: [
        { content: '收件箱工具', status: 'completed', priority: 'high' },
        { content: '写测试', status: 'in_progress' },
        { text: '发版', status: 'pending' },
      ],
    },
  },
]

// ---------- 事件流探测降级 ----------

test('探测：null session 降级 skipped，不抛错', () => {
  const r = probeSessionEvents(null)
  assert.equal(r.skipped, true)
  assert.equal(r.events.length, 0)
  assert.match(r.note, /session 为空/)
})

test('探测：events 非数组降级 skipped', () => {
  const r = probeSessionEvents({ events: 42 })
  assert.equal(r.skipped, true)
  assert.match(r.note, /typeof=number/)
})

test('探测：snapshotEvents 优先，抛错时退回 events 字段', () => {
  const ok = probeSessionEvents(fakeSession(SAMPLE_EVENTS))
  assert.equal(ok.skipped, false)
  assert.equal(ok.events.length, SAMPLE_EVENTS.length)

  const fallback = probeSessionEvents({
    snapshotEvents: () => { throw new Error('boom') },
    events: SAMPLE_EVENTS,
  })
  assert.equal(fallback.skipped, false)
  assert.equal(fallback.events.length, SAMPLE_EVENTS.length)
})

test('探测：snapshotEvents 依赖 this 的方法形态——解绑必抛、绑定重试成功（0.26 probe 接线补口，真机 Session 形态）', () => {
  // 真机形态：snapshotEvents 默认参数读 this.seq（dsh-session lib/index.js:1454）——
  // 解绑裸调用 this=undefined 必抛；0.26 补口后以 session 为接收者绑定重试成功
  const log = [
    { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真机形态采集' }] } },
    { type: 'tool/call', time: 2, data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/x.ts' }) } },
  ]
  const session = {
    id: 'sess-bound-1',
    seq: 2,
    inner: log,
    // 官方签名口径：fromSeq 缺省 = 起点偏移 0；toSeqExclusive 缺省 = this.seq——
    // 解绑时求值默认参数 this.seq 必抛（这正是补口要修的形态）
    snapshotEvents(this: { seq: number; inner: unknown[] }, fromSeq = 0, toSeqExclusive = this.seq) {
      return this.inner.slice(fromSeq, toSeqExclusive)
    },
  }
  const r = probeSessionEvents(session)
  assert.equal(r.skipped, false, '解绑失败 → 绑定重试命中（官方 API 的正确调用形态）')
  assert.equal(r.events.length, 2)
  // 绑定也失败（返回非数组）→ 落 events 字段既有兜底，分级不变
  const deadBound = probeSessionEvents({
    seq: 1,
    events: SAMPLE_EVENTS,
    snapshotEvents(this: unknown) { return 'not-an-array' },
  })
  assert.equal(deadBound.skipped, false)
  assert.equal(deadBound.events.length, SAMPLE_EVENTS.length)
})

test('收集：真机 this 形态经 pushHandoff 全链路成立——绑定重试后事件事实照常蒸馏', () => {
  const dir = tmpHome()
  try {
    const log = [
      { type: 'user/message', time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '绑定重试后的接力寄存' }] } },
      { type: 'tool/call', time: 2, data: { name: 'edit', arguments: JSON.stringify({ file_path: 'src/bound.ts' }) } },
    ]
    const session = {
      id: 'sess-bound-2',
      seq: 2,
      inner: log,
      snapshotEvents(this: { seq: number; inner: unknown[] }, fromSeq = 0, toSeqExclusive = this.seq) {
        return this.inner.slice(fromSeq, toSeqExclusive)
      },
    }
    const r = pushHandoff(session, {}, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.skipped, false, 'handoff_push 的事件采集不再静默降级（0.25 已装构建带病形态的修复钉）')
    const card = parseCard(readFileSync(join(dir, 'pending', `${r.id}.md`), 'utf-8'))
    assert.match(card.sections.goal, /绑定重试后的接力寄存/, '事件事实随绑定重试进卡（非兜底骨架）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('收集：用户消息 / 写文件 / 命令 / todo 都被蒸馏', () => {
  const facts = collectFacts(SAMPLE_EVENTS)
  assert.equal(facts.userMessages.at(-1)?.text, '帮我把收件箱做完')
  assert.deepEqual(facts.writeEdits.map((w) => w.file), ['src/tools.ts', 'src/index.ts'])
  assert.ok(facts.commands.some((c) => c.includes('npm test')))
  assert.ok(facts.gitCommits.some((c) => c.includes('git commit')))
  const tasks = todoToTasks(facts)
  assert.deepEqual(tasks.map((t) => t.status), ['completed', 'in_progress', 'pending'])
  assert.equal(tasks[2]?.text, '发版') // text 字段兼容
  assert.equal(tasks[0]?.priority, 'high')
})

test('收集：垃圾事件逐条跳过，不抛错', () => {
  const facts = collectFacts([null, 42, 'x', { notype: 1 }, { type: 9 }, { type: 'unknown/x' }])
  assert.equal(facts.userMessages.length, 0)
  assert.equal(facts.eventCount, 6)
})

// ---------- 卡片渲染 / 落盘 ----------

test('push：六段参数优先，落盘后可解析回协议卡片', () => {
  const dir = tmpHome()
  try {
    const r = pushHandoff(fakeSession(SAMPLE_EVENTS), {
      goal: '做完收件箱',
      remaining: '写测试',
      title: 'takeover 开发',
      project: 'dsh-takeover',
    }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.match(r.id, /^ho-/)
    assert.ok(existsSync(r.path))

    const card = parseCard(readFileSync(r.path, 'utf-8'))
    assert.equal(card.handoff, 1)
    assert.equal(card.id, r.id)
    assert.equal(card.from.agent, 'dsh')
    assert.equal(card.from.session, 'sess-test-1')
    assert.equal(card.from.title, 'takeover 开发')
    assert.equal(card.project, 'dsh-takeover')
    assert.equal(card.sections.goal, '做完收件箱')
    assert.equal(card.sections.remaining, '写测试')
    // 未传段走事件流兜底
    assert.match(card.sections.files, /src\/tools\.ts/)
    // tasks 快照进 frontmatter
    assert.deepEqual(card.tasks.map((t) => t.status), ['completed', 'in_progress', 'pending'])
    // 六段中文标题齐全
    const text = readFileSync(r.path, 'utf-8')
    for (const h of ['## 目标', '## 涉及文件', '## 做到哪', '## 还差什么', '## 停在哪', '## 读者警告']) {
      assert.ok(text.includes(h), `缺段：${h}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('push：空壳卡守门——裸 push 被拦（理由回喂），confirmSkeleton 旁路后仍全链路成立', () => {
  const dir = tmpHome()
  try {
    const gated = pushHandoff(null, {}, { dir })
    assert.equal(gated.ok, false)
    if (gated.ok) return
    assert.match(gated.error, /空壳卡守门/)
    assert.match(gated.error, /confirmSkeleton/)

    const r = pushHandoff(null, { confirmSkeleton: true }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.skipped, true)
    assert.equal(r.skeleton, true, '旁路落盘应带 skeleton 留痕')
    assert.notEqual(r.note, '')
    const card = parseCard(readFileSync(r.path, 'utf-8'))
    assert.match(card.sections.warnings, /HISTORY_REPORTED/)
    assert.match(card.sections.warnings, /降级/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 收件箱 list / 消费即弃 ----------

test('inbox：list 只读不消费，load 消费即弃，二次取件报规范错误值', () => {
  const dir = tmpHome()
  try {
    const pushed = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: 'g' }, { dir })
    assert.equal(pushed.ok, true)
    if (!pushed.ok) return

    const before = inboxList({ dir })
    assert.equal(before.ok, true)
    if (!before.ok) return
    assert.equal(before.cards.length, 1)
    assert.equal(before.cards[0]?.id, pushed.id)
    // list 不消费：再列还在
    assert.equal((inboxList({ dir }) as { cards: unknown[] }).cards.length, 1)

    const loaded = inboxLoad(pushed.id, { dir })
    assert.equal(loaded.ok, true)
    if (!loaded.ok) return
    assert.equal(loaded.id, pushed.id)
    assert.match(loaded.text, /## 目标/)
    // cwd 是本仓库（git 仓库），核验要么无 mismatch 要么有具体说明，但不允许抛错
    assert.ok(Array.isArray(loaded.mismatches))

    // 消费即弃：源卡进 archived；0.26 取件即回执——pending 恰剩刚产出的延续回执卡
    //（回执卡被取件不再产出二次回执，链条到此收敛）
    assert.equal(listArchived(dir).length, 1)
    const after = inboxList({ dir })
    assert.equal(after.ok, true)
    if (!after.ok) return
    assert.equal(after.cards.length, 1, 'pending 恰剩一张：取件即回执的延续回执卡')
    assert.equal(after.cards[0]?.title, `延续回执 · ${pushed.id}`, '回执卡标题带源卡 id（接力链可溯）')
    assert.equal(listPending(dir).length, 1)

    // 二次取件：规范错误值，不抛异常
    const again = inboxLoad(pushed.id, { dir })
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.match(again.error, /收件箱无此待取件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inbox：空 id 与未知 id 都是规范错误值', () => {
  const dir = tmpHome()
  try {
    const empty = inboxLoad('  ', { dir })
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.match(empty.error, /id 不能为空/)

    const missing = inboxLoad('ho-nope-0000', { dir })
    assert.equal(missing.ok, false)
    if (!missing.ok) assert.match(missing.error, /收件箱无此待取件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('核心层二次取件直接调用也报错（消费即弃协议语义）', () => {
  const dir = tmpHome()
  try {
    const pushed = pushHandoff(fakeSession(SAMPLE_EVENTS), {}, { dir })
    assert.equal(pushed.ok, true)
    if (!pushed.ok) return
    loadCard(pushed.id, dir)
    assert.throws(() => loadCard(pushed.id, dir), /收件箱无此待取件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 卡链检索（handoff_inbox action=history） ----------

/** 造一张已归档卡（直写 archived/——历史回查是纯读面，绕开 pushHandoff 的 git 采集） */
function archCard(dir: string, o: { id: string; title: string; project?: string; cwd?: string; pushed_at: string; stopped?: string; supersedes?: string }): void {
  mkdirSync(archivedDir(dir), { recursive: true })
  const card = {
    handoff: 1,
    id: o.id,
    from: { agent: 'dsh', session: '', title: o.title },
    to: 'any',
    project: o.project ?? '',
    cwd: o.cwd ?? '',
    pushed_at: o.pushed_at,
    git: { branch: '', changed: [] },
    tasks: [],
    sections: { goal: '', files: '', done: '', remaining: '', stopped: o.stopped ?? '', warnings: '' },
    extras: { axis: 'session', ...(o.supersedes !== undefined ? { supersedes: o.supersedes } : {}) },
  }
  writeFileSync(join(archivedDir(dir), `${o.id}.md`), renderCard(card as Parameters<typeof renderCard>[0]), 'utf-8')
}

test('history：按 project / cwd 回查 archived/——返回 id/title/pushed_at/stopped 摘要/supersedes，时间正序', () => {
  const dir = tmpHome()
  try {
    archCard(dir, { id: 'ho-h1-aaaa', title: '早卡', project: 'alpha', cwd: 'D:/work/alpha', pushed_at: '2026-11-13T09:00:00+08:00', stopped: '停在写测试', supersedes: 'ho-h0-zzzz' })
    archCard(dir, { id: 'ho-h2-bbbb', title: '晚卡', project: 'alpha', cwd: 'D:/work/alpha', pushed_at: '2026-11-13T10:00:00+08:00', stopped: '停在部署' })
    archCard(dir, { id: 'ho-h3-cccc', title: '别家卡', project: 'beta', cwd: 'D:/work/beta', pushed_at: '2026-11-13T11:00:00+08:00' })
    const all = inboxHistory({ dir })
    assert.equal(all.ok, true)
    if (!all.ok) return
    assert.equal(all.total, 3)
    assert.deepEqual(all.cards.map((c) => c.id), ['ho-h1-aaaa', 'ho-h2-bbbb', 'ho-h3-cccc'], '时间正序（早→晚）')
    const first = all.cards[0]
    assert.equal(first?.title, '早卡')
    assert.equal(first?.pushed_at, '2026-11-13T09:00:00+08:00')
    assert.equal(first?.stopped, '停在写测试')
    assert.equal(first?.supersedes, 'ho-h0-zzzz')
    assert.equal(all.cards[1]?.supersedes, undefined, '无接力链的卡 supersedes 缺省')
    // project 过滤
    const byProject = inboxHistory({ dir, project: 'alpha' })
    assert.equal(byProject.ok, true)
    if (byProject.ok) {
      assert.equal(byProject.total, 2)
      assert.deepEqual(byProject.cards.map((c) => c.id), ['ho-h1-aaaa', 'ho-h2-bbbb'])
    }
    // cwd 过滤
    const byCwd = inboxHistory({ dir, cwd: 'D:/work/beta' })
    assert.equal(byCwd.ok, true)
    if (byCwd.ok) assert.deepEqual(byCwd.cards.map((c) => c.id), ['ho-h3-cccc'])
    // 两个条件同时给 = AND
    const both = inboxHistory({ dir, project: 'alpha', cwd: 'D:/work/beta' })
    assert.equal(both.ok, true)
    if (both.ok) assert.equal(both.cards.length, 0)
    // 渲染分支：历史头 + 停点摘要 + 接力链
    const text = String(renderInbox({}, all)[0]?.text)
    assert.match(text, /卡链历史/)
    assert.match(text, /停在：停在写测试/)
    assert.match(text, /接替 ho-h0-zzzz/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('history：尾 50 条封顶（55 张归档卡只回最新 50，total 照报全量）', () => {
  const dir = tmpHome()
  try {
    for (let i = 0; i < 55; i++) {
      archCard(dir, { id: `ho-t${String(i).padStart(2, '0')}-xxxx`, title: `卡${i}`, pushed_at: `2026-11-01T00:${String(i).padStart(2, '0')}:00+08:00` })
    }
    const r = inboxHistory({ dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.total, 55, 'total 报过滤命中全量')
    assert.equal(r.cards.length, 50, '返回值尾 50 封顶')
    assert.equal(r.cards[0]?.title, '卡5', '最早的 5 张被裁掉')
    assert.equal(r.cards.at(-1)?.title, '卡54', '最新一张保住')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('push：supersedes 进 extras（卡链检索的持久通道——信封取件即弃，卡面才是历史）', () => {
  const dir = tmpHome()
  try {
    const r = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: '接力卡', supersedes: 'ho-prev-0001' }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const card = parseCard(readFileSync(r.path, 'utf-8'))
    assert.equal(card.extras['supersedes'], 'ho-prev-0001')
    // 不传 supersedes：extras 无该键（不写空壳假链）
    const r2 = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: '无接力卡' }, { dir })
    assert.equal(r2.ok, true)
    if (!r2.ok) return
    const card2 = parseCard(readFileSync(r2.path, 'utf-8'))
    assert.equal(card2.extras['supersedes'], undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 接力账本：supersedes 父卡 remaining 前缀继承（确定性拼接，零 LLM） ----------

test('接力账本：父卡已归档——「上一棒遗留」前缀并入新卡 remaining 段（前缀在上、note 留痕）', () => {
  const dir = tmpHome()
  try {
    const parent = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: '父卡目标', remaining: '父卡没干完的事', title: '父卡' }, { dir })
    assert.equal(parent.ok, true)
    if (!parent.ok) return
    // 父卡取件进 archived/（接力常态：先取件再接力）
    assert.equal(inboxLoad(parent.id, { dir }).ok, true)
    const child = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: '子卡目标', remaining: '子卡新事项', supersedes: parent.id }, { dir })
    assert.equal(child.ok, true)
    if (!child.ok) return
    const card = parseCard(readFileSync(child.path, 'utf-8'))
    assert.match(card.sections.remaining, /^【上一棒遗留 · ho-/, '前缀应在段首')
    const atParent = card.sections.remaining.indexOf('父卡没干完的事')
    const atChild = card.sections.remaining.indexOf('子卡新事项')
    assert.ok(atParent >= 0, '父卡遗留文本应随前缀继承')
    assert.ok(atChild >= 0, '子卡自身 remaining 应保留')
    assert.ok(atParent < atChild, '确定性顺序：上一棒遗留在前、新事项在后')
    assert.match(child.note ?? '', /接力账本/, '继承发生应有 note 留痕')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('接力账本：父卡还在 pending（未取件）同样继承——pending 优先于 archived', () => {
  const dir = tmpHome()
  try {
    const parent = pushHandoff(fakeSession(SAMPLE_EVENTS), { remaining: 'pending 里的父卡遗留' }, { dir })
    assert.equal(parent.ok, true)
    if (!parent.ok) return
    const child = pushHandoff(fakeSession(SAMPLE_EVENTS), { remaining: '子卡新事项', supersedes: parent.id }, { dir })
    assert.equal(child.ok, true)
    if (!child.ok) return
    const card = parseCard(readFileSync(child.path, 'utf-8'))
    assert.ok(card.sections.remaining.includes('pending 里的父卡遗留'))
    assert.match(child.note ?? '', /接力账本/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('接力账本：父卡 remaining 超 2KB 截断——产出整体 ≤2048 字节且带截断标记，子卡正文完整', () => {
  const dir = tmpHome()
  try {
    const parent = pushHandoff(fakeSession(SAMPLE_EVENTS), { remaining: '长'.repeat(3000) }, { dir })
    assert.equal(parent.ok, true)
    if (!parent.ok) return
    const child = pushHandoff(fakeSession(SAMPLE_EVENTS), { remaining: '子卡新事项', supersedes: parent.id }, { dir })
    assert.equal(child.ok, true)
    if (!child.ok) return
    const card = parseCard(readFileSync(child.path, 'utf-8'))
    const remaining = card.sections.remaining
    // 前缀体 = 头行之后到子卡正文（空行分隔）之前
    const headEnd = remaining.indexOf('\n')
    const childStart = remaining.indexOf('子卡新事项')
    assert.ok(headEnd >= 0 && childStart > headEnd)
    const inherited = remaining.slice(headEnd + 1, childStart).trimEnd()
    assert.ok(Buffer.byteLength(inherited, 'utf-8') <= 2048, `继承体应 ≤2048 字节（实测 ${Buffer.byteLength(inherited, 'utf-8')}）`)
    assert.match(inherited, /上一棒遗留超 2048 字节已截断/, '截断应留痕')
    assert.ok(!remaining.includes('长'.repeat(1500)), '3000 字的父卡正文不得整段混入')
    assert.ok(remaining.endsWith('子卡新事项'), '子卡自身正文完整保留')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('接力账本：父卡缺席/非法 id——无前缀无痕迹，行为与无 supersedes 完全一致', () => {
  const dir = tmpHome()
  try {
    const plain = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: 'g', remaining: '子卡新事项' }, { dir })
    const ghost = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: 'g', remaining: '子卡新事项', supersedes: 'ho-gone-9999' }, { dir })
    const evil = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: 'g', remaining: '子卡新事项', supersedes: '../../etc/passwd' }, { dir })
    assert.equal(plain.ok && ghost.ok && evil.ok, true)
    if (!(plain.ok && ghost.ok && evil.ok)) return
    const cPlain = parseCard(readFileSync(plain.path, 'utf-8'))
    const cGhost = parseCard(readFileSync(ghost.path, 'utf-8'))
    const cEvil = parseCard(readFileSync(evil.path, 'utf-8'))
    assert.equal(cGhost.sections.remaining, cPlain.sections.remaining, '父卡缺席：remaining 与无 supersedes 完全一致')
    assert.equal(cEvil.sections.remaining, cPlain.sections.remaining, '非法 id（路径走私形态）：同样无前缀、不抛错')
    assert.doesNotMatch(ghost.note, /接力账本/)
    assert.doesNotMatch(evil.note, /接力账本/)
    // 链记录照旧：extras.supersedes 原样入册（继承缺席不影响链本身）
    assert.equal(cGhost.extras['supersedes'], 'ho-gone-9999')
    assert.equal(cEvil.extras['supersedes'], '../../etc/passwd')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('接力账本：父卡遗留里藏着密钥——密钥闸照拦，不因继承放行（0.25 评审[12] 测试钉）', () => {
  const dir = tmpHome()
  try {
    // 密钥串拼接构造：测试源码不出现完整密钥（uncommitted diff 不走私触发补丁扫描）；
    // 父卡用 allowSecrets 留痕旁路写入（旁路的正当用途），子卡无旁路——继承内容必须被闸拦下
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE'
    const parent = pushHandoff(fakeSession(SAMPLE_EVENTS), { remaining: '父卡遗留：aws key: ' + key + '（测试样例）', allowSecrets: true }, { dir })
    assert.equal(parent.ok, true)
    if (!parent.ok) return
    assert.ok((parent.secretsBypass ?? []).length > 0, '父卡密钥旁路应留痕')
    assert.equal(inboxLoad(parent.id, { dir }).ok, true)
    const child = pushHandoff(fakeSession(SAMPLE_EVENTS), { remaining: '子卡新事项', supersedes: parent.id }, { dir })
    assert.equal(child.ok, false, '父卡遗留藏密钥：继承内容必须过密钥闸')
    if (child.ok) return
    assert.match(child.error ?? '', /密钥闸/, '拒收原因应指向密钥闸')
    // 死亡地图照记（secret_gate）——拒收有据可查，不静默
    const events = readLifecycleEvents(dir)
    assert.ok(events.some((e) => e.reason === 'secret_gate'), '写侧拒收应入死亡地图')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('接力账本：父卡 remaining 为空/父卡是坏卡——无可继承则无前缀（不造空壳遗留）', () => {
  const dir = tmpHome()
  try {
    // 父卡直写 archived/（pushHandoff 的 remaining 兜底永远有内容，造不出真空段）
    const emptyParent = {
      handoff: 1,
      id: 'ho-empt-0001',
      from: { agent: 'dsh', session: '', title: '空段父卡' },
      to: 'any',
      project: '',
      cwd: '',
      pushed_at: '2026-11-13T09:00:00+08:00',
      git: { branch: '', changed: [] },
      tasks: [],
      sections: { goal: '', files: '', done: '', remaining: '', stopped: '', warnings: '' },
      extras: {},
    }
    mkdirSync(archivedDir(dir), { recursive: true })
    writeFileSync(join(archivedDir(dir), 'ho-empt-0001.md'), renderCard(emptyParent as Parameters<typeof renderCard>[0]), 'utf-8')
    const child = pushHandoff(fakeSession(SAMPLE_EVENTS), { remaining: '子卡新事项', supersedes: 'ho-empt-0001' }, { dir })
    assert.equal(child.ok, true)
    if (!child.ok) return
    const card = parseCard(readFileSync(child.path, 'utf-8'))
    assert.equal(card.sections.remaining, '子卡新事项', '父卡 remaining 为空：无前缀')
    assert.doesNotMatch(child.note ?? '', /接力账本/)
    // 坏卡父卡：解析失败如实降级，不拖垮子卡寄存
    writeFileSync(join(archivedDir(dir), 'ho-bad1-0001.md'), 'garbage-not-a-card', 'utf-8')
    const child2 = pushHandoff(fakeSession(SAMPLE_EVENTS), { remaining: '子卡新事项', supersedes: 'ho-bad1-0001' }, { dir })
    assert.equal(child2.ok, true)
    if (!child2.ok) return
    assert.equal(parseCard(readFileSync(child2.path, 'utf-8')).sections.remaining, '子卡新事项')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 宿主通知（ctx.userQuestions 阻塞式问答面板） ----------

test('宿主通知：push/load 各用规范问题 id 与文案，agent/signal 透传', async () => {
  const calls: Array<{ id: string; question: string; agent?: unknown; signal?: unknown }> = []
  const uq = {
    ask: async (req: { questions: Array<{ id: string; question: string }>; agent?: unknown; signal?: unknown }) => {
      for (const q of req.questions) calls.push({ id: q.id, question: q.question, agent: req.agent, signal: req.signal })
      return { answers: [] }
    },
  }
  const agent = { session: null } as never
  const controller = new AbortController()
  await handoffHostNotice(uq, 'push', 'ho-abc-123', { agent, signal: controller.signal })
  await handoffHostNotice(uq, 'load', 'ho-def-456', { agent, signal: controller.signal })
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.id, 'handoff-pushed')
  assert.match(calls[0]?.question ?? '', /已寄存会话卡片 handoff:ho-abc-123/)
  assert.equal(calls[1]?.id, 'handoff-picked')
  assert.match(calls[1]?.question ?? '', /已取件会话卡片 handoff:ho-def-456/)
  assert.equal(calls[0]?.agent, agent)
  assert.equal(calls[0]?.signal, controller.signal)
})

test('宿主通知：服务缺席/形态不符/ask 抛错（NO_PROVIDER、DELEGATED_CALLER）都静默不抛', async () => {
  // 服务缺席（undefined / null / 非 ask 对象）
  await handoffHostNotice(undefined, 'push', 'ho-x', {})
  await handoffHostNotice(null, 'push', 'ho-x', {})
  await handoffHostNotice({ noAsk: true }, 'push', 'ho-x', {})
  // ask reject（NO_PROVIDER / DELEGATED_CALLER / ASK_ABORTED）
  await handoffHostNotice({ ask: async () => { throw new Error('NO_PROVIDER') } }, 'push', 'ho-x', {})
  await handoffHostNotice({ ask: async () => { throw new Error('DELEGATED_CALLER') } }, 'load', 'ho-x', {})
})

// ---------- 0.26 集成接线：接力体检（extras.flight / 拒收诊断）+ 上下文预警旁证 ----------

test('pushHandoff：出卡盖接力体检章（extras.flight）——cleared 四项；cautioned 摘要并入读者警告段', () => {
  const dir = tmpHome()
  // file_ref 检查以卡 cwd 为基准解析 files 段的相对路径——fixture 自建独立工作区并造出
  // 被引用文件（经 args.cwd 传入），断言不随测试运行目录漂移（门禁可从仓外目录起跑）
  const ws = mkdtempSync(join(tmpdir(), 'dsh-flight-ws-'))
  mkdirSync(join(ws, 'src'), { recursive: true })
  writeFileSync(join(ws, 'src', 'tools.ts'), '// file_ref fixture\n', 'utf-8')
  try {
    const r = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: '体检 cleared 验证', done: '手写完成项（CURRENT_OBSERVED）', stopped: '停在测试', files: 'src/tools.ts', cwd: ws }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const card = parseCard(readFileSync(join(dir, 'pending', `${r.id}.md`), 'utf-8'))
    const flight = (card.extras as Record<string, unknown>)['flight'] as { verdict?: string; checks?: unknown[] } | undefined
    assert.ok(flight !== undefined, '出卡应盖 extras.flight 章（集成接线 §5.1②）')
    assert.equal(flight?.verdict, 'cleared')
    assert.equal(Array.isArray(flight?.checks) ? (flight?.checks as unknown[]).length : -1, 4, '四检查项固定顺序（file_ref/secret/skeleton/claim_cmd）')

    // cautioned：files 段声称不存在的路径 → file_ref 诊断升级档位，摘要随警告段持久化
    //（no-such/dir 在任何运行目录都不存在——两档判据对 cwd 稳定）
    const r2 = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: '体检 cautioned 验证', files: 'no-such/dir/File.ts', cwd: ws }, { dir })
    assert.equal(r2.ok, true)
    if (!r2.ok) return
    const card2 = parseCard(readFileSync(join(dir, 'pending', `${r2.id}.md`), 'utf-8'))
    const flight2 = (card2.extras as Record<string, unknown>)['flight'] as { verdict?: string } | undefined
    assert.equal(flight2?.verdict, 'cautioned', '声称路径不存在 → cautioned（真实落盘卡只有 cleared/cautioned 两档）')
    assert.match(card2.sections.warnings, /接力体检 cautioned/, 'cautioned 摘要并入读者警告段随卡持久化')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(ws, { recursive: true, force: true })
  }
})

test('pushHandoff：密钥闸拒收路径附体检 blocked 诊断（拒收反馈与 lifecycle detail 同落，无卡可落）', () => {
  const dir = tmpHome()
  try {
    // 密钥样例运行时拼装（不在测试源码留下活的密钥形态字面量——本文件是未提交改动，
    // 字面量会进工作树补丁被 cwd=仓库的 patch 扫描捞到，把全文件 push 全部毒成密钥闸拒收）
    const secretSample = `ghp_${'x'.repeat(24)}1234567890abcd`
    const r = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: `带密验证 ${secretSample}` }, { dir })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /密钥闸/, '既有闸行为零改动')
    assert.match(r.error, /拒收诊断：/, 'blocked 诊断进拒收反馈')
    assert.match(r.error, /接力体检 blocked/)
    const lifecycle = readFileSync(join(dir, 'lifecycle.jsonl'), 'utf-8')
    assert.match(lifecycle, /"reason":"secret_gate"/)
    assert.match(lifecycle, /接力体检 blocked/, 'blocked 诊断进 lifecycle detail')
    assert.equal(existsSync(join(dir, 'pending', 'ho-')), false, '拒收路径无卡可落（诊断不落卡面）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pushHandoff：空壳闸拒收路径同样附体检 blocked 诊断', () => {
  const dir = tmpHome()
  try {
    // 空壳拒收的现场 = 无会话环境（session null，事件流探测降级 → 六段全兜底占位）
    const r = pushHandoff(null, {}, { dir })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /空壳卡守门/, '既有闸行为零改动')
    assert.match(r.error, /拒收诊断：/, 'blocked 诊断进拒收反馈')
    const lifecycle = readFileSync(join(dir, 'lifecycle.jsonl'), 'utf-8')
    assert.match(lifecycle, /"reason":"skeleton_gate"/)
    assert.match(lifecycle, /接力体检 blocked/, 'blocked 诊断进 lifecycle detail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pushHandoff：上下文预警旁证——critical 会话出卡随结果带 contextHealth；ok/unknown 不占字段', () => {
  const dir = tmpHome()
  try {
    const hot = {
      id: 'sess-hot',
      header: { cwd: dir },
      snapshotEvents: () => [{ type: 'assistant/message', seq: 1, data: { usage: { totalTokens: 900 } } }],
      requestContext: () => ({ contextWindow: 1000 }),
    }
    const r = pushHandoff(hot, { goal: '预警旁证验证' }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.contextHealth?.level, 'critical', 'critical 随结果带出（写侧旁证与缓存，呈现走 GET state）')
    assert.equal(r.contextHealth?.action, 'lifeboat')
    const calm = pushHandoff(fakeSession(SAMPLE_EVENTS), { goal: '无预警验证' }, { dir })
    assert.equal(calm.ok, true)
    if (calm.ok) assert.equal(calm.contextHealth, undefined, 'ok/unknown 不占字段（不制造噪音）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pushHandoff：tokenMeter 投影贯通（0.26 probe 接线）——官方 contextPressure 直读随旁证透传；缺席诚实「不可达」', () => {
  const dir = tmpHome()
  try {
    const hot = {
      id: 'sess-proj',
      header: { cwd: dir },
      snapshotEvents: () => [{ type: 'assistant/message', seq: 1, data: { usage: { totalTokens: 900 } } }],
      requestContext: () => ({ contextWindow: 1000 }),
    }
    // 宿主 tokenMeter 在手（集成面 safeTokenMeter/tokenMeterOf 同形态）：投影数值原样透传，绝不自算
    const withMeter = pushHandoff(hot, { goal: '投影贯通验证' }, { dir, tokenMeter: { contextPressure: () => ({ pressureTokens: 880, contextWindow: 1000 }) } })
    assert.equal(withMeter.ok, true)
    if (!withMeter.ok) return
    assert.equal(withMeter.contextHealth?.projection?.pressureTokens, 880, '官方投影直读透传')
    assert.equal(withMeter.contextHealth?.projection?.contextWindow, 1000)
    assert.match(withMeter.contextHealth?.basis ?? '', /tokenMeter\.contextPressure 直读，未参与分级/)
    assert.equal(withMeter.contextHealth?.level, 'critical', '投影只是参考字段，绝不参与分级')

    // 未传 tokenMeter（精简 profile / 老宿主）：projection 缺席 + basis 如实注明不可达
    const noMeter = pushHandoff(hot, { goal: '投影缺席验证' }, { dir })
    assert.equal(noMeter.ok, true)
    if (!noMeter.ok) return
    assert.equal(noMeter.contextHealth?.projection, undefined, '不可达 → 投影键缺席（不编数值）')
    assert.match(noMeter.contextHealth?.basis ?? '', /代价投影不可达，未接入/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 0.26 triage 接线：handoff_inbox 新动作（pin/unpin/restore/search）工具位 ----------

test('handoff_inbox triage 四动作：pin/unpin 幂等两态、restore 恢复往返、search 元字段+正文两态（render 同面）', async () => {
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs')
  const { registerInboxTool, renderInbox } = await import('../src/tools.ts')
  const dir = tmpHome()
  mkdirSync(join(dir, 'pending'), { recursive: true })
  process.env.HANDOFF_HOME = dir
  try {
    writeFileSync(
      join(dir, 'pending', 'ho-tool-0001.md'),
      ['---', 'handoff: 1', 'id: ho-tool-0001', 'from:', '  agent: dsh', '  session: s1', '---', '## 目标', '', '工具位往返钉 BODYWORD', '', '## 涉及文件', '', '- x', '', '## 做到哪', '', '- a', '', '## 还差什么', '', '- b', '', '## 停在哪', '', '- c', '', '## 读者警告', '', '- d', ''].join('\n'),
      'utf-8',
    )
    const registered: Array<{ name: string; def: { execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown> } }> = []
    const ctx = { tools: { register(def: { name: string }): void { registered.push({ name: def.name, def: def as never }) } } }
    registerInboxTool(ctx as never)
    const execute = registered[0]!.def.execute

    // pin：ok；unpin：ok；unpin 未置顶：规范错误值
    assert.deepEqual(await execute({ action: 'pin', id: 'ho-tool-0001' }), { ok: true, action: 'pin', id: 'ho-tool-0001' })
    assert.deepEqual(await execute({ action: 'unpin', id: 'ho-tool-0001' }), { ok: true, action: 'unpin', id: 'ho-tool-0001' })
    const unAgain = await execute({ action: 'unpin', id: 'ho-tool-0001' }) as { ok: boolean; error?: string }
    assert.equal(unAgain.ok, false)
    assert.match(unAgain.error ?? '', /未置顶/)
    // id 消毒在工具位同口径：路径分隔符剥掉
    const pinPath = await execute({ action: 'pin', id: 'a/b' }) as { ok: boolean; id?: string }
    assert.equal(pinPath.ok, true)
    assert.equal(pinPath.id, 'ab')

    // search：元字段命中 + includeBody 正文命中两态；空 query 空命中
    const metaHit = await execute({ action: 'search', q: 'ho-tool' }) as { ok: boolean; hits: Array<{ id: string; where: string }> }
    assert.equal(metaHit.ok, true)
    assert.equal(metaHit.hits.length, 1)
    assert.equal(metaHit.hits[0]?.where, 'meta')
    const bodyHit = await execute({ action: 'search', q: 'BODYWORD', includeBody: true }) as { ok: boolean; hits: Array<{ id: string; where: string; lines: string[] }> }
    assert.equal(bodyHit.hits.length, 1, 'includeBody:true → 纯正文词命中')
    assert.equal(bodyHit.hits[0]?.where, 'body')
    assert.ok(bodyHit.hits[0]?.lines.some((l) => l.includes('BODYWORD')))
    const empty = await execute({ action: 'search', q: '   ' }) as { ok: boolean; hits: unknown[] }
    assert.deepEqual(empty.hits, [], '空 query 空命中（不做全量枚举）')

    // restore：pending 无形态 → 规范错误；dismiss 后整卡搬回
    const restoreMiss = await execute({ action: 'restore', id: 'ho-tool-0001' }) as { ok: boolean; error?: string }
    assert.equal(restoreMiss.ok, false, '还在 pending（archived 无形态）→ 规范错误值')
    const { dismissPending } = await import('../src/settings.ts')
    assert.equal(dismissPending('ho-tool-0001').ok, true)
    const restored = await execute({ action: 'restore', id: 'ho-tool-0001' }) as { ok: boolean; moved?: number }
    assert.equal(restored.ok, true)
    assert.ok((restored.moved ?? 0) >= 1)
    assert.equal(existsSync(join(dir, 'pending', 'ho-tool-0001.md')), true, '恢复后重新可取件')

    // render 面：pin/restore/search 各自一句话回执（真实返回值喂入）
    const pinRender = renderInbox({}, { ok: true, action: 'pin', id: 'ho-x' })
    assert.match(pinRender[0]?.text ?? '', /已置顶：ho-x/)
    const restoreRender = renderInbox({}, { ok: true, action: 'restore', id: 'ho-x', moved: 3 })
    assert.match(restoreRender[0]?.text ?? '', /搬回 pending：ho-x（3 份/)
    const searchRender = renderInbox({}, { ok: true, action: 'search', query: 'q', includeBody: true, scanned: 2, skippedOversize: [], hits: [{ id: 'ho-x', agent: 'dsh', title: 'T', project: '', where: 'body', lines: ['l1'] }] })
    assert.match(searchRender[0]?.text ?? '', /含正文/)
    assert.match(searchRender[0]?.text ?? '', /l1/)
    // 未知 action：参数 schema 层先拦（枚举闸在 defineTool 包装层，比分支兜底更强）
    await assert.rejects(() => execute({ action: 'garbage' }), /must be one of/)
  } finally {
    delete process.env.HANDOFF_HOME
    rmSync(dir, { recursive: true, force: true })
  }
})
