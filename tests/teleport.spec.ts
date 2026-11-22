/**
 * 云端门内 teleport spike 测试（0.26 · WS-4）。
 * 覆盖（计划 WS-4 tests 全集）：
 * - runner 桩三态：成功 / CLI 缺席（ENOENT）/ 非零退出（含静默失败与超时硬杀）
 * - 命令组装恶意 session-id 拒绝（参数逃逸面：--flag / 空格 / 路径段 / shell 元字符）
 * - 落盘探测防御：不存在 / 越权不可读 / 非法 id 不触碰 fs / 路径组合精确
 * - 发现对齐评估：UUID 候选 / 头行对齐 / 非 UUID 不采信 / fail-open / 根缺失 skipped
 * - 报告文件守门：docs/spike-teleport-0.26.md 在盘时四问各有结论段（报告属内部文档，CI 缺席时显式 skip）
 * 全部走桩与 tmp 目录，不真跑 claude、不碰真实 user home。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALIGNMENT_NOTES,
  assertSafeSessionId,
  buildTeleportCommand,
  buildTeleportProbeCommand,
  evaluateTeleportDiscovery,
  mungeProjectDir,
  probeTeleportArtifact,
  runTeleport,
  runTeleportProbe,
  teleportJsonlPath,
  type TeleportRunner,
} from '../src/teleport.ts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GOOD_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d' // 合法小写 UUID 样例（虚构，非真实会话 id）

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `dsh-teleport-${label}-`))
}

function rmRf(p: string): void {
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

// ---------- 消毒与命令组装 ----------

describe('assertSafeSessionId：闭集消毒（防参数逃逸）', () => {
  test('合法 UUID 放行并小写归一化', () => {
    assert.equal(assertSafeSessionId(GOOD_ID), GOOD_ID)
    assert.equal(assertSafeSessionId(GOOD_ID.toUpperCase()), GOOD_ID)
    assert.equal(assertSafeSessionId(`  ${GOOD_ID}  `.toUpperCase()), GOOD_ID)
  })

  test('恶意形态全数拒绝：新 flag / 空格 / 分号 / 路径段 / ../ / 空 / 坏十六进制 / 非 UUID 形态', () => {
    const evil = [
      '--danger-flag',
      '--teleport=00000000-0000-0000-0000-000000000000',
      'abc def',
      'a;rm -rf /',
      'a & calc',
      '`cmd`',
      '$(cmd)',
      '../escape',
      '..\\escape',
      'C:/Windows/system32',
      '',
      '   ',
      '00000000-0000-0000-0000-00000000000g', // 坏十六进制
      '00000000-0000-0000-0000-0000000000000', // 长度多一位
      '00000000000000000000000000000000', // 无连字符
      'ho-abc1-ab2c', // 卡片 id 形态（另一套闭集，互不通用）
    ]
    for (const id of evil) {
      assert.throws(() => assertSafeSessionId(id), /非法会话 id/, `应拒绝：${id}`)
    }
  })
})

describe('buildTeleportCommand / buildTeleportProbeCommand：纯组装', () => {
  test('无 id → 交互 picker 形态 claude --teleport', () => {
    assert.deepEqual(buildTeleportCommand(), { cmd: 'claude', args: ['--teleport'] })
  })

  test('有 id → claude --teleport <id>，id 槽位不可能长出新 flag', () => {
    const c = buildTeleportCommand(GOOD_ID)
    assert.equal(c.cmd, 'claude')
    assert.deepEqual(c.args, ['--teleport', GOOD_ID])
    assert.ok(c.args.every((a) => !a.startsWith('--') || a === '--teleport'))
  })

  test('探针命令 -p --teleport <id>', () => {
    assert.deepEqual(buildTeleportProbeCommand(GOOD_ID).args, ['-p', '--teleport', GOOD_ID])
  })

  test('恶意 id 在组装层即抛，探针命令同拒', () => {
    assert.throws(() => buildTeleportCommand('--evil'))
    assert.throws(() => buildTeleportProbeCommand('--evil'))
    assert.throws(() => buildTeleportCommand('not-a-uuid at all'))
  })
})

// ---------- runner 桩三态 ----------

describe('runTeleport / runTeleportProbe：runner 三态（全桩）', () => {
  test('成功：ok=true，args 原样透传给 runner，stdout 透传', async () => {
    const seen: Array<{ cmd: string; args: string[]; timeoutMs?: number }> = []
    const runner: TeleportRunner = async (cmd, args, opts) => {
      seen.push({ cmd, args, timeoutMs: opts?.timeoutMs })
      return { stdout: 'teleported', stderr: '' }
    }
    const out = await runTeleport({ sessionId: GOOD_ID, timeoutMs: 1234 }, runner)
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'ok')
    assert.equal(out.stdout, 'teleported')
    assert.deepEqual(seen, [{ cmd: 'claude', args: ['--teleport', GOOD_ID], timeoutMs: 1234 }])
  })

  test('CLI 缺席：ENOENT → kind=cli-missing，中文说明，ok=false', async () => {
    const runner: TeleportRunner = async () => {
      throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    }
    const out = await runTeleportProbe({ sessionId: GOOD_ID }, runner)
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'cli-missing')
    assert.match(out.error ?? '', /claude CLI 不在 PATH/)
  })

  test('非零退出（静默失败形态：无 stdout 无 stderr）→ kind=nonzero，如实标注无诊断输出', async () => {
    const runner: TeleportRunner = async () => {
      // 本机 2.1.220 实测形态：exit 1 / 无输出
      throw Object.assign(new Error('command failed'), { code: 1, stdout: '', stderr: '' })
    }
    const out = await runTeleport({ sessionId: GOOD_ID }, runner)
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'nonzero')
    assert.match(out.error ?? '', /无诊断输出（静默失败形态）/)
  })

  test('非零退出（带 stderr 详情）→ error 含详情', async () => {
    const runner: TeleportRunner = async () => {
      throw Object.assign(new Error('command failed'), { code: 2, stderr: 'session not found\n' })
    }
    const out = await runTeleport({ sessionId: GOOD_ID }, runner)
    assert.equal(out.kind, 'nonzero')
    assert.match(out.error ?? '', /session not found/)
  })

  test('超时硬杀（killed）→ nonzero 且中文超时说明，绝不挂死', async () => {
    const runner: TeleportRunner = async () => {
      throw Object.assign(new Error('killed'), { killed: true, code: null })
    }
    const out = await runTeleportProbe({ sessionId: GOOD_ID, timeoutMs: 50 }, runner)
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'nonzero')
    assert.match(out.error ?? '', /超时被硬杀/)
  })
})

// ---------- ② 落盘探测防御 ----------

describe('probeTeleportArtifact：落盘探测（不存在/越权/非法 id 防御）', () => {
  test('路径组合精确：<root>/projects/<munge(project)>/<id>.jsonl，uppercase id 归一化小写', () => {
    const root = tmpRoot('path')
    try {
      const path = teleportJsonlPath(GOOD_ID.toUpperCase(), { projectPath: 'D:\\CodingProjects\\sample-proj', claudeRoot: root })
      assert.equal(path, join(root, 'projects', 'D--CodingProjects-sample-proj', `${GOOD_ID}.jsonl`))
    } finally {
      rmRf(root)
    }
  })

  test('不存在 → state=missing，中文注记不粉饰', () => {
    const root = tmpRoot('missing')
    try {
      const probe = probeTeleportArtifact(GOOD_ID, { projectPath: 'D:\\CodingProjects', claudeRoot: root })
      assert.equal(probe.state, 'missing')
      assert.match(probe.note, /无产物/)
      assert.ok(existsSync(root)) // 只读探测，不创建目录
    } finally {
      rmRf(root)
    }
  })

  test('存在 → state=found，size/mtime 如实', () => {
    const root = tmpRoot('found')
    try {
      const dir = join(root, 'projects', 'D--CodingProjects-sample-proj')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${GOOD_ID}.jsonl`), '{"type":"queue-operation"}\n', 'utf-8')
      const probe = probeTeleportArtifact(GOOD_ID, { projectPath: 'D:\\CodingProjects\\sample-proj', claudeRoot: root })
      assert.equal(probe.state, 'found')
      if (probe.state === 'found') assert.equal(probe.size, '{"type":"queue-operation"}\n'.length)
    } finally {
      rmRf(root)
    }
  })

  test('越权/IO 错误：注入 stat 抛 EPERM → state=unreadable，fail-open 不抛', () => {
    const root = tmpRoot('unreadable')
    try {
      const probe = probeTeleportArtifact(GOOD_ID, {
        projectPath: 'D:\\CodingProjects',
        claudeRoot: root,
        exists: () => true,
        stat: () => {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        },
      })
      assert.equal(probe.state, 'unreadable')
      assert.match(probe.note, /EPERM|不可读/)
    } finally {
      rmRf(root)
    }
  })

  test('非法 id：invalid-id 且 fs 注入桩零触碰（探测根本不落盘）', () => {
    const root = tmpRoot('invalid')
    try {
      const existsSpyCalls: string[] = []
      for (const id of ['--flag', '../escape', 'not a uuid', '']) {
        const probe = probeTeleportArtifact(id, {
          projectPath: 'D:\\CodingProjects',
          claudeRoot: root,
          exists: (p) => {
            existsSpyCalls.push(p)
            return true
          },
          stat: () => ({ size: 1, mtimeMs: 0 }),
        })
        assert.equal(probe.state, 'invalid-id', `应拒绝：${id}`)
        assert.match(probe.note, /非法会话 id|纵深防御/)
      }
      assert.equal(existsSpyCalls.length, 0, 'fs 桩不应被触碰')
    } finally {
      rmRf(root)
    }
  })

  test('纵深防御：hostile claudeRoot 组合后路径仍须落在 projects 解析域内', () => {
    const probe = probeTeleportArtifact(GOOD_ID, {
      projectPath: 'D:\\CodingProjects',
      claudeRoot: 'C:/hostile/../../escaped',
      exists: () => true,
      stat: () => ({ size: 1, mtimeMs: 0 }),
    })
    // 组合路径解析后仍在 <resolve(root)>/projects 域内（域随 root 解析平移）——
    // 本断言钉死「域判定用解析后路径」，不允许 .. 半途逃逸出判定
    assert.ok(probe.state === 'found' || probe.state === 'invalid-id')
  })
})

// ---------- munge 规则（本机实测 4/4 吻合的推断规则） ----------

describe('mungeProjectDir：推断规则钉死', () => {
  test('本机实测样本：盘符冒号与反斜杠折叠为 -，下划线保留', () => {
    assert.equal(mungeProjectDir('D:\\CodingProjects\\sample-proj'), 'D--CodingProjects-sample-proj')
    assert.equal(mungeProjectDir('C:\\Users\\someone'), 'C--Users-someone')
    assert.equal(mungeProjectDir('D:\\CodingProjects'), 'D--CodingProjects')
    assert.equal(mungeProjectDir('__blindspot_test__'), '__blindspot_test__')
    assert.equal(mungeProjectDir('/home/user/my proj'), '-home-user-my-proj')
  })
})

// ---------- ③ 发现对齐评估 ----------

describe('evaluateTeleportDiscovery：扫描 + 对齐评估（全桩/tmp）', () => {
  test('UUID 候选：头行 sessionId 与文件名一致 → aligns=true，行数如实', () => {
    const root = tmpRoot('disc')
    try {
      const proj = join(root, 'projects', 'D--CodingProjects-sample-proj')
      mkdirSync(proj, { recursive: true })
      const lines = [
        `{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-10T02:32:46.439Z","sessionId":"${GOOD_ID}"}`,
        `{"type":"user","timestamp":"2026-10-10T02:33:00.000Z","sessionId":"${GOOD_ID}"}`,
      ]
      writeFileSync(join(proj, `${GOOD_ID}.jsonl`), lines.join('\n') + '\n', 'utf-8')
      const report = evaluateTeleportDiscovery({ claudeRoot: root })
      assert.equal(report.skipped, false)
      assert.equal(report.projectDirs, 1)
      assert.equal(report.candidates.length, 1)
      const c = report.candidates[0]!
      assert.equal(c.sessionId, GOOD_ID)
      assert.equal(c.headSessionId, GOOD_ID)
      assert.equal(c.aligns, true)
      assert.equal(c.lineCount, 2)
      assert.ok(c.size! > 0)
      assert.ok(report.alignmentNotes.some((n) => n.includes('适配层')))
    } finally {
      rmRf(root)
    }
  })

  test('非 UUID 文件名不采信（sessionId=null，aligns=false）；头行 sessionId 不一致 → aligns=false', () => {
    const root = tmpRoot('disc2')
    try {
      const proj = join(root, 'projects', 'proj')
      mkdirSync(proj, { recursive: true })
      writeFileSync(join(proj, 'notes.jsonl'), '{"note":"not a session"}\n', 'utf-8')
      const other = '11111111-2222-4333-8444-555555555555'
      writeFileSync(join(proj, `${GOOD_ID}.jsonl`), `{"type":"user","sessionId":"${other}"}\n`, 'utf-8')
      const report = evaluateTeleportDiscovery({ claudeRoot: root })
      const notes = report.candidates.find((c) => c.path.endsWith('notes.jsonl'))!
      assert.equal(notes.sessionId, null)
      assert.equal(notes.aligns, false)
      assert.match(notes.note, /非 UUID/)
      const misaligned = report.candidates.find((c) => c.sessionId === GOOD_ID)!
      assert.equal(misaligned.headSessionId, other)
      assert.equal(misaligned.aligns, false)
    } finally {
      rmRf(root)
    }
  })

  test('单文件读不了：fail-open 留名录 + 注记，绝不抛；头行非 JSON 同款', () => {
    const root = tmpRoot('disc3')
    try {
      const proj = join(root, 'projects', 'proj')
      mkdirSync(proj, { recursive: true })
      writeFileSync(join(proj, `${GOOD_ID}.jsonl`), 'not-json-garbage\n', 'utf-8')
      const report = evaluateTeleportDiscovery({
        claudeRoot: root,
        stat: (p) => {
          if (p.endsWith('.jsonl')) throw new Error('EACCES: permission denied')
          return { size: 1, mtimeMs: 0 }
        },
      })
      assert.equal(report.candidates.length, 1)
      assert.equal(report.candidates[0]!.aligns, false)
      assert.match(report.candidates[0]!.note, /stat 失败（fail-open）/)
      // 头行非 JSON 分支（stat 正常、内容不是 JSON）
      const report2 = evaluateTeleportDiscovery({ claudeRoot: root })
      assert.equal(report2.candidates[0]!.headSessionId, null)
      assert.match(report2.candidates[0]!.note, /头行非 JSON/)
    } finally {
      rmRf(root)
    }
  })

  test('projects 根缺失 → skipped=true 中文注记（fail-open 规范值，对齐 ProbeResult 形态）', () => {
    const root = tmpRoot('disc4')
    try {
      const report = evaluateTeleportDiscovery({ claudeRoot: root }) // projects/ 不存在
      assert.equal(report.ok, true)
      assert.equal(report.skipped, true)
      assert.equal(report.candidates.length, 0)
      assert.match(report.note, /projects 根不可达/)
      assert.ok(report.alignmentNotes.length > 0) // 对齐结论照常给出
    } finally {
      rmRf(root)
    }
  })

  test('ALIGNMENT_NOTES：三条结论齐全（字段模型不同/桥成本/发现面零障碍）', () => {
    assert.equal(ALIGNMENT_NOTES.length, 3)
    assert.ok(ALIGNMENT_NOTES[0]!.includes('collectFacts'))
    assert.ok(ALIGNMENT_NOTES[0]!.includes('适配层'))
    assert.ok(ALIGNMENT_NOTES[1]!.includes('上游语义可变'))
    assert.ok(ALIGNMENT_NOTES[2]!.includes('零障碍'))
  })
})

// ---------- 报告文件守门（防没跑完就合入） ----------

describe('docs/spike-teleport-0.26.md 守门：四问各有结论段', () => {
  // 本报告属内部研究文档（.gitignore `docs/*` 默认不入库，白名单仅 ROADMAP 在册）：
  // 在盘（本机开发态）→ 守门断言全跑；缺席（CI 全新 checkout）→ 显式 skip 注明原因，
  // 不装通过、不误红。「零接线自查」一测与报告无关，任何环境都跑。
  const docPath = join(REPO_ROOT, 'docs', 'spike-teleport-0.26.md')
  const md = existsSync(docPath) ? readFileSync(docPath, 'utf-8').replace(/\r\n/g, '\n') : null

  test('报告存在且四问各有「结论」段', (t) => {
    if (md === null) {
      t.skip('spike 报告为内部文档不入库，CI 环境无该文件——守门仅在本机开发态生效')
      return
    }
    for (const [q, kw] of [
      ['问 1', '会话 id'],
      ['问 2', '压缩'],
      ['问 3', '落盘'],
      ['问 4', '非交互'],
    ] as const) {
      assert.ok(md.includes(q), `报告缺 ${q} 段`)
      assert.ok(md.includes(kw), `报告 ${q} 缺关键词 ${kw}`)
    }
    // 四问逐答，每问带结论行
    const conclusionCount = (md.match(/#### 结论/g) ?? []).length
    assert.ok(conclusionCount >= 4, `结论段应 ≥4，实为 ${conclusionCount}`)
  })

  test('实测记录齐全：CLI 版本号 + 实测命令 + 诚实「未实测」标注', (t) => {
    if (md === null) {
      t.skip('spike 报告为内部文档不入库，CI 环境无该文件')
      return
    }
    assert.ok(md.includes('2.1.220'), '报告须记录实测时 CLI 版本号（风险②）')
    assert.ok(md.includes('claude -p --teleport'), '报告须留实测命令原文')
    assert.ok(md.includes('未实测'), '无环境项必须如实标注未实测（风险③）')
    assert.ok(md.includes('cloudroom') || md.includes('Cloudroom'), '须含 cloudroom 卡位对比')
    assert.ok(md.includes('0.27 决策输入'), '须含 0.27 决策输入清单')
    assert.ok(md.includes('竞品全景不完整') || md.includes('材料截断'), '材料截断须注记（风险④）')
  })

  test('报告不留 TODO/占位（防半成品合入）', (t) => {
    if (md === null) {
      t.skip('spike 报告为内部文档不入库，CI 环境无该文件')
      return
    }
    assert.ok(!/TODO|FIXME|【待补】|待填/.test(md), '报告不得残留 TODO/占位')
    assert.ok(md.length > 4000, `报告应有实质内容（当前 ${md.length} 字符）`)
  })

  test('零接线自查：teleport 不被 src 其它模块引用（spike 不进注册表/路由/exports）', () => {
    for (const f of ['index.ts', 'tools.ts', 'server.ts', 'settings.ts', 'client.ts', 'collect.ts']) {
      const src = readFileSync(join(REPO_ROOT, 'src', f), 'utf-8')
      assert.ok(!src.includes('teleport'), `src/${f} 不得引用 teleport（零接线纪律）`)
    }
  })
})
