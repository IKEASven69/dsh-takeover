/**
 * /handoff slash skill：指示 agent 把当前会话蒸馏成六段协议卡片，
 * 然后调 handoff_push 落盘。userInvocable 而非 modelInvocable（用户显式触发纪律）。
 * @module dsh-takeover/skills/handoff
 */

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

export const HANDOFF_SKILL_CONTENT = `# 交接当前会话（/handoff）

把当前 DSH 会话蒸馏成一张 handoff: 1 协议卡片，寄存进共享收件箱 \`~/.handoff/pending/\`，任何 agent 开局可取件。

## 写卡纪律（协议语义六条）

1. **证据账本四态**：卡片正文里每条完成 / 测试 / 部署 / 上线类陈述，必须标且只标一个状态——
   \`CURRENT_OBSERVED\`（本轮亲自核对过）/ \`HISTORY_REPORTED\`（仅见于历史）/
   \`MISMATCH\`（当下证据冲突）/ \`UNAVAILABLE\`（无法恢复或验证）。
   没在本轮核对的，一律 \`HISTORY_REPORTED\`。文件存在只证明文件存在，不证明构建通过或提交已推送。
   **核验降级纪律**：核验工具不可用或报错（如宿主 shell 权限问题）时，把对应陈述标 \`UNAVAILABLE\`
   然后继续主线任务；**永远不要尝试修复宿主环境、不要为此申请提权、不要加载诊断类技能**。
2. **原文不进卡片**：\`from.session\` 只是指针，卡片只带蒸馏后的快照。
3. **不重复已有产物**：计划文档、设计文档、大段代码只写路径，不复制内容——接手方自读。
4. **redact 是生产者义务**：写卡前抹掉密钥、口令、token、PII。
5. **尽量给「建议加载」段**：下个会话该预载什么 skill / 先读哪些文件。
6. **反向锚定 + 剪枝**：先从会话最终状态（最后一条回复、通过的测试、用户确认）确定"当前活跃真相"，
   再回填支撑它的过程；同一实体的多次演变（方案 A→B→C、依赖 X→Y）只保留最终形态，
   被否决 / 替换 / 推翻的中间结论一律剪出正文（它们的教训如值得保留，压缩成一句放进「读者警告」）。
7. **失败尝试也是交接物**：试过什么方案、为什么放弃——压缩成一句写进「读者警告」，
   接手方不重复踩坑比多写一条「做到哪」更有价值。
8. **环境与机器边界**：运行中的服务 / 端口 / 需要的环境变量 / 关键工具版本 / 源机 OS，
   写进「读者警告」；仅存在于源机的路径（本机部署目录、临时产物）标注「仅源机」——
   跨机接手时这些路径不可达，未提交改动的代码本体由插件随卡补丁携带，无需手抄 diff。

## 步骤

1. 回顾本会话，按六段组织内容，标题中文、顺序固定：
   - **目标**：这个会话在做什么、最后一条用户请求是什么。
   - **涉及文件**：碰过的文件 / 目录 / 命令。
   - **做到哪**：已完成的事 + 每条证据状态（四态之一）。
   - **还差什么**：未完成事项。
   - **停在哪**：精确停止点 + 接手方最安全的第一步。
   - **读者警告**：过期信息、坑、redact 说明。
2. 调 \`handoff_push\`，把六段作为参数传入（goal / files / done / remaining / stopped / warnings，
   可选 suggested / title / to / project；接力寄存传 supersedes=<前卡id>）。
   留空的段由插件从会话事件流确定性兜底（不调 LLM）；未提交改动会自动随卡打补丁，
   你不需要也不应该在卡片里手抄 diff。但你亲手蒸馏的内容永远比兜底强——尽量六段都自己写。
   两道守门被拦时的正确反应：**密钥闸**（报「发现疑似密钥」）→ redact 后重试，
   确要带密传 allowSecrets: true（留痕）；**空壳卡守门**（报「六段全是兜底占位」）→
   这是在提醒你亲手蒸馏——确要寄存空壳（如「无在途工作」声明）传 confirmSkeleton: true。
3. 把返回的卡片 id 与路径告诉用户。对方（或另一台机器上的你）用 \`handoff_inbox\` 或 \`/inbox\` 取件。
`

/** /handoff 注册项 */
export function handoffSkillRegistration(): SkillRegistration {
  return {
    name: 'handoff',
    description: '把当前会话蒸馏成六段交接卡片，寄存进 ~/.handoff/pending/ 共享收件箱。',
    source: 'bundled',
    provider: 'dsh-takeover',
    invocation: { modelInvocable: false, userInvocable: true },
    content: HANDOFF_SKILL_CONTENT,
  }
}
