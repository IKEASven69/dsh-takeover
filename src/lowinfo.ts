/**
 * 低信息卡识别（0.4.1 收件箱噪音治理的原子件）：
 * 空壳卡 = 用户只敲 /handoff 但会话没有实质工作，六段以确定性兜底占位文本为主。
 * 纯函数零依赖，服务端（settings.ts 标 PendingRow.lowInfo）与客户端共用同一判据。
 */

/** 单行占位判定：整行是一个（…）括注且含「无 / 不可用 / 未」——与 factsToSections 的兜底文案同族 */
export function isPlaceholderLine(line: string): boolean {
  const t = line.trim()
  if (t === '' || !t.startsWith('（') || !t.endsWith('）')) return false
  return /无|不可用|未/.test(t)
}

/** 占位行数下限：不足此数即使全占位也不算低信息（极短卡另有空态横幅兜底） */
export const PLACEHOLDER_LINES_MIN = 3

/**
 * 低信息判定：占位行 ≥ MIN 且占非空正文行（去 frontmatter/标题行）一半以上。
 * 只数条数会把「实质内容 + 手写几行（无）」的健康卡误折叠（审查 #5）——占比才是空壳语义。
 */
export function isLowInfoCardMarkdown(cardText: string): boolean {
  const withoutFrontmatter = cardText.replace(/^---[\s\S]*?---/, '')
  let placeholders = 0
  let substantive = 0
  for (const raw of withoutFrontmatter.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    if (isPlaceholderLine(line)) placeholders++
    else substantive++
  }
  if (placeholders < PLACEHOLDER_LINES_MIN) return false
  return placeholders * 2 >= placeholders + substantive
}
