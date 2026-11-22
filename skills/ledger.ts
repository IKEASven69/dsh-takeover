/**
 * /ledger slash skill：确定性翻账零 LLM——按固定规则把 relay/ 取件记录、
 * lifecycle.jsonl 账本、pending/archived 卡面三源翻成一屏接力总账
 * （链 / 僵尸 / 闭集计数），让「取件了没下文」的僵尸卡和被静默吞掉的失败当场现形。
 * 单模板先例同 skills/inbox.ts INBOX_SKILL_CONTENT；userInvocable 而非
 * modelInvocable（slash 纪律，模型不可自行触发）。空数据回「账本还是空的」不编零。
 * @module dsh-takeover/skills/ledger
 */

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

export const LEDGER_SKILL_CONTENT = `# 接力总账（/ledger）

把 claude→卡→回执→延续/弃置/僵尸 全链翻成一屏账：谁接了棒、接了有没有下文、哪张卡被静默吞掉。**确定性翻账**——以下每一步都是机械读取与固定规则，不做任何推断、评分或百分比；同样的盘面翻出同样的账。

## 数据三源（全部只读，逐条如实）

1. \`~/.handoff/relay/*.json\`：接力记录（sessionId / provider / sourceId / cardId / title / at）。
   cardId 非空的记录 = 取件记录；坏 JSON 或形态不符的文件跳过，跳了几份要注明。
2. \`~/.handoff/lifecycle.jsonl\`：生命周期事件（at / stage / reason / target / detail），
   只有尾部 500 条窗口——事件数达到 500 时注明「已达窗口上限，更早历史不可见」。
3. 卡面：\`~/.handoff/pending/*.md\` 与 \`archived/*.md\` 的 id / 标题 / pushed_at，
   以及 frontmatter 的 \`supersedes\`（父卡 id）与 \`receipt.for\`（延续回执指向的源卡 id）。

## 步骤（机械执行）

1. **装链**：每张卡的 \`supersedes\` 指向父卡。父卡 id 在 pending/archived 任一盘有 .md 在场
   → 链上棒；不在场 → 该棒标「断链→<id>」，**账不断**。父卡文件在盘但解析失败 → 照常挂链，
   该棒标题/时刻留空（诚实缺省）。\`supersedes\` 成环 → 标「成环（环上 id：…）」，账不断。
   同一父棒被多棒接替 → 标「分叉」。从未接棒也不被接棒的孤立卡不进链，只进计数（无链棒）。
2. **判僵尸**：cardId 非空的 relay 取件记录指向的卡仍在 pending/ → 「僵尸在册」
   （relay 说取了、卡却没被消费——取件会话绕过消费即弃的实测证据）。
   其中 lifecycle 有 \`reason: lifeboat\` 且 target 命中的 → 改标「救生艇抢出卡在册」：
   救生艇抢出的卡生来就在册，成因与普通僵尸不同，**不得混入普通僵尸口径渲染**。
   卡已不在 pending（如在 archived）→ 不是僵尸。
3. **对不齐如实单列**：取件记录指向已不在册的卡（已消费后被滚动清理，或从未落盘）、
   lifecycle 端点指向已不在册的卡——单列原样，不硬归账、不猜成因。
4. **回执标注**：卡面带 \`receipt.for\` 的是延续回执卡，链上标「已延续→源卡」。

## 计数行（闭集原样，一个字都不要加工）

\`\`\`
X continued / Y abandoned / Z zombie（n=总棒 N）
\`\`\`

- X / Y 取 lifecycle 里 continued / abandoned 事件条数**原样**；Z = 僵尸命中数
  （救生艇抢出卡 M 张紧跟括注）；N = pending ∪ archived 盘上卡数。
- **绝不计算延续率、百分比或评分**：无账本数据前是编数字——评分机制明确不做。
- lifecycle 事件数达到 500 时，在计数行下注明窗口上限。

## 隐私与边界

- 账面只含 id / 标题 / provider / 时间；不落卡正文、不落 lifecycle detail 全文、不落绝对路径。
- relay/ 与 lifecycle.jsonl 是本机事实、不随 HANDOFF_HOME 同步——总账是**单机口径**；
  链上出现别机寄存的卡时只出卡面事实，不反推别机事件。

## 空账本

三源全空（relay 无记录、lifecycle.jsonl 不存在或 0 条、pending/archived 无卡）→
只回一句「账本还是空的——还没有任何接力发生」，不要编一张 0 表格。
`

/** /ledger 注册项 */
export function ledgerSkillRegistration(): SkillRegistration {
  return {
    name: 'ledger',
    description: '把 relay 取件记录、lifecycle 账本与在册卡面翻成一屏接力总账：链/僵尸/闭集计数，确定性翻账。',
    source: 'bundled',
    provider: 'dsh-takeover',
    invocation: { modelInvocable: false, userInvocable: true },
    content: LEDGER_SKILL_CONTENT,
  }
}
