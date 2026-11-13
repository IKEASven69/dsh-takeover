/**
 * 四轴贯通集成测试（0.2.0）：会话 / 上下文 / 记忆 / 配置四轴同走一根链。
 * 「两台机器」= 两个独立临时 HANDOFF_HOME + 一个本地裸仓库远端（sync.spec.ts 同款）：
 * A 机用 readers 读合成 Claude Code 会话（jsonl，HANDOFF_ROOT_CLAUDE 指向临时目录——
 * foreign.spec.ts 手法：适配器在模块加载时读根路径，env 必须先于 readers 首次加载）
 * 蒸馏出会话轴卡（六段 + extras.baseline 基线 + 未提交改动补丁随卡），同一趟流程
 * 再出记忆轴卡（axis='memory' / payload='files' / 建议段带正文）与配置轴卡
 * （axis='config' / payload='manifest' / 清单+指针指向 env-backup 密文包）；
 * syncNow 推裸远端，B 机 setup + now 拉到三张卡逐轴取件断言，最后 tombstone 跨机不重放。
 * git 全用临时真实仓库，不 mock，不碰真实 ~/.handoff / ~/.claude。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseCard } from '@agent-handoff/core'
import { foreignSessionRead } from '../src/foreign.ts'
import { pushHandoff, pushConfigCard, inboxList, inboxLoad, renderInbox } from '../src/tools.ts'
import { pushMemoryCard, type MemorySourceRow } from '../src/memory.ts'
import { createBackup } from '../src/envbackup.ts'
import { syncSetup, syncNow } from '../src/sync.ts'

// Windows 下一次 git 子进程链轻松超过几百毫秒；测试给 10s 仍远低于真挂死面
const TIMEOUT_MS = 10_000

// ---------- Claude Code 会话 fixture（env 先于 readers 首次加载） ----------

const CLAUDE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-axes-claude-'))
process.env['HANDOFF_ROOT_CLAUDE'] = CLAUDE_ROOT

// ---------- 临时目录与 git helper ----------

/** 弹性清理：git 裸仓 pack/objects 只读，Windows rmSync EPERM——attrib 清只读后再删 */
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

const A = mkdtempSync(join(tmpdir(), 'dsh-axes-home-a-'))
const B = mkdtempSync(join(tmpdir(), 'dsh-axes-home-b-'))
const remote = mkdtempSync(join(tmpdir(), 'dsh-axes-sync-remote-'))
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' })
const memoryHome = mkdtempSync(join(tmpdir(), 'dsh-axes-mem-'))
const userHomeA = mkdtempSync(join(tmpdir(), 'dsh-axes-user-'))

after(() => {
  for (const p of [A, B, remote, memoryHome, userHomeA, CLAUDE_ROOT]) {
    rmGit(p)
  }
})

/** 临时 git 命令（-c core.fsmonitor=false 口径与 core/基线采集一致） */
const gitOf = (dir: string) => (args: string[]): string =>
  execFileSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf-8' }).trim()

/** A 机寄存工作仓：带 origin 裸远端 + 未提交改动 + 未跟踪新文件（上下文轴的承载现场） */
function makeWorkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-axes-repo-'))
  const bare = mkdtempSync(join(tmpdir(), 'dsh-axes-origin-'))
  const g = gitOf(repo)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'app.ts'), 'export const stage = "寄存前"\n', 'utf-8')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  g(['remote', 'add', 'origin', bare])
  // 上下文现场：已跟踪文件的未提交改动 + 一个没 git add 的新文件（<64KB 随补丁走）
  writeFileSync(join(repo, 'app.ts'), 'export const stage = "寄存时未提交"\n', 'utf-8')
  writeFileSync(join(repo, 'notes-today.md'), '# 今日便签\n\n四轴演示寄存现场。\n', 'utf-8')
  after(() => rmGit(repo))
  return repo
}

/** 合成 Claude Code 会话：引擎原生 jsonl 格式（claude 适配器 user/assistant 条目） */
function makeClaudeSession(repo: string): string {
  const entry = (type: string, content: unknown, ts: string): string =>
    JSON.stringify({ type, message: { role: type, content }, cwd: repo, timestamp: ts })
  const jsonl = join(CLAUDE_ROOT, 'demo-four-axes.jsonl')
  writeFileSync(jsonl, [
    entry('user', '把 dsh-takeover 的四轴贯通演示做完：会话、上下文、记忆、配置一起带走', '2026-11-14T09:00:00Z'),
    entry('assistant', [{ type: 'text', text: '好的，先写演示脚本骨架。' }], '2026-11-14T09:01:00Z'),
    entry('assistant', [{ type: 'tool_use', name: 'Edit', input: { file_path: join(repo, 'app.ts') } }], '2026-11-14T09:02:00Z'),
    entry('user', '跑完测试就准备跨机', '2026-11-14T09:03:00Z'),
    entry('assistant', [{ type: 'text', text: '测试全绿，四轴断言齐了，准备 syncNow 推远端。' }], '2026-11-14T09:04:00Z'),
  ].join('\n'), 'utf-8')
  return jsonl
}

test('四轴贯通全链：A 机三轴出卡 → syncNow → B 机拉到三张卡逐轴取件 → tombstone 不重放', async () => {
  const repo = makeWorkRepo()
  const repoGit = gitOf(repo)
  const sessionJsonl = makeClaudeSession(repo)
  const memoryFile = join(memoryHome, 'CLAUDE.md')
  writeFileSync(memoryFile, '# Claude 用户记忆\n\n- 演示项目用 pnpm，不用 npm\n- 提交信息用中文\n', 'utf-8')
  // 配置轴承载现场：假用户家里的 DSH 全家桶登记文件（createBackup 的 root 注入口）
  mkdirSync(join(userHomeA, '.zcode'), { recursive: true })
  writeFileSync(join(userHomeA, '.zcode', 'AGENTS.md'), '# 用户级指令\n\n- 回复用中文\n', 'utf-8')
  const passphrase = 'four-axes-test-passphrase'

  // —— A 机·会话轴：readers 读 Claude 会话 → 六段蒸馏 → 寄存（含基线与补丁） ——
  const show = await foreignSessionRead({ provider: 'claude', action: 'show' })
  assert.equal(show.ok, true)
  if (!show.ok || show.action !== 'show') return
  assert.equal(show.summary.sessionId, sessionJsonl, 'latest 命中合成会话 jsonl')
  assert.match(show.summary.firstUserMessage, /四轴贯通演示/)
  for (const k of ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings'] as const) {
    assert.notEqual(show.skeleton[k], '', `骨架缺段：${k}`)
  }
  const sessionPush = pushHandoff(null, {
    goal: show.skeleton.goal,
    files: show.skeleton.files,
    done: show.skeleton.done,
    remaining: show.skeleton.remaining,
    stopped: show.skeleton.stopped,
    warnings: show.skeleton.warnings,
    title: 'Claude Code 会话 · 四轴测试',
    project: 'demo-four-axes',
    cwd: repo,
  }, { dir: A })
  assert.equal(sessionPush.ok, true, `会话卡寄存失败：${sessionPush.ok ? '' : sessionPush.error}`)
  if (!sessionPush.ok) return

  // —— A 机·记忆轴：建议段带记忆正文（scan 注入，不碰真实 home） ——
  const memoryPush = pushMemoryCard({ keys: ['claude-user'], target: 'any', title: '记忆快照 · 测试' }, {
    dir: A,
    scan: (): MemorySourceRow[] => [{
      key: 'claude-user', agent: 'Claude Code', path: memoryFile,
      exists: true, bytes: 48, mtime: new Date().toISOString(), preview: '# Claude 用户记忆',
    }],
  })
  assert.equal(memoryPush.ok, true, `记忆卡寄存失败：${memoryPush.ok ? '' : memoryPush.error}`)
  if (!memoryPush.ok) return

  // —— A 机·配置轴：环境备份 + 清单+指针出卡（口令永不进卡） ——
  const backup = createBackup(passphrase, A, userHomeA)
  assert.equal(backup.ok, true)
  assert.equal(backup.files, 1, '假用户家只有 .zcode/AGENTS.md 一件在备份范围内')
  const configPush = pushConfigCard({ passphrase }, { dir: A })
  assert.equal(configPush.ok, true, `配置卡寄存失败：${configPush.ok ? '' : configPush.error}`)
  if (!configPush.ok) return

  // —— 出卡面立约：三轴 axis + 两态 payload 逐字在卡 ——
  const readExtras = (dir: string, id: string): Record<string, unknown> =>
    parseCard(readFileSync(join(dir, 'pending', `${id}.md`), 'utf-8')).extras as Record<string, unknown>
  assert.equal(readExtras(A, sessionPush.id)['axis'], 'session')
  assert.equal(readExtras(A, memoryPush.id)['axis'], 'memory')
  assert.equal(readExtras(A, memoryPush.id)['payload'], 'files')
  assert.equal(readExtras(A, configPush.id)['axis'], 'config')
  assert.equal(readExtras(A, configPush.id)['payload'], 'manifest')
  assert.equal((readExtras(A, configPush.id)['config'] as { backupFile?: string })?.backupFile, backup.file)

  // —— A 机 syncNow：三张卡 + 密文包 + 签名密钥推裸远端 ——
  const setupA = await syncSetup(remote, A, { timeoutMs: TIMEOUT_MS })
  assert.equal(setupA.ok, true, `A setup 失败：${setupA.error ?? ''}`)
  const pushA = await syncNow(A, { timeoutMs: TIMEOUT_MS })
  assert.equal(pushA.ok, true, `A syncNow 失败：${pushA.error ?? ''}`)

  // —— B 机 setup + now：拉到三张卡 ——
  const setupB = await syncSetup(remote, B, { timeoutMs: TIMEOUT_MS })
  assert.equal(setupB.ok, true, `B setup 失败：${setupB.error ?? ''}`)
  const pullB = await syncNow(B, { timeoutMs: TIMEOUT_MS })
  assert.equal(pullB.ok, true, `B syncNow 失败：${pullB.error ?? ''}`)
  const listB = inboxList({ dir: B })
  assert.equal(listB.ok, true)
  if (!listB.ok) return
  const ids = listB.cards.map((c) => c.id)
  assert.deepEqual(ids.sort(), [configPush.id, memoryPush.id, sessionPush.id].sort(), 'B 机拉到全部三张卡')

  // —— 会话轴取件：六段 + axis + baseline 三元组 + 补丁 + 签名 ——
  const loadSession = inboxLoad(sessionPush.id, { dir: B })
  assert.equal(loadSession.ok, true)
  if (!loadSession.ok) return
  assert.equal(loadSession.axis, 'session')
  for (const heading of ['## 目标', '## 涉及文件', '## 做到哪', '## 还差什么', '## 停在哪', '## 读者警告']) {
    assert.ok(loadSession.text.includes(heading), `六段缺段：${heading}`)
  }
  assert.ok(loadSession.baseline, '取件面应带 baseline')
  assert.equal(loadSession.baseline?.head, repoGit(['rev-parse', 'HEAD']))
  assert.equal(loadSession.baseline?.branch, 'main')
  assert.equal(loadSession.baseline?.remote, repoGit(['remote', 'get-url', 'origin']))
  assert.ok(typeof loadSession.patchPath === 'string' && existsSync(loadSession.patchPath), '补丁随卡到达')
  assert.equal(loadSession.sig, 'ok', '签名密钥随同步走 = 信任域随目录走')

  // —— 记忆轴取件：建议段正文在场 + 吸收回执进生命周期账本 ——
  const loadMemory = inboxLoad(memoryPush.id, { dir: B })
  assert.equal(loadMemory.ok, true)
  if (!loadMemory.ok) return
  assert.equal(loadMemory.axis, 'memory')
  assert.ok(loadMemory.text.includes('## 建议加载') && loadMemory.text.includes('演示项目用 pnpm'), 'memory 建议段正文随卡到达')
  assert.match(String(renderInbox({}, loadMemory)[0]?.text), /记忆已随卡注入/)
  assert.match(readFileSync(join(B, 'lifecycle.jsonl'), 'utf-8'), /"reason":"memory-absorbed"/)

  // —— 配置轴取件：清单在卡上 + 密文包本体随同步到达 ——
  const loadConfig = inboxLoad(configPush.id, { dir: B })
  assert.equal(loadConfig.ok, true)
  if (!loadConfig.ok) return
  assert.equal(loadConfig.axis, 'config')
  assert.ok(loadConfig.text.includes('sha256=') && loadConfig.text.includes('.zcode/AGENTS.md'), 'config 清单（path｜category｜sha256）在卡上')
  assert.ok(existsSync(join(B, 'env-backup', backup.file)), '密文包本体随同步到达 B 机')

  // —— 消费即弃跨机收敛：B 推走 tombstone，A 再 now → pending 清空 ——
  const pushB2 = await syncNow(B, { timeoutMs: TIMEOUT_MS })
  assert.equal(pushB2.ok, true, `B 二次 syncNow 失败：${pushB2.error ?? ''}`)
  const pullA2 = await syncNow(A, { timeoutMs: TIMEOUT_MS })
  assert.equal(pullA2.ok, true, `A 二次 syncNow 失败：${pullA2.error ?? ''}`)
  const listA = inboxList({ dir: A })
  assert.equal(listA.ok, true)
  if (!listA.ok) return
  assert.equal(listA.cards.length, 0, 'A 机 pending 清空——已消费的卡不在另一台机器重放')
})
