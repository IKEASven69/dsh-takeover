/**
 * 环境备份/恢复（0.2.0 wave2）：DSH 全家桶（settings/插件登记/会话/skills/工作区登记）
 * 打包成单个加密文件，随换机同步跨机，新机器解密 → dry-run diff → 确认落盘 → 可回滚。
 *
 * 安全三原则（THREAT-MODEL T7）：
 * 1. 密钥类文件（.credentials.yaml / typesafe-key / zcode 凭据）只存在于加密包内——
 *    API 没有明文备份路径，加密不可跳过；包体落 <HANDOFF_HOME>/env-backup/（随卡同步）。
 * 2. 口令派生（scrypt）+ AES-256-GCM 认证加密：口令永不落盘、永不进日志；错口令 =
 *    GCM 校验失败 = 诚实报错，不吐半个字节。
 * 3. 恢复是「写 ~/.handoff 之外」的破例动作：必须先 dry-run 出 diff（新建/覆盖/相同），
 *    再显式确认才落盘；落盘前把被覆盖原物快照进 checkpoint，回滚一键还原。
 *    路径全走相对 user home 的白名单清单 + 穿越校验（..、绝对路径、盘符一律拒收）。
 *
 * 容器格式（纯 node，无子进程——没有 tar 就没有 tar-slip 面）：
 *   MAGIC 'DSHENV1' | salt(16) | iv(12) | tag(16) |
 *   密文 = manifestLen(u32 LE) + manifest JSON（{files:[{path,bytes,sha256,category}],...}）+ blobs
 *
 * 升级保险快照（0.26.1）：宿主版本变化 → 自动打 auto-upgrade- 标签快照（只留最近一份，
 * 手动备份不动；口令由调用方既有机制注入，无口令即 skip + 原因，绝不新增交互、绝不误打）。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, dirname } from 'node:path'
import { resolveHome } from '@agent-handoff/core'
import { scanSecrets } from './secretscan.ts'

const MAGIC = Buffer.from('DSHENV1', 'ascii')
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
/** scrypt N=2^14：内存 ~16MB，交互式口令够用且不拖垮面板 */
const SCRYPT_N = 16384

// ---------- 备份范围（2026-11 全家桶磁盘测绘定稿；相对 user home，正斜杠） ----------

interface ScopeRule {
  category: string
  /** 相对 user home 的路径或通配（段内 * 通配；尾部 /** 整子树） */
  pattern: string
  /** 凭据类：只存在于加密包内的文件 */
  secret?: boolean
}

/** 测绘结论：node_modules/缓存/日志/热 sqlite 全部排除（可重植），只备不可再生的登记与数据 */
export const SCOPE: readonly ScopeRule[] = [
  { category: 'dsh-core', pattern: '.dsh/.credentials.yaml', secret: true },
  { category: 'dsh-core', pattern: '.dsh/typesafe-key', secret: true },
  { category: 'dsh-core', pattern: '.dsh/settings.yaml.imported' },
  { category: 'dsh-core', pattern: '.dsh/mystery-root.json' },
  { category: 'dsh-core', pattern: '.dsh/dsh-opencli-state.json' },
  // profile 登记五件套（node_modules 由 pnpm-lock 重植，~2.6G 不备）
  { category: 'dsh-profile', pattern: '.dsh/profiles/*/cordis.yml' },
  { category: 'dsh-profile', pattern: '.dsh/profiles/*/cordis.patch.yml' },
  { category: 'dsh-profile', pattern: '.dsh/profiles/*/package.json' },
  { category: 'dsh-profile', pattern: '.dsh/profiles/*/pnpm-lock.yaml' },
  { category: 'dsh-profile', pattern: '.dsh/profiles/*/pnpm-workspace.yaml' },
  // 会话与投影缓存（不可再生，zstd 已压缩）
  { category: 'dsh-sessions', pattern: '.dsh/sessions/**' },
  { category: 'dsh-sessions', pattern: '.dsh/storages/**' },
  // 智能中枢登记（hf-cache / store-recovery 排除）
  { category: 'dsh-registries', pattern: '.dsh/dsh-intelhub/workspaces.json' },
  { category: 'dsh-registries', pattern: '.dsh/dsh-intelhub/registry.json' },
  { category: 'dsh-registries', pattern: '.dsh/dsh-intelhub/schedules.json' },
  { category: 'dsh-registries', pattern: '.dsh/dsh-zvec-kb/registry.json' },
  // 用户全局 skills（宿主内置/缓存 skills 不在 ~/.agents，天然不进来）
  { category: 'agents-skills', pattern: '.agents/skills/**' },
  { category: 'agents-skills', pattern: '.agents/.skill-lock.json' },
  // MCP servers 事实标准配置（{ mcpServers: … } 形态）——配置写回（action=inject）的源条目
  { category: 'mcp-config', pattern: '.mcp.json' },
  // ZCode 宿主用户层（db/缓存/工件全排除；凭据类只进加密包）
  { category: 'zcode-core', pattern: '.zcode/AGENTS.md' },
  { category: 'zcode-core', pattern: '.zcode/cli/AGENTS.md' },
  { category: 'zcode-core', pattern: '.zcode/cli/config.json' },
  { category: 'zcode-core', pattern: '.zcode/cli/plugins/known_marketplaces.json' },
  { category: 'zcode-core', pattern: '.zcode/v2/setting.json' },
  { category: 'zcode-core', pattern: '.zcode/v2/config.json' },
  { category: 'zcode-core', pattern: '.zcode/v2/provider_config.json' },
  { category: 'zcode-secret', pattern: '.zcode/v2/credentials.json', secret: true },
]

/** 收集/恢复的目录黑名单（防未来 scope 改动把可重植巨物卷进来；.state = 技能运行时状态，跨机恢复会拿 A 机状态覆盖 B 机） */
const PRUNE_DIRS = new Set(['node_modules', '.git', 'hf-cache', 'logs', 'crash', 'cache', '.state'])

/** 相对路径合法性：正斜杠、无 .. 段、非绝对、无盘符（恢复路径的穿越硬闸） */
export function validateRelPath(p: string): string {
  const norm = p.split('\\').join('/')
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) throw new Error(`非法备份路径（绝对路径）：${p}`)
  const segs = norm.split('/').filter((s) => s !== '')
  if (segs.length === 0) throw new Error('非法备份路径（空路径）')
  if (segs.some((s) => s === '..')) throw new Error(`非法备份路径（含 .. 穿越）：${p}`)
  return segs.join('/')
}

/** 段式 glob：* 段内通配；尾部 /** 吃整子树；其余字面 */
function matchGlob(rel: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3)
    return rel === prefix || rel.startsWith(prefix + '/')
  }
  const ps = pattern.split('/')
  const xs = rel.split('/')
  if (ps.length !== xs.length) return false
  return ps.every((seg, i) => seg === '*' || seg === xs[i])
}

function walkCollect(root: string, rel: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(join(root, rel))
  } catch { return }
  for (const e of entries) {
    if (PRUNE_DIRS.has(e)) continue
    const child = `${rel}/${e}`
    let st
    try {
      st = statSync(join(root, child))
    } catch { continue }
    if (st.isDirectory()) walkCollect(root, child, out)
    else out.push(child)
  }
}

export interface ScopeFile {
  path: string
  category: string
  secret: boolean
  bytes: number
}

/** 收集备份清单：scope 命中且磁盘上真实存在的文件（缺失容错——没有就跳过，不算错） */
export function collectScopeFiles(root?: string): ScopeFile[] {
  const userHome = root ?? homedir()
  const onDisk = new Set<string>()
  for (const rule of SCOPE) {
    if (rule.pattern.endsWith('/**')) {
      const base = rule.pattern.slice(0, -3)
      if (existsSync(join(userHome, base))) {
        const out: string[] = []
        walkCollect(userHome, base, out)
        for (const p of out) onDisk.add(p)
      }
    } else if (rule.pattern.includes('*')) {
      // 段内 * 通配（如 .dsh/profiles/*/cordis.yml）：枚举星段前缀目录，
      // 星段吃任意子项名，再拼回星段之后的字面后缀
      const segs = rule.pattern.split('/')
      const starIdx = segs.findIndex((seg) => seg.includes('*'))
      const prefix = segs.slice(0, starIdx).join('/')
      const suffix = segs.slice(starIdx + 1).join('/')
      let entries: string[]
      try {
        entries = readdirSync(join(userHome, prefix))
      } catch { continue }
      for (const e of entries) {
        const candidate = suffix === '' ? `${prefix}/${e}` : `${prefix}/${e}/${suffix}`
        try {
          if (!statSync(join(userHome, candidate)).isFile()) continue
        } catch { continue }
        if (matchGlob(candidate, rule.pattern)) onDisk.add(candidate)
      }
    } else if (existsSync(join(userHome, rule.pattern))) {
      onDisk.add(rule.pattern)
    }
  }
  const files: ScopeFile[] = []
  for (const rel of onDisk) {
    const rule = SCOPE.find((r) => matchGlob(rel, r.pattern))
    if (rule === undefined) continue // 黑名单目录产物（不该发生，防御）
    let bytes = 0
    try {
      bytes = statSync(join(userHome, rel)).size
    } catch { continue }
    files.push({ path: rel, category: rule.category, secret: rule.secret === true, bytes })
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

// ---------- 容器：打包/解包（纯 node） ----------

interface Manifest {
  createdAt: string
  host: string
  secretCount: number
  secretHits: number
  files: Array<{ path: string; bytes: number; sha256: string; category: string }>
}

interface LoadedManifest extends Manifest {
  body: Buffer
  manifestLen: number
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: SCRYPT_N, r: 8, maxmem: 256 * 1024 * 1024 })
}

/** 打包 + 加密 → 单个 .dshenv 缓冲（口令永不落盘） */
function packEncrypted(files: ScopeFile[], root: string, passphrase: string): { buf: Buffer; manifest: Manifest } {
  const entries: Manifest['files'] = []
  const blobs: Buffer[] = []
  let secretCount = 0
  let secretHits = 0
  for (const f of files) {
    const raw = readFileSync(join(root, f.path))
    const sha = createHash('sha256').update(raw).digest('hex')
    entries.push({ path: f.path, bytes: raw.length, sha256: sha, category: f.category })
    if (f.secret) secretCount += 1
    // 密钥闸：小文本配置过 secretscan（凭据类文件本身按 SECRET 严管，不进扫描口径）
    if (!f.secret && raw.length <= 2 * 1024 * 1024) {
      try {
        secretHits += scanSecrets({ config: raw.toString('utf-8') }).length
      } catch { /* 扫描失败不挡备份，计数如实为 0 */ }
    }
    blobs.push(raw)
  }
  const manifest: Manifest = { createdAt: new Date().toISOString(), host: hostname(), secretCount, secretHits, files: entries }
  const manifestJson = Buffer.from(JSON.stringify(manifest), 'utf-8')
  const body = Buffer.concat([Buffer.alloc(4), manifestJson, ...blobs])
  body.writeUInt32LE(manifestJson.length, 0)
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
  const enc = Buffer.concat([cipher.update(body), cipher.final()])
  const tag = cipher.getAuthTag()
  return { buf: Buffer.concat([MAGIC, salt, iv, tag, enc]), manifest }
}

/** 解包：错口令 = GCM 认证失败 = 诚实报错，不吐半个字节 */
function unpackEncrypted(buf: Buffer, passphrase: string): LoadedManifest {
  if (buf.length < MAGIC.length + SALT_LEN + IV_LEN + TAG_LEN + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('不是 dsh-takeover 环境备份包（魔数不符）')
  }
  let off = MAGIC.length
  const salt = buf.subarray(off, off + SALT_LEN); off += SALT_LEN
  const iv = buf.subarray(off, off + IV_LEN); off += IV_LEN
  const tag = buf.subarray(off, off + TAG_LEN); off += TAG_LEN
  let body: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)
    decipher.setAuthTag(tag)
    body = Buffer.concat([decipher.update(buf.subarray(off)), decipher.final()])
  } catch {
    throw new Error('解密失败：口令不对或包已损坏（GCM 认证未通过，未泄露任何内容）')
  }
  const manifestLen = body.readUInt32LE(0)
  const manifest = JSON.parse(body.subarray(4, 4 + manifestLen).toString('utf-8')) as Manifest
  return { ...manifest, body, manifestLen }
}

function blobAt(m: LoadedManifest, i: number): Buffer {
  let off = 4 + m.manifestLen
  for (let k = 0; k < i; k++) off += m.files[k]!.bytes
  return m.body.subarray(off, off + m.files[i]!.bytes)
}

// ---------- 目录与清单 ----------

export function envBackupDir(dir?: string): string {
  return join(resolveHome(dir), 'env-backup')
}

/** type 别名：工具/客户端 JSON 值面需要隐式索引签名（interface 会挂 defineTool） */
export type BackupRow = {
  file: string
  bytes: number
  /** 文件名内嵌的时间戳（yyyyMMdd-HHMM） */
  at: string
}

/** 文件名内嵌时间戳（yyyyMMdd-HHMM）：标签前缀件（auto-upgrade-20261119-1234-host）也从首个时间戳段提取 */
function stampOfFileName(f: string): string {
  const m = /\d{8}-\d{4}/.exec(f)
  return m?.[0] ?? f.slice(0, 13)
}

/** 列备份文件（只读目录，不解密）。按内嵌时间戳新→旧排：标签件（auto-upgrade-*）不因
 * 前缀字典序压过更新的手动备份——缺省取「最近一次」的路径（configinject / 配置轴出卡）口径不失真 */
export function listBackups(dir?: string): BackupRow[] {
  const d = envBackupDir(dir)
  if (!existsSync(d)) return []
  const rows: BackupRow[] = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.dshenv')) continue
    try {
      rows.push({ file: f, bytes: statSync(join(d, f)).size, at: stampOfFileName(f) })
    } catch { /* 尽力 */ }
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || b.file.localeCompare(a.file))
}

/** 只保留最新 N 个备份（换机仓库不被备份史撑爆） */
export function pruneBackups(keep = 3, dir?: string): number {
  const d = envBackupDir(dir)
  if (!existsSync(d)) return 0
  const rows = readdirSync(d).filter((f) => f.endsWith('.dshenv')).sort()
  let pruned = 0
  while (rows.length > keep) {
    const victim = rows.shift()
    if (victim === undefined) break
    try {
      rmSync(join(d, victim), { force: true })
      pruned += 1
    } catch { break }
  }
  return pruned
}

// ---------- 动作 ----------

/** 备份清单行（容器 manifest 的对外形态；配置轴出卡 / dry diff 共用） */
export type ManifestFileRow = { path: string; bytes: number; sha256: string; category: string }

export interface BackupManifestRead {
  ok: true
  /** 备份文件名（.dshenv） */
  file: string
  /** 密文包本体字节数（卡上「指针」的 bytes 口径） */
  bytes: number
  createdAt: string
  host: string
  secretCount: number
  secretHits: number
  /** 清单行（path/bytes/sha256/category，容器内解密所得） */
  files: ManifestFileRow[]
}

/**
 * 读一份备份的加密清单：口令解密容器取 manifest，**不触碰任何 blob 内容**——
 * 配置轴出卡（handoff_env action=card / pushConfigCard）只把清单+指针写上卡，
 * 密文 blob 原样留在 env-backup/。错口令 = GCM 认证失败诚实报错（同解包口径）。
 */
export function readBackupManifest(file: string, passphrase: string, dir?: string): BackupManifestRead {
  const name = basenameSafe(file)
  if (!name.endsWith('.dshenv')) throw new Error('备份文件名不合法（须为 .dshenv）')
  const buf = readFileSync(join(envBackupDir(dir), name))
  const m = unpackEncrypted(buf, passphrase)
  return {
    ok: true,
    file: name,
    bytes: buf.length,
    createdAt: m.createdAt,
    host: m.host,
    secretCount: m.secretCount,
    secretHits: m.secretHits,
    files: m.files.map((f) => ({ ...f })),
  }
}

/** 备份包内单条目的原文（配置写回 inject 的读取形态；不落盘，纯读） */
export interface BackupEntryBlob {
  /** 包内相对 user home 的路径（正斜杠） */
  path: string
  category: string
  content: Buffer
}

/**
 * 读备份包内若干条目的原文：口令解密容器后按谓词挑条目取 blob（**只读**——
 * 与 readBackupManifest 同口径，错口令 = GCM 认证失败诚实报错，不吐半个字节）。
 * handoff_env action=inject 用它取 `.mcp.json` 与 `.agents/skills/**` 两类源条目；
 * 谓词缺省 = 全部条目（调用方自己过滤也行）。
 *
 * 选中条目的路径过 validateRelPath（与 applyRestore 同款穿越闸：..、绝对路径、
 * 盘符一律拒收）——容器格式公开可伪造，敌意包不得经注入链把文件写出备份范围外。
 */
export function readBackupEntryBlobs(file: string, passphrase: string, dir?: string, pred?: (rel: string) => boolean): BackupEntryBlob[] {
  const name = basenameSafe(file)
  if (!name.endsWith('.dshenv')) throw new Error('备份文件名不合法（须为 .dshenv）')
  const m = unpackEncrypted(readFileSync(join(envBackupDir(dir), name)), passphrase)
  const out: BackupEntryBlob[] = []
  for (let i = 0; i < m.files.length; i++) {
    const f = m.files[i]!
    if (pred !== undefined && !pred(f.path)) continue
    const path = validateRelPath(f.path) // 穿越闸：..、绝对路径、盘符一律拒收（applyRestore 同款）
    out.push({ path, category: f.category, content: Buffer.from(blobAt(m, i)) })
  }
  return out
}

export interface BackupResult {
  ok: true
  file: string
  bytes: number
  files: number
  secretCount: number
  secretHits: number
  detail: string
}

/** 备份标签 → 文件名前缀：只允许小写字母/数字/连字符（≤32 字符），保证文件名安全；空/缺省回 '' */
function normalizeBackupLabel(label?: string): string {
  if (label === undefined || label.trim() === '') return ''
  const clean = label.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(clean)) {
    throw new Error(`备份标签不合法（只允许小写字母/数字/连字符，≤32 字符）：${label}`)
  }
  return `${clean}-`
}

/** 只保留某标签最近 N 个备份（文件名字典序=时间序）；只动同标签件——手动备份与其它标签件不受影响 */
function pruneLabeled(labelPrefix: string, keep: number, dir?: string): number {
  const d = envBackupDir(dir)
  if (!existsSync(d)) return 0
  const rows = readdirSync(d).filter((f) => f.endsWith('.dshenv') && f.startsWith(labelPrefix)).sort()
  let pruned = 0
  while (rows.length > keep) {
    const victim = rows.shift()
    if (victim === undefined) break
    try {
      rmSync(join(d, victim), { force: true })
      pruned += 1
    } catch { break }
  }
  return pruned
}

/**
 * 立即备份：收集 → 加密 → 落 env-backup/ → 修剪。
 * 无标签 = 手动备份语义（全局留 3，同现有口径不变）；
 * 带标签（如 auto-upgrade）= 标记快照语义：文件名带前缀、只留该标签最近 1 份、
 * 全局 keep-3 不跑——自动快照绝不挤掉手动备份。
 */
export function createBackup(passphrase: string, dir?: string, root?: string, label?: string): BackupResult {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('口令至少 8 位（它保护凭据类文件，且永不落盘——忘了就救不回备份）')
  }
  const prefix = normalizeBackupLabel(label)
  const userHome = root ?? homedir()
  const files = collectScopeFiles(root)
  if (files.length === 0) throw new Error('备份范围内没有找到任何文件（全家桶未安装？）')
  const { buf, manifest } = packEncrypted(files, userHome, passphrase)
  const d = envBackupDir(dir)
  mkdirSync(d, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  const file = `${prefix}${stamp}-${manifest.host}.dshenv`
  writeFileSync(join(d, file), buf)
  const pruned = prefix === '' ? pruneBackups(3, dir) : pruneLabeled(prefix, 1, dir)
  return {
    ok: true,
    file,
    bytes: buf.length,
    files: manifest.files.length,
    secretCount: manifest.secretCount,
    secretHits: manifest.secretHits,
    detail: prefix === ''
      ? `已备份 ${manifest.files.length} 个文件（${(buf.length / 1024 / 1024).toFixed(1)} MB，含凭据类 ${manifest.secretCount} 个${manifest.secretHits > 0 ? `；配置扫描疑似密钥 ${manifest.secretHits} 处` : ''}）——包已 AES-256-GCM 加密，口令未落盘${pruned > 0 ? `；已修剪 ${pruned} 个旧备份（保留 3 个）` : ''}`
      : `已打标记快照 ${file}（${manifest.files.length} 个文件，${(buf.length / 1024 / 1024).toFixed(1)} MB，含凭据类 ${manifest.secretCount} 个）——标签 ${prefix.replace(/-$/, '')} 只留最近 1 份${pruned > 0 ? `（本次修剪 ${pruned} 个旧份）` : ''}，手动备份未动；口令未落盘`,
  }
}

export type RestoreDiffRow = {
  path: string
  action: 'create' | 'overwrite' | 'same'
  category: string
  diskBytes?: number
  packBytes: number
}

export interface DryRunResult {
  ok: true
  file: string
  createdAt: string
  host: string
  secretCount: number
  diff: RestoreDiffRow[]
  creates: number
  overwrites: number
  same: number
}

/** 还原预演：解密 + 与磁盘逐文件比对（三态：新建/覆盖/相同）——不写任何盘 */
export function dryRunRestore(file: string, passphrase: string, dir?: string, root?: string): DryRunResult {
  const name = basenameSafe(file)
  if (!name.endsWith('.dshenv')) throw new Error('备份文件名不合法（须为 .dshenv）')
  const m = unpackEncrypted(readFileSync(join(envBackupDir(dir), name)), passphrase)
  const userHome = root ?? homedir()
  const diff: RestoreDiffRow[] = m.files.map((f) => {
    const rel = validateRelPath(f.path)
    const abs = join(userHome, rel)
    if (!existsSync(abs)) return { path: rel, action: 'create' as const, category: f.category, packBytes: f.bytes }
    const disk = readFileSync(abs)
    const sha = createHash('sha256').update(disk).digest('hex')
    return {
      path: rel,
      action: sha === f.sha256 ? ('same' as const) : ('overwrite' as const),
      category: f.category,
      diskBytes: disk.length,
      packBytes: f.bytes,
    }
  })
  return {
    ok: true,
    file: basenameSafe(file),
    createdAt: m.createdAt,
    host: m.host,
    secretCount: m.secretCount,
    diff,
    creates: diff.filter((r) => r.action === 'create').length,
    overwrites: diff.filter((r) => r.action === 'overwrite').length,
    same: diff.filter((r) => r.action === 'same').length,
  }
}

/** 取末段文件名（不含目录），仅拒绝空值；.dshenv 后缀在备份文件入口单独校验 */
function basenameSafe(file: string): string {
  const base = file.split('\\').join('/').split('/').pop() ?? ''
  if (base === '') throw new Error('备份文件名不合法')
  return base
}

export interface ApplyResult {
  ok: true
  file: string
  applied: number
  checkpointDir: string
  detail: string
}

/** 确认还原：checkpoint 被覆盖原物 → 逐文件 tmp+rename 落盘 → 报告 */
export function applyRestore(file: string, passphrase: string, dir?: string, root?: string): ApplyResult {
  const name = basenameSafe(file)
  if (!name.endsWith('.dshenv')) throw new Error('备份文件名不合法（须为 .dshenv）')
  const m = unpackEncrypted(readFileSync(join(envBackupDir(dir), name)), passphrase)
  const userHome = root ?? homedir()
  const toWrite: Array<{ path: string }> = []
  for (const f of m.files) {
    const rel = validateRelPath(f.path) // 穿越闸：..、绝对路径、盘符一律拒收
    const abs = join(userHome, rel)
    if (!existsSync(abs)) {
      toWrite.push({ path: rel })
      continue
    }
    const sha = createHash('sha256').update(readFileSync(abs)).digest('hex')
    if (sha !== f.sha256) toWrite.push({ path: rel })
    // 相同文件跳过：不碰盘、不进 checkpoint
  }
  if (toWrite.length === 0) {
    return { ok: true, file: basenameSafe(file), applied: 0, checkpointDir: '', detail: '磁盘已是备份内容（全部相同），未动任何文件' }
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  const ckptName = `restore-checkpoint-${stamp}`
  const ckpt = join(envBackupDir(dir), ckptName)
  mkdirSync(ckpt, { recursive: true })
  const overwritten: string[] = []
  for (const f of toWrite) {
    const abs = join(userHome, f.path)
    if (existsSync(abs)) {
      const cAbs = join(ckpt, f.path)
      mkdirSync(dirname(cAbs), { recursive: true })
      copyFileSync(abs, cAbs)
      overwritten.push(f.path)
    }
  }
  let applied = 0
  for (const f of toWrite) {
    const abs = join(userHome, f.path)
    mkdirSync(dirname(abs), { recursive: true })
    const idx = m.files.findIndex((x) => x.path === f.path)
    const data = blobAt(m, idx)
    const tmp = `${abs}.${process.pid}.tmp`
    writeFileSync(tmp, data)
    renameSync(tmp, abs)
    applied += 1
  }
  writeFileSync(join(ckpt, 'checkpoint-manifest.json'), JSON.stringify({ at: new Date().toISOString(), from: basenameSafe(file), overwritten }, null, 2), 'utf-8')
  return {
    ok: true,
    file: basenameSafe(file),
    applied,
    checkpointDir: join('env-backup', ckptName),
    detail: `已还原 ${applied} 个文件（新建 ${toWrite.length - overwritten.length} / 覆盖 ${overwritten.length}）。被覆盖原物已存 checkpoint（env-backup/${ckptName}）——不满意可 rollback`,
  }
}

/** 回滚：把 checkpoint 里的原物写回去 */
export function rollbackRestore(checkpointDir: string, dir?: string, root?: string): { ok: true; restored: number; detail: string } {
  const base = basenameSafe(checkpointDir)
  if (!base.startsWith('restore-checkpoint-')) throw new Error('回滚目标必须是 restore-checkpoint-* 目录')
  const ckpt = join(envBackupDir(dir), base)
  const manifestPath = join(ckpt, 'checkpoint-manifest.json')
  if (!existsSync(manifestPath)) throw new Error('checkpoint 目录不完整（缺 checkpoint-manifest.json）')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { overwritten: string[] }
  const userHome = root ?? homedir()
  let restored = 0
  for (const rel of manifest.overwritten) {
    validateRelPath(rel)
    const src = join(ckpt, rel)
    if (!existsSync(src)) continue
    const abs = join(userHome, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.tmp`
    copyFileSync(src, tmp)
    renameSync(tmp, abs)
    restored += 1
  }
  return { ok: true, restored, detail: `已回滚 ${restored} 个文件到还原前状态（${base}）` }
}

// ---------- 升级保险快照（0.26.1：宿主版本变化 → 自动打环境保险快照） ----------
//
// 触发器语义（需求调研 undo-savepoint 借鉴）：宿主升级是环境漂移的最大单点，升级前
// 留一份可回退的加密快照，升级搞坏了才有得救。纪律（fail-open + 诚实三态）：
// - 首跑只记基线版本不打快照（无基线不折腾）；
// - 口令复用调用方既有已存口令机制注入（opts.passphrase）——本模块绝不新增交互、
//   绝不把口令落盘（THREAT-MODEL T7：口令永不落盘）；无已存口令 = 诚实 skip 且不推进
//   基线（升级事件保持待办，口令就位后下次启动补打真正的保险）；
// - 自动快照带 auto-upgrade- 文件名标签，独立保留策略 = 只留最近一份；手动备份绝不动；
// - 宿主版本源不可读 = skipped + 原因，绝不误打。
// 调用方（服务器启动接线）自行与 env-backup 写队列串行，避免与手动备份并发写目录。

/** 升级保险快照的文件名标签（前缀 auto-upgrade-；独立保留策略只认这个前缀） */
export const AUTO_UPGRADE_LABEL = 'auto-upgrade'

/** 宿主版本基线文件：sync.json 的旁伴新键。本机记录、不随换机同步分发（各机升级节奏
 * 不同；不入 sync.ts SYNC_PATHS 白名单——勿加，加了会让 B 机继承 A 机的版本基线）。 */
export function envBackupStatePath(dir?: string): string {
  return join(resolveHome(dir), 'envbackup-state.json')
}

export interface EnvBackupStateFile {
  /** 上次见到的宿主运行时版本；缺失 = 首跑（无基线） */
  lastHostVersion?: string
  /** 基线记录时刻（ISO） */
  at?: string
}

/** 读版本基线：文件缺失/损坏 fail-open 回空（= 首跑重记基线，不打快照不误删），损坏必 console.warn */
export function readEnvBackupState(dir?: string): EnvBackupStateFile {
  const p = envBackupStatePath(dir)
  if (!existsSync(p)) return {}
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
    if (raw === null || typeof raw !== 'object') return {}
    const rec = raw as Record<string, unknown>
    return {
      lastHostVersion: typeof rec['lastHostVersion'] === 'string' ? rec['lastHostVersion'] : undefined,
      at: typeof rec['at'] === 'string' ? rec['at'] : undefined,
    }
  } catch (e) {
    console.warn(`[dsh-takeover] envbackup-state.json 损坏，按首跑处理：${e instanceof Error ? e.message : String(e)}`)
    return {}
  }
}

/** 写版本基线：tmp + rename 原子替换（saveSyncState 同模板）；尽力而为——失败不抛出
 * 不清盘，最坏后果是下次启动重记/重打一份（保留策略只留最近一份，自愈）。 */
export function writeEnvBackupState(state: EnvBackupStateFile, dir?: string): void {
  const next = { ...state, at: new Date().toISOString() }
  const target = envBackupStatePath(dir)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8')
    renameSync(tmp, target)
  } catch {
    try { rmSync(tmp, { force: true }) } catch { /* 尽力清临时件 */ }
  }
}

/**
 * 宿主运行时版本源（勘察结论）：`@deepseek-ai/dsh-app-boot` 的 getDshRuntimeVersion()——
 * 读当前加载的 app-boot 包自身 package.json 的 version，与宿主插件兼容闸（engines.dsh）
 * 对比的是同一个值，随宿主升级自动前进。懒加载 + 运行时拼接 specifier（防打包器把
 * 可选宿主包当静态依赖解析成硬依赖）；任何一步不可达回 null——调用方把 null 传给
 * maybeAutoUpgradeSnapshot 即 skipped，绝不误打。
 */
export async function resolveHostRuntimeVersion(): Promise<string | null> {
  try {
    const specifier = ['@deepseek-ai', 'dsh-app-boot'].join('/')
    const mod = (await import(specifier)) as { getDshRuntimeVersion?: () => unknown }
    const v = typeof mod.getDshRuntimeVersion === 'function' ? mod.getDshRuntimeVersion() : null
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
  } catch {
    return null // 宿主外环境（测试 / 缺包 profile）：诚实降级为不可读
  }
}

export interface AutoUpgradeSnapshotOpts {
  /** HANDOFF_HOME（版本基线文件与 env-backup/ 所在；缺省 ~/.handoff） */
  dir?: string
  /** 备份范围根（user home），透传 createBackup */
  root?: string
  /** 调用方既有已存口令机制注入的口令（≥8 位）；缺失/过短 = skip（绝不新增交互、绝不落盘） */
  passphrase?: string
}

/** 三态返回：created=打了快照 / same=版本没变 / skipped=没打（reason 给机器可读原因，detail 给人看） */
export type AutoUpgradeSnapshotValue = {
  action: 'created' | 'same' | 'skipped'
  reason?: string
  file?: string
  bytes?: number
  detail?: string
}

/**
 * 宿主版本变化 → 自动打升级保险快照（启动时接线调用，不新增任何交互）：
 * 1. 版本源不可读（null/空）→ skipped('host-version-unreadable')，基线不动、快照不打；
 * 2. 首跑（无基线）→ 只记版本，skipped('first-run')——无基线不折腾；
 * 3. 版本相同 → same，什么都不做；
 * 4. 版本变化 + 无已存口令 → skipped('no-passphrase') 且基线不推进（事件保持待办）；
 * 5. 版本变化 + 有口令 → createBackup(auto-upgrade 标签)，成功才推进基线并返回 created；
 *    失败 → skipped('backup-failed') 基线不推进（下次启动重试）。
 * 保留策略：自动快照只留最近一份（标签内修剪），手动备份绝不被自动流程动。
 */
export function maybeAutoUpgradeSnapshot(hostVersion: string | null | undefined, opts?: AutoUpgradeSnapshotOpts): AutoUpgradeSnapshotValue {
  const version = typeof hostVersion === 'string' ? hostVersion.trim() : ''
  if (version === '') {
    return { action: 'skipped', reason: 'host-version-unreadable', detail: '宿主版本源不可读——基线不记、快照不打（绝不误打）' }
  }
  const dir = opts?.dir
  const prev = readEnvBackupState(dir).lastHostVersion ?? ''
  if (prev === '') {
    writeEnvBackupState({ lastHostVersion: version }, dir)
    return { action: 'skipped', reason: 'first-run', detail: `首跑只记基线版本 ${version}，不打快照（无基线不折腾）` }
  }
  if (prev === version) {
    return { action: 'same', detail: `宿主版本未变（${version}），无需快照` }
  }
  const passphrase = opts?.passphrase
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    return { action: 'skipped', reason: 'no-passphrase', detail: `宿主版本 ${prev} → ${version}，但无已存口令（≥8 位）——不打快照，基线不推进（口令就位后下次启动补打）` }
  }
  let r: BackupResult
  try {
    r = createBackup(passphrase, dir, opts?.root, AUTO_UPGRADE_LABEL)
  } catch (e) {
    return { action: 'skipped', reason: 'backup-failed', detail: `宿主版本 ${prev} → ${version}，自动快照失败（基线不推进，下次启动重试）：${e instanceof Error ? e.message : String(e)}` }
  }
  writeEnvBackupState({ lastHostVersion: version }, dir)
  return {
    action: 'created',
    file: r.file,
    bytes: r.bytes,
    detail: `宿主版本 ${prev} → ${version}，已自动打升级保险快照：${r.file}（${r.files} 个文件）——自动快照只留最近一份，手动备份未动`,
  }
}
