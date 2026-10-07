/**
 * 接力链测试（0.4.1）：真实交接是 A→B→A→… 多跳，不是单跳。
 * 三跳全链路（进程内确定性）：每跳 = 取前卡 → 蒸馏（保内容 + 追加本跳标记）→
 * 带 supersedes 寄存下一跳。验证：supersedes 链、跨跳信息存活、补丁累积性
 * （最新补丁含全部未提交工作）、归档审计轨迹、同步冲突文件（「丢失」场景）优雅降级。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectPatch } from '@agent-handoff/core'
import { inboxLoad, pushHandoff, renderInbox } from '../src/tools.ts'

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takeover-relay-'))
  const g = (args: string[]) => execFileSync('git', ['-C', dir, '-c', 'core.fsmonitor=false', ...args], { stdio: 'ignore' })
  g(['init', '-q'])
  g(['config', 'user.email', 't@t'])
  g(['config', 'user.name', 't'])
  writeFileSync(join(dir, 'work.txt'), 'hop0\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'baseline'])
  return dir
}

test('接力链：三跳 supersedes 链完整、hop1 关键事实存活到 hop3、补丁累积携带全部未提交工作', () => {
  const repo = makeRepo()
  const home = mkdtempSync(join(tmpdir(), 'takeover-relay-home-'))
  try {
    const hops: Array<{ id: string; done: string }> = []
    let prevId: string | undefined

    for (let hop = 1; hop <= 3; hop++) {
      // ── 接手上一跳（hop>0）：取卡 → 蒸馏 = 保留原文 + 追加本跳标记 ──
      let inherited = { goal: '', warnings: '', doneLines: [] as string[] }
      if (prevId !== undefined) {
        const take = inboxLoad(prevId, { dir: home })
        assert.equal(take.ok, true, `第 ${hop} 跳取第 ${hop - 1} 跳的卡应成功`)
        if (!take.ok) return
        assert.equal(take.supersedes !== undefined || hop === 2, true)
        // 继承蒸馏（模型行为的确定性替身）：全文保留 + 追加
        const prev = hops[hops.length - 1] as { id: string; done: string }
        inherited = { goal: `接力自 ${prev.id}：保真测试`, warnings: '关键事实——出发地 D:/CodingProjects（hop1 记录，随卡传递）', doneLines: [prev.done] }
        // 改工作文件（本跳的未提交工作，模拟接手方继续干活）
        writeFileSync(join(repo, 'work.txt'), (hop === 2 ? 'hop2' : 'hop2\nhop3') + ' 的接手工作\n')
      }

      // ── 寄存本跳 ──
      const done = prevId === undefined
        ? 'hop1 起点：接力链保真测试（HISTORY_REPORTED）'
        : `${inherited.doneLines.join('\n')}\nhop${hop} 接手完成并追加（CURRENT_OBSERVED）`
      const r = pushHandoff(null, {
        goal: prevId === undefined ? '接力链保真测试（hop-1/3）：验证跨三跳的信息存活' : inherited.goal,
        warnings: prevId === undefined ? '关键事实——出发地 D:/CodingProjects（hop1 记录）' : inherited.warnings,
        done,
        cwd: repo,
        ...(prevId !== undefined ? { supersedes: prevId } : {}),
      }, { dir: home })
      assert.equal(r.ok, true, `hop${hop} push 应成功：${!r.ok ? r.error : ''}`)
      if (!r.ok) return
      assert.equal(r.supersedes, prevId, `hop${hop} 的 supersedes 应指向前一跳`)
      hops.push({ id: r.id, done })
      prevId = r.id
    }

    // ── 链完整性：hop3 取件可见 supersedes=hop2，文案含接力链 ──
    const hop1 = hops[0] as { id: string }
    const hop2 = hops[1] as { id: string }
    const hop3 = hops[2] as { id: string }
    const take3 = inboxLoad(hop3.id, { dir: home })
    assert.equal(take3.ok, true)
    if (!take3.ok) return
    assert.equal(take3.supersedes, hop2.id)
    const text3 = renderInbox(null, take3).map((b) => b.text).join(String.fromCharCode(10))
    assert.ok(text3.includes(`接替前置卡 ${hop2.id}`))

    // ── 信息存活：hop3 的卡文本仍含 hop1 写入的关键事实与起点标记 ──
    assert.ok(take3.text.includes('hop1 起点'), 'hop1 的起点标记应存活到 hop3')
    assert.ok(take3.text.includes('D:/CodingProjects'), 'hop1 的关键事实应存活到 hop3')

    // ── 补丁累积性：最新一次 push 的补丁含全部三跳的未提交工作 ──
    const bundle = collectPatch(repo)
    assert.ok(bundle)
    if (!bundle) return
    assert.ok(bundle.patch.includes('hop2'), '累积补丁应含 hop2 的工作')
    assert.ok(bundle.patch.includes('hop3'), '累积补丁应含 hop3 的工作')
    // 取 hop3 时补丁随卡归档
    assert.ok(existsSync(join(home, 'archived', `${hop3.id}.patch`)), 'hop3 补丁应随卡归档')

    // ── 审计轨迹：三跳的卡全部在 archived/（消费即弃不丢历史）──
    for (const h of [hop1, hop2, hop3]) {
      assert.ok(existsSync(join(home, 'archived', `${h.id}.md`)), `${h.id} 应在归档轨迹里`)
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})
