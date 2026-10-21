/**
 * ① 解析层 · 故障注入与恢复语义（收件箱消费即弃状态机）：
 * - 并发取件：两个独立进程同时 loadCard 同一张卡，恰好一胜一败（rename 原子性）；
 * - 损坏卡：列表跳过有线索、取件失败不消费、卡原地保留；
 * - 巨卡：拒载不消费；
 * - 同步盘冲突：同名同内容=幂等消费；同名不同内容=冲突副本保留审计（core 加固）；
 * - 孤儿伴生文件：崩溃窗口留下的信封/补丁，buildState 按活性判据清扫。
 * @module dsh-takeover/recovery
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname ?? '.', '..')

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recovery-'))
  mkdirSync(join(dir, 'pending'), { recursive: true })
  mkdirSync(join(dir, 'archived'), { recursive: true })
  return dir
}

/** 直接向 pending/ 落一张合法卡（绕过 pushHandoff 的会话探测，聚焦状态机本身） */
function placeCard(home: string, id: string, body?: string): void {
  writeFileSync(join(home, 'pending', `${id}.md`), body ?? validCardMarkdown(id), 'utf-8')
}

function validCardMarkdown(id: string): string {
  return [
    '---',
    'handoff: 1',
    `id: ${id}`,
    'from:',
    '  agent: dsh',
    '  session: sess-src',
    '  title: 恢复语义测试卡',
    'to: any',
    'project: demo',
    'cwd: /corpus/proj0',
    `pushed_at: 2026-01-01T00:00:00+08:00`,
    'git:',
    '  branch: main',
    '  dirty: []',
    'tasks: []',
    '---',
    '',
    '## 目标（goal）',
    '',
    '验证恢复语义。',
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

const { inboxLoad, inboxList } = await import('../src/tools.ts')
const { buildState } = await import('../src/settings.ts')

test('并发取件 · 顺序等价证明：第二次取已消费的卡必败（rename 原子性的顺序面）', () => {
  const home = freshHome()
  try {
    placeCard(home, 'ho-race-0001')
    // 并发的判定点是 existsSync→rename 的 TOCTOU，由 rename 原子性兜住：
    // 敗者的 rename 必以 ENOENT 落败（另一进程已把源搬走）。顺序两次调用共享同一判定点。
    const first = inboxLoad('ho-race-0001', { dir: home })
    assert.equal(first.ok, true)
    const second = inboxLoad('ho-race-0001', { dir: home })
    assert.equal(second.ok, false, '第二次取件必败（消费即弃）')
    if (!second.ok) assert.match(second.error, /无此待取件/)
    assert.ok(!existsSync(join(home, 'pending', 'ho-race-0001.md')))
    assert.ok(existsSync(join(home, 'archived', 'ho-race-0001.md')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('并发取件 · 平台语义发现：Windows 并发 rename 同一源文件双双成功（冻结——这是认领文件存在的理由）', { skip: process.platform !== 'win32' ? 'Windows 专属 fs 语义（POSIX 上第二发 ENOENT，单胜者天然成立）' : false }, async () => {
  // 实测（libuv/Windows）：两个线程同时对同一 pending 文件 rename，双 fulfilled、
  // 目标仅一份——rename 在 Windows 上不提供互斥。依赖「rename 原子性=单胜者」的
  // 设计在 Windows 并发下会双重消费（两个 agent 都拿到 ok）。core 的 loadCard
  // 因此引入独占创建认领文件（CREATE_NEW，全平台原子）做并发仲裁。
  const home = freshHome()
  try {
    const id = 'ho-race-0003'
    placeCard(home, id)
    const { rename } = await import('node:fs/promises')
    const src = join(home, 'pending', `${id}.md`)
    const dst = join(home, 'archived', `${id}.md`)
    const results = await Promise.allSettled([rename(src, dst), rename(src, dst)])
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], 'Windows 平台语义：双成功（POSIX 上第二发 ENOENT）')
    assert.ok(!existsSync(src))
    assert.equal(readdirSync(join(home, 'archived')).filter((f) => f === `${id}.md`).length, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('并发取件 · loadCard 真并行（worker_threads + Atomics 屏障）：恰好一胜一败', async () => {
  const home = freshHome()
  try {
    const id = 'ho-race-0004'
    placeCard(home, id)
    const coreUrl = 'file:///' + join(ROOT, 'node_modules', '@agent-handoff', 'core', 'dist', 'index.mjs').replace(/\\/g, '/')
    const sab = new SharedArrayBuffer(8)
    new Int32Array(sab)[0] = 0
    const workerSrc = `
      const { parentPort, workerData } = require('node:worker_threads')
      import(${JSON.stringify(coreUrl)}).then(({ loadCard }) => {
        Atomics.wait(new Int32Array(workerData.sab), 0, 0) // 屏障：双方都就位后才放行
        try { loadCard(workerData.id, workerData.home); parentPort.postMessage('WIN') }
        catch (e) { parentPort.postMessage('LOSE|' + String(e.message).slice(0, 50)) }
      })
    `
    const { Worker } = await import('node:worker_threads')
    const workers = [1, 2].map(() => new Worker(workerSrc, {
      eval: true,
      workerData: { sab, id, home },
    }))
    // 等两个 worker 都阻塞在 Atomics.wait（轮询消息计数不可靠——给足启动时间后放行）
    await new Promise((r) => setTimeout(r, 1200))
    Atomics.store(new Int32Array(sab), 0, 1)
    Atomics.notify(new Int32Array(sab), 0)
    const results = await Promise.all(workers.map((w) => new Promise<string>((resolve, reject) => {
      w.on('message', resolve)
      w.on('error', reject)
    })))
    const wins = results.filter((r) => r === 'WIN').length
    assert.equal(wins, 1, `恰好一胜，实得：${JSON.stringify(results)}`)
    const loser = results.find((r) => r !== 'WIN') ?? ''
    assert.match(loser, /并发冲突/, `败者的错误应是并发冲突（消费即弃语义不变），实得：${loser}`)
    assert.ok(!existsSync(join(home, 'pending', `${id}.md`)), 'pending 清空')
    assert.ok(!existsSync(join(home, 'pending', `${id}.claim`)), '认领文件随取件退役，不残留')
    assert.ok(existsSync(join(home, 'archived', `${id}.md`)))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('僵尸卡 · 非法 id：列表跳过有因（不造「永远可见取不走」）、取件被 id 闸拒绝、卡原地保留', () => {
  const home = freshHome()
  try {
    // 非法 id（大写不过 SAFE_ID）：parseCardLenient 宽松解析能读出卡，但 id 闸必拦——
    // 这类卡若进列表，就是永远可见、永远取不走的僵尸卡（core 的既有守卫）
    writeFileSync(join(home, 'pending', 'ho-broken-0001.md'), validCardMarkdown('ho-broken-0001').replace('id: ho-broken-0001', 'id: HO-BROKEN'), 'utf-8')
    const list = inboxList({ dir: home })
    assert.equal(list.ok, true)
    const listed = list as { ok: true; cards: Array<{ id: string }> }
    assert.equal(listed.cards.length, 0, '非法 id 卡不进列表（防僵尸卡）')
    const load = inboxLoad('HO-BROKEN', { dir: home })
    assert.equal(load.ok, false, '取件被 id 闸拒绝')
    assert.ok(existsSync(join(home, 'pending', 'ho-broken-0001.md')), '失败=无副作用，卡保留')
    assert.ok(!existsSync(join(home, 'archived', 'ho-broken-0001.md')), '不得半消费')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('巨卡 · 超上限拒载不消费（渲染先于归档契约）', () => {
  const home = freshHome()
  try {
    const id = 'ho-giant-0001'
    placeCard(home, id, `${validCardMarkdown(id)}\n${'x'.repeat(9 * 1024 * 1024)}`)
    const load = inboxLoad(id, { dir: home })
    assert.equal(load.ok, false)
    if (!load.ok) assert.match(load.error, /拒载|上限/)
    assert.ok(existsSync(join(home, 'pending', `${id}.md`)), '巨卡原地保留')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('同步盘冲突 · 同名同内容：幂等消费（pending 清空，archived 不重复）', () => {
  const home = freshHome()
  try {
    const id = 'ho-sync-same'
    placeCard(home, id)
    // 另一台机器已消费同名同内容卡进 archived（同步盘拉齐）
    writeFileSync(join(home, 'archived', `${id}.md`), readFileSync(join(home, 'pending', `${id}.md`)), 'utf-8')
    const load = inboxLoad(id, { dir: home })
    assert.equal(load.ok, true, '幂等消费应成功')
    assert.ok(!existsSync(join(home, 'pending', `${id}.md`)))
    assert.equal(readFileSync(join(home, 'archived', `${id}.md`), 'utf-8').includes('恢复语义测试卡'), true, 'archived 保持一份')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('同步盘冲突 · 同名不同内容：冲突副本保留审计，本侧消费不丢卡', () => {
  const home = freshHome()
  try {
    const id = 'ho-sync-diff'
    placeCard(home, id)
    writeFileSync(join(home, 'archived', `${id}.md`), '---\nhandoff: 1\nid: ho-sync-diff\n---\n\n## 目标（goal）\n\n旧机版本（审计记录，不可覆盖）\n', 'utf-8')
    const load = inboxLoad(id, { dir: home })
    assert.equal(load.ok, true, '取件应成功（冲突走副本，不拒绝消费）')
    assert.ok(!existsSync(join(home, 'pending', `${id}.md`)), 'pending 消费干净')
    // archived/<id>.md = 本侧新内容；旧机审计内容已先挪进冲突副本，不静默覆盖
    assert.equal(readFileSync(join(home, 'archived', `${id}.md`), 'utf-8').includes('恢复语义测试卡'), true, 'archived 主位是本侧消费内容')
    const conflictFiles = readdirSync(join(home, 'archived')).filter((f) => f.startsWith(`${id}.conflict-`))
    assert.ok(conflictFiles.length === 1, `存在恰好一个 conflict 副本：${JSON.stringify(conflictFiles)}`)
    assert.equal(readFileSync(join(home, 'archived', conflictFiles[0] ?? ''), 'utf-8').includes('旧机版本'), true, '旧机审计内容完整保留在冲突副本')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('孤儿伴生文件 · 信封与补丁按活性判据清扫（崩溃窗口恢复语义）', () => {
  const home = freshHome()
  try {
    const liveId = 'ho-orphan-live'
    const deadId = 'ho-orphan-dead'
    placeCard(home, liveId)
    placeCard(home, deadId)
    // live 卡的信封/补丁（.md 在盘，保留+计数）
    writeFileSync(join(home, 'pending', `${liveId}.envelope.json`), '{"host":{"hostname":"x","platform":"win32"}}', 'utf-8')
    writeFileSync(join(home, 'pending', `${liveId}.patch`), 'diff --git a/x b/x', 'utf-8')
    // dead 卡的信封/补丁（.md 已被取走——崩溃窗口产物，应被清扫）
    writeFileSync(join(home, 'pending', `${deadId}.envelope.json`), '{"supersedes":"ho-old"}', 'utf-8')
    writeFileSync(join(home, 'pending', `${deadId}.patch`), 'diff --git a/y b/y', 'utf-8')
    rmSync(join(home, 'pending', `${deadId}.md`))

    const readers = {
      adapterNote: () => ({ supported: false, note: '' }),
      listSessions: () => [],
      resolve: () => ({ kind: 'not-found', reference: '' }),
      readSession: () => [],
    } as never
    const state = buildState(readers, home)
    assert.ok(!existsSync(join(home, 'pending', `${deadId}.envelope.json`)), '孤儿信封被清扫')
    assert.ok(!existsSync(join(home, 'pending', `${deadId}.patch`)), '孤儿补丁被清扫（本次修复的崩溃窗口）')
    assert.ok(existsSync(join(home, 'pending', `${liveId}.envelope.json`)), '活卡信封保留')
    assert.ok(existsSync(join(home, 'pending', `${liveId}.patch`)), '活卡补丁保留')
    assert.equal(state.pending.length, 1)
    assert.equal((state.pending[0]?.supersedes ?? ''), '', '孤儿信封的 supersedes 不得污染活卡')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
