#!/usr/bin/env node
/**
 * 0.4.1 归因版 · 段落效用归因（行为探针法）。
 *
 * 问题：六段卡里哪些段真正被接手方用上了？读转录猜意图不可靠（取件会话
 * 存在宿主内部，读取层不可达），改用**行为探针**：把不同事实埋进不同段，
 * 接手产物（文件输出）逐一检验哪些事实「存活」——事实物化了，说明那段
 * 被接手方消费了。测量不依赖任何转录访问。
 *
 * 探针设计（三臂实验共用）：
 *  - fact-work      埋在 remaining（还差什么）：TODO beta→gamma + NOTES 追加 step2
 *  - fact-marker    埋在 warnings（读者警告）：新行必须带 [TX-77] 标记
 *  - fact-context   埋在 done（做到哪）：step1 已完成（背景，不作探针）
 * 探针判定全部是产物文件的确定性断言。
 *
 * @module dsh-takeover/section-utility
 */

/** 三臂共用的事实常量（内容在 A/B 两臂完全一致，只有结构不同） */
export const FACTS = {
  workTodoFrom: 'beta',
  workTodoTo: 'gamma',
  workNoteLine: 'step2: done',
  marker: '[TX-77]',
  contextDone: 'step1: done（alpha 已写入 NOTES.md）',
}

/** 组装各臂的接手产物断言输入 */
export function probesOf(output) {
  const todo = output.todo ?? ''
  const notes = output.notes ?? ''
  return {
    /** work 事实：TODO beta→gamma */
    todoFlipped: todo.includes(FACTS.workTodoTo) && !new RegExp(`^${FACTS.workTodoFrom}$`, 'm').test(todo),
    /** work 事实：NOTES 追加了 step2 行 */
    noteAppended: notes.includes(FACTS.workNoteLine),
    /** marker 事实：step2 行带 [TX-77]（只有读过 warnings 段才知道） */
    markerUsed: (() => {
      const line = notes.split('\n').find((l) => l.includes(FACTS.workNoteLine))
      return line !== undefined && line.includes(FACTS.marker)
    })(),
  }
}

/** 段落效用：arm A（结构化卡）的探针 → 段级归因。
 * remaining 驱动 work 双探针；warnings 驱动 marker 探针。 */
export function sectionUtility(output) {
  const p = probesOf(output)
  return {
    remaining: { probed: true, hit: p.todoFlipped && p.noteAppended },
    warnings: { probed: true, hit: p.markerUsed },
  }
}

/** 三臂的成功判定（确定性）：work 双探针齐 = 任务完成 */
export function armSuccess(output) {
  const p = probesOf(output)
  return p.todoFlipped && p.noteAppended
}

/** 三臂的卡片正文组装（纯函数：同源事实，两种结构 + 最小对照） */
export function armCardSections(arm, facts) {
  if (arm === 'structured') {
    return {
      title: '三臂实验·结构化卡',
      goal: '接手上一棒的仓库收尾任务：按「还差什么」完成工作。',
      files: '- TODO.md\n- NOTES.md',
      done: `- HISTORY_REPORTED ${facts.contextDone}`,
      remaining: `- CURRENT_OBSERVED 把 TODO.md 里的 ${facts.workTodoFrom} 改成 ${facts.workTodoTo}\n- CURRENT_OBSERVED 在 NOTES.md 末尾追加一行 ${facts.workNoteLine}`,
      stopped: '上一棒在完成 step1 后正常收尾。',
      warnings: `- CURRENT_OBSERVED 所有新增行必须以标记 ${facts.marker} 开头（接手方遵守）`,
    }
  }
  if (arm === 'plain') {
    return {
      title: '三臂实验·纯文本段',
      goal: `前置已完成：${facts.contextDone}。接下来把 TODO.md 里的 ${facts.workTodoFrom} 改成 ${facts.workTodoTo}，并在 NOTES.md 末尾追加一行 ${facts.workNoteLine}；所有新增行必须以标记 ${facts.marker} 开头。`,
      files: '- TODO.md\n- NOTES.md',
      done: '',
      remaining: '',
      stopped: '',
      warnings: '',
    }
  }
  if (arm === 'minimal') {
    return {
      title: '三臂实验·最小对照',
      goal: '继续这个仓库里的工作（仓库内文件自述了一切可知道的信息）。',
      files: '- TODO.md\n- NOTES.md',
      done: '',
      remaining: '',
      stopped: '',
      warnings: '',
    }
  }
  throw new Error(`未知 arm：${arm}`)
}
