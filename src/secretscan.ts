/**
 * push 侧密钥扫描（0.4.1 物质层安全闸）：卡文本由模型手写、随同步盘跨机传播并进入
 * 下游会话上下文——比 git 更宽的泄漏面（git 仓有 gitleaks 守，交接盘什么都没有）。
 *
 * 判据遵循先例共识（gitleaks / GitHub Push Protection / git-secrets）：
 * 高置信模式（云厂商 key、私钥头、常见 token 前缀）+ 关键词上下文里的高熵串。
 * 命中 → push 拒绝（ok:false）并回喂理由；确要寄存走 allowSecrets 留痕旁路。
 * 纯函数零依赖，误报由旁路兜底而不是静默放行。
 */

export interface SecretHit {
  /** 命中规则名（中文，供人读） */
  rule: string
  /** 所在段（goal/files/…） */
  section: string
  /** 命中串的掩码预览（只露前 4 后 2，中间打码） */
  masked: string
}

/** 熵判定：字符集多样性 × 长度（简化 Shannon——长 hex/base64 串必然高分） */
function entropy(s: string): number {
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const n of freq.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

/** 高熵串：≥20 字符、熵 ≥3.5、同时含字母与数字（区分普通长句） */
function isHighEntropyToken(s: string): boolean {
  return s.length >= 20 && entropy(s) >= 3.5 && /[a-zA-Z]/.test(s) && /[0-9]/.test(s)
}

/** 高置信模式：命中即报（每条一个正则 + 规则名） */
const PATTERNS: Array<{ rule: string; re: RegExp }> = [
  { rule: 'AWS Access Key（AKIA…）', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: 'AWS 临时凭证（ASIA…）', re: /\bASIA[0-9A-Z]{16}\b/g },
  { rule: 'GitHub App token（ghp_/gho_/ghu_/ghs_/ghr_）', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { rule: 'GitHub fine-grained PAT（github_pat_…）', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { rule: 'DeepSeek API key', re: /\bsk-[a-f0-9]{32}\b/g },
  { rule: 'OpenAI 风格 key（sk-…）', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { rule: 'Anthropic API key（sk-ant-…）', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: 'Slack token（xox…）', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { rule: '私钥文件头', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { rule: 'GitLab token（glpat-…）', re: /\bglpat-[A-Za-z0-9_-]{16,}/g },
  { rule: 'npm token（npm_…）', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { rule: 'PyPI token（pypi-…）', re: /\bpypi-[A-Za-z0-9_-]{30,}/g },
  { rule: 'JWT（eyJ 头部.载荷.签名）', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { rule: '连接串口令（db://user:pass@）', re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:@/]+:([^\s:@/]{6,})@/g },
]

/** 关键词上下文里的赋值/声明：password = "…"、token: '…' 等，值高熵即报 */
const ASSIGNMENT =
  /(?:[\w.-]{0,40}(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)[\w.-]{0,40})\s*[:=]\s*["']?([A-Za-z0-9_+/=.:-]{14,})["']?/gi

const SECTION_KEYS = ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings', 'suggested'] as const

function mask(s: string): string {
  if (s.length <= 10) return '*'.repeat(s.length)
  const keep = Math.max(2, Math.floor(s.length * 0.08))
  return `${s.slice(0, keep)}${'*'.repeat(s.length - keep - 2)}${s.slice(-2)}`
}

/** 扫描六段文本；返回全部命中（空数组 = 干净）。确定性：同一输入永远同一输出。 */
export function scanSecrets(sections: Record<string, string | undefined>): SecretHit[] {
  const hits: SecretHit[] = []
  const seen = new Set<string>()
  // 审查 #3：遍历调用方给的全部键（含 title/to/project 标量），不再固定六段——
  // 密钥从任何标量侧门出盘等于没闸
  for (const key of Object.keys(sections)) {
    const text = sections[key]
    if (typeof text !== 'string' || text === '') continue
    for (const { rule, re } of PATTERNS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        // 口令在捕获组的规则（连接串）报组内容，其余报全匹配
        const matched = m[1] !== undefined && rule.includes('连接串') ? m[1] : m[0]
        // 去重按命中文本（不同规则罩同一串只报一次，具体规则在前优先标签）——修审查 #7
        const sig = `${key}:${matched}`
        if (!seen.has(sig)) {
          seen.add(sig)
          hits.push({ rule, section: key, masked: mask(matched) })
        }
      }
    }
    let am: RegExpExecArray | null
    ASSIGNMENT.lastIndex = 0
    while ((am = ASSIGNMENT.exec(text)) !== null) {
      const value = am[1]
      if (value === undefined) continue
      if (!isHighEntropyToken(value)) continue
      // 键名从整段匹配里回提（键名自身是非捕获组，允许任意前后缀——审查 #1）
      const kw = /password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key/i.exec(am[0])?.[0] ?? 'key'
      const sig = `assignment:${key}:${value}`
      if (!seen.has(sig)) {
        seen.add(sig)
        hits.push({ rule: `敏感词赋值（${kw}）`, section: key, masked: mask(value) })
      }
    }
  }
  return hits
}
