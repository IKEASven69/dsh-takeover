/**
 * 收件箱进阶纯函数测试（0.3.0）：过滤 / 相邻分组 / 新卡判定（已见集合 +
 * HANDOFF_HOME 键散列）/ 导出 md 生成。全部无 DOM 依赖；
 * 导出文本用 @agent-handoff/core 的 parseCard/yamlParse 做 round-trip 断言。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCard, yamlParse } from '@agent-handoff/core'
import {
  SEEN_CAP,
  cardMarkdown,
  filterPending,
  fnv1a,
  groupAdjacent,
  loadSeenSet,
  newIdsOf,
  pendingListMarkdown,
  saveSeenSet,
  seenStorageKey,
  yamlQuote,
  type ExportNotes,
  type PendingGroup,
  type SeenStore,
} from '../src/inbox-view.ts'
import type { PendingRow } from '../src/settings.ts'

/** 造一行待取件（state 里 PendingRow 的最小公分母） */
function makeRow(partial?: Partial<PendingRow>): PendingRow {
  return {
    id: 'ho-test-0001',
    agent: 'claude',
    title: '修收件箱',
    project: 'dsh-takeover',
    pushedAt: '2026-10-03T10:00:00+08:00',
    preview: '把过滤框做完',
    ...partial,
  }
}

/** 来源显示名注入（对齐 client.ts 里 PROVIDER_LABEL 的用法） */
const labelOf = (agent: string): string =>
  ({ claude: 'Claude Code', codex: 'Codex CLI' })[agent] ?? agent

const NOTES: ExportNotes = {
  top: '> 导出说明（顶部）',
  missing: '（该段全文不在 state 内）',
}

// ---------- 过滤 ----------

test('过滤：空串与纯空白不过滤，返回原数组引用', () => {
  const rows = [makeRow(), makeRow({ id: 'ho-test-0002', title: '另一张' })]
  assert.equal(filterPending(rows, '', labelOf), rows)
  assert.equal(filterPending(rows, '   ', labelOf), rows)
})

test('过滤：标题 / 编号 / 来源 id / 来源显示名 子串命中（大小写不敏感）', () => {
  const rows = [
    makeRow(),
    makeRow({ id: 'ho-codex-0009', agent: 'codex', title: '写测试', project: 'x' }),
  ]
  assert.deepEqual(filterPending(rows, '收件箱', labelOf).map((r) => r.id), ['ho-test-0001'])
  assert.deepEqual(filterPending(rows, 'TEST-0002', labelOf).map((r) => r.id), []) // 无此编号
  assert.deepEqual(filterPending(rows, 'test-0001', labelOf).map((r) => r.id), ['ho-test-0001'])
  assert.deepEqual(filterPending(rows, 'codex', labelOf).map((r) => r.id), ['ho-codex-0009'])
  assert.deepEqual(filterPending(rows, 'claude code', labelOf).map((r) => r.id), ['ho-test-0001'])
  assert.deepEqual(filterPending(rows, 'CLAUDE', labelOf).map((r) => r.id), ['ho-test-0001'])
  assert.deepEqual(filterPending(rows, '不存在的词', labelOf), [])
})

// ---------- 相邻分组 ----------

test('分组：同来源+同标题连续折叠；单卡也成组但渲染层按 rows.length 区分', () => {
  const rows = [
    makeRow({ id: 'ho-run-a1' }),
    makeRow({ id: 'ho-run-a2' }),
    makeRow({ id: 'ho-run-a3' }),
  ]
  const groups = groupAdjacent(rows)
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.rows.length, 3)
  assert.equal(groups[0]?.agent, 'claude')
  assert.equal(groups[0]?.title, '修收件箱')
})

test('分组：非相邻同名不合并；换来源断组；空标题永不入组；key 全列表唯一', () => {
  const rows = [
    makeRow({ id: 'ho-grp-0001' }),
    makeRow({ id: 'ho-grp-0002', agent: 'codex' }), // 换来源 → 断
    makeRow({ id: 'ho-grp-0003' }), // 同来源同标题但被隔开 → 不与 0001 合并
    makeRow({ id: 'ho-grp-0004', title: '' }), // 空标题（行内显示编号）永不入组
    makeRow({ id: 'ho-grp-0005', title: '' }),
  ]
  const groups: PendingGroup[] = groupAdjacent(rows)
  assert.equal(groups.length, 5)
  assert.deepEqual(groups.map((g) => g.rows.length), [1, 1, 1, 1, 1])
  assert.equal(new Set(groups.map((g) => g.key)).size, 5)
  // 空标题即使相邻也不合并（0004/0005 各自成组）
  assert.equal(groupAdjacent([makeRow({ id: 'ho-grp-0006', title: '' }), makeRow({ id: 'ho-grp-0007', title: '' })]).length, 2)
})

// ---------- 新卡判定：FNV-1a 键散列 + 已见集合 ----------

test('fnv1a：对齐 FNV-1a 32 位公开测试向量；定长 8 位十六进制', () => {
  assert.equal(fnv1a(''), '811c9dc5')
  assert.equal(fnv1a('a'), 'e40c292c')
  assert.equal(fnv1a('foobar'), 'bf9cf968')
  assert.equal(fnv1a('x').length, 8)
})

test('seenStorageKey：键含 HANDOFF_HOME 散列；不同环境（路径）不同键', () => {
  const a = seenStorageKey('C:/Users/a/.handoff')
  const b = seenStorageKey('C:/Users/b/.handoff')
  assert.notEqual(a, b)
  assert.match(a, /^dsh-takeover\.seen\.v1\.[0-9a-f]{8}$/)
  assert.equal(a, `dsh-takeover.seen.v1.${fnv1a('C:/Users/a/.handoff')}`)
})

/** Map 假货存储（结构对齐 SeenStore） */
function fakeStore(): SeenStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => { map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
  }
}

test('已见集合：round-trip；坏 JSON / 非数组 / 非字符串条目都回空集或剔除', () => {
  const store = fakeStore()
  const key = seenStorageKey('home-a')
  assert.equal(loadSeenSet(store, key).size, 0) // 键不存在
  saveSeenSet(store, key, ['ho-a-0001', 'ho-b-0002'])
  assert.deepEqual([...loadSeenSet(store, key)], ['ho-a-0001', 'ho-b-0002'])
  // 坏 JSON
  store.map.set(key, 'not json{')
  assert.equal(loadSeenSet(store, key).size, 0)
  // 非数组
  store.map.set(key, '{"a":1}')
  assert.equal(loadSeenSet(store, key).size, 0)
  // 非字符串条目剔除
  store.map.set(key, JSON.stringify(['ho-ok-0001', 42, null, {}]))
  assert.deepEqual([...loadSeenSet(store, key)], ['ho-ok-0001'])
})

test('已见集合：存储缺席（null）读写都不抛；超出容量保最新 SEEN_CAP 条', () => {
  assert.doesNotThrow(() => {
    assert.equal(loadSeenSet(null, 'k').size, 0)
    saveSeenSet(null, 'k', ['ho-x-0001'])
  })
  const store = fakeStore()
  const key = 'k'
  const ids = Array.from({ length: SEEN_CAP + 200 }, (_, i) => `ho-${String(i).padStart(4, '0')}-zzzz`)
  saveSeenSet(store, key, ids)
  const loaded = loadSeenSet(store, key)
  assert.equal(loaded.size, SEEN_CAP)
  assert.equal(loaded.has(ids[0] as string), false) // 最旧的被挤掉
  assert.equal(loaded.has(ids[ids.length - 1] as string), true) // 最新的保留
})

test('newIdsOf：本次 state 首次出现（不在已见集合）的 id', () => {
  const rows = [makeRow({ id: 'ho-new-0001' }), makeRow({ id: 'ho-old-0002' })]
  const seen = new Set(['ho-old-0002'])
  assert.deepEqual(newIdsOf(rows, seen), ['ho-new-0001'])
  assert.deepEqual(newIdsOf(rows, new Set(['ho-new-0001', 'ho-old-0002'])), [])
})

// ---------- 导出文本生成 ----------

test('yamlQuote：引号/反斜杠/换行/制表转义，控制字符剔除；core yamlParse round-trip', () => {
  assert.equal(yamlQuote('plain'), '"plain"')
  assert.equal(yamlQuote('a"b'), '"a\\"b"')
  assert.equal(yamlQuote('a\\b'), '"a\\\\b"')
  assert.equal(yamlQuote('a\nb\tc'), '"a\\nb\\tc"')
  assert.equal(yamlQuote('a\rb\u0001c\u007Fd'), '"abcd"') // \r 与其余控制字符剔除
  // round-trip：产出可被协议 yamlParse 原样读回
  const samples = [
    'plain',
    'with "quotes" and \\ backslash',
    'multi\nline\twith tab',
    '冒号: 不加引号会歧义，所以全程带引号',
    '', // 空串
  ]
  for (const s of samples) {
    const parsed = yamlParse(`k: ${yamlQuote(s)}`)
    assert.equal(parsed['k'], s, `round-trip 失败：${JSON.stringify(s)}`)
  }
})

test('cardMarkdown：frontmatter 只写 state 真有字段；六段协议顺序；缺段就地注明不臆造', () => {
  const row = makeRow()
  const md = cardMarkdown(row, NOTES)
  assert.match(md, /^---\nhandoff: 1\n/)
  assert.match(md, /^id: "ho-test-0001"$/m)
  assert.match(md, /^  agent: "claude"$/m)
  assert.match(md, /^  title: "修收件箱"$/m)
  assert.match(md, /^project: "dsh-takeover"$/m)
  assert.match(md, /^pushed_at: "2026-10-03T10:00:00\+08:00"$/m)
  // state 没有的字段一律不写（to/session/cwd/git/tasks 有默认值，不硬造）
  for (const banned of ['to:', 'session:', 'cwd:', 'git:', 'tasks:']) {
    assert.equal(md.includes(banned), false, `不该出现 ${banned}`)
  }
  // 顶部说明在首个段标题之前；六段协议顺序
  const topAt = md.indexOf(NOTES.top)
  const firstHeading = md.indexOf('## ')
  assert.ok(topAt !== -1 && firstHeading !== -1 && topAt < firstHeading)
  const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(headings, ['目标', '涉及文件', '做到哪', '还差什么', '停在哪', '读者警告'])
  // 「目标」= 预览；其余五段就地注明 limitation
  assert.match(md, /## 目标\n\n把过滤框做完\n/)
  assert.equal(md.split(NOTES.missing).length - 1, 5)
  assert.equal(md.endsWith('\n'), true)
  assert.equal(md.endsWith('\n\n'), false)
})

test('cardMarkdown：core parseCard round-trip——id/来源/标题/项目/时间/目标段原样读回', () => {
  const row = makeRow({
    id: 'ho-rnd-1234',
    title: '带"引号"的标题',
    preview: '多行目标\n第二行',
  })
  const card = parseCard(cardMarkdown(row, NOTES))
  assert.equal(card.handoff, 1)
  assert.equal(card.id, 'ho-rnd-1234')
  assert.equal(card.from.agent, 'claude')
  assert.equal(card.from.title, '带"引号"的标题')
  assert.equal(card.project, 'dsh-takeover')
  assert.equal(card.pushed_at, '2026-10-03T10:00:00+08:00')
  assert.equal(card.sections.goal, '多行目标\n第二行')
  assert.match(card.sections.warnings, /state 未提供|不在 state 内|\/inbox/)
  assert.equal(card.to, 'any') // core 对缺省 to 的默认值，非臆造字段
  // 预览为空：目标段也走就地注明，不写空话
  const empty = parseCard(cardMarkdown(makeRow({ preview: '' }), NOTES))
  assert.match(empty.sections.goal, /state 未提供|不在 state 内|\/inbox/)
})

test('pendingListMarkdown：全部待取件拼一个文件；空列表回空串', () => {
  assert.equal(pendingListMarkdown([], NOTES), '')
  const one = cardMarkdown(makeRow(), NOTES)
  assert.equal(pendingListMarkdown([makeRow()], NOTES), `${one.trimEnd()}\n`)
  const two = pendingListMarkdown([makeRow(), makeRow({ id: 'ho-two-0002' })], NOTES)
  assert.equal(two.split('handoff: 1').length - 1, 2)
  assert.ok(two.includes('\n\n---\n\n')) // 卡间分隔线
  assert.equal(two.endsWith('\n'), true)
  assert.equal(two.endsWith('\n\n'), false)
})

// 回归（0.4.1）：filterPending 曾把新 id 集写反（!has），「只看新卡」实际只显旧卡
test('filterPending：newOnly 只留新卡（回归：曾写反成只显旧卡）', () => {
  const rows = [makeRow(), makeRow({ id: 'ho-test-0002' })]
  const seen = new Set(['ho-test-0002'])
  const newIds = new Set(newIdsOf(rows, seen))
  assert.deepEqual(newIds, new Set(['ho-test-0001']))
  const out = filterPending(rows, '', labelOf, null, newIds)
  assert.deepEqual(out.map((r) => r.id), ['ho-test-0001'])
  assert.deepEqual(filterPending(rows, '', labelOf, null, null).map((r) => r.id), ['ho-test-0001', 'ho-test-0002'])
})
