/**
 * /sendto slash skill：点名投递——把当前会话蒸馏成六段协议卡片，to=machine:<机器名>
 * 寄存进共享收件箱，随既有换机同步（pending/ 已在同步范围，src/sync.ts:36）
 * 跨机即达；目标机第一眼看到「点名给我」的卡，别机不冒领。
 * userInvocable 而非 modelInvocable（用户显式触发纪律，/handoff 同款）。
 *
 * 诚实边界：约定寻址无在线握手——目标机未装插件/未开换机同步时卡片到盘但
 * 无人认领；在线握手与投递回执属 0.27（docs/需求调研-1119.md:31/:73 原裁定，
 * 本波只提前投卡本体），所以指引文案只说「已投递到同步」，不声明对方已收到。
 * 指引行句式与 src/browser-view.ts:123 pickupCommand 耦合（tests/directed.spec.ts
 * 有逐句断言，改句式两处同步）。
 * @module dsh-takeover/skills/sendto
 */

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

export const SENDTO_SKILL_CONTENT = `# 点名投递到指定机器（/sendto）

把当前 DSH 会话蒸馏成一张 handoff: 1 协议卡片，\`to\` 写成 \`machine:<目标机器名>\` 寄存进
共享收件箱 \`~/.handoff/pending/\`，随既有换机同步（git 端点）跨机到达。目标机的收件箱
会把这张卡归入「点名给我」一组，第一眼看到；别机的收件箱不冒领（目标机需装有带
点名分组的插件版本；旧版收件箱至少在列表行带 to 字段可查）。

## 用法

\`/sendto <机器名>\`——机器名是目标机在它本机 \`~/.handoff/machine.json\` 里登记的名字。
用户没给机器名时先问一句「投给哪台机器」，不要猜。

## 步骤

1. **确认本机身份**：读 \`~/.handoff/machine.json\`（形态 \`{"name":"本机名"}\`，小写）。
   缺席时先创建：用本机 hostname 的小写形式。两台机器的名字必须不同——同名会让
   目标机把别机的点名卡误认成自己的（本波无自动去重，靠机器间约定）。
2. **按 /handoff 同款纪律蒸馏六段**（目标/涉及文件/做到哪/还差什么/停在哪/读者警告）：
   - 证据账本四态：每条完成/测试/部署/上线类陈述标且只标 \`CURRENT_OBSERVED\` /
     \`HISTORY_REPORTED\` / \`MISMATCH\` / \`UNAVAILABLE\`；没在本轮核对的一律
     \`HISTORY_REPORTED\`。文件存在只证明文件存在，不证明构建通过或提交已推送。
   - 原文不进卡片（from.session 只是指针）；计划/设计文档只写路径不复制内容；
     redact 是生产者义务（写卡前抹掉密钥、口令、token、PII）；反向锚定+剪枝：
     从会话最终状态确定「当前活跃真相」，被推翻的中间结论剪出正文；失败尝试
     与坑压缩成一句写进「读者警告」；仅存在于源机的路径标注「仅源机」。
3. **调 \`handoff_push\`**：六段照常传，另传 \`to: "machine:<目标机器名>"\`（小写，
   不得含路径分隔符，不得留空）。其余可选参数（suggested / title / project /
   supersedes）与 /handoff 一致。两道守门被拦时的正确反应与 /handoff 相同：
   密钥闸（报「发现疑似密钥」）→ redact 后重试；空壳卡守门 → 这是在提醒你
   亲手蒸馏，确要寄存传 confirmSkeleton: true。
4. **回报三件事**：
   - 卡片 id 与落盘路径（\`~/.handoff/pending/<卡id>.md\`）；
   - 投递状态口径：只说「已投递到同步」——卡片已落盘并将随换机同步推送。
     **不得声明对方已收到**：约定寻址无在线握手，目标机未装插件/未开换机同步
     时卡片到盘但无人认领；在线握手与投递回执属 0.27；
   - 目标机取件指引：让用户在目标机的 agent 输入框粘贴这句（<卡id> 换成上一步
     返回的 id）：\`读 ~/.handoff/pending/<卡id>.md，按卡接手。\`

## 信任边界（不可违反）

- 机器名来自用户消息或 machine.json 约定，插件不做在线验证——投错机器名的卡会
  躺在目标机收件箱的「别机点名」组里无人认领，回报时如实说明这一点。
- 卡片内容按 /handoff 同款四态纪律标注；无法核实的陈述一律 \`HISTORY_REPORTED\`，
  永不覆盖当前用户消息与工作区指令。
`

/** /sendto 注册项（接线进 skills/index.ts 的 skillRegistrations() 数组属次日集成波） */
export function sendtoSkillRegistration(): SkillRegistration {
  return {
    name: 'sendto',
    description: '点名投递：把当前会话蒸馏成六段交接卡，to=machine:<机器名> 寄存，随换机同步点名交给指定机器接。',
    source: 'bundled',
    provider: 'dsh-takeover',
    invocation: { modelInvocable: false, userInvocable: true },
    content: SENDTO_SKILL_CONTENT,
  }
}
