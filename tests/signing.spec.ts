/**
 * 信封机器签名测试：写侧自动签（密钥文件生成）→ 取侧验签三态（ok / tampered / no-key）
 * → 未签名旧卡兼容 → 篡改进死亡地图（sig_tampered）。全部临时 HANDOFF_HOME，不碰真实总线。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inboxLoad, pushHandoff, renderInbox } from '../src/tools.ts'
import { dismissPending } from '../src/settings.ts'
import { loadOrCreateSigningKey, macOf, signEnvelope, signingKeyPath, verifyEnvelopeSig } from '../src/signing.ts'
import { readLifecycleEvents } from '../src/lifecycle.ts'

const withHome = <T>(fn: (home: string) => T): T => {
  const home = mkdtempSync(join(tmpdir(), 'takeover-sign-home-'))
  try {
    return fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const pushCard = (home: string, goal: string) => {
  const r = pushHandoff(null, { goal, warnings: '' }, { dir: home })
  assert.equal(r.ok, true)
  if (!r.ok) throw new Error('push failed')
  return r
}

test('push 自动生成总线密钥并给信封签名；取件验签 ok 且渲染 🔐 行', () => {
  withHome((home) => {
    assert.ok(!existsSync(signingKeyPath(home)), '寄存前不应有密钥文件')
    const r = pushCard(home, '签名往返')
    const keyPath = signingKeyPath(home)
    assert.ok(existsSync(keyPath), '首次 push 应生成 .signing-key.json')
    const key = loadOrCreateSigningKey(home)
    assert.ok(key !== null)
    const env = JSON.parse(readFileSync(join(home, 'pending', `${r.id}.envelope.json`), 'utf-8')) as Record<string, unknown>
    const sig = env['sig'] as Record<string, unknown>
    assert.ok(sig, '信封应带 sig 字段')
    assert.equal(sig['alg'], 'hmac-sha256')
    assert.equal(sig['keyId'], key.keyId)
    // mac 与独立重算一致（canonical 序列化口径）
    const { sig: _omit, ...payload } = env
    assert.equal(sig['mac'], macOf(payload, key.secret))

    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.sig, 'ok')
    const rendered = renderInbox(null, load)[0]?.text ?? ''
    assert.ok(rendered.includes('信封签名校验通过'), `渲染应含验签通过行：${rendered}`)
  })
})

test('取前篡改信封 → tampered + 🚨 渲染 + sig_tampered 死亡地图事件', () => {
  withHome((home) => {
    const r = pushCard(home, '篡改检测')
    const p = join(home, 'pending', `${r.id}.envelope.json`)
    const env = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    env['goal'] = '被越权改写过的目标'
    writeFileSync(p, JSON.stringify(env), 'utf-8')
    const verdict = verifyEnvelopeSig(env, home)
    assert.equal(verdict, 'tampered')
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.sig, 'tampered')
    const rendered = renderInbox(null, load)[0]?.text ?? ''
    assert.ok(rendered.includes('签名校验失败'), `渲染应含篡改警告：${rendered}`)
    const events = readLifecycleEvents(home)
    assert.ok(events.some((e) => e.reason === 'sig_tampered' && e.target === r.id), '死亡地图应记 sig_tampered')
  })
})

test('卡面篡改（信封未动）→ cardSha256 比对抓出 tampered', () => {
  withHome((home) => {
    const r = pushCard(home, '卡面篡改检测')
    const md = join(home, 'pending', `${r.id}.md`)
    writeFileSync(md, `${readFileSync(md, 'utf-8')}\n被越权追加的内容\n`, 'utf-8')
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.sig, 'tampered', '信封 mac 未变但卡面哈希与签名面不符，应判 tampered')
    const rendered = renderInbox(null, load)[0]?.text ?? ''
    assert.ok(rendered.includes('签名校验失败'), `渲染应含篡改警告：${rendered}`)
  })
})

test('未签名旧卡兼容：无 sig 字段不报异常也不渲染签名行', () => {
  withHome((home) => {
    const r = pushCard(home, '旧卡形态')
    const p = join(home, 'pending', `${r.id}.envelope.json`)
    const env = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    delete env['sig']
    writeFileSync(p, JSON.stringify(env), 'utf-8')
    assert.equal(verifyEnvelopeSig(env, home), 'unsigned')
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.sig, undefined)
    const rendered = renderInbox(null, load)[0]?.text ?? ''
    assert.ok(!rendered.includes('签名'), '旧卡不应渲染任何签名行')
  })
})

test('dismiss：卡+信封+patch 三件全移 archived，pending 清空', () => {
  withHome((home) => {
    const r = pushCard(home, '忽略搬运验证')
    // 手工放一个 sidecar 补丁，模拟脏仓 push 的物质层
    writeFileSync(join(home, 'pending', `${r.id}.patch`), 'diff --git a/x b/x\n', 'utf-8')
    const d = dismissPending(r.id, home)
    assert.equal(d.ok, true)
    assert.equal(d.moved, 3)
    assert.deepEqual(readdirSync(join(home, 'pending')).filter((f) => f.startsWith(r.id)), [])
    assert.deepEqual(
      readdirSync(join(home, 'archived')).filter((f) => f.startsWith(r.id)).sort(),
      [`${r.id}.envelope.json`, `${r.id}.md`, `${r.id}.patch`],
    )
  })
})

test('跨信任域：keyId 不在本总线 → no-key，绝不误报篡改', () => {
  withHome((home) => {
    const r = pushCard(home, '跨域取件')
    const p = join(home, 'pending', `${r.id}.envelope.json`)
    const env = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>
    const foreign = signEnvelope({ goal: '别家总线写的卡' } as Record<string, unknown>, { keyId: 'ffff', secret: 'a'.repeat(64) })
    env['sig'] = foreign.sig
    writeFileSync(p, JSON.stringify(env), 'utf-8')
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.sig, 'no-key')
    const rendered = renderInbox(null, load)[0]?.text ?? ''
    assert.ok(rendered.includes('跨信任域'), `渲染应含未验签说明：${rendered}`)
  })
})

test('密钥文件形态闸：坏形态不覆盖不签；同内容不同键序 mac 一致', () => {
  withHome((home) => {
    writeFileSync(signingKeyPath(home), JSON.stringify({ hello: 'world' }), 'utf-8')
    assert.equal(loadOrCreateSigningKey(home), null, '坏形态密钥回 null')
    assert.deepEqual(JSON.parse(readFileSync(signingKeyPath(home), 'utf-8')), { hello: 'world' }, '不覆盖用户文件')
    // 稳定序列化：键序不影响 mac
    const secret = 'b'.repeat(64)
    const a = macOf({ x: 1, y: { a: '1', b: '2' } }, secret)
    const b = macOf({ y: { b: '2', a: '1' }, x: 1 }, secret)
    assert.equal(a, b)
  })
})
