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
import { envBackupDir, listBackups, readBackupEntryBlobs } from './envbackup.ts'

/** inject 依赖注入（测试用：dir=HANDOFF_HOME、home=user home、now=事件时刻） */
export interface InjectDeps {
  dir?: string
  home?: string
  now?: Date
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
  /** 不做项的诚实标注（渲染给模型/用户看） */
  limits: string
}

/**
 * 配置写回目标注册表（事实标准口径，路径全部可注入测试）：
 * - claude：MCP 用户级在 ~/.claude.json 顶层 mcpServers；用户 skills 目录 ~/.claude/skills。
 * - cursor：MCP 全局在 ~/.cursor/mcp.json；skills 无用户级目录公开惯例——不做。
 * - gemini：MCP 在 ~/.gemini/settings.json 的 mcpServers；skills 无公开惯例——不做。
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
    limits: 'skills 无公开惯例，不做；hooks/权限语义不等价，不做',
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
      skills.push({ rel: b.path.slice('.agents/skills/'.length), content: b.content })
    }
  }
  return { mcpServers, skills }
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
        for (const [server, cfg] of Object.entries(mcpServers)) {
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
      for (const s of skills) {
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
        const cfg = mcpServers[item.name]
        if (cfg === undefined) continue // 预演到执行之间包内容不可能变（同一次解密）；防御式跳过
        table[item.name] = cfg
        mcpAdded.push(item.name)
      }
      doc[def.mcp.key] = table
      if (docExisted) {
        // 写前快照：原物进 checkpoint（与 applyRestore 同款布局，action=rollback 直接可回滚）
        const stamp = (deps?.now ?? new Date()).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
        const ckptName = `restore-checkpoint-inject-${stamp}`
        const ckpt = join(envBackupDir(deps?.dir), ckptName)
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
        detail: `目标已是备份内容或全部条目冲突跳过（只新增不覆盖）：MCP 跳过 ${mcpSkipped}、skills 跳过 ${skillsSkipped}——未写任何盘`,
      }
    }

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
      ].join('；'),
    }
  } catch (e) {
    return { ok: false, error: readable(e) }
  }
}
