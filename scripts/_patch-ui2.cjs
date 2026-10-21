// 一次性补丁：把本轮 UI 审查批次（几何分档/壳重构/引导条/右栏重排/未读条/文案接线）
// 重新套用到从 HEAD 恢复的 src/client.ts 上。带逐项存在性校验，缺一即报。
const fs = require('fs')
let s = fs.readFileSync('src/client.ts', 'utf8')
let ok = 0
let miss = 0
function rep(a, b, tag) {
  if (!s.includes(a)) { console.error(`MISS [${tag}]`); miss++; return }
  s = s.replace(a, b)
  ok++
}

// ---- 1. themeVars 暗色分层 ----
rep(
  "  return dark\n    ? { '--bt-mut': 'rgba(255,255,255,.55)', '--bt-ok': '#4ade80', '--bt-warn': '#fbbf24', '--bt-err': '#f87171' }\n    : { '--bt-mut': 'rgba(30,41,59,.72)', '--bt-ok': '#15803d', '--bt-warn': '#b45309', '--bt-err': '#d93025' }",
  "  return dark\n    ? {\n        '--bt-mut': 'rgba(255,255,255,.62)',\n        '--bt-ok': '#4ade80',\n        '--bt-warn': '#fbbf24',\n        '--bt-err': '#f87171',\n        // 暗色分层（视觉审查 P0-3）：卡面比壳抬一档、卡线更轻，内容才浮得起\n        '--bt-card': 'rgba(255,255,255,.035)',\n        '--bt-line': 'rgba(255,255,255,.08)',\n        '--bt-id': 'rgba(255,255,255,.48)',\n      }\n    : {\n        '--bt-mut': 'rgba(30,41,59,.72)',\n        '--bt-ok': '#15803d',\n        '--bt-warn': '#b45309',\n        '--bt-err': '#d93025',\n        '--bt-card': '#ffffff',\n        '--bt-line': 'rgba(15,23,42,.12)',\n        '--bt-id': 'rgba(30,41,59,.55)',\n      }",
  'themeVars 分层',
)

// ---- 2. SVG 图标常量（放 ICON_SVG 定义前）----
rep(
  "const ICON_SVG = '<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"",
  "export const HELP_SVG = '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3\"/><line x1=\"12\" y1=\"17\" x2=\"12.01\" y2=\"17\"/></svg>'\nexport const MEMORY_SVG = '<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><ellipse cx=\"12\" cy=\"5\" rx=\"9\" ry=\"3\"/><path d=\"M21 12c0 1.66-4 3-9 3s-9-1.34-9-3\"/><path d=\"M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5\"/></svg>'\n\nconst ICON_SVG = '<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\"",
  'SVG 常量',
)

// ---- 3. HelpCard：去 details 折叠（显隐由外部按钮控制）+ 头部图标 ----
rep(
  "  return createElement('details', { className: 'bt-note' },\n    createElement('summary', null, t('helpTitle')),",
  "  return createElement('div', { className: 'bt-card' },\n    createElement('div', { className: 'bt-head' },\n      createElement('span', { className: 'bt-logo', style: { width: 13, height: 13, display: 'inline-block', opacity: 0.9 }, dangerouslySetInnerHTML: { __html: HELP_SVG } }),\n      createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, t('helpTitle')),\n    ),",
  'HelpCard 无折叠',
)

// ---- 4. PendingList 行：displayTitleOf + 未读条 + 徽标阈值 ----
rep(
  "          createElement('span', { className: 'bt-pending-title' }, p.title !== '' ? p.title : p.id),\n          isNew ? createElement('span', { className: 'bt-tag bt-tag-new' }, t('newBadge')) : null,",
  "          createElement('span', { className: 'bt-pending-title', title: p.id }, displayTitleOf(p)),\n          // 未读态已由行首强调条表达；「新」徽标只留给 1 小时内的新卡（防满屏 amber 噪音）\n          (isNew && Date.now() - Date.parse(p.pushedAt) < 3600000) ? createElement('span', { className: 'bt-tag bt-tag-new' }, t('newBadge')) : null,",
  '行标题/徽标',
)
rep(
  "      className: `bt-pending${open ? ' bt-pending-open' : ''}`,\n      title: p.id,",
  "      className: `bt-pending${open ? ' bt-pending-open' : ''}${isNew ? ' bt-pending-unread' : ''}`,\n      title: p.id,",
  '未读条类名',
)
// displayTitleOf 导入
rep(
  "import {\n  cardMarkdown,\n  filterPending,",
  "import {\n  cardMarkdown,\n  displayTitleOf,\n  filterPending,",
  'displayTitleOf 导入',
)

// ---- 5. 清空确认窗口 6s ----
rep(
  'setTimeout(() => { setConfirmClear(false) }, 3000)',
  'setTimeout(() => { setConfirmClear(false) }, 6000)',
  '清空 6s',
)

// ---- 6. dock-debug 移除 ----
s = s.replace(/      try \{ \(globalThis as \{ localStorage\?: \{ setItem: \(k: string, v: string\) => void \} \}\)\.localStorage\?\.setItem\("dsh-takeover-dock-debug", "ok"\) \} catch \{ \/\* 隐私模式等 \*\/ \}\n/, '')
s = s.replace(/      try \{ \(globalThis as \{ localStorage\?: \{ setItem: \(k: string, v: string\) => void \} \}\)\.localStorage\?\.setItem\("dsh-takeover-dock-debug", msg\) \} catch \{ \/\* 同上 \*\/ \}\n/, '')

// ---- 7. MemoryCard 标题图标 ----
rep(
  "      createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, `${t('memoryTitle')}`),",
  "      createElement('span', { className: 'bt-logo', style: { width: 13, height: 13, display: 'inline-block', opacity: 0.9 }, dangerouslySetInnerHTML: { __html: MEMORY_SVG } }),\n      createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, `${t('memoryTitle')}`),",
  '记忆卡图标',
)

// ---- 8. TargetChips ariaLabel ----
rep(
  "export function TargetChips({ sel, lang, onSelect }: {\n  sel: string\n  lang: Lang\n  onSelect: (t: OutboundTarget) => void\n}): ReturnType<typeof createElement> {\n  return createElement('div', { className: 'bt-chips', role: 'group', style: { marginTop: 8 } },",
  "export function TargetChips({ sel, lang, onSelect, ariaLabel }: {\n  sel: string\n  lang: Lang\n  onSelect: (t: OutboundTarget) => void\n  ariaLabel?: string\n}): ReturnType<typeof createElement> {\n  return createElement('div', { className: 'bt-chips', role: 'group', 'aria-label': ariaLabel, style: { marginTop: 8 } },",
  'TargetChips aria',
)
rep(
  "    createElement(TargetChips, { sel: target, lang, onSelect: setTarget }),",
  "    createElement(TargetChips, { sel: target, lang, onSelect: setTarget, ariaLabel: t('targetGroupLabel') }),",
  'SendCard chips aria',
)

// ---- 9. SendCard：目标真生效 + 按钮文案 ----
rep(
  "    const instruction = outboundCommand(lang)",
  "    const targetLabelText = OUTBOUND_LABELS[target][lang]\n    const instruction = outboundCommand(lang, target === 'any' ? undefined : targetLabelText)",
  '出站指令带目标',
)
rep(
  "    void post<{ ok: true } | { ok: false; error: string; instruction?: string }>('/dsh-takeover/send', { sessionId, lang })",
  "    void post<{ ok: true } | { ok: false; error: string; instruction?: string }>('/dsh-takeover/send', { sessionId, lang, target })",
  'send 带 target',
)
rep(
  "        copied ? t('copiedBtn') : busy ? t('sendBusy') : t('sendBtn'),",
  "        copied ? t('copiedBtn') : busy ? t('sendBusy') : target === 'any' ? t('sendBtn') : t('sendBtnTo', { label: targetLabelText }),",
  '按钮文案',
)
rep(
  "    createElement(TargetChips, { sel: target, lang, onSelect: setTarget }),",
  "    createElement('div', { className: 'bt-sub', style: { marginTop: 6, fontWeight: 600 } }, t('targetGroupLabel')),\n    createElement(TargetChips, { sel: target, lang, onSelect: setTarget, ariaLabel: t('targetGroupLabel') }),",
  'SendCard 组标签',
)

// ---- 10. measure 几何分档 + 居中 ----
rep(
  "    const vw = window.innerWidth\n    const width = Math.max(360, Math.min(1040, vw - 16))\n    const left = Math.max(8, Math.min(vw - width - 8, r.right - width))",
  "    const vw = window.innerWidth\n    // 宽度分档（视觉审查 P0-1）：大屏放大、中屏定宽、小屏贴边，不再焊死 1040\n    const width = vw >= 1600 ? Math.min(1240, vw - 48) : vw >= 1200 ? Math.min(1040, vw - 48) : Math.max(360, Math.min(720, vw - 16))\n    // 以 chip 中心对齐再夹取进视口——chip 在宿主页里不居中，浮层也不歪\n    const left = Math.max(16, Math.min(vw - width - 16, r.left + r.width / 2 - width / 2))",
  'measure 分档',
)

// ---- 11. 浮层壳：flex 列 + 遮罩 + 阴影 + 圆角16 + 头栏28px + 滚动体 ----
rep(
  "      style: { position: 'fixed', inset: 0, zIndex: 9998 },\n      onClick: () => setOpen(false),",
  "      style: { position: 'fixed', inset: 0, zIndex: 9998, background: 'rgba(0,0,0,.32)' },\n      onClick: () => setOpen(false),",
  '遮罩',
)
rep(
  "        position: 'fixed', zIndex: 9999,\n        boxSizing: 'border-box', // maxHeight 必须含 padding+border，否则矮窗仍溢出视口（实测 583>568）",
  "        position: 'fixed', zIndex: 9999,\n        boxSizing: 'border-box', // maxHeight 必须含 padding+border，否则矮窗仍溢出视口（实测 583>568）\n        display: 'flex', flexDirection: 'column', overflow: 'hidden',",
  'flex 列',
)
rep(
  "        background: 'var(--bg)',\n        border: '1px solid var(--border)', borderRadius: 12,\n        boxShadow: '0 10px 32px rgba(0,0,0,.28)', padding: 8,\n      },\n    },",
  "        background: 'var(--bg)',\n        border: '1px solid var(--border)', borderRadius: 16,\n        boxShadow: '0 16px 48px rgba(0,0,0,.5)', padding: '10px 14px 12px',\n      },\n    },",
  '阴影/圆角',
)
rep(
  "      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px 6px' } },\n        createElement('span', { className: 'bt-logo', style: { width: 14, height: 14, display: 'inline-block' }, dangerouslySetInnerHTML: { __html: ICON_SVG } }),\n        createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, t('popoverTitle')),\n        createElement('span', { style: { flex: 1 } }),\n        createElement('button', {\n          className: 'bt-btn bt-btn-xs', onClick: () => setOpen(false), 'aria-label': 'close',\n        }, '✕'),\n      ),",
  "      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10, borderBottom: '1px solid var(--border)', marginBottom: 10 } },\n        createElement('span', { className: 'bt-logo', style: { width: 14, height: 14, display: 'inline-block' }, dangerouslySetInnerHTML: { __html: ICON_SVG } }),\n        createElement('span', { className: 'bt-title', style: { fontSize: 14, fontWeight: 650 } }, t('popoverTitle')),\n        createElement('span', { style: { flex: 1 } }),\n        createElement('button', {\n          className: 'bt-btn bt-btn-xs',\n          onClick: () => setShowHelp((v) => !v),\n          'aria-label': t('helpTitle'),\n          title: t('helpTitle'),\n          style: { minWidth: 28, height: 28, padding: 0, ...(showHelp ? { color: 'var(--bt-a)', borderColor: 'var(--bt-a)' } : {}) },\n        }, '?'),\n        createElement('button', {\n          className: 'bt-btn bt-btn-xs', onClick: () => { setOpen(false); setShowHelp(false) }, 'aria-label': t('closeBtn'),\n          title: t('closeBtn'),\n          style: { minWidth: 28, height: 28, padding: 0 },\n        }, '✕'),\n      ),",
  '头栏按钮',
)

// ---- 12. ComposerChip 状态 showHelp + WorkspaceBody 接线（bounded/showHelp）----
rep(
  "  const [open, setOpen] = useState(false)\n  return createElement('div', { style: { position: 'relative', display: 'inline-flex' } },",
  "  const [open, setOpen] = useState(false)\n  const [showHelp, setShowHelp] = useState(false)\n  return createElement('div', { style: { position: 'relative', display: 'inline-flex' } },",
  'showHelp 状态',
)
rep(
  "        children: createElement('div', { style: { display: 'grid', gap: 8 } },\n          showHelp ? createElement(HelpCard, { t }) : null,\n          createElement(WorkspaceBody, { t, locale, navigate, chrome: false, sessionId }),\n        ),",
  "        children: createElement('div', { style: { display: 'grid', gap: 8 } },\n          showHelp ? createElement(HelpCard, { t }) : null,\n          createElement(WorkspaceBody, { t, locale, navigate, chrome: false, sessionId, showHelp, bounded: true }),\n        ),",
  'WorkspaceBody 接线',
)

// ---- 13. WorkspaceBody 签名 + root 类 + 栅格 480/16 ----
rep(
  "  sessionId?: string\n  /** 新手 FAQ 显隐（由浮层标题栏的 [?] 按钮切换；默认隐藏不占行） */\n  showHelp?: boolean\n}): ReturnType<typeof createElement> {",
  "  sessionId?: string\n  /** 新手 FAQ 显隐（由浮层标题栏的 [?] 按钮切换；默认隐藏不占行） */\n  showHelp?: boolean\n  /** 浮层挂载（有固定高度外壳：面板变 flex 列、栅格内滚） */\n  bounded?: boolean\n}): ReturnType<typeof createElement> {",
  'bounded 签名',
)
rep(
  "export function WorkspaceBody({ t, locale, navigate, chrome, sessionId, showHelp }: {",
  "export function WorkspaceBody({ t, locale, navigate, chrome, sessionId, showHelp, bounded }: {",
  '解构',
)
rep(
  "  return createElement('div', { className: 'bt-panel', style: themeVars() },\n    createElement('style', null, CSS),\n\n    // 右侧栏挂载时的 slim 头卡",
  "  return createElement('div', { className: `bt-panel${bounded === true ? ' bt-bounded' : ''}`, style: themeVars() },\n    createElement('style', null, CSS),\n\n    // 右侧栏挂载时的 slim 头卡",
  'root 类',
)
rep(
  "    createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 10, alignItems: 'start' } },",
  "    createElement('div', { className: 'bt-cols', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(480px, 1fr))', gap: 16, alignItems: 'start', ...(bounded === true ? { flex: '1 1 auto', minHeight: 0 } : {}) } },",
  '栅格 480',
)

// ---- 14. 左栏帮助改条件（默认隐藏）----
rep(
  "    // 左栏：新手帮助（默认收起）+ 收件箱概览\n    createElement('div', { style: { display: 'grid', gap: 10, alignItems: 'start' } },\n      createElement(HelpCard, { t }),",
  "    // 左栏：新手帮助（[?] 切换，默认隐藏）+ 收件箱概览\n    createElement('div', { style: { display: 'grid', gap: 14, alignItems: 'start' } },\n      showHelp === true ? createElement(HelpCard, { t }) : null,",
  '左栏条件帮助',
)

// ---- 15. 右栏重排（浏览 → 交接出去 → 记忆）+ 间距 16 ----
rep(
  "    // 右栏：交接出去（出站）+ 外部会话浏览器（入站）+ 记忆快照\n    createElement('div', { style: { display: 'grid', gap: 10, alignItems: 'start' } },\n      createElement(SendCard, { sessionId, t, lang, onError: (msg) => setError(msg), onNotice: showNotice }),\n      // 外部会话浏览器（浏览 + 一键投递 + 投递后自动切会话；卡片蒸馏仍在会话里由模型完成）\n      createElement(ForeignBrowser, { state, t, lang, onError: (msg) => setError(msg), onNotice: showNotice, navigate }),\n      createElement(MemoryCard, { t, lang, onError: (msg) => setError(msg), onNotice: showNotice, onPushed: reload }),\n    ),",
  "    // 右栏（按三步上手顺序）：① 浏览外部会话（接进来）② 交接出去（寄存出站）③ 记忆快照（低频）\n    createElement('div', { style: { display: 'grid', gap: 16, alignItems: 'start' } },\n      // 外部会话浏览器（浏览 + 一键接管 + 投递后自动切会话；卡片蒸馏仍在会话里由模型完成）\n      createElement(ForeignBrowser, { state, t, lang, onError: (msg) => setError(msg), onNotice: showNotice, navigate }),\n      createElement(SendCard, { sessionId, t, lang, onError: (msg) => setError(msg), onNotice: showNotice }),\n      createElement(MemoryCard, { t, lang, onError: (msg) => setError(msg), onNotice: showNotice, onPushed: reload }),\n    ),",
  '右栏重排',
)

// ---- 16. Panel：帮助 [?] 按钮 + 条件渲染 ----
rep(
  "        createElement('span', { className: 'bt-spacer' }),\n        createElement('button', { className: 'bt-btn', onClick: reload, disabled: busy !== null }, t('refresh')),",
  "        createElement('span', { className: 'bt-spacer' }),\n        createElement('button', { className: 'bt-btn bt-btn-xs', onClick: () => setShowHelp((v) => !v), 'aria-label': t('helpTitle'), title: t('helpTitle'), style: { minWidth: 26, ...(showHelp ? { color: 'var(--bt-a)', borderColor: 'var(--bt-a)' } : {}) } }, '?'),\n        createElement('button', { className: 'bt-btn', onClick: reload, disabled: busy !== null }, t('refresh')),",
  'Panel 帮助按钮',
)
rep(
  "    // 新手帮助 / FAQ（设置卡同款，工作台左栏顶部另有一份）\n    createElement(HelpCard, { t }),",
  "    // 新手帮助 / FAQ（头卡 [?] 切换，默认隐藏不占行）\n    showHelp ? createElement(HelpCard, { t }) : null,",
  'Panel 条件帮助',
)
rep(
  "  // 每家开关的操作中态（矩阵行级禁用）\n  const [busy, setBusy] = useState<string | null>(null)",
  "  // 每家开关的操作中态（矩阵行级禁用）\n  const [busy, setBusy] = useState<string | null>(null)\n  // 新手 FAQ 显隐（头卡 [?] 按钮切换，默认隐藏不占行）\n  const [showHelp, setShowHelp] = useState(false)",
  'Panel showHelp 状态',
)

// ---- 17. MemoryCard 折叠副标题（可用性 P2-3）----
rep(
  "      createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, `${t('memoryTitle')}`),\n      createElement('span', { className: 'bt-spacer' }),",
  "      createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, `${t('memoryTitle')}`),\n      createElement('span', { className: 'bt-sub' }, t('memoryHint')),\n      createElement('span', { className: 'bt-spacer' }),",
  '记忆卡副标题',
)

// ---- 18. 接线状态（onboard）在 WorkspaceBody：批外项，保持脚本聚焦 ----
fs.writeFileSync('src/client.ts', s)
console.log(`补丁完成：${ok} 项命中，${miss} 项未命中`)
if (miss > 0) process.exit(1)
