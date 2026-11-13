/**
 * 补丁物质层打包/还原（0.4.x 物质层补全）：
 * - untracked 小文件内容旅行：vendor collectPatch 只列 untracked 清单不带货；
 *   这里把单文件 <64KB 的清单项手拼「新增文件 unified diff」追加进补丁全文，
 *   格式逐行对齐 git 自身 intent-to-add 的输出（git apply / --check / -3way 均可消费），
 *   大文件 / 二进制 / 不可读 / 不安全路径仍只列清单。
 * - gzip / 分块破 512KB：PATCH_MAX_BYTES 是 core 硬限，超限整份拒带——最需要带的
 *   时刻带不走。补丁全文先过完密钥扫描再打包：原始 ≤512KB 走旧纯文本 .patch；
 *   超限先 gzipSync，压缩后 ≤512KB 写单个 <id>.patch.gz；仍超则把 gzip 字节流按
 *   480KB 等分切块 <id>.patch.001.gz/.patch.002.gz…（同一条 gzip 流的字节切块，
 *   取件侧按序拼接后一次 gunzip）。绝不静默丢补丁——超限也要分块带走。
 * - 取件还原：consumePatch 识别 gzip magic（1f 8b）自动解压、多块按序重组，
 *   写回归档 <id>.patch——git apply 指引路径与旧格式完全一致。
 * 纯函数优先、失败降级不抛：与 tools.ts 物质层既有纪律一致。
 * @module dsh-takeover/patchpack
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { archivedDir, pendingDir, PATCH_MAX_BYTES, type PatchBundle, type UntrackedFile } from '@agent-handoff/core'

/** untracked 单文件内联上限：单文件 <64KB 才生成新增文件 diff 随补丁旅行 */
export const UNTRACKED_INLINE_MAX_BYTES = 64 * 1024

/** gzip 分块字节（480KB）：低于 core 512KB 硬限留出余量，每块独立落盘 */
export const PATCH_CHUNK_BYTES = 480 * 1024

/** 自采 diff 单命令超时（毫秒）：与 tools.ts 基线采集同口径——挂死的 git / 慢盘不拖垮寄存 */
const GIT_DIFF_TIMEOUT_MS = 15_000

/** gzip magic 识别（前 2 字节 = 1f 8b）：按字节判形态，不依赖扩展名 */
export function isGzipBytes(buf: Buffer): boolean {
  return buf.byteLength >= 2 && buf[0] === 0x1f && buf[1] === 0x8b
}

// ---------------------------------------------------------------------------
// A. untracked 小文件内容旅行
// ---------------------------------------------------------------------------

/** 内联未跟踪文件时主动放弃的原因（如实进 push 文案，绝不静默） */
export type InlineSkipReason = 'size' | 'binary' | 'unreadable' | 'unsafe'

export interface InlineSkipped extends UntrackedFile {
  reason: InlineSkipReason
}

export interface InlineOutcome {
  /** 增补后的补丁全文（tracked diff + untracked 新增文件 diff）；空串 = 无任何可带内容 */
  patch: string
  /** 已随补丁旅行的清单项（相对路径 + 字节数） */
  inlined: UntrackedFile[]
  /** 未随卡、仍只列清单的项 + 放弃原因 */
  leftOut: InlineSkipped[]
}

/**
 * 手拼「新增文件 unified diff」：格式逐行对齐 git intent-to-add 的输出
 *（git diff HEAD 对已 add -N 文件的形态），git apply / --check / -3way 实测可消费：
 * - 空文件 = 仅扩展头无 hunk（git 同款）；
 * - 末行无换行 = hunk 后跟 `\ No newline at end of file` 标记；
 * - index 行带全量 blob sha1（git apply --3way 依赖 blob 哈希做三方合并）。
 * 模式固定 100644：Windows 源机上可执行位本就不可知，跨机还原后如需 +x 由接手方补
 *（卡片内容一律 HISTORY_REPORTED，模式漂移不算静默失真）。
 * 换行原样保留（CRLF 文件字节级还原）；git apply 侧的 eol 转换（autocrlf）是 git
 * 自身对一切 diff 的语义，不是本函数引入的失真。
 */
export function newFileDiffBlock(file: string, content: Buffer): string {
  const blobSha = createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
  const head = [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    `index 0000000000000000000000000000000000000000..${blobSha}`,
  ]
  const text = content.toString('utf-8')
  if (text === '') {
    // 空文件：git 自身输出只有扩展头（无 ---/+++、无 hunk），git apply 据此建空文件
    return `${head.join('\n')}\n`
  }
  const hasTrailingNl = text.endsWith('\n')
  const lines = text.split('\n')
  if (hasTrailingNl) lines.pop() // 结尾换行 split 出的尾空元素不属于内容行
  const parts: string[] = [
    ...head,
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ]
  if (!hasTrailingNl) parts.push('\\ No newline at end of file')
  return `${parts.join('\n')}\n`
}

/** 内联路径安全闸：绝对路径 / 上跳 / 引号（git C-quoted 输出歧义面）/ 换行一律不内联 */
function unsafeRelPath(file: string): boolean {
  return file.startsWith('/') || file.includes('..') || file.includes('"') || file.includes('\n') || file.includes('\r')
}

/**
 * 把 untracked 清单中的小文件手拼 diff 追加进补丁全文。
 * base 传推送侧解析出的补丁全文（vendor 超 512KB 拒带时调用方已自采；非 git 仓传空串
 * 且清单为空）；清单为空或全部放弃时返回 base 原文。追加处以换行衔接：vendor patch
 * 经 trim 尾部无换行，直接拼接会把两段粘成一行。
 */
export function augmentPatchWithUntracked(cwd: string, base: string, untracked: UntrackedFile[]): InlineOutcome {
  const inlined: UntrackedFile[] = []
  const leftOut: InlineSkipped[] = []
  const blocks: string[] = []
  for (const u of untracked) {
    // 清单字节数先行闸：超大文件不值得读盘（读盘后再验一次，防清单口径过期）
    if (u.bytes >= UNTRACKED_INLINE_MAX_BYTES) {
      leftOut.push({ ...u, reason: 'size' })
      continue
    }
    if (unsafeRelPath(u.file)) {
      leftOut.push({ ...u, reason: 'unsafe' })
      continue
    }
    let buf: Buffer
    try {
      if (!statSync(join(cwd, u.file)).isFile()) {
        // 目录项不内联（ls-files 理论上不列目录，防御）
        leftOut.push({ ...u, reason: 'unreadable' })
        continue
      }
      buf = readFileSync(join(cwd, u.file))
    } catch {
      leftOut.push({ ...u, reason: 'unreadable' })
      continue
    }
    // 二次尺寸闸：清单采集到落盘窗口内文件可能变大，超限仍按 size 放弃
    if (buf.byteLength >= UNTRACKED_INLINE_MAX_BYTES) {
      leftOut.push({ ...u, reason: 'size' })
      continue
    }
    // 二进制（NUL 字节，git 同款判据）与非 UTF-8 文本不内联——补丁 sidecar 是 utf-8 文本，
    // 塞进坏字节等于构造不可 apply 的补丁；仍留在清单里如实列名
    if (buf.includes(0)) {
      leftOut.push({ ...u, reason: 'binary' })
      continue
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      leftOut.push({ ...u, reason: 'binary' })
      continue
    }
    blocks.push(newFileDiffBlock(u.file, Buffer.from(text, 'utf-8')))
    inlined.push({ file: u.file, bytes: buf.byteLength })
  }
  const appended = blocks.join('')
  const patch = base === '' ? appended : base.endsWith('\n') ? base + appended : `${base}\n${appended}`
  return { patch, inlined, leftOut }
}

/** 自采 diff 缓冲上限（64MB）：vendor git() 用默认 1MB maxBuffer，diff 超限时它自己
 * 先崩（抛错被吞成空串）；本侧自采必须撑住被 vendor 判「超限拒带」的 512KB~1MB 区间，
 * 也顺带兜住 >1MB 的假干净。64MB 是显式推送动作下可接受的内存峰值；再大的 diff
 * 属病理场景，自采失败走「自采失败未随卡」的诚实降级而非静默。 */
const GIT_DIFF_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/**
 * vendor collectPatch 超 PATCH_MAX_BYTES 时整份拒带（patch 为空串）——这里以 core 同款
 * 口径（fsmonitor=false + quotePath=false + trim）自采 diff 全文，交给 gzip/分块管线带走。
 * 拿不到（git 失败/unborn）回 null，调用方如实降级，绝不假称已带。
 */
export function collectFullDiff(cwd: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', 'diff', 'HEAD'], {
      encoding: 'utf-8',
      timeout: GIT_DIFF_TIMEOUT_MS,
      maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * collectPatch 结果 → 推送侧补丁全文。vendor 的 patch 空串是二义的：真空树、
 * unborn、diff 命令失败/超 1MB maxBuffer 崩掉的「假干净」都长一个样——空串时
 * 一律自采一次 diff 全文复核（真空树这次调用毫秒级秒回），只为不静默丢补丁；
 * vendor 给了非空且未拒带的 patch 才直接沿用（正常脏仓不多花一次进程）。
 */
export function resolvePatchText(cwd: string, bundle: PatchBundle | null): string {
  if (bundle === null) return ''
  if (bundle.patch !== '' && !bundle.truncated) return bundle.patch
  return collectFullDiff(cwd) ?? ''
}

// ---------------------------------------------------------------------------
// B. 写侧打包：纯文本 / gzip 单块 / gzip 分块
// ---------------------------------------------------------------------------

export type PackedFormat = 'plain' | 'gzip' | 'gzip-chunked'

export interface PackedPatch {
  format: PackedFormat
  /** gzip 分块数（plain=0、单块=1、分块=N） */
  chunks: number
  /** 落盘的边车文件绝对路径（按序） */
  files: string[]
  /** 实际落盘字节（plain=原文、gzip=压缩流、分块=压缩流总量） */
  writtenBytes: number
}

/**
 * 补丁边车落盘（写侧唯一入口，pushHandoff 在密钥扫描通过后调用）：
 * ≤512KB 纯文本 <id>.patch（旧格式零改动）；超限 gzipSync 后 ≤512KB 写单块 <id>.patch.gz；
 * 仍超按 480KB 等分 <id>.patch.NNN.gz——同一条 gzip 流按字节切块，取件侧按序拼接一次解压。
 */
export function writePatchSidecar(id: string, patch: string, dir?: string): PackedPatch {
  const pend = pendingDir(dir)
  const plainBytes = Buffer.byteLength(patch, 'utf-8')
  if (plainBytes <= PATCH_MAX_BYTES) {
    const p = join(pend, `${id}.patch`)
    writeFileSync(p, patch, 'utf-8')
    return { format: 'plain', chunks: 0, files: [p], writtenBytes: plainBytes }
  }
  const gz = gzipSync(Buffer.from(patch, 'utf-8'))
  if (gz.byteLength <= PATCH_MAX_BYTES) {
    const p = join(pend, `${id}.patch.gz`)
    writeFileSync(p, gz)
    return { format: 'gzip', chunks: 1, files: [p], writtenBytes: gz.byteLength }
  }
  const total = Math.ceil(gz.byteLength / PATCH_CHUNK_BYTES)
  const files: string[] = []
  for (let i = 0; i < total; i++) {
    const p = join(pend, `${id}.patch.${String(i + 1).padStart(3, '0')}.gz`)
    writeFileSync(p, gz.subarray(i * PATCH_CHUNK_BYTES, Math.min((i + 1) * PATCH_CHUNK_BYTES, gz.byteLength)))
    files.push(p)
  }
  return { format: 'gzip-chunked', chunks: total, files, writtenBytes: gz.byteLength }
}

// ---------------------------------------------------------------------------
// C. 取件还原：gzip magic 识别 + 多块按序重组
// ---------------------------------------------------------------------------

export interface RestoredPatch {
  /** 归档后可直接 git apply 的纯文本补丁路径；解压失败时缺省（压缩块已原样归档） */
  path?: string
  /** 解压后纯文本字节数（与旧格式 patchBytes 口径一致） */
  bytes?: number
  /** 归档形态说明（gzip 单块 / 分块），供取件文案如实告知 */
  format?: Exclude<PackedFormat, 'plain'>
  /** gzip 块数（单块=1、分块=N；plain 路径由 consumePatch 直接回 path 不带本字段） */
  chunks?: number
  /** 还原降级说明（解压失败/序号断档等）；有 warn 时 path 缺省 */
  warn?: string
}

/** gzip 分块名尾段正则：<id>.patch.NNN.gz（单块 .patch.gz 无序号段，不匹配） */
const CHUNK_NAME_RE = /\.patch\.(\d+)\.gz$/

/** pending/ 下按序号升序收集某卡的 gzip 分块；序号断档（不连续）按损坏处理回 null */
export function listPatchChunks(id: string, dir?: string): { paths: string[]; total: number } | null {
  let names: string[]
  try {
    names = readdirSync(pendingDir(dir))
  } catch {
    return null
  }
  const parts: Array<{ n: number; name: string }> = []
  for (const f of names) {
    if (!f.startsWith(`${id}.patch.`) || !f.endsWith('.gz')) continue
    const m = CHUNK_NAME_RE.exec(f)
    if (m === null) continue
    parts.push({ n: Number(m[1]), name: f })
  }
  if (parts.length === 0) return null
  parts.sort((a, b) => a.n - b.n)
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]?.n !== i + 1) return null // 序号断档：补丁不完整，按损坏降级
  }
  return { paths: parts.map((p) => join(pendingDir(dir), p.name)), total: parts.length }
}

/**
 * 取件还原：pending/ 里的压缩形态（单块 .patch.gz 或分块 .patch.NNN.gz）→ 按序拼接 →
 * gzip magic 校验 → gunzip → 写归档 <id>.patch（git apply 指引路径与旧格式一致）；
 * 压缩块原样搬去 archived/ 留审计轨迹。旧纯文本 .patch 不走本函数（consumePatch 先判）。
 */
export function restoreGzipPatch(id: string, dir?: string): RestoredPatch | undefined {
  const single = join(pendingDir(dir), `${id}.patch.gz`)
  const chunks = listPatchChunks(id, dir)
  let sources: string[]
  let format: 'gzip' | 'gzip-chunked'
  if (existsQuiet(single)) {
    sources = [single]
    format = 'gzip'
  } else if (chunks !== null) {
    sources = chunks.paths
    format = 'gzip-chunked'
  } else {
    return undefined
  }
  const chunkCount = sources.length
  const arch = archivedDir(dir)
  const bufs: Buffer[] = []
  for (const src of sources) {
    try {
      bufs.push(readFileSync(src))
    } catch (e) {
      return { warn: `压缩块读取失败（${baseName(src)}）：${e instanceof Error ? e.message : String(e)}` }
    }
  }
  const merged = Buffer.concat(bufs)
  if (!isGzipBytes(merged)) {
    archiveParts(arch, sources)
    return { warn: '压缩流缺 gzip magic（1f 8b），可能损坏或被篡改——压缩块已原样归档' }
  }
  let plain: Buffer
  try {
    plain = gunzipSync(merged)
  } catch (e) {
    archiveParts(arch, sources)
    return { warn: `gzip 解压失败（${e instanceof Error ? e.message : String(e)}）——压缩块已原样归档，可手工 gunzip 修复` }
  }
  const dest = join(arch, `${id}.patch`)
  try {
    writeFileSync(dest, plain)
  } catch (e) {
    return { warn: `解压后补丁落盘失败：${e instanceof Error ? e.message : String(e)}` }
  }
  archiveParts(arch, sources)
  return { path: dest, bytes: plain.byteLength, format, chunks: chunkCount }
}

/** 压缩块原样搬 archived（审计轨迹）；搬移失败容忍——残留块由伴生孤儿清扫兜底 */
function archiveParts(arch: string, sources: string[]): void {
  for (const src of sources) {
    try {
      renameSync(src, join(arch, basename(src)))
    } catch { /* 残留块由伴生孤儿清扫兜底 */ }
  }
}

function existsQuiet(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function baseName(p: string): string {
  return basename(p)
}
