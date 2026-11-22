/**
 * 记忆蒸馏闭环测试（0.26 · WS-2；0.26.1 侧车格式 v2）：hippo 13 字段 JSONL 快照的
 * 生产/随卡/导入三段。
 * 钉死的不变量：
 * - produceSnapshot runner 桩三态：成功 / 非零退出 / CLI 缺席——全部 fail-open 不抛异常，
 *   绝不拦出卡；runner 谎报成功但文件未落 = 导出失败（不造「已导出」假象）
 * - 侧车随卡 round-trip（v2 格式）：文件头 meta 行 version 2；13 字段**值级**逐字段
 *   不丢（v2 重编码：键序保留、值不改）；条目级 workspace（卡 cwd 归属）/weight
 *   （strength 推导，缺省 1）/section（四段账本透传）生产→搬移→读侧→absorb 全贯通；
 *   取件搬移 pending→archived 字节不变；搬移失败/缺席各有诚实态
 * - v1/v2 双兼容（回归钉）：v1 旧侧车（无 meta 无 v2 字段）absorb 照常；混合总线
 *   v1+v2 并存互不干扰；meta 行缺失按 v1 处理（版本归属跟 meta 行，不虚构 v2 事实）；
 *   幂等记账键不变（侧车 sha，v1/v2 同一机制）
 * - hippo import 对 v2 的兼容背书：dsh-hippo transfer.ts:114-146 只取已知字段（未知
 *   字段忽略）、缺 text 行按坏行跳过；0.3.0 CLI 实测（临时 HIPPO_DATA_DIR）：meta 行
 *   skipped 1、v2 条目全数入库、退出码 0——单测全走桩 runner，绝不真 spawn hippo
 * - distill 与扫描共用同一解析：约定路径 = MEMORY_STORES entriesFile 对扫描行的解析
 *   结果；runner env 钉 HIPPO_DATA_DIR=三级解析结果（hippo CLI 只认 env）
 * - hippoDataDir 三级解析链钉测（env / data-dir.txt / 回退三态 + 空值边界）+ 新增一态：
 *   data-dir.txt 缺席且回退 memories 也不在场 → exists:false（现状行为入册防回归）
 * - absorb target=hippo-db：confirm 缺省拒 + 计划回显零写盘；confirm 后 hippo import；
 *   takeover 侧按侧车 sha 记账幂等跳过；CLI 缺席/失败诚实报错退指引；侧车不在场
 *   诚实报错不假装导入过；记账失败 fail-open 不回滚导入
 * 全部走桩 runner（绝不真 spawn hippo）与临时目录，不碰真实 home 与真实数据目录。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateId, MAX_CARD_BYTES } from '@agent-handoff/core'
import { absorbCard, renderAbsorb } from '../src/absorb.ts'
import {
  DISTILL_SIDECAR_VERSION,
  consumeDistillSidecar,
  hippoEntriesFile,
  hippoImportRun,
  hippoLedgerPath,
  locateHippoSidecar,
  parseSidecarMeta,
  produceSnapshot,
  readHippoLedger,
  readSidecarEntriesV2,
  readSidecarFacts,
  recordHippoLedger,
  toV2Sidecar,
  type HippoRunner,
} from '../src/distill.ts'
import { MEMORY_STORES, hippoDataDir, pushMemoryCard, scanMemorySources, type MemorySourceRow } from '../src/memory.ts'
import { inboxLoad, pushHandoff } from '../src/tools.ts'
import { readLifecycleEvents } from '../src/lifecycle.ts'

// ---------- 通用桩与夹具 ----------

function rmRf(p: string): void {
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-td-${label}-`))
}

const HIPPO_ENV_KEYS = ['HIPPO_DATA_DIR'] as const

/** 保存/恢复 hippo 相关环境变量（数据目录解析读 process.env，测试定环境用） */
function withHippoEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map(HIPPO_ENV_KEYS.map((k) => [k, process.env[k]]))
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** 全树内容指纹（relPath（正斜杠）→ sha256）：零写盘断言的基准（writeback.spec 同款） */
function treeMap(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (rel: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(join(root, rel))
    } catch {
      return
    }
    for (const e of entries) {
      const child = rel === '' ? e : `${rel}/${e}`
      const st = statSync(join(root, child))
      if (st.isDirectory()) walk(child)
      else out.set(child.split('\\').join('/'), createHash('sha256').update(readFileSync(join(root, child))).digest('hex'))
    }
  }
  walk('')
  return out
}

/** hippo export 的 13 字段（dsh-hippo transfer.ts EXPORT_FIELDS 原样清单） */
const HIPPO_13_FIELDS = [
  'text', 'type', 'project', 'agent', 'created_at', 'accessed_at', 'strength',
  'source_id', 'source_offset', 'superseded_by', 'superseded_at', 'lifecycle', 'verify',
] as const

/** 两条 13 字段全字段记录（含 supersede 链与 provenance，覆盖字段类型面） */
const FIX_RECORDS: Array<Record<string, unknown>> = [
  {
    text: '偏好中文回复', type: 'preference', project: 'global', agent: 'claude',
    created_at: 1737000000000, accessed_at: 1737000001000, strength: 3,
    source_id: '', source_offset: -1, superseded_by: '', superseded_at: 0,
    lifecycle: 'proven', verify: 'npm test',
  },
  {
    text: '蒸馏条目：登录页报错先看适配器', type: 'lesson', project: 'dsh-takeover', agent: 'dsh',
    created_at: 1737000010000, accessed_at: 1737000011000, strength: 1,
    source_id: 'blob-abc', source_offset: 42, superseded_by: 'ho-newer', superseded_at: 1737000020000,
    lifecycle: 'trial', verify: '',
  },
]
const FIX_JSONL = `${FIX_RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`

interface RunnerCall {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/** export 桩：模拟 `hippo export -f jsonl -o <约定路径>` 落盘（hippo 自己建库目录，桩同款建父目录） */
function exportStub(jsonl: string): { runner: HippoRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = []
  const runner: HippoRunner = (file, args, opts) => {
    calls.push({ file, args, env: opts.env })
    const o = args[args.indexOf('-o') + 1]
    if (typeof o !== 'string' || o === '') throw new Error('export 桩：缺 -o 参数')
    mkdirSync(dirname(o), { recursive: true })
    writeFileSync(o, jsonl, 'utf-8')
    return `exported ${jsonl.trim().split('\n').length} memories -> ${o}`
  }
  return { runner, calls }
}

/** import 桩：内存 hippo 库（text 去重 → created/reinforced 计数，模拟 dedup-reinforce 语义） */
function importStub(): { runner: HippoRunner; calls: RunnerCall[]; created: () => number; reinforced: () => number; storeSize: () => number } {
  const store = new Set<string>()
  const calls: RunnerCall[] = []
  let created = 0
  let reinforced = 0
  const runner: HippoRunner = (file, args, opts) => {
    calls.push({ file, args, env: opts.env })
    const f = args[args.indexOf('import') + 1]
    if (typeof f !== 'string' || f === '') throw new Error('import 桩：缺文件参数')
    for (const line of readFileSync(f, 'utf-8').split('\n')) {
      const t = line.trim()
      if (t === '') continue
      const o = JSON.parse(t) as { text?: unknown }
      const text = typeof o.text === 'string' ? o.text : ''
      if (text === '') continue
      if (store.has(text)) reinforced += 1
      else {
        store.add(text)
        created += 1
      }
    }
    return `import done: ${created} created, ${reinforced} reinforced (merged), 0 skipped`
  }
  return { runner, calls, created: () => created, reinforced: () => reinforced, storeSize: () => store.size }
}

const fakeRow = (path: string): MemorySourceRow => ({
  key: 'claude-user', agent: 'Claude Code', path, exists: true,
  bytes: 1, mtime: '2026-11-19T00:00:00.000Z', preview: '',
})

/** 定 cwd 执行并回传结果（出卡会从 process.cwd() 采 git 补丁——本仓共享工作树常有他人
 * 未提交改动，测试夹具必须与仓库脏净解耦：chdir 进非 git 临时目录，补丁采集自然为空） */
function withCwd<T>(dir: string, fn: () => T): T {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return fn()
  } finally {
    process.chdir(prev)
  }
}

/** 出一张真 memory 轴卡并取件归档（pushHandoff 全纪律 + inboxLoad 两步语义第一步），返回卡 id */
function makeArchivedMemoryCard(handoff: string): string {
  const src = tmpDir('cardsrc')
  try {
    mkdirSync(join(src, '.claude'), { recursive: true })
    writeFileSync(join(src, '.claude', 'CLAUDE.md'), '吸收 fixture：偏好 bun。\n', 'utf-8')
    const scan = (): MemorySourceRow[] => [fakeRow(join(src, '.claude', 'CLAUDE.md'))]
    return withCwd(src, (): string => {
      const r = pushMemoryCard({ keys: ['claude-user'] }, { dir: handoff, scan })
      if (!r.ok) throw new Error(`出卡失败：${r.error}`)
      const load = inboxLoad(r.id, { dir: handoff })
      if (!load.ok) throw new Error(`取件失败：${load.error}`)
      return r.id
    })
  } finally {
    rmRf(src)
  }
}

/** 完整链路夹具：出真 memory 轴卡 + 生产侧车（stub export）+ 取件（.md 走 inboxLoad、
 * 侧车走 consumeDistillSidecar——该搬移接线归集成面，测试显式调用补完取件语义） */
function makeArchivedCardWithSidecar(handoff: string, jsonl: string): string {
  const id = makeArchivedMemoryCard(handoff)
  const home = tmpDir('fixture-home')
  try {
    const { runner } = exportStub(jsonl)
    const produced = produceSnapshot({ cardId: id, runner, home, dir: handoff })
    if (!produced.ok) throw new Error(`侧车生产失败：${produced.note}`)
    if (produced.sidecar === undefined) throw new Error(`侧车未随卡：${produced.note}`)
  } finally {
    rmRf(home)
  }
  // inboxLoad 已搬 .md；侧车搬移在集成面接线前由本测试显式补完（consumeDistillSidecar 同位语义）
  const moved = consumeDistillSidecar(id, handoff)
  if (moved.state !== 'moved') throw new Error(`侧车搬移态异常：${JSON.stringify(moved)}`)
  return id
}

// ---------- A. produceSnapshot：runner 桩三态 + 谎报防线 ----------

test('produceSnapshot：runner 成功——条目计数、v2 侧车随卡（meta version 2 + weight 推导）、note 如实', () => {
  const home = tmpDir('a-home')
  const handoff = tmpDir('a-handoff')
  const cardId = generateId()
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const { runner, calls } = exportStub(FIX_JSONL)
      const r = produceSnapshot({ cardId, runner, home, dir: handoff })
      assert.equal(r.ok, true, r.ok ? '' : `应成功：${r.note}`)
      if (!r.ok) return
      assert.equal(r.entries, 2, '有效条目数按 readStoreEntries 同口径解析')
      assert.equal(r.bytes, Buffer.byteLength(FIX_JSONL, 'utf-8'))
      assert.equal(r.sidecar, join(handoff, 'pending', `${cardId}.hippo.jsonl`), '侧车落 pending/（与卡同屋）')
      assert.ok(existsSync(r.sidecar))
      assert.match(r.note, /v2 快照侧车随卡/)
      assert.match(r.note, /2 条条目/)
      assert.equal(r.sidecarBytes, Buffer.byteLength(readFileSync(r.sidecar, 'utf-8'), 'utf-8'), 'sidecarBytes = 侧车实际字节')
      // v2 侧车内容：meta 行在文件头（version 2、条目数对齐；未给 cwd → 不带 workspace）
      const sidecarRaw = readFileSync(r.sidecar, 'utf-8')
      const meta = parseSidecarMeta(sidecarRaw)
      assert.ok(meta, 'meta 行应可解析')
      assert.equal(meta?.version, DISTILL_SIDECAR_VERSION)
      assert.equal(meta?.entries, 2)
      assert.equal(meta?.workspace, undefined, '未给 cwd：meta 不带 workspace')
      assert.ok(meta?.at !== '', 'meta.at 在场')
      // 条目行：weight 由 strength 推导；未给 cwd → 无 workspace；源无 section → 无 section
      const es = readSidecarEntriesV2(sidecarRaw)
      assert.equal(es.length, 2)
      assert.equal(es[0]?.weight, 3, 'weight = strength（使用/强化计数）')
      assert.equal(es[1]?.weight, 1)
      assert.ok(es.every((e) => e.workspace === undefined), '未给 cwd：条目不带 workspace')
      assert.ok(es.every((e) => e.section === undefined), '源无 section：条目不带 section')
      // runner 收到的调用形态：hippo export -f jsonl -o <约定路径>，env 钉数据目录
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.file, 'hippo')
      assert.deepEqual(calls[0]?.args, ['export', '-f', 'jsonl', '-o', r.entriesFile])
      assert.equal(calls[0]?.env?.['HIPPO_DATA_DIR'], hippoDataDir(home))
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('produceSnapshot runner 三态：非零退出 / CLI 缺席各有两态文案且 fail-open 不抛', () => {
  const home = tmpDir('b-home')
  const handoff = tmpDir('b-handoff')
  const cardId = generateId()
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      // 非零退出（execFileSync 对非零退出抛带 status 的 Error）
      const fail = Object.assign(new Error('Command failed: hippo export'), { status: 1 })
      const r1 = produceSnapshot({ cardId, runner: () => { throw fail }, home, dir: handoff })
      assert.equal(r1.ok, false, '非零退出必须 fail-open 回 ok:false（不拦出卡）')
      if (!r1.ok) {
        assert.equal(r1.state, 'export-failed')
        assert.match(r1.note, /hippo export 失败/)
        assert.match(r1.note, /hippo export -f jsonl/, '手动补救命令在文案里')
      }
      // CLI 缺席（spawn ENOENT）
      const missing = Object.assign(new Error('spawn hippo ENOENT'), { code: 'ENOENT' })
      const r2 = produceSnapshot({ cardId, runner: () => { throw missing }, home, dir: handoff })
      assert.equal(r2.ok, false)
      if (!r2.ok) {
        assert.equal(r2.state, 'cli-missing', 'ENOENT 归为「未装 CLI」态')
        assert.match(r2.note, /未装 hippo CLI/)
      }
      assert.ok(!existsSync(join(handoff, 'pending', `${cardId}.hippo.jsonl`)), '失败路径不出侧车')
      // runner 谎报成功但约定文件未落盘 = 导出失败（不造「已导出」假象）
      const r3 = produceSnapshot({ cardId, runner: () => 'ok', home, dir: handoff })
      assert.equal(r3.ok, false)
      if (!r3.ok) {
        assert.equal(r3.state, 'export-failed')
        assert.match(r3.note, /未落盘/)
      }
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

// ---------- B. 侧车随卡与取件搬移 round-trip（13 字段逐字段） ----------

test('侧车随卡与取件搬移 round-trip（v2）：meta 行 + 13 字段值级逐字段不丢 + 搬移字节不变', () => {
  const home = tmpDir('c-home')
  const handoff = tmpDir('c-handoff')
  const cardId = generateId()
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const { runner } = exportStub(FIX_JSONL)
      const r = produceSnapshot({ cardId, runner, home, dir: handoff })
      assert.equal(r.ok, true)
      if (!r.ok || r.sidecar === undefined) return
      const pendingSidecar = join(handoff, 'pending', `${cardId}.hippo.jsonl`)
      const pendingRaw = readFileSync(pendingSidecar, 'utf-8')
      assert.equal(parseSidecarMeta(pendingRaw)?.version, DISTILL_SIDECAR_VERSION, '文件头 meta 行 version 2')
      // 逐行逐字段断言：13 字段名与值全数保留（v2 重编码：键序保留、值不改）
      const lines = pendingRaw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      assert.equal(lines.length, 3, 'meta 行 + 2 条条目')
      assert.equal('text' in (lines[0] ?? {}), false, '首行是 meta 不是条目（无 text）')
      for (const [i, rec] of FIX_RECORDS.entries()) {
        const got = lines[i + 1]
        assert.ok(got, `条目 ${i + 1} 应存在`)
        if (!got) continue
        for (const f of HIPPO_13_FIELDS) {
          assert.ok(f in got, `条目 ${i + 1} 缺字段 ${f}`)
          assert.deepEqual(got[f], rec[f], `条目 ${i + 1} 字段 ${f} 值不丢`)
        }
        // v2 富集：weight 由 strength 推导；未给 cwd/源无 section → 对应字段不伪造
        assert.equal(got['weight'], rec['strength'], 'weight 由 strength 推导')
        assert.equal('workspace' in got, false, '未给 cwd 不带 workspace')
        assert.equal('section' in got, false, '源无 section 不带 section')
        assert.equal(Object.keys(got).length, 14, `条目 ${i + 1} = 13 字段 + weight`)
      }
      // 取件搬移：pending → archived，字节逐字节不变（rename 语义）；搬后 pending 不再持有
      const moved = consumeDistillSidecar(cardId, handoff)
      assert.deepEqual(moved, {
        state: 'moved',
        path: join(handoff, 'archived', `${cardId}.hippo.jsonl`),
        bytes: Buffer.byteLength(pendingRaw, 'utf-8'),
      })
      assert.equal(readFileSync(join(handoff, 'archived', `${cardId}.hippo.jsonl`), 'utf-8'), pendingRaw, '搬移字节逐字节不变')
      assert.ok(!existsSync(pendingSidecar), 'pending 侧车搬走后不在')
      // 再搬一次 = absent（幂等无副作用）；非法 id 同样 absent（不出路径）
      assert.equal(consumeDistillSidecar(cardId, handoff).state, 'absent')
      assert.equal(consumeDistillSidecar('../evil', handoff).state, 'absent')
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('consumeDistillSidecar：搬移失败回 move-failed 态（侧车留 pending，不吞异常不假装搬走）', () => {
  const handoff = tmpDir('d-handoff')
  const cardId = generateId()
  try {
    mkdirSync(join(handoff, 'pending'), { recursive: true })
    writeFileSync(join(handoff, 'pending', `${cardId}.hippo.jsonl`), FIX_JSONL, 'utf-8')
    // archived 位被同名文件占用 → rename 目标路径非法 → 搬移失败
    writeFileSync(join(handoff, 'archived'), 'not a dir', 'utf-8')
    const moved = consumeDistillSidecar(cardId, handoff)
    assert.equal(moved.state, 'move-failed')
    if (moved.state === 'move-failed') {
      assert.match(moved.error, /搬移失败/)
    }
    assert.ok(existsSync(join(handoff, 'pending', `${cardId}.hippo.jsonl`)), '侧车留 pending（取件主流程不受影响）')
  } finally {
    rmRf(handoff)
  }
})

// ---------- C. data-dir 解析链钉测 + distill 与扫描共用同一解析 ----------

test('hippoDataDir 三级解析链钉测：env > data-dir.txt > 回退 ~/.hippo（含空值边界）', () => {
  const tmp = tmpDir('e-chain')
  try {
    withHippoEnv({ HIPPO_DATA_DIR: join(tmp, 'envdir') }, () => {
      assert.equal(hippoDataDir(tmp), join(tmp, 'envdir'), 'env 最优先')
      // env 优先于 data-dir.txt（两者同在时）
      mkdirSync(join(tmp, '.hippo'), { recursive: true })
      writeFileSync(join(tmp, '.hippo', 'data-dir.txt'), `${join(tmp, 'txtdir')}\n`)
      assert.equal(hippoDataDir(tmp), join(tmp, 'envdir'))
    })
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      assert.equal(hippoDataDir(tmp), join(tmp, 'txtdir'), 'data-dir.txt 内容生效（次优先）')
      // env 空白视同未设（trim 口径）
      withHippoEnv({ HIPPO_DATA_DIR: '   ' }, () => {
        assert.equal(hippoDataDir(tmp), join(tmp, 'txtdir'), 'env 空白 = 未配置')
      })
      // data-dir.txt 空白内容视同未配置 → 回退 ~/.hippo
      writeFileSync(join(tmp, '.hippo', 'data-dir.txt'), '   \n')
      assert.equal(hippoDataDir(tmp), join(tmp, '.hippo'), 'data-dir.txt 空白 = 回退')
    })
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      // 全缺（无 env、无 data-dir.txt）→ 回退 ~/.hippo
      rmSync(join(tmp, '.hippo'), { recursive: true, force: true })
      assert.equal(hippoDataDir(tmp), join(tmp, '.hippo'))
    })
  } finally {
    rmRf(tmp)
  }
})

test('扫描新增一态钉：data-dir.txt 缺席且回退 memories 也不在场 → exists:false（现状入册防回归，非待修 bug）', () => {
  const tmp = tmpDir('e-none') // 完全空的 home：.hippo 目录整体不在场
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const rows = scanMemorySources({ home: tmp })
      const hippo = rows.find((r) => r.key === 'hippo-db')
      assert.ok(hippo, 'hippo-db 行恒在清单（存在性如实，行不消失）')
      assert.equal(hippo?.exists, false, '数据目录整体缺席 → exists:false（statSync 落 catch 的现状行为）')
      assert.equal(hippo?.bytes, 0)
      assert.equal(hippo?.mtime, '')
      assert.equal(hippo?.preview, '')
      assert.match(hippo?.path ?? '', /[\\/]\.hippo[\\/]memories$/, '回退解析仍指向 ~/.hippo/memories')
    })
  } finally {
    rmRf(tmp)
  }
})

test('distill 与扫描共用同一解析：约定路径 = MEMORY_STORES 对扫描行的解析、env 钉同一数据目录', () => {
  const home = tmpDir('f-shared')
  try {
    mkdirSync(join(home, '.hippo', 'memories'), { recursive: true })
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const { runner, calls } = exportStub(FIX_JSONL)
      const r = produceSnapshot({ runner, home, dir: home }) // 不给卡 id：只导出约定路径不出侧车
      assert.equal(r.ok, true)
      if (!r.ok) return
      const row = scanMemorySources({ home }).find((x) => x.key === 'hippo-db')
      assert.ok(row, '扫描应有 hippo-db 行（memories 目录在场）')
      if (!row) return
      const store = MEMORY_STORES.find((s) => s.id === 'hippo-db')
      assert.ok(store, 'hippo store 应在 MEMORY_STORES 注册表')
      const fromScan = store?.entriesFile?.(row)
      assert.ok(fromScan, '注册表应能从扫描行解析约定路径')
      assert.equal(r.entriesFile, fromScan, 'distill 落盘路径 = 扫描/出卡组装的同一约定路径（不重复实现）')
      assert.equal(r.dataDir, hippoDataDir(home))
      assert.equal(hippoEntriesFile(hippoDataDir(home)), fromScan, 'hippoEntriesFile 纯函数与二者一致')
      // 未给卡 id：只导出约定路径
      assert.equal(r.sidecar, undefined)
      assert.match(r.note, /未给卡 id/)
      assert.equal(calls[0]?.env?.['HIPPO_DATA_DIR'], hippoDataDir(home), 'runner env 钉住与扫描同一数据目录')
    })
  } finally {
    rmRf(home)
  }
})

test('guidance 两态文案：区分「未装 hippo CLI」与「CLI 在场但导出失败」，CLI 通路指引用词保留', () => {
  const store = MEMORY_STORES.find((s) => s.id === 'hippo-db')
  assert.ok(store, 'hippo store 在册')
  if (!store) return
  assert.match(store.guidance, /hippo export -f jsonl/, 'export 通路指引在（memory.spec 行为钉同款）')
  assert.match(store.guidance, /hippo import/, 'import 通路指引在')
  assert.match(store.guidance, /未装 hippo CLI/, '第一态：未装 CLI')
  assert.match(store.guidance, /导出失败/, '第二态：CLI 在场但导出失败')
})

// ---------- D. 尺寸闸 oversize ----------

test('尺寸闸 oversize：快照超 MAX_CARD_BYTES 侧车不随卡 + lifecycle oversize 留痕 + 导出本身不受影响', () => {
  const home = tmpDir('g-home')
  const handoff = tmpDir('g-handoff')
  const cardId = generateId()
  try {
    // 两条各 ~4.2MB text 的合法 JSONL（总字节 > 8MiB），条目解析照常可计
    const mkLine = (text: string): string => JSON.stringify({
      text, type: 'fact', project: 'global', agent: 'a', created_at: 1, accessed_at: 1,
      strength: 1, source_id: '', source_offset: -1, superseded_by: '', superseded_at: 0,
      lifecycle: 'proven', verify: '',
    })
    const bigText = 'x'.repeat(4 * 1024 * 1024 + 1024)
    const bigJsonl = `${mkLine(bigText)}\n${mkLine(`${bigText}-2`)}\n`
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const { runner } = exportStub(bigJsonl)
      const r = produceSnapshot({ cardId, runner, home, dir: handoff, now: new Date('2026-11-19T00:00:00.000Z') })
      assert.equal(r.ok, true, '导出成功本身不因尺寸闸失败')
      if (!r.ok) return
      assert.equal(r.entries, 2)
      assert.ok(r.bytes > MAX_CARD_BYTES, `夹具须真超限：${r.bytes} > ${MAX_CARD_BYTES}`)
      assert.equal(r.sidecar, undefined, '超限侧车不随卡')
      assert.match(r.note, /超 MAX_CARD_BYTES/)
      assert.ok(!existsSync(join(handoff, 'pending', `${cardId}.hippo.jsonl`)), '侧车确实未落')
      // oversize 留痕（闭集既有理由，target = 卡 id）
      const ev = readLifecycleEvents(handoff).find((e) => e.reason === 'oversize')
      assert.ok(ev, 'oversize 事件应在账本')
      assert.equal(ev?.stage, 'write')
      assert.equal(ev?.target, cardId)
      assert.match(ev?.detail ?? '', /hippo 侧车/)
      assert.match(ev?.detail ?? '', /v2/, 'oversize 留痕如实标注 v2 侧车（闸算在 v2 实际字节上）')
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

// ---------- E. absorb target=hippo-db：confirm 闸 / 导入 / 幂等 / 诚实降级 ----------

test('absorb hippo-db：confirm 缺省一律拒绝——计划回显（侧车/条数/命令/幂等分层）、零写盘、不调 CLI', () => {
  const home = tmpDir('h-home')
  const handoff = tmpDir('h-handoff')
  try {
    const id = makeArchivedCardWithSidecar(handoff, FIX_JSONL)
    const stub = importStub()
    const before = treeMap(handoff)
    const r = absorbCard({ id, target: 'hippo-db' }, { dir: handoff, home, runner: stub.runner })
    assert.equal(r.ok, false, '缺 confirm 必须拒绝')
    if (r.ok) return
    // 计划回显：目标数据目录、侧车路径与条数、命令、幂等说明、confirm 指引
    assert.match(r.error, /confirm: true/)
    assert.match(r.error, /将导入/)
    assert.match(r.error, /hippo import /)
    assert.match(r.error, /2 条条目/)
    assert.match(r.error, /dedup-reinforce/)
    assert.match(r.error, /未写任何盘/)
    assert.match(r.error, /推翻链（supersede）以 hippo 侧为准/)
    // 零写盘：HANDOFF_HOME 全树指纹不变（含 lifecycle）；CLI 桩零调用
    assert.deepEqual(treeMap(handoff), before, '拒绝路径不得写任何盘')
    assert.equal(stub.calls.length, 0, 'confirm 闸前不执行导入')
    // confirm:false 同样拒绝
    const r2 = absorbCard({ id, target: 'hippo-db', confirm: false }, { dir: handoff, home, runner: stub.runner })
    assert.equal(r2.ok, false, 'confirm:false 同样必须拒绝')
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('absorb hippo-db：confirm 落地——hippo import 执行（env 钉数据目录）、absorbed-write 留痕、记账本落 sha', () => {
  const home = tmpDir('i-home')
  const handoff = tmpDir('i-handoff')
  try {
    mkdirSync(join(home, '.hippo'), { recursive: true })
    const id = makeArchivedCardWithSidecar(handoff, FIX_JSONL)
    const stub = importStub()
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const r = absorbCard({ id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r.ok, true, r.ok ? '' : r.error)
      // 收窄到 hippo 结果面（ok:true 双成员并集，target 是 string 判别不了，用独有字段收窄）
      if (!r.ok || !('sidecar' in r)) return
      assert.equal(r.target, 'hippo-db')
      assert.equal(r.repeat, false)
      assert.equal(r.entries, 2)
      assert.equal(r.agent, 'dsh-hippo 记忆库')
      assert.equal(r.sidecar, join(handoff, 'archived', `${id}.hippo.jsonl`))
      assert.equal(r.dataDir, hippoDataDir(home))
      // CLI 调用形态：hippo import <archived 侧车>，env 钉与解析一致的数据目录
      assert.equal(stub.calls.length, 1)
      assert.equal(stub.calls[0]?.file, 'hippo')
      assert.deepEqual(stub.calls[0]?.args, ['import', join(handoff, 'archived', `${id}.hippo.jsonl`)])
      assert.equal(stub.calls[0]?.env?.['HIPPO_DATA_DIR'], hippoDataDir(home))
      assert.equal(stub.created(), 2, '桩内 2 条全部入库')
      // lifecycle absorbed-write（闭集既有理由，detail 记导入口径）
      const ev = readLifecycleEvents(handoff).find((e) => e.reason === 'absorbed-write')
      assert.ok(ev, 'absorbed-write 事件应在账本')
      assert.equal(ev?.stage, 'write')
      assert.equal(ev?.target, id)
      assert.match(ev?.detail ?? '', /hippo import 导入 2 条/)
      // 记账本：侧车 sha 对得上（takeover 侧同卡幂等凭据）
      const sidecarContent = readFileSync(join(handoff, 'archived', `${id}.hippo.jsonl`), 'utf-8')
      const ledger = readHippoLedger(handoff)
      assert.equal(ledger[id]?.sha256, createHash('sha256').update(sidecarContent, 'utf-8').digest('hex'))
      assert.ok(existsSync(hippoLedgerPath(handoff)), '记账本落 archived/absorb-backup/')
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('absorb hippo-db 幂等：同卡二次 absorb 按 sha 跳过（不再调 CLI、不重复留痕）；桩内重复条目 = 强化合并计数', () => {
  const home = tmpDir('j-home')
  const handoff = tmpDir('j-handoff')
  try {
    mkdirSync(join(home, '.hippo'), { recursive: true })
    const id = makeArchivedCardWithSidecar(handoff, FIX_JSONL)
    const stub = importStub()
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const r1 = absorbCard({ id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r1.ok, true)
      if (!r1.ok) return
      // takeover 侧幂等：二次 absorb → repeat:true、runner 不再调、事件不重复
      const r2 = absorbCard({ id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r2.ok, true)
      if (!r2.ok || !('sidecar' in r2)) return
      assert.equal(r2.repeat, true, '重复 absorb 必须按记账 sha 跳过')
      assert.equal(stub.calls.length, 1, '跳过路径不再调 CLI')
      assert.match(r2.detail, /已导入过/)
      assert.equal(readLifecycleEvents(handoff).filter((e) => e.reason === 'absorbed-write').length, 1, '不重复留痕')
      // hippo 层幂等（模拟记账缺失时的重复导入）：同侧车再跑一次 import → 全部强化合并、0 新建
      const info = locateHippoSidecar(id, { dir: handoff, home })
      assert.ok(!('error' in info), '侧车应可定位')
      if ('error' in info) return
      const run2 = hippoImportRun(info, { runner: stub.runner })
      assert.equal(run2.ok, true)
      assert.equal(stub.calls.length, 2)
      assert.equal(stub.created(), 2, '重复导入不新建（dedup-reinforce 语义由 hippo 承担）')
      assert.equal(stub.reinforced(), 2, '重复条目全部强化合并计数')
      assert.equal(stub.storeSize(), 2, '库内不重复')
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('absorb hippo-db：CLI 缺席诚实报错退指引——零记账、零事件、零写盘（现状降级底座）', () => {
  const home = tmpDir('k-home')
  const handoff = tmpDir('k-handoff')
  try {
    const id = makeArchivedCardWithSidecar(handoff, FIX_JSONL)
    const runner: HippoRunner = () => {
      throw Object.assign(new Error('spawn hippo ENOENT'), { code: 'ENOENT' })
    }
    const before = treeMap(handoff)
    const r = absorbCard({ id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner })
    assert.equal(r.ok, false, 'CLI 缺席必须诚实报错')
    if (r.ok) return
    assert.match(r.error, /未装 hippo CLI/)
    assert.match(r.error, /hippo import /, '手动通路指引保留')
    assert.match(r.error, /幂等/)
    assert.equal(readHippoLedger(handoff)[id], undefined, '失败不记账')
    assert.equal(readLifecycleEvents(handoff).filter((e) => e.reason === 'absorbed-write').length, 0, '失败不留正向回执')
    assert.deepEqual(treeMap(handoff), before, '失败路径零写盘（侧车原样保留可重试）')
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('absorb hippo-db：import 非零退出诚实报错——侧车保留、零记账、可重试', () => {
  const home = tmpDir('l-home')
  const handoff = tmpDir('l-handoff')
  try {
    const id = makeArchivedCardWithSidecar(handoff, FIX_JSONL)
    const runner: HippoRunner = () => {
      throw Object.assign(new Error('Command failed: hippo import'), { status: 1 })
    }
    const before = treeMap(handoff)
    const r = absorbCard({ id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.error, /hippo import 失败/)
    assert.match(r.error, /重试/)
    assert.equal(readHippoLedger(handoff)[id], undefined)
    assert.deepEqual(treeMap(handoff), before, '失败路径零写盘')
    assert.ok(existsSync(join(handoff, 'archived', `${id}.hippo.jsonl`)), '侧车原样保留（未假装导入过）')
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('absorb hippo-db：侧车不在场诚实报错（zvec 口径 + 不假装导入过）+ 未取件/非 memory 轴先拒', () => {
  const home = tmpDir('m-home')
  const handoff = tmpDir('m-handoff')
  const src = tmpDir('m-src')
  try {
    mkdirSync(join(home, '.hippo'), { recursive: true })
    const stub = importStub()
    mkdirSync(join(src, '.claude'), { recursive: true })
    writeFileSync(join(src, '.claude', 'CLAUDE.md'), 'pending 态的一条。\n', 'utf-8')
    const scan = (): MemorySourceRow[] => [fakeRow(join(src, '.claude', 'CLAUDE.md'))]
    // 未取件：卡还在 pending/ → 两步语义第一步未完成
    const pushed = withCwd(src, () => pushMemoryCard({ keys: ['claude-user'] }, { dir: handoff, scan }))
    assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.error)
    if (!pushed.ok) return
    const pend = absorbCard({ id: pushed.id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
    assert.equal(pend.ok, false)
    if (!pend.ok) assert.match(pend.error, /先 handoff_inbox action=load/)
    // 取件后（无侧车）：诚实报错——zvec 引擎目录不按文件写回（T8），不静默假装导入过
    inboxLoad(pushed.id, { dir: handoff })
    const noSidecar = absorbCard({ id: pushed.id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
    assert.equal(noSidecar.ok, false)
    if (!noSidecar.ok) {
      assert.match(noSidecar.error, /zvec/, '引擎目录口径在文案里（既有 writeback 钉语义兼容）')
      assert.match(noSidecar.error, /不静默假装导入过/)
      assert.match(noSidecar.error, /重新出卡/, '回源机重出的指引在')
    }
    // 非 memory 轴卡（会话卡 + 手放侧车）→ axis 闸先拒（侧车在也不放行）
    const sess = withCwd(src, () => pushHandoff(null, { goal: '会话轴 hippo 闸验证', done: '手写完成项（HISTORY_REPORTED）', remaining: 'r', stopped: 's', warnings: 'w', title: '会话卡' }, { dir: handoff }))
    assert.equal(sess.ok, true, sess.ok ? '' : sess.error)
    if (!sess.ok) return
    inboxLoad(sess.id, { dir: handoff })
    writeFileSync(join(handoff, 'archived', `${sess.id}.hippo.jsonl`), FIX_JSONL, 'utf-8')
    const notMem = absorbCard({ id: sess.id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
    assert.equal(notMem.ok, false)
    if (!notMem.ok) assert.match(notMem.error, /非 memory 轴卡/)
    assert.equal(stub.calls.length, 0, '以上路径都不执行导入')
  } finally {
    rmRf(home)
    rmRf(handoff)
    rmRf(src)
  }
})

test('absorb hippo-db：侧车 sha 变化 → 重新导入并更新记账；记账写失败 fail-open 导入仍生效', () => {
  const home = tmpDir('n-home')
  const handoff = tmpDir('n-handoff')
  try {
    mkdirSync(join(home, '.hippo'), { recursive: true })
    const id = makeArchivedCardWithSidecar(handoff, FIX_JSONL)
    const stub = importStub()
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const r1 = absorbCard({ id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r1.ok, true)
      if (!r1.ok) return
      // 侧车内容变化（sha 变了）→ 计划回显说明将重新导入；confirm 后真的重导并更新记账
      const sidecar = join(handoff, 'archived', `${id}.hippo.jsonl`)
      writeFileSync(sidecar, `${FIX_JSONL}${JSON.stringify({ text: '新增的一条', type: 'fact', project: 'global', agent: 'a', created_at: 9, accessed_at: 9, strength: 1, source_id: '', source_offset: -1, superseded_by: '', superseded_at: 0, lifecycle: 'proven', verify: '' })}\n`, 'utf-8')
      const plan = absorbCard({ id, target: 'hippo-db' }, { dir: handoff, home, runner: stub.runner })
      assert.equal(plan.ok, false)
      if (!plan.ok) assert.match(plan.error, /侧车 sha 变了/, '计划回显如实说明 sha 变化')
      const r2 = absorbCard({ id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r2.ok, true)
      if (!r2.ok || !('sidecar' in r2)) return
      assert.equal(r2.repeat, false, 'sha 变了不算已导入')
      assert.equal(r2.entries, 3)
      assert.equal(stub.calls.length, 2, '重新导入真的跑了 CLI')
      const ledger = readHippoLedger(handoff)[id]
      const newContent = readFileSync(sidecar, 'utf-8')
      assert.equal(ledger?.sha256, createHash('sha256').update(newContent, 'utf-8').digest('hex'), '记账更新为新 sha')
      assert.equal(ledger?.entries, 3)
      // 记账写失败 fail-open：absorb-backup 位被文件占用 → 导入仍 ok、附注如实带回
      rmSync(join(handoff, 'archived', 'absorb-backup'), { recursive: true, force: true })
      writeFileSync(join(handoff, 'archived', 'absorb-backup'), 'not a dir', 'utf-8')
      const r3 = absorbCard({ id, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r3.ok, true, '记账失败不拦导入结果（fail-open）')
      if (!r3.ok) return
      assert.match(r3.detail, /导入记账失败/, '诚实附注：下次会再跑一遍 CLI')
      const ev = readLifecycleEvents(handoff).filter((e) => e.reason === 'absorbed-write').at(-1)
      assert.ok(ev, '事件仍留痕')
      assert.match(ev?.detail ?? '', /记账失败|已记账|导入记账失败/)
      assert.equal(stub.calls.length, 3)
      assert.equal(stub.created(), 3, '第三条新增条目入库')
      assert.equal(stub.reinforced(), 5, '桩计数为累计口径：第 2 轮强化 2 条 + 第 3 轮全量强化 3 条（dedup-reinforce）')
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('produceSnapshot：非法卡 id 不出侧车（导出照常，防御降级）；recordHippoLedger/readHippoLedger 往返', () => {
  const home = tmpDir('o-home')
  const handoff = tmpDir('o-handoff')
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const { runner } = exportStub(FIX_JSONL)
      const r = produceSnapshot({ cardId: '../evil', runner, home, dir: handoff })
      assert.equal(r.ok, true, '侧车环节失败不拦导出结果')
      if (!r.ok) return
      assert.equal(r.sidecar, undefined)
      assert.match(r.note, /非法/)
      assert.ok(!existsSync(join(handoff, 'pending')), '非法 id 不落任何盘')
      // 记账本读写往返（坏账本回空账的降级形态顺带钉住）
      mkdirSync(dirname(hippoLedgerPath(handoff)), { recursive: true })
      writeFileSync(hippoLedgerPath(handoff), 'not json', 'utf-8')
      assert.deepEqual(readHippoLedger(handoff), {}, '坏账本回空账（宁可重导，hippo dedup 兜底）')
      assert.equal(recordHippoLedger('ho-x', { sha256: 'a'.repeat(64), at: '2026-11-19T00:00:00.000Z', entries: 1, bytes: 10 }, handoff), '', '记账成功无附注')
      assert.equal(readHippoLedger(handoff)['ho-x']?.sha256, 'a'.repeat(64))
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('renderAbsorb：hippo 两态渲染（首次导入 / 幂等跳过）', () => {
  const base = { ok: true as const, action: 'absorb' as const, id: 'ho-x', target: 'hippo-db' as const, agent: 'dsh-hippo 记忆库', sidecar: 'X:/h/archived/ho-x.hippo.jsonl', entries: 2, dataDir: 'X:/dd', detail: '导入完成' }
  const first = renderAbsorb({}, { ...base, repeat: false })
  assert.match(first[0]?.text ?? '', /已导入 hippo 记忆库/)
  assert.match(first[0]?.text ?? '', /2 条条目/)
  assert.match(first[0]?.text ?? '', /dedup-reinforce/)
  const repeat = renderAbsorb({}, { ...base, repeat: true })
  assert.match(repeat[0]?.text ?? '', /幂等跳过/)
  assert.match(repeat[0]?.text ?? '', /已导入过/)
})

// ---------- 集成接线钉（0.26 集成期补）：inboxLoad 真实链路搬侧车 + hippoPath/hippoWarn 如实带出 ----------

test('集成接线：inboxLoad 真实链路搬侧车（consumeDistillSidecar 与 consumePatch 同位），延续回执同次落卡', () => {
  const handoff = tmpDir('integrate-pickup')
  const src = tmpDir('cardsrc-int')
  try {
    mkdirSync(join(src, '.claude'), { recursive: true })
    writeFileSync(join(src, '.claude', 'CLAUDE.md'), `吸收 fixture：偏好 pnpm。${'\n'}`, 'utf-8')
    const scan = (): MemorySourceRow[] => [fakeRow(join(src, '.claude', 'CLAUDE.md'))]
    withCwd(src, (): void => {
      const r = pushMemoryCard({ keys: ['claude-user'] }, { dir: handoff, scan })
      assert.equal(r.ok, true)
      if (!r.ok) return
      // 侧车按约定名落 pending/（生产端接线的产物形态；本测试手工落一份等价物）
      writeFileSync(join(handoff, 'pending', `${r.id}.hippo.jsonl`), `{"k":1}${'\n'}`, 'utf-8')
      const load = inboxLoad(r.id, { dir: handoff })
      assert.equal(load.ok, true)
      if (!load.ok) return
      assert.equal(load.hippoPath, join(handoff, 'archived', `${r.id}.hippo.jsonl`), 'hippoPath 如实带出归档路径')
      assert.ok(existsSync(load.hippoPath), '侧车已随卡进 archived')
      assert.equal(existsSync(join(handoff, 'pending', `${r.id}.hippo.jsonl`)), false, 'pending 不留侧车')
      assert.equal(load.receiptNote !== undefined, true, '取件即回执：延续回执落账附注在场')
      // pending 恰剩延续回执卡（回执卡被取件不再产出二次回执）
      const pendings = readdirSync(join(handoff, 'pending')).filter((f) => f.endsWith('.md'))
      assert.equal(pendings.length, 1, 'pending 恰剩一张：延续回执卡')
    })
  } finally {
    rmRf(handoff)
    rmRf(src)
  }
})

test('集成接线：侧车搬移失败不拦取件（hippoWarn 如实附注，侧车留 pending）', () => {
  const handoff = tmpDir('integrate-mvfail')
  const src = tmpDir('cardsrc-mvfail')
  try {
    mkdirSync(join(src, '.claude'), { recursive: true })
    writeFileSync(join(src, '.claude', 'CLAUDE.md'), `吸收 fixture：偏好 bun。${'\n'}`, 'utf-8')
    const scan = (): MemorySourceRow[] => [fakeRow(join(src, '.claude', 'CLAUDE.md'))]
    withCwd(src, (): void => {
      const r = pushMemoryCard({ keys: ['claude-user'] }, { dir: handoff, scan })
      assert.equal(r.ok, true)
      if (!r.ok) return
      writeFileSync(join(handoff, 'pending', `${r.id}.hippo.jsonl`), `{"k":1}${'\n'}`, 'utf-8')
      // 目的地被同名目录占住：rename 必失败（平台一致的失败注入）
      mkdirSync(join(handoff, 'archived', `${r.id}.hippo.jsonl`), { recursive: true })
      const load = inboxLoad(r.id, { dir: handoff })
      assert.equal(load.ok, true, '搬移失败绝不拦取件')
      if (!load.ok) return
      assert.equal(load.hippoPath, undefined, '未搬成不虚报路径')
      assert.match(load.hippoWarn ?? '', /侧车搬移失败/, 'hippoWarn 如实附注')
      assert.ok(existsSync(join(handoff, 'pending', `${r.id}.hippo.jsonl`)), '侧车留 pending（补吸收/重试可及）')
    })
  } finally {
    rmRf(handoff)
    rmRf(src)
  }
})

// ---------- F. 侧车格式 v2（0.26.1）：全字段 round-trip / v1 回归钉 / 混合总线 / meta 缺失 ----------

/** v2 全字段夹具：条目 2 带 section（四段账本透传路径）；条目 3 无 strength（weight 缺省路径） */
const FIX_RECORDS_V2: Array<Record<string, unknown>> = [
  {
    text: '偏好中文回复', type: 'preference', project: 'global', agent: 'claude',
    created_at: 1737000000000, accessed_at: 1737000001000, strength: 3,
    source_id: '', source_offset: -1, superseded_by: '', superseded_at: 0,
    lifecycle: 'proven', verify: 'npm test',
  },
  {
    text: '蒸馏条目：登录页报错先看适配器', type: 'lesson', project: 'dsh-takeover', agent: 'dsh',
    created_at: 1737000010000, accessed_at: 1737000011000, strength: 1,
    source_id: 'blob-abc', source_offset: 42, superseded_by: 'ho-newer', superseded_at: 1737000020000,
    lifecycle: 'trial', verify: '', section: 'dead_ends',
  },
  {
    text: '无 strength 的条目（weight 缺省语义 = 1，不伪造键）', type: 'fact', project: 'global', agent: 'a',
    created_at: 1737000030000, accessed_at: 1737000031000,
    source_id: '', source_offset: -1, superseded_by: '', superseded_at: 0,
    lifecycle: 'proven', verify: '',
  },
]
const FIX_JSONL_V2 = `${FIX_RECORDS_V2.map((r) => JSON.stringify(r)).join('\n')}\n`

/** 混合总线的 v1 侧车夹具：与 FIX_JSONL_V2 条目文本互异（桩库按 text 去重，互异才可独立计数） */
const MIX_V1_JSONL = `${[
  { text: '混合总线 v1 条目甲', type: 'fact', project: 'global', agent: 'a', created_at: 1737000100000, accessed_at: 1737000101000, strength: 1, source_id: '', source_offset: -1, superseded_by: '', superseded_at: 0, lifecycle: 'proven', verify: '' },
  { text: '混合总线 v1 条目乙', type: 'lesson', project: 'global', agent: 'a', created_at: 1737000110000, accessed_at: 1737000111000, strength: 2, source_id: '', source_offset: -1, superseded_by: '', superseded_at: 0, lifecycle: 'proven', verify: '' },
].map((r) => JSON.stringify(r)).join('\n')}\n`

test('v2 出卡→v2 吸收全字段 round-trip：workspace/weight/section 生产、搬移、读侧、absorb 全贯通', () => {
  const home = tmpDir('v2rt-home')
  const handoff = tmpDir('v2rt-handoff')
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      // 真出一张 memory 轴卡并取件（absorb 的两步语义第一步）：侧车挂这张卡的 id
      const cardId = makeArchivedMemoryCard(handoff)
      const { runner } = exportStub(FIX_JSONL_V2)
      const at = new Date('2026-11-19T00:00:00.000Z')
      const r = produceSnapshot({ cardId, cwd: 'D:/proj/x', runner, home, dir: handoff, now: at })
      assert.equal(r.ok, true, r.ok ? '' : `应成功：${r.note}`)
      if (!r.ok || r.sidecar === undefined) return
      const raw = readFileSync(r.sidecar, 'utf-8')
      // meta 行：version 2 + 卡 cwd 归属 + 注入时刻 + 条目数对齐
      const meta = parseSidecarMeta(raw)
      assert.equal(meta?.version, 2)
      assert.equal(meta?.workspace, 'D:/proj/x', 'meta 声明 workspace 归属')
      assert.equal(meta?.entries, 3)
      assert.equal(meta?.at, at.toISOString(), 'meta.at 取注入时刻（测试定钟）')
      // 条目级全字段回读
      const es = readSidecarEntriesV2(raw)
      assert.equal(es.length, 3)
      assert.ok(es.every((e) => e.workspace === 'D:/proj/x'), '每条条目带 workspace 归属')
      assert.equal(es[0]?.weight, 3, 'weight = strength 推导')
      assert.equal(es[1]?.weight, 1)
      assert.equal(es[2]?.weight, undefined, '无 strength 不伪造 weight（读侧缺省语义 = 1）')
      assert.equal(es[1]?.section, 'dead_ends', '四段账本标签透传')
      assert.equal(es[0]?.section, undefined)
      assert.equal(es[2]?.section, undefined)
      // 读侧事实汇总
      const facts = readSidecarFacts(raw)
      assert.equal(facts.version, 2)
      assert.equal(facts.metaWorkspace, 'D:/proj/x')
      assert.deepEqual(facts.workspaces, ['D:/proj/x'])
      assert.deepEqual(facts.sections, { dead_ends: 1 }, '四段账本计数只算在场标签')
      assert.deepEqual(facts.weights, { count: 2, total: 4 }, '权重事实只算显式在场条目')
      // 取件搬移（字节不变）→ absorb：confirm 缺省计划回显带 v2 事实、零写盘
      assert.equal(consumeDistillSidecar(cardId, handoff).state, 'moved')
      const stub = importStub()
      const before = treeMap(handoff)
      const plan = absorbCard({ id: cardId, target: 'hippo-db' }, { dir: handoff, home, runner: stub.runner })
      assert.equal(plan.ok, false, '缺 confirm 必须拒绝')
      if (!plan.ok) {
        assert.match(plan.error, /侧车格式 v2/)
        assert.match(plan.error, /workspace=D:\/proj\/x/)
        assert.match(plan.error, /dead_ends 1/)
        assert.match(plan.error, /state 0/, '缺席标签如实计 0（四段闭集固定顺序）')
      }
      assert.deepEqual(treeMap(handoff), before, '拒绝路径零写盘')
      assert.equal(stub.calls.length, 0)
      // confirm → 真导入：桩收到 v2 原字节、记账 sha 机制不变、结果带 sidecarVersion
      const r2 = absorbCard({ id: cardId, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r2.ok, true, r2.ok ? '' : JSON.stringify(r2))
      if (!r2.ok || !('sidecar' in r2)) return
      assert.equal(r2.sidecarVersion, 2, '结果如实带侧车格式版本')
      assert.equal(r2.entries, 3)
      assert.equal(stub.calls.length, 1)
      const received = readFileSync(stub.calls[0]?.args[1] ?? '', 'utf-8')
      assert.equal(received, raw, '桩收到的就是 archived 侧车原字节（v2 字段随字节交给 hippo——实测 hippo 忽略未知字段、meta 行按坏行跳过）')
      assert.equal(stub.created(), 3)
      assert.match(r2.detail, /侧车格式 v2/)
      assert.match(r2.detail, /坏行/, 'note 如实说明 meta 行被 hippo 按坏行跳过')
      const ledger = readHippoLedger(handoff)
      assert.equal(ledger[cardId]?.sha256, createHash('sha256').update(raw, 'utf-8').digest('hex'), '幂等记账键 = v2 侧车 sha（机制不变）')
      // 二次 absorb 幂等跳过（机制不变）
      const r3 = absorbCard({ id: cardId, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r3.ok, true)
      if (!r3.ok || !('sidecar' in r3)) return
      assert.equal(r3.repeat, true)
      assert.equal(stub.calls.length, 1, '跳过路径不再调 CLI')
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('v1 旧侧车→absorb 照常（回归钉）：无 meta 无 v2 字段，格式事实如实报 v1', () => {
  const home = tmpDir('v1home')
  const handoff = tmpDir('v1handoff')
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      const card = makeArchivedMemoryCard(handoff)
      // 手工落一份 v1 侧车（0.26 旧行为的原样字节：裸 13 字段行、无 meta 行）
      writeFileSync(join(handoff, 'pending', `${card}.hippo.jsonl`), FIX_JSONL, 'utf-8')
      assert.equal(consumeDistillSidecar(card, handoff).state, 'moved')
      const info = locateHippoSidecar(card, { dir: handoff, home })
      assert.ok(!('error' in info), 'v1 侧车应可定位')
      if ('error' in info) return
      assert.equal(info.sidecarVersion, 1, '无 meta 行按 v1')
      assert.equal(info.v2Workspace, undefined)
      assert.deepEqual(info.v2Sections, {}, 'v1 无四段账本计数')
      const stub = importStub()
      const plan = absorbCard({ id: card, target: 'hippo-db' }, { dir: handoff, home, runner: stub.runner })
      assert.equal(plan.ok, false)
      if (!plan.ok) {
        assert.match(plan.error, /侧车格式 v1/, '计划回显如实报 v1')
        assert.doesNotMatch(plan.error, /侧车格式 v2/, '不虚构 v2 事实')
      }
      const r = absorbCard({ id: card, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r))
      if (!r.ok || !('sidecar' in r)) return
      assert.equal(r.sidecarVersion, 1)
      assert.equal(r.entries, 2)
      assert.equal(stub.created(), 2, 'v1 条目照常入库')
      // 桩收到的就是 v1 原字节：条目不带任何 v2 字段
      assert.equal(stub.calls[0]?.args[1], join(handoff, 'archived', `${card}.hippo.jsonl`))
      const es = readSidecarEntriesV2(readFileSync(stub.calls[0]?.args[1] ?? '', 'utf-8'))
      assert.ok(es.every((e) => e.workspace === undefined && e.weight === undefined && e.section === undefined), 'v1 条目不带 v2 字段')
      const ledger = readHippoLedger(handoff)
      assert.equal(ledger[card]?.sha256, createHash('sha256').update(FIX_JSONL, 'utf-8').digest('hex'), 'v1 侧车记账键 = 原 sha')
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('混合总线（v1+v2 并存）：同一 HANDOFF_HOME 两张卡各带各的版本，互不干扰、记账共存', () => {
  const home = tmpDir('mix-home')
  const handoff = tmpDir('mix-handoff')
  const homeB = tmpDir('mix-home-b')
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      // 卡 A：v1 侧车（手工落 pending，0.26 旧形态；条目文本与 v2 夹具互异）
      const a = makeArchivedMemoryCard(handoff)
      writeFileSync(join(handoff, 'pending', `${a}.hippo.jsonl`), MIX_V1_JSONL, 'utf-8')
      assert.equal(consumeDistillSidecar(a, handoff).state, 'moved')
      // 卡 B：v2 侧车（produceSnapshot 出，cwd 归属）
      const b = makeArchivedMemoryCard(handoff)
      const { runner } = exportStub(FIX_JSONL_V2)
      const produced = produceSnapshot({ cardId: b, cwd: 'D:/proj/y', runner, home: homeB, dir: handoff })
      assert.equal(produced.ok, true, produced.ok ? '' : produced.note)
      if (!produced.ok) return
      assert.equal(consumeDistillSidecar(b, handoff).state, 'moved')
      // 两卡各自 absorb（同一桩库）：版本各自如实、条目全数入库
      const stub = importStub()
      const ra = absorbCard({ id: a, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      const rb = absorbCard({ id: b, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(ra.ok, true, ra.ok ? '' : JSON.stringify(ra))
      assert.equal(rb.ok, true, rb.ok ? '' : JSON.stringify(rb))
      if (!ra.ok || !('sidecar' in ra) || !rb.ok || !('sidecar' in rb)) return
      assert.equal(ra.sidecarVersion, 1, '卡 A 如实报 v1')
      assert.equal(rb.sidecarVersion, 2, '卡 B 如实报 v2')
      assert.equal(stub.created(), 5, 'v1 两条 + v2 三条全数入库')
      assert.match(rb.detail, /workspace=D:\/proj\/y/)
      assert.doesNotMatch(ra.detail, /workspace=/, 'v1 不虚报 workspace')
      const ledger = readHippoLedger(handoff)
      assert.ok(ledger[a] !== undefined && ledger[b] !== undefined, '两卡记账共存')
      assert.notEqual(ledger[a]?.sha256, ledger[b]?.sha256, '两份侧车各自记账（sha 不同）')
      // 幂等互不干扰：再 absorb A 按 A 自己的 sha 跳过
      const ra2 = absorbCard({ id: a, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(ra2.ok, true)
      if (!ra2.ok || !('sidecar' in ra2)) return
      assert.equal(ra2.repeat, true)
      assert.equal(stub.calls.length, 2, '跳过路径不再调 CLI')
    })
  } finally {
    rmRf(home)
    rmRf(homeB)
    rmRf(handoff)
  }
})

test('meta 行缺失按 v1 处理：条目带 v2 字段也不冒充 v2（版本归属跟 meta 行，字段如实解出）', () => {
  const home = tmpDir('nometahome')
  const handoff = tmpDir('nometahandoff')
  try {
    withHippoEnv({ HIPPO_DATA_DIR: undefined }, () => {
      // 手写侧车：无 meta 行，但条目行带 workspace/weight/section（异常生产方的产物形态）
      const rawNoMeta = `${[
        JSON.stringify({ ...FIX_RECORDS_V2[0], workspace: 'D:/elsewhere', weight: 2, section: 'goals' }),
        JSON.stringify(FIX_RECORDS_V2[1]),
      ].join('\n')}\n`
      const card = makeArchivedMemoryCard(handoff)
      writeFileSync(join(handoff, 'pending', `${card}.hippo.jsonl`), rawNoMeta, 'utf-8')
      assert.equal(consumeDistillSidecar(card, handoff).state, 'moved')
      // 读侧事实：version 1（meta 缺失）、metaWorkspace 无；条目级字段仍如实解出（字段是字段，版本是版本）
      const facts = readSidecarFacts(rawNoMeta)
      assert.equal(facts.version, 1, 'meta 行缺失 → 按 v1 处理')
      assert.equal(facts.metaWorkspace, undefined)
      assert.deepEqual(facts.workspaces, ['D:/elsewhere'], '条目级字段在场仍如实解出')
      assert.deepEqual(facts.sections, { goals: 1, dead_ends: 1 }, '条目级字段在场仍如实解出（第 2 条夹具自带 section）')
      assert.deepEqual(facts.weights, { count: 1, total: 2 })
      const info = locateHippoSidecar(card, { dir: handoff, home })
      assert.ok(!('error' in info))
      if ('error' in info) return
      assert.equal(info.sidecarVersion, 1)
      assert.equal(info.v2Workspace, undefined)
      const stub = importStub()
      const plan = absorbCard({ id: card, target: 'hippo-db' }, { dir: handoff, home, runner: stub.runner })
      assert.equal(plan.ok, false)
      if (!plan.ok) assert.match(plan.error, /侧车格式 v1/, '计划回显按 v1（不冒充 v2）')
      const r = absorbCard({ id: card, target: 'hippo-db', confirm: true }, { dir: handoff, home, runner: stub.runner })
      assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r))
      if (!r.ok || !('sidecar' in r)) return
      assert.equal(r.sidecarVersion, 1)
      assert.equal(stub.created(), 2, '照常入库（hippo 对未知字段忽略——实测背书）')
    })
  } finally {
    rmRf(home)
    rmRf(handoff)
  }
})

test('toV2Sidecar 纯函数钉：坏行保原样、空行剔除、非法 section/weight 消毒、双次组装字节不变', () => {
  const raw = [
    '{"text":"好条目","type":"fact","strength":2,"section":"bogus","weight":-1}',
    'not json line',
    '',
    '{"text":"已有 weight","strength":9,"weight":5,"workspace":"/old"}',
    '{"noText":1}',
  ].join('\n')
  const { jsonl, entries } = toV2Sidecar(raw, { workspace: 'D:/w', at: '2026-11-19T00:00:00.000Z' })
  assert.equal(entries, 2, '只有 text 非空行计条目')
  assert.equal(parseSidecarMeta(jsonl)?.entries, 2, 'meta 条目数与条目行对齐')
  assert.ok(jsonl.endsWith('\n'), '尾换行（hippo writeJsonl 同款）')
  const es = readSidecarEntriesV2(jsonl)
  assert.equal(es[0]?.section, undefined, '非法 section 消毒剔除（写侧保证闭集）')
  assert.equal(es[0]?.weight, 2, '非法 weight 消毒后由 strength 推导')
  assert.equal(es[1]?.weight, 5, '已有合法 weight 不被 strength 覆盖')
  assert.equal(es[1]?.workspace, 'D:/w', '卡级 cwd 覆盖条目旧 workspace（归属以随卡的卡为准）')
  assert.ok(jsonl.includes('not json line'), '坏行原样保留（消费者按行跳过，不丢来源字节）')
  assert.ok(jsonl.includes('{"noText":1}'), '非条目非空行原样保留')
  assert.ok(!jsonl.includes('\n\n'), '空行剔除（无数据）')
  // 幂等：同输入同 opts 双次组装字节不变（已富集条目不重复加键、不改值）
  const again = toV2Sidecar(jsonl, { workspace: 'D:/w', at: '2026-11-19T00:00:00.000Z' })
  assert.equal(again.jsonl, jsonl, '双次组装字节不变')
  assert.equal(again.entries, 2)
  // 无 cwd：不动条目已有 workspace（无卡级真源不覆盖来源）
  const noCwd = toV2Sidecar(raw, { at: '2026-11-19T00:00:00.000Z' })
  const es2 = readSidecarEntriesV2(noCwd.jsonl)
  assert.equal(es2[0]?.workspace, undefined)
  assert.equal(es2[1]?.workspace, '/old', '无卡级真源不覆盖来源 workspace')
})
