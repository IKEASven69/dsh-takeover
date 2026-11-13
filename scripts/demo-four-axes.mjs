#!/usr/bin/env node
/**
 * 四轴贯通演示（0.2.0）：会话 / 上下文 / 记忆 / 配置四轴，同走一根链。
 *
 * 场景 =「A 机寄存、B 机接着干」的最小可复现全链：
 *   ① A 机用 readers 读一个合成 Claude Code 会话（jsonl，HANDOFF_ROOT_CLAUDE 覆盖根，
 *      tests/foreign.spec.ts 同款 fixture 手法），蒸馏成会话轴卡（六段 + 上下文轴的
 *      repo 基线 baseline 与未提交改动补丁随卡）；
 *   ② 同一趟流程再出两张卡：记忆轴卡（extras.axis='memory'、payload='files'，
 *      记忆正文进「建议加载」段）+ 配置轴卡（extras.axis='config'、payload='manifest'，
 *      清单+指针指向 env-backup/ 的密文 blob，口令永不进卡）；
 *   ③ syncNow 把三张卡 + 密文包经本地裸仓库远端推走；
 *   ④ B 机 setup + now 拉到三张卡，逐张取件，断言四轴齐全：
 *      六段在、axis/payload 在、baseline 在、memory 建议段在、config 清单在。
 *
 * 纪律：全部落盘走两个临时 HANDOFF_HOME + 临时工作仓 + 临时假用户家，不碰真实
 * ~/.handoff、不碰真实 ~/.claude；断言不过就非零退出（退出码 0 = 贯通），绝不造假。
 *
 * 用法：npx tsx scripts/demo-four-axes.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// 断言工具：断言不过立即抛，外层统一捕获后非零退出——演示结果不造假
// ---------------------------------------------------------------------------

let step = 0
const say = (msg) => console.log(`\n【第 ${step} 步】${msg}`)
const info = (msg) => console.log(`  ${msg}`)

function must(cond, label, detail = '') {
  if (cond) {
    info(`✅ ${label}`)
    return
  }
  info(`❌ ${label}${detail !== '' ? ` —— ${detail}` : ''}`)
  throw new Error(`断言失败：${label}`)
}

// ---------------------------------------------------------------------------
// fixture：双 home + 裸远端 + Claude 会话 jsonl + 工作仓 + 记忆文件 + 假用户家
// ---------------------------------------------------------------------------

/** HANDOFF_ROOT_CLAUDE 必须先于 readers 首次加载设定（claude 适配器在模块加载时读根路径） */
const CLAUDE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-axes-claude-'))
process.env['HANDOFF_ROOT_CLAUDE'] = CLAUDE_ROOT

// src 模块走 tsx 直跑（typecheck/test 不覆盖本脚本，见 package.json scripts.check 口径）
const src = (p) => import(pathToFileURL(join(REPO_ROOT, 'src', p)).href)
const { foreignSessionRead } = await src('foreign.ts')
const { pushHandoff, pushConfigCard, inboxList, inboxLoad, renderInbox } = await src('tools.ts')
const { pushMemoryCard } = await src('memory.ts')
const { createBackup } = await src('envbackup.ts')
const { syncSetup, syncNow } = await src('sync.ts')
const { parseCard } = await import('@agent-handoff/core')

/** 弹性清理：git 裸仓 pack/objects 只读，Windows rmSync EPERM 时 attrib 清只读再删（tests/sync.spec.ts 同款） */
function rmGit(p) {
  try {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  } catch {
    try {
      execFileSync('cmd', ['/c', 'attrib', '-R', join(p, '*'), '/s', '/d'], { stdio: 'ignore' })
      rmSync(p, { recursive: true, force: true })
    } catch { /* 尽力清：临时目录留尸无害 */ }
  }
}

/** 临时 git 命令（-c core.fsmonitor=false 口径与 core/基线采集一致） */
const gitOf = (dir) => (args) =>
  execFileSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf-8' }).trim()

/** A 机寄存工作仓：带 origin 裸远端 + 未提交改动 + 未跟踪新文件（上下文轴的承载现场） */
function makeWorkRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-axes-repo-'))
  const bare = mkdtempSync(join(tmpdir(), 'dsh-axes-origin-'))
  const g = gitOf(repo)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' })
  g(['init', '-q', '-b', 'main'])
  g(['config', 'user.email', 'demo@four-axes'])
  g(['config', 'user.name', '四轴演示'])
  writeFileSync(join(repo, 'app.ts'), 'export const stage = "寄存前"\n', 'utf-8')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  g(['remote', 'add', 'origin', bare])
  // 上下文现场：已跟踪文件的未提交改动 + 一个没 git add 的新文件（<64KB 随补丁走）
  writeFileSync(join(repo, 'app.ts'), 'export const stage = "寄存时未提交"\n', 'utf-8')
  writeFileSync(join(repo, 'notes-today.md'), '# 今日便签\n\n四轴演示寄存现场。\n', 'utf-8')
  return repo
}

/** 合成 Claude Code 会话：引擎原生 jsonl 格式（entryToTurns 消费 user/assistant 条目） */
function makeClaudeSession(repo) {
  mkdirSync(CLAUDE_ROOT, { recursive: true })
  const jsonl = join(CLAUDE_ROOT, 'demo-four-axes.jsonl')
  const entry = (type, content, ts, extra = {}) =>
    JSON.stringify({ type, message: { role: type, content }, cwd: repo, timestamp: ts, ...extra })
  writeFileSync(jsonl, [
    entry('user', '把 dsh-takeover 的四轴贯通演示做完：会话、上下文、记忆、配置一起带走', '2026-11-14T09:00:00Z'),
    entry('assistant', [{ type: 'text', text: '好的，先写演示脚本骨架。' }], '2026-11-14T09:01:00Z', { model: 'claude-sonnet-4-5' }),
    entry('assistant', [{ type: 'tool_use', name: 'Edit', input: { file_path: join(repo, 'app.ts') } }], '2026-11-14T09:02:00Z'),
    entry('user', '跑完测试就准备跨机', '2026-11-14T09:03:00Z'),
    entry('assistant', [{ type: 'text', text: '测试全绿，四轴断言齐了，准备 syncNow 推远端。' }], '2026-11-14T09:04:00Z'),
  ].join('\n'), 'utf-8')
  return jsonl
}

const A = mkdtempSync(join(tmpdir(), 'dsh-axes-home-a-'))
const B = mkdtempSync(join(tmpdir(), 'dsh-axes-home-b-'))
const remote = mkdtempSync(join(tmpdir(), 'dsh-axes-sync-remote-'))
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { stdio: 'ignore' })
const repo = makeWorkRepo()
const repoGit = gitOf(repo)
const sessionJsonl = makeClaudeSession(repo)

// 记忆轴承载现场：一份真实的 CLAUDE.md 记忆文件（pushMemoryCard 经注入 scan 读它）
const memoryHome = mkdtempSync(join(tmpdir(), 'dsh-axes-mem-'))
const memoryFile = join(memoryHome, 'CLAUDE.md')
writeFileSync(memoryFile, '# Claude 用户记忆\n\n- 演示项目用 pnpm，不用 npm\n- 提交信息用中文\n', 'utf-8')

// 配置轴承载现场：假用户家里的 DSH 全家桶登记文件（createBackup 的 root 注入口）
const userHomeA = mkdtempSync(join(tmpdir(), 'dsh-axes-user-'))
mkdirSync(join(userHomeA, '.zcode'), { recursive: true })
writeFileSync(join(userHomeA, '.zcode', 'AGENTS.md'), '# 用户级指令\n\n- 回复用中文\n', 'utf-8')

const PASSPHRASE = 'four-axes-demo-passphrase'

try {
  // -------------------------------------------------------------------------
  say('fixture 就绪：A/B 双 home + 裸远端 + Claude 会话 jsonl + 工作仓 + 记忆文件')
  info(`Claude 会话：${sessionJsonl}`)
  info(`工作仓（带 origin + 未提交改动 + 未跟踪文件）：${repo}`)
  info(`裸远端（同步端点）：${remote}`)

  // -------------------------------------------------------------------------
  step = 1
  say('A 机·会话轴：readers 读 Claude Code 会话 → 蒸馏六段 → 寄存（含基线与补丁）')
  const show = await foreignSessionRead({ provider: 'claude', action: 'show' })
  must(show.ok === true, 'foreign_session_read show 成功', show.ok ? '' : String(show.error))
  if (!show.ok) throw new Error('readers 读会话失败，演示无法继续')
  must(show.summary.sessionId === sessionJsonl, 'latest 命中合成会话 jsonl')
  must(show.summary.turnCount > 0 && show.summary.firstUserMessage.includes('四轴贯通演示'), '摘要蒸馏出用户请求')
  for (const k of ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings']) {
    must(typeof show.skeleton[k] === 'string' && show.skeleton[k] !== '', `骨架六段有素材：${k}`)
  }
  const sessionPush = pushHandoff(null, {
    goal: show.skeleton.goal,
    files: show.skeleton.files,
    done: show.skeleton.done,
    remaining: show.skeleton.remaining,
    stopped: show.skeleton.stopped,
    warnings: show.skeleton.warnings,
    title: 'Claude Code 会话 · 四轴演示',
    project: 'demo-four-axes',
    cwd: repo,
  }, { dir: A })
  must(sessionPush.ok === true, '会话卡寄存成功', sessionPush.ok ? '' : String(sessionPush.error))
  if (!sessionPush.ok) throw new Error('会话卡寄存失败，演示无法继续')
  info(`会话卡：${sessionPush.id}`)

  // -------------------------------------------------------------------------
  step = 2
  say('A 机·记忆轴 + 配置轴：同走一趟流程再出两张卡（axis/payload 立约各归其位）')
  const memoryPush = pushMemoryCard({ keys: ['claude-user'], target: 'any', title: '记忆快照 · 演示' }, {
    dir: A,
    scan: () => [{
      key: 'claude-user', agent: 'Claude Code', path: memoryFile,
      exists: true, bytes: 48, mtime: new Date().toISOString(), preview: '# Claude 用户记忆',
    }],
  })
  must(memoryPush.ok === true, '记忆卡寄存成功', memoryPush.ok ? '' : String(memoryPush.error))
  if (!memoryPush.ok) throw new Error('记忆卡寄存失败，演示无法继续')
  info(`记忆卡：${memoryPush.id}`)

  const backup = createBackup(PASSPHRASE, A, userHomeA)
  must(backup.ok === true && backup.files === 1, `环境备份落 env-backup/（${backup.file}，${backup.files} 个文件）`)
  const configPush = pushConfigCard({ passphrase: PASSPHRASE }, { dir: A })
  must(configPush.ok === true, '配置卡寄存成功（清单+指针，口令未进卡）', configPush.ok ? '' : String(configPush.error))
  if (!configPush.ok) throw new Error('配置卡寄存失败，演示无法继续')
  info(`配置卡：${configPush.id}（指针 → env-backup/${backup.file}）`)

  // 出卡后立刻盘卡面立约标记：session / memory / config 三轴 + payload 两态
  const readExtras = (dir, id) => parseCard(readFileSync(join(dir, 'pending', `${id}.md`), 'utf-8')).extras
  const sessionExtras = readExtras(A, sessionPush.id)
  const memoryExtras = readExtras(A, memoryPush.id)
  const configExtras = readExtras(A, configPush.id)
  must(sessionExtras['axis'] === 'session', "会话卡 axis='session'")
  must(memoryExtras['axis'] === 'memory' && memoryExtras['payload'] === 'files', "记忆卡 axis='memory' + payload='files'")
  must(configExtras['axis'] === 'config' && configExtras['payload'] === 'manifest', "配置卡 axis='config' + payload='manifest'")
  must(configExtras['config']?.backupFile === backup.file, '配置卡 extras.config 指向 env-backup 密文包')

  // -------------------------------------------------------------------------
  step = 3
  say('A 机·syncNow：三张卡 + 密文包经裸远端推走')
  const setupA = await syncSetup(remote, A)
  must(setupA.ok === true, 'A 机同步 setup 成功', setupA.ok ? '' : String(setupA.error))
  const pushA = await syncNow(A)
  must(pushA.ok === true, 'A 机 syncNow 推送成功', pushA.ok ? '' : String(pushA.error))

  // -------------------------------------------------------------------------
  step = 4
  say('B 机·setup + now：拉到三张卡')
  const setupB = await syncSetup(remote, B)
  must(setupB.ok === true, 'B 机同步 setup 成功（信任域随目录走：签名密钥同车）', setupB.ok ? '' : String(setupB.error))
  const pullB = await syncNow(B)
  must(pullB.ok === true, 'B 机 syncNow 拉取成功', pullB.ok ? '' : String(pullB.error))
  const listB = inboxList({ dir: B })
  must(listB.ok === true && listB.cards.length === 3, `B 机收件箱待取件 ${listB.cards.length}/3 张`)
  must(typeof listB.cards.find((c) => c.id === sessionPush.id) === 'object', 'B 机看到会话卡')
  must(typeof listB.cards.find((c) => c.id === memoryPush.id) === 'object', 'B 机看到记忆卡')
  must(typeof listB.cards.find((c) => c.id === configPush.id) === 'object', 'B 机看到配置卡')

  // -------------------------------------------------------------------------
  step = 5
  say('B 机·逐轴取件断言：六段在、axis/payload 在、baseline 在、memory 建议段在、config 清单在')

  // —— 会话轴：六段 + 基线 + 补丁（上下文轴随行） ——
  const loadSession = inboxLoad(sessionPush.id, { dir: B })
  must(loadSession.ok === true, '会话卡取件成功', loadSession.ok ? '' : String(loadSession.error))
  if (!loadSession.ok) throw new Error('会话卡取件失败，演示无法继续')
  must(loadSession.axis === 'session', "取件面 axis='session'")
  for (const heading of ['## 目标', '## 涉及文件', '## 做到哪', '## 还差什么', '## 停在哪', '## 读者警告']) {
    must(loadSession.text.includes(heading), `六段在卡上：${heading}`)
  }
  must(loadSession.baseline?.head === repoGit(['rev-parse', 'HEAD'])
    && loadSession.baseline?.branch === 'main'
    && loadSession.baseline?.remote === repoGit(['remote', 'get-url', 'origin']),
    'baseline 三元组 = 寄存现场实测（origin/HEAD/main）', JSON.stringify(loadSession.baseline))
  must(typeof loadSession.patchPath === 'string' && existsSync(loadSession.patchPath), '未提交改动补丁随卡到达（git apply 可复原）')
  must(loadSession.sig === 'ok', '信封签名校验通过（A 机的密钥已随同步到达 B 机）')

  // —— 记忆轴：payload=files + 建议段正文 + 吸收回执 ——
  const loadMemory = inboxLoad(memoryPush.id, { dir: B })
  must(loadMemory.ok === true && loadMemory.axis === 'memory', "记忆卡取件成功且 axis='memory'")
  if (!loadMemory.ok) throw new Error('记忆卡取件失败，演示无法继续')
  must(loadMemory.text.includes('## 建议加载') && loadMemory.text.includes('演示项目用 pnpm'), 'memory 建议段随卡到达（正文在场）')
  const memoryRendered = renderInbox({}, loadMemory).map((b) => b.text).join('\n')
  must(memoryRendered.includes('记忆已随卡注入'), '取件渲染含「记忆已随卡注入」吸收提示')
  must(readFileSync(join(B, 'lifecycle.jsonl'), 'utf-8').includes('"reason":"memory-absorbed"'), '吸收回执进生命周期账本（memory-absorbed）')

  // —— 配置轴：payload=manifest + 清单 + 密文包本体随同步到达 ——
  const loadConfig = inboxLoad(configPush.id, { dir: B })
  must(loadConfig.ok === true && loadConfig.axis === 'config', "配置卡取件成功且 axis='config'")
  if (!loadConfig.ok) throw new Error('配置卡取件失败，演示无法继续')
  must(loadConfig.text.includes('sha256=') && loadConfig.text.includes('.zcode/AGENTS.md'), 'config 清单在卡上（path｜category｜sha256）')
  must(existsSync(join(B, 'env-backup', backup.file)), '密文包本体随同步到达 B 机 env-backup/')

  // -------------------------------------------------------------------------
  step = 6
  say('消费即弃跨机收敛：B 取件后推走消费记录，A 再 syncNow → A 侧 pending 清空（tombstone 不重放）')
  const pushB2 = await syncNow(B)
  must(pushB2.ok === true, 'B 机二次 syncNow（推走 archived tombstone）', pushB2.ok ? '' : String(pushB2.error))
  const pullA2 = await syncNow(A)
  must(pullA2.ok === true, 'A 机二次 syncNow 成功')
  must(inboxList({ dir: A }).cards.length === 0, 'A 机收件箱已清空——已消费的卡不在另一台机器重放')

  // -------------------------------------------------------------------------
  console.log('\n════════════════════════════════════════════')
  console.log('✅ 四轴贯通：会话 / 上下文 / 记忆 / 配置，一根链全绿。')
  console.log(`   会话卡 ${sessionPush.id}（六段 + baseline + 补丁）`)
  console.log(`   记忆卡 ${memoryPush.id}（payload=files + 建议段 + 吸收回执）`)
  console.log(`   配置卡 ${configPush.id}（payload=manifest + 清单 + 密文包指针）`)
  console.log('════════════════════════════════════════════')
  process.exitCode = 0
} catch (e) {
  console.error(`\n🛑 四轴贯通演示失败：${e instanceof Error ? e.message : String(e)}`)
  console.error('   （断言不过即非零退出——演示结果不造假）')
  process.exitCode = 1
} finally {
  rmGit(A)
  rmGit(B)
  rmGit(remote)
  rmGit(repo)
  rmSync(CLAUDE_ROOT, { recursive: true, force: true })
  rmSync(memoryHome, { recursive: true, force: true })
  rmSync(userHomeA, { recursive: true, force: true })
}
