/**
 * dsh-takeover 浏览器半：设置页「dsh-takeover」卡。
 * 四区：命令速览（/handoff · /inbox · /resume-*，直接可见）/ 收件箱概览
 * （即时过滤 + 相邻重复卡分组 + 「新」卡徽标（localStorage 已见集，键含
 * HANDOFF_HOME 散列）+ 展开看目标段预览 + 单卡/全部导出 .md + 导出 HTML 报告
 * （自包含单文件，state→html 为可单测纯函数）+ archived 计数 + 清空归档）/
 * 支持矩阵（八家读取器：规范名+品牌图标、会话数、启用开关）/ 开关语义说明。
 * 文案走宿主 i18n：ctx.locale 注册本卡词典（zh/en）+ bind 出 t()，
 * 语言切换经 locale revision 驱动重渲染（宿主缺席时回退 zh 静态词典）。
 * 数据通路走同源 fetch 直连 host 路由 /dsh-takeover/*（dsh-hippo 先例）。
 * 取件不在设置卡做——会话里 /inbox。
 * host 侧并行落地中的扩展字段（机器信封字符数 / 四态覆盖率）走防御式读取：
 * 字段缺席即整行/徽标不显示，绝不硬造。
 * @module dsh-takeover/client
 */

import { Component, createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
// 0.2.0：一方客户端插件直接收 cordis Context。
import type { Context } from '@deepseek-ai/cordis'
// Type-only: ctx.slots（SlotRegistry 服务）由 ui-renderer 的 cordis Context 合并提供。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: ctx.locale（LocaleRuntime）由 dsh-client-locale 的 Context 增强提供。
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
// Type-only: Translate 形态（(key, params) => string，{name} 占位）。
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { BRAND_FULL_SVG, BRAND_MARKS, PROVIDER_LABEL } from './brand-icons.ts'
import type { BrandMark } from './brand-icons.ts'
import { DICTS, NS, interpolate } from './locales.ts'
import {
  cardMarkdown,
  filterPending,
  groupAdjacent,
  loadSeenSet,
  newIdsOf,
  pendingListMarkdown,
  saveSeenSet,
  sourceFacets,
  seenStorageKey,
} from './inbox-view.ts'
import type { PendingGroup, SeenStore } from './inbox-view.ts'
import type { TakeoverState, PendingRow, ProviderRow } from './settings.ts'
import {
  cwdFacets,
  depositCommand,
  filterByCwd,
  filterSessions,
  isSubagentSession,
  relTime,
  shortId,
  takeoverCommand,
} from './browser-view.ts'
import type { SessionListBody, SessionPreviewBody, SessionRow } from './browser-view.ts'

/** 卡片渲染语言（跟随宿主 active locale；未登记语言回退 zh）。
 * 导出——报告纯函数按 lang 出 <html lang> 与文案注入，单测两套词典都要能过。 */
export type Lang = 'zh' | 'en'

// ---------------------------------------------------------------------------
// i18n：注册本卡词典并绑定 t。宿主 locale 服务缺席（旧宿主/非浏览器）时
// 回退 zh 静态词典 + 本地插值，保证卡片永远可用。
// ---------------------------------------------------------------------------

const tCache = new WeakMap<object, Translate>()

/**
 * 防御式取宿主 locale 服务：cordis 对未挂载服务的属性访问会直接 throw
 * （locale 插件可能晚于本插件挂载），绝不能让异常从渲染工厂里逃出去。
 */
function resolveLocale(ctx: Context): LocaleRuntime | undefined {
  try {
    const l: unknown = (ctx as unknown as { locale?: unknown }).locale
    return l !== null && typeof l === 'object' ? (l as LocaleRuntime) : undefined
  } catch {
    return undefined
  }
}

function makeT(ctx: Context): Translate {
  const hit = tCache.get(ctx)
  if (hit !== undefined) return hit
  const locale = resolveLocale(ctx)
  let t: Translate
  if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
    try {
      locale.register(NS, 'zh', DICTS.zh)
      locale.register(NS, 'en', DICTS.en)
      t = locale.bind(NS)
    } catch (e) {
      // 重复注册（HMR 重跑）/宿主词典约束变化：降级静态 zh，卡片不塌
      console.warn('[dsh-takeover] locale register/bind 失败，回退静态词典：', e)
      t = (key, params) => interpolate(DICTS.zh[String(key)] ?? String(key), params)
    }
  } else {
    t = (key, params) => interpolate(DICTS.zh[String(key)] ?? String(key), params)
  }
  tCache.set(ctx, t)
  return t
}

/** 宿主 active locale → 卡片渲染语言 */
function langOf(locale: LocaleRuntime | undefined): Lang {
  try {
    return locale?.getLocale().active === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

/**
 * 宿主主题探测：宿主主题是 CSS 模块字面色、不暴露 --muted 令牌，
 * prefers-color-scheme 又只跟系统不跟宿主；宿主切主题换的是背景（浅=白底，
 * 深=黑底），文字色恒定。所以按 body 背景色亮度判断明暗，给 muted /
 * 语义色选对轴。每次渲染现算（主题切换后任意交互即校正）。
 */
function themeVars(): Record<string, string> {
  let dark = true
  try {
    // body 背景透明（rgba alpha 0 / 空）时退化到 html 根元素——部分宿主只给根上底色
    let bg = getComputedStyle(document.body).backgroundColor
    if (bg === '' || /rgba?\([^)]*\/\s*0\s*\)/.test(bg) || bg === 'transparent') {
      bg = getComputedStyle(document.documentElement).backgroundColor
    }
    // oklch/oklab 等 modern 色彩函数抓不出 r/g/b（`oklch(0.98 0 0)` 会被 \d+ 抓成 r=0,g=98）——
    // 提取首参亮度分量判明暗（0~1 或百分比），解析不了再退 rgb/深色保底
    const modern = /^(oklch|oklab|lab|lch)\(\s*([\d.]+)(%?)/.exec(bg)
    if (modern) {
      const l = Number(modern[2]) * (modern[3] === '%' ? 0.01 : 1)
      dark = l <= 0.5
    } else {
      const m = bg.match(/\d+/g)
      if (m && m.length >= 3) {
        const [r = 0, g = 0, b = 0] = m.map(Number)
        dark = (0.299 * r + 0.587 * g + 0.114 * b) / 255 <= 0.5
      }
    }
  } catch {
    /* 保底按深色 */
  }
  return dark
    ? { '--bt-mut': 'rgba(255,255,255,.55)', '--bt-ok': '#4ade80', '--bt-warn': '#fbbf24', '--bt-err': '#f87171' }
    : { '--bt-mut': 'rgba(30,41,59,.72)', '--bt-ok': '#15803d', '--bt-warn': '#b45309', '--bt-err': '#d93025' }
}

export const inject = ['slots', 'locale']

// ---------------------------------------------------------------------------
// 品牌图标：assets/icon.svg 的内联副本（改图标时两边同步）。
// 圆角方底 + 接管意象（双箭头 » 进格 |，读作"接管席位"），渐变 #6366F1→#8B5CF6。
// 渐变 id 加 bt- 前缀避免与宿主页面里的 defs 撞名。
// ---------------------------------------------------------------------------

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="100%" height="100%" role="img" aria-label="dsh-takeover">' +
  '<defs>' +
  '<linearGradient id="bt-bg" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#6366F1"/><stop offset="1" stop-color="#8B5CF6"/>' +
  '</linearGradient>' +
  '<linearGradient id="bt-sheen" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#ffffff" stop-opacity=".26"/>' +
  '<stop offset=".55" stop-color="#ffffff" stop-opacity="0"/>' +
  '</linearGradient>' +
  '</defs>' +
  '<rect x="2" y="2" width="60" height="60" rx="15" fill="url(#bt-bg)"/>' +
  '<rect x="2" y="2" width="60" height="60" rx="15" fill="url(#bt-sheen)"/>' +
  '<rect x="2.75" y="2.75" width="58.5" height="58.5" rx="14.25" fill="none" stroke="#ffffff" stroke-opacity=".22" stroke-width="1.5"/>' +
  '<g fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M15 19 L27 32 L15 45"/>' +
  '<path d="M29 19 L41 32 L29 45"/>' +
  '</g>' +
  '<rect x="46.5" y="17" width="6" height="30" rx="3" fill="#ffffff" opacity=".9"/>' +
  '</svg>'

// ---------------------------------------------------------------------------
// Provider 图标：八家全部官方矢量（见 brand-icons.ts 的来源清单）。
// 常规形态 = 官方 tile 底色 + 官方 path（fill 逐 path 保真）；
// workbuddy = 官方完整 SVG 整体内嵌（自带渐变圆底）。
// 未知来源（如 dsh 自己）回退中性字母块——那不是品牌冒充，是兜底。
// ---------------------------------------------------------------------------

function providerMark(name: string): BrandMark | null {
  const m = BRAND_MARKS[name]
  return m ?? null
}

function ProviderIcon({ name, size = 20 }: { name: string; size?: number }): ReturnType<typeof createElement> {
  const full = BRAND_FULL_SVG[name]
  if (full !== undefined) {
    return createElement('span', {
      className: 'bt-icon bt-icon-full',
      style: { width: size, height: size },
      title: PROVIDER_LABEL[name] ?? name,
      dangerouslySetInnerHTML: { __html: full },
    })
  }
  const mark = providerMark(name)
  if (mark === null) {
    // 未知来源（实践中只有 dsh 宿主自己）：用本插件品牌小标，不出字母块
    return createElement('span', {
      className: 'bt-icon',
      style: { background: 'linear-gradient(135deg, #6366F1, #8B5CF6)', width: size, height: size },
      title: PROVIDER_LABEL[name] ?? name,
      dangerouslySetInnerHTML: { __html: '<svg viewBox="0 0 64 64" width="100%" height="100%"><g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19 L27 32 L15 45"/><path d="M29 19 L41 32 L29 45"/></g></svg>' },
    })
  }
  return createElement('span', {
    className: 'bt-icon',
    style: { background: mark.tile, width: size, height: size },
    title: PROVIDER_LABEL[name] ?? name,
  }, createElement('svg', { viewBox: mark.viewBox, width: Math.round(size * 0.64), height: Math.round(size * 0.64), 'aria-hidden': true },
    ...mark.paths.map((p, i) => createElement('path', { key: i, d: p.d, fill: p.fill }))),
  )
}

// ---------------------------------------------------------------------------
// 样式：颜色尽量继承宿主令牌（--accent/--border/--muted），兜底值保证浅色可读；
// 深色模式下兜底值整体换轴（prefers-color-scheme），宿主令牌在场时天然跟随主题。
// ---------------------------------------------------------------------------

const CSS = `
.bt-panel { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 10px;
  container-type: inline-size;
  --bt-a: var(--accent, #6366f1); --bt-ok: #15803d; --bt-warn: #b45309; --bt-err: #d93025;
  --bt-line: var(--border, rgba(127,127,127,.2)); --bt-mut: rgba(30,41,59,.72);
  --bt-card: var(--bg, rgba(127,127,127,.05)); --bt-hover: rgba(127,127,127,.07);
  --bt-shadow: 0 1px 2px rgba(16,24,40,.05), 0 12px 32px -18px rgba(16,24,40,.16); }
.bt-card { background: var(--bt-card); border: 1px solid var(--bt-line); border-radius: 14px;
  padding: 16px 18px; display: flex; flex-direction: column; gap: 12px;
  box-shadow: var(--bt-shadow); }
.bt-head { display: flex; align-items: center; gap: 12px; }
.bt-logo { width: 40px; height: 40px; border-radius: 11px; flex: none; overflow: hidden;
  box-shadow: 0 2px 8px rgba(99,102,241,.35), inset 0 0 0 1px rgba(255,255,255,.18); }
.bt-logo svg { display: block; }
.bt-title { font-weight: 700; font-size: 14px; letter-spacing: .01em; }
.bt-sub { font-size: 12px; color: var(--bt-mut); line-height: 1.55; }
.bt-spacer { flex: 1; }
.bt-badge { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px;
  color: var(--bt-mut); background: rgba(127,127,127,.1); border: 1px solid var(--bt-line);
  font-variant-numeric: tabular-nums; }
.bt-badge-hot { color: var(--bt-a); background: rgba(99,102,241,.1); border-color: rgba(99,102,241,.3); }
/* 收件箱统计条：待取件/已消费/覆盖率/信封 四格，label+数字同 chip */
.bt-statstrip { display: flex; gap: 6px; flex-wrap: wrap; }
.bt-stat { font-size: 11px; color: var(--bt-mut); background: rgba(127,127,127,.08);
  border: 1px solid var(--bt-line); border-radius: 999px; padding: 2px 10px;
  font-variant-numeric: tabular-nums; }
.bt-stat-hot { color: var(--bt-a); background: rgba(99,102,241,.1); border-color: rgba(99,102,241,.3); }
.bt-stat-warn { color: var(--bt-warn); background: rgba(251,191,36,.12); border-color: rgba(251,191,36,.4); }
.bt-btn { cursor: pointer; border-radius: 10px; font-size: 12.5px; font-weight: 500; padding: 6px 16px;
  border: 1px solid var(--bt-line); background: transparent; color: inherit; white-space: nowrap;
  transition: border-color .15s ease, color .15s ease, background .15s ease, transform .12s ease; }
.bt-btn:disabled { opacity: .5; cursor: default; }
.bt-btn:not(:disabled):hover { border-color: var(--bt-a); color: var(--bt-a); transform: translateY(-1px); }
.bt-btn:not(:disabled):active { transform: translateY(0); }
.bt-btn-danger:not(:disabled):hover { border-color: var(--bt-err); color: var(--bt-err); }
.bt-btn-confirm { background: var(--bt-err); border-color: transparent; color: #fff; }
.bt-btn-confirm:not(:disabled):hover { color: #fff; transform: none; }
.bt-banner { font-size: 12px; line-height: 1.6; border-radius: 10px; padding: 8px 12px; }
.bt-banner-info { color: var(--bt-mut); background: rgba(127,127,127,.08); }
.bt-banner-err { color: var(--bt-err); background: rgba(211,47,47,.08); }
.bt-rows { display: flex; flex-direction: column; gap: 2px; }
.bt-pending { display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: flex-start;
  border-radius: 10px; padding: 9px 10px; font-size: 12.5px;
  cursor: pointer; transition: background .12s ease; }
.bt-pending:hover { background: var(--bt-hover); }
.bt-pending:focus-visible { outline: 2px solid var(--bt-a); outline-offset: -2px; }
.bt-pending-open { background: var(--bt-hover); }
.bt-pend-icon { flex: none; margin-top: 2px; }
.bt-pend-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.bt-pend-line1 { display: flex; align-items: baseline; gap: 8px; }
.bt-pending-title { flex: 1; min-width: 0; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-pend-time { flex: none; font-size: 11px; color: var(--bt-mut); font-variant-numeric: tabular-nums; }
.bt-pending-chev { flex: none; font-size: 10px; color: var(--bt-mut); align-self: center; transition: transform .15s ease; }
.bt-pending-open .bt-pending-chev { transform: rotate(90deg); }
.bt-pend-meta { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: var(--bt-mut);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.bt-pend-src { font-weight: 500; }
.bt-pend-dot { opacity: .45; }
.bt-pend-id { font-family: ui-monospace, monospace; font-size: 10.5px; opacity: .68; }
.bt-preview { flex-basis: 100%; font-size: 12px; line-height: 1.65; color: inherit;
  background: var(--bt-card); border-left: 2px solid var(--bt-a); border-radius: 0 10px 10px 0;
  padding: 8px 12px; margin: 4px 0 2px 0; white-space: pre-wrap;
  word-break: break-word; display: flex; flex-direction: column; gap: 4px; }
.bt-preview-hint { font-size: 10.5px; color: var(--bt-mut); }
/* 展开态动作行：预览提示 + 单卡导出按钮 */
.bt-preview-actions { display: flex; align-items: center; gap: 8px; justify-content: space-between;
  white-space: normal; }
/* 收件箱工具行：即时过滤输入 + 导出全部（过滤词空 = 全量） */
.bt-inbox-toolbar { display: flex; gap: 8px; align-items: center; margin-top: -2px; }
.bt-filter { flex: 1; min-width: 0; height: 32px; box-sizing: border-box;
  border: 1px solid var(--bt-line); border-radius: 10px; background: var(--bt-card);
  color: inherit; font-size: 12.5px; padding: 0 10px; outline: none;
  transition: border-color .15s ease, box-shadow .15s ease; }
.bt-filter:focus { border-color: var(--bt-a); box-shadow: 0 0 0 3px rgba(99,102,241,.15); }
.bt-filter::placeholder { color: var(--bt-mut); opacity: .75; }
/* 行内小徽标：「新」（未展开过的卡）与分组计数，同一基座 */
.bt-tag { font-size: 10px; font-weight: 700; line-height: 1.5; padding: 1px 8px;
  border-radius: 999px; flex: none; white-space: nowrap; box-sizing: border-box; letter-spacing: .02em; }
.bt-tag-new { color: var(--bt-warn); background: rgba(251,191,36,.16); border: 1px solid rgba(251,191,36,.4); }
.bt-tag-lowinfo { color: var(--bt-mut); background: rgba(127,127,127,.12); border: 1px solid var(--bt-line); }
.bt-tag-group { color: var(--bt-a); background: rgba(99,102,241,.12); border: 1px solid transparent; }
/* 组内成员行：整体右缩进，视觉上挂在组头下 */
.bt-pending-member { margin-left: 20px; }
/* 行外壳（中性容器，内含 role=button 行 + 兄弟预览块）：延续原先行内 flex-wrap 布局 */
.bt-pending-wrap { display: flex; flex-wrap: wrap; }
.bt-cmds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 10px; }
.bt-cmd { display: flex; align-items: center; gap: 8px; min-width: 0; border: 1px solid var(--bt-line);
  border-radius: 10px; padding: 7px 12px; font-size: 12px; background: transparent;
  transition: opacity .15s ease, border-color .15s ease, background .15s ease; }
.bt-cmd:hover { border-color: var(--bt-line); background: var(--bt-hover); }
.bt-cmd-key { font-family: ui-monospace, monospace; font-size: 11.5px; font-weight: 600; flex: none; }
.bt-cmd-key-primary { color: var(--bt-a); }
.bt-cmd-desc { color: var(--bt-mut); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-cmd .bt-icon { width: 16px; height: 16px; flex: none; border-radius: 5px; }
.bt-cmd-off { opacity: .42; }
.bt-icon { display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
  flex: none; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255,255,255,.14), 0 1px 2px rgba(0,0,0,.16); }
.bt-icon svg { display: block; }
.bt-icon-full { border-radius: 50%; }
.bt-icon-full svg { width: 100%; height: 100%; }
.bt-icon-letter { color: #fff; font-weight: 700; font-size: 11px; line-height: 1; letter-spacing: -.02em; user-select: none; }
.bt-matrix { display: flex; flex-direction: column; }
.bt-mrow { display: grid; grid-template-columns: minmax(170px, auto) 1fr auto auto; gap: 10px; align-items: center;
  padding: 8px 6px; font-size: 12.5px; border-bottom: 1px solid var(--bt-line); border-radius: 8px;
  transition: opacity .15s ease, background .15s ease; }
.bt-mrow:hover { background: var(--bt-hover); }
.bt-mrow:last-child { border-bottom: none; }
.bt-mrow-idle { opacity: .48; }
.bt-mrow-idle:hover { opacity: .8; }
.bt-mname-col { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.bt-mname-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
.bt-mname { font-weight: 600; font-size: 12.5px; white-space: nowrap; }
.bt-mid { font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--bt-mut); opacity: .75; }
/* 假 0 哨兵浮出：supported 且 note 非空时行内橙色小字（不只放 title），与 --bt-warn 同轴 */
.bt-mnote { font-size: 10.5px; line-height: 1.5; color: var(--bt-warn); max-width: 360px; overflow-wrap: anywhere; }
.bt-mstat { font-size: 11.5px; color: var(--bt-mut); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.bt-pill { font-size: 10.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px; flex: none;
  min-width: 34px; text-align: center; box-sizing: border-box; letter-spacing: .02em; }
.bt-pill-ok { color: var(--bt-ok); background: rgba(21,128,61,.1); border: 1px solid rgba(21,128,61,.35); }
.bt-pill-no { color: var(--bt-warn); background: rgba(180,83,9,.1); border: 1px solid rgba(180,83,9,.35); }
.bt-toggle { cursor: pointer; width: 38px; height: 22px; border-radius: 999px; border: none;
  background: rgba(127,127,127,.25); position: relative; padding: 0; justify-self: end;
  transition: background .18s cubic-bezier(.4,0,.2,1); box-shadow: inset 0 1px 2px rgba(0,0,0,.12); }
.bt-toggle:disabled { opacity: .45; cursor: default; }
.bt-toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25); transition: left .18s cubic-bezier(.4,0,.2,1); }
.bt-toggle-on { background: linear-gradient(135deg, #6366F1, #8B5CF6); }
.bt-toggle-on::after { left: 19px; }
.bt-note { font-size: 11.5px; color: var(--bt-mut); line-height: 1.6; border-left: 2px solid var(--bt-line);
  padding-left: 10px; }
.bt-note summary { cursor: pointer; user-select: none; list-style: none; display: flex; align-items: center; gap: 6px; }
.bt-note summary::-webkit-details-marker { display: none; }
.bt-note summary::before { content: '▸'; font-size: 10px; transition: transform .15s ease; }
.bt-note[open] summary::before { transform: rotate(90deg); }
.bt-note-body { margin-top: 6px; }
/* 窄容器（侧栏收窄）：命令单列、矩阵行收掉会话数列，避免挤压换行 */
/* 来源筛选 chips：全部/各家/只看新卡，pill 基座 + 选中态品牌描边 */
.bt-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 2px 0 8px; }
.bt-chip { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  border: 1px solid var(--bt-line); border-radius: 999px; padding: 3px 12px;
  background: transparent; color: var(--bt-mut); font-size: 11.5px; font-weight: 500;
  font-variant-numeric: tabular-nums;
  transition: border-color .15s ease, color .15s ease, background .15s ease; }
.bt-chip:hover { border-color: var(--bt-a); color: var(--bt-a); }
.bt-chip-on { color: var(--bt-a); background: rgba(99,102,241,.12);
  border-color: rgba(99,102,241,.45); font-weight: 600; }
.bt-chip-count { font-size: 10px; opacity: .75; }
/* 外部会话浏览器：行 + 预览展开体。接管/寄存一键投递（FR-1）——面板不产卡，
 * 蒸馏都在会话里由模型完成（卡片质量跟模型能力走）。
 * 样式（审查 Y1-Y3）：主操作「接管」有主按钮权重；动作按钮定宽防状态文案切换跳动；
 * chips 与按钮补键盘焦点环。 */
.bt-btn-primary { color: var(--bt-a); border-color: rgba(99,102,241,.45); background: rgba(99,102,241,.12); font-weight: 600; }
.bt-btn-primary:not(:disabled):hover { background: var(--bt-a); border-color: var(--bt-a); color: #fff; transform: translateY(-1px); }
.bt-fsess-act .bt-btn-xs { min-width: 5.5em; }
.bt-chip:focus-visible, .bt-btn:focus-visible { outline: 2px solid var(--bt-a); outline-offset: 2px; }
.bt-chip-off { opacity: .4; }
.bt-chip-off:hover { border-color: var(--bt-line); color: var(--bt-mut); }
.bt-btn-xs { font-size: 11px; padding: 2px 8px; border-radius: 8px; }
.bt-fsess { border: 1px solid var(--bt-line); border-radius: 10px; padding: 7px 10px; margin-bottom: 6px; background: var(--bt-card); }
.bt-fsess-line1 { display: flex; gap: 8px; align-items: baseline; }
.bt-fsess-title { flex: 1; min-width: 0; font-size: 12.5px; font-weight: 600; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; cursor: pointer; border-radius: 4px; }
.bt-fsess-title:hover { color: var(--bt-a); }
.bt-fsess-title:focus-visible { outline: 2px solid var(--bt-a); outline-offset: 2px; }
.bt-fsess-time { flex: none; font-size: 11px; color: var(--bt-mut); font-variant-numeric: tabular-nums; }
.bt-fsess-line2 { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.bt-fsess-src { flex: none; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: var(--bt-mut); }
.bt-fsess-id { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: var(--bt-mut); cursor: pointer; font-variant-numeric: tabular-nums; }
.bt-fsess-id:hover { color: var(--bt-a); }
.bt-fsess-id:focus-visible { outline: 2px solid var(--bt-a); outline-offset: 2px; }
.bt-fsess-act { flex: none; display: flex; gap: 4px; }
.bt-fsprev { margin-top: 7px; padding-top: 7px; border-top: 1px dashed var(--bt-line); display: grid;
  gap: 3px; font-size: 11.5px; }
.bt-fsprev-line { display: flex; gap: 6px; min-width: 0; }
.bt-fsprev-label { flex: none; color: var(--bt-mut); }
.bt-fsprev-text { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3;
  -webkit-box-orient: vertical; word-break: break-word; }
.bt-fsprev-warn { color: var(--bt-warn); }
.bt-fs-empty { padding: 8px 2px; }
.bt-fs-count { margin: 8px 0 6px; }
@container (max-width: 430px) {
  .bt-fsess-act { flex-wrap: wrap; }
}
@container (max-width: 430px) {
  .bt-cmds { grid-template-columns: 1fr; }
  .bt-mrow { grid-template-columns: minmax(0, auto) auto auto; }
  .bt-mstat { display: none; }
}
`

// ---------------------------------------------------------------------------
// 数据获取
// ---------------------------------------------------------------------------

async function getState(): Promise<TakeoverState> {
  const res = await fetch('/dsh-takeover/state', { cache: 'no-store' })
  const body = await res.json() as TakeoverState | { error: string }
  if (!res.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${res.status}`)
  return body
}

async function post<T extends object>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json() as T | { error: string }
  if (!res.ok || 'error' in data) throw new Error('error' in data ? data.error : `HTTP ${res.status}`)
  return data
}

/** GET JSON：HTTP 层错误抛出（错误文案优先取响应体 error 字段）；业务面 ok:false 由调用方窄化 */
async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const b = await res.json() as { error?: string }
      if (typeof b.error === 'string' && b.error !== '') msg = b.error
    } catch { /* 无响应体则保留 HTTP 状态文案 */ }
    throw new Error(msg)
  }
  return await res.json() as T
}

/** 复制到剪贴板：Clipboard API 优先（需安全上下文——面板在 localhost 恒满足），
 * 不可得退 textarea+execCommand。异常上抛，由调用方进错误横幅。 */
function copyText(text: string): Promise<void> {
  const nav: { clipboard?: { writeText?: (t: string) => Promise<void> } } | undefined = globalThis.navigator
  if (nav?.clipboard?.writeText !== undefined) return nav.clipboard.writeText(text)
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      if (ok) resolve()
      else reject(new Error('execCommand copy failed'))
    } catch (e) { reject(e) }
  })
}

function fmtTime(iso: string, lang: Lang): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (sameDay) return hm // 今天的只给时刻，别把行撑长
  return lang === 'en'
    ? `${d.getMonth() + 1}/${d.getDate()} ${hm}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/**
 * 防御式取 localStorage：隐私模式 / 禁写（SecurityError、quota）回 null，
 * 已见集合退化为仅本会话记住（纯内存），徽标语义仍在，卡片不塌。
 * 探测一次真实读写——拿到引用不代表能写（Safari 隐私模式的老坑）。
 */
function safeLocalStorage(): SeenStore | null {
  try {
    const s: unknown = globalThis.localStorage
    if (s === null || typeof s !== 'object') return null
    const store = s as SeenStore
    const probe = '__dsh_takeover_probe__'
    store.setItem(probe, probe)
    store.removeItem(probe)
    return store
  } catch {
    return null
  }
}

/** Blob 下载：零依赖（URL.createObjectURL + 隐形 <a> 点击）；异常由调用方进错误横幅。
 * mime 由调用方给：.md 走 text/markdown，HTML 报告走 text/html。 */
function downloadText(filename: string, text: string, mime = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => { URL.revokeObjectURL(url) }, 1_000)
}

/** 导出文件名的时间戳尾巴：handoff-pending-20261003-1215.md */
function exportStamp(d = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// host 侧并行落地字段的防御式读取（0.3.2 预留位）
// 字段由 host 半（settings.ts/tools.ts，另一条工作线）稍后落地；客户端约定两处
// 落点：state.extras.* 优先、顶层 * 兜底。任一都不在或形态不符 → null，
// 对应整行/徽标不渲染——宁可少显示，不硬造。
// ---------------------------------------------------------------------------

/** 非负有限数才算计数（信封字符数 / coverage 计数）；NaN、负数、字符串数字不认 */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/** state.extras 防御式取对象：host 侧未落地 / 形态漂移一律回空对象 */
function extrasOf(state: TakeoverState): Record<string, unknown> {
  const v: unknown = (state as unknown as Record<string, unknown>).extras
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/**
 * 机器信封字符数。host 半真实契约（src/tools.ts InboxLoadResult）：
 * envelopeChars?: number（随卡消费的机器信封 JSON 字符数）。state 侧落地位置
 * 未定稿前两处都探：extras.envelopeChars / envelopeChars，另容 envelope: { chars }
 * 对象形态。全不在 → null（「机器信封已随卡归档」整行不显示）。
 */
export function envelopeCharsOf(state: TakeoverState): number | null {
  const top = state as unknown as Record<string, unknown>
  const extra = extrasOf(state)
  for (const c of [extra.envelopeChars, top.envelopeChars]) {
    if (isCount(c)) return c
  }
  for (const env of [extra.envelope, top.envelope]) {
    if (env !== null && typeof env === 'object') {
      const chars: unknown = (env as Record<string, unknown>).chars
      if (isCount(chars)) return chars
    }
  }
  return null
}

/**
 * 四态覆盖率徽标文本（extras.coverage 优先、顶层 coverage 兜底——extras.coverage
 * 即 host 半 coverageFromExtras 的取数位，src/tools.ts CoverageStats）：
 * - 对象形态认真实契约 { statements, marked, unmarked }（三字段齐且全为非负数），
 *   出 "marked/statements"，与工具侧 renderCoverageLine 的 x/y 口径一致；
 * - 字符串形态（如 "3/8"）trim 后非空即原样展示；
 * - 兜底对象形态 { done, total }（x / y 字面键再兜一层）拼成 "x/y"。
 * 全不在/形态不符 → null（徽标位整体不渲染）。
 */
export function coverageTextOf(state: TakeoverState): string | null {
  const top = state as unknown as Record<string, unknown>
  const extra = extrasOf(state)
  for (const c of [extra.coverage, top.coverage]) {
    if (typeof c === 'string') {
      const s = c.trim()
      if (s !== '') return s
    } else if (c !== null && typeof c === 'object') {
      const o = c as Record<string, unknown>
      if (isCount(o.statements) && isCount(o.marked) && isCount(o.unmarked)) {
        return `${o.marked}/${o.statements}`
      }
      const x = isCount(o.done) ? o.done : isCount(o.x) ? o.x : null
      const y = isCount(o.total) ? o.total : isCount(o.y) ? o.y : null
      if (x !== null && y !== null) return `${x}/${y}`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// HTML 单文件报告导出（docs/需求调研-1003.md P2：对标 Claude Code /export 需求）。
// state→html 是可导出纯函数：单测直接喂 state + 双语词典 + 固定时刻，无 DOM。
// 诚实纪律：内容仅来自 state 真有字段（pending 全卡 / 八家矩阵 / archived 计数 /
// pendingSkipped / inboxError），不硬造；卡片标题与预览是模型生成文本，进 HTML
// 前一律过 escHtml——自包含单文件没有 CSP 兜底，转义是唯一防线。
// ---------------------------------------------------------------------------

/** HTML 文本转义：& < > " ' 全量，任何 state 来的字符串进模板前必须过这里 */
function escHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 报告里的绝对时间：解析失败原样返回（诚实优于臆造）；成功给本地 YYYY-MM-DD HH:mm */
function absTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 报告文案包（调用方按语言现配，本函数保持无 i18n 依赖——同 inbox-view 的 ExportNotes 纪律） */
export interface ReportWords {
  title: string
  subtitle: string
  /** 「生成于 {n}」模板，{n} 由 buildReportHtml 代入 */
  generated: string
  /** 顶部边界说明：内容仅来自 state，完整卡片回会话 /inbox 取 */
  note: string
  statPending: string
  statArchived: string
  statProviders: string
  sectionInbox: string
  sectionMatrix: string
  pendingEmpty: string
  /** 「另有 {n} 张无法解析的卡片被跳过」模板 */
  skipped: string
  labelFrom: string
  labelProject: string
  labelTime: string
  labelPreview: string
  previewEmpty: string
  /** 矩阵行：会话数 / 探测失败 / 不支持 / 启用状态 */
  sessionsCount: string
  sessionsProbeFail: string
  unsupported: string
  unsupportedNote: string
  pillOk: string
  pillNo: string
  disabled: string
  /** 来源为空时的兜底显示名（host 侧 0.4.0 起下发空串） */
  unknownSource: string
}

/** 从本卡词典组装报告文案包（zh/en 全量对齐，漏译在 tests/locales.spec.ts 拦下） */
export function reportWords(lang: Lang): ReportWords {
  const d = DICTS[lang]
  const w = (key: string): string => d[key] ?? key
  return {
    title: w('reportTitle'),
    subtitle: w('reportSubtitle'),
    generated: w('reportGenerated'),
    note: w('reportNote'),
    statPending: w('reportStatPending'),
    statArchived: w('reportStatArchived'),
    statProviders: w('reportStatProviders'),
    sectionInbox: w('inboxTitle'),
    sectionMatrix: w('matrixTitle'),
    pendingEmpty: w('reportPendingEmpty'),
    skipped: w('reportSkipped'),
    labelFrom: w('reportLabelFrom'),
    labelProject: w('reportLabelProject'),
    labelTime: w('reportLabelTime'),
    labelPreview: w('reportLabelPreview'),
    previewEmpty: w('previewEmpty'),
    sessionsCount: w('sessionsCount'),
    sessionsProbeFail: w('sessionsProbeFail'),
    unsupported: w('unsupported'),
    unsupportedNote: w('unsupportedNote'),
    pillOk: w('pillOk'),
    pillNo: w('pillNo'),
    disabled: w('reportDisabled'),
    unknownSource: w('unknownSource'),
  }
}

/** 报告样式：内联进单文件（自包含、离线可开）；品牌渐变头 #6366F1→#8B5CF6 */
const REPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f4f5fb; color: #1e293b;
  font: 14px/1.65 system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; }
.rt-hero { background: linear-gradient(135deg, #6366F1, #8B5CF6); color: #fff; padding: 34px 28px 28px; }
.rt-hero h1 { margin: 0; font-size: 22px; letter-spacing: .01em; overflow-wrap: anywhere; }
.rt-sub { margin: 6px 0 0; font-size: 13.5px; opacity: .85; }
.rt-meta { margin: 14px 0 0; font-size: 12px; opacity: .78; }
.rt-main { max-width: 860px; margin: 0 auto; padding: 22px 20px 8px; display: flex; flex-direction: column; gap: 16px; }
.rt-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.rt-stat { background: #fff; border: 1px solid rgba(99,102,241,.18); border-radius: 12px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 2px; box-shadow: 0 1px 2px rgba(30,41,59,.06); }
.rt-stat-n { font-size: 24px; font-weight: 700; color: #4f46e5; }
.rt-stat-label { font-size: 12px; color: #64748b; }
.rt-note { margin: 0; font-size: 12px; line-height: 1.7; color: #64748b; background: rgba(99,102,241,.06);
  border: 1px solid rgba(99,102,241,.16); border-radius: 10px; padding: 10px 14px; }
.rt-card { background: #fff; border: 1px solid rgba(30,41,59,.08); border-radius: 12px; padding: 16px 18px; }
.rt-card h2 { margin: 0 0 12px; font-size: 15px; color: #312e81; }
.rt-empty { color: #64748b; font-size: 13px; background: rgba(127,127,127,.07); border-radius: 8px; padding: 12px 14px; }
.rt-warn { color: #b45309; font-size: 12.5px; line-height: 1.6; background: rgba(251,191,36,.13);
  border-radius: 8px; padding: 10px 14px; margin: 0 0 10px; overflow-wrap: anywhere; }
.rt-pcard { border: 1px solid rgba(30,41,59,.08); border-radius: 10px; padding: 12px 14px; }
.rt-pcard + .rt-pcard { margin-top: 10px; }
.rt-ptitle { margin: 0 0 4px; font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
.rt-pid { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px;
  font-weight: 500; color: #6366F1; background: rgba(99,102,241,.08); border-radius: 6px; padding: 1px 7px; margin-left: 6px; }
.rt-pmeta { margin: 0 0 8px; font-size: 12px; color: #64748b; display: flex; flex-wrap: wrap; gap: 2px 14px; }
.rt-plabel { font-size: 11px; opacity: .82; margin-right: 3px; }
.rt-preview { margin-top: 2px; padding: 8px 12px; border-left: 3px solid #6366F1; background: #f8f9ff;
  border-radius: 0 8px 8px 0; }
.rt-preview-body { font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.rt-mrow { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 7px 2px;
  border-bottom: 1px dashed rgba(30,41,59,.1); font-size: 13px; }
.rt-mrow:last-child { border-bottom: none; }
.rt-mrow-off { opacity: .55; }
.rt-mname { font-weight: 600; min-width: 140px; }
.rt-mid { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: #94a3b8; }
.rt-pill { font-size: 11px; font-weight: 600; border-radius: 999px; padding: 1px 10px; white-space: nowrap; }
.rt-pill-ok { color: #15803d; background: rgba(21,128,61,.1); border: 1px solid rgba(21,128,61,.35); }
.rt-pill-no { color: #b45309; background: rgba(180,83,9,.1); border: 1px solid rgba(180,83,9,.35); }
.rt-mstat { color: #64748b; font-size: 12px; }
.rt-mnote { flex-basis: 100%; color: #b45309; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.rt-foot { text-align: center; color: #94a3b8; font-size: 11.5px; padding: 14px 0 30px; }
@media (max-width: 560px) { .rt-stats { grid-template-columns: 1fr; } }
`

/**
 * state → 自包含 HTML 报告（纯函数，无 DOM / 无 i18n / 无时钟依赖）：
 * - generatedAt 由调用方给定（展示与 <title> 用；文件名时间戳在调用方拼），
 *   单测喂固定串即可逐字断言；
 * - 内容面：头部品牌渐变 + 三张统计卡（待取件 / 已消费 / 读取器已启用-总数）+
 *   边界说明 + 收件箱全卡（空态出横幅；inboxError / pendingSkipped 诚实浮出）+
 *   八家支持矩阵（启用与否、支持 pill、会话数、note 浮出）。
 */
export function buildReportHtml(
  state: TakeoverState,
  words: ReportWords,
  lang: Lang,
  generatedAt: string,
): string {
  const esc = escHtml
  const enabled = state.providers.filter((p) => p.enabled).length

  const statCards =
    `<div class="rt-stat"><span class="rt-stat-n">${state.pending.length}</span>` +
    `<span class="rt-stat-label">${esc(words.statPending)}</span></div>` +
    `<div class="rt-stat"><span class="rt-stat-n">${state.archivedCount}</span>` +
    `<span class="rt-stat-label">${esc(words.statArchived)}</span></div>` +
    `<div class="rt-stat"><span class="rt-stat-n">${enabled}/${state.providers.length}</span>` +
    `<span class="rt-stat-label">${esc(words.statProviders)}</span></div>`

  // 收件箱诚实浮出：概览不可用 / 坏卡跳过——只转述 state 给的原文，不粉饰成「为空」
  const inboxFlags =
    (state.inboxError !== undefined && state.inboxError !== ''
      ? `<div class="rt-warn">${esc(state.inboxError)}</div>`
      : '') +
    (state.pendingSkipped > 0
      ? `<div class="rt-warn">${esc(interpolate(words.skipped, { n: state.pendingSkipped }))}</div>`
      : '')

  const pendingCards = state.pending.map((p) => {
    const hasTitle = p.title !== ''
    const title = hasTitle ? p.title : p.id
    const idChip = hasTitle ? `<span class="rt-pid">${esc(p.id)}</span>` : ''
    const project = p.project !== ''
      ? `<span><span class="rt-plabel">${esc(words.labelProject)}</span>${esc(p.project)}</span>`
      : ''
    const previewBody = p.preview !== '' ? p.preview : words.previewEmpty
    return `<div class="rt-pcard">` +
      `<p class="rt-ptitle">${esc(title)}${idChip}</p>` +
      `<p class="rt-pmeta">` +
      `<span><span class="rt-plabel">${esc(words.labelFrom)}</span>${esc(PROVIDER_LABEL[p.agent] ?? (p.agent === '' ? words.unknownSource : p.agent))}</span>` +
      project +
      `<span><span class="rt-plabel">${esc(words.labelTime)}</span>${esc(absTime(p.pushedAt))}</span>` +
      `</p>` +
      `<div class="rt-preview"><span class="rt-plabel">${esc(words.labelPreview)}</span>` +
      `<div class="rt-preview-body">${esc(previewBody)}</div></div>` +
      `</div>`
  }).join('')

  const inboxBody = state.pending.length === 0
    ? `<div class="rt-empty">${esc(words.pendingEmpty)}</div>`
    : pendingCards

  const matrixRows = state.providers.map((r) => {
    const label = PROVIDER_LABEL[r.name] ?? r.name
    const stat = r.supported
      ? (r.sessions >= 0 ? interpolate(words.sessionsCount, { n: r.sessions }) : words.sessionsProbeFail)
      : (r.note !== '' ? interpolate(words.unsupportedNote, { note: r.note }) : words.unsupported)
    // 假 0 哨兵浮出与设置卡同口径：supported 且 note 非空才浮出
    const note = r.supported && r.note !== '' ? `<span class="rt-mnote">${esc(r.note)}</span>` : ''
    return `<div class="rt-mrow${r.enabled ? '' : ' rt-mrow-off'}">` +
      `<span class="rt-mname">${esc(label)}</span>` +
      `<span class="rt-mid">${esc(r.name)}</span>` +
      `<span class="rt-pill ${r.supported ? 'rt-pill-ok' : 'rt-pill-no'}">${esc(r.supported ? words.pillOk : words.pillNo)}</span>` +
      `<span class="rt-mstat">${esc(stat)}${r.enabled ? '' : ` · ${esc(words.disabled)}`}</span>` +
      note +
      `</div>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(words.title)} · ${esc(generatedAt)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header class="rt-hero">
<h1>${esc(words.title)}</h1>
<p class="rt-sub">${esc(words.subtitle)}</p>
<p class="rt-meta">${esc(interpolate(words.generated, { n: generatedAt }))} · dsh-takeover</p>
</header>
<main class="rt-main">
<div class="rt-stats">${statCards}</div>
<p class="rt-note">${esc(words.note)}</p>
<section class="rt-card">
<h2>${esc(words.sectionInbox)}</h2>
${inboxFlags}
${inboxBody}
</section>
<section class="rt-card">
<h2>${esc(words.sectionMatrix)}</h2>
${matrixRows}
</section>
</main>
<footer class="rt-foot">dsh-takeover · handoff: 1</footer>
</body>
</html>
`
}

// ---------------------------------------------------------------------------
// 展示件
// ---------------------------------------------------------------------------

function PendingList({ rows, query, home, t, lang, onExport, onChainFilter, onTakeInbox, takeBusyId }: {
  rows: PendingRow[]
  query: string
  /** 解析后的 HANDOFF_HOME（state.home）：已见集合 localStorage 键的散列源 */
  home: string
  t: Translate
  lang: Lang
  /** 单卡导出（展开态「导出 .md」按钮），下载逻辑在 Panel */
  onExport: (p: PendingRow) => void
  /** FR-4：按接力链过滤（把查询词设为前置卡 id） */
  onChainFilter: (id: string) => void
  /** FR-1：一键取件（新建会话投递 /inbox，带卡 id 定向取件），投递态在 Panel */
  onTakeInbox: (p: PendingRow) => void
  /** 正在投递的卡 id（审查 C7：按行显示投递中，其余行仅 disabled） */
  takeBusyId: string | null
}): ReturnType<typeof createElement> {
  // 已见集合：localStorage 按 HANDOFF_HOME 散列分键；打开过（展开过）即记为已见。
  // 存储不可写时退化为仅本会话记住（loadSeenSet/saveSeenSet 全程不抛）。
  const [store] = useState(safeLocalStorage)
  const [seen, setSeen] = useState<Set<string>>(() => loadSeenSet(store, seenStorageKey(home)))
  const [openIds, setOpenIds] = useState<Set<string>>(new Set())
  // HANDOFF_HOME 变更（服务端换目录/换机器）→ 键变，已见集随之重载
  useEffect(() => { setSeen(loadSeenSet(store, seenStorageKey(home))) }, [store, home])

  const markSeen = (ids: readonly string[]): void => {
    setSeen((prev) => {
      const fresh = ids.filter((id) => !prev.has(id))
      if (fresh.length === 0) return prev
      const next = new Set(prev)
      for (const id of fresh) next.add(id)
      // 副作用（localStorage 持久化）在 updater 外做：updater 须为纯函数
      queueMicrotask(() => saveSeenSet(store, seenStorageKey(home), next))
      return next
    })
  }
  const toggleOpen = (id: string): void => {
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    markSeen([id]) // 打开过即记为已见，「新」徽标随之消失
  }
  const toggleGroup = (g: PendingGroup): void => {
    const willOpen = !openIds.has(g.key)
    setOpenIds((prev) => {
      const next = new Set(prev)
      if (next.has(g.key)) next.delete(g.key)
      else next.add(g.key)
      return next
    })
    // 组头展开即整组可见：全部成员一并记为已见（同一 openIds 机制，键是组 key）
    if (willOpen) markSeen(g.rows.map((r) => r.id))
  }

  // 来源筛选 + 只看新卡：收件箱自持的筛选状态（重开设置卡即重置，轻量符合直觉）
  const [sourceSel, setSourceSel] = useState<string | null>(null)
  const [newOnly, setNewOnly] = useState(false)

  // 先滤（来源 → 只看新卡 → 文本）后组：过滤改变可见序列，「相邻」在滤后的列表上判定。
  // 空壳卡分离成「低信息」次级组（默认折叠）——主列表只留实质工作卡（Linear/Gmail 范式）
  const newIds = new Set(newIdsOf(rows, seen))
  const visible = filterPending(
    rows,
    query,
    (a) => PROVIDER_LABEL[a] ?? (a === '' ? t('unknownSource') : a),
    sourceSel,
    newOnly ? newIds : null,
  )
  const lowRows = visible.filter((r) => r.lowInfo === true)
  const mainRows = visible.filter((r) => r.lowInfo !== true)
  const groups = groupAdjacent(mainRows)
  const facets = sourceFacets(rows)

  // 来源筛选 chips：全部 + 各家（带计数）+ 只看新卡
  const chip = (label: string, count: number, on: boolean, onClick: () => void, key: string): ReturnType<typeof createElement> =>
    createElement('button', {
      key,
      className: `bt-chip${on ? ' bt-chip-on' : ''}`,
      'aria-pressed': on,
      onClick,
      type: 'button',
    },
      createElement('span', { className: 'bt-chip-label' }, label),
      createElement('span', { className: 'bt-chip-count' }, String(count)),
    )
  // 来源显示名：host 侧空串回退（0.4.0 起不再下发中文字面量），由词典渲染兜底
  const agentLabel = (a: string): string => PROVIDER_LABEL[a] ?? (a === '' ? t('unknownSource') : a)
  const chipBar = createElement('div', { className: 'bt-chips', role: 'group', 'aria-label': t('chipSourceAria') },
    chip(t('chipAll'), rows.length, sourceSel === null, () => setSourceSel(null), 'chip-all'),
    ...facets.map((f) => chip(
      agentLabel(f.agent),
      f.count,
      sourceSel === f.agent,
      () => setSourceSel(sourceSel === f.agent ? null : f.agent),
      'chip-' + f.agent,
    )),
    chip(t('newOnlyChip'), newIds.size, newOnly, () => setNewOnly(!newOnly), 'chip-new'),
  )

  // 低信息次级组：可展开（与普通组同一 openIds 机制），组头带数量与「低信息」语义
  const lowInfoNode = (low: PendingRow[]): ReturnType<typeof createElement> => {
    const key = 'bt-lowinfo'
    const open = openIds.has(key)
    const hasNew = low.some((r) => !seen.has(r.id))
    const toggle = () => {
      setOpenIds((prev) => { const nx = new Set(prev); if (nx.has(key)) nx.delete(key); else nx.add(key); return nx })
      if (!open) markSeen(low.map((r) => r.id)) // 展开即整组记已见（与 toggleGroup 对齐——审查 #11）
    }
    return createElement('div', { key, className: 'bt-group' },
      createElement('div', {
        className: `bt-pending${open ? ' bt-pending-open' : ''}`,
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        'aria-label': t('groupAria', { title: t('lowInfoGroup', { n: low.length }), n: low.length }),
        onClick: toggle,
        onKeyDown: (e: { key: string; preventDefault(): void }) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
        },
      },
        createElement('span', { className: 'bt-tag bt-tag-lowinfo' }, t('lowInfoBadge')),
        createElement('span', { className: 'bt-pending-title' }, t('lowInfoGroup', { n: low.length })),
        hasNew ? createElement('span', { className: 'bt-tag bt-tag-new' }, t('newBadge')) : null,
        createElement('span', { className: 'bt-pending-chev', 'aria-hidden': true }, '▸'),
      ),
      open ? low.map((r) => rowNode(r, true)) : null,
    )
  }

  const rowNode = (p: PendingRow, inGroup: boolean): ReturnType<typeof createElement> => {
    const open = openIds.has(p.id)
    const isNew = !seen.has(p.id)
    // 外层是中性容器：预览与「导出 .md」按钮必须是 role=button 行的**兄弟**节点——
    // 嵌套可交互元素违反 ARIA 禁则（stopPropagation 只解决事件，不解决语义）
    return createElement('div', { key: p.id, className: inGroup ? 'bt-pending-member' : undefined },
      createElement('div', {
      className: `bt-pending${open ? ' bt-pending-open' : ''}`,
      title: p.id,
      role: 'button',
      tabIndex: 0,
      'aria-expanded': open,
      onClick: () => { toggleOpen(p.id) },
      onKeyDown: (e: { key: string; preventDefault(): void }) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(p.id) }
      },
    },
      createElement('span', { className: 'bt-pend-icon' }, createElement(ProviderIcon, { name: p.agent, size: 22 })),
      createElement('span', { className: 'bt-pend-main' },
        createElement('span', { className: 'bt-pend-line1' },
          createElement('span', { className: 'bt-pending-title' }, p.title !== '' ? p.title : p.id),
          isNew ? createElement('span', { className: 'bt-tag bt-tag-new' }, t('newBadge')) : null,
          p.lowInfo === true ? createElement('span', { className: 'bt-tag bt-tag-lowinfo' }, t('lowInfoBadge')) : null,
          // FR-4：接力链徽标（展示位；过滤入口在展开态「只看此链」——行内不嵌交互，ARIA 禁则同前）
          p.supersedes !== undefined
            ? createElement('span', {
                className: 'bt-tag bt-tag-group',
                title: t('chainBadgeTitle', { id: p.supersedes }),
              }, t('chainBadge', { id: p.supersedes.length > 16 ? `${p.supersedes.slice(0, 16)}…` : p.supersedes }))
            : null,
          createElement('span', { className: 'bt-pend-time' }, p.pushedAt === '' ? t('noTime') : fmtTime(p.pushedAt, lang)),
        ),
        createElement('span', {
          className: 'bt-pend-meta',
          title: `${t('from', { name: '' }).trim()} · ${t('project', { name: '' }).trim()} · ${t('idLabel', { id: '' }).trim()}`,
        },
          createElement('span', { className: 'bt-pend-src' }, agentLabel(p.agent)),
          p.project !== '' ? createElement('span', { className: 'bt-pend-dot' }, '·') : null,
          p.project !== '' ? createElement('span', null, p.project) : null,
          createElement('span', { className: 'bt-pend-dot' }, '·'),
          createElement('span', { className: 'bt-pend-id' }, p.id),
        ),
      ),
      createElement('span', { className: 'bt-pending-chev', 'aria-hidden': true }, '▸'),
      ),
      open ? createElement('div', { className: 'bt-preview', onClick: (e: Event) => e.stopPropagation() },
        createElement('span', null, p.preview !== '' ? p.preview : t('previewEmpty')),
        createElement('span', { className: 'bt-preview-actions' },
          createElement('span', { className: 'bt-preview-hint' }, t('previewHint')),
          p.supersedes !== undefined
            ? createElement('button', {
                className: 'bt-btn',
                onClick: () => {
                  // 审查 C3：链过滤要同时清掉行内来源/新卡筛选，否则组合过滤出空列表
                  setSourceSel(null)
                  setNewOnly(false)
                  onChainFilter(p.supersedes as string)
                },
                title: t('chainFilterTitle', { id: p.supersedes }),
              }, t('chainFilterBtn'))
            : null,
          createElement('button', {
            className: 'bt-btn',
            disabled: takeBusyId !== null,
            onClick: () => { onTakeInbox(p) },
            title: t('inboxTakeTitle'),
          }, takeBusyId === p.id ? t('deliveringBtn') : t('inboxTakeBtn')),
          createElement('button', {
            className: 'bt-btn',
            onClick: () => { onExport(p) },
            title: t('exportCardTitle'),
          }, t('exportCard')),
        ),
      ) : null,
    )
  }

  const groupNode = (g: PendingGroup): ReturnType<typeof createElement> => {
    const open = openIds.has(g.key)
    const hasNew = g.rows.some((r) => !seen.has(r.id))
    const head = g.rows[0]
    return createElement('div', { key: g.key, className: 'bt-group' },
      createElement('div', {
        className: `bt-pending${open ? ' bt-pending-open' : ''}`,
        title: g.rows.map((r) => r.id).join(' · '),
        role: 'button',
        tabIndex: 0,
        'aria-expanded': open,
        'aria-label': t('groupAria', { title: g.title, n: g.rows.length }),
        onClick: () => { toggleGroup(g) },
        onKeyDown: (e: { key: string; preventDefault(): void }) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(g) }
        },
      },
        createElement('span', { className: 'bt-pend-icon' }, createElement(ProviderIcon, { name: g.agent, size: 22 })),
        createElement('span', { className: 'bt-pend-main' },
          createElement('span', { className: 'bt-pend-line1' },
            createElement('span', { className: 'bt-pending-title' }, g.title),
            createElement('span', { className: 'bt-tag bt-tag-group' }, t('groupCount', { n: g.rows.length })),
            hasNew ? createElement('span', { className: 'bt-tag bt-tag-new' }, t('newBadge')) : null,
            head !== undefined
              ? createElement('span', { className: 'bt-pend-time' }, head.pushedAt === '' ? t('noTime') : fmtTime(head.pushedAt, lang))
              : null,
          ),
          createElement('span', {
            className: 'bt-pend-meta',
            title: t('from', { name: '' }).trim(),
          },
            createElement('span', { className: 'bt-pend-src' }, agentLabel(g.agent)),
          ),
        ),
        createElement('span', { className: 'bt-pending-chev', 'aria-hidden': true }, '▸'),
      ),
      open ? g.rows.map((r) => rowNode(r, true)) : null,
    )
  }

  return createElement('div', { className: 'bt-rows' },
    chipBar,
    rows.length === 0
      ? createElement('div', { className: 'bt-banner bt-banner-info' }, t('emptyInbox'))
      : visible.length === 0
        ? createElement('div', { className: 'bt-banner bt-banner-info' }, t('filterEmpty'))
        : mainRows.length === 0 && lowRows.length > 0
          ? lowInfoNode(lowRows)
          : [
              ...groups.map((g) => (g.rows.length > 1 ? groupNode(g) : rowNode(g.rows[0] as PendingRow, false))),
              lowRows.length > 0 ? lowInfoNode(lowRows) : null,
            ],
  )
}

function ProviderMatrix({ rows, busy, onToggle, t }: {
  rows: ProviderRow[]
  busy: string | null
  onToggle: (name: string, enabled: boolean) => void
  t: Translate
}): ReturnType<typeof createElement> {
  return createElement('div', { className: 'bt-matrix' },
    ...rows.map((r) => {
      const label = PROVIDER_LABEL[r.name] ?? r.name
      // 假 0 哨兵浮出：supported 且 note 非空（布局迁移提示等）→ 行内橙色小字 +
      // title 悬浮 + aria-description，三处同源；unsupported 行仍走 stat 列的 unsupportedNote
      const showNote = r.supported && r.note !== ''
      const noteId = `bt-mnote-${r.name}`
      return createElement('div', {
        key: r.name,
        className: `bt-mrow${!r.supported || r.sessions === 0 ? ' bt-mrow-idle' : ''}`,
        title: r.note !== '' ? r.note : undefined,
        // aria-description 不是有效 ARIA 属性（读屏不识别）——改 aria-describedby 指向可见 note 节点
        'aria-describedby': showNote ? noteId : undefined,
      },
        createElement('span', { className: 'bt-mname-col' },
          createElement('span', { className: 'bt-mname-wrap' },
            createElement(ProviderIcon, { name: r.name }),
            createElement('span', { className: 'bt-mname' }, label),
            createElement('span', { className: 'bt-mid' }, r.name),
          ),
          showNote ? createElement('span', { className: 'bt-mnote', id: noteId }, r.note) : null,
        ),
        createElement('span', { className: 'bt-mstat' },
          r.supported
            ? (r.sessions >= 0 ? t('sessionsCount', { n: r.sessions }) : t('sessionsProbeFail'))
            : (r.note !== '' ? t('unsupportedNote', { note: r.note }) : t('unsupported'))),
        createElement('span', { className: `bt-pill ${r.supported ? 'bt-pill-ok' : 'bt-pill-no'}` },
          r.supported ? t('pillOk') : t('pillNo')),
        createElement('button', {
          className: `bt-toggle${r.enabled ? ' bt-toggle-on' : ''}`,
          role: 'switch',
          'aria-checked': r.enabled,
          'aria-label': t('toggleAria', { label, id: r.name }),
          disabled: busy !== null,
          title: r.enabled ? t('toggleDisable', { label }) : t('toggleEnable', { label }),
          onClick: () => { onToggle(r.name, !r.enabled) },
        }),
      )
    }),
  )
}

// ---------------------------------------------------------------------------
// 外部会话浏览器：浏览 + 一键投递（FR-1）。面板不产卡——蒸馏都在会话里由
// 模型完成（卡片质量跟着模型能力走，这正是「跟着模型升级」的接法）；
// 一键投递只是把与手动复制同源的指令送进新会话，失败退回复制。
// 列表走轻量发现层（默认不自动扫八家，点哪家读哪家）；预览按需单会话拉结构化摘要。
// ---------------------------------------------------------------------------

interface PreviewEntry {
  loading: boolean
  data: SessionPreviewBody | null
  error: string | null
}

function ForeignBrowser({ state, t, lang, onError, onNotice }: {
  state: TakeoverState | null
  t: Translate
  lang: Lang
  onError: (msg: string) => void
  /** 软回执横幅（FR-1 降级原因等，8s 自清）——审查 C5：降级不吞错 */
  onNotice: (msg: string) => void
}): ReturnType<typeof createElement> {
  const providers = state?.providers ?? []
  // 选中家：默认不选（面板打开不扫盘），点哪家读哪家；列表按家缓存
  const [sel, setSel] = useState<string | null>(null)
  const [lists, setLists] = useState<Record<string, SessionListBody>>({})
  // 审查 C2：按家记加载态（单字符串设计会在 A 加载中点 B 时把 B 永久卡在「加载中…」）
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [query, setQuery] = useState('')
  // FR-3：项目（cwd）facet 选中键；FR-2：子代理组展开态
  const [cwdSel, setCwdSel] = useState<string | null>(null)
  const [subOpen, setSubOpen] = useState(false)
  // FR-1：一键接管投递态（busyKey 防双击；delivered 成功回执）
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [deliveredKey, setDeliveredKey] = useState<string | null>(null)
  // 预览：单行展开（openId），按会话 id 缓存
  const [openId, setOpenId] = useState<string | null>(null)
  const [previews, setPreviews] = useState<Record<string, PreviewEntry>>({})
  // 复制回执：按钮文案短暂切换（不引入 toast 组件）
  const [copied, setCopied] = useState<string | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)

  const load = (provider: string): void => {
    setLoading((prev) => ({ ...prev, [provider]: true }))
    void getJson<SessionListBody | { ok: false; error: string }>(`/dsh-takeover/sessions?provider=${encodeURIComponent(provider)}`)
      .then((b) => {
        if (b.ok !== true) throw new Error(b.error)
        setLists((prev) => ({ ...prev, [provider]: b }))
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading((cur) => {
        if (cur[provider] !== true) return cur
        const next = { ...cur }
        delete next[provider]
        return next
      }))
  }

  const loadPreview = (provider: string, id: string): void => {
    setPreviews((prev) => ({ ...prev, [id]: { loading: true, data: prev[id]?.data ?? null, error: null } }))
    void getJson<SessionPreviewBody | { ok: false; error: string }>(
      `/dsh-takeover/session-preview?provider=${encodeURIComponent(provider)}&reference=${encodeURIComponent(id)}`,
    )
      .then((b) => {
        if (b.ok !== true) throw new Error(b.error)
        setPreviews((prev) => ({ ...prev, [id]: { loading: false, data: b, error: null } }))
      })
      .catch((e: unknown) => {
        setPreviews((prev) => ({ ...prev, [id]: { loading: false, data: null, error: e instanceof Error ? e.message : String(e) } }))
      })
  }

  const copy = (key: string, text: string): void => {
    void copyText(text)
      .then(() => {
        setCopied(key)
        window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => setCopied(null), 1600)
      })
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  const now = Date.now()
  const list = sel !== null ? lists[sel] : undefined
  const provider = sel ?? ''
  const clip = (s: string, n = 260): string => (s.length > n ? `${s.slice(0, n)}…` : s)

  /** FR-1 一键接管：POST 宿主投递（建新会话+queue 指令）；失败（含宿主缺控制器）
   * 自动退回复制路径——按钮与手动粘贴的载荷同源（takeoverCommand/depositCommand），
   * 降级永不改变语义，只多一步粘贴；失败原因随信息横幅浮出（审查 C5，不吞错）。 */
  const runTakeover = (key: string, mode: 'take' | 'take_deposit', id: string): void => {
    if (busyKey !== null) return
    const fallback = mode === 'take_deposit' ? depositCommand(provider, id, lang) : takeoverCommand(provider, id)
    setBusyKey(key)
    void post<{ ok: true; sessionId: string; title: string } | { ok: false; error: string }>(
      '/dsh-takeover/takeover',
      { mode, provider, reference: id, lang },
    )
      .then((r) => {
        if (!r.ok) throw new Error(r.error)
        setDeliveredKey(key)
        return undefined
      })
      .catch((e: unknown) => {
        const reason = e instanceof Error ? e.message : String(e)
        copyText(fallback)
          .then(() => {
            setCopied(key)
            window.clearTimeout(copyTimer.current)
            copyTimer.current = window.setTimeout(() => setCopied(null), 2400)
            onNotice(t('fallbackNotice', { reason }))
          })
          .catch((ce: unknown) => onError(ce instanceof Error ? ce.message : String(ce)))
      })
      .finally(() => setBusyKey(null))
  }

  const line = (label: string, text: string, key?: string): ReturnType<typeof createElement> =>
    createElement('div', { className: 'bt-fsprev-line', key },
      label !== '' ? createElement('span', { className: 'bt-fsprev-label' }, label) : null,
      createElement('span', { className: 'bt-fsprev-text' }, text),
    )

  const previewNode = (id: string): ReturnType<typeof createElement> | null => {
    const pv = previews[id]
    if (pv === undefined || pv.loading) return createElement('div', { className: 'bt-fsprev' }, t('loading'))
    if (pv.error !== null) {
      return createElement('div', { className: 'bt-fsprev bt-fsprev-warn' }, `${t('previewLoadFail')}：${pv.error}`)
    }
    const d = pv.data
    if (d === null) return null
    const warns = d.skeleton.warnings.split('\n').map((s) => s.trim()).filter((s) => s !== '').slice(0, 3)
    return createElement('div', { className: 'bt-fsprev' },
      createElement('div', { className: 'bt-fsprev-line' },
        createElement('span', { className: 'bt-fsprev-label' },
          t('previewTurns', { n: d.summary.turnCount, u: d.summary.userTurns })),
        d.note !== undefined ? createElement('span', { className: 'bt-fsprev-warn' }, d.note) : null,
      ),
      d.summary.firstUserMessage !== '' ? line(t('previewFirst'), clip(d.summary.firstUserMessage), 'pv-first') : null,
      ...d.summary.tailProgress.slice(0, 2).map((s, i) => line(i === 0 ? t('previewTail') : '', clip(s, 200), `pv-tail-${i}`)),
      line(t('previewStop'), clip(d.skeleton.stopped), 'pv-stop'),
      ...warns.map((w, i) => createElement('div', { className: 'bt-fsprev-line bt-fsprev-warn', key: `pv-warn-${i}` }, `⚠ ${clip(w, 200)}`)),
    )
  }

  const toggleRow = (r: SessionRow, open: boolean): void => {
    setOpenId(open ? null : r.id)
    if (!open && previews[r.id] === undefined && sel !== null) loadPreview(sel, r.id)
  }

  const rowNode = (r: SessionRow): ReturnType<typeof createElement> => {
    const open = openId === r.id
    const idShown = shortId(r)
    const idKey = `id:${r.id}`
    return createElement('div', { key: r.id, className: 'bt-fsess' },
      createElement('div', { className: 'bt-fsess-line1' },
        createElement('span', {
          className: 'bt-fsess-title',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          title: r.title !== '' ? r.title : r.id,
          onClick: () => toggleRow(r, open),
          onKeyDown: (e: { key: string; preventDefault(): void }) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(r, open) }
          },
        }, r.title !== '' ? r.title : idShown),
        createElement('span', { className: 'bt-fsess-time' }, relTime(r.updatedAt, now, lang)),
      ),
      createElement('div', { className: 'bt-fsess-line2' },
        createElement('span', {
          className: 'bt-fsess-src',
          title: r.cwd !== '' ? r.cwd : undefined,
        }, r.cwd === '' ? '—' : (r.cwd.split(/[\\/]/).filter(Boolean).pop() ?? r.cwd)),
        createElement('span', {
          className: 'bt-fsess-id',
          role: 'button',
          tabIndex: 0,
          title: t('copyIdTitle'),
          onClick: () => copy(idKey, r.id),
          onKeyDown: (e: { key: string; preventDefault(): void }) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(idKey, r.id) }
          },
        }, copied === idKey ? t('copiedBtn') : idShown),
        createElement('span', { className: 'bt-fsess-act' },
          createElement('button', {
            className: 'bt-btn bt-btn-xs bt-btn-primary',
            type: 'button',
            disabled: busyKey !== null,
            title: t('takeoverTitle'),
            onClick: () => runTakeover(`take:${r.id}`, 'take', r.id),
          },
            deliveredKey === `take:${r.id}` ? t('deliveredBtn')
            : busyKey === `take:${r.id}` ? t('deliveringBtn')
            : copied === `take:${r.id}` ? t('fallbackCopyBtn')
            : t('takeoverBtn')),
          createElement('button', {
            className: 'bt-btn bt-btn-xs',
            type: 'button',
            disabled: busyKey !== null,
            title: t('depositTitle'),
            onClick: () => runTakeover(`dep:${r.id}`, 'take_deposit', r.id),
          },
            deliveredKey === `dep:${r.id}` ? t('deliveredBtn')
            : busyKey === `dep:${r.id}` ? t('deliveringBtn')
            : copied === `dep:${r.id}` ? t('fallbackCopyBtn')
            : t('depositBtn')),
        ),
      ),
      open ? previewNode(r.id) : null,
    )
  }

  const matched = list !== undefined ? filterSessions(list.sessions, query) : []
  // FR-3：facet 计数随查询走（不含自身 cwd 选择，保持各 facet 计数可点）
  const facets = list !== undefined ? cwdFacets(matched) : []
  // 审查 C1：选中的 facet 因查询变化/换家消失时自动失效——不留下隐形过滤器
  const cwdEffective = facets.some((f) => f.cwd === cwdSel) ? cwdSel : null
  const visible = filterByCwd(matched, cwdEffective).filter((r) => !isSubagentSession(r))
  // FR-2：子代理/工作流会话收进次级折叠组（agent-sessions #49、cc-sessions #3 两家用户各自请求）
  const subRows = filterByCwd(matched, cwdEffective).filter(isSubagentSession)

  // FR-2 次级折叠组（与收件箱低信息组同款交互：组头开合，默认收起）
  const subGroupNode = subRows.length > 0
    ? createElement('div', { className: 'bt-group', key: 'fs-sub' },
        createElement('div', {
          className: `bt-pending${subOpen ? ' bt-pending-open' : ''}`,
          role: 'button',
          tabIndex: 0,
          'aria-expanded': subOpen,
          'aria-label': t('subagentGroup', { n: subRows.length }),
          onClick: () => setSubOpen(!subOpen),
          onKeyDown: (e: { key: string; preventDefault(): void }) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSubOpen(!subOpen) }
          },
        },
          createElement('span', { className: 'bt-tag bt-tag-lowinfo' }, t('subagentBadge')),
          createElement('span', { className: 'bt-pending-title' }, t('subagentGroup', { n: subRows.length })),
          createElement('span', { className: 'bt-pending-chev', 'aria-hidden': true }, '▸'),
        ),
        subOpen ? subRows.map(rowNode) : null,
      )
    : null

  return createElement('div', { className: 'bt-card' },
    createElement('div', { className: 'bt-head' },
      createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, t('browserTitle')),
    ),
    createElement('div', { className: 'bt-sub' }, t('browserHint')),
    createElement('div', { className: 'bt-chips', role: 'group', 'aria-label': t('browserChipAria'), style: { marginTop: 8 } },
      ...providers.map((p) => {
        const usable = p.supported && p.enabled
        return createElement('button', {
          key: p.name,
          className: `bt-chip${sel === p.name ? ' bt-chip-on' : ''}${usable ? '' : ' bt-chip-off'}`,
          disabled: !usable,
          'aria-pressed': sel === p.name,
          type: 'button',
          title: !usable
            ? t('browserDisabledTitle', { label: PROVIDER_LABEL[p.name] ?? p.name })
            : (p.supported && p.note !== '' ? p.note : undefined),
          onClick: () => {
            setSel(p.name)
            setOpenId(null)
            setCwdSel(null) // 审查 C1：换家必清项目 facet——旧家的 cwd 对新家是隐形过滤器
            if (lists[p.name] === undefined && loading[p.name] !== true) load(p.name)
          },
        },
          createElement('span', { className: 'bt-chip-label' }, PROVIDER_LABEL[p.name] ?? p.name),
          createElement('span', { className: 'bt-chip-count' }, p.sessions >= 0 ? String(p.sessions) : '…'),
        )
      }),
    ),
    sel === null || list === undefined
      ? createElement('div', { className: 'bt-sub bt-fs-empty' }, sel === null ? t('browserPick') : t('loading'))
      : [
          createElement('div', { className: 'bt-inbox-toolbar', key: 'fs-bar' },
            createElement('input', {
              className: 'bt-filter',
              type: 'search',
              value: query,
              placeholder: t('filterSessionsPlaceholder'),
              'aria-label': t('filterSessionsAria'),
              title: t('filterSessionsAria'),
              onChange: (e: { target: { value: string } }) => { setQuery(e.target.value) },
            }),
            createElement('button', {
              className: 'bt-btn',
              type: 'button',
              disabled: loading[provider] === true,
              onClick: () => { setOpenId(null); load(provider) },
            }, loading[provider] === true ? t('loading') : t('refresh')),
          ),
          createElement('div', { className: 'bt-sub bt-fs-count', key: 'fs-count' },
            list.total === 0
              ? t('browserEmpty')
              : t('browserTotal', { m: list.total, n: list.sessions.length }),
            list.note !== undefined ? ` · ${t('browserNote', { note: list.note })}` : '',
          ),
          list.total > 0 && facets.length > 1
            ? createElement('div', { className: 'bt-chips', key: 'fs-cwd', role: 'group', 'aria-label': t('facetCwdAria'), style: { marginTop: 6 } },
                ...facets.map((f) => createElement('button', {
                  key: f.cwd === '' ? '(empty)' : f.cwd,
                  className: `bt-chip${cwdEffective === f.cwd ? ' bt-chip-on' : ''}`,
                  'aria-pressed': cwdEffective === f.cwd,
                  type: 'button',
                  title: f.cwd === '' ? undefined : f.cwd,
                  onClick: () => setCwdSel(cwdEffective === f.cwd ? null : f.cwd),
                },
                  createElement('span', { className: 'bt-chip-label' }, f.label),
                  createElement('span', { className: 'bt-chip-count' }, String(f.count)),
                )),
              )
            : null,
          list.total > 0 && matched.length === 0
            ? createElement('div', { className: 'bt-banner bt-banner-info', key: 'fs-nomatch' }, t('browserFilterEmpty'))
            : createElement('div', { key: 'fs-rows' }, visible.map(rowNode), subGroupNode),
        ],
  )
}

// ---------------------------------------------------------------------------
// 命令速览：直接可见（不折叠）。provider 与 foreign.ts 的 FOREIGN_PROVIDERS
// 保持一致——不直接 import（值引入会把 host 半的 cordis/dsh-tools 拖进客户端包）。
// ---------------------------------------------------------------------------

const RESUME_PROVIDERS = ['claude', 'codex', 'opencode', 'zcode', 'pi', 'workbuddy', 'cursor', 'grok'] as const

function CommandsCard({ state, t }: { state: TakeoverState | null; t: Translate }): ReturnType<typeof createElement> {
  const disabled = new Set<string>(
    (state?.providers ?? []).filter((p) => !p.enabled).map((p) => p.name as string),
  )
  const chip = (cmd: string, desc: string, provider?: string, primary = false): ReturnType<typeof createElement> => {
    const off = provider !== undefined && disabled.has(provider)
    const label = provider !== undefined ? (PROVIDER_LABEL[provider] ?? provider) : undefined
    return createElement('div', {
      key: cmd,
      className: `bt-cmd${off ? ' bt-cmd-off' : ''}`,
      title: off && label !== undefined ? t('cmdOffTitle', { label }) : undefined,
    },
      provider !== undefined
        ? createElement(ProviderIcon, { name: provider })
        : createElement('span', { className: 'bt-icon', style: { width: 16, height: 16, background: 'var(--bt-a, #2563eb)' } },
            createElement('svg', { viewBox: '0 0 64 64', width: 10, height: 10, 'aria-hidden': true },
              createElement('rect', { x: 12, y: 26.5, width: 40, height: 11, rx: 5.5, fill: '#fff', transform: 'rotate(-45 32 32)' }))),
      createElement('span', { className: `bt-cmd-key${primary ? ' bt-cmd-key-primary' : ''}` }, cmd),
      createElement('span', { className: 'bt-cmd-desc' }, desc),
    )
  }
  return createElement('div', { className: 'bt-card' },
    createElement('div', { className: 'bt-head' },
      createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, t('cmdTitle')),
      createElement('span', { className: 'bt-badge' }, t('cmdBadge')),
    ),
    createElement('div', { className: 'bt-cmds' },
      chip('/handoff', t('cmdHandoffDesc'), undefined, true),
      chip('/inbox', t('cmdInboxDesc'), undefined, true),
      ...RESUME_PROVIDERS.map((p) => chip(`/resume-${p}`, t('cmdResumeDesc', { name: PROVIDER_LABEL[p] ?? p }), p)),
    ),
  )
}

// 渲染错误边界：任何渲染期异常直接显示在卡片里（宿主外壳会吞 React 报错，
// 静默空白最难排查——宁可把错误亮出来）。
type BoundaryState = { err: unknown }
class PanelBoundary extends Component<{ children: ReturnType<typeof createElement>; t: Translate }, BoundaryState> {
  override state: BoundaryState = { err: null }
  static getDerivedStateFromError(err: unknown): BoundaryState { return { err } }
  override render(): ReturnType<typeof createElement> {
    if (this.state.err !== null) {
      const e = this.state.err as { stack?: string; message?: string }
      return createElement('div', { className: 'bt-panel', style: themeVars() },
        createElement('style', null, CSS),
        createElement('div', { className: 'bt-card' },
          createElement('div', { className: 'bt-title' }, this.props.t('renderErrorTitle')),
          createElement('pre',
            { style: { fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, lineHeight: 1.5 } },
            e.stack ?? e.message ?? String(this.state.err)),
        ),
      )
    }
    return this.props.children
  }
}

function Panel({ t, locale }: { t: Translate; locale: LocaleRuntime | undefined }): ReturnType<typeof createElement> {
  const [state, setState] = useState<TakeoverState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  // 收件箱即时过滤词：空串 = 不过滤（纯前端，输入即滤，清空恢复）
  const [query, setQuery] = useState('')
  // FR-1：取件投递态（审查 C7：记正在投的卡 id，按行显示投递中）+ 操作回执横幅
  const [takeBusyId, setTakeBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const showNotice = (msg: string): void => {
    setNotice(msg)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 8000)
  }
  const takeInbox = (p: PendingRow): void => {
    if (takeBusyId !== null) return
    setTakeBusyId(p.id)
    // 审查 C4：行级按钮带卡 id 定向取件——服务端指令升级为「取编号 xxx 这张」，
    // 多卡待取时模型取的就是用户点的那张，不再是「自行挑一张」
    void post<{ ok: true; sessionId: string; title: string } | { ok: false; error: string }>('/dsh-takeover/takeover', { mode: 'inbox', reference: p.id })
      .then((r) => {
        if (!r.ok) throw new Error(r.error)
        showNotice(t('deliveredNotice', { title: r.title }))
        return undefined
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setTakeBusyId(null))
  }
  // 语言切换实时重渲染：宿主 locale revision 变化即重画（bound t 在渲染时取词）
  useSyncExternalStore(
    (cb) => {
      try {
        return locale?.subscribe(cb) ?? (() => {})
      } catch {
        return (() => {}) as () => void
      }
    },
    () => {
      try {
        return locale?.getSnapshot().revision ?? 0
      } catch {
        return 0
      }
    },
  )
  const lang: Lang = langOf(locale)

  // 请求代数：30s 轮询的慢 GET 若晚于 toggle POST 返回，会把开关弹回旧状态——
  // 每次发起请求自增代数，响应落地时只接受仍是最新代的结果
  const generationRef = useRef(0)
  const reload = (): void => {
    const gen = ++generationRef.current
    void getState().then(
      (s) => {
        if (gen !== generationRef.current) return
        setState(s); setError(null)
      },
      (e: unknown) => {
        if (gen !== generationRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }
  useEffect(reload, [])
  // 每 30s 自动刷新：仅面板前台可见时拉取（后台标签页不白跑请求）；
  // 卸载清 interval；手动刷新按钮（头卡）保留，两者共用同一 reload。
  useEffect(() => {
    const timer = window.setInterval(() => {
      try {
        if (document.visibilityState === 'visible') reload()
      } catch {
        /* visibilityState 不可得（非浏览器环境）：跳过本轮 */
      }
    }, 30_000)
    return () => { window.clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload 只闭包 setState，挂载期稳定
  }, [])

  const toggle = (name: string, enabled: boolean): void => {
    setBusy(name)
    const gen = ++generationRef.current
    void post<{ ok: true; state: TakeoverState }>('/dsh-takeover/provider', { provider: name, enabled })
      .then((r) => {
        if (gen !== generationRef.current) return
        setState(r.state); setError(null)
      })
      .catch((e: unknown) => {
        if (gen !== generationRef.current) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { setBusy(null) })
  }

  const clear = (): void => {
    if (!confirmClear) {
      setConfirmClear(true)
      setTimeout(() => { setConfirmClear(false) }, 3000)
      return
    }
    setConfirmClear(false)
    setBusy('clear')
    void post<{ ok: true; cleared: number }>('/dsh-takeover/clear-archived', {})
      .then(() => { reload() })
      .catch((e: unknown) => { setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { setBusy(null) })
  }

  const archivedCount = state?.archivedCount ?? 0
  // host 侧并行字段（0.3.2 预留位）：state 缺席或字段未落地 → null，行/徽标整体不渲染
  const envelopeChars = state !== null ? envelopeCharsOf(state) : null
  const coverage = state !== null ? coverageTextOf(state) : null

  // 导出说明文案随当前语言现取；生成/下载全程 try 包住，异常进错误横幅不塌卡
  const exportNotes = (): { top: string; missing: string } => ({
    top: t('exportNoteTop'),
    missing: t('exportSectionMissing'),
  })
  // 单卡导出：文件名 = 编号.md；内容由 state 真有字段生成，缺的段就地注明（inbox-view.ts）
  const exportOne = (p: PendingRow): void => {
    try {
      downloadText(`${p.id}.md`, cardMarkdown(p, exportNotes()))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  // 导出全部：全部待取件拼一个 .md（文件名带导出时刻，避免反复下载互相覆盖）
  const exportAll = (): void => {
    if (state === null || state.pending.length === 0) return
    try {
      downloadText(`handoff-pending-${exportStamp()}.md`, pendingListMarkdown(state.pending, exportNotes()))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  // 导出 HTML 报告：自包含单文件（八家矩阵 + 全部待取件 + 已消费计数；pending 为空也
  // 有矩阵与计数可报，故不随 pending 禁用）。state→html 组装在 buildReportHtml 纯函数，
  // 文案按当前语言现取（reportWords）；文件名带导出时刻，生成失败进错误横幅不塌卡
  const exportHtmlReport = (): void => {
    if (state === null) return
    try {
      const d = new Date()
      downloadText(
        `handoff-report-${exportStamp(d)}.html`,
        buildReportHtml(state, reportWords(lang), lang, absTime(d.toISOString())),
        'text/html;charset=utf-8',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return createElement('div', { className: 'bt-panel', style: themeVars() },
    createElement('style', null, CSS),

    // 头卡：标识 + 刷新
    createElement('div', { className: 'bt-card' },
      createElement('div', { className: 'bt-head' },
        createElement('span', { className: 'bt-logo', dangerouslySetInnerHTML: { __html: ICON_SVG } }),
        createElement('span', null,
          createElement('div', { className: 'bt-title' }, t('appTitle')),
          createElement('div', { className: 'bt-sub' }, t('appSubtitle')),
        ),
        createElement('span', { className: 'bt-spacer' }),
        createElement('button', { className: 'bt-btn', onClick: reload, disabled: busy !== null }, t('refresh')),
      ),
      error !== null ? createElement('div', { className: 'bt-banner bt-banner-err' }, error) : null,
      notice !== null ? createElement('div', { className: 'bt-banner bt-banner-info' }, notice) : null,
    ),

    // 命令速览（直接可见）
    createElement(CommandsCard, { state, t }),

    // 收件箱概览
    createElement('div', { className: 'bt-card' },
      createElement('div', { className: 'bt-head' },
        createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, t('inboxTitle')),
        createElement('span', { className: 'bt-spacer' }),
        createElement('button', {
          className: `bt-btn bt-btn-danger${confirmClear ? ' bt-btn-confirm' : ''}`,
          disabled: busy !== null || archivedCount === 0,
          onClick: clear,
          title: t('clearArchivedTitle'),
        }, confirmClear ? t('clearConfirm', { n: archivedCount }) : t('clearArchived')),
      ),
      // 统计条：四格横排（待取件 / 已消费 / 账本覆盖 / 信封），一个元素一行信息
      state !== null
        ? createElement('div', { className: 'bt-statstrip' },
            createElement('span', {
              className: `bt-stat${(state?.pending.length ?? 0) > 0 ? ' bt-stat-hot' : ''}`,
              title: t('pendingDirHint'),
            }, t('badgePending', { n: state?.pending.length ?? '…' })),
            createElement('span', {
              className: 'bt-stat',
              title: t('archivedDirHint'),
            }, t('badgeArchived', { n: archivedCount })),
            coverage !== null
              ? createElement('span', { className: 'bt-stat', title: t('coverageBadgeTitle') },
                  t('coverageBadge', { v: coverage }))
              : null,
            envelopeChars !== null
              ? createElement('span', { className: 'bt-stat', title: t('envelopeArchived', { n: envelopeChars }) },
                  t('envelopeArchived', { n: envelopeChars }))
              : null,
            (state?.pendingDuplicates ?? 0) > 0
              ? createElement('span', { className: 'bt-stat bt-stat-warn', title: t('pendingDupTitle') },
                  t('pendingDupChip', { n: state.pendingDuplicates }))
              : null,
          )
        : null,
      // 工具行：即时过滤 + 导出全部 + 导出 HTML 报告
      state !== null
        ? createElement('div', { className: 'bt-inbox-toolbar' },
            createElement('input', {
              className: 'bt-filter',
              type: 'search',
              value: query,
              placeholder: t('filterPlaceholder'),
              'aria-label': t('filterAria'),
              title: t('filterAria'),
              onChange: (e: { target: { value: string } }) => { setQuery(e.target.value) },
            }),
            createElement('button', {
              className: 'bt-btn',
              disabled: state.pending.length === 0,
              onClick: exportAll,
              title: t('exportAllTitle'),
            }, t('exportAll')),
            createElement('button', {
              className: 'bt-btn',
              onClick: exportHtmlReport,
              title: t('exportHtmlTitle'),
            }, t('exportHtml')),
          )
        : null,
      state !== null
        ? createElement(PendingList, {
            rows: state.pending,
            query,
            home: state.home,
            t,
            lang,
            onExport: exportOne,
            onChainFilter: (id: string) => { setQuery(id) },
            onTakeInbox: takeInbox,
            takeBusyId,
          })
        : createElement('div', { className: 'bt-sub' }, t('loading')),
    ),

    // 外部会话浏览器（浏览 + 一键投递；卡片蒸馏仍在会话里由模型完成）
    createElement(ForeignBrowser, { state, t, lang, onError: (msg) => setError(msg), onNotice: showNotice }),

    // 支持矩阵
    createElement('div', { className: 'bt-card' },
      createElement('div', { className: 'bt-head' },
        createElement('span', { className: 'bt-title', style: { fontSize: 13 } }, t('matrixTitle')),
      ),
      state !== null
        ? createElement(ProviderMatrix, { rows: state.providers, busy, onToggle: toggle, t })
        : createElement('div', { className: 'bt-sub' }, t('loading')),
      createElement('details', { className: 'bt-note' },
        createElement('summary', null, t('noteSummary')),
        createElement('div', { className: 'bt-note-body' }, t('noteBody'))),
    ),
  )
}

export function apply(ctx: Context): void {
  // 防御：宿主若没有 slots 服务（SlotRegistry 形态不符）只告警降级，
  // 不把整个客户端插件树拖崩。
  const slots: unknown = ctx.slots
  if (
    slots === null || typeof slots !== 'object'
    || typeof (slots as { inject?: unknown }).inject !== 'function'
    || typeof (slots as { register?: unknown }).register !== 'function'
  ) {
    console.warn('[dsh-takeover] 宿主未提供可用的 slots 服务（需要 @deepseek-ai/dsh-client-ui-renderer），设置卡跳过挂载')
    return
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'dsh-takeover', order: 42, label: 'dsh-takeover' },
    () => {
      const t = makeT(ctx)
      return createElement(PanelBoundary, {
        t,
        children: createElement(Panel, { t, locale: resolveLocale(ctx) }),
      })
    },
  ))
}
