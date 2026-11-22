/**
 * 配置写回最小闭环（0.2.x）：handoff_env action=inject——把备份包内的
 * `.mcp.json`（MCP servers 事实标准形态）与 `.agents/skills/**`（用户 skills
 * 事实标准目录）两类条目**合并**进目标 harness 的对应配置。
 *
 * 映射面（事实标准可映射的才做；其余明确不做并如实标注——hooks/权限/插件登记
 * 语义不等价，绝不半吊子映射）：
 * - MCP：目标闭集 = INJECT_TARGETS 里带 mcp 映射的家（JSON 配置 + mcpServers 键）。
 *   Codex 的 MCP 配置是 config.toml（TOML），JSON 合并语义不等价——明确不做。
 * - skills：目标闭集 = 带 skills 映射的家（用户级 skills 目录惯例）。
 *
 * 值消毒（0.26 扩展，仅 gemini 行——上游口径来自实现期实抓的 gemini-cli 源码/文档，
 * 其余 harness 材料缺失不假造，经 InjectTargetDef.mcpSanitize/skillGate 按行声明）：
 * - `$VAR`/`${VAR}`/`${VAR:-DEF}` 上游两级展开（settings 加载全对象一次展开 + MCP 连接期对
 *   env/headers 再展开、Windows 另展开 `%VAR%`）——写值预解析成终态（落盘即不被再展开），
 *   引用解析不出（未定义且无默认）的 server 整条 skip 并如实报告；
 * - server 别名禁下划线（工具 FQN `mcp_<别名>_<工具>` 按首个下划线切分，策略引擎会误判
 *   server 身份——上游文档明文告诫）；
 * - timeout 以毫秒 number 写入（上游 schema 口径；数字字符串原样转 number，非数字单位无
 *   出处不代换）；
 * - SKILL.md 写回前按上游 skillLoader 口径校验 frontmatter name/description（零依赖按上游
 *   兜底行解析实现——放行集是上游可发现集的子集，宁 skip 不写坏）；
 * - 写回后按上游 schemas/settings.schema.json 派生最小结构校验（增强非闸：不符只报告不回滚）。
 *
 * 安全纪律（THREAT-MODEL T8 · 与 handoff_absorb 同款硬线）：
 * 1. confirm 两步强制：缺 confirm 一律拒绝，并把「将写什么」逐条列出回显；
 * 2. 只新增不覆盖：同名 MCP server / 已存在的 skill 文件一律跳过（同内容 skip-same、
 *    不同内容 skip-conflict），用户既有配置永不被本动作改写值；
 * 3. 既有配置文件被修改（新增键）前，原物快照进 env-backup/restore-checkpoint-inject-*
 *    （checkpoint-manifest.json 与 applyRestore 同款）——handoff_env action=rollback
 *    一键回滚，零新增回滚通路；
 * 4. 落盘全部 tmp+rename 原子替换；写后 lifecycle 记 config-injected 事件留痕；
 * 5. 目标路径来自注册表闭集（无自由路径入参），会话存储路径段结构守门与 absorb 同款。
 *
 * 源条目经 readBackupEntryBlobs 从加密备份包读取（错口令 = GCM 认证失败诚实报错）；
 * 内容密钥闸在备份时已扫（packEncrypted 对非凭据类配置 secretscan 计数），与本插件
 * 的整包还原（applyRestore）同口径——inject 是用户自己的加密备份的恢复路径之一。
 * @module dsh-takeover/configinject
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { recordLifecycleEvent } from './lifecycle.ts'
import { envBackupDir, listBackups, readBackupEntryBlobs, validateRelPath } from './envbackup.ts'

/** inject 依赖注入（测试用：dir=HANDOFF_HOME、home=user home、now=事件时刻；
 * env=值消毒用的环境快照（缺省取当前 process.env 的字符串键值——inject 在目标机执行，
 * 该环境即 gemini 启动时将看到的口径）；winEnvExpand=是否按 Windows 口径消毒 %VAR%
 * （缺省 process.platform==='win32'——上游仅 Windows 在 MCP 连接期展开 %VAR%）） */
export interface InjectDeps {
  dir?: string
  home?: string
  now?: Date
  env?: Record<string, string>
  winEnvExpand?: boolean
}

/** MCP 合并目标：JSON 配置路径 + 服务器表键名（事实标准均为 mcpServers） */
export interface InjectMcpMapping {
  path: (home: string) => string
  key: 'mcpServers'
}

/** inject 目标定义：映射缺省 = 该家该项明确不做（limits 里如实标注原因） */
export interface InjectTargetDef {
  key: string
  agent: string
  /** MCP 合并目标；undefined = 无等价映射，明确不做 */
  mcp?: InjectMcpMapping
  /** 用户级 skills 目录目标；undefined = 无公开惯例，明确不做 */
  skills?: (home: string) => string
  /** mcpServers 值消毒三条 + 写后 schema 派生校验（上游口径按行声明——目前只有 gemini 行，
   *  其余家上游行为未调研不假造）。undefined = 不消毒，保持 0.25 既有合并语义 */
  mcpSanitize?: boolean
  /** SKILL.md frontmatter name/description 写回前闸（上游 skillLoader 口径按行声明——
   *  claude/zcode 的 skill 装载口径未调研，不假造套用）。undefined = 不设闸 */
  skillGate?: boolean
  /** 不做项的诚实标注（渲染给模型/用户看） */
  limits: string
}

/**
 * 配置写回目标注册表（事实标准口径，路径全部可注入测试）：
 * - claude：MCP 用户级在 ~/.claude.json 顶层 mcpServers；用户 skills 目录 ~/.claude/skills。
 * - cursor：MCP 全局在 ~/.cursor/mcp.json；skills 无用户级目录公开惯例——不做。
 * - gemini：MCP 在 ~/.gemini/settings.json 的 mcpServers；skills 写用户级主名 ~/.gemini/skills/
 *   （上游 Storage.getUserSkillsDir；别名 ~/.agents/skills 是发现侧兼容、skillManager 后加载
 *   且同名优先——写回走主名避免歧义，主名必被发现），项目级 .gemini/skills/ 不做（inject 是
 *   用户级备份恢复通路）；该行带 mcpSanitize + skillGate（上游口径见模块头）。
 * - codex：MCP 是 ~/.codex/config.toml（TOML），与 { mcpServers } JSON 合并语义不等价——
 *   不做；skills 无公开惯例——不做。
 * - zcode：用户 skills 即 ~/.agents/skills 事实标准目录（源即目标，注入天然幂等去重）；
 *   MCP 无与 .mcp.json 等价的公开 JSON 映射——不做。
 * hooks / 权限 / 插件登记：语义不等价，任何一家都明确不做（T8 硬线）。
 */
export const INJECT_TARGETS: readonly InjectTargetDef[] = [
  {
    key: 'claude',
    agent: 'Claude Code',
    mcp: { path: (h) => join(h, '.claude.json'), key: 'mcpServers' },
    skills: (h) => join(h, '.claude', 'skills'),
    limits: 'hooks/权限语义不等价，不做',
  },
  {
    key: 'cursor',
    agent: 'Cursor',
    mcp: { path: (h) => join(h, '.cursor', 'mcp.json'), key: 'mcpServers' },
    limits: 'skills 无用户级目录公开惯例，不做；hooks/规则语义不等价，不做',
  },
  {
    key: 'gemini',
    agent: 'Gemini CLI',
    mcp: { path: (h) => join(h, '.gemini', 'settings.json'), key: 'mcpServers' },
    skills: (h) => join(h, '.gemini', 'skills'),
    mcpSanitize: true,
    skillGate: true,
    limits: 'hooks/权限语义不等价，不做；skills 只写用户级主名 ~/.gemini/skills/（上游 Storage.getUserSkillsDir；别名 ~/.agents/skills 为发现侧兼容不写），项目级不做',
  },
  {
    key: 'codex',
    agent: 'Codex CLI',
    limits: 'MCP 配置是 config.toml（TOML），与 { mcpServers } JSON 合并语义不等价——不做；skills 无公开惯例——不做',
  },
  {
    key: 'zcode',
    agent: 'ZCode',
    skills: (h) => join(h, '.agents', 'skills'),
    limits: 'MCP 无与 .mcp.json 等价的公开 JSON 映射，不做',
  },
]

/** 会话存储路径段黑名单（与 absorb.ts 同款结构守门：注册表解析出的路径命中即拒） */
const SESSION_STORE_SEGMENTS = new Set(['projects', 'sessions', 'storages', 'session-store', 'history'])

function assertNotSessionStore(p: string): void {
  const segs = p.split(/[\\/]/).map((s) => s.toLowerCase())
  for (const seg of segs) {
    if (SESSION_STORE_SEGMENTS.has(seg)) {
      throw new Error(`写回目标命中会话存储路径段（${seg}）——外部 harness 的会话存储永不写（T8 硬线），注册表配置有误`)
    }
  }
}

/** 规范错误（absorb.ts 同款本地简版） */
function readable(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return `文件系统错误（${code}）：${e.message}`
    return e.message
  }
  return String(e)
}

/** 稳定序列化（键排序）：MCP server 配置的 same/conflict 判定用——键序差异不算不同 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** inject 参数（工具面与核心函数共用） */
export interface InjectArgs {
  /** 备份文件名（.dshenv）；缺省取最近一次 */
  file?: string
  passphrase?: string
  target?: string
  confirm?: boolean
}

/** 计划单条：kind=动作面，action=add/create=将写入、skip-same/skip-conflict=明确不写 */
export interface InjectPlanItem {
  kind: 'mcp' | 'skill'
  /** mcp=server 名；skill=包内相对路径 */
  name: string
  action: 'add' | 'create' | 'skip-same' | 'skip-conflict'
  /** 目标绝对路径（将写入处 / 冲突处） */
  path: string
}

export interface InjectPlan {
  ok: true
  target: string
  agent: string
  /** 备份文件名 */
  file: string
  items: InjectPlanItem[]
  /** MCP 目标配置路径（无映射时缺省） */
  mcpConfigPath?: string
  /** skills 目标目录（无映射时缺省） */
  skillsDir?: string
  /** 诚实标注（源条目存在但目标无映射等） */
  notes: string[]
}

export type InjectPlanResult = InjectPlan | { ok: false; error: string }

/** 解析备份包内源条目 → { mcpServers, skillBlobs }；两样都没有时给诚实错误 */
function loadSourceEntries(file: string, passphrase: string, deps?: InjectDeps): { mcpServers: Record<string, unknown> | null; skills: Array<{ rel: string; content: Buffer }> } {
  const blobs = readBackupEntryBlobs(file, passphrase, deps?.dir, (rel) => rel === '.mcp.json' || rel.startsWith('.agents/skills/'))
  let mcpServers: Record<string, unknown> | null = null
  const skills: Array<{ rel: string; content: Buffer }> = []
  for (const b of blobs) {
    if (b.path === '.mcp.json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(b.content.toString('utf-8'))
      } catch {
        throw new Error('备份包内 .mcp.json 不是合法 JSON——请核对备份内容（inject 不写形态不认识的条目）')
      }
      const servers = (parsed as Record<string, unknown> | null)?.['mcpServers']
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
        throw new Error('备份包内 .mcp.json 缺 mcpServers 对象（形态不认识）——inject 只合并事实标准形态')
      }
      mcpServers = servers as Record<string, unknown>
    } else {
      // 穿越闸（第二道，validateRelPath 归一化后的相对路径才允许拼进 skillsDir）：
      // ..、绝对路径、盘符一律拒收——敌意包的 skills 条目不得越出目标 skills 目录
      const rel = validateRelPath(b.path.slice('.agents/skills/'.length))
      skills.push({ rel, content: b.content })
    }
  }
  return { mcpServers, skills }
}

// ------------------------------------------------------- gemini 行值消毒（0.26 · 上游口径实现期实抓）

/** 上游 envVarResolver.ts 同款展开正则：$VAR / ${VAR} / ${VAR:-DEFAULT}（settings 加载期全对象一次展开） */
const GEMINI_ENVVAR_REGEX = /\$(?:(\w+)|{([^}]+?)(?::-([^}]*))?})/g
/** 上游 envExpansion.ts 同款 Windows 形态：%VAR%（仅 Windows、仅 env/headers 在 MCP 连接期展开） */
const GEMINI_WINVAR_REGEX = /%(\w+)%/g

/** 值消毒的执行口径（deps → 环境快照 + Windows %VAR% 闸） */
interface GeminiSanitizeOpts {
  env: Record<string, string>
  win: boolean
}

function sanitizeOptsOf(deps?: InjectDeps): GeminiSanitizeOpts {
  const env = deps?.env ?? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'))
  return { env, win: deps?.winEnvExpand ?? process.platform === 'win32' }
}

/**
 * 单字符串按上游两级展开口径做一次预解析：可解析 → { value }（落盘即终态，上游两级展开皆空转）；
 * 有引用解析不出 → { unresolved }（整 server skip 的依据）。
 *
 * 语义依据（实现期实抓上游源码，0.69.0/main 双对）：
 * - settings 加载：resolveEnvVarsInObject 对整个 settings 对象一次展开（packages/cli/src/config/
 *   settings.ts:924）；未定义且无默认 → 占位符原样保留（envVarResolver.ts）——对写回即「裸 $ 落盘」，
 *   且环境一变就会被展开，违反「写值规避上游展开」不变量 → 判不可解析；
 * - MCP 连接：env/headers 值再经 dotenv-expand 二次展开（packages/core/src/tools/mcp-client.ts:1015/:2420），
 *   Windows 另把 %VAR% 展开、未定义解析为空串（packages/core/src/utils/envExpansion.ts:28-31）——
 *   未定义 %VAR% 落盘会被静默清空 → 同判不可解析。
 * 转义口径说明：上游无任何转义语法（`\$` 不被两级展开链识别），「按上游口径转义」的唯一落地
 * = 预解析成终态值——与上游启动时用同一环境展开的结果逐字节一致，且此后不再随环境漂移。
 */
function resolveGeminiString(s: string, opts: GeminiSanitizeOpts, winScope: boolean): { value: string; refs: string[] } | { unresolved: string } {
  const refs: string[] = []
  const missing: string[] = []
  let out = s.replace(GEMINI_ENVVAR_REGEX, (match, v1?: string, v2?: string, def?: string): string => {
    const name = v1 ?? v2 ?? ''
    if (name === '') return match
    const val = opts.env[name]
    if (val !== undefined && (val !== '' || def === undefined)) {
      refs.push(`$${name}（${clipVal(match)}）`)
      return val
    }
    if (def !== undefined) {
      refs.push(`$${name}（默认值）`)
      return def
    }
    missing.push(match)
    return match // 上游口径：未定义且无默认原样保留——写回判不可解析（skip 依据）
  })
  if (missing.length > 0) {
    return { unresolved: `${missing.join('、')} 在目标机当前环境未定义且无默认值` }
  }
  if (out.match(GEMINI_ENVVAR_REGEX) !== null) {
    // 预解析结果仍含 $ 引用（如默认值里嵌 $B）——上游加载期还会再展开，落盘非终态
    return { unresolved: `解析后仍含 $ 引用（${clipVal(out)}）` }
  }
  if (winScope && opts.win) {
    out = out.replace(GEMINI_WINVAR_REGEX, (match, name: string): string => {
      const val = opts.env[name]
      if (val !== undefined) {
        refs.push(`%${name}%`)
        return val
      }
      return match // 交由下方复扫判不可解析（上游会解析为空串——静默清空不可接受）
    })
    const leftover = out.match(GEMINI_WINVAR_REGEX)
    if (leftover !== null) {
      return { unresolved: `${leftover[0]} 在目标机当前环境未定义（上游 Windows 口径会展开为空串——静默清空不可接受）` }
    }
  }
  return { value: out, refs }
}

/** 展开引用的出处标注（值本身可能超长，截到 40 字符） */
function clipVal(v: string): string {
  const t = v.length > 40 ? `${v.slice(0, 40)}…` : v
  return JSON.stringify(t)
}

export type GeminiServerSanitize =
  | { ok: true; value: Record<string, unknown>; resolved: string[] }
  | { ok: false; reason: string }

/**
 * gemini 行单条 MCP server 配置消毒：别名闸（下划线/空）→ timeout 毫秒形态 → 深走值预解析。
 * 任何一条不满足 → 整 server skip（只新增不覆盖纪律下，改写/丢弃字段都等于动用户配置——
 * 与「配置不是对象跳过」同款按条跳过并报告）。
 */
export function sanitizeGeminiMcpServer(alias: string, cfg: unknown, opts: GeminiSanitizeOpts): GeminiServerSanitize {
  // 别名闸：FQN mcp_<别名>_<工具> 按首个下划线切分（docs/reference/policy-engine.md 明文告诫
  // 「Do not use underscores in your MCP server names」——下划线别名会让策略引擎误判 server 身份，
  // 通配规则与安全策略静默失效）；空别名上游 FQN 解析为空 server 组件（tool-names.ts 显式拒绝）同拒。
  // 不静默改名——别名是用户配置身份，改名即越权。
  if (alias === '') return { ok: false, reason: '别名为空（上游工具 FQN 解析不出 server 组件）' }
  if (alias.includes('_')) return { ok: false, reason: `别名含下划线——上游工具 FQN mcp_<别名>_<工具> 按首个下划线切分，策略引擎会误判 server 身份（上游文档明文告诫）` }
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, reason: '配置不是对象，形态不认识' }

  const resolved: string[] = []
  const src = cfg as Record<string, unknown>

  // timeout 毫秒形态（上游 schemas/settings.schema.json:4114-4116「Timeout in milliseconds」type=number；
  // docs/tools/mcp-server.md「Request timeout in milliseconds (default: 600,000ms)」——单位口径有出处，
  // 示例值材料截断未到手，故只做形态合规不做任何单位换算/示例编造）：
  // number 原样；纯数字字符串原数字转 number（形态合规，不换算单位）；其余（"30s" 等）skip。
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === 'timeout' && v !== undefined) {
      if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; continue }
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
        out[k] = Number(v)
        resolved.push(`timeout ${JSON.stringify(v)}→${Number(v)}（毫秒 number 形态，数字原样不换算）`)
        continue
      }
      return { ok: false, reason: `timeout 值 ${JSON.stringify(v)} 不是毫秒数字——上游 schema 口径 timeout 为毫秒 number，单位换算无出处不代做` }
    }
    out[k] = v
  }

  // 值深走预解析：$ 形态全字段；%VAR% 仅 env/headers 子树且仅 Windows 口径（上游连接期只对这两块
  // 做 dotenv-expand + %VAR% 预处理；settings 加载期虽全对象展开 $，但 % 只在连接期——scope 忠实上游）
  const walk = (v: unknown, path: string, winScope: boolean): { ok: true; value: unknown } | { ok: false; reason: string } => {
    if (typeof v === 'string') {
      const r = resolveGeminiString(v, opts, winScope)
      if ('unresolved' in r) return { ok: false, reason: `${path} 的 ${r.unresolved}——落盘会被上游展开/静默清空，inject 不写不可解析值（如为有意透传请手写在目标配置）` }
      for (const ref of r.refs) resolved.push(`${path}=${ref}`)
      return { ok: true, value: r.value }
    }
    if (Array.isArray(v)) {
      const arr: unknown[] = []
      for (let i = 0; i < v.length; i++) {
        const r = walk(v[i], `${path}[${i}]`, winScope)
        if (!r.ok) return r
        arr.push(r.value)
      }
      return { ok: true, value: arr }
    }
    if (v !== null && typeof v === 'object') {
      const obj: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        // 上游只展开值不展开键（resolveEnvVarsInObject 逐键 resolve 值）——键名原样保留
        const sub = winScope || k === 'env' || k === 'headers'
        const r = walk(val, path === '' ? k : `${path}.${k}`, sub)
        if (!r.ok) return r
        obj[k] = r.value
      }
      return { ok: true, value: obj }
    }
    return { ok: true, value: v }
  }
  const w = walk(out, '', false)
  if (!w.ok) return { ok: false, reason: w.reason }
  return { ok: true, value: w.value as Record<string, unknown>, resolved }
}

/** gemini 行整表消毒：逐条 sanitize，skip 条目进 notes（与「配置不是对象跳过」同款按条报告） */
export function sanitizeGeminiMcpTable(servers: Record<string, unknown>, opts: GeminiSanitizeOpts): { table: Record<string, unknown>; notes: string[] } {
  const table: Record<string, unknown> = {}
  const notes: string[] = []
  for (const [alias, cfg] of Object.entries(servers)) {
    const r = sanitizeGeminiMcpServer(alias, cfg, opts)
    if (!r.ok) {
      notes.push(`MCP server「${alias}」${r.reason}，跳过`)
      continue
    }
    if (r.resolved.length > 0) notes.push(`MCP server「${alias}」${r.resolved.length} 处 $/% 引用已按目标机当前环境预解析写入（落盘即终态，上游启动/连接期展开不再生效）：${r.resolved.join('、')}`)
    table[alias] = r.value
  }
  return { table, notes }
}

// ------------------------------------------------------- gemini 行 SKILL.md frontmatter 闸

/** 上游 skillLoader.ts:35-36 FRONTMATTER_REGEX 同款（BOM 容忍 + --- 界定） */
const SKILL_FRONTMATTER_REGEX = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1)
  return value
}

/**
 * SKILL.md frontmatter 闸（上游 packages/core/src/skills/skillLoader.ts parseFrontmatter 口径）：
 * name/description 双 string 取不到 → 上游根本不发现该 skill（loadSkillFromFile 返回 null），
 * 写了也是死文件——「不写坏 skill」的落法是写回前 skip 并如实报告。
 *
 * 零依赖口径说明：上游先 YAML（js-yaml）后兜底简单行解析；本仓零依赖无 YAML 解析器，
 * 按上游兜底行解析实现（逐行 name:/description: 提取、剥外层引号、description 支持续行与
 * >| 块指示符）。关键性质：上游 YAML 分支失败即落到同一套行解析——本闸的放行集 ⊆ 上游
 * 可发现集（凡本闸放行上游必能发现）；仅极端 YAML 形态（YAML 成而行解析不成）会保守 skip，
 * 如实报告优于写坏。注意行解析口径下 `name: 123` 等标量按文本提取为 string——上游兜底口径
 * 同样接受（YAML 分支类型不符后落到行解析），本闸不比上游严。
 */
export function geminiSkillFrontmatterOk(content: string): { ok: true } | { ok: false; reason: string } {
  const m = content.match(SKILL_FRONTMATTER_REGEX)
  if (m === null) return { ok: false, reason: '无 frontmatter（上游 skillLoader 需 --- 界定的 name/description 才发现 skill）' }
  const lines = m[1]?.split(/\r?\n/) ?? []
  let name: string | undefined
  let description: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const nameMatch = line.match(/^[ \t]*name[ \t]*:/i)
    if (nameMatch !== null && name === undefined) {
      name = stripOuterQuotes(line.slice(nameMatch[0].length).trim())
      continue
    }
    const descMatch = line.match(/^([ \t]*)description[ \t]*:/i)
    if (descMatch !== null && description === undefined) {
      const descIndent = descMatch[1]?.length ?? 0
      const firstLine = line.slice(descMatch[0].length).trim()
      const descLines = /^[>|][-+]?$/.test(firstLine) ? [] : [firstLine]
      // 续行：缩进更深、非已知键/注释（上游 parseSimpleFrontmatter 同款判定）
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? ''
        const nextIndent = next.match(/^[ \t]*/)?.[0].length ?? 0
        const isNonEmpty = nextIndent < next.length
        const isKnownKey = /^[ \t]*(?:name|description)[ \t]*:/i.test(next)
        const isComment = /^[ \t]*#/.test(next)
        const isOtherKey = nextIndent <= descIndent && /^[ \t]*[a-zA-Z0-9_-]+[ \t]*:/.test(next)
        if (isNonEmpty && !isKnownKey && !isComment && !isOtherKey) {
          descLines.push(next.trim())
          i++
        } else break
      }
      description = stripOuterQuotes(descLines.filter(Boolean).join(' '))
      continue
    }
  }
  if (name === undefined || description === undefined) return { ok: false, reason: 'frontmatter 取不到 name/description 双 string 键（上游 skillLoader 口径不发现该 skill）' }
  return { ok: true }
}

/**
 * gemini 行 skills 整树闸：skill = 目录 + 可被上游发现的 SKILL.md（上游 glob 只认根级与一级
 * 子目录的 SKILL.md）。分组规则：rel 首段为组；组内 SKILL.md 闸判定全组去留——
 * - SKILL.md 闸不过 → 整目录跳过（skill 无有效入口，只写资源文件是死字节）；
 * - 组内无一级 SKILL.md → 整目录跳过（上游不发现，同上）；
 * - 根级散文件（无目录的 rel）原样放行（上游本就不解析它们，写回无害，与既有只新增语义一致）。
 */
export function gateGeminiSkills(entries: Array<{ rel: string; content: Buffer }>): { keep: Array<{ rel: string; content: Buffer }>; notes: string[] } {
  const groups = new Map<string, Array<{ rel: string; content: Buffer }>>()
  for (const e of entries) {
    const i = e.rel.indexOf('/')
    const g = i === -1 ? '' : e.rel.slice(0, i)
    const list = groups.get(g) ?? []
    list.push(e)
    groups.set(g, list)
  }
  const keep: Array<{ rel: string; content: Buffer }> = []
  const notes: string[] = []
  for (const [g, list] of groups) {
    if (g === '') {
      // 根组：仅根级 SKILL.md 是 skill 入口需闸；其余散文件放行
      for (const e of list) {
        if (e.rel === 'SKILL.md') {
          const r = geminiSkillFrontmatterOk(e.content.toString('utf-8'))
          if (r.ok) keep.push(e)
          else notes.push(`根级 SKILL.md ${r.reason}，跳过`)
        } else keep.push(e)
      }
      continue
    }
    const entryMd = list.find((e) => e.rel === `${g}/SKILL.md`)
    if (entryMd === undefined) {
      notes.push(`skill「${g}」无一级 SKILL.md——上游只发现根级与一级子目录的 SKILL.md，整目录跳过 ${list.length} 个文件`)
      continue
    }
    const r = geminiSkillFrontmatterOk(entryMd.content.toString('utf-8'))
    if (r.ok) keep.push(...list)
    else notes.push(`skill「${g}」SKILL.md ${r.reason}，整目录跳过 ${list.length} 个文件`)
  }
  return { keep, notes }
}

// ------------------------------------------------------- 写后 schema 派生校验（增强非闸）

/** 上游 schemas/settings.schema.json $defs/MCPServerConfig 的字段闭集（2026-11-19 实抓 main，
 * additionalProperties:false——未知字段上游 Zod 校验告警并 coerce 剥除） */
const SCHEMA_MCP_FIELDS: Record<string, 'string' | 'boolean' | 'number' | 'stringArray' | 'stringRecord' | 'object'> = {
  command: 'string', url: 'string', httpUrl: 'string', cwd: 'string', description: 'string',
  authProviderType: 'string', targetAudience: 'string', targetServiceAccount: 'string', tcp: 'string', type: 'string',
  trust: 'boolean', timeout: 'number',
  args: 'stringArray', includeTools: 'stringArray', excludeTools: 'stringArray',
  env: 'stringRecord', headers: 'stringRecord',
  oauth: 'object', extension: 'object',
}

/**
 * 写回后结构校验（增强非闸）：按实现期实抓的上游 schemas/settings.schema.json 派生的最小
 * 结构契约——非完整 JSON Schema 校验、无网络依赖（schema 随上游演进而变时以「只新增不覆盖 +
 * checkpoint 可回滚」为降级面）。返回不符描述列表（空 = 通过）；只报告不回滚、不拒写。
 */
export function schemaCheckMcpServer(cfg: unknown): string[] {
  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) return ['配置不是对象']
  const src = cfg as Record<string, unknown>
  const viols: string[] = []
  for (const [k, v] of Object.entries(src)) {
    const kind = SCHEMA_MCP_FIELDS[k]
    if (kind === undefined) {
      viols.push(`字段 ${k} 不在上游 schema 闭集（MCPServerConfig additionalProperties:false，上游会告警并剥除）`)
      continue
    }
    if (kind === 'string' && typeof v !== 'string') viols.push(`字段 ${k} 应为 string，实际 ${typeof v}`)
    else if (kind === 'boolean' && typeof v !== 'boolean') viols.push(`字段 ${k} 应为 boolean，实际 ${typeof v}`)
    else if (kind === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) viols.push(`字段 ${k} 应为 number，实际 ${typeof v}`)
    else if (kind === 'stringArray' && (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))) viols.push(`字段 ${k} 应为 string[]，实际形态不符`)
    else if (kind === 'stringRecord' && (v === null || typeof v !== 'object' || Array.isArray(v) || !Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string'))) viols.push(`字段 ${k} 应为 { [k]: string }，实际形态不符`)
    else if (kind === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) viols.push(`字段 ${k} 应为 object，实际 ${typeof v}`)
  }
  if (src['command'] === undefined && src['url'] === undefined && src['httpUrl'] === undefined) {
    viols.push('缺 command/url/httpUrl 任一传输字段（上游运行时无法建立连接）')
  }
  return viols
}

/**
 * 注入预演（纯读零写盘）：目标闭集校验 → 源条目解密读取 → 逐条比对出计划。
 * planInject 的任何失败都回 { ok: false, error }；成功返回逐条计划（add/create 才会写）。
 */
export function planInject(args: InjectArgs, deps?: InjectDeps): InjectPlanResult {
  try {
    const targetKey = (args.target ?? '').trim()
    const def = INJECT_TARGETS.find((t) => t.key === targetKey)
    if (def === undefined) {
      const keys = INJECT_TARGETS.map((t) => t.key).join(' / ')
      return { ok: false, error: `未知 inject target：${targetKey}（注册表只有 ${keys}；会话存储路径不是合法目标——外部会话存储永不写）` }
    }
    const passphrase = typeof args.passphrase === 'string' ? args.passphrase : ''
    if (passphrase.length < 8) {
      return { ok: false, error: '口令至少 8 位（读加密备份清单必需；口令永不落盘）' }
    }
    const explicit = typeof args.file === 'string' ? args.file.trim().split('\\').join('/').split('/').pop() ?? '' : ''
    const name = explicit !== '' ? explicit : (listBackups(deps?.dir)[0]?.file ?? '')
    if (name === '') {
      return { ok: false, error: '没有可注入的环境备份：先 handoff_env action=backup 生成 .dshenv 加密包' }
    }
    const { mcpServers, skills } = loadSourceEntries(name, passphrase, deps)
    if (mcpServers === null && skills.length === 0) {
      return { ok: false, error: '备份包里没有可注入的条目（缺 .mcp.json 与 .agents/skills/**）——旧备份先重新 backup' }
    }
    const home = deps?.home ?? homedir()
    const items: InjectPlanItem[] = []
    const notes: string[] = []
    let mcpConfigPath: string | undefined
    let skillsDir: string | undefined

    // MCP 面：逐 server 比对（只新增；同名跳过——同内容 skip-same，不同值 skip-conflict 不覆盖）
    if (def.mcp !== undefined) {
      mcpConfigPath = def.mcp.path(home)
      assertNotSessionStore(mcpConfigPath)
      if (mcpServers !== null) {
        // 值消毒先行（gemini 行声明）：消毒后的表才是「将写入的值」——same/conflict 判定、
        // 落盘值都用它（同名同消毒值 = skip-same，二次 inject 幂等）；skip 条目进 notes
        let effective = mcpServers
        if (def.mcpSanitize === true) {
          const san = sanitizeGeminiMcpTable(mcpServers, sanitizeOptsOf(deps))
          notes.push(...san.notes)
          effective = san.table
        }
        let current: Record<string, unknown> = {}
        try {
          const st = statSync(mcpConfigPath)
          if (st.isFile()) {
            const parsed: unknown = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'))
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return { ok: false, error: `目标配置 ${mcpConfigPath} 顶层不是 JSON 对象——inject 不写形态不认识的文件，请人工核对` }
            }
            current = parsed as Record<string, unknown>
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            return { ok: false, error: `目标配置 ${mcpConfigPath} 解析失败（${e.message}）——inject 不合并进解析不了的文件，请先人工修复` }
          }
          // 文件不存在：全新建（current 保持空对象）
        }
        const table = (current[def.mcp.key] !== undefined && typeof current[def.mcp.key] === 'object' && current[def.mcp.key] !== null && !Array.isArray(current[def.mcp.key]))
          ? current[def.mcp.key] as Record<string, unknown>
          : {}
        for (const [server, cfg] of Object.entries(effective)) {
          // 非消毒行（claude/cursor）保持 0.25 语义：非对象形态按条跳过；消毒行（gemini）
          // 该情况已在 sanitizeGeminiMcpTable 内 skip 并进 notes，此分支天然不触发
          if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
            notes.push(`MCP server ${server} 配置不是对象，跳过（形态不认识）`)
            continue
          }
          const targetPath = mcpConfigPath
          const have = table[server]
          if (have === undefined) items.push({ kind: 'mcp', name: server, action: 'add', path: targetPath })
          else if (stableStringify(have) === stableStringify(cfg)) items.push({ kind: 'mcp', name: server, action: 'skip-same', path: targetPath })
          else items.push({ kind: 'mcp', name: server, action: 'skip-conflict', path: targetPath })
        }
      }
    } else if (mcpServers !== null) {
      notes.push(`${def.agent} 无 MCP 等价映射（${def.limits}）——备份里的 .mcp.json 条目不注入`)
    }

    // skills 面：逐文件比对（只新建；已存在一律跳过——同内容 skip-same，不同内容 skip-conflict 不覆盖）
    if (def.skills !== undefined) {
      skillsDir = def.skills(home)
      assertNotSessionStore(skillsDir)
      // frontmatter 闸先行（gemini 行声明）：上游发现不了的 skill 写了也是死文件——整组 skip 进 notes
      let effectiveSkills = skills
      if (def.skillGate === true) {
        const gate = gateGeminiSkills(skills)
        notes.push(...gate.notes)
        effectiveSkills = gate.keep
      }
      for (const s of effectiveSkills) {
        const targetPath = join(skillsDir, ...s.rel.split('/'))
        let have: Buffer | undefined
        try {
          const st = statSync(targetPath)
          if (st.isFile()) have = readFileSync(targetPath)
        } catch { /* 目标不存在：将新建 */ }
        if (have === undefined) items.push({ kind: 'skill', name: s.rel, action: 'create', path: targetPath })
        else if (have.equals(s.content)) items.push({ kind: 'skill', name: s.rel, action: 'skip-same', path: targetPath })
        else items.push({ kind: 'skill', name: s.rel, action: 'skip-conflict', path: targetPath })
      }
    } else if (skills.length > 0) {
      notes.push(`${def.agent} 无用户级 skills 目录映射（${def.limits}）——备份里的 skills 条目不注入`)
    }

    const writable = items.filter((i) => i.action === 'add' || i.action === 'create')
    if (writable.length === 0 && items.length === 0) {
      if (notes.length > 0) {
        return { ok: false, error: `${def.agent} 无可写入条目——${notes.join('；')}（本次明确不做，不写任何盘）` }
      }
      return { ok: false, error: `${def.agent} 无可注入的等价映射（${def.limits}）——本次明确不做，不写任何盘` }
    }
    return { ok: true, target: targetKey, agent: def.agent, file: name, items, ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}), ...(skillsDir !== undefined ? { skillsDir } : {}), notes }
  } catch (e) {
    return { ok: false, error: readable(e) }
  }
}

/** 计划 → 逐条人读文本（confirm 缺省拒绝时整段回显） */
export function renderInjectPlan(plan: InjectPlan): string {
  const lines = [
    `inject 预演（目标 ${plan.agent}，备份 ${plan.file}）——将写入：`,
    ...plan.items.filter((i) => i.action === 'add').map((i) => `  + MCP server「${i.name}」→ ${i.path}`),
    ...plan.items.filter((i) => i.action === 'create').map((i) => `  + skill 文件 ${i.name} → ${i.path}`),
    ...plan.items.filter((i) => i.action === 'skip-same').map((i) => `  = ${i.kind === 'mcp' ? `MCP server「${i.name}」` : i.name} 内容相同，跳过`),
    ...plan.items.filter((i) => i.action === 'skip-conflict').map((i) => `  ! ${i.kind === 'mcp' ? `MCP server「${i.name}」` : i.name} 与目标现存不同——只新增不覆盖，跳过`),
    ...plan.notes.map((n) => `  （${n}）`),
  ]
  return lines.join('\n')
}

export type InjectResult =
  | {
      ok: true
      action: 'inject'
      target: string
      agent: string
      file: string
      /** 新增的 MCP server 名列表 */
      mcpAdded: string[]
      /** 跳过的 MCP server 数（同名同内容 + 同名冲突） */
      mcpSkipped: number
      /** 新建的 skill 文件相对路径列表 */
      skillsCreated: string[]
      /** 跳过的 skill 文件数 */
      skillsSkipped: number
      /** 既有配置被改写前的 checkpoint 目录名（回滚入口）；无既有文件被改时缺省 */
      checkpointDir?: string
      detail: string
    }
  | { ok: false; error: string }

/**
 * 注入执行：先预演出计划 → confirm 闸（缺 confirm 一律拒绝并回显逐条计划，零写盘）
 * → 既有 MCP 配置文件原物快照进 restore-checkpoint-inject-*（rollback 可回滚）
 * → MCP 合并（tmp+rename）+ skill 文件新建（tmp+rename）→ config-injected 留痕。
 * 只新增不覆盖：任何与目标现存内容不同的条目都跳过并在结果里如实报告。
 */
export function applyInject(args: InjectArgs, deps?: InjectDeps): InjectResult {
  try {
    const plan = planInject(args, deps)
    if (!plan.ok) return plan
    if (args.confirm !== true) {
      return {
        ok: false,
        error: [
          'inject 是覆盖性写回动作：两步确认强制——确认下面计划无误后带 confirm: true 重试。本调用未写任何盘。',
          renderInjectPlan(plan),
        ].join('\n'),
      }
    }
    const def = INJECT_TARGETS.find((t) => t.key === plan.target)!
    const home = deps?.home ?? homedir()
    const { mcpServers, skills } = loadSourceEntries(plan.file, args.passphrase ?? '', deps)
    // 与 planInject 同一套消毒（同一次调用的环境快照一致）：写盘值必须用消毒后的终态——
    // 计划里 add 条目的 same/conflict 判定基于消毒值，写裸值会让「计划与落盘不一致」
    const effectiveMcp = (def.mcpSanitize === true && mcpServers !== null)
      ? sanitizeGeminiMcpTable(mcpServers, sanitizeOptsOf(deps)).table
      : mcpServers

    let checkpointDir: string | undefined
    const mcpAdded: string[] = []
    const skillsCreated: string[] = []
    let mcpSkipped = 0
    let skillsSkipped = 0

    // MCP 合并：读现文件 → 只把 add 项并进 mcpServers 表 → tmp+rename 写回
    const adds = plan.items.filter((i) => i.action === 'add')
    if (def.mcp !== undefined && adds.length > 0 && mcpServers !== null) {
      const cfgPath = def.mcp.path(home)
      let doc: Record<string, unknown> = {}
      let docExisted = false
      try {
        const parsed: unknown = JSON.parse(readFileSync(cfgPath, 'utf-8'))
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          doc = parsed as Record<string, unknown>
          docExisted = true
        }
      } catch { /* 预演已挡解析失败/形态不认识；此处兜底按新建 */ }
      const table = (doc[def.mcp.key] !== undefined && typeof doc[def.mcp.key] === 'object' && doc[def.mcp.key] !== null && !Array.isArray(doc[def.mcp.key]))
        ? doc[def.mcp.key] as Record<string, unknown>
        : {}
      for (const item of adds) {
        const cfg = effectiveMcp?.[item.name]
        if (cfg === undefined) continue // 预演到执行之间包内容不可能变（同一次解密）；防御式跳过
        table[item.name] = cfg
        mcpAdded.push(item.name)
      }
      doc[def.mcp.key] = table
      if (docExisted) {
        // 写前快照：原物进 checkpoint（与 applyRestore 同款布局，action=rollback 直接可回滚）。
        // 同一分钟两次 inject 不覆盖既有 checkpoint——撞名时尾缀递增取空位，
        // 保留的永远是第一次写入前的原物（与 absorb 快照「首写不被覆盖」同纪律）
        const stamp = (deps?.now ?? new Date()).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
        const backupDir = envBackupDir(deps?.dir)
        let ckptName = `restore-checkpoint-inject-${stamp}`
        for (let n = 2; existsSync(join(backupDir, ckptName)); n++) ckptName = `restore-checkpoint-inject-${stamp}-${n}`
        const ckpt = join(backupDir, ckptName)
        const relToHome = cfgPath.slice(home.length).split('\\').join('/').replace(/^[/\\]/, '')
        const cAbs = join(ckpt, relToHome)
        mkdirSync(dirname(cAbs), { recursive: true })
        copyFileSync(cfgPath, cAbs)
        writeFileSync(join(ckpt, 'checkpoint-manifest.json'), JSON.stringify({ at: (deps?.now ?? new Date()).toISOString(), from: `inject:${plan.file}`, overwritten: [relToHome] }, null, 2), 'utf-8')
        checkpointDir = join('env-backup', ckptName)
      }
      mkdirSync(dirname(cfgPath), { recursive: true })
      const tmp = `${cfgPath}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8')
      renameSync(tmp, cfgPath)
    }
    mcpSkipped = plan.items.filter((i) => i.kind === 'mcp' && (i.action === 'skip-same' || i.action === 'skip-conflict')).length

    // skills 新建：只写 create 项，tmp+rename
    if (def.skills !== undefined && skills.length > 0) {
      const creates = plan.items.filter((i) => i.action === 'create')
      for (const item of creates) {
        const src = skills.find((s) => s.rel === item.name)
        if (src === undefined) continue
        mkdirSync(dirname(item.path), { recursive: true })
        const tmp = `${item.path}.${process.pid}.tmp`
        writeFileSync(tmp, src.content)
        renameSync(tmp, item.path)
        skillsCreated.push(item.name)
      }
    }
    skillsSkipped = plan.items.filter((i) => i.kind === 'skill' && (i.action === 'skip-same' || i.action === 'skip-conflict')).length

    if (mcpAdded.length === 0 && skillsCreated.length === 0) {
      // 消毒 skip 条目（notes）不是计划 item——「未写任何盘」的口径里必须如实点名，否则静默不可见
      const sanitizeTail = plan.notes.length > 0 ? `；${plan.notes.join('；')}` : ''
      return {
        ok: true,
        action: 'inject',
        target: plan.target,
        agent: plan.agent,
        file: plan.file,
        mcpAdded,
        mcpSkipped,
        skillsCreated,
        skillsSkipped,
        detail: `目标已是备份内容或全部条目冲突跳过（只新增不覆盖）：MCP 跳过 ${mcpSkipped}、skills 跳过 ${skillsSkipped}——未写任何盘${sanitizeTail}`,
      }
    }

    // 写后 schema 派生校验（增强非闸，仅消毒行）：只报告不回滚——发现的相符/不符都如实进 detail
    const schemaNotes: string[] = []
    if (def.mcpSanitize === true && mcpAdded.length > 0) {
      const viols = mcpAdded.flatMap((n) => schemaCheckMcpServer(effectiveMcp?.[n]).map((v) => `server「${n}」${v}`))
      schemaNotes.push(viols.length === 0
        ? `schema 派生结构校验（上游 settings.schema.json 实抓快照）：新增 ${mcpAdded.length} 个 server 全部通过`
        : `schema 派生结构校验不符 ${viols.length} 处（增强非闸，已写值未回滚）：${viols.join('；')}`)
    }
    const sanitizeTail = (plan.notes.length > 0 || schemaNotes.length > 0) ? `；${[...plan.notes, ...schemaNotes].join('；')}` : ''

    recordLifecycleEvent({
      stage: 'write',
      reason: 'config-injected',
      target: `inject:${plan.target}`,
      detail: `MCP +${mcpAdded.length}/跳过 ${mcpSkipped}；skills +${skillsCreated.length}/跳过 ${skillsSkipped}；${checkpointDir !== undefined ? `checkpoint ${checkpointDir}` : '无既有文件被改'}`,
    }, deps?.dir, deps?.now)

    return {
      ok: true,
      action: 'inject',
      target: plan.target,
      agent: plan.agent,
      file: plan.file,
      mcpAdded,
      mcpSkipped,
      skillsCreated,
      skillsSkipped,
      ...(checkpointDir !== undefined ? { checkpointDir } : {}),
      detail: [
        `已合并进 ${plan.agent}：MCP 新增 ${mcpAdded.length} 个${mcpAdded.length > 0 ? `（${mcpAdded.join('、')}）` : ''}、skills 新建 ${skillsCreated.length} 个；跳过 MCP ${mcpSkipped}/skills ${skillsSkipped}（同内容或冲突——只新增不覆盖）`,
        checkpointDir !== undefined ? `被改的既有配置原物快照在 ${checkpointDir}（handoff_env action=rollback file=<checkpoint 目录名> 可回滚）` : '无既有文件被改，无需回滚',
      ].join('；') + sanitizeTail,
    }
  } catch (e) {
    return { ok: false, error: readable(e) }
  }
}
