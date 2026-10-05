/**
 * HTML 单文件报告导出测试（0.3.2）：state→html 纯函数（src/client.ts 的
 * buildReportHtml / reportWords）+ host 侧并行字段的防御式读取
 * （envelopeCharsOf / coverageTextOf）。全部无 DOM、无时钟依赖：
 * generatedAt 由测试喂固定串，输出逐字可断言。
 * 覆盖面：全部区块（渐变头 / 统计三卡 / 边界说明 / 收件箱全卡 / 八家矩阵）、
 * zh/en 文案注入、空 pending 形态、转义纪律（模型生成文本不得以原文进 HTML）、
 * 防御位（字段缺席 → null 不显示）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildReportHtml,
  coverageTextOf,
  envelopeCharsOf,
  reportWords,
  type Lang,
  type ReportWords,
} from '../src/client.ts'
import { DICTS } from '../src/locales.ts'
import type { PendingRow, ProviderRow, TakeoverState } from '../src/settings.ts'

/** 固定生成时刻（展示串；文件名时间戳在 Panel 侧拼，不在此测） */
const STAMP = '2026-10-04 13:22'

/** 造一行待取件（对齐 inbox-view.spec 的最小公分母） */
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

/** 八家矩阵：supported 交替、grok 停用、opencode 带假 0 哨兵 note */
function makeProviders(): ProviderRow[] {
  const names = ['claude', 'codex', 'opencode', 'zcode', 'pi', 'workbuddy', 'cursor', 'grok'] as const
  return names.map((name, i) => ({
    name,
    supported: i % 2 === 0,
    sessions: i % 2 === 0 ? (i === 0 ? 7 : i) : -1,
    enabled: name !== 'grok',
    note: name === 'opencode' ? '存储目录存在但未发现会话——上游可能已迁移存储布局' : '',
  }))
}

function makeState(partial?: Partial<TakeoverState>): TakeoverState {
  return {
    home: '/home/u/.handoff',
    pending: [
      makeRow(),
      makeRow({ id: 'ho-two-0002', agent: 'codex', title: '写报告', project: '', preview: '' }),
    ],
    pendingSkipped: 0,
    pendingDuplicates: 0,
    archivedCount: 3,
    providers: makeProviders(),
    ...partial,
  }
}

const WORDS: Record<Lang, ReportWords> = { zh: reportWords('zh'), en: reportWords('en') }

const render = (state: TakeoverState, lang: Lang): string =>
  buildReportHtml(state, WORDS[lang], lang, STAMP)

// ---------- 文案包：词典驱动 ----------

/** 字段名与词典值恰同形的豁免（en.disabled='disabled' 是真词，不是回退） */
const KEY_EQUAL_OK = new Set(['disabled'])

test('reportWords：zh/en 全字段非空且确来自词典（缺键回退 key 在此拦下）', () => {
  for (const lang of ['zh', 'en'] as const) {
    const w = reportWords(lang)
    const keys = Object.keys(w)
    assert.ok(keys.length >= 20, `文案包字段过少：${keys.length}`)
    for (const [k, v] of Object.entries(w)) {
      assert.ok(v !== '', `${lang}.${k} 为空`)
      // v === k 有两种可能：词典缺键回退（坏）或词典值恰与字段同名（豁免集）
      assert.ok(v !== k || KEY_EQUAL_OK.has(k), `${lang}.${k} 未命中词典（回退了 key）`)
    }
  }
  // 逐字段同源：文案包只是词典的视图，不另造词
  assert.equal(WORDS.zh.title, DICTS.zh.reportTitle)
  assert.equal(WORDS.en.title, DICTS.en.reportTitle)
  assert.equal(WORDS.zh.sectionInbox, DICTS.zh.inboxTitle) // 复用既有键
  assert.equal(WORDS.en.sectionMatrix, DICTS.en.matrixTitle)
  assert.equal(WORDS.zh.previewEmpty, DICTS.zh.previewEmpty)
})

// ---------- 全区块 ----------

test('buildReportHtml：自包含单文件全区块——渐变头/统计三卡/边界说明/收件箱全卡/八家矩阵', () => {
  const html = render(makeState(), 'zh')
  // 自包含：DOCTYPE 开场、内联 <style>、无外链资源、恰一个收尾换行
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.match(html, /<html lang="zh">/)
  assert.match(html, /<style>/)
  assert.equal(html.includes('http://') || html.includes('https://'), false, '报告不得外链资源')
  assert.ok(html.endsWith('</html>\n'))
  // 品牌渐变头（#6366F1→#8B5CF6）
  assert.ok(html.includes('linear-gradient(135deg, #6366F1, #8B5CF6)'))
  assert.ok(html.includes(`<h1>${WORDS.zh.title}</h1>`))
  // 生成时刻（{n} 占位已代入）
  assert.ok(html.includes('生成于 2026-10-04 13:22'))
  // 统计三卡：待取件 2 / 已消费 3 / 读取器 7/8（grok 停用）
  assert.ok(html.includes('<span class="rt-stat-n">2</span>'))
  assert.ok(html.includes('<span class="rt-stat-n">3</span>'))
  assert.ok(html.includes('<span class="rt-stat-n">7/8</span>'))
  assert.ok(html.includes(WORDS.zh.statPending))
  assert.ok(html.includes(WORDS.zh.statArchived))
  assert.ok(html.includes(WORDS.zh.statProviders))
  // 边界说明（诚实纪律：只来自 state）
  assert.ok(html.includes('仅来自 /dsh-takeover/state'))
  // 收件箱全卡：两张卡各自要素（标题+编号 chip、来源、项目可选、时间、预览）
  assert.equal(html.split('rt-pcard"').length - 1, 2)
  assert.ok(html.includes('修收件箱'))
  assert.ok(html.includes('<span class="rt-pid">ho-test-0001</span>'))
  assert.ok(html.includes('写报告'))
  assert.ok(html.includes('<span class="rt-plabel">来源</span>Claude Code'))
  assert.ok(html.includes('<span class="rt-plabel">来源</span>Codex CLI'))
  assert.ok(html.includes('<span class="rt-plabel">项目</span>dsh-takeover'))
  assert.ok(html.includes('把过滤框做完'))
  // 空预览回退「卡片正文为空」，不写空话
  assert.ok(html.includes(WORDS.zh.previewEmpty))
  // 推送时间：可解析 ISO 出 YYYY-MM-DD HH:mm 形态（本地时区，不锚死具体值）
  assert.match(html, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  // 八家矩阵：规范名 ×8、原始 id、支持 pill、会话数、停用行、哨兵 note 浮出
  for (const label of ['Claude Code', 'Codex CLI', 'OpenCode', 'ZCode', 'Pi', 'WorkBuddy', 'Cursor', 'Grok CLI']) {
    assert.ok(html.includes(label), `矩阵缺 ${label}`)
  }
  assert.equal(html.split('class="rt-pill ').length - 1, 8)
  assert.ok(html.includes('7 个会话'))
  assert.ok(html.includes('rt-mrow-off'))
  assert.ok(html.includes(`· ${WORDS.zh.disabled}`))
  assert.ok(html.includes('存储目录存在但未发现会话'))
  assert.ok(html.includes('rt-mnote'))
  // 页脚协议标
  assert.ok(html.includes('dsh-takeover · handoff: 1'))
})

test('buildReportHtml：zh/en 文案注入——两套词典各出各的文案，lang 属性随语言', () => {
  const zh = render(makeState(), 'zh')
  const en = render(makeState(), 'en')
  assert.match(zh, /<html lang="zh">/)
  assert.match(en, /<html lang="en">/)
  assert.ok(zh.includes('dsh-takeover 交接报告'))
  assert.ok(en.includes('dsh-takeover Handoff Report'))
  assert.ok(zh.includes('生成于 2026-10-04 13:22'))
  assert.ok(en.includes('Generated at 2026-10-04 13:22'))
  assert.ok(zh.includes('另有') === false && zh.includes(WORDS.zh.pendingEmpty) === false) // 满卡无空态/跳过行
  assert.ok(en.includes('Pending') && en.includes('Consumed'))
  assert.ok(en.includes('<span class="rt-plabel">Source</span>Claude Code'))
  // 语言不串：zh 文案不得漏进 en 报告，反之亦然
  assert.equal(en.includes('交接报告'), false)
  assert.equal(zh.includes('Handoff Report'), false)
  assert.equal(en.includes('推送时间'), false)
  assert.equal(zh.includes('Goal preview'), false)
})

test('buildReportHtml：矩阵行状态逐字段忠实——supported/sessions/note/enabled 组合', () => {
  const html = render(makeState(), 'zh')
  // supported 且 sessions≥0 → 「N 个会话」；探测失败（-1 不存在于本 state）不出现
  assert.ok(html.includes('>支持</span>'))
  assert.ok(html.includes('>不可用</span>'))
  // grok：unsupported + 停用 → 「本机不支持 · 已停用」，行降透明
  assert.ok(html.includes(`本机不支持 · ${WORDS.zh.disabled}`))
  // codex / zcode / workbuddy：unsupported 无 note → 纯「本机不支持」；grok 带停用后缀
  assert.equal(html.split('本机不支持').length - 1, 4)
})

// ---------- 空 pending 形态 ----------

test('buildReportHtml：空 pending——空态横幅替代卡列；统计仍出 0；报告不塌', () => {
  const html = render(makeState({ pending: [], archivedCount: 0 }), 'zh')
  assert.equal(html.split('class="rt-pcard"').length - 1, 0, '空收件箱不得出卡')
  assert.ok(html.includes(WORDS.zh.pendingEmpty))
  assert.ok(html.includes('<span class="rt-stat-n">0</span>'))
  assert.equal(html.includes('<span class="rt-stat-n">0/8</span>'), false) // 启用数与 pending 无关
  assert.ok(html.includes('Claude Code')) // 矩阵照常全量输出
  assert.equal(html.split('class="rt-pill ').length - 1, 8)
})

test('buildReportHtml：inboxError / pendingSkipped 诚实浮出——概览不可用不粉饰成「为空」', () => {
  const err = '收件箱概览不可用：EPERM: operation not permitted'
  const html = render(
    makeState({ pending: [], pendingSkipped: 2, inboxError: err }),
    'zh',
  )
  assert.ok(html.includes(err)) // state 原文逐字进报告（转义后语义不变，err 无特殊字符）
  assert.ok(html.includes('另有 2 张无法解析的卡片被跳过'))
  assert.equal(html.split('class="rt-warn"').length - 1, 2) // 两条警示横幅
  // 干净 state：无警示横幅（计数口径 = class 属性出现次数，内联 CSS 里的类名不算）
  const clean = render(makeState(), 'zh')
  assert.equal(clean.split('class="rt-warn"').length - 1, 0)
})

// ---------- 转义纪律（自包含单文件无 CSP 兜底） ----------

test('buildReportHtml：模型生成文本（标题/预览/项目）一律转义，<script> 不以原文出现', () => {
  const html = render(makeState({
    pending: [
      makeRow({
        title: '<script>alert("x")</script>',
        project: 'a"&b',
        preview: '<img src=x onerror=alert(1)> 多行\n第二行 & 尾',
      }),
    ],
    inboxError: '收件箱概览不可用：<b>坏卡</b>',
  }), 'zh')
  // 原文零出现
  assert.equal(html.includes('<script'), false)
  assert.equal(html.includes('<img'), false)
  assert.equal(html.includes('<b>坏卡</b>'), false)
  // 转义形态在场：内容没丢，只是不再可执行
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'))
  assert.ok(html.includes('a&quot;&amp;b'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt; 多行\n第二行 &amp; 尾'))
  assert.ok(html.includes('&lt;b&gt;坏卡&lt;/b&gt;'))
})

// ---------- 纯函数纪律 ----------

test('buildReportHtml：同参必同串（无时钟/DOM/随机依赖）', () => {
  const s = makeState()
  assert.equal(render(s, 'zh'), render(s, 'zh'))
  assert.equal(buildReportHtml(s, WORDS.en, 'en', STAMP), buildReportHtml(s, WORDS.en, 'en', STAMP))
  // 不同 generatedAt 只影响展示时刻（<title> 与 meta 行各一处），不碰内容区块
  const a = buildReportHtml(s, WORDS.zh, 'zh', '2026-01-01 00:00')
  const b = buildReportHtml(s, WORDS.zh, 'zh', '2026-12-31 23:59')
  assert.notEqual(a, b)
  assert.equal(a.split('2026-01-01 00:00').join('X'), b.split('2026-12-31 23:59').join('X'))
})

test('buildReportHtml：推送时间不可解析时原样保留（诚实优于臆造）', () => {
  const html = render(makeState({ pending: [makeRow({ pushedAt: 'not-a-time' })] }), 'zh')
  assert.ok(html.includes('not-a-time'))
})

// ---------- 防御位：host 侧并行字段（envelope / coverage） ----------

test('envelopeCharsOf：字段缺席 → null（整行不显示）；extras 优先于顶层', () => {
  const bare = makeState()
  assert.equal(envelopeCharsOf(bare), null) // host 侧未落地：什么都不显示
  // extras.envelopeChars 优先
  assert.equal(envelopeCharsOf({ ...bare, extras: { envelopeChars: 980 } } as unknown as TakeoverState), 980)
  // 顶层兜底
  assert.equal(envelopeCharsOf({ ...bare, envelopeChars: 1180 } as unknown as TakeoverState), 1180)
  // 两处都在：extras 赢
  assert.equal(
    envelopeCharsOf({ ...bare, envelopeChars: 1, extras: { envelopeChars: 2 } } as unknown as TakeoverState),
    2,
  )
  // 对象形态 envelope: { chars }
  assert.equal(envelopeCharsOf({ ...bare, envelope: { chars: 777 } } as unknown as TakeoverState), 777)
  assert.equal(envelopeCharsOf({ ...bare, extras: { envelope: { chars: 888 } } } as unknown as TakeoverState), 888)
})

test('envelopeCharsOf：形态不符一律 null——字符串数字/负数/NaN/Infinity 不认', () => {
  const bare = makeState()
  for (const bad of [
    { envelopeChars: '980' },
    { envelopeChars: -1 },
    { envelopeChars: Number.NaN },
    { envelopeChars: Number.POSITIVE_INFINITY },
    { envelopeChars: null },
    { envelopeChars: { chars: 5 } }, // 数字落点塞了对象 → 不认
    { envelope: { chars: '1200' } }, // 对象形态里也是字符串 → 不认
    { extras: 'oops' }, // extras 整个漂移成字符串 → 当缺席
  ]) {
    assert.equal(envelopeCharsOf({ ...bare, ...bad } as unknown as TakeoverState), null, JSON.stringify(bad))
  }
})

test('coverageTextOf：CoverageStats 真实契约出 marked/statements；字符串与兜底对象形态也认', () => {
  const bare = makeState()
  assert.equal(coverageTextOf(bare), null)
  // 真实契约（src/tools.ts CoverageStats）：{ statements, marked, unmarked } → x/y = marked/statements
  assert.equal(
    coverageTextOf({ ...bare, extras: { coverage: { statements: 8, marked: 3, unmarked: 5 } } } as unknown as TakeoverState),
    '3/8',
  )
  assert.equal(
    coverageTextOf({ ...bare, coverage: { statements: 20, marked: 12, unmarked: 8 } } as unknown as TakeoverState),
    '12/20',
  )
  // 三字段不齐（对齐 tools.ts normalizeCoverage 的全齐纪律）→ 不认
  assert.equal(
    coverageTextOf({ ...bare, extras: { coverage: { statements: 8, marked: 3 } } } as unknown as TakeoverState),
    null,
  )
  // 字符串形态
  assert.equal(coverageTextOf({ ...bare, extras: { coverage: '3/8' } } as unknown as TakeoverState), '3/8')
  assert.equal(coverageTextOf({ ...bare, coverage: '12/20' } as unknown as TakeoverState), '12/20')
  assert.equal(coverageTextOf({ ...bare, extras: { coverage: '   ' } } as unknown as TakeoverState), null)
  // 兜底对象形态：done/total 为主，x/y 字面键备选
  assert.equal(coverageTextOf({ ...bare, extras: { coverage: { done: 3, total: 8 } } } as unknown as TakeoverState), '3/8')
  assert.equal(coverageTextOf({ ...bare, extras: { coverage: { x: 1, y: 4 } } } as unknown as TakeoverState), '1/4')
  // 残缺对象 / 非数计数 → null
  assert.equal(coverageTextOf({ ...bare, extras: { coverage: { done: 3 } } } as unknown as TakeoverState), null)
  assert.equal(coverageTextOf({ ...bare, extras: { coverage: { done: '3', total: 8 } } } as unknown as TakeoverState), null)
  assert.equal(coverageTextOf({ ...bare, extras: { coverage: 42 } } as unknown as TakeoverState), null)
  // extras 优先于顶层
  assert.equal(
    coverageTextOf({ ...bare, coverage: '1/9', extras: { coverage: '8/8' } } as unknown as TakeoverState),
    '8/8',
  )
})
