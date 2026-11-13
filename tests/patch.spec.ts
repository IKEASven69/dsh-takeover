/**
 * 物质层交接测试（0.4.1 → 0.4.x 物质层补全）：补丁随卡（纯文本/gzip/分块）/
 * untracked 小文件内容旅行 / 信封物质层扩展 / 非 git 仓诚实警告 / supersedes 接力链。
 * 全部用临时真实 git 仓库走 pushHandoff → inboxLoad 全链路，不 mock git。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { collectPatch, PATCH_MAX_BYTES } from '@agent-handoff/core'
import { buildEnvelope, inboxLoad, pushHandoff, renderInbox } from '../src/tools.ts'
import { listPatchChunks, PATCH_CHUNK_BYTES, restoreGzipPatch, UNTRACKED_INLINE_MAX_BYTES, writePatchSidecar } from '../src/patchpack.ts'

/** 造一个有真实提交基线的临时 git 仓（fsmonitor 关闭口径与 core 一致） */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-patch-'))
  const g = (args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', ...args], { stdio: 'ignore' })
  g(['init', '-q'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  // 字节保真断言需要关闭 autocrlf（本机全局常为 true：git apply 会把 LF 转 CRLF，
  // 那是 git 自身对一切 diff 的语义，不是被测代码的失真——夹具侧关掉才可比字节）
  g(['config', 'core.autocrlf', 'false'])
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

test('净仓 push（0.4.x 补全）：untracked 小文件手拼新增 diff 随补丁携带且 git apply 可复原；信封仍列全清单', () => {
  const repo = makeRepo() // 干净树（仅基线提交）
  writeFileSync(join(repo, 'new-untracked.txt'), 'brand new\n')
  writeFileSync(join(repo, 'no-nl.txt'), 'no trailing newline') // 末行无换行
  mkdirSync(join(repo, 'sub'))
  writeFileSync(join(repo, 'sub', 'deep.txt'), 'sub content\n') // 子目录路径
  writeFileSync(join(repo, 'empty.txt'), '') // 空文件（仅扩展头无 hunk）
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x61, 0x00, 0x62])) // NUL 字节=二进制
  writeFileSync(join(repo, 'big.bin'), 'z'.repeat(UNTRACKED_INLINE_MAX_BYTES + 1)) // 超 64KB
  withHome((home) => {
    const r = pushHandoff(null, { goal: '净仓 untracked 旅行', warnings: '', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    // 小文件内容旅行：净仓也有补丁 sidecar（untracked 手拼新增 diff 就是补丁本体）
    assert.ok(r.patch, 'untracked 小文件应随补丁携带（净仓也有 sidecar）')
    if (!r.patch) return
    assert.equal(r.patch.truncated, false)
    assert.equal(r.patch.sidecar, true)
    const patchFile = join(home, 'pending', `${r.id}.patch`)
    assert.ok(existsSync(patchFile), 'pending/ 应有 <id>.patch（纯文本形态）')
    const patchText = readFileSync(patchFile, 'utf-8')
    for (const marker of ['diff --git a/new-untracked.txt b/new-untracked.txt', '+brand new', '+++ b/no-nl.txt', '\\ No newline at end of file', '+++ b/sub/deep.txt', '+sub content', 'diff --git a/empty.txt b/empty.txt']) {
      assert.ok(patchText.includes(marker), `补丁应含手拼新增 diff 标记「${marker}」`)
    }
    assert.ok(!patchText.includes('bin.dat'), '二进制文件不应内联进补丁')
    assert.ok(!patchText.includes('big.bin'), '超大文件不应内联进补丁')
    assert.ok(r.note.includes('已随补丁携带'), `小文件旅行应进文案：${r.note}`)
    assert.ok(r.note.includes('不随卡'), `超大/二进制放弃原因应如实进文案：${r.note}`)
    // 信封仍列全清单（4 个可内联文本文件 + 1 二进制 + 1 超大，共 6 项）
    const env = JSON.parse(readFileSync(join(home, 'pending', `${r.id}.envelope.json`), 'utf-8')) as { untracked?: Array<{ file: string }> }
    assert.equal((env['untracked'] as unknown[]).length, 6, '信封 untracked 清单应列全部 6 项')
    // 取件 + git apply 实复原：先删源侧未跟踪文件（模拟取件机没有这些文件的新 clone），
    // 再 apply 逐文件字节比对
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.ok(load.patchPath, '取件应归档解压后的纯文本补丁')
    if (!load.patchPath) return
    rmSync(join(repo, 'new-untracked.txt'), { force: true })
    rmSync(join(repo, 'no-nl.txt'), { force: true })
    rmSync(join(repo, 'empty.txt'), { force: true })
    rmSync(join(repo, 'sub', 'deep.txt'), { force: true })
    rmSync(join(repo, 'bin.dat'), { force: true })
    rmSync(join(repo, 'big.bin'), { force: true })
    const g = (args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf-8' })
    g(['apply', '--check', load.patchPath])
    g(['apply', load.patchPath])
    assert.equal(readFileSync(join(repo, 'new-untracked.txt'), 'utf-8'), 'brand new\n')
    assert.equal(readFileSync(join(repo, 'no-nl.txt'), 'utf-8'), 'no trailing newline')
    assert.equal(readFileSync(join(repo, 'sub', 'deep.txt'), 'utf-8'), 'sub content\n')
    assert.equal(readFileSync(join(repo, 'empty.txt'), 'utf-8'), '')
    assert.ok(!existsSync(join(repo, 'bin.dat')), '二进制文件不随补丁复原')
    assert.ok(!existsSync(join(repo, 'big.bin')), '超大文件不随补丁复原')
  })
  rmSync(repo, { recursive: true, force: true })
})

test('密钥闸覆盖 untracked 追加部分：小文件里的密钥随补丁被扫出，push 拒绝；旁路留痕成立', () => {
  const repo = makeRepo()
  // 夹具密钥运行时拼装（源码/工作区 diff 里不存在可匹配字面量）：否则本仓自己的脏树
  // push 会被密钥闸拦下——补丁 diff 同扫对仓库自身同样生效（T2-P 纪律的诚实体现）
  const fakeKey = ['sk-', 'abcdef0123456789abcdef0123456789'].join('')
  writeFileSync(join(repo, 'leaky.txt'), `token = "${fakeKey}"\n`) // DeepSeek 口径 32 hex
  withHome((home) => {
    const blocked = pushHandoff(null, { goal: 'untracked 密钥走私', warnings: '', cwd: repo }, { dir: home })
    assert.equal(blocked.ok, false, 'untracked 小文件里的密钥必须被密钥闸拦下（追加部分同口径扫描）')
    if (blocked.ok) return
    assert.ok(blocked.error.includes('密钥闸'), `拒绝理由应回喂：${blocked.error}`)
    assert.ok(blocked.error.includes('@patch'), `命中段应标 patch（补丁段扫描）：${blocked.error}`)
    assert.ok(!existsSync(join(home, 'pending')), '拒绝时不得落任何 pending 物料')
    // 旁路留痕：allowSecrets 后密钥内容随补丁旅行（与 tracked diff 既有旁路语义一致）
    const bypass = pushHandoff(null, { goal: 'untracked 密钥走私旁路', warnings: '', cwd: repo, allowSecrets: true }, { dir: home })
    assert.equal(bypass.ok, true)
    if (!bypass.ok) return
    assert.ok(bypass.secretsBypass?.length, '旁路应留痕')
    const patchText = readFileSync(join(home, 'pending', `${bypass.id}.patch`), 'utf-8')
    assert.ok(patchText.includes('+token = "sk-abcdef'), '旁路后 untracked 内容应随补丁落盘')
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

test('超大 diff 不再拒带（0.4.x 补全）：vendor 仍按上限 truncated，push 自采全文 gzip 单块随卡，取件自动解压可 apply', () => {
  const repo = makeRepo()
  writeFileSync(join(repo, 'base.txt'), `x${'y'.repeat(PATCH_MAX_BYTES)}`) // >512KB 单行改动（高冗余，gzip 后远小于上限）
  // 直接收集面：vendor 口径不变——超上限 → patch 空串 + truncated
  const small = collectPatch(repo, 100)
  assert.ok(small)
  assert.equal(small.truncated, true)
  assert.equal(small.patch, '')
  assert.ok(small.bytes > 100)
  // push 面（0.4.x）：>512KB 自采全文 → gzip 压缩后单块 .patch.gz 随卡，绝不静默丢补丁
  withHome((home) => {
    const r = pushHandoff(null, { goal: '巨diff压缩单块', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.patch?.sidecar, 'gzip 单块也应 sidecar 随卡')
    assert.equal(r.patch.truncated, false, '全量已随卡，不再标记 truncated')
    assert.equal(r.patch.patchFormat, 'gzip', '信封/返回面应标 gzip 形态')
    assert.equal(r.patch.chunks, undefined, '单块不记 chunks')
    assert.ok(!existsSync(join(home, 'pending', `${r.id}.patch`)), '不应落旧纯文本 .patch')
    const gzPath = join(home, 'pending', `${r.id}.patch.gz`)
    assert.ok(existsSync(gzPath), '应落单块 <id>.patch.gz')
    const gzHead = readFileSync(gzPath).subarray(0, 2)
    assert.deepEqual([...gzHead], [0x1f, 0x8b], '边车应是 gzip magic（1f 8b）开头')
    assert.ok(r.note.includes('gzip 压缩后单块随卡'), `文案应如实说明压缩随卡：${r.note}`)
    // 信封 patch 元信息：bytes 仍是未压缩口径，patchFormat=gzip
    const env = JSON.parse(readFileSync(join(home, 'pending', `${r.id}.envelope.json`), 'utf-8')) as {
      patch?: { bytes?: number; patchFormat?: string; truncated?: boolean }
    }
    assert.equal(env['patch']?.patchFormat, 'gzip')
    assert.equal(env['patch']?.truncated, false)
    assert.ok((env['patch']?.bytes ?? 0) > PATCH_MAX_BYTES, 'bytes 应为未压缩补丁全文口径')
    // 取件：自动解压写回归档 <id>.patch，apply 指引路径不变；压缩块原样搬 archived/
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.ok(load.patchPath, '取件应带归档补丁路径')
    if (!load.patchPath) return
    assert.ok(load.patchPath.endsWith(`${r.id}.patch`), '归档路径应为解压后的 <id>.patch')
    assert.ok((load.patchBytes ?? 0) > PATCH_MAX_BYTES, 'patchBytes 应为解压后口径')
    assert.equal(load.patchFormat, 'gzip')
    assert.equal(load.patchChunks, 1)
    assert.ok(!existsSync(gzPath), 'pending/ 的压缩块应已离场')
    assert.ok(existsSync(join(home, 'archived', `${r.id}.patch.gz`)), '压缩块原样搬 archived/ 留审计轨迹')
    // 实复原：工作区先退回 HEAD（模拟取件机干净基线），解压补丁应用后应逐字节回到
    // 寄存时刻的未提交内容（补丁复原的是「改动」，不是基线）
    const g = (args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf-8' })
    g(['checkout', '--', 'base.txt'])
    g(['apply', '--check', load.patchPath])
    g(['apply', load.patchPath])
    assert.equal(readFileSync(join(repo, 'base.txt'), 'utf-8'), `x${'y'.repeat(PATCH_MAX_BYTES)}`, 'apply 后应逐字节复原寄存时刻的未提交内容')
    const text = renderInbox(null, load).map((b) => b.text).join('\n')
    assert.ok(text.includes('gzip 压缩形态随卡'), `取件文案应如实说明自动解压：${text}`)
  })
  rmSync(repo, { recursive: true, force: true })
})

test('超大且难压缩 diff（0.4.x 补全）：gzip 仍超限 → 480KB 分块 .patch.NNN.gz 随卡，取件按序重组可 apply', () => {
  const repo = makeRepo()
  // 近随机 hex 文本（每行 80 字符）：熵 ~4bit/字符，gzip 只能压到 ~50%——
  // 1.2MB 文本 → diff >1MB → gzip 后 >512KB → 必走分块；hex 字母表不会撞任何密钥前缀规则
  const lines = 15_000
  const noise: string[] = []
  for (let i = 0; i < lines; i++) noise.push(randomBytes(40).toString('hex'))
  writeFileSync(join(repo, 'base.txt'), `${noise.join('\n')}\n`)
  withHome((home) => {
    const r = pushHandoff(null, { goal: '巨diff分块', cwd: repo }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.ok(r.patch?.sidecar, '分块也应视为 sidecar 随卡')
    assert.equal(r.patch.truncated, false, '分块全量带走，不标 truncated')
    assert.equal(r.patch.patchFormat, 'gzip')
    assert.equal(typeof r.patch.chunks, 'number', '分块应记 chunks 数')
    const chunkCount = r.patch.chunks as number
    assert.ok(chunkCount >= 2, `难压缩补丁应至少 2 块：${chunkCount}`)
    assert.ok(!existsSync(join(home, 'pending', `${r.id}.patch`)), '不应落旧纯文本 .patch')
    assert.ok(!existsSync(join(home, 'pending', `${r.id}.patch.gz`)), '不应落单块 .patch.gz')
    for (let i = 1; i <= chunkCount; i++) {
      const p = join(home, 'pending', `${r.id}.patch.${String(i).padStart(3, '0')}.gz`)
      assert.ok(existsSync(p), `分块 ${p} 应存在`)
      const st = (i < chunkCount) ? PATCH_CHUNK_BYTES : undefined
      if (st !== undefined) assert.equal(readFileSync(p).byteLength, PATCH_CHUNK_BYTES, `非末块应恰为 ${PATCH_CHUNK_BYTES} 字节`)
      assert.ok(readFileSync(p).byteLength <= PATCH_CHUNK_BYTES, '每块不得超过 480KB')
    }
    assert.ok(r.note.includes(`gzip 分 ${chunkCount} 块随卡`), `文案应如实说明分块：${r.note}`)
    const env = JSON.parse(readFileSync(join(home, 'pending', `${r.id}.envelope.json`), 'utf-8')) as {
      patch?: { chunks?: number; patchFormat?: string }
    }
    assert.equal(env['patch']?.chunks, chunkCount, '信封应记 chunks 数')
    assert.equal(env['patch']?.patchFormat, 'gzip')
    // 取件：多块按序重组解压 → 归档纯文本补丁可 apply；压缩块全部搬 archived/
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.patchFormat, 'gzip-chunked')
    assert.equal(load.patchChunks, chunkCount)
    assert.ok(load.patchPath?.endsWith(`${r.id}.patch`), `重组后应写归档 <id>.patch：${load.patchPath}`)
    const restored = readFileSync(load.patchPath as string, 'utf-8')
    assert.ok(restored.includes(`+${noise[0]}`), '重组补丁应含首个内容行')
    assert.ok(restored.includes(`+${noise[lines - 1]}`), '重组补丁应含末个内容行（跨块不丢字节）')
    for (let i = 1; i <= chunkCount; i++) {
      assert.ok(!existsSync(join(home, 'pending', `${r.id}.patch.${String(i).padStart(3, '0')}.gz`)), 'pending/ 分块应全部离场')
      assert.ok(existsSync(join(home, 'archived', `${r.id}.patch.${String(i).padStart(3, '0')}.gz`)), '分块应原样搬 archived/ 留审计轨迹')
    }
    const g = (args: string[]) => execFileSync('git', ['-C', repo, '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf-8' })
    g(['checkout', '--', 'base.txt'])
    g(['apply', '--check', load.patchPath as string])
    g(['apply', load.patchPath as string])
    assert.equal(readFileSync(join(repo, 'base.txt'), 'utf-8'), `${noise.join('\n')}\n`, '重组补丁 apply 后应逐字节复原寄存时刻的未提交内容')
    const text = renderInbox(null, load).map((b) => b.text).join('\n')
    assert.ok(text.includes(`${chunkCount} 块已按序重组`), `取件文案应说明重组块数：${text}`)
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

test('旧纯文本 .patch 完全兼容：外来手放补丁不经 gzip 路径，原样归档且文案不出现 gzip 说明', () => {
  withHome((home) => {
    const id = 'ho-compat-0001'
    mkdirSync(join(home, 'pending'), { recursive: true })
    writeFileSync(join(home, 'pending', `${id}.md`), '---\nid: x\n---\n# 卡\n', 'utf-8') // 伴生 .md（活性判据）
    writeFileSync(join(home, 'pending', `${id}.patch`), 'diff --git a/old.txt b/old.txt\n--- /dev/null\n+++ b/old.txt\n@@ -0,0 +1 @@\n+old\n', 'utf-8')
    const load = inboxLoad(id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.patchFormat, undefined, '纯文本补丁不应带 gzip 形态标记')
    assert.equal(load.patchChunks, undefined)
    assert.equal(load.patchWarn, undefined)
    assert.ok(load.patchPath?.endsWith(`${id}.patch`), '旧格式原路径归档')
    assert.equal(readFileSync(load.patchPath as string, 'utf-8').includes('+old'), true, '内容原样保留')
    assert.ok(!existsSync(join(home, 'archived', `${id}.patch.gz`)), '不得凭空产出压缩块')
    const text = renderInbox(null, load).map((b) => b.text).join('\n')
    assert.ok(!text.includes('gzip'), `旧格式文案不得出现 gzip 说明：${text}`)
    assert.ok(text.includes('git apply --check'), '旧格式 apply 指引不变')
  })
})

test('writePatchSidecar 尺寸分档直测：≤512KB 纯文本 / gzip ≤512KB 单块 / gzip >512KB 按 480KB 等分', () => {
  withHome((home) => {
    mkdirSync(join(home, 'pending'), { recursive: true })
    // 纯文本档：≤512KB 原样落 .patch（旧格式零改动）
    const small = writePatchSidecar('ho-pack-0001', 'a'.repeat(1024), home)
    assert.equal(small.format, 'plain')
    assert.equal(small.chunks, 0)
    assert.equal(readFileSync(small.files[0] as string, 'utf-8'), 'a'.repeat(1024))
    // gzip 单块档：512KB+ 高冗余文本 → 压缩后远小于上限 → 单 .patch.gz
    const single = writePatchSidecar('ho-pack-0002', 'y'.repeat(PATCH_MAX_BYTES + 1024), home)
    assert.equal(single.format, 'gzip')
    assert.equal(single.chunks, 1)
    assert.deepEqual([...readFileSync(single.files[0] as string).subarray(0, 2)], [0x1f, 0x8b])
    // 分块档：近随机 hex → gzip 后仍 >512KB → 恰好按 480KB 等分，块序号从 001 起
    const noise = randomBytes(600 * 1024).toString('hex') // 1.2MB 文本，gzip ~0.5 比例仍超限
    const chunked = writePatchSidecar('ho-pack-0003', noise, home)
    assert.equal(chunked.format, 'gzip-chunked')
    assert.ok(chunked.chunks >= 2, `难压缩文本应分块：${chunked.chunks}`)
    assert.equal(chunked.files.length, chunked.chunks)
    let total = 0
    for (let i = 0; i < chunked.chunks; i++) {
      const st = readFileSync(chunked.files[i] as string)
      total += st.byteLength
      if (i < chunked.chunks - 1) assert.equal(st.byteLength, PATCH_CHUNK_BYTES, '非末块恒为 480KB')
      assert.ok(st.byteLength <= PATCH_CHUNK_BYTES, '每块 ≤480KB')
    }
    assert.equal(total, chunked.writtenBytes, '分块字节数守恒')
    // 拼接后一次 gunzip 还原原文（与取件侧 restoreGzipPatch 同口径）
    const merged = Buffer.concat(chunked.files.map((f) => readFileSync(f as string)))
    assert.equal(gunzipSync(merged).toString('utf-8'), noise, '分块拼接解压后必须逐字节还原原文')
  })
})

test('分块序号断档与坏 gzip：还原降级回 warn、压缩块原样归档，绝不静默丢材料', () => {
  withHome((home) => {
    mkdirSync(join(home, 'pending'), { recursive: true })
    mkdirSync(join(home, 'archived'), { recursive: true })
    // 断档（缺 002）：listPatchChunks 判损坏回 null
    writeFileSync(join(home, 'pending', 'ho-broken-0001.patch.001.gz'), Buffer.from([0x1f, 0x8b]))
    writeFileSync(join(home, 'pending', 'ho-broken-0001.patch.003.gz'), Buffer.from([0x1f, 0x8b]))
    assert.equal(listPatchChunks('ho-broken-0001', home), null, '序号断档按损坏处理')
    assert.equal(restoreGzipPatch('ho-broken-0001', home), undefined, '单块与合法分块都不在场 → undefined')
    // 连续序号但内容坏（缺 gzip magic）：压缩块原样归档 + warn，不产出假补丁
    writeFileSync(join(home, 'pending', 'ho-broken-0002.md'), '---\n---\n', 'utf-8')
    writeFileSync(join(home, 'pending', 'ho-broken-0002.patch.001.gz'), Buffer.from('not-gzip-at-all', 'utf-8'))
    writeFileSync(join(home, 'pending', 'ho-broken-0002.patch.002.gz'), Buffer.from([0x1f, 0x8b]))
    const bad = restoreGzipPatch('ho-broken-0002', home)
    assert.ok(bad?.warn, '坏 gzip 应回降级说明')
    assert.equal(bad?.path, undefined, '坏 gzip 不得产出可 apply 的假补丁')
    assert.ok(existsSync(join(home, 'archived', 'ho-broken-0002.patch.001.gz')), '坏块原样归档不销毁')
    assert.ok(existsSync(join(home, 'archived', 'ho-broken-0002.patch.002.gz')), '坏块原样归档不销毁')
    assert.ok(!existsSync(join(home, 'archived', 'ho-broken-0002.patch')), '不得凭空产出归档补丁')
  })
})
