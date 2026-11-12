/**
 * 换机上下文同步（0.2.0）：HANDOFF_HOME 的卡（pending/archived + 信封侧车）与
 * 签名密钥经 git 仓库端点跨机同步。
 *
 * 设计三原则（迭代计划 0.2.0）：
 * 1. git-native、零存储凭据——传输端点 = 用户配置的 git 仓库；凭据完全交给系统 git
 *    （credential helper / ssh），插件不存任何密钥；remote URL 保存时拒绝 userinfo
 *    形态（user:pass@），展示只出红折形态。secretscan 对 URL 内嵌凭据零覆盖，从入口堵死。
 * 2. HANDOFF_HOME 即工作树——启用同步 = home 内 git init（已仓则收编）+ 设 remote；
 *    同步范围 = pending/ + archived/（罩住 <id>.envelope.json）+ .signing-key.json +
 *    sync.json；.gitignore 排除 lifecycle.jsonl / relay/ / config.json / *.claim
 *    （机器本地记录，避免 append-only JSONL 两机同写必冲突）。
 * 3. 消费即弃跨机 = archived/ 当 tombstone——A 机取件 push，B 机 pull 后 pending
 *    消失且 archived/ 出现 → 不重放；合并冲突 → abort + 诚实报错，本地文件不动。
 *
 * 安全边界（THREAT-MODEL T6 修订）：插件唯一的网络出口 = 本模块经系统 git 与用户
 * 显式配置的 remote 通信；GIT_TERMINAL_PROMPT=0 + 超时（默认 30s，可注入）保证
 * 永不挂死在凭据交互或不可达网络上。仓库本地强制 core.autocrlf=false——卡字节是
 * 信封签名面（cardSha256），checkout 行尾漂移会让全部卡 tampered（见 signing.ts）。
 *
 * state 路径零网络：buildState 读 sync.json + sync-state.json（上次同步的
 * ahead/behind/lastSyncAt/lastError，动作完成后写回），30s 轮询不碰任何网络。
 */
import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '@agent-handoff/core'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

/** git 网络命令超时：push/pull 可能慢，但绝不挂死（脚本侧先例 15s，网络面放宽） */
export const SYNC_GIT_TIMEOUT_MS = 30_000

/** 同步范围：卡的宇宙 + 签名密钥 + 同步配置（远端 URL 随目录走）+ 环境备份包（append-only，无合并冲突） */
const SYNC_PATHS = ['pending', 'archived', '.signing-key.json', 'sync.json', 'env-backup'] as const

/** GITIGNORE：机器本地记录不入库（生命周期日志/取件溯源/插件开关各自为本机事实） */
const SYNC_GITIGNORE = [
  '# dsh-takeover 换机同步：机器本地记录不入库',
  'lifecycle.jsonl',
  'relay/',
  'config.json',
  'pending/*.claim',
  '*.tmp',
  'sync-state.json',
].join('\n')

// ---------- 配置（sync.json，独立于 config.json：loadSwitches 只认开关字段，会丢弃未知键） ----------

export interface SyncConfig {
  enabled: boolean
  /** 用户配置的 git 仓库地址（https / ssh / git@host:path / 本地路径），永不存凭据 */
  remote: string
}

/** sync.json 路径（HANDOFF_HOME 内，随同步分发——B 机启用时可直接采纳同地址） */
export function syncConfigPath(dir?: string): string {
  return join(resolveHome(dir), 'sync.json')
}

/** 读同步配置：文件缺失/损坏 fail-open 回未启用（同 loadSwitches 纪律），损坏必 console.warn */
export function loadSyncConfig(dir?: string): SyncConfig {
  const p = syncConfigPath(dir)
  if (!existsSync(p)) return { enabled: false, remote: '' }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<SyncConfig>
    return { enabled: raw.enabled === true, remote: typeof raw.remote === 'string' ? raw.remote : '' }
  } catch (e) {
    console.warn(`[dsh-takeover] sync.json 损坏，按未配置处理：${e instanceof Error ? e.message : String(e)}`)
    return { enabled: false, remote: '' }
  }
}

/** 写同步配置：tmp + rename 原子替换（saveSwitches 同模板）；写入前校验地址 */
export function saveSyncConfig(cfg: SyncConfig, dir?: string): void {
  const remote = cfg.remote.trim()
  if (cfg.enabled && remote === '') throw new Error('启用同步前必须先填仓库地址')
  if (remote !== '') validateRemoteUrl(remote)
  const target = syncConfigPath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ enabled: cfg.enabled, remote }, null, 2) + '\n', 'utf-8')
    renameSync(tmp, target)
  } catch (e) {
    try { rmSync(tmp, { force: true }) } catch { /* 尽力清临时件 */ }
    throw e instanceof Error ? e : new Error(String(e))
  }
}

/**
 * 仓库地址校验：拒绝 userinfo 形态（`user:pass@`）——secretscan 对 URL 内嵌凭据
 * 零覆盖，插件也永不存储凭据，凭据交给系统 git credential helper / ssh agent。
 * 允许：https://、ssh://、git://、file://、git@host:path（scp 形态）、本地路径。
 * 返回 trim 后的地址；不合法抛中文错。
 */
export function validateRemoteUrl(url: string): string {
  const u = url.trim()
  if (u === '') throw new Error('仓库地址不能为空')
  // scp 形态（git@host:path）：有 @ 但无 scheme——正常 ssh 形态放行；带「user:pass@」前段则拒绝
  if (/^[A-Za-z0-9._~-]+:[^@/\\]+@[A-Za-z0-9._~-]+:/.test(u)) {
    throw new Error('仓库地址不得内嵌凭据（user:pass@ 形态）——请改用 ssh key 或 credential helper')
  }
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(u)
  if (m !== null) {
    const scheme = m[1]!.toLowerCase()
    if (scheme !== 'https' && scheme !== 'ssh' && scheme !== 'git' && scheme !== 'file') {
      throw new Error(`不支持的仓库协议：${scheme}（支持 https / ssh / git / 本地路径）`)
    }
    const rest = u.slice(m[0].length)
    // userinfo 段带冒号即密码形态（user@host 是正常 ssh 形态，无冒号放行）
    if (/^[^/@:]+:[^@/]*@/.test(rest)) {
      throw new Error('仓库地址不得内嵌凭据（user:pass@ 形态）——请改用 ssh key 或 credential helper')
    }
    return u
  }
  // 其余按本地路径处理（裸仓库目录）
  return u
}

/** 红折展示：userinfo 段打码（防御性——保存时已拒绝，展示仍再折一次） */
export function redactRemote(url: string): string {
  return url
    .replace(/^([a-z]+):\/\/[^/@]+:[^@/]+@/i, '$1://***@')
    .replace(/^([A-Za-z0-9._~-]+):[^@/\\]+@/, '$1:***@')
}

// ---------- git 执行（异步 + 超时 + 禁交互） ----------

export interface SyncOutcome {
  ok: boolean
  action: string
  /** 动作后状态摘要（供面板/工具直显） */
  detail?: string
  ahead?: number
  behind?: number
  error?: string
}

/** git 命令统一入口：参数数组不走 shell；禁交互（GIT_TERMINAL_PROMPT=0）；超时硬杀 */
async function git(args: string[], opts: { cwd: string; timeoutMs?: number }): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? SYNC_GIT_TIMEOUT_MS
  try {
    const r = await execFile(
      'git',
      // core.fsmonitor=false：外来仓库的 fsmonitor 钩子是命令执行面（core git() 同款防线）；
      // protocol.file.allow=always：本地裸仓库端点（同机两目录换机）在新版 git 默认被禁——
      // 用户显式配置的本地路径放行
      ['-C', opts.cwd, '-c', 'core.fsmonitor=false', '-c', 'protocol.file.allow=always',
        '-c', 'user.name=dsh-takeover', '-c', 'user.email=dsh-takeover@local', ...args],
      { encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    )
    return r.stdout
  } catch (e) {
    const err = e as { message?: string; killed?: boolean; stderr?: string }
    if (err.killed === true) throw new Error(`git ${String(args[0])} 超时（${(timeoutMs / 1000).toFixed(1)}s）——网络不可达或凭据交互被禁`)
    const detail = (err.stderr ?? err.message ?? String(e)).trim()
    throw new Error(`git ${String(args[0])} 失败：${detail.slice(0, 400)}`)
  }
}

function homeOf(dir?: string): string {
  return resolveHome(dir)
}

/** 确保 home 是仓库（已仓收编）+ 强制行尾配置 + .gitignore + remote 对齐 */
async function ensureRepo(cfg: SyncConfig, dir?: string, timeoutMs?: number): Promise<string> {
  const home = homeOf(dir)
  if (!existsSync(join(home, '.git'))) {
    mkdirSync(home, { recursive: true })
    await git(['init', '-b', 'main'], { cwd: home, timeoutMs })
  }
  // 行尾钉死：卡字节是信封签名面（cardSha256），checkout 行尾漂移 = 全部 tampered。
  // 仓库本地覆盖全局 autocrlf（Windows git 默认 true 会绞碎字节）。
  await git(['config', 'core.autocrlf', 'false'], { cwd: home, timeoutMs })
  await git(['config', 'core.eol', 'lf'], { cwd: home, timeoutMs })
  writeFileSync(join(home, '.gitignore'), SYNC_GITIGNORE + '\n', 'utf-8')
  const remotes = await git(['remote'], { cwd: home, timeoutMs })
  if (remotes.trim().split('\n').map((s) => s.trim()).includes('origin')) {
    await git(['remote', 'set-url', 'origin', cfg.remote], { cwd: home, timeoutMs })
  } else {
    await git(['remote', 'add', 'origin', cfg.remote], { cwd: home, timeoutMs })
  }
  return home
}

/** 提交同步范围内的本地变化（无变化不提交；不存在的路径自动跳过） */
async function commitLocal(home: string, timeoutMs?: number): Promise<boolean> {
  const present = SYNC_PATHS.filter((p) => existsSync(join(home, p)))
  await git(['add', '--', '.gitignore', ...present], { cwd: home, timeoutMs })
  const staged = await git(['diff', '--cached', '--name-only'], { cwd: home, timeoutMs })
  if (staged.trim() === '') return false
  await git(['commit', '-m', 'dsh-takeover 换机同步：收发件箱快照'], { cwd: home, timeoutMs })
  return true
}

/** fetch 远端并计数（远端空仓回 null；调用契约：本地 main 已存在——commitLocal 先行） */
async function fetchOrigin(home: string, timeoutMs?: number): Promise<{ ahead: number; behind: number } | null> {
  try {
    await git(['fetch', 'origin'], { cwd: home, timeoutMs })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/couldn't find remote ref|Repository is empty|does not appear to be a git repository|No such file or directory/i.test(msg)) return null
    throw e
  }
  const remoteExists = await git(['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: home, timeoutMs }).then(() => true, () => false)
  if (!remoteExists) return null
  const count = (range: string): Promise<number> =>
    git(['rev-list', '--count', range], { cwd: home, timeoutMs }).then((s) => Number(s.trim()) || 0, () => 0)
  return { ahead: await count('origin/main..main'), behind: await count('main..origin/main') }
}

/** 合并远端：冲突即 abort + 中文诚实报错（本地文件不动）。契约：commitLocal 已先行。 */
async function mergeRemote(home: string, timeoutMs?: number): Promise<'merged' | 'none'> {
  const remoteExists = await git(['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd: home, timeoutMs }).then(() => true, () => false)
  if (!remoteExists) return 'none'
  const behind = await git(['rev-list', '--count', 'main..origin/main'], { cwd: home, timeoutMs }).then((s) => Number(s.trim()) || 0, () => 0)
  if (behind === 0) return 'none'
  try {
    // allow-unrelated-histories：新机器加入已有远端时，本机初始提交与远端历史无共同
    // 祖先——这是换机的标准入场姿势，必须能合；重叠文件不同内容仍走冲突诚实报错
    await git(['merge', '--no-edit', '--allow-unrelated-histories', 'origin/main'], { cwd: home, timeoutMs })
  } catch (e) {
    await git(['merge', '--abort'], { cwd: home, timeoutMs }).catch(() => { /* 尽力回滚到合并前 */ })
    throw new Error(`同步合并冲突（两侧都改过同一批文件）——已中止合并，本地文件原样保留。处理：在本机确认要保留的版本后重新寄存，或换一个全新仓库地址。git 原因：${e instanceof Error ? e.message : String(e)}`.slice(0, 400))
  }
  return 'merged'
}

// ---------- 状态文件（state 路径的数据源，零网络） ----------

interface SyncStateFile {
  at?: string
  ahead?: number
  behind?: number
  ok?: boolean
  error?: string
}

function readSyncStateFile(home: string): SyncStateFile {
  try {
    return JSON.parse(readFileSync(join(home, 'sync-state.json'), 'utf-8')) as SyncStateFile
  } catch {
    return {}
  }
}

function writeSyncState(home: string, patch: Partial<SyncStateFile>): void {
  const next = { ...readSyncStateFile(home), ...patch, at: new Date().toISOString() }
  const target = join(home, 'sync-state.json')
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
    renameSync(tmp, target)
  } catch {
    try { rmSync(tmp, { force: true }) } catch { /* 尽力清临时件 */ }
  }
}

/** 动作统一收尾：失败也如实写状态，面板才能「一眼知道当前什么状态需要干嘛」 */
async function runAction(action: string, dir: string | undefined, opts: { timeoutMs?: number } | undefined,
  body: (home: string, timeoutMs?: number) => Promise<{ detail: string; ahead: number; behind: number }>): Promise<SyncOutcome> {
  const cfg = loadSyncConfig(dir)
  if (!cfg.enabled || cfg.remote.trim() === '') {
    return { ok: false, action, error: '换机同步未启用：先在设置卡「换机」页填仓库地址并启用' }
  }
  const home = homeOf(dir)
  try {
    await ensureRepo(cfg, dir, opts?.timeoutMs)
    await commitLocal(home, opts?.timeoutMs)
    const result = await body(home, opts?.timeoutMs)
    writeSyncState(home, { ahead: result.ahead, behind: result.behind, ok: true, error: undefined })
    return { ok: true, action, detail: result.detail, ahead: result.ahead, behind: result.behind }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    writeSyncState(home, { ok: false, error })
    return { ok: false, action, error }
  }
}

/** 启用同步：init/收编 + remote + 本地先提交 + 远端非空先合并再推（远端空仓直接首推） */
export async function syncSetup(url: string, dir?: string, opts?: { timeoutMs?: number }): Promise<SyncOutcome> {
  const remote = validateRemoteUrl(url)
  saveSyncConfig({ enabled: true, remote }, dir)
  return runAction('setup', dir, opts, async (home, timeoutMs) => {
    const counts = await fetchOrigin(home, timeoutMs)
    await mergeRemote(home, timeoutMs)
    await git(['push', '-u', 'origin', 'main'], { cwd: home, timeoutMs })
    const after = await fetchOrigin(home, timeoutMs)
    const ahead = after?.ahead ?? 0
    const behind = after?.behind ?? 0
    const detail = counts === null
      ? `已启用换机同步（${redactRemote(remote)}）：远端空仓，本地已完成首推`
      : `已启用换机同步（${redactRemote(remote)}）：已与远端对齐并推送`
    return { detail, ahead, behind }
  })
}

/** pull：本地先提交 → fetch → 合并（冲突 abort 诚实报错） */
export async function syncPull(dir?: string, opts?: { timeoutMs?: number }): Promise<SyncOutcome> {
  return runAction('pull', dir, opts, async (home, timeoutMs) => {
    const counts = await fetchOrigin(home, timeoutMs)
    if (counts === null) return { detail: '远端为空仓库：本地已是最新', ahead: 0, behind: 0 }
    const merged = await mergeRemote(home, timeoutMs)
    const after = await fetchOrigin(home, timeoutMs)
    const ahead = after?.ahead ?? 0
    const behind = after?.behind ?? 0
    return { detail: merged === 'merged' ? `已拉取远端 ${counts.behind} 个提交` : '已与远端对齐', ahead, behind }
  })
}

/** push：本地提交 + 推送 */
export async function syncPush(dir?: string, opts?: { timeoutMs?: number }): Promise<SyncOutcome> {
  return runAction('push', dir, opts, async (home, timeoutMs) => {
    const committed = await commitLocal(home, timeoutMs)
    await git(['push', 'origin', 'main'], { cwd: home, timeoutMs })
    const after = await fetchOrigin(home, timeoutMs)
    const ahead = after?.ahead ?? 0
    const behind = after?.behind ?? 0
    return { detail: committed ? '已提交并推送' : '无本地变化，已推送确认', ahead, behind }
  })
}

/** 立即同步 = pull（拿别人的）→ push（给别人的），一步到位 */
export async function syncNow(dir?: string, opts?: { timeoutMs?: number }): Promise<SyncOutcome> {
  const pulled = await syncPull(dir, opts)
  if (!pulled.ok) return pulled
  return syncPush(dir, opts)
}

// ---------- 状态（零网络：sync.json + sync-state.json + 本地脏计数） ----------

/** 同步状态（type 别名：客户端与工具面都要把它当 JSON 值传递，interface 缺隐式索引签名会挂 defineTool） */
export type SyncStatus = {
  enabled: true
  /** 红折后的仓库地址 */
  remote: string
  /** 待推提交数（上次同步记录） */
  ahead: number
  /** 待拉提交数（上次同步记录） */
  behind: number
  lastSyncAt?: string
  lastError?: string
  /** 同步范围内本地未提交文件数（现算，git status，零网络） */
  dirtyFiles: number
  /** home 是否已是仓库（未 init 前无从谈脏计数） */
  repoReady: boolean
}

/** 组装同步状态（buildState 调用；未启用 → undefined，客户端整个块不渲染） */
export function syncStatusOf(dir?: string): SyncStatus | undefined {
  const cfg = loadSyncConfig(dir)
  if (!cfg.enabled || cfg.remote.trim() === '') return undefined
  const home = homeOf(dir)
  const repoReady = existsSync(join(home, '.git'))
  const stateFile = readSyncStateFile(home)
  let dirtyFiles = 0
  if (repoReady) {
    try {
      const out = execFileSync('git',
        ['-C', home, '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--', ...SYNC_PATHS],
        { encoding: 'utf-8', timeout: 5_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      dirtyFiles = out.trim() === '' ? 0 : out.trim().split('\n').length
    } catch { /* git 不可用/非仓库：按 0，状态由 repoReady 说明 */ }
  }
  return {
    enabled: true,
    remote: redactRemote(cfg.remote),
    ahead: stateFile.ahead ?? 0,
    behind: stateFile.behind ?? 0,
    lastSyncAt: stateFile.at,
    lastError: stateFile.error,
    dirtyFiles,
    repoReady,
  }
}

/** 工具侧状态行（zh 直出，与其他工具错误文案同语种纪律；面板侧用词典组自己的行） */
export function syncStatusLine(st: SyncStatus): string {
  const parts: string[] = [`远端 ${st.remote}`]
  if (st.behind > 0) parts.push(`落后 ${st.behind} 个提交（执行 now 拉取）`)
  if (st.ahead > 0) parts.push(`领先 ${st.ahead} 个提交（待推送）`)
  if (st.dirtyFiles > 0) parts.push(`${st.dirtyFiles} 个本地文件待提交`)
  if (st.lastError !== undefined) parts.push(`上次同步出错：${st.lastError}`)
  if (st.lastSyncAt !== undefined) parts.push(`上次同步 ${st.lastSyncAt.slice(0, 16).replace('T', ' ')}`)
  return parts.join(' · ')
}
