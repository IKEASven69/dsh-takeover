/**
 * 收件箱 triage 三件测试：置顶（三态 + 失效清理 + fail-open）/ 正文过滤
 * （命中 / 不命中 / 空 query / 元字段与正文两种命中面）/ 弃置恢复
 * （全扩展名 + gzip 分块 + 不存在 id 报错 + restored 账本断言）。
 * 夹具直接向 pending/archived 落盘（recovery.spec 同款），聚焦旁路层本身。
 * @module dsh-takeover/inboxtriage
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PINS_CAP,
  setPin,
  unsetPin,
  listPins,
  isPinned,
  pinsPath,
  searchInbox,
  restoreFromArchived,
  BODY_HIT_LINES_MAX,
} from '../src/inboxtriage.ts'
import { LIFECYCLE_REASONS, readLifecycleEvents } from '../src/lifecycle.ts'
import { dismissPending } from '../src/settings.ts'
import { inboxLoad } from '../src/tools.ts'

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'inboxtriage-'))
  mkdirSync(join(dir, 'pending'), { recursive: true })
  mkdirSync(join(dir, 'archived'), { recursive: true })
  return dir
}

/** 直接落一张合法卡（recovery.spec 同款：绕过 pushHandoff 的会话探测） */
function placeCard(home: string, id: string, title?: string, bodyWord?: string): void {
  writeFileSync(join(home, 'pending', `${id}.md`), cardMarkdown(id, title, bodyWord), 'utf-8')
}

function cardMarkdown(id: string, title?: string, bodyWord?: string): string {
  return [
    '---',
    'handoff: 1',
    `id: ${id}`,
    'from:',
    '  agent: dsh',
    '  session: sess-src',
    `  title: ${title ?? 'triage 测试卡'}`,
    'to: any',
    'project: demo',
    'cwd: /corpus/proj0',
    'pushed_at: 2026-01-01T00:00:00+08:00',
    'git:',
    '  branch: main',
    '  dirty: []',
    'tasks: []',
    '---',
    '',
    '## 目标（goal）',
    '',
    bodyWord ? `验证 ${bodyWord} 语义。` : '验证恢复语义。',
    '',
    '## 涉及文件（files）',
    '',
    '- /corpus/proj0/a.ts',
    '',
    '## 做到哪（done）',
    '',
    '- CURRENT_OBSERVED 卡片已落盘',
    '',
    '## 还差什么（remaining）',
    '',
    '- 取件方续做',
    '',
    '## 停在哪（stopped）',
    '',
    '停在寄存时刻。第一步：读卡。',
    '',
    '## 读者警告（warnings）',
    '',
    '- 全部内容 HISTORY_REPORTED。',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// ① 置顶：三态 + 失效清理
// ---------------------------------------------------------------------------

describe('pins：set/unset/list 三态', () => {
  test('set → 在册；unset → 离册；重复 unset 回规范错误值（诚实两态）', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-pin-a001')
      assert.equal(isPinned('ho-pin-a001', dir), false, '初始未置顶')
      const s = setPin('ho-pin-a001', dir)
      assert.equal(s.ok, true)
      assert.deepEqual(listPins(dir), ['ho-pin-a001'])
      assert.equal(isPinned('ho-pin-a001', dir), true)
      // 落盘面：pins.json 在 HANDOFF_HOME 下，键=卡 id
      assert.ok(existsSync(pinsPath(dir)))
      const raw = JSON.parse(readFileSync(pinsPath(dir), 'utf-8')) as Record<string, unknown>
      assert.equal(typeof raw['ho-pin-a001'], 'string')
      // 幂等：重复置顶只刷新时间戳，清单仍是一条
      assert.equal(setPin('ho-pin-a001', dir).ok, true)
      assert.deepEqual(listPins(dir), ['ho-pin-a001'])
      const u = unsetPin('ho-pin-a001', dir)
      assert.equal(u.ok, true)
      assert.deepEqual(listPins(dir), [])
      assert.equal(isPinned('ho-pin-a001', dir), false)
      // 再 unset：本来就没置顶 ≠ 成功解除（诚实两态）
      const u2 = unsetPin('ho-pin-a001', dir)
      assert.equal(u2.ok, false)
      assert.match(u2.error ?? '', /未置顶/)
      // 空 id 回规范错误值
      assert.equal(setPin('', dir).ok, false)
      assert.equal(unsetPin('', dir).ok, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('list 新置顶在前（at 降序）', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-pin-a001')
      placeCard(dir, 'ho-pin-b002')
      placeCard(dir, 'ho-pin-c003')
      setPin('ho-pin-a001', dir, new Date('2026-11-01T00:00:00Z'))
      setPin('ho-pin-b002', dir, new Date('2026-11-03T00:00:00Z'))
      setPin('ho-pin-c003', dir, new Date('2026-11-02T00:00:00Z'))
      assert.deepEqual(listPins(dir), ['ho-pin-b002', 'ho-pin-c003', 'ho-pin-a001'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('容量封顶：超 PINS_CAP 丢最旧，本次置顶必在册', () => {
    const dir = tmpHome()
    try {
      for (let i = 0; i <= PINS_CAP; i++) {
        writeFileSync(join(dir, 'pending', `ho-cap-${String(i).padStart(4, '0')}.md`), 'x', 'utf-8')
        const r = setPin(`ho-cap-${String(i).padStart(4, '0')}`, dir, new Date(2026, 0, 1, 0, 0, 0, i))
        assert.equal(r.ok, true)
      }
      const list = listPins(dir)
      assert.equal(list.length, PINS_CAP)
      assert.ok(!list.includes('ho-cap-0000'), '最旧被挤出')
      assert.ok(list.includes(`ho-cap-${String(PINS_CAP).padStart(4, '0')}`), '最新在册')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pins：失效自动清理（卡被消费/弃置 → 不报错）', () => {
  test('弃置路径：dismissPending 后 pin 自动失效，且 sidecar 里的失效条目被清掉', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-pin-g001')
      assert.equal(setPin('ho-pin-g001', dir).ok, true)
      const d = dismissPending('ho-pin-g001', dir)
      assert.equal(d.ok, true)
      // list 不报错、不含已弃置卡；且回读文件确认懒清理真落盘
      assert.deepEqual(listPins(dir), [])
      const raw = JSON.parse(readFileSync(pinsPath(dir), 'utf-8')) as Record<string, unknown>
      assert.equal(raw['ho-pin-g001'], undefined, '失效条目应从 sidecar 清掉，不是只藏不删')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('消费路径：.md 被 loadCard 搬走（任意实现取走同理）→ pin 失效不报错', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-pin-g002')
      assert.equal(setPin('ho-pin-g002', dir).ok, true)
      const load = inboxLoad('ho-pin-g002', { dir })
      assert.equal(load.ok, true)
      assert.deepEqual(listPins(dir), [])
      assert.ok(existsSync(join(dir, 'archived', 'ho-pin-g002.md')), '卡确实被消费进了 archived')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fail-open：pins.json 损坏视为空集；下次 set 自愈可写；hand-edit 的穿越键被丢弃', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-pin-l001')
      writeFileSync(pinsPath(dir), '{broken json!!!', 'utf-8')
      assert.deepEqual(listPins(dir), [], '损坏 → 空集（fail-open）')
      assert.equal(isPinned('ho-pin-l001', dir), false)
      // 自愈：损坏文件不拦新写入
      assert.equal(setPin('ho-pin-l001', dir).ok, true)
      assert.deepEqual(listPins(dir), ['ho-pin-l001'])
      // 形态不符（数组/标量）→ 空集
      writeFileSync(pinsPath(dir), '["ho-pin-l001"]', 'utf-8')
      assert.deepEqual(listPins(dir), [])
      // hand-edit 的穿越键（含路径分隔符）载入即丢弃，不参与存在性校验
      writeFileSync(pinsPath(dir), JSON.stringify({ 'ho-pin-l001': '2026-11-19T00:00:00Z', '../evil': 'x', '': 'y' }), 'utf-8')
      assert.deepEqual(listPins(dir), ['ho-pin-l001'])
      const raw = JSON.parse(readFileSync(pinsPath(dir), 'utf-8')) as Record<string, unknown>
      assert.equal(raw['../evil'], undefined, '穿越键应被清理出 sidecar')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// ② 正文过滤：命中 / 不命中 / 空 query
// ---------------------------------------------------------------------------

describe('searchInbox：正文过滤', () => {
  test('body 命中：includeBody 读全文，返回命中 id + 命中行摘要', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-srch-a001', undefined, '量子纠错')
      placeCard(dir, 'ho-srch-b002', '别的主题')
      const r = searchInbox('量子纠错', { includeBody: true, dir })
      assert.equal(r.includeBody, true)
      assert.equal(r.scanned, 2, '两张合法卡都该被扫到')
      assert.equal(r.hits.length, 1)
      assert.equal(r.hits[0]!.id, 'ho-srch-a001')
      assert.equal(r.hits[0]!.where, 'body')
      assert.equal(r.hits[0]!.lines.length, 1)
      assert.match(r.hits[0]!.lines[0] ?? '', /量子纠错/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('meta 命中：标题子串（includeBody 缺省也命中），lines 为空；meta+body 双面', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-srch-c003', '重启引导扇区')
      // meta：includeBody 缺省（false）也命中标题
      const meta = searchInbox('引导扇区', { dir })
      assert.equal(meta.includeBody, false)
      assert.equal(meta.hits.length, 1)
      assert.equal(meta.hits[0]!.where, 'meta')
      assert.deepEqual(meta.hits[0]!.lines, [])
      // meta+body：查询词同时在标题与正文
      placeCard(dir, 'ho-srch-d004', '量子纠错', '量子纠错')
      const both = searchInbox('量子纠错', { includeBody: true, dir })
      const hit = both.hits.find((h) => h.id === 'ho-srch-d004')
      assert.equal(hit?.where, 'meta+body')
      assert.ok((hit?.lines.length ?? 0) > 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('大小写不敏感：小写查询命中大写正文（CURRENT_OBSERVED）', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-srch-e005')
      const r = searchInbox('current_observed', { includeBody: true, dir })
      assert.equal(r.hits.length, 1)
      assert.equal(r.hits[0]!.id, 'ho-srch-e005')
      assert.equal(r.hits[0]!.where, 'body')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('不命中：hits 空、scanned 如实；空 query：空命中且不做全量枚举', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-srch-f006')
      const miss = searchInbox('不存在的词组', { includeBody: true, dir })
      assert.deepEqual(miss.hits, [])
      assert.equal(miss.scanned, 1)
      assert.deepEqual(miss.skippedOversize, [])
      const empty = searchInbox('   ', { includeBody: true, dir })
      assert.deepEqual(empty.hits, [])
      assert.equal(empty.scanned, 0, '空 query 不做全量枚举')
      assert.equal(empty.error, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('includeBody 缺省：body-only 词不命中（正文不进匹配面）', () => {
    const dir = tmpHome()
    try {
      placeCard(dir, 'ho-srch-g007', undefined, '量子纠错')
      const r = searchInbox('量子纠错', { dir })
      assert.deepEqual(r.hits, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('防御：超尺寸卡不进命中面（core 读侧已跳过）；同 id 重复文件只扫一次', () => {
    const dir = tmpHome()
    try {
      // 超尺寸卡（>8MiB）：含查询词也不该被读进内存/命中——读侧尺寸闸同口径
      writeFileSync(join(dir, 'pending', 'ho-srch-b008.md'), `x 量子纠错 x${'x'.repeat(8 * 1024 * 1024)}`, 'utf-8')
      placeCard(dir, 'ho-srch-o009')
      const r = searchInbox('量子纠错', { includeBody: true, dir })
      assert.ok(!r.hits.some((h) => h.id === 'ho-srch-b008'), '超尺寸卡不该命中（读侧已跳过）')
      assert.equal(r.scanned, 1, '超尺寸卡不计入扫描数')
      // 同 frontmatter id 重复文件：只扫首次（settings.buildState 同款去重）——
      // 扫描数=去重后卡数（与目录枚举顺序无关的确定性口径），命中面里同一 id 不重复出现
      placeCard(dir, 'ho-srch-o009', '二号同名卡')
      writeFileSync(join(dir, 'pending', 'ho-srch-d010.md'), cardMarkdown('ho-srch-o009', '借壳卡'), 'utf-8')
      const dup = searchInbox('量子纠错', { includeBody: true, dir })
      assert.equal(dup.scanned, 1, '同 id 两文件按首次出现去重，扫描数=1')
      assert.ok(dup.hits.filter((h) => h.id === 'ho-srch-o009').length <= 1, '命中面同一 id 不重复出现')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('命中行摘要封顶：单卡至多 BODY_HIT_LINES_MAX 行、超长行截断', () => {
    const dir = tmpHome()
    try {
      const lines = Array.from({ length: BODY_HIT_LINES_MAX + 3 }, (_, i) => `命中行${i} 锚点词`)
      const md = [
        '---',
        'handoff: 1',
        'id: ho-srch-c011',
        'from:',
        '  agent: dsh',
        '  session: s',
        '  title: t',
        'to: any',
        'project: demo',
        'cwd: /c',
        'pushed_at: 2026-01-01T00:00:00+08:00',
        'git:',
        '  branch: main',
        '  dirty: []',
        'tasks: []',
        '---',
        '',
        ...lines,
        `超长${'锚点词'.repeat(100)}行尾巴`,
      ].join('\n')
      writeFileSync(join(dir, 'pending', 'ho-srch-c011.md'), md, 'utf-8')
      const r = searchInbox('锚点词', { includeBody: true, dir })
      assert.equal(r.hits.length, 1)
      assert.equal(r.hits[0]!.lines.length, BODY_HIT_LINES_MAX)
      for (const line of r.hits[0]!.lines) assert.ok(line.length <= 161, `摘要行应截断在 ${160}+省略号内`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// ③ 弃置恢复：全扩展名 + gzip 分块 + 不存在 id + restored 账本
// ---------------------------------------------------------------------------

describe('restoreFromArchived：dismiss 的逆操作', () => {
  test('全扩展名：md/信封/补丁/gzip 单块/蒸馏侧车五件全搬回 pending', () => {
    const dir = tmpHome()
    try {
      const id = 'ho-rstr-f001'
      placeCard(dir, id)
      writeFileSync(join(dir, 'pending', `${id}.envelope.json`), '{"supersedes":""}', 'utf-8')
      writeFileSync(join(dir, 'pending', `${id}.patch`), 'diff x', 'utf-8')
      writeFileSync(join(dir, 'pending', `${id}.patch.gz`), Buffer.from([0x1f, 0x8b]), 'utf-8')
      writeFileSync(join(dir, 'pending', `${id}.hippo.jsonl`), '{}\n', 'utf-8')
      const d = dismissPending(id, dir)
      assert.equal(d.ok, true)
      assert.equal(d.moved, 5)
      assert.deepEqual(readdirSync(join(dir, 'pending')).filter((f) => f.startsWith(id)), [])
      const r = restoreFromArchived(id, dir)
      assert.equal(r.ok, true)
      assert.equal(r.moved, 5)
      for (const ext of ['.md', '.envelope.json', '.patch', '.patch.gz', '.hippo.jsonl']) {
        assert.ok(existsSync(join(dir, 'pending', id + ext)), `恢复后 pending 应有 ${id}${ext}`)
        assert.ok(!existsSync(join(dir, 'archived', id + ext)), `archived 应不再有 ${id}${ext}`)
      }
      // 端到端闭环：恢复后的卡重新可见、可再次取件（消费即弃状态机照常运转）
      assert.ok(existsSync(join(dir, 'pending', `${id}.md`)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('gzip 分块：.patch.NNN.gz 名单扫同搬；非纯数字序号的伪装块不搬', () => {
    const dir = tmpHome()
    try {
      const id = 'ho-rstr-c001'
      placeCard(dir, id)
      writeFileSync(join(dir, 'pending', `${id}.patch.001.gz`), Buffer.from([0x1f, 0x8b]), 'utf-8')
      writeFileSync(join(dir, 'pending', `${id}.patch.002.gz`), Buffer.from([0x1f, 0x8b]), 'utf-8')
      // 伪装块（序号段非纯数字）：dismiss 与 restore 的正则口径一致——都不认
      writeFileSync(join(dir, 'pending', `${id}.patch.abc.gz`), Buffer.from([0x1f, 0x8b]), 'utf-8')
      assert.ok(existsSync(join(dir, 'pending', `${id}.patch.abc.gz`)), 'dismiss 不认伪装块 → 留在 pending')
      const d = dismissPending(id, dir)
      assert.equal(d.ok, true)
      assert.equal(d.moved, 3, '.md + 两分块应全搬；伪装块不在枚举内')
      assert.ok(existsSync(join(dir, 'pending', `${id}.patch.abc.gz`)), 'dismiss 不认伪装块 → 留在 pending')
      const r = restoreFromArchived(id, dir)
      assert.equal(r.ok, true)
      assert.equal(r.moved, 3)
      assert.ok(existsSync(join(dir, 'pending', `${id}.patch.001.gz`)))
      assert.ok(existsSync(join(dir, 'pending', `${id}.patch.002.gz`)))
      assert.ok(existsSync(join(dir, 'pending', `${id}.patch.abc.gz`)), 'restore 同口径：不认即不动，伪装块留 pending')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('不存在 id / 空 id 回规范错误值；restored 正向回执落账（闭集成员 + 读写保真）', () => {
    const dir = tmpHome()
    try {
      const miss = restoreFromArchived('ho-rstr-n001', dir)
      assert.equal(miss.ok, false)
      assert.match(miss.error ?? '', /archived/)
      assert.equal(restoreFromArchived('', dir).ok, false)
      assert.equal(readLifecycleEvents(dir).length, 0, '失败恢复不落账')
      // 成功路径 + 账本断言
      const id = 'ho-rstr-l001'
      placeCard(dir, id)
      assert.equal(dismissPending(id, dir).ok, true)
      const r = restoreFromArchived(id, dir, new Date('2026-11-19T00:00:00Z'))
      assert.equal(r.ok, true)
      const ev = readLifecycleEvents(dir)
      assert.equal(ev.length, 1)
      assert.equal(ev[0]!.stage, 'write')
      assert.equal(ev[0]!.reason, 'restored')
      assert.equal(ev[0]!.target, id)
      assert.match(ev[0]!.detail, /1 份/)
      // 闭集成员断言：新增理由 = 改 LIFECYCLE_REASONS + 测试（lifecycle.ts 纪律钉）
      assert.ok((LIFECYCLE_REASONS as readonly string[]).includes('restored'))
      assert.ok((LIFECYCLE_REASONS as readonly string[]).includes(ev[0]!.reason), '读写保真：round-trip 后仍在闭集内（不落 unknown）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('碰撞保护：pending 已有同名卡时一次都不搬（rename 覆盖即毁活卡）', () => {
    const dir = tmpHome()
    try {
      const id = 'ho-rstr-o001'
      placeCard(dir, id, '原卡')
      writeFileSync(join(dir, 'pending', `${id}.envelope.json`), '{"supersedes":""}', 'utf-8')
      assert.equal(dismissPending(id, dir).ok, true)
      // 同 id 卡被重新 push 过：pending 已有同名 .md
      placeCard(dir, id, '重推的新卡')
      const r = restoreFromArchived(id, dir)
      assert.equal(r.ok, false)
      assert.match(r.error ?? '', /拒绝覆盖/)
      // archived 侧原样未动（预检先行，一个都不搬）
      assert.ok(existsSync(join(dir, 'archived', `${id}.md`)))
      assert.ok(existsSync(join(dir, 'archived', `${id}.envelope.json`)))
      assert.equal(readFileSync(join(dir, 'pending', `${id}.md`), 'utf-8').includes('重推的新卡'), true, '活卡未被覆盖')
      assert.equal(readLifecycleEvents(dir).length, 0, '未完成的恢复不落账')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
