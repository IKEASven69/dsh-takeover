import { writeFileSync } from 'node:fs'

// 竞品 issue 区挖掘：feature request 与抱怨 = 最硬的需求证据。
// state=all 拿开+关（关掉的往往是已满足的需求，也是证据）。PR 排除。
const repos = [
  'jazzyalex/agent-sessions',
  'giuliastro/harness-remote',
  'nicosuave/memex',
  'ccpopy/cc-sessions',
]
const out = []
for (const repo of repos) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=50&sort=created&direction=desc`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-takeover-research' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) { out.push(`## ${repo}: HTTP ${res.status}`); continue }
    const list = await res.json()
    const issues = list.filter((i) => !i.pull_request)
    out.push(`## ${repo}（共取到 ${issues.length} 条 issue）`)
    for (const i of issues) {
      const labels = (i.labels ?? []).map((l) => l.name).join(',')
      const body = (i.body ?? '').replace(/\s+/g, ' ').slice(0, 220)
      out.push(`- [${i.state}] #${i.number} ${i.title}（${labels || '无标签'}，评论 ${i.comments}）\n  ${body}`)
    }
    out.push('')
  } catch (e) {
    out.push(`## ${repo}: FETCH_FAIL ${e.message}`)
  }
}
const text = out.join('\n')
writeFileSync('docs/_research-issues-raw.txt', text, 'utf8')
console.log(text.slice(0, 1200))
console.log(`\n...总长 ${text.length} 字符，全文在 docs/_research-issues-raw.txt`)
