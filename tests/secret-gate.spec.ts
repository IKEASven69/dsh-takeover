/** 密钥扫描 + 空壳守门 + 低信息客户端数据（0.4.1 调研裁决 build 项） */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pushHandoff, renderInbox } from '../src/tools.ts'
import { scanSecrets } from '../src/secretscan.ts'

const tmpHome = () => mkdtempSync(join(tmpdir(), 'dsh-gate-'))

test('scanSecrets：云厂商 key / 私钥头 / 常见 token 前缀全命中并掩码', () => {
  const hits = scanSecrets({
    warnings: [
      'aws AKIAIOSFODNN7EXAMPLE',
      'github ghp_1234567890abcdefghij1234567890ABCD',
      'openai sk-proj-abcdefghijklmnopqrst1234',
      '-----BEGIN RSA PRIVATE KEY-----',
      'google AIzaSyA-1234567890abcdefghijklmnopqrstu',
    ].join('\n'),
  })
  const rules = hits.map((h) => h.rule)
  assert.ok(rules.some((r) => r.includes('AWS')), 'AWS 应命中')
  assert.ok(rules.some((r) => r.includes('GitHub')), 'GitHub 应命中')
  assert.ok(rules.some((r) => r.includes('OpenAI')), 'OpenAI 应命中')
  assert.ok(rules.some((r) => r.includes('私钥')), '私钥头应命中')
  assert.ok(rules.some((r) => r.includes('Google')), 'Google 应命中')
  for (const h of hits) {
    assert.ok(!JSON.stringify(h).includes('AKIAIOSFODNN7EXAMPLE'.slice(4, -2)), '掩码不得泄漏中段')
    assert.equal(h.section, 'warnings')
  }
})

test('scanSecrets：普通长句不误报；关键词赋值仅高熵值命中', () => {
  assert.deepEqual(scanSecrets({
    goal: '把交接卡的手写蒸馏纪律写进 skill，配置里 password 字段要 redact——这句没有密钥值',
    done: '测试 130/130 通过（CURRENT_OBSERVED）',
  }), [])
  const hit = scanSecrets({ warnings: `token = "j8Km2Pq7Rs4Tu9Vw1Xy3Zα6Bc0De2Fg"` })
  assert.equal(hit.length, 1)
  assert.ok(hit[0]?.rule.includes('敏感词赋值'))
})

test('push 密钥闸：命中拒绝并回喂 redact 指引；allowSecrets 留痕旁路', () => {
  const home = tmpHome()
  try {
    const blocked = pushHandoff(null, {
      goal: '配置说明',
      warnings: 'aws key: AKIAIOSFODNN7EXAMPLE（测试样例）',
      cwd: 'D:/nonexistent-xyz',
    })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.match(blocked.error, /密钥闸/)
    assert.match(blocked.error, /redact/)
    assert.match(blocked.error, /allowSecrets/)

    const bypass = pushHandoff(null, {
      goal: '配置说明',
      warnings: 'aws key: AKIAIOSFODNN7EXAMPLE（测试样例）',
      cwd: 'D:/nonexistent-xyz',
      allowSecrets: true,
      confirmSkeleton: true, // 混合手写+占位仍会触发空壳守门，两道旁路可叠加
    })
    assert.equal(bypass.ok, true)
    if (!bypass.ok) return
    assert.deepEqual(bypass.secretsBypass, ['AWS Access Key（AKIA…）'])
    assert.match(bypass.note, /密钥闸旁路留痕/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('取件补丁指引含 -3way 冲突兜底（调研裁决 P3：文案级成本趋零）', () => {
  const text = renderInbox(null, {
    ok: true, action: 'load', id: 'ho-x-0001', text: '卡', mismatches: [],
    patchPath: 'D:/h/archived/ho-x-0001.patch', patchBytes: 1024,
  }).map((b) => b.text).join('\n')
  assert.ok(text.includes('git apply --check'), '--check 在场')
  assert.ok(text.includes('git apply -3'), '-3way 兜底在场')
})
