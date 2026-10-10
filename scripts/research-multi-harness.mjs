import { writeFileSync } from 'node:fs'

// 多 harness 切换者画像取证：HN 讨论 + 多代理编排工具 issue 区。
// 输出结构化原文到 docs/_research-multi-harness-raw.txt
const out = []

// ---- HN：为什么切、怎么切的真实讨论 ----
const hnQueries = [
  'claude code codex',
  'multiple AI coding agents',
  'switching between coding agents',
  'AI coding agent workflow',
]
for (const q of hnQueries) {
  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=8`, { signal: AbortSignal.timeout(15000) })
    const r = await res.json()
    out.push(`## HN 故事：「${q}」（命中 ${r.nbHits}）`)
    for (const h of r.hits ?? []) {
      if ((h.points ?? 0) < 5 && (h.num_comments ?? 0) < 3) continue
      out.push(`- [${h.points ?? 0}分/${h.num_comments ?? 0}评] ${h.title} | ${h.url ?? '(无链接)'} | ${h.created_at?.slice(0, 10)} | objectID=${h.objectID}`)
    }
    out.push('')
  } catch (e) { out.push(`## HN「${q}」FAIL ${e.message}`) }
}

// ---- GitHub：多代理编排/切换工具的 issue（多工具用户的诉求金矿）----
const repos = [
  'BloopAI/vibe-kanban',
  'stravu/crystal',
  'awslabs/cli-agent-orchestrator',
]
for (const repo of repos) {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=all&per_page=40&sort=created&direction=desc`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-takeover-research' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) { out.push(`## ${repo}: HTTP ${res.status}`); continue }
    const list = (await res.json()).filter((i) => !i.pull_request)
    out.push(`## ${repo}（${list.length} 条 issue）`)
    for (const i of list) {
      const labels = (i.labels ?? []).map((l) => l.name).join(',')
      const body = (i.body ?? '').replace(/\s+/g, ' ').slice(0, 200)
      out.push(`- [${i.state}] #${i.number} ${i.title}（${labels || '无标签'}，评论 ${i.comments}）\n  ${body}`)
    }
    out.push('')
  } catch (e) { out.push(`## ${repo}: FAIL ${e.message}`) }
}

const text = out.join('\n')
writeFileSync('docs/_research-multi-harness-raw.txt', text, 'utf8')
console.log(text.slice(0, 3000))
console.log(`\n...总长 ${text.length}，全文 docs/_research-multi-harness-raw.txt`)
