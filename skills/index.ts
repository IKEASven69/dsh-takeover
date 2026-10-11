/**
 * bundled slash skill 注册表（数组驱动、单一模板）：
 * 一个出处返回全部注册项，src/index.ts 的 apply 逐个 ctx.skills.register。
 * @module dsh-takeover/skills
 */

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'
import { handoffSkillRegistration } from './handoff.ts'
import { inboxSkillRegistration } from './inbox.ts'
import { resumeSkillRegistrations } from './resume.ts'

export { HANDOFF_SKILL_CONTENT, handoffSkillRegistration } from './handoff.ts'
export { INBOX_SKILL_CONTENT, inboxSkillRegistration } from './inbox.ts'
export { RESUME_SKILL_SPECS, resumeSkillContent, resumeSkillRegistration, resumeSkillRegistrations } from './resume.ts'
export type { ResumeSkillSpec } from './resume.ts'

/** 全部 bundled slash skill 注册项（/handoff /inbox + /resume-* 八条） */
export function skillRegistrations(): SkillRegistration[] {
  return [handoffSkillRegistration(), inboxSkillRegistration(), ...resumeSkillRegistrations()]
}
