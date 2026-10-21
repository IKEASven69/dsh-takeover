/**
 * 参考实现适配器：把 @agent-handoff/core（dsh-takeover 的协议实现）接进符合性套件。
 * @module conformance/adapter-core
 */
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listPending, loadCard, resolveHome, writeCard } from '@agent-handoff/core'

export default {
  name: '@agent-handoff/core（参考实现）',
  home() {
    return resolveHome()
  },
  writeCard(_text) {
    const card = {
      handoff: 1,
      id: '',
      from: { agent: 'conformance', session: 'sessions/vector.jsonl', title: '套件向量卡' },
      to: 'any',
      project: 'conformance',
      cwd: '/corpus/proj0',
      pushed_at: '2026-01-01T00:00:00+08:00',
      git: { branch: 'main', changed: [] },
      tasks: [],
      extras: {},
      sections: {
        goal: '套件目标段。',
        files: '- /corpus/proj0/vector.ts',
        done: '- CURRENT_OBSERVED 套件构造。',
        remaining: '- 取件方继续。',
        stopped: '停在构造时刻。',
        warnings: '- HISTORY_REPORTED 合成语料。',
      },
    }
    writeCard(card)
    return { id: card.id }
  },
  listPending() {
    return readdirSync(join(resolveHome(), 'pending')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
  },
  load(id) {
    const card = loadCard(id)
    return { text: `id: ${card.id}\n\n${card.sections.goal ?? ''}` }
  },
  writeRaw(filename, text) {
    writeFileSync(join(resolveHome(), 'pending', filename), text, 'utf-8')
  },
}
