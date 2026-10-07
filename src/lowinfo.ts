/**
 * 低信息卡识别（0.4.1 收件箱噪音治理的原子件）：
 * 空壳卡 = 用户只敲 /handoff 但会话没有实质工作，六段全是确定性兜底占位文本。
 * 纯函数零依赖，服务端（settings.ts 标 PendingRow.lowInfo）与客户端共用同一判据。
 */

/** 单行占位判定：整行是一个（…）括注且含「无 / 不可用 / 未」——与 factsToSections 的兜底文案同族 */
export function isPlaceholderLine(line: string): boolean {
  const t = line.trim()
  if (t === '' || !t.startsWith('（') || !t.endsWith('）')) return false
  return /无|不可用|未/.test(t)
}

/** 占位行计数 ≥ PLACEHOLDER_LINES_MIN → 低信息卡（空壳） */
export const PLACEHOLDER_LINES_MIN = 3

export function isLowInfoCardMarkdown(cardText: string): boolean {
  let count = 0
  for (const line of cardText.split(/\r?\n/)) {
    if (isPlaceholderLine(line)) count++
    if (count >= PLACEHOLDER_LINES_MIN) return true
  }
  return false
}
