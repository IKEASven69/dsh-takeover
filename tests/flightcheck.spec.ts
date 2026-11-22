/**
 * 接力体检 + 起飞章（0.26 特色功能 WS-5）测试。
 * 覆盖：四检查项正负例各一 / 三档判定边界（闸拒收路径 blocked、旁路 cautioned 且
 * 警告段含残留摘要、全过 cleared）/ 落盘卡面只断言 cleared·cautioned 两档 /
 * claim_cmd 登记 unverified 且零执行（负向断言无子进程 + 静态无 child_process 面）/
 * 防御式降级（体检自身抛错 = 未盖章如实缺省）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runFlightcheck,
  runFlightcheckSafe,
  claimsFromFlight,
  filePathCandidates,
  extractCommandClaims,
  FLIGHTCHECK_KINDS,
  type FlightcheckOptions,
  type FlightcheckSections,
} from '../src/flightcheck.ts'
import { pushHandoff } from '../src/tools.ts'

const NON_GIT = 'D:/nonexistent-xyz'

/** 红队样例密钥拆接书写：未跟踪的 spec 文件会被 pushHandoff 的 untracked 增补面
 * 手拼进真实工作树补丁过密钥闸（tools.ts T2-P 增补面）——本文件若连写字面量，
 * 全仓一切缺省 cwd 的 pushHandoff 调用（如 lifecycle.spec 基线）会被本文件毒成
 * 密钥闸拒收（实测翻车）。拆接后源文件不命中模式，运行时值保持完整。 */
const SAMPLE_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

/** 六段全手写的健康卡面（无占位行、无密钥、无路径声称之外的干扰） */
const CLEAN: FlightcheckSections = {
  goal: '把接力体检模块写完并过测试',
  files: '无关正文（file_ref 正例注入临时路径）',
  done: '模块落地，测试编写完成',
  remaining: 'typecheck 与全量回归',
  stopped: '停在 flightcheck 收尾。最安全的第一步：跑单文件测试',
  warnings: '无在途风险',
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'flightcheck-'))
}

describe('四检查项 · 正负例各一', () => {
  test('file_ref 正例：files 段路径在盘 → ok；负例：路径缺失 → 诊断列出缺失项', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flightcheck-fileref-'))
    try {
      const file = join(dir, 'a.txt')
      writeFileSync(file, 'x', 'utf-8')
      // 正例（绝对路径）
      const okR = runFlightcheck({ ...CLEAN, files: `- ${file}` }, { exists: (p) => p === file })
      const okCheck = okR.stamp.checks.find((c) => c.kind === 'file_ref')
      assert.equal(okCheck?.ok, true)
      // 正例（相对路径按卡面 cwd 解析）
      mkdirSync(join(dir, 'src'), { recursive: true })
      writeFileSync(join(dir, 'src', 'foo.ts'), 'x', 'utf-8')
      const relR = runFlightcheck({ ...CLEAN, files: '- src/foo.ts' }, { cwd: dir, exists: (p) => p === 'src/foo.ts' || p === join(dir, 'src/foo.ts') })
      assert.equal(relR.stamp.checks.find((c) => c.kind === 'file_ref')?.ok, true)
      // 负例：缺失路径进诊断，其余三项不受拖累
      const badR = runFlightcheck({ ...CLEAN, files: `- ${file}\n- src/gone.ts` }, { cwd: dir, exists: (p) => p === file })
      const bad = badR.stamp.checks.find((c) => c.kind === 'file_ref')
      assert.equal(bad?.ok, false)
      assert.match(bad?.detail ?? '', /1\/2 处声称路径不存在/)
      assert.match(bad?.detail ?? '', /gone\.ts/)
      assert.equal(badR.stamp.verdict, 'cautioned', '缺文件不拦卡（诊断非闸）→ cautioned')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('secret 正例：干净六段 → ok；负例：残留命中且掩码不泄漏中段', () => {
    const okR = runFlightcheck(CLEAN)
    assert.equal(okR.stamp.checks.find((c) => c.kind === 'secret')?.ok, true)
    const badR = runFlightcheck({ ...CLEAN, warnings: `aws key: ${SAMPLE_KEY}（测试样例）` })
    const bad = badR.stamp.checks.find((c) => c.kind === 'secret')
    assert.equal(bad?.ok, false)
    assert.match(bad?.detail ?? '', /AWS/)
    assert.doesNotMatch(bad?.detail ?? '', /IOSFODNN7/, '掩码不得泄漏密钥中段')
  })

  test('skeleton 正例：实质六段 → ok；负例：全占位行 → 空壳形态诊断（非新闸）', () => {
    const okR = runFlightcheck(CLEAN)
    assert.equal(okR.stamp.checks.find((c) => c.kind === 'skeleton')?.ok, true)
    const placeholders: FlightcheckSections = {
      goal: '（事件流中无用户消息）',
      files: '（事件流中无文件/命令记录）',
      done: '（事件流中无可蒸馏的完成项）',
      remaining: '（无未完成 todo 快照）',
      stopped: '（事件流不可用：无会话环境）',
      warnings: '（无）',
    }
    const badR = runFlightcheck(placeholders)
    const bad = badR.stamp.checks.find((c) => c.kind === 'skeleton')
    assert.equal(bad?.ok, false)
    assert.match(bad?.detail ?? '', /空壳形态/)
  })

  test('claim_cmd：done 反引号 + $ 行前缀命令 → 登记为 unverified，检查项不罚档', () => {
    const r = runFlightcheck({
      ...CLEAN,
      done: '跑过 `npm test` 全绿；`src/a.ts` 是文件引用不登记',
      remaining: '$ git status 复核后收尾',
    })
    const check = r.stamp.checks.find((c) => c.kind === 'claim_cmd')
    assert.equal(check?.ok, true, '登记即职责完成，unverified 不罚档')
    assert.equal(check?.claims?.length, 2, '单 token 反引号（src/a.ts）不误登')
    assert.deepEqual(check?.claims?.map((c) => c.state), ['unverified', 'unverified'])
    assert.deepEqual(check?.claims?.map((c) => c.claim), ['npm test', 'git status 复核后收尾'])
    assert.equal(r.stamp.verdict, 'cleared', '四项全过（claim 在册不算未过）→ cleared')
  })
})

describe('三档判定边界', () => {
  test('blocked：密钥命中未旁路（闸拒收路径返回值，不落任何卡面）', () => {
    const r = runFlightcheck({ ...CLEAN, warnings: `aws key: ${SAMPLE_KEY}（测试样例）` })
    assert.equal(r.stamp.verdict, 'blocked')
    assert.match(r.note, /blocked/)
    assert.match(r.note, /AWS/, 'blocked 诊断进拒收反馈与 lifecycle detail 的原料在场')
  })

  test('cautioned：allowSecrets 旁路放行 + 警告段摘要含残留（二值闸升级分级章）', () => {
    const r = runFlightcheck(
      { ...CLEAN, warnings: `aws key: ${SAMPLE_KEY}（测试样例）` },
      { allowSecrets: true },
    )
    assert.equal(r.stamp.verdict, 'cautioned')
    assert.match(r.note, /cautioned/)
    assert.match(r.note, /AWS Access Key/, '警告段残留摘要含规则名')
    assert.match(r.note, /@warnings/, '残留摘要含所在段')
    assert.match(r.note, /\*/, '残留摘要为掩码形态')
  })

  test('cleared：四项全过，note 为空串', () => {
    const r = runFlightcheck(CLEAN)
    assert.equal(r.stamp.verdict, 'cleared')
    assert.equal(r.note, '')
    assert.deepEqual(r.stamp.checks.map((c) => c.kind), [...FLIGHTCHECK_KINDS], '四项固定顺序齐整')
  })

  test('空壳 blocked 边界：全占位且未手写 → blocked；confirmSkeleton 旁路 → cautioned；已手写偏空 → cautioned（诊断非闸）', () => {
    const placeholders: FlightcheckSections = {
      goal: '（事件流中无用户消息）',
      files: '（事件流中无文件/命令记录）',
      done: '（事件流中无可蒸馏的完成项）',
      remaining: '（无未完成 todo 快照）',
      stopped: '（事件流不可用：无会话环境）',
      warnings: '（无）',
    }
    assert.equal(runFlightcheck(placeholders, { userWrote: false }).stamp.verdict, 'blocked', '镜像空壳闸拒收判据')
    assert.equal(runFlightcheck(placeholders, { userWrote: false, confirmSkeleton: true }).stamp.verdict, 'cautioned', '镜像 confirmSkeleton 旁路')
    assert.equal(runFlightcheck(placeholders).stamp.verdict, 'cautioned', '缺省按已手写处理——体检不越权发明 blocked')
  })

  test('面外残留补正：extraSecretHits 让 secret 项据实判 false（闸拒收但章 cleared 的假象不出现）', () => {
    const r = runFlightcheck(CLEAN, { extraSecretHits: 2 })
    const secret = r.stamp.checks.find((c) => c.kind === 'secret')
    assert.equal(secret?.ok, false)
    assert.match(secret?.detail ?? '', /2 处面外残留/)
    assert.equal(r.stamp.verdict, 'blocked')
    const bypassed = runFlightcheck(CLEAN, { extraSecretHits: 2, allowSecrets: true })
    assert.equal(bypassed.stamp.verdict, 'cautioned')
  })
})

describe('落盘卡面两档契约（体检挂闸后：blocked 只活在拒收路径）', () => {
  const withSecret = { ...CLEAN, warnings: `aws key: ${SAMPLE_KEY}（测试样例）` }

  test('闸放行卡（旁路落盘）→ 章为 cautioned 且不是 blocked；闸拒收路径 → blocked', () => {
    const home = tmpHome()
    try {
      const landed = pushHandoff(null, {
        ...withSecret,
        cwd: NON_GIT,
        allowSecrets: true,
      }, { dir: home })
      assert.equal(landed.ok, true, '旁路放行卡真实落盘')
      const fcLanded = runFlightcheckSafe(withSecret, { allowSecrets: true, userWrote: true, cwd: NON_GIT })
      assert.ok(fcLanded, '健康卡面体检必产章')
      assert.ok(
        fcLanded.stamp.verdict === 'cleared' || fcLanded.stamp.verdict === 'cautioned',
        `落盘卡卡面只可能两档，实际 ${String(fcLanded.stamp.verdict)}`,
      )
      assert.equal(fcLanded.stamp.verdict, 'cautioned', '旁路带残 → cautioned')
      assert.match(fcLanded.note, /AWS/, '警告段含残留摘要')

      const rejected = pushHandoff(null, { ...withSecret, cwd: NON_GIT }, { dir: home })
      assert.equal(rejected.ok, false, '未旁路被闸拒收，无卡可落')
      const fcRejected = runFlightcheckSafe(withSecret, { userWrote: true, cwd: NON_GIT })
      assert.equal(fcRejected?.stamp.verdict, 'blocked', 'blocked 是闸拒收路径的返回值，不落卡面')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('claim_cmd 零执行（负向断言：无子进程；0.26 无执行面）', () => {
  test('声称的命令带真实副作用载荷也不被执行——执行面不存在，登记即终态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flightcheck-noexec-'))
    try {
      const pwned = join(dir, 'pwned.txt')
      const claim = `node -e "require('fs').writeFileSync('${pwned.replace(/\\/g, '/')}','PWNED')"`
      const r = runFlightcheck({ ...CLEAN, done: `声称执行 \`${claim}\`` })
      const check = r.stamp.checks.find((c) => c.kind === 'claim_cmd')
      assert.equal(check?.ok, true)
      assert.equal(check?.claims?.length, 1)
      assert.equal(check?.claims?.[0]?.state, 'unverified')
      assert.equal(existsSync(pwned), false, '若存在任何执行面，副作用文件会出现——登记路径必须零执行')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('静态负向断言：模块不含 child_process 导入与任何进程发起调用形态', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/flightcheck.ts', import.meta.url)), 'utf-8')
    assert.doesNotMatch(src, /from\s+['"]node:child_process['"]/, '体检模块不得引入子进程面')
    // 负向后行断言排除 .exec( 这类正则 API 的属性访问，只拦进程发起形态
    assert.doesNotMatch(src, /(?<!\.)\bexec(?:File|FileSync|Sync)?\s*\(/, '不得出现 exec 调用形态')
    assert.doesNotMatch(src, /(?<!\.)\bspawn(?:Sync)?\s*\(/, '不得出现 spawn 调用形态')
  })
})

describe('防御式降级（体检是新增写侧步骤，自身失败绝不拦出卡）', () => {
  test('存在性探测抛错 → 该路径按未确认存在计，不炸体检', () => {
    const r = runFlightcheck({ ...CLEAN, files: '- src/a.ts' }, { exists: () => { throw new Error('probe boom') } })
    const check = r.stamp.checks.find((c) => c.kind === 'file_ref')
    assert.equal(check?.ok, false)
    assert.equal(r.stamp.verdict, 'cautioned', '探测失败如实降级为诊断，不拦不瞒')
  })

  test('外来 sections 投毒 getter → runFlightcheckSafe 返 undefined（未盖章如实缺省）', () => {
    const poison: FlightcheckSections = {}
    Object.defineProperty(poison, 'files', { get() { throw new Error('poison') }, enumerable: true })
    assert.equal(runFlightcheckSafe(poison), undefined)
  })

  test('opts 投毒 getter（runFlightcheck 兜底层）→ safe 返 undefined 而非抛出', () => {
    const poisonOpts: FlightcheckOptions = {}
    Object.defineProperty(poisonOpts, 'now', { get() { throw new Error('poison') }, enumerable: true })
    assert.equal(runFlightcheckSafe(CLEAN, poisonOpts), undefined)
  })

  test('claimsFromFlight：坏数据一律忽略；外来卡声称非 unverified 态也归一 unverified', () => {
    assert.deepEqual(claimsFromFlight(undefined), [])
    assert.deepEqual(claimsFromFlight(null), [])
    assert.deepEqual(claimsFromFlight('垃圾'), [])
    assert.deepEqual(claimsFromFlight({ checks: 'not-array' }), [])
    assert.deepEqual(claimsFromFlight({ checks: [{ kind: 'secret', claims: [{ claim: 'x' }] }] }), [])
    const got = claimsFromFlight({
      verdict: 'cleared',
      checks: [{
        kind: 'claim_cmd',
        ok: true,
        detail: '',
        claims: [
          { claim: 'npm run build', section: 'done', state: 'CURRENT_OBSERVED' },
          { claim: 42, section: 'done' },
          { claim: 'git push --force', section: '' },
        ],
      }],
    })
    assert.equal(got.length, 2, '非法条目忽略')
    assert.deepEqual(got.map((c) => c.state), ['unverified', 'unverified'], '0.26 无执行面，在册声称一律 unverified')
    assert.equal(got[1]?.section, 'unknown', '空段名归一 unknown')
  })

  test('extractCommandClaims：中文名/单 token/空段不误登；同段去重', () => {
    assert.deepEqual(extractCommandClaims({
      done: '`纯中文命令` 与 `单词` 与 `` 都不算',
      goal: '$ git commit -m "x"',
    }).length, 1)
    assert.deepEqual(extractCommandClaims({ done: '`npm ci` 与 `npm ci` 重复' }).length, 1, '同段同串去重')
    assert.deepEqual(extractCommandClaims({}), [])
  })
})

describe('filePathCandidates 启发式（file_ref 的确定性取径）', () => {
  test('列表记号/反引号/tool: path 形态取径；命令与裸单词不误报', () => {
    assert.deepEqual(
      filePathCandidates([
        '- src/flightcheck.ts',
        '- `tests/receipt.spec.ts`',
        '- Write: D:/repo/a b/x.ts'.replace('a b/', ''),
        '* README.md',
        '- `npm test`（命令含空白不认路径）',
        '- plainword（裸单词不认）',
        '-（空行占位）',
      ].join('\n')),
      ['src/flightcheck.ts', 'tests/receipt.spec.ts', 'D:/repo/x.ts', 'README.md'],
    )
  })
})
