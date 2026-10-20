/**
 * ① 解析层 · 特征化测试（golden files）：
 * readers 对语料 fixtures 的「发现 + 结构化摘要」输出逐字节冻结——解析行为
 * 的任何变化（上游存储布局迁移、适配器改动）都会在这里现形，改对了才允许
 * REGEN_GOLDEN=1 重新生成。语料由 scripts/corpus-build.mjs 从本机真实会话
 * 结构克隆脱敏而来（键名/嵌套/损坏行保留，字符串内容全合成）。
 *
 * golden 纪律：凡随机器/checkout 变化的字段（绝对路径 id、文件 mtime）不进
 * golden；随内容结构变化的字段（title/cwd/kind/轮次/摘要）全进。
 * @module dsh-takeover/corpus-golden
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { basename } from 'node:path'

const ROOT = join(import.meta.dirname ?? '.', '..')
// env 必须先于 readers 首次加载（适配器在模块加载时读根路径）
process.env['HANDOFF_ROOT_CLAUDE'] = join(ROOT, 'tests', 'fixtures', 'corpus', 'claude')
process.env['HANDOFF_ROOT_ZCODE'] = join(ROOT, 'tests', 'fixtures', 'corpus', 'zcode', 'db.sqlite')

const { defaultForeignReaders } = await import('../src/foreign.ts')
const { summarizeTurns } = await import('../src/foreign.ts')

const GOLDEN_DIR = join(ROOT, 'tests', 'golden')
const CORPUS = join(ROOT, 'tests', 'fixtures', 'corpus')

/** golden 比对/再生（REGEN_GOLDEN=1 时写入而非比对） */
function golden(name: string, actual: unknown): void {
  const p = join(GOLDEN_DIR, name)
  const json = `${JSON.stringify(actual, null, 2)}\n`
  if (process.env['REGEN_GOLDEN'] === '1') {
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, json, 'utf-8')
    return
  }
  assert.ok(existsSync(p), `golden 缺失：${name}（先跑 REGEN_GOLDEN=1 npm test 生成）`)
  assert.equal(readFileSync(p, 'utf-8'), json, `golden 不匹配：${name}——解析行为变了。若是预期改进，REGEN_GOLDEN=1 重新生成并在提交说明里写明原因`)
}

const readers = await defaultForeignReaders()

test('语料隐私自检：fixtures 不含本机路径特征（结构克隆纪律）', () => {
  const bad: string[] = []
  const scan = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name)
      if (f.isDirectory()) scan(p)
      else {
        const text = readFileSync(p, 'utf8')
        if (/123456|C:\\\\?Users|[A-Z]:\\\\|\/Users\/|CodingProjects/.test(text)) bad.push(p)
      }
    }
  }
  scan(CORPUS)
  assert.deepEqual(bad, [], `fixtures 泄漏本机路径：${bad.join('、')}`)
})

test('claude 发现层 golden：语料会话清单（结构字段，无机器相关值）', () => {
  const refs = readers.listSessions('claude-code')
  assert.ok(refs.length >= 9, `语料会话数不足：${refs.length}`)
  golden('corpus-claude-discover.json', refs.map((r) => ({
    title: r.title,
    cwd: r.cwd,
    kind: r.kind,
    hasCwd: r.cwd !== '',
  })).sort((a, b) => a.title.localeCompare(b.title)))
})

test('claude 蒸馏层 golden：每个语料会话的结构化摘要逐字节冻结', async () => {
  const refs = readers.listSessions('claude-code')
  assert.ok(refs.length > 0)
  for (const ref of refs) {
    const turns = readers.readSession('claude-code', ref)
    const { summary, skeleton } = summarizeTurns(ref, turns)
    // sessionId 是机器相关绝对路径——归一成文件名再冻结
    const out = {
      session: basename(ref.id),
      turnCount: summary.turnCount,
      userTurns: summary.userTurns,
      firstUserMessage: summary.firstUserMessage,
      files: summary.files,
      commands: summary.commands,
      skeleton: {
        goal: skeleton.goal,
        files: skeleton.files,
        done: skeleton.done,
        remaining: skeleton.remaining,
        stopped: skeleton.stopped,
        warnings: skeleton.warnings,
      },
    }
    golden(`corpus/claude-${basename(ref.id)}.json`, out)
  }
})

test('zcode 发现层 + 蒸馏层 golden：sqlite 适配器对语料库的输出冻结', () => {
  const note = readers.adapterNote('zcode')
  assert.equal(note.supported, true, `node:sqlite 不可用，zcode 语料跳过：${note.note}`)
  const refs = readers.listSessions('zcode')
  assert.ok(refs.length >= 1, 'zcode 语料库无会话')
  golden('corpus-zcode-discover.json', refs.map((r) => ({
    id: r.id, title: r.title, cwd: r.cwd, kind: r.kind,
  })))
  for (const ref of refs.slice(0, 3)) {
    const turns = readers.readSession('zcode', ref)
    const { summary } = summarizeTurns(ref, turns)
    golden(`corpus/zcode-${ref.id}.json`, {
      turnCount: summary.turnCount,
      userTurns: summary.userTurns,
      firstUserMessage: summary.firstUserMessage,
      files: summary.files,
    })
  }
})
