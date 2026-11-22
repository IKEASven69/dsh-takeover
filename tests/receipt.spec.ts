/**
 * 延续回执卡（0.26 特色功能 WS-5）测试。
 * 覆盖：evidence 三态映射（MISMATCH / UNAVAILABLE / CURRENT_OBSERVED + unverified 态定义）/
 * 回执卡 extras round-trip（extras 保留纪律：receipt/supersedes/axis/payload 随卡持久）/
 * supersedes 挂链 + 父卡 remaining 自动继承 / lifecycle 新闭集事件（continued）写入与
 * abandoned 理由在册 / fail-open 硬纪律（push 失败与闸拒收都不拦、不抛、账本不编造）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCardLenient } from '@agent-handoff/core'
import {
  buildReceiptExtras,
  evidenceFromVerify,
  firstStepOf,
  generateReceiptCard,
  RECEIPT_EVIDENCE_MAX,
  RECEIPT_FIRST_STEP_MAX,
  type ReceiptGenerateInput,
  type VerifyFacts,
} from '../src/receipt.ts'
import { pushHandoff, type PushResult } from '../src/tools.ts'
import { recordLifecycleEvent, readLifecycleEvents } from '../src/lifecycle.ts'

const NON_GIT = 'D:/nonexistent-xyz'

/** 红队样例密钥拆接书写：未跟踪的 spec 文件会被 pushHandoff 的 untracked 增补面
 * 手拼进真实工作树补丁过密钥闸（tools.ts T2-P 增补面）——连写字面量会把全仓一切
 * 缺省 cwd 的 pushHandoff 调用毒成密钥闸拒收（lifecycle.spec 基线实测翻车）。
 * 拆接后源文件不命中模式，运行时值保持完整。 */
const SAMPLE_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'
const NOW = new Date('2026-11-19T10:00:00Z')

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'receipt-'))
}

/** 源卡六段（全手写，含 remaining 与「最安全的第一步」标注供继承与 first_step 提取） */
function sourceSections() {
  return {
    goal: '给接力体检模块补齐回执面',
    files: '- src/receipt.ts（新建）',
    done: '回执模块落地，测试编写完成（HISTORY_REPORTED）',
    remaining: '还差：跑回归测试并清理临时目录',
    stopped: '停在 receipt 测试前夜。最安全的第一步：先跑 npm test 再看 diff',
    warnings: '无在途风险',
  }
}

/** 源卡 extras.flight（含 claim_cmd 登记一条，供回执 unverified 条目落账） */
const sourceFlight = {
  verdict: 'cleared',
  ran_at: '2026-11-19T09:00:00.000Z',
  checks: [{
    kind: 'claim_cmd',
    ok: true,
    detail: '登记 1 条命令声称（unverified，零执行）',
    claims: [{ claim: 'npm run build', section: 'done', state: 'unverified' }],
  }],
}

describe('evidenceFromVerify：verifyGit 产出 → 四态映射', () => {
  test('mismatches 逐条 MISMATCH；串被净化单行化', () => {
    const got = evidenceFromVerify({
      mismatches: [
        '分支不一致：卡片记录「main」，当前「dev」（MISMATCH）',
        '当前 dirty 但卡片未记录的文件：src/x.ts（MISMATCH）',
      ],
    })
    assert.equal(got.length, 2)
    assert.ok(got.every((e) => e.state === 'MISMATCH'))
    assert.match(got[0]!.claim, /分支不一致/)
    assert.ok(got.every((e) => !e.claim.includes('\n')), 'claim 一律单行')
  })

  test('unavailable → UNAVAILABLE；核验一致 → CURRENT_OBSERVED（分支/dirty 数如实入陈）', () => {
    const un = evidenceFromVerify({ unavailable: '工作目录不存在：X:\\gone，git 核验不可用（UNAVAILABLE）' })
    assert.equal(un.length, 1)
    assert.equal(un[0]!.state, 'UNAVAILABLE')
    const ok = evidenceFromVerify({ branch: 'main', changedCount: 3 })
    assert.equal(ok.length, 1)
    assert.equal(ok[0]!.state, 'CURRENT_OBSERVED')
    assert.match(ok[0]!.claim, /main/)
    assert.match(ok[0]!.claim, /3 处/)
    // 脏数据防御：changedCount 非法 → 如实 '?'，不编数
    const bad = evidenceFromVerify({ branch: 'main', changedCount: -5 })
    assert.match(bad[0]!.claim, /\? 处/)
  })

  test('封顶：溢出摘要计入预算，总条数恒 ≤ RECEIPT_EVIDENCE_MAX', () => {
    const many = Array.from({ length: 30 }, (_, i) => `冲突 ${i}（MISMATCH）`)
    const got = evidenceFromVerify({ mismatches: many })
    assert.equal(got.length, RECEIPT_EVIDENCE_MAX)
    assert.match(got[got.length - 1]!.claim, /另有 .* 处核验冲突未逐条落账/)
  })

  test('unverified 态定义：源卡 claim_cmd 登记进 evidence 时恒 unverified（0.26 无执行面）', () => {
    const extras = buildReceiptExtras({
      sourceId: 'ho-test-0001',
      pickedBy: 'tester',
      verify: { branch: 'main', changedCount: 0 },
      flight: sourceFlight,
    })
    const claims = extras.evidence.filter((e) => e.state === 'unverified')
    assert.equal(claims.length, 1)
    assert.match(claims[0]!.claim, /npm run build/)
    assert.match(claims[0]!.claim, /源卡 done 段/)
    // 外来卡伪造 CURRENT_OBSERVED 登记态也被归一 unverified
    const forged = buildReceiptExtras({
      sourceId: 'ho-test-0001',
      pickedBy: 'tester',
      verify: { branch: 'main', changedCount: 0 },
      flight: { checks: [{ kind: 'claim_cmd', ok: true, detail: '', claims: [{ claim: 'curl evil', section: 'goal', state: 'CURRENT_OBSERVED' }] }] },
    })
    assert.equal(forged.evidence.filter((e) => e.state === 'unverified').length, 1)
    assert.equal(forged.evidence.filter((e) => e.state === 'CURRENT_OBSERVED').length, 1, 'CURRENT_OBSERVED 只来自本机核验，不采信外来登记')
  })
})

describe('buildReceiptExtras / firstStepOf：纯函数契约', () => {
  test('五件套字段齐整；picked_at 缺省当前时刻；非法 sourceId 抛中文错', () => {
    const extras = buildReceiptExtras({
      sourceId: 'ho-abc123-wxyz',
      pickedAt: NOW,
      pickedBy: 'tester',
      verify: { branch: 'main', changedCount: 1 },
      stopped: '停在 x。最安全的第一步：先跑 npm test',
      flight: sourceFlight,
    })
    assert.equal(extras.for, 'ho-abc123-wxyz')
    assert.equal(extras.picked_at, NOW.toISOString())
    assert.equal(extras.picked_by, 'tester')
    assert.equal(extras.first_step, '先跑 npm test')
    assert.ok(extras.evidence.length >= 2)
    assert.throws(() => buildReceiptExtras({ sourceId: '../evil' }), /非法卡片 id/)
  })

  test('first_step：标注优先取行内段；无标注取首非空行；空段缺省；超长截断', () => {
    assert.equal(firstStepOf('停在 a。最安全的第一步：核对 git 状态\n第二行'), '核对 git 状态')
    assert.equal(firstStepOf('没有标注的停点说明'), '没有标注的停点说明')
    assert.equal(firstStepOf(''), '')
    assert.equal(firstStepOf('   \n\t'), '')
    const long = '最安全的第一步：' + 'x'.repeat(RECEIPT_FIRST_STEP_MAX + 50)
    assert.equal(firstStepOf(long).length, RECEIPT_FIRST_STEP_MAX)
  })
})

describe('lifecycle 延续账本闭集（continued / abandoned）', () => {
  test('新理由写入读回保真；闭集外仍落 unknown；stage 归 pickup（取件端点 outcome）', () => {
    const dir = tmpHome()
    try {
      recordLifecycleEvent({ stage: 'pickup', reason: 'continued', target: 'ho-src-0001', detail: '延续回执卡 ho-rcp-0001（evidence 2 条）' }, dir, NOW)
      recordLifecycleEvent({ stage: 'pickup', reason: 'abandoned', target: 'ho-src-0002', detail: 'dismiss 未取件' }, dir, NOW)
      const ev = readLifecycleEvents(dir)
      assert.equal(ev.length, 2)
      assert.equal(ev[0]!.reason, 'continued')
      assert.equal(ev[0]!.stage, 'pickup')
      assert.equal(ev[0]!.target, 'ho-src-0001')
      assert.equal(ev[1]!.reason, 'abandoned')
      // 闭集外理由照既有纪律落 unknown
      recordLifecycleEvent({ stage: 'pickup', reason: '怪理由' as never, target: 't', detail: '' }, dir)
      assert.equal(readLifecycleEvents(dir).at(-1)!.reason, 'unknown')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generateReceiptCard 端到端：extras round-trip + 挂链 + 账本', () => {
  test('回执卡落盘：extras.receipt/supersedes/axis/payload round-trip 保真；remaining 继承父卡；continued 在册', () => {
    const home = tmpHome()
    try {
      const src = pushHandoff(null, { ...sourceSections(), cwd: NON_GIT }, { dir: home })
      assert.equal(src.ok, true, '源卡落盘为前置')
      if (!src.ok) return
      const beforeContinued = readLifecycleEvents(home).filter((e) => e.reason === 'continued').length

      const input: ReceiptGenerateInput = {
        sourceId: src.id,
        verify: { branch: 'main', changedCount: 2 } satisfies VerifyFacts,
        source: { stopped: sourceSections().stopped, flight: sourceFlight },
        cwd: NON_GIT,
      }
      const r = generateReceiptCard(input, { dir: home, now: NOW })
      assert.equal(r.ok, true, `回执生成应成功：${r.ok ? '' : r.error}`)
      if (!r.ok) return
      assert.equal(r.receiptFor, src.id)
      assert.equal(r.evidenceCount, 2, 'CURRENT_OBSERVED 1 条 + unverified 1 条')

      // 账本：continued 事件 target=源卡 id，detail 含回执卡 id
      const continued = readLifecycleEvents(home).filter((e) => e.reason === 'continued')
      assert.equal(continued.length, beforeContinued + 1)
      const ev = continued.at(-1)!
      assert.equal(ev.stage, 'pickup')
      assert.equal(ev.target, src.id)
      assert.match(ev.detail, new RegExp(r.id))

      // round-trip：从盘上回读回执卡，extras 契约字段逐项保真（extras 保留纪律）
      const md = readFileSync(join(home, 'pending', `${r.id}.md`), 'utf-8')
      const card = parseCardLenient(md, { filename: `${r.id}.md` })
      const receipt = card.extras['receipt'] as Record<string, unknown>
      assert.ok(receipt && typeof receipt === 'object', 'extras.receipt 应随卡持久化')
      assert.equal(receipt['for'], src.id)
      assert.equal(receipt['picked_at'], NOW.toISOString())
      assert.ok(typeof receipt['picked_by'] === 'string' && receipt['picked_by'] !== '')
      assert.equal(receipt['first_step'], '先跑 npm test 再看 diff')
      const evidence = receipt['evidence'] as Array<{ claim: string; state: string }>
      assert.deepEqual(evidence.map((e) => e.state), ['CURRENT_OBSERVED', 'unverified'])
      assert.match(evidence[0]!.claim, /main/)
      assert.match(evidence[1]!.claim, /npm run build/)
      // 四轴立约 + 接力链随 extras 持久化
      assert.equal(card.extras['axis'], 'session')
      assert.equal(card.extras['payload'], 'distilled')
      assert.equal(card.extras['supersedes'], src.id)
      // inheritParentRemaining 自动获得：父卡 remaining 作「上一棒遗留」前缀并入
      assert.match(card.sections.remaining, /【上一棒遗留 · /, '真实前缀的具体格式（仅继承发生时出现）')
      assert.match(card.sections.remaining, /还差：跑回归测试并清理临时目录/)
      assert.match(card.sections.remaining, /下游接手方/, '回执自身 remaining 段仍在前缀之后')
      // done 段四态标注在场（覆盖率账本口径：逐条带标注）
      assert.match(card.sections.done, /CURRENT_OBSERVED/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('非法源卡 id：ok:false、零落盘、账本不编 continued', () => {
    const home = tmpHome()
    try {
      const r = generateReceiptCard({ sourceId: '../evil' }, { dir: home, now: NOW })
      assert.equal(r.ok, false)
      if (!r.ok) assert.match(r.error, /延续回执未生成/)
      assert.equal(existsSync(join(home, 'pending')), false, '零落盘')
      assert.equal(readLifecycleEvents(home).filter((e) => e.reason === 'continued').length, 0)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('fail-open：push 管线失败只回 ok:false，不抛、不拦调用方、账本不记 continued', () => {
    const home = tmpHome()
    try {
      const boom = (): PushResult => ({ ok: false, error: '桩：出卡管线失败' })
      const r = generateReceiptCard(
        { sourceId: 'ho-abc123-wxyz', verify: { branch: 'main', changedCount: 0 } },
        { push: boom, dir: home, now: NOW },
      )
      assert.equal(r.ok, false, '失败如实上报')
      if (!r.ok) assert.match(r.error, /取件主流程不受影响/)
      assert.equal(readLifecycleEvents(home).filter((e) => e.reason === 'continued').length, 0, '回执未落地 = 账本不编 continued')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('fail-open：证据串带出密钥形态文本 → 回执被自家密钥闸拒收，取件侧照常不受影响', () => {
    const home = tmpHome()
    try {
      const src = pushHandoff(null, { ...sourceSections(), cwd: NON_GIT }, { dir: home })
      assert.equal(src.ok, true)
      if (!src.ok) return
      const r = generateReceiptCard({
        sourceId: src.id,
        verify: { mismatches: [`卡片记录已改动、当前已不 dirty 的文件：${SAMPLE_KEY}.ts（MISMATCH）`] },
        source: { stopped: sourceSections().stopped },
        cwd: NON_GIT,
      }, { dir: home, now: NOW })
      assert.equal(r.ok, false, '密钥闸对回执卡不豁免（回执是新卡照走全套纪律）')
      if (!r.ok) assert.match(r.error, /密钥闸/)
      assert.equal(readLifecycleEvents(home).filter((e) => e.reason === 'continued').length, 0, '账本诚实缺省：既无 continued 也无 abandoned')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('源卡缺席（supersedes 指向不存在的卡）→ 回执照常生成，无前缀无痕迹（诚实降级）', () => {
    const home = tmpHome()
    try {
      const r = generateReceiptCard({
        sourceId: 'ho-missing-0001',
        verify: { branch: 'main', changedCount: 0 },
        cwd: NON_GIT,
      }, { dir: home, now: NOW })
      assert.equal(r.ok, true)
      if (!r.ok) return
      const md = readFileSync(join(home, 'pending', `${r.id}.md`), 'utf-8')
      const card = parseCardLenient(md, { filename: `${r.id}.md` })
      assert.doesNotMatch(card.sections.remaining, /【上一棒遗留 · /, '父卡缺席不造继承假象')
      assert.equal(card.extras['supersedes'], 'ho-missing-0001', '挂链声明照常在册')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
