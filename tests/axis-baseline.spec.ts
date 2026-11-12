/**
 * 四轴 IR 立约 + 仓库基线测试（axis/payload 立约、extras.baseline 进卡、
 * 缺 remote 容忍、取件恢复指引渲染）。
 * 落盘一律走临时 HANDOFF_HOME；git 全用临时真实仓库（fsmonitor 关闭口径与 core 一致），
 * 不 mock git、不碰真实 ~/.handoff。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCard, renderCard, writeCard } from '@agent-handoff/core'
import { inboxLoad, pushHandoff, renderInbox, baselineFromExtras, type RepoBaseline } from '../src/tools.ts'
import { pushMemoryCard, type MemorySourceRow } from '../src/memory.ts'

/** 独立 HANDOFF_HOME 临时目录（用例结束清理） */
function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-axis-home-'))
}

/** 临时 git 命令（-c core.fsmonitor=false 口径与 core 一致） */
function gitOf(dir: string): (args: string[]) => string {
  return (args) => execFileSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf-8' }).trim()
}

/** 造一个有真实提交的临时 git 仓（可带 origin 裸仓远端），返回仓库目录 */
function makeRepo(opts?: { withOrigin?: boolean; dirty?: boolean; withTestScript?: boolean }): string {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-axis-repo-'))
  const g = gitOf(repo)
  g(['init', '-q'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'base.txt'), 'baseline\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  if (opts?.withOrigin === true) {
    // 本地裸仓当 origin：get-url 返回该路径，足够验证 remote 采集与 round-trip
    const bare = mkdtempSync(join(tmpdir(), 'dsh-axis-bare-'))
    execFileSync('git', ['init', '-q', '--bare', bare], { stdio: 'ignore' })
    g(['remote', 'add', 'origin', bare])
  }
  if (opts?.dirty === true) writeFileSync(join(repo, 'base.txt'), 'baseline\nchanged\n')
  if (opts?.withTestScript === true) {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'axis-fixture', scripts: { test: 'node -e "process.exit(0)"' } }), 'utf-8')
  }
  return repo
}

// ---------------------------------------------------------------------------
// A. axis/payload 立约：默认 session，记忆卡 memory/files，round-trip 不丢
// ---------------------------------------------------------------------------

test('axis 立约：pushHandoff 默认写 extras.axis="session"，落盘 round-trip 不丢', () => {
  const dir = tmpHome()
  try {
    const r = pushHandoff(null, { goal: '立约冒烟：会话卡（手写段过守门）' }, { dir })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const card = parseCard(readFileSync(r.path, 'utf-8'))
    assert.equal(card.extras['axis'], 'session')
    // 双重 round-trip：renderCard → parseCard 再走一遍，axis 仍在（未知字段不丢纪律）
    const again = parseCard(renderCard(card))
    assert.equal(again.extras['axis'], 'session')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('axis/payload 立约：pushMemoryCard 写 extras.axis="memory"、extras.payload="files"，round-trip 不丢', () => {
  const home = tmpHome()
  const body = mkdtempSync(join(tmpdir(), 'dsh-axis-mem-'))
  try {
    const scan = (): MemorySourceRow[] => [
      { key: 'claude-user', agent: 'Claude Code', path: join(body, 'CLAUDE.md'), exists: true, bytes: 10, mtime: '', preview: '' },
    ]
    const r = pushMemoryCard({ keys: ['claude-user'], target: 'claude' }, { scan, push: pushHandoff, dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const card = parseCard(readFileSync(r.path, 'utf-8'))
    assert.equal(card.extras['axis'], 'memory')
    assert.equal(card.extras['payload'], 'files')
    const again = parseCard(renderCard(card))
    assert.equal(again.extras['axis'], 'memory')
    assert.equal(again.extras['payload'], 'files')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(body, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// B. 仓库基线：remote/head/branch 进 extras.baseline + round-trip + 如实缺省
// ---------------------------------------------------------------------------

test('baseline 进卡：带 origin 的 git 仓 push 写 extras.baseline，parseCard 读回等值', () => {
  const repo = makeRepo({ withOrigin: true })
  const home = tmpHome()
  try {
    const g = gitOf(repo)
    const head = g(['rev-parse', 'HEAD'])
    const branch = g(['branch', '--show-current'])
    const remote = g(['remote', 'get-url', 'origin'])
    const r = pushHandoff(null, { goal: '基线：带 origin 的仓库卡', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const card = parseCard(readFileSync(r.path, 'utf-8'))
    const b = baselineFromExtras(card.extras)
    assert.ok(b, 'extras.baseline 应存在')
    if (!b) return
    assert.equal(b.remote, remote)
    assert.equal(b.head, head)
    assert.equal(b.branch, branch)
    // round-trip：renderCard → parseCard 再走一遍，baseline 三元组不丢
    const again = parseCard(renderCard(card))
    assert.deepEqual(baselineFromExtras(again.extras), { remote, head, branch })
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('缺 remote 容忍：无 origin 的 git 仓 baseline.remote 如实 null，head/branch 照记', () => {
  const repo = makeRepo()
  const home = tmpHome()
  try {
    const g = gitOf(repo)
    const r = pushHandoff(null, { goal: '基线：无 origin 的仓库卡', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const card = parseCard(readFileSync(r.path, 'utf-8'))
    const b = baselineFromExtras(card.extras)
    assert.ok(b, '无 origin 也应有 baseline（head 在场）')
    if (!b) return
    assert.equal(b.remote, null)
    assert.equal(b.head, g(['rev-parse', 'HEAD']))
    assert.equal(b.branch, g(['branch', '--show-current']))
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('非 git 仓如实缺省：extras.baseline 整字段不写（不造假基线），axis 照写', () => {
  const home = tmpHome()
  const plain = mkdtempSync(join(tmpdir(), 'dsh-axis-plain-'))
  try {
    const r = pushHandoff(null, { goal: '基线：非 git 目录卡', cwd: plain }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const card = parseCard(readFileSync(r.path, 'utf-8'))
    assert.equal(baselineFromExtras(card.extras), undefined)
    assert.equal(card.extras['axis'], 'session')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// C. 恢复指引：extras.baseline 在场 → 四步渲染；缺席/坏形态如实降级
// ---------------------------------------------------------------------------

test('恢复指引渲染：取件带 baseline → 四步（clone/checkout/apply/跑测试）齐全', () => {
  const repo = makeRepo({ withOrigin: true, dirty: true, withTestScript: true })
  const home = tmpHome()
  try {
    const g = gitOf(repo)
    const head = g(['rev-parse', 'HEAD'])
    const remote = g(['remote', 'get-url', 'origin'])
    const r = pushHandoff(null, { goal: '恢复指引：脏仓带测试脚本的卡', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.ok(load.baseline, 'load 返回面应带 baseline')
    if (!load.baseline) return
    assert.equal(load.baseline.remote, remote)
    assert.equal(load.baseline.head, head)
    const text = String(renderInbox({}, load)[0]?.text)
    assert.ok(text.includes('基线恢复指引'), `应渲染指引标题：${text}`)
    assert.ok(text.includes(`git clone ${remote}`), `第 1 步 clone：${text}`)
    assert.ok(text.includes(`git checkout ${head}`), `第 2 步 checkout HEAD：${text}`)
    assert.match(text, /git apply .+\.patch/, `第 3 步 apply 随卡补丁：${text}`)
    assert.ok(text.includes('跑测试（npm test）'), `第 4 步用信封 testCommand 跑测试：${text}`)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('恢复指引降级：remote/head 缺省的外来卡渲染如实说明行，不渲染空壳命令', () => {
  const home = tmpHome()
  try {
    // 手写外来卡（writeCard）：baseline 三元组全缺省、无信封无补丁——降级路径全覆盖
    const card = {
      handoff: 1,
      id: 'ho-axis0001-base',
      from: { agent: 'foreign', session: '', title: '外来基线卡' },
      to: 'any',
      project: '',
      cwd: '',
      pushed_at: '2026-11-13T00:00:00+08:00',
      git: { branch: '', changed: [] },
      tasks: [],
      sections: { goal: '恢复指引降级冒烟', files: '', done: '', remaining: '', stopped: '', warnings: '' },
      extras: { axis: 'session', baseline: { remote: null, head: null, branch: 'dev' } as unknown as Record<string, unknown> },
    }
    writeCard(card as Parameters<typeof writeCard>[0], home)
    const load = inboxLoad(card.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    const b: RepoBaseline | undefined = load.baseline
    assert.deepEqual(b, { remote: null, head: null, branch: 'dev' })
    const text = String(renderInbox({}, load)[0]?.text)
    assert.ok(text.includes('卡片未带 origin 远端'), `第 1 步降级说明：${text}`)
    assert.ok(text.includes('卡片未带 HEAD'), `第 2 步降级说明：${text}`)
    assert.ok(text.includes('本卡无随卡补丁'), `第 3 步降级说明：${text}`)
    assert.ok(text.includes('信封未带基线测试命令'), `第 4 步降级说明：${text}`)
    assert.ok(!/\n\s*1\. git clone https?:/.test(text), '缺 remote 不应渲染可复制的空壳命令')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// D. baselineFromExtras 防御：外来卡/坏数据一律 undefined，不渲染不报错
// ---------------------------------------------------------------------------

test('baselineFromExtras：坏形态一律 undefined，好形态原样读回', () => {
  assert.equal(baselineFromExtras(undefined), undefined)
  assert.equal(baselineFromExtras(null), undefined)
  assert.equal(baselineFromExtras('x'), undefined)
  assert.equal(baselineFromExtras({ baseline: null }), undefined)
  assert.equal(baselineFromExtras({ baseline: 'oops' }), undefined)
  assert.equal(baselineFromExtras({ baseline: ['remote', 'head'] }), undefined)
  assert.equal(baselineFromExtras({ baseline: { remote: 1, head: null, branch: 'dev' } }), undefined)
  assert.equal(baselineFromExtras({ baseline: { remote: null, head: true, branch: 'dev' } }), undefined)
  assert.equal(baselineFromExtras({ baseline: { remote: null, head: null } }), undefined, 'branch 缺失不认')
  assert.deepEqual(
    baselineFromExtras({ baseline: { remote: 'https://example.com/x.git', head: 'a'.repeat(40), branch: 'main' } }),
    { remote: 'https://example.com/x.git', head: 'a'.repeat(40), branch: 'main' },
  )
  // 恢复指引（渲染层）对坏形态同样防御：只在 load 通过 baselineFromExtras 之后才会渲染
})
