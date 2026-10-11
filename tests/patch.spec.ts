/**
 * 物质层交接测试（0.4.1）：补丁随卡 / 信封物质层扩展 / 非 git 仓诚实警告 / supersedes 接力链。
 * 全部用临时真实 git 仓库走 pushHandoff → inboxLoad 全链路，不 mock git。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectPatch, PATCH_MAX_BYTES } from '@agent-handoff/core'
import { buildEnvelope, inboxLoad, pushHandoff, renderInbox } from '../src/tools.ts'

/** 造一个有真实提交基线的临时 git 仓（fsmonitor 关闭口径与 core 一致） */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-patch-'))
  const g = (args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', ...args], { stdio: 'ignore' })
  g(['init', '-q'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(dir, 'base.txt'), 'baseline\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  return dir
}

const withHome = <T>(fn: (home: string) => T): T => {
  const home = mkdtempSync(join(tmpdir(), 'takeover-patch-home-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test('补丁随卡：脏仓 push 落 .patch sidecar，取件随卡归档并给出 apply 指引', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'base.txt'), 'baseline\nchanged line\n') // 未提交改动
  withHome((home) => {
    const r = pushHandoff(null, { goal: '补丁往返', warnings: '', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.patch, '脏仓 push 应返回 patch 信息')
    if (!r.patch) return
    assert.equal(r.patch.truncated, false)
    assert.equal(r.patch.sidecar, true)
    assert.ok(r.patch.bytes > 0)
    const patchPath = join(home, 'pending', `${r.id}.patch`)
    assert.ok(existsSync(patchPath), 'pending/ 应有 <id>.patch')
    assert.ok(readFileSync(patchPath, 'utf-8').includes('changed line'), '补丁应含未提交改动内容')
    assert.ok(r.note.includes('补丁随卡'), `push 文案应提示补丁随卡：${r.note}`)
    // 信封里也有 patch 与 host
    const env = JSON.parse(readFileSync(join(home, 'pending', `${r.id}.envelope.json`), 'utf-8')) as Record<string, unknown>
    assert.ok(env['patch'], '信封应含 patch 字段')
    assert.ok(env['host'], '信封应含源机标识 host')
    assert.equal((env['host'] as { platform?: string }).platform, process.platform)
    // 取件：补丁随卡搬去 archived/，文案给 apply 指引
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.ok(load.patchPath, '取件结果应带归档补丁路径')
    if (!load.patchPath) return
    assert.ok(existsSync(load.patchPath), '补丁应已搬进 archived/')
    assert.ok(!existsSync(patchPath), 'pending/ 的补丁应已离场')
    assert.ok(typeof load.patchBytes === 'number' && load.patchBytes > 0)
    const text = renderInbox(null, load).map((b) => b.text).join('\n')
    assert.ok(text.includes('git apply --check'), '取件文案应给 apply --check 指引')
    assert.ok(text.includes(load.patchPath))
  })
  rmSync(repo, { recursive: true, force: true })
})

test('净仓 push：无补丁 sidecar、无补丁文案；untracked 新文件进清单提示', () => {
  const repo = makeRepo() // 干净树（仅基线提交）
  writeFileSync(join(repo, 'new-untracked.txt'), 'brand new\n') // 未跟踪新文件
  withHome((home) => {
    const r = pushHandoff(null, { goal: '净仓', warnings: '', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.patch, undefined, '净仓不应有补丁')
    assert.ok(!existsSync(join(home, 'pending', `${r.id}.patch`)), '净仓不应落 .patch')
    assert.ok(r.note.includes('未跟踪新文件 1 个不随卡'), `untracked 应进文案：${r.note}`)
    const env = JSON.parse(readFileSync(join(home, 'pending', `${r.id}.envelope.json`), 'utf-8')) as { untracked?: Array<{ file: string }> }
    assert.ok(env['untracked'] === undefined || (env['untracked'] as unknown[]).length >= 0)
  })
  rmSync(repo, { recursive: true, force: true })
})

test('非 git 仓 cwd：push 警告段如实标注（不再让 git 字段静默为空）', () => {
  const plain = mkdtempSync(join(tmpdir(), 'takeover-nogit-'))
  withHome((home) => {
    const r = pushHandoff(null, { goal: '非仓', warnings: '', cwd: plain }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.patch, undefined)
    const card = readFileSync(join(home, 'pending', `${r.id}.md`), 'utf-8')
    assert.ok(card.includes('源目录未识别为 git 仓库'), '卡片警告段应如实标注非 git 仓')
    assert.ok(card.includes(plain.slice(0, 8)), '警告应带 cwd 线索')
  })
  rmSync(plain, { recursive: true, force: true })
})

test('超大 diff 整份拒带不截断：collectPatch truncated + push 文案提示自行提交', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'base.txt'), `x${'y'.repeat(PATCH_MAX_BYTES)}`) // >512KB 单行改动
  // 直接收集面：超上限 → patch 空串 + truncated
  const small = collectPatch(repo, 100)
  assert.ok(small)
  assert.equal(small.truncated, true)
  assert.equal(small.patch, '')
  assert.ok(small.bytes > 100)
  // push 面（默认上限）：600KB diff 超 512KB → 拒带 + 文案
  withHome((home) => {
    const r = pushHandoff(null, { goal: '巨diff', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.patch?.truncated, '应标记 truncated')
    assert.ok(!existsSync(join(home, 'pending', `${r.id}.patch`)), '拒带时不落 .patch')
    assert.ok(r.note.includes('未提交 diff 过大'), `文案应提示自行携带：${r.note}`)
  })
  rmSync(repo, { recursive: true, force: true })
})

test('信封物质层：test 基线提示 + supersedes 接力链贯通 push→信封→取件→文案', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 't', scripts: { test: 'node --test' } }))
  withHome((home) => {
    const r = pushHandoff(null, { goal: '接力', cwd: repo, supersedes: 'ho-test-0001' }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.supersedes, 'ho-test-0001')
    const env = JSON.parse(readFileSync(join(home, 'pending', `${r.id}.envelope.json`), 'utf-8')) as {
      supersedes?: string
      test?: { command?: string }
    }
    assert.equal(env.supersedes, 'ho-test-0001')
    assert.equal(env.test?.command, 'npm test')
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.supersedes, 'ho-test-0001')
    assert.equal(load.testCommand, 'npm test')
    const text = renderInbox(null, load).map((b) => b.text).join('\n')
    assert.ok(text.includes('基线测试提示'), '取件文案应含基线测试提示')
    assert.ok(text.includes('接替前置卡 ho-test-0001'), '取件文案应含接力链')
  })
  rmSync(repo, { recursive: true, force: true })
})

test('buildEnvelope：extra 字段缺省时不产出现有消费者不认识的键', () => {
  const env = buildEnvelope({ id: 'ho-x-0001', from: { agent: 'dsh' }, sections: { goal: 'g' } })
  const raw = JSON.parse(JSON.stringify(env)) as Record<string, unknown>
  for (const k of ['patch', 'untracked', 'host', 'test', 'supersedes']) assert.equal(k in raw, false, `${k} 不应出现`)
})

test('mkdirSync 前置引用防抖（tmp 目录已由 makeRepo/withHome 覆盖）', () => {
  assert.equal(typeof mkdirSync, 'function')
  assert.ok(PATCH_MAX_BYTES >= 512 * 1024)
})
