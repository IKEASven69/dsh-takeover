import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import { SkillRegistration } from "@deepseek-ai/dsh-skill";
//#region ../agent-handoff/packages/core/dist/index.d.mts
/** 六段正文 + 可选「建议加载」段 */
interface CardSections {
  goal: string;
  files: string;
  done: string;
  remaining: string;
  stopped: string;
  warnings: string;
  suggested?: string;
}
//#endregion
//#region src/collect.d.ts
/**
 * 事件流确定性收集（不调 LLM、不读时钟之外的副作用）。
 * 借道 npm 包 dsh-handoff v0.1.0 的探测思路：全程 typeof 防御，
 * 任何结构偏差都不抛错——探测失败由调用方降级为规范值，绝不 throw。
 * @module dsh-takeover/collect
 */
/** 探测结果：events 不可用/无法适配时 skipped=true 并附中文说明 */
interface ProbeResult {
  events: unknown[];
  skipped: boolean;
  note: string;
}
/** 收集到的会话事实（全部来自事件流的确定性蒸馏） */
interface SessionFacts {
  /** 直接用户消息（source.kind === 'user'），截 200 字 */
  userMessages: Array<{
    time: number;
    text: string;
  }>;
  /** 写过的文件/编辑清单 */
  writeEdits: Array<{
    tool: string;
    file: string;
  }>;
  /** 执行过的命令摘要（bash 系，截 120 字，最多 10 条） */
  commands: string[];
  /** bash 里的 git commit 命令 */
  gitCommits: string[];
  /** 工具调用参数里出现的工作区路径（去重） */
  keyFiles: Set<string>;
  /** 最近一次 todo/write 的快照（原样条目） */
  lastTodo: Array<Record<string, unknown>> | null;
  /** 最近一次 goal/change 的目标文本 */
  lastGoal: string;
  /** 事件总数（探测成功时） */
  eventCount: number;
}
/**
 * 探测会话事件流：优先 session.snapshotEvents()（dsh-session 正式 API），
 * 退回 session.events 数组（dsh-handoff 探测过的形态），再退回降级。
 */
export declare function probeSessionEvents(session: unknown): ProbeResult;
/** 遍历事件流收集会话事实；单条事件结构不符就跳过，绝不抛错 */
export declare function collectFacts(events: unknown[]): SessionFacts;
/** todo 条目 → 协议 tasks 快照（text + status 最小公分母，语义 4：迁快照不迁现场） */
export declare function todoToTasks(facts: SessionFacts): Array<{
  text: string;
  status: string;
  priority?: string;
}>;
//#endregion
//#region src/tools.d.ts
/** 覆盖率统计：done 段的完成/交付陈述总数与其中带四态标注的条数 */
interface CoverageStats {
  statements: number;
  marked: number;
  unmarked: number;
  [k: string]: number;
}
/** handoff_push 参数：六段文本可选，缺省段走事件流确定性兜底 */
interface PushArgs {
  goal?: string;
  files?: string;
  done?: string;
  remaining?: string;
  stopped?: string;
  warnings?: string;
  suggested?: string;
  title?: string;
  to?: string;
  project?: string;
  cwd?: string;
}
type PushResult = {
  ok: true;
  id: string;
  path: string;
  skipped: boolean;
  note: string;
  coverage: CoverageStats;
} | {
  ok: false;
  error: string;
};
/** 确定性兜底：事件流事实 → 六段正文草稿（中文，证据一律 HISTORY_REPORTED） */
export declare function factsToSections(facts: SessionFacts, skipped: boolean, note: string): CardSections;
/**
 * 推送核心（可脱离 host 单测）：组装协议卡片写入 pending/。
 * session 可以是任何形态——探测失败只降级，不抛错。
 * 外来段落净化（ANSI/控制字符剥离、伪标题解除形态）并限量（单段 128K 字符，
 * 标量 500）——共享收件箱的卡会被 inboxList/buildState 每次全量重读，不设上限
 * 就是把宿主内存/CPU 交给任意一次 push。
 */
export declare function pushHandoff(session: unknown, args: PushArgs, opts?: {
  dir?: string;
}): PushResult;
interface InboxItem {
  id: string;
  from: string;
  title: string;
  to: string;
  project: string;
  pushed_at: string;
  taskCount: number;
  [k: string]: string | number;
}
type InboxListResult = {
  ok: true;
  action: 'list';
  cards: InboxItem[];
  skipped: number;
} | {
  ok: false;
  error: string;
};
/** 列出 pending 待取件（新→旧），只读不消费；坏卡跳过并计数（skipped），不再静默 */
export declare function inboxList(opts?: {
  dir?: string;
}): InboxListResult;
type InboxLoadResult = {
  ok: true;
  action: 'load';
  id: string;
  text: string;
  mismatches: string[];
  unavailable?: string;
  /** 卡内 extras.coverage（防御式提取，外来卡/坏数据缺省） */
  coverage?: CoverageStats;
  /** 随卡消费的机器信封 JSON 字符数；卡无信封（旧卡/外写卡）缺省 */
  envelopeChars?: number;
} | {
  ok: false;
  error: string;
};
/** 取件（消费即弃）：pending → archived，附 verifyGit 的 MISMATCH/UNAVAILABLE 警告 */
export declare function inboxLoad(id: string, opts?: {
  dir?: string;
}): InboxLoadResult;
/** 寄存/取件后的宿主通知（docs/需求调研-1003.md P2-3）：
 * DSH 宿主无 toast / 系统通知的插件挂点，最接近形态是 ctx.userQuestions.ask
 * 的阻塞式问答面板（规范调用样例：dsh-tool-ask-user，agent: exec.agent + signal: exec.signal）。
 * 尽力而为，绝不阻断寄存/取件主流程：
 * - 服务缺席（旧宿主）→ safeUserQuestions 返 undefined，直接跳过；
 * - Web 客户端离线 / 会话无 open turn（NO_PROVIDER）、subagent 持有 agent（DELEGATED_CALLER）、
 *   中止（ASK_ABORTED）→ ask reject，静默降级为工具结果文本。 */
export declare function handoffHostNotice(userQuestions: unknown, action: 'push' | 'load', id: string, exec?: {
  agent?: Agent;
  signal?: AbortSignal;
}, log?: (msg: string) => void): Promise<void>;
//#endregion
//#region ../agent-handoff/packages/readers/dist/index.d.mts
//#region src/transcript.d.ts
/**
 * 会话 Turn 的最小类型与 Claude transcript 解析（移植自 dsh-hippo src/patterns/transcript.ts，
 * 去掉 cwdToProject——它依赖 hippo 项目别名表，不属于读取层）。
 *
 * 一条 assistant 消息的多个 content block 拆成多个 Turn（text / thinking / tool_use），
 * user 消息里的 tool_result block 变成带 failed 标记的 tool turn。
 */
/** 对话的一个最小单元（从一行 transcript 提取） */
interface Turn {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  cwd: string;
  ts: string;
  toolName: string;
  toolFailed: boolean;
  model: string;
}
//#endregion
//#region src/types.d.ts
/** 一个已发现的会话（发现层产物，轻量：不含内容）。 */
interface SessionRef {
  /** 归属适配器名：claude-code | codex | opencode | zcode | pi | workbuddy | cursor | grok */
  agent: string;
  /** 稳定 id：文件系=绝对路径；SQLite 系=会话 id。 */
  id: string;
  title: string;
  cwd: string;
  /** 最近更新时间（ms epoch），排序用。 */
  updatedAt: number;
  /** 增量指纹：文件系="mtime:size"；SQLite 系=String(time_updated)。 */
  fingerprint: string;
  kind: 'file' | 'sqlite';
}
//#endregion
//#region src/foreign.d.ts
/** 面向用户的八家提供方名 → readers 适配器名（claude 是 claude-code 的别名） */
export declare const FOREIGN_PROVIDERS: readonly ['claude', 'codex', 'opencode', 'zcode', 'pi', 'workbuddy', 'cursor', 'grok'];
type ForeignProvider = (typeof FOREIGN_PROVIDERS)[number];
/** 面向用户的 provider 名 → readers 适配器名（设置卡支持矩阵同用） */
export declare const PROVIDER_TO_ADAPTER: Record<ForeignProvider, string>;
/** 引用解析结果（与 readers ResolveResult 同构，解耦后单测可手写） */
type ForeignResolve = {
  kind: 'resolved';
  ref: SessionRef;
} | {
  kind: 'ambiguous';
  candidates: SessionRef[];
} | {
  kind: 'not-found';
  reference: string;
};
/** 读取层依赖（默认实现 lazy import @agent-handoff/readers；测试注入假货） */
interface ForeignReaders {
  listSessions(agent: string): SessionRef[];
  resolve(agent: string, reference: string): ForeignResolve;
  readSession(agent: string, ref: SessionRef | string): Turn[];
  /** 适配器支持情况：node:sqlite 缺失（Node<22）时 zcode 报 supported=false */
  adapterNote(agent: string): {
    supported: boolean;
    note: string;
  };
}
/** 工具参数 */
interface ForeignReadArgs {
  provider?: string;
  action?: string;
  reference?: string;
  limit?: number;
  offset?: number;
}
/** list 的候选条目（标题 / 时间 / 轮数） */
type ForeignCandidate = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  kind: string;
  turns: number;
};
/** show 的结构化摘要 */
type ForeignSummary = {
  title: string;
  sessionId: string;
  cwd: string;
  updatedAt: string;
  turnCount: number;
  userTurns: number;
  firstUserMessage: string;
  lastUserMessage: string;
  tailProgress: string[];
  files: string[];
  commands: string[];
};
/** show 的骨架卡六段素材（模型改写六段卡的原料，全部 HISTORY_REPORTED） */
type ForeignSkeleton = {
  goal: string;
  files: string;
  done: string;
  remaining: string;
  stopped: string;
  warnings: string;
};
/** 分页吐出的原文轮次（仅在模型显式传 limit 时给出） */
type ForeignTurn = {
  index: number;
  role: string;
  ts: string;
  toolName: string;
  toolFailed: boolean;
  text: string;
};
type ForeignReadResult = {
  ok: true;
  action: 'list';
  provider: string;
  total: number;
  sessions: ForeignCandidate[];
} | {
  ok: true;
  action: 'show';
  provider: string;
  summary: ForeignSummary;
  skeleton: ForeignSkeleton;
  turnsTotal: number;
  turnsOffset: number;
  turns?: ForeignTurn[];
  note?: string;
} | {
  ok: false;
  error: string;
  candidates?: ForeignCandidate[];
};
/** 轮次流 → 结构化摘要 + 骨架素材（纯函数，可单测） */
export declare function summarizeTurns(ref: SessionRef, turns: Turn[]): {
  summary: ForeignSummary;
  skeleton: ForeignSkeleton;
};
/** 运行时环境钩子：provider 启停闸（host 侧从设置开关注入；缺省不闸） */
interface ForeignEnv {
  isEnabled?: (provider: ForeignProvider) => boolean;
}
/** 停用规范错误值：与设置卡同一文案口径 */
export declare const disabledError: (provider: string) => string;
/**
 * 拉取核心（可脱离 cordis 单测）：deps 缺省走真实 readers。
 * 任何一步失败都回规范错误值，绝不抛出。
 */
export declare function foreignSessionRead(args: ForeignReadArgs, deps?: ForeignReaders, env?: ForeignEnv): Promise<ForeignReadResult>;
/**
 * 渲染：execute 返回规范值对象，render 包成中文 text block。
 * dsh-tools 契约：模型只见到 output.render 返回的 content blocks；
 * execute 返回的 value JSON 是程序化字段，永不送达模型（README「The loop
 * retains model-emitted arguments and the registry's final content」）。
 * 所以摘要、骨架六段素材、分页 turns 原文必须全部拼进这份主文本。
 */
export declare function renderForeign(_args: unknown, value: unknown): Array<{
  type: 'text';
  text: string;
}>;
/** 注册 foreign_session_read 工具；env.isEnabled 缺省则不闸（纯库用法） */
export declare function registerForeignTool(ctx: Context, env?: ForeignEnv): void;
//#endregion
//#region src/settings.d.ts
/** 开关文件形态：只记停用名单（默认全开，未知条目载入时丢弃） */
interface TakeoverSwitches {
  disabledProviders: string[];
}
/** config.json 路径（HANDOFF_HOME 优先，否则 ~/.handoff） */
export declare function switchesPath(dir?: string): string;
/** 读开关：文件缺失/损坏一律视为默认全开（fail-open 是有文档的取舍），
 * 但损坏必须告警——隐私开关被无声恢复是不可接受的静默 */
export declare function loadSwitches(dir?: string): TakeoverSwitches;
/** 写开关：tmp+rename 原子替换（进程中断不再留下半截 config.json） */
export declare function saveSwitches(switches: TakeoverSwitches, dir?: string): void;
/** 某家是否启用（默认启用；只认八家名单内的停用条目） */
export declare function isProviderEnabled(provider: string, dir?: string): boolean;
/** 切某家开关并持久化；未知 provider 抛中文错（路由层转 400） */
export declare function setProviderEnabled(provider: string, enabled: boolean, dir?: string): TakeoverSwitches;
/** 收件箱概览的待取件行 */
interface PendingRow {
  id: string;
  agent: string;
  title: string;
  project: string;
  pushedAt: string;
  /** 目标段（sections.goal）预览，截 240 字；空段回退 done 段 */
  preview: string;
}
/** 支持矩阵行：本机是否支持 / 发现的会话数 / 启用开关 */
interface ProviderRow {
  name: ForeignProvider;
  supported: boolean;
  /** 发现的会话数；探测失败为 -1（前端显示「—」） */
  sessions: number;
  enabled: boolean;
  note: string;
}
interface TakeoverState {
  /** 解析后的 HANDOFF_HOME 绝对路径（默认 ~/.handoff）：客户端 localStorage
   * 已见卡集合的键散列数据源（0.3.0 新卡徽标），同源连不同机器不串扰 */
  home: string;
  pending: PendingRow[];
  /** 收件箱概览里被跳过的坏卡数（不再静默） */
  pendingSkipped: number;
  /** 收件箱概览不可用时的降级说明（pending 位置异常等）；正常时缺省 */
  inboxError?: string;
  archivedCount: number;
  /** 待取件卡账本覆盖聚合（各卡 extras.coverage 求和）；无数据缺省。
   * 口径纪律：只聚合不强制——防「为覆盖率假标」污染账本 */
  coverage?: {
    statements: number;
    marked: number;
    unmarked: number;
  };
  /** 待取件机器信封字符总量（*.envelope.json 文件字节数求和）；无信封缺省 */
  envelopeChars?: number;
  providers: ProviderRow[];
}
/**
 * 组装设置卡状态（纯函数核心，读取层与目录都可注入）：
 * 单家探测失败只影响该行，不拖垮整体。
 */
export declare function buildState(readers: ForeignReaders, dir?: string): TakeoverState;
/** 清空 archived/：删除全部 .md 文件，返回清除份数（目录不存在=0，不视为错误）。
 * *.md 目录等异常项：跳过不删（应用层删不动，留给人工），单删失败也继续清其余——
 * 此前一个 *.md 目录就让整个清空操作抛 EISDIR，违背「绝不抛出」且永远 500。 */
export declare function clearArchived(dir?: string): number;
//#endregion
//#region src/server.d.ts
/**
 * 注册 /dsh-takeover/ 前缀路由。webServer 是宿主可选服务（CLI 形态没有），
 * 走 ctx.inject 缺席即跳过，不影响工具与 skill 注册面。
 */
export declare function registerTakeoverRoutes(ctx: Context): void;
//#endregion
//#region skills/handoff.d.ts
/** /handoff 注册项 */
export declare function handoffSkillRegistration(): SkillRegistration;
//#endregion
//#region skills/inbox.d.ts
/** /inbox 注册项 */
export declare function inboxSkillRegistration(): SkillRegistration;
//#endregion
//#region skills/resume.d.ts
interface ResumeSkillSpec {
  readonly name: `resume-${ForeignProvider}`;
  readonly provider: ForeignProvider;
  readonly product: string;
  readonly description: string;
  /** 各家恢复边界文案（读取器排除什么、永不做什么） */
  readonly recoveryBoundary: string;
}
/** 八家注册规格：单一出处，content 由模板函数生成 */
export declare const RESUME_SKILL_SPECS: readonly [{
  readonly name: 'resume-claude';
  readonly provider: 'claude';
  readonly product: 'Claude Code';
  readonly description: '把一条 Claude Code 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。';
  readonly recoveryBoundary: '读取器沿可恢复的 Claude 会话分支读取，排除私密与被替换内容；不复活 CLI、不回放工具调用。';
}, {
  readonly name: 'resume-codex';
  readonly provider: 'codex';
  readonly product: 'Codex';
  readonly description: '把一条 Codex 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。';
  readonly recoveryBoundary: '读取器排除 Codex 的 system / developer / reasoning / world-state / 跨 agent 记录。';
}, {
  readonly name: 'resume-opencode';
  readonly provider: 'opencode';
  readonly product: 'OpenCode';
  readonly description: '把一条 OpenCode 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id 或标题关键词。';
  readonly recoveryBoundary: '读取器只读 OpenCode 本地存储的会话记录；不复活进程、不回放存储的调用。';
}, {
  readonly name: 'resume-zcode';
  readonly provider: 'zcode';
  readonly product: 'ZCode';
  readonly description: '把一条 ZCode 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id（支持短前缀）或标题关键词。';
  readonly recoveryBoundary: '读取器只读 ZCode 的 sqlite 库（readonly、随开随关，需 Node ≥22）；不回放调用、不复活 CLI；压缩段只是摘要标记，仍在库里的旧行保留。';
}, {
  readonly name: 'resume-pi';
  readonly provider: 'pi';
  readonly product: 'Pi';
  readonly description: '把一条 Pi 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、JSONL 路径或标题关键词。';
  readonly recoveryBoundary: '读取器只沿 Pi 当前活跃叶子读取，排除 thinking、hooks、system 消息与扩展注入的记录。';
}, {
  readonly name: 'resume-workbuddy';
  readonly provider: 'workbuddy';
  readonly product: 'WorkBuddy';
  readonly description: '把一条 WorkBuddy 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。';
  readonly recoveryBoundary: '读取器只导入受支持的 WorkBuddy transcript / 存储记录，永不回放存储的调用。';
}, {
  readonly name: 'resume-cursor';
  readonly provider: 'cursor';
  readonly product: 'Cursor';
  readonly description: '把一条 Cursor 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。';
  readonly recoveryBoundary: '读取器只导入受支持的 Cursor transcript / store 记录，永不回放存储的调用。';
}, {
  readonly name: 'resume-grok';
  readonly provider: 'grok';
  readonly product: 'Grok';
  readonly description: '把一条 Grok 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、会话目录、记录路径或标题关键词。';
  readonly recoveryBoundary: '读取器只用 Grok 可见的 updates.jsonl 流，永不读 chat_history.jsonl 原始模型上下文。';
}];
/** 单条 skill 内容模板：八条共用一个模板函数 */
export declare function resumeSkillContent(spec: ResumeSkillSpec): string;
/** 八条注册项（数组驱动，与 RESUME_SKILL_SPECS 一一对应） */
export declare function resumeSkillRegistrations(): SkillRegistration[];
//#endregion
//#region skills/index.d.ts
/** 全部 bundled slash skill 注册项（/handoff /inbox + /resume-* 八条） */
export declare function skillRegistrations(): SkillRegistration[];
//#endregion
//#region src/index.d.ts
export declare const name = "dsh-takeover";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
//#endregion
export type { ForeignCandidate, ForeignEnv, ForeignProvider, ForeignReadArgs, ForeignReadResult, ForeignReaders, ForeignResolve, ForeignSkeleton, ForeignSummary, ForeignTurn, InboxItem, InboxListResult, InboxLoadResult, PendingRow, ProbeResult, ProviderRow, PushArgs, PushResult, ResumeSkillSpec, SessionFacts, TakeoverState, TakeoverSwitches };
//# sourceMappingURL=index.d.ts.map