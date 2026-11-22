/**
 * /almanac slash skill：接力年鉴——按固定规则把这台机器真实发生过的接力史编成一页
 * 可分享、可审计的 markdown（理由直方图 / 救生艇抢出 / 接力来源家 / 归档窗口）。
 * 确定性翻账零 LLM 推断：每项统计单源可对账，只计数不评分（延续率评分是判死项）。
 * 单模板先例同 skills/inbox.ts INBOX_SKILL_CONTENT 与 skills/ledger.ts；渲染结构与
 * src/almanac.ts renderAlmanac 同构（集成面只落本模板与注册，不改纯函数模块）。
 * userInvocable 而非 modelInvocable（slash 纪律）。零数据回「这条总线还没有故事」不编表。
 * @module dsh-takeover/skills/almanac
 */

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

export const ALMANAC_SKILL_CONTENT = `# 接力年鉴（/almanac）

把**这台机器**真实发生过的接力史编成一页可分享、可审计的年鉴：理由直方图 / 救生艇抢出 /
接力来源家 / 归档窗口。**只计数、不评分**——延续率、评分、等级一律不做（无账本数据前是
编数字）；同样的盘面编出同样的页。

## 数据三源（全部只读，逐项单源对账）

1. \`~/.handoff/lifecycle.jsonl\`：生命周期事件（at / stage / reason / target / detail），
   只有尾部 500 条窗口——事件数达到 500 时注明「已达窗口上限，更早历史不可见」。
2. \`~/.handoff/relay/*.json\`：接力溯源（provider / sourceId / cardId / title / at）。
   坏 JSON 或形态不符的文件跳过并计数，不能混进任何 provider 计数。
3. \`~/.handoff/archived/\`：归档目录现场清点——.md 卡与非 .md 侧车分开数
   （滚动保留最近 50 张，只滚 .md、侧车不随之清理）。

## 步骤（机械执行）

1. **理由直方图**：把 lifecycle 尾 500 条窗口内的全部事件按 \`reason\` 计数。
   理由是闭集（secret_gate / skeleton_gate / lifeboat / oversize / parse_error /
   memory-absorbed / absorbed-write / config-injected / restored / drift_mismatch /
   git_unavailable / sig_tampered / continued / abandoned / unknown）——**全闭集在册**，
   缺席的理由也列出计 0，逐项可与账本行对账；窗口外的历史不存在，不冒充全史。
2. **救生艇抢出**：reason=lifeboat 的事件逐条列出 target 卡 id 与事件时刻（at）。
   列表只含 id + 时刻，detail 原文留在账本不进年鉴。
3. **接力来源家**：relay/*.json 按 provider 字段统计——**非空（trim 后非空串）才计入**，
   去重后列家名（字典序）；provider 为空串/缺席的溯源如实不计入 distinct 口径；
   解析失败的文件单独计一笔「未能解析」，不静默漏。
4. **归档窗口**：archived/ 现场清点 .md 卡数与侧车数（不验卡面健康——那是总线体检的
   职责，年鉴单源纪律）。

## 渲染（结构与 src/almanac.ts renderAlmanac 同构）

- 标题「接力年鉴 · 这台机器」；口径行注明「只计数不评分」「数字随本机排放漂移，以重跑为准」
  与生成时刻。
- 四节各带窗口标注：理由直方图（lifecycle 尾部 500 条窗口内 N 行）、救生艇抢出（X 次）、
  接力来源（Y 家）、归档窗口（archived/ · 滚动 50 张）。
- 末尾附扫描降级附注（目录在场但读取失败才记；目录缺席 = 全新机器的诚实零态，不加附注）。

## 红线（不可违反）

- **措辞只说「这台机器」**：lifecycle.jsonl 与 relay/ 不随换机同步（机器本地记录不入库），
  年鉴是本机口径——不得写成「全总线 / 全网」。
- **隐私**：全文无卡正文、无绝对路径、无会话 id / 会话标题 / provider 溯源的 sessionId——
  只有计数、闭集理由名、来源家名与卡 id。
- **绝不评分**：不出现延续率、百分比评分、等级或排名。

## 零数据

三源全空（lifecycle.jsonl 不存在或 0 条、relay/ 无文件、archived/ 无卡）→
只回一句「这条总线还没有故事」的诚实说明（三处目录各是什么），不要编一张 0 表格。
`

/** /almanac 注册项（接线进 skills/index.ts 的 skillRegistrations() 数组属集成面） */
export function almanacSkillRegistration(): SkillRegistration {
  return {
    name: 'almanac',
    description: '把这台机器的真实接力史编成一页可分享、可审计的年鉴：理由直方图/救生艇/来源家/归档窗口，只计数不评分。',
    source: 'bundled',
    provider: 'dsh-takeover',
    invocation: { modelInvocable: false, userInvocable: true },
    content: ALMANAC_SKILL_CONTENT,
  }
}
