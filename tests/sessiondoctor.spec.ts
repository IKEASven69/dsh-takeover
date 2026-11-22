/**
 * 0.26 扩展波 · 会话医生（总线只读自检）测试。
 * 覆盖：干净总线零误报（含 C8 宽松卡/gzip 审计组合/活链）+ 只读保证 /
 * 损坏段逐类命中（坏 YAML/超尺寸/id 非法/id 错位/读失败/archived 降级 warn）/
 * 形态缺段缺字段（C4 口径，C8 宽松卡豁免字段查）/ 孤儿侧车（pending 写侧残留、
 * 取件中断残留、archived 滚动残留、信封误置、分块聚合）/ 链三查（dangling 双通道、
 * 环、自环、fork、活链零报）/ 坏文件不炸扫描（二进制垃圾/目录冒充/不存在目录）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanStore, sidecarOwnerOf, type DoctorIssue } from '../src/sessiondoctor.ts'

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-'))
  mkdirSync(join(dir, 'pending'), { recursive: true })
  mkdirSync(join(dir, 'archived'), { recursive: true })
  return dir
}

/** 合法六段卡文本（frontmatter 齐 + 六段齐；opts 裁剪出各类缺陷形态） */
function cardText(id: string, opts?: {
  supersedes?: string
  omitHeadings?: string[]
  omitFields?: Array<'handoff' | 'session'>
  frontless?: boolean
}): string {
  if (opts?.frontless === true) {
    const heads = ['目标', '涉及文件', '做到哪', '还差什么', '停在哪', '读者警告'].filter((h) => opts.omitHeadings?.includes(h) !== true)
    return heads.map((h) => `## ${h}\n\n${h}段内容\n`).join('\n')
  }
  const fm: string[] = []
  if (opts?.omitFields?.includes('handoff') !== true) fm.push('handoff: 1')
  fm.push(`id: ${id}`)
  fm.push('from:')
  fm.push('  agent: dsh')
  if (opts?.omitFields?.includes('session') !== true) fm.push('  session: sess-1')
  fm.push('  title: 体检fixture')
  fm.push('to: any')
  fm.push('project: doctor-spec')
  fm.push('cwd: D:/nowhere')
  fm.push('pushed_at: 2026-11-19T00:00:00.000Z')
  fm.push('git:')
  fm.push('  branch: main')
  fm.push('  changed: []')
  if (opts?.supersedes !== undefined) fm.push(`supersedes: ${opts.supersedes}`)
  const heads = ['目标', '涉及文件', '做到哪', '还差什么', '停在哪', '读者警告'].filter((h) => opts?.omitHeadings?.includes(h) !== true)
  return `---\n${fm.join('\n')}\n---\n\n${heads.map((h) => `## ${h}\n\n${h}段内容\n`).join('\n')}`
}

function writeCard(home: string, where: 'pending' | 'archived', id: string, text: string): void {
  writeFileSync(join(home, where, `${id}.md`), text, 'utf-8')
}

function issuesOf(report: { issues: DoctorIssue[] }, kind: DoctorIssue['kind']): DoctorIssue[] {
  return report.issues.filter((i) => i.kind === kind)
}

describe('sidecarOwnerOf：侧车名 → owner id（settings PATCH_CHUNK_GZ_RE 同款切法）', () => {
  test('五个家族全命中；.claim 与杂项返回 null', () => {
    assert.equal(sidecarOwnerOf('ho-x-y001.envelope.json'), 'ho-x-y001')
    assert.equal(sidecarOwnerOf('ho-x-y001.patch'), 'ho-x-y001')
    assert.equal(sidecarOwnerOf('ho-x-y001.patch.gz'), 'ho-x-y001')
    assert.equal(sidecarOwnerOf('ho-x-y001.patch.001.gz'), 'ho-x-y001')
    assert.equal(sidecarOwnerOf('ho-x-y001.patch.012.gz'), 'ho-x-y001')
    assert.equal(sidecarOwnerOf('ho-x-y001.hippo.jsonl'), 'ho-x-y001')
    assert.equal(sidecarOwnerOf('ho-x-y001.claim'), null)
    assert.equal(sidecarOwnerOf('notes.txt'), null)
    assert.equal(sidecarOwnerOf('lifecycle.jsonl'), null)
  })
})

describe('干净总线：零误报 + 只读保证', () => {
  test('全件总线（含 C8 宽松卡、gzip 审计组合、活链、正常随卡侧车）issues 为空', () => {
    const dir = tmpHome()
    try {
      // pending：规范卡（带信封+补丁）、C8 宽松卡（无 frontmatter 六段齐）、活链子卡
      writeCard(dir, 'pending', 'ho-doct-ok01', cardText('ho-doct-ok01'))
      writeFileSync(join(dir, 'pending', 'ho-doct-ok01.envelope.json'), '{"handoff":1,"kind":"envelope","id":"ho-doct-ok01"}', 'utf-8')
      writeFileSync(join(dir, 'pending', 'ho-doct-ok01.patch'), 'diff --git a/f b/f\n', 'utf-8')
      writeCard(dir, 'pending', 'ho-doct-ok03', cardText('ho-doct-ok03', { frontless: true }))
      writeCard(dir, 'pending', 'ho-chain-ok01', cardText('ho-chain-ok01', { supersedes: 'ho-chain-ok02' }))
      // archived：规范卡 + gzip 审计组合（.patch 与 .patch.gz/分块并存是 restoreGzipPatch 的合法归档形态）
      writeCard(dir, 'archived', 'ho-doct-ok02', cardText('ho-doct-ok02'))
      writeCard(dir, 'archived', 'ho-chain-ok02', cardText('ho-chain-ok02'))
      writeFileSync(join(dir, 'archived', 'ho-doct-ok02.patch'), 'diff\n', 'utf-8')
      writeFileSync(join(dir, 'archived', 'ho-doct-ok02.patch.gz'), Buffer.from([0x1f, 0x8b, 0x00]))
      writeFileSync(join(dir, 'archived', 'ho-doct-ok02.patch.001.gz'), Buffer.from([0x1f, 0x8b, 0x01]))
      writeFileSync(join(dir, 'archived', 'ho-doct-ok02.patch.002.gz'), Buffer.from([0x1f, 0x8b, 0x02]))
      writeFileSync(join(dir, 'archived', 'ho-chain-ok02.hippo.jsonl'), '{"entries":[]}\n', 'utf-8')

      // 扫描前全量快照（只读保证：一个字节都不能动）
      const before = ['pending', 'archived'].flatMap((d) =>
        ['ho-doct-ok01.md', 'ho-doct-ok01.envelope.json', 'ho-doct-ok01.patch', 'ho-doct-ok03.md', 'ho-chain-ok01.md',
          'ho-doct-ok02.md', 'ho-chain-ok02.md', 'ho-doct-ok02.patch', 'ho-doct-ok02.patch.gz', 'ho-doct-ok02.patch.001.gz', 'ho-doct-ok02.patch.002.gz', 'ho-chain-ok02.hippo.jsonl']
          .map((f) => join(dir, d, f)),
      )
      const snapshot = before.filter(existsSync).map((p) => ({ p, text: readFileSync(p) }))

      const report = scanStore(dir)
      assert.equal(report.ok, true, `干净总线不应有发现：${JSON.stringify(report.issues)}`)
      assert.equal(report.issues.length, 0)
      assert.equal(report.notes, undefined, '干净总线不应有降级附注')
      assert.deepEqual(report.scanned, { pendingCards: 3, archivedCards: 2, pendingSidecars: 2, archivedSidecars: 5 })
      for (const s of snapshot) {
        assert.ok(existsSync(s.p), `扫描不得删除文件：${s.p}`)
        assert.deepEqual(readFileSync(s.p), s.text, `扫描不得改写文件：${s.p}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('损坏段（corrupt）：逐类命中', () => {
  test('pending 坏 YAML frontmatter → error', () => {
    const dir = tmpHome()
    try {
      writeFileSync(join(dir, 'pending', 'ho-badyaml-0001.md'), '---\nhandoff: 1\nid: [unclosed\n---\n\n## 目标\n\nx\n', 'utf-8')
      const report = scanStore(dir)
      const hits = issuesOf(report, 'corrupt')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.id, 'ho-badyaml-0001')
      assert.equal(hits[0]?.severity, 'error')
      assert.match(hits[0]?.detail ?? '', /解析失败/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('超 MAX_CARD_BYTES 尺寸闸 → error（不读入内容）', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-bigf-0001', 'x'.repeat(8 * 1024 * 1024 + 1))
      const hits = issuesOf(scanStore(dir), 'corrupt')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.id, 'ho-bigf-0001')
      assert.equal(hits[0]?.severity, 'error')
      assert.match(hits[0]?.detail ?? '', /尺寸闸/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('卡内 id 非法 / 卡内 id 与文件名不对应 → 两条 corrupt-id', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-badid-0001', cardText('ho-badid-0001').replace('id: ho-badid-0001', 'id: "bad id!!"'))
      writeCard(dir, 'pending', 'ho-mismat-0001', cardText('ho-mismat-0001').replace('id: ho-mismat-0001', 'id: ho-other-0001'))
      const hits = issuesOf(scanStore(dir), 'corrupt')
      assert.equal(hits.length, 2)
      assert.deepEqual(hits.map((h) => h.id).sort(), ['ho-badid-0001', 'ho-mismat-0001'])
      assert.match(hits.find((h) => h.id === 'ho-badid-0001')?.detail ?? '', /不合法/)
      assert.match(hits.find((h) => h.id === 'ho-mismat-0001')?.detail ?? '', /不对应/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('目录冒充 .md（读必炸）→ corrupt；archived 损坏段 severity 降为 warn', () => {
    const dir = tmpHome()
    try {
      mkdirSync(join(dir, 'pending', 'ho-isdir-0001.md'))
      writeFileSync(join(dir, 'archived', 'ho-archy-0001.md'), '---\nhandoff: 1\nid: [unclosed\n---\n', 'utf-8')
      const report = scanStore(dir)
      const hits = issuesOf(report, 'corrupt')
      assert.equal(hits.length, 2)
      assert.equal(hits.find((h) => h.id === 'ho-isdir-0001')?.severity, 'error')
      assert.equal(hits.find((h) => h.id === 'ho-archy-0001')?.severity, 'warn', 'archived 损坏段是历史档问题，不拦取件')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('形态（shape）：C4 六段 + 必填字段', () => {
  test('缺必备段（停在哪/读者警告）→ warn，点名缺哪些段', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-shape-0001', cardText('ho-shape-0001', { omitHeadings: ['停在哪', '读者警告'] }))
      const hits = issuesOf(scanStore(dir), 'shape')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.severity, 'warn')
      assert.match(hits[0]?.detail ?? '', /停在哪、读者警告/)
      assert.match(hits[0]?.detail ?? '', /取件不受影响/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('有 frontmatter 的卡缺 from.session → 缺必填字段；handoff 缺失同查', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-shape-0002', cardText('ho-shape-0002', { omitFields: ['session'] }))
      writeCard(dir, 'pending', 'ho-shape-0003', cardText('ho-shape-0003', { omitFields: ['handoff'] }))
      const hits = issuesOf(scanStore(dir), 'shape')
      assert.equal(hits.length, 2)
      assert.match(hits.find((h) => h.id === 'ho-shape-0002')?.detail ?? '', /from\.session/)
      assert.match(hits.find((h) => h.id === 'ho-shape-0003')?.detail ?? '', /handoff/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('C8 宽松卡（无 frontmatter）豁免字段查，只查六段：缺段仍点名', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-shape-0004', cardText('ho-shape-0004', { frontless: true, omitHeadings: ['涉及文件', '做到哪', '还差什么', '停在哪', '读者警告'] }))
      const hits = issuesOf(scanStore(dir), 'shape')
      assert.equal(hits.length, 1)
      assert.match(hits[0]?.detail ?? '', /涉及文件/)
      assert.doesNotMatch(hits[0]?.detail ?? '', /frontmatter 必填/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('孤儿侧车（orphan-sidecar）', () => {
  test('pending 孤儿（无主卡）→ warn；分块聚合成一条', () => {
    const dir = tmpHome()
    try {
      writeFileSync(join(dir, 'pending', 'ho-orph1-0001.envelope.json'), '{}', 'utf-8')
      writeFileSync(join(dir, 'pending', 'ho-orph2-0002.patch.001.gz'), Buffer.from([0x1f, 0x8b]))
      writeFileSync(join(dir, 'pending', 'ho-orph2-0002.patch.002.gz'), Buffer.from([0x1f, 0x8b]))
      const report = scanStore(dir)
      const hits = issuesOf(report, 'orphan-sidecar')
      assert.equal(hits.length, 2, `信封一条 + 分块聚合一条：${JSON.stringify(hits)}`)
      const env = hits.find((h) => h.id === 'ho-orph1-0001')
      assert.equal(env?.severity, 'warn')
      const chunk = hits.find((h) => h.id === 'ho-orph2-0002')
      assert.match(chunk?.detail ?? '', /patch\.001\.gz/)
      assert.match(chunk?.detail ?? '', /patch\.002\.gz/)
      assert.doesNotMatch(chunk?.detail ?? '', /取件中断残留/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('取件中断残留：pending 侧车 + archived 有主卡 → warn 点名「取件中断残留」', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'archived', 'ho-orph3-0003', cardText('ho-orph3-0003'))
      writeFileSync(join(dir, 'pending', 'ho-orph3-0003.patch'), 'diff\n', 'utf-8')
      const hits = issuesOf(scanStore(dir), 'orphan-sidecar')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.id, 'ho-orph3-0003')
      assert.equal(hits[0]?.severity, 'warn')
      assert.match(hits[0]?.detail ?? '', /取件中断残留/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('archived 侧车无主卡（滚动残留）→ info；archived 信封误置（有/无主卡）→ info', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'archived', 'ho-orph4-0004', cardText('ho-orph4-0004'))
      writeFileSync(join(dir, 'archived', 'ho-orph5-0005.patch'), 'diff\n', 'utf-8')
      writeFileSync(join(dir, 'archived', 'ho-orph4-0004.envelope.json'), '{}', 'utf-8')
      writeFileSync(join(dir, 'archived', 'ho-orph6-0006.envelope.json'), '{}', 'utf-8')
      const hits = issuesOf(scanStore(dir), 'orphan-sidecar')
      assert.equal(hits.length, 3, `三处都是 archived 残留：${JSON.stringify(hits)}`)
      for (const h of hits) assert.equal(h.severity, 'info')
      assert.match(hits.find((h) => h.id === 'ho-orph5-0005')?.detail ?? '', /滚动清理/)
      assert.match(hits.find((h) => h.id === 'ho-orph4-0004')?.detail ?? '', /消费即删/)
      assert.match(hits.find((h) => h.id === 'ho-orph6-0006')?.detail ?? '', /无同名主卡/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('主卡在册的 pending 侧车是正常随卡件：零孤儿发现', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-orph7-0007', cardText('ho-orph7-0007'))
      writeFileSync(join(dir, 'pending', 'ho-orph7-0007.envelope.json'), '{}', 'utf-8')
      writeFileSync(join(dir, 'pending', 'ho-orph7-0007.patch'), 'diff\n', 'utf-8')
      writeFileSync(join(dir, 'pending', 'ho-orph7-0007.hippo.jsonl'), '{}\n', 'utf-8')
      const report = scanStore(dir)
      assert.equal(issuesOf(report, 'orphan-sidecar').length, 0)
      assert.equal(report.issues.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('链三查（dangling / cycle / fork）', () => {
  test('supersedes 指向在册不存在的 id（卡面通道）→ warn', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-dang1-0001', cardText('ho-dang1-0001', { supersedes: 'ho-gone1-0001' }))
      const hits = issuesOf(scanStore(dir), 'chain-dangling')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.id, 'ho-dang1-0001')
      assert.equal(hits[0]?.severity, 'warn')
      assert.match(hits[0]?.detail ?? '', /ho-gone1-0001/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('supersedes 目标 id 形态非法（含路径穿越形态）→ 报断链但不做盘上探测', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-dang3-0003', cardText('ho-dang3-0003', { supersedes: '../../evil' }))
      const hits = issuesOf(scanStore(dir), 'chain-dangling')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.id, 'ho-dang3-0003')
      assert.equal(hits[0]?.severity, 'warn')
      assert.match(hits[0]?.detail ?? '', /形态非法/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('信封兜底通道：卡面无 supersedes、信封有 → 同样报 dangling（settings 链数据源同口径）', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-dang2-0002', cardText('ho-dang2-0002'))
      writeFileSync(join(dir, 'pending', 'ho-dang2-0002.envelope.json'), '{"handoff":1,"kind":"envelope","id":"ho-dang2-0002","supersedes":"ho-gone2-0002"}', 'utf-8')
      const hits = issuesOf(scanStore(dir), 'chain-dangling')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.id, 'ho-dang2-0002')
      assert.match(hits[0]?.detail ?? '', /ho-gone2-0002/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('活链零报：pending 子卡 supersedes archived 父卡（目标在盘）', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-chain-ok04', cardText('ho-chain-ok04', { supersedes: 'ho-chain-ok05' }))
      writeCard(dir, 'archived', 'ho-chain-ok05', cardText('ho-chain-ok05'))
      const report = scanStore(dir)
      assert.equal(issuesOf(report, 'chain-dangling').length, 0)
      assert.equal(issuesOf(report, 'chain-cycle').length, 0)
      assert.equal(issuesOf(report, 'chain-fork').length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('supersedes 环（A→B→A）→ 一条 error；自环同理', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'archived', 'ho-cycl1-0001', cardText('ho-cycl1-0001', { supersedes: 'ho-cycl2-0002' }))
      writeCard(dir, 'archived', 'ho-cycl2-0002', cardText('ho-cycl2-0002', { supersedes: 'ho-cycl1-0001' }))
      writeCard(dir, 'pending', 'ho-self1-0001', cardText('ho-self1-0001', { supersedes: 'ho-self1-0001' }))
      const report = scanStore(dir)
      const hits = issuesOf(report, 'chain-cycle')
      assert.equal(hits.length, 2, `二卡环 + 自环各一条：${JSON.stringify(hits)}`)
      for (const h of hits) assert.equal(h.severity, 'error')
      const two = hits.find((h) => h.id === 'ho-cycl1-0001')
      assert.match(two?.detail ?? '', /ho-cycl1-0001 → ho-cycl2-0002 → ho-cycl1-0001/)
      const self = hits.find((h) => h.id === 'ho-self1-0001')
      assert.match(self?.detail ?? '', /ho-self1-0001 → ho-self1-0001/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('一张卡被多张卡 supersedes（fork）→ 一条 warn 点名全部分叉', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'archived', 'ho-targ1-0001', cardText('ho-targ1-0001'))
      writeCard(dir, 'pending', 'ho-fork1-0001', cardText('ho-fork1-0001', { supersedes: 'ho-targ1-0001' }))
      writeCard(dir, 'pending', 'ho-fork1-0002', cardText('ho-fork1-0002', { supersedes: 'ho-targ1-0001' }))
      const report = scanStore(dir)
      const hits = issuesOf(report, 'chain-fork')
      assert.equal(hits.length, 1)
      assert.equal(hits[0]?.id, 'ho-targ1-0001')
      assert.equal(hits[0]?.severity, 'warn')
      assert.match(hits[0]?.detail ?? '', /ho-fork1-0001/)
      assert.match(hits[0]?.detail ?? '', /ho-fork1-0002/)
      // fork 子卡目标在盘：不应误报 dangling
      assert.equal(issuesOf(report, 'chain-dangling').length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('坏文件不炸扫描（fail-open）', () => {
  test('二进制垃圾 .md、目录冒充 .md、杂项文件并存：扫描完整返回且逐项点名', () => {
    const dir = tmpHome()
    try {
      writeFileSync(join(dir, 'pending', 'ho-junk1-0001.md'), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]))
      mkdirSync(join(dir, 'pending', 'ho-junk2-0002.md'))
      writeFileSync(join(dir, 'pending', 'unrelated.txt'), 'not protocol', 'utf-8')
      writeFileSync(join(dir, 'pending', 'ho-junk1-0001.claim'), '', 'utf-8')
      const report = scanStore(dir)
      // 二进制垃圾按宽松解析落 shape（无 frontmatter 无六段）；目录冒充落 corrupt；杂项不进体检闭集
      assert.equal(issuesOf(report, 'corrupt').some((h) => h.id === 'ho-junk2-0002'), true)
      assert.equal(issuesOf(report, 'shape').some((h) => h.id === 'ho-junk1-0001'), true)
      assert.equal(report.issues.some((h) => h.id.includes('unrelated')), false)
      assert.equal(report.issues.some((h) => h.id.includes('.claim')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('总线目录不存在 = 全新总线：干净返回零计数零降级', () => {
    const report = scanStore(join(tmpdir(), `doctor-nosuch-${Date.now()}`))
    assert.equal(report.ok, true)
    assert.equal(report.issues.length, 0)
    assert.deepEqual(report.scanned, { pendingCards: 0, archivedCards: 0, pendingSidecars: 0, archivedSidecars: 0 })
    assert.equal(report.notes, undefined)
  })

  test('issue 输出按 (kind, id) 排序：跨次运行可 diff', () => {
    const dir = tmpHome()
    try {
      writeCard(dir, 'pending', 'ho-sort1-0002', cardText('ho-sort1-0002', { omitHeadings: ['目标'] }))
      writeCard(dir, 'pending', 'ho-sort1-0001', cardText('ho-sort1-0001', { omitHeadings: ['目标'] }))
      writeFileSync(join(dir, 'pending', 'ho-sort2-0001.patch'), 'diff\n', 'utf-8')
      const report = scanStore(dir)
      const keys = report.issues.map((i) => `${i.kind}|${i.id}`)
      const sorted = [...keys].sort((a, b) => a.localeCompare(b))
      assert.deepEqual(keys, sorted)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
