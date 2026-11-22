/**
 * 定向投递纯函数层测试（src/directed.ts）：machine.json 三态（缺文件回 hostname /
 * 坏 JSON fail-open / 正常读）、parseAddress 消毒（禁路径分隔符、空名拒、非
 * machine: 原样、大小写规约）、bucketOf 三桶（缺省归 any、坏数据归 any 不抛、
 * 点名本机/别机正确）、/sendto skill 指引行耦合断言（含卡 id 与 pending 路径）、
 * 跨机闭环文件级断言（A 机写 to=machine:lap-b 的卡落 pending/ → bucketOf 归
 * mine/others——纯函数以 selfName 参数模拟两机）、SYNC_GITIGNORE 追加
 * machine.json 后的真 git 回归（机器身份落 .gitignore 且不入 git 追踪）。
 * 落盘一律走临时 HANDOFF_HOME（dir 注入），不碰真实 ~/.handoff。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { generateId, loadCard, writeCard, type Card } from '@agent-handoff/core'
import { pickupCommand } from '../src/browser-view.ts'
import {
  bucketOf,
  machinePath,
  parseAddress,
  readMachineName,
  saveMachineName,
  toMachineAddress,
} from '../src/directed.ts'
import { syncSetup } from '../src/sync.ts'
import { SENDTO_SKILL_CONTENT, sendtoSkillRegistration } from '../skills/sendto.ts'

// ---------- 临时 home（dir 注入，不碰真实 ~/.handoff） ----------

const homes: string[] = []
function freshHome(label: string): string {
  const p = mkdtempSync(join(tmpdir(), `dsh-directed-${label}-`))
  homes.push(p)
  return p
}
after(() => {
  for (const p of homes) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* 尽力清：临时目录留尸无害 */ }
  }
})

/** hostname 兜底的期望值（与 directed.ts machineFallback 同规约化） */
function expectedFallback(): string {
  const h = hostname().trim().toLowerCase()
  return h !== '' ? h : 'localhost'
}

function makeCard(partial?: Partial<Card>): Card {
  return {
    handoff: 1,
    id: generateId(),
    from: { agent: 'dsh', session: 'sess-directed', title: '' },
    to: 'any',
    project: '',
    cwd: tmpdir(),
    pushed_at: '2026-11-20T10:00:00+08:00',
    git: { branch: '', changed: [] },
    tasks: [],
    sections: { goal: '点名闭环验证', files: '', done: '', remaining: '', stopped: '', warnings: '' },
    extras: {},
    ...partial,
  }
}

// ---------- ① machine.json 三态 ----------

test('readMachineName：缺文件 fail-open 回 os.hostname()', () => {
  const home = freshHome('missing')
  assert.equal(readMachineName(home), expectedFallback())
})

test('readMachineName：坏 JSON fail-open 回 hostname，不抛', () => {
  const home = freshHome('broken')
  writeFileSync(machinePath(home), '{oops', 'utf-8')
  assert.equal(readMachineName(home), expectedFallback())
})

test('readMachineName：正常读 + 大小写规约（小写）', () => {
  const home = freshHome('ok')
  writeFileSync(machinePath(home), JSON.stringify({ name: 'Lap-B' }), 'utf-8')
  assert.equal(readMachineName(home), 'lap-b')
})

test('readMachineName：形态不符（数组/number/带路径分隔符的名字）回 hostname', () => {
  const home = freshHome('shape')
  writeFileSync(machinePath(home), JSON.stringify(['lap-b']), 'utf-8')
  assert.equal(readMachineName(home), expectedFallback())
  writeFileSync(machinePath(home), JSON.stringify({ name: 42 }), 'utf-8')
  assert.equal(readMachineName(home), expectedFallback())
  writeFileSync(machinePath(home), JSON.stringify({ name: 'a/b' }), 'utf-8')
  assert.equal(readMachineName(home), expectedFallback())
})

test('saveMachineName：写读一致（规约化小写）+ 非法名中文错拒绝', () => {
  const home = freshHome('save')
  saveMachineName('Desk-1', home)
  assert.equal(readMachineName(home), 'desk-1')
  assert.throws(() => saveMachineName('a/b', home), /路径分隔符/)
  assert.throws(() => saveMachineName('a\\b', home), /路径分隔符/)
  assert.throws(() => saveMachineName('  ', home), /机器名不能为空/)
  assert.match(readFileSync(machinePath(home), 'utf-8'), /"name": "desk-1"/)
})

// ---------- ② parseAddress 消毒 ----------

test('parseAddress：machine: 名 trim + 大小写规约', () => {
  assert.equal(parseAddress('machine:Lap-B'), 'machine:lap-b')
  assert.equal(parseAddress('machine:  lap-b  '), 'machine:lap-b')
})

test('parseAddress：非 machine: 前缀原样返回不碰（连空白也不动）', () => {
  assert.equal(parseAddress('dsh'), 'dsh')
  assert.equal(parseAddress('  any  '), '  any  ')
  assert.equal(parseAddress('Machine:lap-b'), 'Machine:lap-b') // 前缀大小写敏感：非点名
  assert.equal(parseAddress(''), '')
})

test('parseAddress：空名拒 / 路径分隔符拒（中文错）', () => {
  assert.throws(() => parseAddress('machine:'), /机器名不能为空/)
  assert.throws(() => parseAddress('machine:   '), /机器名不能为空/)
  assert.throws(() => parseAddress('machine:a/b'), /路径分隔符/)
  assert.throws(() => parseAddress('machine:a\\b'), /路径分隔符/)
})

test('toMachineAddress：裸机器名组址，同一消毒', () => {
  assert.equal(toMachineAddress('Lap-B'), 'machine:lap-b')
  assert.throws(() => toMachineAddress(''), /机器名不能为空/)
})

// ---------- ③ bucketOf 三桶 ----------

test('bucketOf：点名本机归 mine / 点名别机归 others（比较大小写不敏感）', () => {
  assert.equal(bucketOf({ to: 'machine:lap-b' }, 'lap-b'), 'mine')
  assert.equal(bucketOf({ to: 'machine:lap-b' }, 'LAP-B'), 'mine') // 本机名侧规约
  assert.equal(bucketOf({ to: 'machine:LAP-B' }, 'lap-b'), 'mine') // 地址侧规约
  assert.equal(bucketOf({ to: 'machine:lap-b' }, 'lap-a'), 'others')
  assert.equal(bucketOf({ to: ' machine:lap-b ' }, 'lap-b'), 'mine') // 手写带空白也能分组
})

test('bucketOf：缺省 / any / agent 名归 any', () => {
  assert.equal(bucketOf({}, 'lap-b'), 'any')
  assert.equal(bucketOf({ to: 'any' }, 'lap-b'), 'any')
  assert.equal(bucketOf({ to: '' }, 'lap-b'), 'any')
  assert.equal(bucketOf({ to: 'dsh' }, 'lap-b'), 'any') // agent 寻址照旧，不进点名桶
})

test('bucketOf：坏数据归 any 不抛（含 row 本身为空）', () => {
  assert.equal(bucketOf({ to: 42 }, 'lap-b'), 'any')
  assert.equal(bucketOf({ to: null }, 'lap-b'), 'any')
  assert.equal(bucketOf({ to: 'machine:' }, 'lap-b'), 'any') // 空名
  assert.equal(bucketOf({ to: 'machine:a/b' }, 'lap-b'), 'any') // 路径分隔符
  assert.equal(bucketOf(null, 'lap-b'), 'any')
  assert.equal(bucketOf(undefined, 'lap-b'), 'any')
  assert.equal(bucketOf({ to: 'machine:lap-b' }, ''), 'others') // 本机名缺席绝不误收
})

// ---------- ④ skill 指引行耦合 ----------

test('sendto skill：指引行与 pickupCommand 句式耦合（句中含卡 id 与 pending 路径）', () => {
  // src/browser-view.ts:123 的 zh 句式：<id> 进句、~/.handoff/pending/ 路径在句中
  assert.ok(
    SENDTO_SKILL_CONTENT.includes(pickupCommand('any', '<卡id>', 'zh')),
    'skill 指引行必须与 pickupCommand 的 zh 句式逐字一致（改句式两处同步）',
  )
  assert.ok(SENDTO_SKILL_CONTENT.includes('~/.handoff/pending/'))
})

test('sendto skill：投递口径诚实——只说「已投递到同步」，全文不出现「送达」', () => {
  assert.ok(SENDTO_SKILL_CONTENT.includes('已投递到同步'))
  assert.ok(!SENDTO_SKILL_CONTENT.includes('送达'), '在线握手/投递回执留 0.27，文案不得声明对方已收到')
  assert.ok(SENDTO_SKILL_CONTENT.includes('handoff_push'))
  assert.ok(SENDTO_SKILL_CONTENT.includes('to: "machine:'))
  assert.ok(SENDTO_SKILL_CONTENT.includes('machine.json'))
})

test('sendto skill：注册项 userInvocable（/handoff 同款显式触发纪律）', () => {
  const reg = sendtoSkillRegistration()
  assert.equal(reg.name, 'sendto')
  assert.equal(reg.source, 'bundled')
  assert.equal(reg.provider, 'dsh-takeover')
  assert.equal(reg.invocation?.userInvocable, true)
  assert.equal(reg.invocation?.modelInvocable, false)
  assert.ok(reg.content.length > 200)
})

// ---------- ⑤ 跨机闭环（文件级，纯函数以 selfName 模拟两机） ----------

test('跨机闭环：A 机写 to=machine:lap-b 的卡落 pending/ → B 机侧 mine、A 机侧 others', () => {
  const homeA = freshHome('loop-a')
  const homeB = freshHome('loop-b')
  writeFileSync(machinePath(homeA), JSON.stringify({ name: 'lap-a' }), 'utf-8')
  writeFileSync(machinePath(homeB), JSON.stringify({ name: 'lap-b' }), 'utf-8')

  const card = makeCard({ to: 'machine:lap-b' })
  const path = writeCard(card, homeA)
  assert.ok(path.includes('pending'), `卡落 pending/：${path}`)

  const loaded = loadCard(card.id, homeA) // 协议位零改动：to 原样进卡、原样读回
  assert.equal(loaded.to, 'machine:lap-b')

  const row = { to: loaded.to }
  const selfA = readMachineName(homeA)
  const selfB = readMachineName(homeB)
  assert.equal(selfA, 'lap-a')
  assert.equal(selfB, 'lap-b')
  assert.equal(bucketOf(row, selfB), 'mine') // B 机第一眼看到「点名给我」
  assert.equal(bucketOf(row, selfA), 'others') // A 机不冒领自己投出去的卡
  assert.equal(bucketOf(row, 'desk-c'), 'others') // 第三台机也不冒领
})

// ---------- ⑥ SYNC_GITIGNORE 回归：机器身份绝不入同步端点（真 git） ----------

test('SYNC_GITIGNORE：machine.json 进 .gitignore 且不入 git 追踪（同名互 claim 防线）', async () => {
  const home = freshHome('git')
  const remote = mkdtempSync(join(tmpdir(), 'dsh-directed-remote-'))
  homes.push(remote)
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' })

  // 机器身份先在盘：setup 全链走完仍不得被追踪
  writeFileSync(machinePath(home), JSON.stringify({ name: 'lap-a' }), 'utf-8')
  const pendingCard = makeCard({ to: 'machine:lap-b' }) // 对照组：pending/ 必须照常入库
  writeCard(pendingCard, home)

  const outcome = await syncSetup(remote, home, { timeoutMs: 10_000 })
  assert.equal(outcome.ok, true, `syncSetup 应成功：${outcome.error ?? ''}`)

  const gitignore = readFileSync(join(home, '.gitignore'), 'utf-8')
  assert.ok(gitignore.includes('machine.json'), '.gitignore 必须排除 machine.json')

  const tracked = execFileSync('git', ['-C', home, 'ls-files'], { encoding: 'utf-8' })
    .split('\n').map((s) => s.trim())
  assert.ok(!tracked.includes('machine.json'), '机器身份绝不能入 git 追踪（两台机同名互 claim 防线）')
  assert.ok(tracked.some((f) => f.startsWith('pending')), 'pending/ 的卡照常入库')
})
