import { writeFileSync } from 'node:fs'

// 挖 HN 评论树：切换动机的一手证词（usage limits / micro-manage / Omnara / git-conversation）
const threads = [
  { id: '49904074', label: 'Ask HN: hitting AI coding agent usage limits（切工具的头号动机）' },
  { id: '46736682', label: 'Ask HN: Do you micro-manage your agents?' },
  { id: '46991591', label: 'Launch HN: Omnara – Run Claude Code and Codex from anywhere（161 评）' },
]
const KEY = /switch|limit|quota|handoff|context|session|juggl|agent|codex|opencode|cursor|gemini|multiple|both|several|transfer|portab/i

function walk(item, depth, out) {
  if (depth > 2) return
  for (const c of item.children ?? []) {
    if (c.text && KEY.test(c.text)) {
      const t = c.text.replace(/<[^>]+>/g, ' ').replace(/&#x2F;/g, '/').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
      if (t.length > 60) out.push(`${'  '.repeat(depth)}- [${c.author}] ${t.slice(0, 420)}`)
    }
    walk(c, depth + 1, out)
  }
}

const out = []
for (const th of threads) {
  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/items/${th.id}`, { signal: AbortSignal.timeout(20000) })
    const item = await res.json()
    const bucket = []
    walk(item, 0, bucket)
    out.push(`## ${th.label}（筛后 ${bucket.length} 条相关评论）`)
    out.push(...bucket.slice(0, 40), '')
  } catch (e) { out.push(`## ${th.label} FAIL ${e.message}`, '') }
}
const text = out.join('\n')
writeFileSync('docs/_research-multi-harness-comments.txt', text, 'utf8')
console.log(text.slice(0, 2600))
console.log(`\n...总长 ${text.length}，全文 docs/_research-multi-harness-comments.txt`)
