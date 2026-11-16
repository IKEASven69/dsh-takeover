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

/** 收集/恢复的目录黑名单（防未来 scope 改动把可重植巨物卷进来） */
const PRUNE_DIRS = new Set(['node_modules', '.git', 'hf-cache', 'logs', 'crash', 'cache'])

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

/** 列备份文件（只读目录，不解密） */
export function listBackups(dir?: string): BackupRow[] {
  const d = envBackupDir(dir)
  if (!existsSync(d)) return []
  const rows: BackupRow[] = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.dshenv')) continue
    try {
      rows.push({ file: f, bytes: statSync(join(d, f)).size, at: f.slice(0, 13) })
    } catch { /* 尽力 */ }
  }
  return rows.sort((a, b) => b.file.localeCompare(a.file))
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

/** 立即备份：收集 → 加密 → 落 env-backup/ → 修剪留 3 */
export function createBackup(passphrase: string, dir?: string, root?: string): BackupResult {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('口令至少 8 位（它保护凭据类文件，且永不落盘——忘了就救不回备份）')
  }
  const userHome = root ?? homedir()
  const files = collectScopeFiles(root)
  if (files.length === 0) throw new Error('备份范围内没有找到任何文件（全家桶未安装？）')
  const { buf, manifest } = packEncrypted(files, userHome, passphrase)
  const d = envBackupDir(dir)
  mkdirSync(d, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  const file = `${stamp}-${manifest.host}.dshenv`
  writeFileSync(join(d, file), buf)
  const pruned = pruneBackups(3, dir)
  return {
    ok: true,
    file,
    bytes: buf.length,
    files: manifest.files.length,
    secretCount: manifest.secretCount,
    secretHits: manifest.secretHits,
    detail: `已备份 ${manifest.files.length} 个文件（${(buf.length / 1024 / 1024).toFixed(1)} MB，含凭据类 ${manifest.secretCount} 个${manifest.secretHits > 0 ? `；配置扫描疑似密钥 ${manifest.secretHits} 处` : ''}）——包已 AES-256-GCM 加密，口令未落盘${pruned > 0 ? `；已修剪 ${pruned} 个旧备份（保留 3 个）` : ''}`,
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
