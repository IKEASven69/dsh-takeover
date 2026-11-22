/**
 * bundled slash skill 注册表（数组驱动、单一模板）：
 * 一个出处返回全部注册项，src/index.ts 的 apply 逐个 ctx.skills.register。
 * @module dsh-takeover/skills
 */

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { handoffSkillRegistration } from './handoff.ts'
import { inboxSkillRegistration } from './inbox.ts'
import { almanacSkillRegistration } from './almanac.ts'
import { ledgerSkillRegistration } from './ledger.ts'
import { sendtoSkillRegistration } from './sendto.ts'
import { resumeSkillRegistrations } from './resume.ts'

export { HANDOFF_SKILL_CONTENT, handoffSkillRegistration } from './handoff.ts'
export { INBOX_SKILL_CONTENT, inboxSkillRegistration } from './inbox.ts'
export { ALMANAC_SKILL_CONTENT, almanacSkillRegistration } from './almanac.ts'
export { LEDGER_SKILL_CONTENT, ledgerSkillRegistration } from './ledger.ts'
export { SENDTO_SKILL_CONTENT, sendtoSkillRegistration } from './sendto.ts'
export { RESUME_SKILL_SPECS, resumeSkillContent, resumeSkillRegistration, resumeSkillRegistrations } from './resume.ts'
export type { ResumeSkillSpec } from './resume.ts'

/** 全部 bundled slash skill 注册项（/handoff /inbox /ledger /sendto /almanac + /resume-* 逐家衍生） */
export function skillRegistrations(): SkillRegistration[] {
  return [
    handoffSkillRegistration(),
    inboxSkillRegistration(),
    ledgerSkillRegistration(),
    sendtoSkillRegistration(),
    almanacSkillRegistration(),
    ...resumeSkillRegistrations(),
  ]
}
