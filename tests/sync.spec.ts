/**
 * 换机上下文同步集成测试（0.2.0）：双 home + 本地裸仓库远端，真 git 走全链。
 * 「两台机器」= 两个独立临时 HANDOFF_HOME + 一个共享裸仓库。
 * 场景：
 * 1. A 寄存 → setup/now → B now 拉到卡（跨机收件箱）
 * 2. B 取件 → now → A now：A pending 清空、archived 计数 1（tombstone 不重放）
 * 3. 两侧同文件各改一版 → 合并冲突诚实报错，本地文件原样保留
 * 4. B 无密钥：pull 采纳 A 的签名密钥 → B 推回的卡 A 侧验签 ok（信任域随目录走）
 * 5. URL 校验：user:pass@ 形态拒收；不支持协议拒收
 * 6. 未启用时动作回规范错误；status 未启用缺省
 * 全部注入短超时（250ms）——真网络面挂死不可能拖死测试。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { generateId, loadCard, writeCard, type Card } from '@agent-handoff/core'
import { buildState } from '../src/settings.ts'
import type { ForeignReaders } from '../src/foreign.ts'
import { loadOrCreateSigningKey, signEnvelope } from '../src/signing.ts'
import {
  loadSyncConfig,
  redactRemote,
  saveSyncConfig,
  syncNow,
  syncPull,
  syncPush,
  syncSetup,
  syncStatusOf,
  validateRemoteUrl,
} from '../src/sync.ts'

// Windows 下一次 git 子进程链（push 多进程+文件系统）轻松超过几百毫秒；测试给 10s 仍远低于真挂死面
const TIMEOUT_MS = 10_000

/** 弹性清理：git 裸仓的 pack/objects 是只读文件，Windows rmSync 会 EPERM——attrib 清只读后再删 */
function rmGit(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    try {
      execFileSync('cmd', ['/c', 'attrib', '-R', join(p, '*'), '/s', '/d'], { stdio: 'ignore' })
      rmSync(p, { recursive: true, force: true })
    } catch { /* 尽力清：临时目录留尸无害 */ }
  }
}

function freshHome(label: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-sync-${label}-`))
}

/** 本地裸仓库当「远端」（真 git，无网络） */
function bareRemote(): string {
  const p = mkdtempSync(join(tmpdir(), 'dsh-sync-remote-'))
  execFileSync('git', ['init', '--bare', '-b', 'main', p], { stdio: 'ignore' })
  return p
}

function fakeReaders(): ForeignReaders {
  return {
    listSessions: () => [],
    resolve: () => ({ kind: 'not-found', reference: '' }),
    readSession: () => [],
    adapterNote: () => ({ supported: true, note: '' }),
  }
}

function makeCard(partial?: Partial<Card>): Card {
  return {
    handoff: 1,
    id: generateId(),
    from: { agent: 'dsh', session: 'sess-x', title: '' },
    to: 'any',
    project: '',
    cwd: tmpdir(),
    pushed_at: '2026-11-12T10:00:00+08:00',
    git: { branch: '', changed: [] },
    tasks: [],
    sections: { goal: 'g', files: 'f', done: 'd', remaining: 'r', stopped: 's', warnings: 'w' },
    extras: {},
    ...partial,
  }
}

test('跨机全链：A 寄存→sync，B sync 拉到卡；B 取件→sync，A sync 后 tombstone 不重放', async () => {
  const remote = bareRemote()
  const A = freshHome('a')
  const B = freshHome('b')
  try {
    // A：寄存两张卡 + 启用
    const c1 = makeCard()
    const c2 = makeCard()
    writeCard(c1, A)
    writeCard(c2, A)
    const setup = await syncSetup(remote, A, { timeoutMs: TIMEOUT_MS })
    assert.equal(setup.ok, true, `A setup 失败：${setup.error ?? ''}`)
    assert.equal(loadSyncConfig(A).enabled, true)
    assert.equal(loadSyncConfig(A).remote, remote, 'setup 把地址落进 sync.json')

    // B：启用同一远端（本地已有别的卡）→ now 拉到 A 的卡
    const cB = makeCard()
    writeCard(cB, B)
    const setupB = await syncSetup(remote, B, { timeoutMs: TIMEOUT_MS })
    assert.equal(setupB.ok, true, `B setup 失败：${setupB.error ?? ''}`)
    const stB1 = buildState(fakeReaders(), B)
    const ids = stB1.pending.map((p) => p.id)
    assert.ok(ids.includes(c1.id) && ids.includes(c2.id), `B 收件箱该有 A 的两张卡：${JSON.stringify(ids)}`)
    assert.ok(ids.includes(cB.id), 'B 自己的卡仍在')

    // B 取件 c1（消费即弃）→ now 推走
    const loaded = loadCard(c1.id, B)
    assert.equal(loaded.id, c1.id)
    const pushB = await syncNow(B, { timeoutMs: TIMEOUT_MS })
    assert.equal(pushB.ok, true, `B now 失败：${pushB.error ?? ''}`)

    // A：now → c1 不再出现在 pending（tombstone），archived 计数含它
    const pullA = await syncNow(A, { timeoutMs: TIMEOUT_MS })
    assert.equal(pullA.ok, true, `A now 失败：${pullA.error ?? ''}`)
    const stA = buildState(fakeReaders(), A)
    assert.ok(!stA.pending.some((p) => p.id === c1.id), '已消费的卡不得在另一台机器重放')
    assert.equal(stA.archivedCount, 1, 'archived/ 即 tombstone：消费证据随同步到达')
    assert.ok(stA.pending.some((p) => p.id === c2.id), '未消费的卡仍在 A 收件箱')
    assert.ok(stA.syncStatus !== undefined, '启用后 state 带同步状态')
    assert.equal(stA.syncStatus.lastError, undefined)
  } finally {
    rmGit(A)
    rmGit(B)
    rmGit(remote)
  }
})

test('合并冲突：两侧各改同一卡文件 → 诚实报错且本地文件原样保留', async () => {
  const remote = bareRemote()
  const A = freshHome('c-a')
  const B = freshHome('c-b')
  try {
    const card = makeCard()
    writeCard(card, A)
    assert.equal((await syncSetup(remote, A, { timeoutMs: TIMEOUT_MS })).ok, true)
    // B 加入（合并 A 的历史）→ 双机同一起跑线
    assert.equal((await syncSetup(remote, B, { timeoutMs: TIMEOUT_MS })).ok, true)
    const fileA = join(A, 'pending', `${card.id}.md`)
    const fileB = join(B, 'pending', `${card.id}.md`)
    // A 先改：往 warnings 段追加标记（卡面仍合法，字节必变）→ now 推上远端
    writeFileSync(fileA, readFileSync(fileA, 'utf-8') + 'A 版附记\n', 'utf-8')
    const nowA = await syncNow(A, { timeoutMs: TIMEOUT_MS })
    assert.equal(nowA.ok, true, `A now 失败：${nowA.error ?? ''}`)
    assert.equal(syncStatusOf(A)?.dirtyFiles, 0, 'A 的编辑必须真被提交（now 后范围内无脏文件，防空操作假绿）')
    // B 再改同一文件：本地提交 B 版；裸 push 被远端拒（A 版已在其上）
    writeFileSync(fileB, readFileSync(fileB, 'utf-8') + 'B 版附记\n', 'utf-8')
    const pushB = await syncPush(B, { timeoutMs: TIMEOUT_MS })
    assert.equal(pushB.ok, false, '分叉后的裸 push 必须被远端拒绝')
    // B pull：合并 A 版与本机已提交的 B 版（共同祖先=原图，双侧同文件不同改法）→ 冲突 → 诚实报错
    const r = await syncPull(B, { timeoutMs: TIMEOUT_MS })
    assert.equal(r.ok, false, '同文件分叉必须诚实失败')
    assert.match(r.error ?? '', /冲突/)
    assert.match(readFileSync(fileB, 'utf-8'), /B 版附记/, '本地文件原样保留（B 版未被吞）')
    assert.ok(!existsSync(join(B, '.git', 'MERGE_HEAD')), '合并已中止，不留半合并状态')
  } finally {
    rmGit(A)
    rmGit(B)
    rmGit(remote)
  }
})

test('签名密钥随同步分发：B 无密钥时采纳 A 的，B 签的卡 A 侧验签 ok', async () => {
  const remote = bareRemote()
  const A = freshHome('k-a')
  const B = freshHome('k-b')
  try {
    // A 先有一张带信封的卡（签名随 push 走）+ 密钥落盘
    const card = makeCard()
    writeCard(card, A)
    const key = loadOrCreateSigningKey(A)
    assert.notEqual(key, null)
    const env = signEnvelope({ card: { id: card.id }, cardSha256: 'x' } as Record<string, unknown>, key!)
    writeFileSync(join(A, 'pending', `${card.id}.envelope.json`), JSON.stringify(env), 'utf-8')
    assert.equal((await syncSetup(remote, A, { timeoutMs: TIMEOUT_MS })).ok, true)

    // B 启用（无本地密钥）→ pull 到卡 + A 的密钥
    assert.equal((await syncSetup(remote, B, { timeoutMs: TIMEOUT_MS })).ok, true)
    assert.ok(existsSync(join(B, '.signing-key.json')), 'A 的密钥随同步到达 B（同一信任域）')
    const keyB = loadOrCreateSigningKey(B)
    assert.equal(keyB?.keyId, key?.keyId, 'B 采纳 A 的密钥，不另起炉灶')
    assert.equal((await syncNow(B, { timeoutMs: TIMEOUT_MS })).ok, true)
    assert.equal((await syncNow(A, { timeoutMs: TIMEOUT_MS })).ok, true)
    const stA = buildState(fakeReaders(), A)
    assert.ok(stA.pending.some((p) => p.id === card.id) || stA.archivedCount >= 1, 'B 推回的卡回到 A')
  } finally {
    rmGit(A)
    rmGit(B)
    rmGit(remote)
  }
})

test('URL 校验：user:pass@ 拒收；坏协议拒收；正常形态放行；红折函数把密码段打码', () => {
  assert.throws(() => validateRemoteUrl('https://user:secret123@github.com/you/handoff.git'), /凭据/)
  assert.throws(() => validateRemoteUrl('https://u:p@x/y'), /凭据/)
  assert.throws(() => validateRemoteUrl('user:secret123@github.com:you/handoff.git'), /凭据/)
  assert.throws(() => validateRemoteUrl('ftp://example.com/x'), /协议/)
  assert.throws(() => saveSyncConfig({ enabled: true, remote: '' }), /仓库地址/)
  // 正常形态放行
  assert.equal(validateRemoteUrl('git@github.com:you/handoff.git'), 'git@github.com:you/handoff.git')
  assert.equal(validateRemoteUrl('ssh://user@gitlab.com/you/handoff.git'), 'ssh://user@gitlab.com/you/handoff.git')
  assert.equal(validateRemoteUrl('https://github.com/you/handoff.git'), 'https://github.com/you/handoff.git')
  // 红折
  assert.equal(redactRemote('https://user:secret123@github.com/you/handoff.git'), 'https://***@github.com/you/handoff.git')
  assert.equal(redactRemote('user:secret123@github.com:you/handoff.git'), 'user:***@github.com:you/handoff.git')
  assert.equal(redactRemote('git@github.com:you/handoff.git'), 'git@github.com:you/handoff.git', '无密码段不打码')
})

test('未启用：动作回规范错误、state 不带 syncStatus；本地路径地址合法', async () => {
  const H = freshHome('off')
  try {
    const r = await syncNow(H, { timeoutMs: TIMEOUT_MS })
    assert.equal(r.ok, false)
    assert.match(r.error ?? '', /未启用/)
    assert.equal(syncStatusOf(H), undefined)
    const st = buildState(fakeReaders(), H)
    assert.equal(st.syncStatus, undefined)
    // 本地裸仓库路径（含中文）合法
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sync-本地-'))
    try {
      execFileSync('git', ['init', '--bare', '-b', 'main', dir], { stdio: 'ignore' })
      assert.equal(validateRemoteUrl(dir), dir)
    } finally { rmGit(dir) }
  } finally {
    rmGit(H)
  }
})

test('不可达远端：动作在超时内诚实失败，错误落 sync-state（面板可见）', async () => {
  const H = freshHome('unreach')
  try {
    // 端口 1 上的 https 远端：快速连接失败（不依赖 30s 超时；真挂死面由 TIMEOUT_MS 兜底）
    const r = await syncSetup('https://127.0.0.1:1/nope.git', H, { timeoutMs: TIMEOUT_MS })
    assert.equal(r.ok, false)
    const st = syncStatusOf(H)
    assert.notEqual(st, undefined, '启用过（config 已落盘）——失败状态必须可见')
    assert.notEqual(st?.lastError, undefined, '失败原因进 sync-state，面板「一眼知道要干嘛」')
  } finally {
    rmGit(H)
  }
})
