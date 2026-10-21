/**
 * ⑤ 互通层 · INTERCHANGE v1 ↔ handoff:1 转换器逻辑自检（合成向量，随 CI 跑）。
 * 格式依据：dsh-chat-import docs/INTERCHANGE.md（turns IR + bundle 双层 sha256 指纹）。
 * @module dsh-takeover/interop-interchange
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { bundleToCardMarkdown, cardToInterchange, distillTurns, verifyBundle } from '../scripts/interop-interchange.mjs'

/** 按其规范合成的最小 bundle（双层指纹真实计算） */
function makeBundle(over: Record<string, unknown> = {}): string {
  const doc: Record<string, unknown> = {
    bundle: 'dsh-chat-import',
    format: 'interchange-v1',
    version: 1,
    exportedAt: 1710000000000,
    sourceSessionId: 'session-abc',
    title: '修复构建脚本',
    originalCwd: 'C:/work',
    landingHint: 'work',
    meta: { id: 'import-abc123', createdAt: 1710000000000, cwd: 'C:/work', sourceId: 'abc123' },
    log: '{"line":1}\n{"line":2}\n',
    turns: [
      {
        prompt: '修复构建脚本',
        steps: [
          {
            content: [{ type: 'text', text: '已定位 rollup 配置缺项' }],
            toolCalls: [{ id: 'call-1', name: 'edit', arguments: JSON.stringify({ file_path: 'build/rollup.config.ts' }) }],
            toolResults: [{ toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }], isError: false }],
          },
        ],
      },
      { prompt: '跑一遍测试', steps: [{ content: [{ type: 'text', text: '测试全绿' }], toolCalls: [], toolResults: [] }] },
    ],
    ...over,
  }
  const { sha256, ...rest } = doc as { sha256?: unknown }
  void sha256
  doc.sha256 = {
    session: createHash('sha256').update(String(doc.log), 'utf-8').digest('hex'),
    bundle: createHash('sha256').update(JSON.stringify(rest), 'utf-8').digest('hex'),
  }
  return JSON.stringify(doc, null, 2)
}

test('互通 · bundle 校验：指纹双对通过；任一指纹被篡改即拒', () => {
  const good = makeBundle()
  assert.equal(verifyBundle(good).ok, true)
  const tamperedLog = makeBundle().replace('"line":1', '"line":999')
  const doc = JSON.parse(tamperedLog)
  doc.sha256.bundle = '0'.repeat(64) // 文件级指纹也失效
  assert.equal(verifyBundle(JSON.stringify(doc)).ok, false)
  const wrongMark = JSON.stringify({ ...JSON.parse(good), bundle: 'other' })
  assert.equal(verifyBundle(wrongMark).ok, false, 'bundle 标记不符应拒')
})

test('互通 · 蒸馏：首尾 prompt 进 goal、tool-call 路径进文件、尾部 assistant 进 done', () => {
  const doc = JSON.parse(makeBundle())
  const d = distillTurns(doc.turns)
  assert.match(d.goal, /修复构建脚本/)
  assert.match(d.goal, /跑一遍测试/)
  assert.deepEqual(d.files, ['build/rollup.config.ts'])
  assert.match(d.done, /测试全绿/)
  assert.equal(d.turnCount, 2)
})

test('互通 · bundle → 卡：六段齐全、溯源字段如实（from.agent=dsh-chat-import、cwd 带入）', () => {
  const doc = JSON.parse(makeBundle())
  const md = bundleToCardMarkdown(doc)
  assert.match(md, /^---\nhandoff: 1\n/)
  assert.match(md, /agent: dsh-chat-import/)
  assert.match(md, /C:\/work/)
  for (const h of ['## 目标（goal）', '## 涉及文件（files）', '## 做到哪（done）', '## 还差什么（remaining）', '## 停在哪（stopped）', '## 读者警告（warnings）']) {
    assert.ok(md.includes(h), `缺段：${h}`)
  }
  assert.match(md, /rollup\.config\.ts/)
})

test('互通 · 卡 → interchange：字段齐全、轮结构与 tool 配对不变量（空工具=无需配对）', () => {
  const card = [
    '---',
    'handoff: 1',
    'id: ho-interop-0001',
    'from:',
    '  agent: dsh',
    '  session: ""',
    '  title: 互通测试卡',
    'to: any',
    'project: demo',
    'cwd: "C:/work/x"',
    'pushed_at: "2026-01-01T00:00:00+08:00"',
    '---',
    '',
    '## 目标（goal）',
    '',
    '把收件箱功能做完',
    '',
    '## 涉及文件（files）',
    '',
    '- src/tools.ts',
    '',
    '## 做到哪（done）',
    '',
    '- CURRENT_OBSERVED 核心路径完成',
    '',
    '## 还差什么（remaining）',
    '',
    '- 取件方收尾',
    '',
    '## 停在哪（stopped）',
    '',
    '- 停在寄存时刻',
    '',
    '## 读者警告（warnings）',
    '',
    '- HISTORY_REPORTED',
    '',
  ].join('\n')
  const doc = cardToInterchange(card) as Record<string, unknown>
  assert.equal(doc.interchange, 'dsh-chat-import')
  assert.equal(doc.version, 1)
  const meta = doc.meta as Record<string, unknown>
  assert.equal(meta.id, 'import-ho-interop-0001')
  assert.equal(meta.cwd, 'C:/work/x')
  assert.equal(doc.title, '互通测试卡')
  const turns = doc.turns as Array<{ prompt: string; steps: Array<{ toolCalls: unknown[]; toolResults: unknown[] }> }>
  assert.equal(turns.length, 1)
  assert.match(turns[0].prompt, /把收件箱功能做完/)
  assert.match(turns[0].prompt, /取件方收尾/)
  // 配对不变量：toolCalls[].id 都要有 toolResults[].toolCallId
  for (const t of turns) {
    for (const s of t.steps) {
      const callIds = new Set((s.toolCalls as Array<{ id: string }>).map((c) => c.id))
      const resultIds = new Set((s.toolResults as Array<{ toolCallId: string }>).map((r) => r.toolCallId))
      for (const cid of callIds) assert.ok(resultIds.has(cid), `tool call ${cid} 缺结果`)
    }
  }
})
