/**
 * 信封机器签名（HMAC-SHA256）——handoff: 1 SPEC 一字不动：sig 长在
 * .envelope.json 的独立字段，不认识它的旧实现天然忽略（同 patch/supersedes 扩展口径）。
 *
 * 威胁面与边界（诚实声明）：共享总线（同步盘/git）上持有全部写权限的攻击者连
 * 密钥文件一起换，HMAC 防不住——它防的是同一同步域里**不持有密钥的写入方**
 * （同盘其他设备/应用的误写、越权写卡）与传输途中的意外损坏，把「这张卡真的
 * 来自写侧」从口口相传变成可校验事实。密钥文件 .signing-key.json 与总线同屋、
 * 随 HANDOFF_HOME 同步自然分发：同一同步域 = 同一信任域；取侧没有对应 keyId
 * 时如实降级为 no-key（未验签），绝不误报篡改。
 */
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveHome } from '@agent-handoff/core'

export interface SigningKey {
  keyId: string
  /** 32 字节 hex（64 字符）——形态闸用它区分「我们的密钥文件」和任意 JSON */
  secret: string
}

export function signingKeyPath(dir?: string): string {
  return join(resolveHome(dir), '.signing-key.json')
}

/** 读总线密钥，没有就生成。任何一步失败回 null——签名是尽力而为，绝不阻断寄存主流程。 */
export function loadOrCreateSigningKey(dir?: string): SigningKey | null {
  const p = signingKeyPath(dir)
  try {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
        if (raw !== null && typeof raw === 'object') {
          const keyId = (raw as Record<string, unknown>)['keyId']
          const secret = (raw as Record<string, unknown>)['secret']
          if (typeof keyId === 'string' && keyId !== '' && typeof secret === 'string' && secret.length >= 64) {
            return { keyId, secret }
          }
        }
      } catch { /* 坏 JSON：落到不覆盖策略 */ }
      return null // 文件在但形态不对：不覆盖用户文件，宁可不签
    }
    const key: SigningKey = { keyId: randomBytes(4).toString('hex'), secret: randomBytes(32).toString('hex') }
    writeFileSync(p, JSON.stringify(key, null, 2), 'utf-8')
    return key
  } catch {
    return null
  }
}

/** 稳定序列化：键递归排序——同内容不同键序产出同一 mac，防跨实现重序列化漂移 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function macOf(payload: unknown, secret: string): string {
  return createHmac('sha256', secret).update(canonical(payload)).digest('hex')
}

export interface EnvelopeSig {
  alg: 'hmac-sha256'
  keyId: string
  mac: string
}

/** 返回带签名的信封副本（入参不加字段——buildEnvelope 保持纯函数） */
export function signEnvelope<T extends Record<string, unknown>>(envelope: T, key: SigningKey): T & { sig: EnvelopeSig } {
  return { ...envelope, sig: { alg: 'hmac-sha256', keyId: key.keyId, mac: macOf(envelope, key.secret) } }
}

export type SigVerdict = 'ok' | 'tampered' | 'unsigned' | 'no-key'

/**
 * 取侧验签。sig 缺席 = unsigned（旧卡/外写卡兼容）；keyId 未知 = no-key；mac 不合 = tampered。
 * actualCardSha256：取件瞬间卡面 .md 的实际哈希——信封签名面含 cardSha256（写侧落卡回读），
 * 两者比对让「改卡面不改信封」的非持钥篡改也现形；actual 拿不到（读失败）时只验信封本身，
 * 如实回 ok 而不猜测。
 */
export function verifyEnvelopeSig(data: Record<string, unknown>, dir?: string, actualCardSha256?: string): SigVerdict {
  const sig = data['sig']
  if (sig === undefined || sig === null) return 'unsigned'
  if (typeof sig !== 'object') return 'tampered'
  const keyId = (sig as Record<string, unknown>)['keyId']
  const mac = (sig as Record<string, unknown>)['mac']
  if (typeof keyId !== 'string' || keyId === '' || typeof mac !== 'string' || mac === '') return 'tampered'
  let key: SigningKey | null = null
  try {
    const p = signingKeyPath(dir)
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
      if (raw !== null && typeof raw === 'object') {
        const kId = (raw as Record<string, unknown>)['keyId']
        const secret = (raw as Record<string, unknown>)['secret']
        if (kId === keyId && typeof secret === 'string' && secret.length >= 64) key = { keyId, secret }
      }
    }
  } catch { /* 读不了密钥 = 没有密钥 */ }
  if (key === null) return 'no-key'
  const payload: Record<string, unknown> = { ...data }
  delete payload['sig']
  if (macOf(payload, key.secret) !== mac) return 'tampered'
  const signedCardSha = payload['cardSha256']
  if (typeof signedCardSha === 'string' && signedCardSha !== '' && actualCardSha256 !== undefined) {
    return signedCardSha === actualCardSha256 ? 'ok' : 'tampered'
  }
  return 'ok'
}
