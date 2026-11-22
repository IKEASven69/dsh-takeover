/**
 * 接管预检三档判定（assessForeignTakeover）测试。
 * 覆盖：
 * - 五检查项正负例：liveness 三桶（近端/远端/缺时刻）、integrity（ok:false 与空 turns
 *   判 decline）、bulk（估算词负向断言 + 观察值陈述）、scene（注入桩跨机缺文件常态 +
 *   相对路径 cwd 解析 + 探测异常未确认）、reader（supported=false 与 note 非空两 wound
 *   来源）；
 * - 三档判定边界：integrity 失败→decline、仅 liveness unknown→ready+basis 注明、
 *   单伤→wounded（wounds 逐条可点）；
 * - fail-open 负向：任一检查项抛错→该项 unknown、assess 整体不抛；坏输入（非 object
 *   read）不抛；
 * - 同输入同判定确定性；零子进程零写盘静态负向断言（含七集成面零 import）。
 * 全部用例注入探测桩/固定 now，不碰真实盘面；演示数据只进本测试文件。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  LIVENESS_RECENT_MS,
  PREFLIGHT_KINDS,
  PREFLIGHT_STATES,
  PREFLIGHT_VERDICTS,
  assessForeignTakeover,
  type PreflightCard,
  type PreflightCheck,
  type PreflightInput,
  type PreflightKind,
} from '../src/preflight.ts'

// ---------- fixture ----------

const NOW = new Date('2026-11-20T12:00:00.000Z')
const FILE_A = 'D:\\other-machine\\proj\\src\\a.ts'
const FILE_B = 'D:\\other-machine\\proj\\src\\b.ts'

/** 健康 show 规范值（README.md:84 结构化摘要形态：轮数/涉及文件 top15/尾部进展） */
function showRead(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ok: true,
    action: 'show',
    provider: 'claude',
    summary: {
      title: '联调收尾',
      sessionId: 'sess-1',
      cwd: 'D:\\other-machine\\proj',
      updatedAt: '2026-11-20T08:00:00.000Z',
      turnCount: 42,
      userTurns: 18,
      firstUserMessage: '把接管跑通',
      lastUserMessage: '收尾',
      tailProgress: ['进展一', '进展二', '进展三'],
      files: [FILE_A, FILE_B],
      commands: [],
    },
    skeleton: { goal: 'x' },
    turnsTotal: 42,
    turnsOffset: 0,
  }
  return { ...base, ...overrides }
}

const cleanNote = { supported: true, note: '' }
const allPresent = (): boolean => true

function assess(read: unknown, extra: Partial<PreflightInput> = {}) {
  return assessForeignTakeover({ read, now: NOW, exists: allPresent, adapterNote: cleanNote, ...extra })
}

const checkOf = (card: PreflightCard, kind: PreflightKind): PreflightCheck | undefined =>
  card.checks.find((c) => c.kind === kind)

// ---------- 契约形态 ----------

describe('立约形态：{ verdict, checks[], wounds[], basis } 四件，不夹带', () => {
  test('卡恰四键；checks 固定序五项；states/verdicts 闭集', () => {
    const card = assess(showRead())
    assert.deepEqual(Object.keys(card).sort(), ['basis', 'checks', 'verdict', 'wounds'])
    assert.deepEqual(card.checks.map((c) => c.kind), [...PREFLIGHT_KINDS])
    assert.ok(card.checks.every((c) => (PREFLIGHT_STATES as readonly string[]).includes(c.state)))
    assert.ok((PREFLIGHT_VERDICTS as readonly string[]).includes(card.verdict))
    assert.equal(card.verdict, 'ready')
    assert.equal(card.wounds.length, 0)
  })

  test('健康输入五项全 ok，basis 概述可直接接管', () => {
    const card = assess(showRead())
    assert.ok(card.checks.every((c) => c.state === 'ok'), JSON.stringify(card.checks))
    assert.match(card.basis, /可直接接管/)
    assert.match(card.basis, /最近活动/)
  })
})

// ---------- liveness 三桶 ----------

describe('liveness 死活：近端/远端/缺时刻三桶（启发式分桶，非运行状态断言）', () => {
  test('正例：最近活动在预检时刻前 24 小时内 → 近端', () => {
    const card = assess(showRead())
    const live = checkOf(card, 'liveness')
    assert.equal(live?.state, 'ok')
    assert.match(live?.detail ?? '', /近端/)
    assert.match(live?.detail ?? '', /最近活动/)
  })

  test('负例 1：最近活动早于预检时刻 24 小时 → 远端；文案不出现「正在运行/运行中」', () => {
    const stale = showRead({ summary: { updatedAt: '2026-10-01T08:00:00.000Z', turnCount: 7, files: [] } })
    const card = assess(stale)
    const live = checkOf(card, 'liveness')
    assert.equal(live?.state, 'ok')
    assert.match(live?.detail ?? '', /远端/)
    assert.doesNotMatch(JSON.stringify(card), /正在运行|运行中/)
    assert.ok(LIVENESS_RECENT_MS === 24 * 60 * 60 * 1000)
  })

  test('负例 2：缺时刻（空串/不可解析）→ unknown 死活未知，不编造活性', () => {
    for (const updatedAt of ['', 'not-a-time']) {
      const card = assess(showRead({ summary: { updatedAt, turnCount: 3, files: [] } }))
      const live = checkOf(card, 'liveness')
      assert.equal(live?.state, 'unknown', `updatedAt=${updatedAt}`)
      assert.match(live?.detail ?? '', /死活未知/)
    }
  })
})

// ---------- integrity 日志完整性 ----------

describe('integrity 日志完整性：ok:false 与空 turns → decline', () => {
  test('负例 1：read ok:false → integrity wound，verdict decline，basis 点名建议放弃', () => {
    const card = assess({ ok: false, error: '解析 claude 会话失败：坏 JSONL 行' })
    assert.equal(card.verdict, 'decline')
    assert.equal(checkOf(card, 'integrity')?.state, 'wound')
    assert.match(card.basis, /建议放弃接管/)
    assert.match(card.basis, /坏 JSONL 行/)
    assert.equal(card.wounds.length, 1)
    assert.equal(card.wounds[0]?.kind, 'integrity')
  })

  test('负例 2：空会话（轮数 0）→ integrity wound，verdict decline（UNAVAILABLE 口径）', () => {
    const card = assess(showRead({
      summary: { updatedAt: '2026-11-20T08:00:00.000Z', turnCount: 0, files: [] },
      turnsTotal: 0,
      note: '会话解析为空：记录损坏、加密或格式不可恢复（按 UNAVAILABLE 处理）',
    }))
    assert.equal(card.verdict, 'decline')
    const integ = checkOf(card, 'integrity')
    assert.equal(integ?.state, 'wound')
    assert.match(integ?.detail ?? '', /空会话/)
    assert.match(integ?.detail ?? '', /UNAVAILABLE/)
  })

  test('正例：健康 read → integrity ok，不 decline', () => {
    const card = assess(showRead())
    assert.equal(checkOf(card, 'integrity')?.state, 'ok')
    assert.notEqual(card.verdict, 'decline')
  })

  test('组合：integrity 失败叠加 reader 伤 → 仍 decline，wounds 逐条并存', () => {
    const card = assess({ ok: false, error: '读取器不可用' }, { adapterNote: { supported: false, note: 'node:sqlite 缺失' } })
    assert.equal(card.verdict, 'decline')
    assert.equal(card.wounds.length, 2)
    assert.deepEqual(card.wounds.map((w) => w.kind).sort(), ['integrity', 'reader'])
  })
})

// ---------- bulk 体量（估算词负向断言） ----------

describe('bulk 体量：只陈述读取器原样观察值，全卡输出无估算词', () => {
  test('正例：陈述轮数/用户轮/涉及文件在册数/尾部进展条数', () => {
    const card = assess(showRead())
    const bulk = checkOf(card, 'bulk')
    assert.equal(bulk?.state, 'ok')
    assert.match(bulk?.detail ?? '', /轮数 42/)
    assert.match(bulk?.detail ?? '', /用户轮 18/)
    assert.match(bulk?.detail ?? '', /涉及文件在册 2 项/)
    assert.match(bulk?.detail ?? '', /尾部进展摘录 3 条/)
  })

  test('负向断言：判定卡全量 JSON 不含「预计/约/耗时/token」估算词（context #240 前车之鉴）', () => {
    const wounded = assessForeignTakeover({
      read: showRead({ summary: { updatedAt: '2026-10-01T08:00:00.000Z', turnCount: 7, userTurns: 3, files: [FILE_A], tailProgress: ['停在中段'] } }),
      adapterNote: { supported: true, note: '候选目录全不命中：HANDOFF_ROOT_MIMO 可直指库文件' },
      now: NOW,
      exists: allPresent,
    })
    const json = JSON.stringify(wounded)
    assert.doesNotMatch(json, /预计/, '输出不得出现「预计」')
    assert.doesNotMatch(json, /约/, '输出不得出现「约」字（含大约/预估/契约等衍生词）')
    assert.doesNotMatch(json, /耗时/, '输出不得出现「耗时」')
    assert.doesNotMatch(json, /token/i, '输出不得出现 token 估算')
  })

  test('负例：read 未取回 → bulk unknown（无从陈述，不编造观察值）', () => {
    const card = assess({ ok: false, error: 'x' })
    assert.equal(checkOf(card, 'bulk')?.state, 'unknown')
  })
})

// ---------- scene 文件现场 ----------

describe('scene 文件现场：注入桩跨机缺文件常态逐条列伤', () => {
  test('负例：跨机缺文件 → 逐条 wound（item=路径），detail 给「N/M 个涉及文件不在本盘」', () => {
    const present = new Set([FILE_A])
    const card = assess(showRead(), { exists: (p) => present.has(p) })
    assert.equal(card.verdict, 'wounded')
    const scene = checkOf(card, 'scene')
    assert.equal(scene?.state, 'wound')
    assert.match(scene?.detail ?? '', /1\/2 个涉及文件不在本盘/)
    assert.equal(card.wounds.length, 1)
    assert.equal(card.wounds[0]?.kind, 'scene')
    assert.equal(card.wounds[0]?.item, FILE_B, 'wound 逐条可点：item 即缺失文件路径')
    assert.match(card.basis, /带伤接管/)
    assert.match(card.basis, new RegExp(FILE_B.replace(/\\/g, '\\\\')))
  })

  test('正例：全部在盘 → scene ok', () => {
    const card = assess(showRead(), { exists: allPresent })
    assert.equal(checkOf(card, 'scene')?.state, 'ok')
    assert.equal(card.wounds.length, 0)
  })

  test('探测抛错（symlink/权限常态）→ 未确认 unknown，不编造缺盘也不编造在盘', () => {
    const card = assess(showRead(), { exists: () => { throw new Error('EPERM') } })
    const scene = checkOf(card, 'scene')
    assert.equal(scene?.state, 'unknown')
    assert.equal(card.wounds.length, 0)
    assert.match(scene?.detail ?? '', /未能确认/)
  })

  test('相对路径按摘要 cwd 解析探测；无 cwd 的相对路径如实未确认', () => {
    const calls: string[] = []
    const rel = showRead({ summary: { cwd: 'D:\\proj', files: ['src\\rel.ts'], updatedAt: '2026-11-20T08:00:00.000Z', turnCount: 5 } })
    const probed = assess(rel, { exists: (p) => { calls.push(p); return true } })
    assert.deepEqual(calls, [join('D:\\proj', 'src\\rel.ts')])
    assert.equal(checkOf(probed, 'scene')?.state, 'ok')

    const noCwd = showRead({ summary: { cwd: '', files: ['src\\rel.ts'], updatedAt: '2026-11-20T08:00:00.000Z', turnCount: 5 } })
    const unconfirmed = assess(noCwd, { exists: allPresent })
    assert.equal(checkOf(unconfirmed, 'scene')?.state, 'unknown')
    assert.equal(unconfirmed.wounds.length, 0)
  })

  test('摘要无涉及文件清单 → scene ok（无现场可核，不算伤）', () => {
    const card = assess(showRead({ summary: { files: [], updatedAt: '2026-11-20T08:00:00.000Z', turnCount: 1 } }))
    assert.equal(checkOf(card, 'scene')?.state, 'ok')
  })
})

// ---------- reader 读取器降级 ----------

describe('reader 读取器降级：supported=false 与降级注记两 wound 来源（README.md:62 先例口径）', () => {
  test('负例 1：supported=false → wound，item=provider 名', () => {
    const card = assess(showRead(), { adapterNote: { supported: false, note: '候选目录全不命中' } })
    assert.equal(card.verdict, 'wounded')
    const reader = checkOf(card, 'reader')
    assert.equal(reader?.state, 'wound')
    assert.match(reader?.detail ?? '', /读取器不可用/)
    assert.match(reader?.detail ?? '', /候选目录全不命中/)
    const wound = card.wounds.find((w) => w.kind === 'reader')
    assert.equal(wound?.item, 'claude')
  })

  test('负例 2：supported=true 但 note 非空（降级注记）→ wound', () => {
    const card = assess(showRead(), { adapterNote: { supported: true, note: '数据路径按上游源码推导，未实机核实' } })
    assert.equal(card.verdict, 'wounded')
    const reader = checkOf(card, 'reader')
    assert.equal(reader?.state, 'wound')
    assert.match(reader?.detail ?? '', /降级注记/)
  })

  test('正例：supported=true 且 note 空 → reader ok', () => {
    const card = assess(showRead())
    assert.equal(checkOf(card, 'reader')?.state, 'ok')
  })

  test('负例 3：未获适配注记 → unknown（支持情况未知）', () => {
    const card = assess(showRead(), { adapterNote: undefined })
    assert.equal(checkOf(card, 'reader')?.state, 'unknown')
    assert.equal(card.verdict, 'ready', 'unknown 只降级不升档：无 wound 不 wounded')
    assert.match(card.basis, /reader 未核验/)
  })
})

// ---------- 三档判定边界 ----------

describe('三档判定边界（调研 TOP 缺口 #1 三档语言逐字）', () => {
  test('integrity 失败 → decline（唯一 decline 来源）', () => {
    assert.equal(assess({ ok: false, error: 'x' }).verdict, 'decline')
    assert.equal(assess(showRead({ turnsTotal: 0, summary: { turnCount: 0, files: [], updatedAt: '2026-11-20T08:00:00.000Z' } })).verdict, 'decline')
  })

  test('仅 liveness unknown → ready + basis 注明死活未知', () => {
    const card = assess(showRead({ summary: { updatedAt: '', turnCount: 42, files: [FILE_A, FILE_B], userTurns: 18, tailProgress: ['x'] } }))
    assert.equal(card.verdict, 'ready')
    assert.equal(card.wounds.length, 0)
    assert.match(card.basis, /死活未知/)
    assert.match(card.basis, /可直接接管/)
  })

  test('单伤 → wounded 且 wounds 逐条可点（scene 单缺 + reader 单伤两形态）', () => {
    const present = new Set([FILE_A, FILE_B])
    const sceneOnly = assess(showRead({ summary: { cwd: 'D:\\other-machine\\proj', files: [FILE_A, 'D:\\elsewhere\\c.ts'], updatedAt: '2026-11-20T08:00:00.000Z', turnCount: 9 } }), { exists: (p) => present.has(p) })
    assert.equal(sceneOnly.verdict, 'wounded')
    assert.equal(sceneOnly.wounds.length, 1)
    assert.equal(sceneOnly.wounds[0]?.item, 'D:\\elsewhere\\c.ts')

    const readerOnly = assess(showRead(), { adapterNote: { supported: false, note: '' } })
    assert.equal(readerOnly.verdict, 'wounded')
    assert.equal(readerOnly.wounds.length, 1)
    assert.equal(readerOnly.wounds[0]?.kind, 'reader')
  })
})

// ---------- fail-open 负向 ----------

describe('fail-open：任一检查项抛错→该项 unknown、assess 整体不抛（绝不拦真实接管）', () => {
  test('summary.files 投毒 getter → 仅 scene 中断为 unknown，其余四项照常核验', () => {
    const poison: Record<string, unknown> = {
      ok: true,
      provider: 'claude',
      summary: {
        updatedAt: '2026-11-20T08:00:00.000Z',
        turnCount: 5,
        get files(): string[] { throw new Error('poison') },
      },
    }
    const card = assess(poison)
    assert.equal(checkOf(card, 'scene')?.state, 'unknown')
    assert.match(checkOf(card, 'scene')?.detail ?? '', /检查中断/)
    // bulk 同样读 files 字段数数——碰到毒的字段各自如实转 unknown（fail-open 粒度：谁碰谁缺省）
    assert.equal(checkOf(card, 'bulk')?.state, 'unknown')
    assert.equal(checkOf(card, 'liveness')?.state, 'ok')
    assert.equal(checkOf(card, 'integrity')?.state, 'ok')
    assert.equal(card.verdict, 'ready', 'unknown 只降级不升档')
    assert.match(card.basis, /bulk、scene 未核验/, '未核验项按 checks 固定序进 basis')
  })

  test('顶层 read 投毒 getter → 整体兜底卡（全 unknown、verdict ready、不抛）', () => {
    const poisonInput: PreflightInput = { read: 0, now: NOW }
    Object.defineProperty(poisonInput, 'read', { get() { throw new Error('poison') }, enumerable: true })
    const card = assessForeignTakeover(poisonInput)
    assert.equal(card.verdict, 'ready')
    assert.ok(card.checks.every((c) => c.state === 'unknown'))
    assert.equal(card.wounds.length, 0)
    assert.match(card.basis, /不构成健康背书/)
  })

  test('坏输入（非 object read：数字/字符串/null/数组）不抛，integrity unknown', () => {
    for (const bad of [42, 'str', null, [1, 2]]) {
      const card = assess(bad)
      assert.equal(checkOf(card, 'integrity')?.state, 'unknown', `read=${JSON.stringify(bad)}`)
      assert.equal(card.wounds.length, 0)
      assert.notEqual(card.verdict, 'decline', '坏输入绝不触发 decline 拦接管')
    }
  })

  test('now/exists 坏形态不炸：now 乱串回退、exists 缺省回退 fs.existsSync（无文件清单则探测零触发，不碰真实盘）', () => {
    // files 留空（scene 零探测，不依赖本机盘面）+ updatedAt 留空（liveness 不依赖本机时钟）
    const card = assessForeignTakeover({ read: showRead({ summary: { files: [], updatedAt: '', turnCount: 42 } }), now: 'garbage', exists: undefined })
    assert.notEqual(card.verdict, 'decline')
    assert.ok(card.checks.length === 5)
    assert.equal(checkOf(card, 'integrity')?.state, 'ok')
    assert.equal(checkOf(card, 'scene')?.state, 'ok')
    assert.equal(checkOf(card, 'bulk')?.state, 'ok')
  })
})

// ---------- 确定性 ----------

describe('同输入同判定确定性', () => {
  test('同 read/adapterNote/now/exists 两次调用逐字节相等', () => {
    const input: PreflightInput = {
      read: showRead({ summary: { cwd: 'D:\\other-machine\\proj', files: [FILE_A, FILE_B], updatedAt: '2026-10-01T08:00:00.000Z', turnCount: 42, userTurns: 18, tailProgress: ['x'] } }),
      adapterNote: { supported: true, note: 'note' },
      now: NOW,
      exists: (p) => p === FILE_A,
    }
    const a = assessForeignTakeover(input)
    const b = assessForeignTakeover(input)
    assert.equal(JSON.stringify(a), JSON.stringify(b))
    assert.equal(a.verdict, 'wounded')
  })
})

// ---------- 零子进程零写盘 + 集成面零 import（静态负向断言） ----------

describe('零子进程零写盘负向断言（模块唯一下游是注入式探测）', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/preflight.ts', import.meta.url)), 'utf-8')

  test('无子进程面：不 import child_process，无 exec/spawn 调用形态', () => {
    assert.doesNotMatch(src, /from\s+['"]node:child_process['"]/, '预检模块不得引入子进程面')
    assert.doesNotMatch(src, /(?<!\.)\bexec(?:File|FileSync|Sync)?\s*\(/, '不得出现 exec 调用形态')
    assert.doesNotMatch(src, /(?<!\.)\bspawn(?:Sync)?\s*\(/, '不得出现 spawn 调用形态')
  })

  test('无写盘面：node:fs 只 import existsSync，无任何写/删/改调用形态', () => {
    assert.match(src, /import\s*\{\s*existsSync\s*\}\s*from\s+['"]node:fs['"]/)
    assert.doesNotMatch(src, /writeFileSync|mkdirSync|rmSync|unlinkSync|appendFileSync|truncateSync|chmodSync|renameSync|copyFileSync/)
  })

  test('不 import 七个集成面文件（tools/server/client/settings/index/locales/collect）', () => {
    for (const f of ['tools', 'server', 'client', 'settings', 'index', 'locales', 'collect']) {
      assert.doesNotMatch(src, new RegExp(`from\\s+['"]\\./${f}\\.ts['"]`), `预检模块不得 import ./${f}.ts`)
    }
  })
})
