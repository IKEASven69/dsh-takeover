import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import { SkillRegistration } from "@deepseek-ai/dsh-skill";
//#region src/signing.d.ts
type SigVerdict = 'ok' | 'tampered' | 'unsigned' | 'no-key';
//#endregion
//#region node_modules/.pnpm/@agent-handoff+core@file+vendor+@agent-handoff+core/node_modules/@agent-handoff/core/dist/index.d.mts
//#region src/types.d.ts
/** 协议卡片类型（handoff: 1）。未知字段不丢：顶层进 extras，嵌套对象透传。 */
type TaskStatus = 'pending' | 'in_progress' | 'completed';
/** 任务快照：text + status 最小公分母（语义 4：迁快照不迁现场） */
interface TaskSnapshot {
  text: string;
  status: TaskStatus;
  priority?: string;
  [k: string]: unknown;
}
/** 推送时刻的 git 快照（HISTORY_REPORTED，不是当下事实） */
interface GitSnapshot {
  branch: string;
  changed: string[];
  [k: string]: unknown;
}
/** 来源：session 是指针不是原文（语义 2） */
interface CardFrom {
  agent: string;
  session: string;
  title: string;
  [k: string]: unknown;
}
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
interface Card {
  handoff: number;
  id: string;
  from: CardFrom;
  to: string;
  project: string;
  cwd: string;
  pushed_at: string;
  git: GitSnapshot;
  tasks: TaskSnapshot[];
  sections: CardSections;
  extras: Record<string, unknown>;
}
/** 目录扫描报告：坏卡不拖垮列表，但逐个计数+告警（此前空 catch 静默吞掉，无跳过线索） */
interface DirCardsReport {
  cards: Card[];
  skipped: Array<{
    file: string;
    reason: string;
  }>;
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
 * 0.26 probe 接线补口（与 contexthealth.ts 同源 bug 同款改法）：snapshotEvents 的
 * 默认参数读 `this.seq`（dsh-session lib/index.js:1454）——解绑裸调用丢 this 在真机
 * Session（0.2.2-rc.1 装机实测）必抛，解绑失败后以 session 为接收者做一次绑定重试
 * （官方 API 的正确调用形态）。合成桩箭头函数形态在解绑跳已成功，不进重试；
 * 全链 typeof 防御 + fail-open 分级不变。
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
//#region src/contexthealth.d.ts
/**
 * 上下文预警触发器（0.26 contextHealth，WS-1）：
 * 把「会话还剩多少上下文」从 collect.ts 已被实测判死刑的条数代理
 * （userMessages≤100 / writeEdits≤200 / commands≤10 全封顶失真）
 * 换成真指标——最后请求的 usage ÷ 广告的 contextWindow——并在临界时
 * 给出可一键执行的预警态建议（救生艇 / 寄存）。不做任何仪表盘
 * （KPI 栏 / 热力图 / 趋势图 / 组成堆叠条是 dsh-context 的「看」位，
 * 本模块交付的全部是「何时该动手」的判定）。
 *
 * 主指标口径（docs/预研-0.26.md §2.1/§2.2，探针面在 @deepseek-ai/dsh-session
 * 类型与运行时双核实）：
 * - 分子：事件流「最后一条带 usage 的事件」（assistant/message 的 `usage?`，
 *   types.d.ts:331-339，「when the adapter reported token accounting」——取尾：
 *   事件流按 seq 连续递增，尾部即最后请求）；
 * - 分母：`session.requestContext().contextWindow`（types.d.ts:231-240，
 *   「Maximum combined request and response context in tokens, when advertised」；
 *   getter 缺席时退事件流 `request/context` 事件——同一份路由元数据的落盘形态）。
 * 两者都是可选字段（预研 §2.4 #1/#2）：任一缺失 → level='unknown'，只报
 * 兜底触发器与依据，绝不编比率。
 *
 * 兜底触发器两条独立在册（与比率口径无关的事实观察，预研 §2.1 触发器行）：
 * - turn/end reason `max-tokens`（types.d.ts:186-190，step 撞输出 token 顶）；
 * - surfaceOp `replace` 计数（types.d.ts:452-463 + surface.d.ts:122
 *   replaceGeneration——compaction 已发生的信号；getter 与事件流两源取大）。
 *
 * seeded/subagent 会话（header.isSeeded / origin='subagent' / delegationDepth /
 * inheritedEventCount 任一命中）：0.26 输出形态一律 level='unknown' + basis
 * 注明 fork 继承，不算比率——元数据只用于识别并降级，不硬编子代理阈值
 * （预研附录 B #12③ Agent 侧探针材料截断，0.26 预警只对主会话出）。
 * 触发器扫描只看子会话自有事件（按 inheritedEventCount 剔除继承前缀），
 * 剔不掉时宁可不报——把父会话的 max-tokens 算到子会话头上就是编造。
 *
 * 阈值不定死：材料未给建议值（预研 §2.4 #4），常量出模块头，上线初期从宽
 * （warn 阈低设，宁误报不漏报），实测分布后再调。
 *
 * 实现风格延续 probeSessionEvents（src/collect.ts:77-98）：全程 typeof 防御、
 * fail-open、绝不 throw；不改 collect.ts（探针是会话对象级探测，不进
 * collectFacts 的事件类型分发 switch）。零依赖（纯函数，node:stdlib 都不用）。
 *
 * ── 探针补路径（0.26+ 真实事件读取，装机 0.2.2-rc.1 实测复现）──
 * 真机瓦片「snapshotEvents/events 均 undefined」的根因是解绑调用丢 this：
 * snapshotEvents 默认参数读 `this.seq`（dsh-session lib/index.js:1454），裸调用
 * `fn()` 时 this=undefined 必抛 → 落 events 字段，而真机 Session 永远没有
 * `events` 字段（内部数组真名是 `log`，实例 own keys 实测）。故在既有两路径
 * 之后追加两条真机可达路径（既有路径原样保留，typeof 防御 + fail-open 分级不变）：
 * - 路径三：同一官方 API 的绑定重试——`snapshotEvents.call(session)`，以 session
 *   为接收者（真机实测：解绑必抛 'reading seq'，绑定 OK 且返回冻结快照）；
 * - 路径四（末位兜底）：`session.log` 内部数组（live）——非正式面，basis 注明来源。
 * 分母同理：requestContext 解绑在真机同样必抛（默认参数读 `this.contextFoldSeq`，
 * 装机实测），追加绑定重试后才在真机点亮。
 * 注意：snapshotEvents/eventAt 上游已标 @deprecated（指向同步读退役架构笔记），
 * 宿主 SessionStore.fork 仍在用，绑定调用短期安全；中长期官方面是 sessionProjections
 * 投影注册表——basis 不把 snapshotEvents 说成长期承诺。
 *
 * ── 条件性代价投影（诚实两态，绝不自算）──
 * 可选第二参 tokenMeter（集成面传 `ctx.root?.tokenMeter`，@deepseek-ai/dsh-token-meter
 * 服务，dsh-base bundle 挂载；精简 profile 可能缺席）。在位时直读官方投影
 * `tokenMeter.contextPressure(session)`（method-call 形态，服务内部读 this 的投影
 * 句柄）——0.2.2-rc.1 装机实测方法面只返回 `pressureTokens`（最近请求 provider
 * 上报 prompt size，不含输出）与 `contextWindow`（最新路由容量）；`projectedTokens`
 * 在投影状态里但不在本方法返回面（官方签名 Pick<'pressureTokens'|'contextWindow'>），
 * 字段保留防御性读取，缺席不编。官方文档明言投影是「user-facing reference,
 * not a billing or gating input」——故只作参考字段呈现，绝不参与分级。
 * tokenMeter 缺席/方法缺席/调用抛错/返回无数值 → 投影字段缺席，basis 如实写
 * 「代价投影不可达，未接入」——不可达就说不可达，绝不自算投影。
 *
 * @module dsh-takeover/contexthealth
 */
/** 预警级别：unknown = 无可靠比率口径（分母/分子缺失或 fork 降级），降级即产品行为 */
type ContexthealthLevel = 'ok' | 'warn' | 'critical' | 'unknown';
/** 建议动作：只指路到既有端点（lifeboat=POST /dsh-takeover/lifeboat，
 * deposit=POST /dsh-takeover/takeover 的 mode='take_deposit'），执行权在集成面与用户 */
type ContexthealthAction = 'lifeboat' | 'deposit' | null;
/** 官方代价投影字段集（tokenMeter.contextPressure 直读的原始数值，绝不自算派生）。
 * 三项均按官方语义可选：pressureTokens 缺席=provider 尚未上报 usage；
 * contextWindow 缺席=无 adapter 广告容量；projectedTokens 官方方法面（0.2.2-rc.1
 * 实测）暂不返回，保留防御性读取。字段键缺席即「该来源未给出」，不编 0。 */
type ContexthealthProjection = {
  /** 最近请求的 provider 上报 prompt size（不含输出） */
  pressureTokens?: number;
  /** 下一请求预估（官方投影状态字段；方法面当前不返回，防御性读取） */
  projectedTokens?: number;
  /** 最新记录的路由容量 */
  contextWindow?: number;
};
/** 探测结果立约（集成面经 state.contextHealth 呈现，字段语义见模块头）。
 * type 别名而非 interface（集成期定型，零逻辑变更）：命名别名才有隐式索引签名，
 * 过 defineTool 的 JsonValue 契约——RepoBaseline/SyncToolValue 同款仓内惯例 */
type ContexthealthReport = {
  level: ContexthealthLevel;
  /** 已用 ÷ 广告窗口；仅比率口径双在场时有值，unknown 态一律缺席 */
  ratio?: number;
  /** 分级/降级依据（中文一句话，如实说明口径来源或缺失原因） */
  basis: string;
  /** 兜底触发器清单（独立于比率的事实观察；无命中为空数组） */
  triggers: string[];
  /** 建议动作：critical→lifeboat（紧急抢出），warn→deposit（提前寄存），其余 null */
  action: ContexthealthAction;
  /** 官方代价投影直读（参考字段，绝不参与分级）；键缺席 = 不可达未接入（basis 注明原因） */
  projection?: ContexthealthProjection;
};
/**
 * 分级阈值（模块头常量，实测分布后调；预研 §2.4 #4 材料未给建议值）。
 * 从宽原则：warn 阈低设，宁误报不漏报；边界判定用 >=（含端点）。
 */
export declare const WARN_RATIO = 0.7;
export declare const CRITICAL_RATIO = 0.85;
/**
 * 探测会话上下文健康并给出预警态（纯函数，绝不 throw）。
 * 任何意外的探测异常都在顶层兜底成 unknown——fail-open，绝不拦调用方。
 *
 * @param session 宿主会话对象（`ctx.root.sessions.get(id)` 的同一实例，弱映射态按实例取）
 * @param tokenMeter 可选；宿主 tokenMeter 服务（集成面传 `ctx.root?.tokenMeter`）。
 * 缺席即代价投影不可达态——basis 如实注明「代价投影不可达，未接入」，绝不自算投影。
 */
export declare function probeContexthealth(session: unknown, tokenMeter?: unknown): ContexthealthReport;
//#endregion
//#region src/tools.d.ts
/** 覆盖率统计：done 段的完成/交付陈述总数与其中带四态标注的条数 */
interface CoverageStats {
  statements: number;
  marked: number;
  unmarked: number;
  [k: string]: number;
}
/**
 * 四轴 IR 立约——axis：这张卡是哪根轴的载荷。
 * 'session'=会话轴（工作交接卡，六段接续工作）；'memory'=记忆轴（记忆快照卡，按条目吸收）；
 * 'config'=环境配置轴（环境/配置交接卡，预留）。取件方据此决定消费姿态。
 * 走 extras 通道持久化：core parseCard 把顶层未知键收进 extras，extras 殿后渲染回 frontmatter——
 * 不认识 axis 的旧实现按未知字段原样保留，round-trip 不丢（既有版本纪律）。
 */
type CardAxis = 'session' | 'memory' | 'config';
/**
 * 四轴 IR 立约——payload：载荷形态。
 * 'files'=原文件正文（卡里带原始文件内容，取件方原样吸收整份）；
 * 'distilled'=蒸馏条目（卡里带甄别过的条目，取件方按条目入库）；
 * 'manifest'=清单+指针（配置轴：卡里只带文件清单/哈希/类别与密文包指针，
 * 不带货本体——本体在卡外按指针取，口令永不进卡）。
 */
type CardPayload = 'files' | 'distilled' | 'manifest';
/**
 * 寄存时刻的仓库基线：remote/head/branch 三元组。取件方据此在新机器上
 * clone → checkout → apply 补丁 → 跑测试，复原寄存时的代码现场。
 * 各字段如实缺省（拿不到就是 null/空串），绝不用占位值冒充。
 * （type 别名而非 interface：命名别名才有隐式索引签名，过 defineTool 的 JsonValue 契约——SyncToolValue 同款）
 */
type RepoBaseline = {
  /** origin 远端 URL；无 origin（纯本地仓）/ 非 git 仓为 null */
  remote: string | null;
  /** 寄存时刻 HEAD commit；unborn 分支（无提交）/ 命令失败为 null */
  head: string | null;
  /** 寄存时刻分支名（复用 GitSnapshot.branch，同一次采集；非 git 仓为空串） */
  branch: string;
};
/** 从卡片 extras 防御式取基线（core parseCard 把顶层未知键收进 extras；外来卡/坏数据一律 undefined） */
export declare function baselineFromExtras(extras: unknown): RepoBaseline | undefined;
/** 从卡片 extras 防御式取四轴标记（闭集外/坏数据一律 undefined——外来卡无 axis 按旧卡处理） */
export declare function axisFromExtras(extras: unknown): CardAxis | undefined;
/** 「🧭 基线恢复指引」四步（clone → checkout → apply 补丁 → 跑测试）。
 * baseline 与 patch/testCommand 任一缺席都如实降级为说明行，不渲染空壳步骤。 */
export declare function renderBaselineGuidance(baseline: RepoBaseline, patchPath: string | undefined, testCommand: string | undefined): string[];
/**
 * 补丁随卡信息（PushResult / 信封 extra / HandoffEnvelope.patch 三处共用）。
 * patchFormat/chunks 是 0.4.x gzip/分块扩展：patchFormat='gzip' = 补丁以 gzip 压缩形态
 * 随卡（.patch.gz 或分块 .patch.NNN.gz），chunks>1 = 分块数；旧消费者天然忽略，
 * bytes 恒为未压缩补丁全文的字节数（压缩块字节数进取件面 patchBytes）。
 */
type PatchInfo = {
  bytes: number;
  truncated: boolean;
  sidecar: boolean;
  patchFormat?: 'gzip';
  chunks?: number;
};
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
  /** 本卡接替的前置卡 id（接力寄存）：只进信封不进 SPEC frontmatter */
  supersedes?: string;
  /** 空壳卡守门旁路：六段全是兜底占位时，确认要寄存空壳卡 */
  confirmSkeleton?: boolean;
  /** 密钥闸旁路：扫描命中疑似密钥时，确认带密寄存（留痕进返回值） */
  allowSecrets?: boolean;
}
type PushResult = {
  ok: true;
  id: string;
  path: string;
  skipped: boolean;
  note: string;
  coverage: CoverageStats;
  /** 未提交改动补丁随卡情况；undefined = 源目录非 git 仓库 */
  patch?: PatchInfo;
  /** 本卡接替的前置卡 id（透传进信封） */
  supersedes?: string;
  /** 空壳卡（守门旁路后落盘）：调用方/下游可据此提示 */
  skeleton?: boolean;
  /** 密钥闸旁路留痕：命中规则名列表 */
  secretsBypass?: string[];
  /** 上下文预警旁证（0.26 集成接线）：pushHandoff 内跟 probeSessionEvents 后的
   * 一次探测，仅在探出 warn/critical 时随结果带出（写侧旁证与缓存，不承担轮询
   * 呈现——面板真相在 GET state 的 state.contextHealth）。ok/unknown 不占字段。 */
  contextHealth?: ContexthealthReport;
} | {
  ok: false;
  error: string;
};
/** 确定性兜底：事件流事实 → 六段正文草稿（中文，证据一律 HISTORY_REPORTED） */
export declare function factsToSections(facts: SessionFacts, skipped: boolean, note: string): CardSections;
/** 父卡 remaining 并入新卡前的字节闸：2KB = 2048 字节（UTF-8 实测字节，超限截断留痕） */
export declare const RELAY_REMAINING_MAX_BYTES = 2048;
/**
 * 读父卡（supersedes 指向的前置卡）的 remaining 段，产出「上一棒遗留」前缀：
 * pending/ 优先（父卡还没被取走——接力现场常态），退 archived/（已被取走）。
 * 父卡不存在 / 已被 archived 滚动清理 / id 非法 / 解析失败 / remaining 为空
 * → undefined（无前缀，行为与无父卡完全一致；诚实降级，不造「继承成功」的假象）。
 * id 过 core SAFE_ID 闸（ho-* 形态），路径走私进不了文件名。确定性：文本净化 +
 * 2KB 截断后原样继承，不总结不改写。
 */
export declare function inheritParentRemaining(parentId: string, dir?: string): {
  prefix: string;
  note: string;
} | undefined;
/**
 * 推送核心（可脱离 host 单测）：组装协议卡片写入 pending/。
 * session 可以是任何形态——探测失败只降级，不抛错。
 * 外来段落净化（ANSI/控制字符剥离、伪标题解除形态）并限量（单段 128K 字符，
 * 标量 500）——共享收件箱的卡会被 inboxList/buildState 每次全量重读，不设上限
 * 就是把宿主内存/CPU 交给任意一次 push。
 * opts.extras 是插件侧内部出卡通道（pushMemoryCard 等程序化调用方覆盖 axis/payload
 * 立约缺省）：不进 handoff_push 工具入参面，模型输入到不了 extras，密钥闸不旁路。
 * opts.tokenMeter（0.26 probe 接线）：集成面传宿主 tokenMeter 服务（server/tools 注册处
 * 防御式取 ctx.root?.tokenMeter）——官方代价投影直读；缺席即投影「不可达」诚实两态。
 */
export declare function pushHandoff(session: unknown, args: PushArgs, opts?: {
  dir?: string;
  extras?: Record<string, unknown>;
  tokenMeter?: unknown;
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
/** 卡链历史单卡上限条数（与 core ARCHIVED_KEEP=50 同量级——再早的已被滚动归档淘汰） */
export declare const HISTORY_TAIL_MAX = 50;
/** stopped 摘要截断（够辨认停点，不把卡正文搬进返回值） */
export declare const HISTORY_STOPPED_MAX = 120;
/** 卡链历史单行（type 别名：JsonValue 契约要隐式索引签名，InboxItem 同款） */
type HistoryItem = {
  id: string;
  title: string;
  pushed_at: string;
  /** 「停在哪」段摘要（截 HISTORY_STOPPED_MAX；控制字符已剥离） */
  stopped: string;
  /** 本卡接替的前置卡 id（extras.supersedes；旧卡/无接力缺省） */
  supersedes?: string;
  /** 本卡是延续回执卡：指向的源卡 id（extras.receipt.for，0.26 取件即回执；普通卡缺省） */
  receiptFor?: string;
};
type InboxHistoryResult = {
  ok: true;
  action: 'history';
  cards: HistoryItem[];
  total: number;
  project?: string;
  cwd?: string;
} | {
  ok: false;
  error: string;
};
/**
 * 卡链检索：按 project 或 cwd 查 archived/ 已归档卡（复用 core listArchivedReport，
 * 坏卡照旧跳过并忽略）。时间正序（pushed_at 字典序——同机卡共享时区口径），取尾
 * HISTORY_TAIL_MAX 条；两个过滤条件都给 = AND，都不给 = 全量回查。
 * supersedes 取自卡面 extras（寄存时随 extras 持久化——信封取件即弃，卡面才是持久通道）。
 */
export declare function inboxHistory(opts?: {
  dir?: string;
  project?: string;
  cwd?: string;
}): InboxHistoryResult;
type InboxLoadResult = {
  ok: true;
  action: 'load';
  id: string;
  text: string;
  mismatches: string[];
  unavailable?: string;
  /** 卡内 extras.axis 四轴标记（防御式提取，外来旧卡缺省） */
  axis?: CardAxis;
  /** 卡内 extras.coverage（防御式提取，外来卡/坏数据缺省） */
  coverage?: CoverageStats;
  /** 随卡消费的机器信封 JSON 字符数；卡无信封（旧卡/外写卡）缺省 */
  envelopeChars?: number;
  /** 随卡归档的未提交改动补丁路径（git apply 可复原；gzip 形态已自动解压为纯文本）；卡无补丁缺省 */
  patchPath?: string;
  patchBytes?: number;
  /** 补丁 gzip 压缩随卡形态（取件时已自动解压重组）；旧纯文本 .patch 缺省 */
  patchFormat?: 'gzip' | 'gzip-chunked';
  /** gzip 块数（单块=1、分块=N） */
  patchChunks?: number;
  /** 补丁还原降级说明（解压失败等，压缩块已原样归档）；正常还原缺省 */
  patchWarn?: string;
  /** 信封提示的基线测试命令 */
  testCommand?: string;
  /** 本卡接替的前置卡 id */
  supersedes?: string;
  /** 跨 OS 接手：源卡 OS 与本机不同（路径体系需人工映射） */
  crossOS?: {
    source: string;
    local: string;
  };
  /** 卡内 extras.baseline 的仓库基线（防御式提取，外来卡/坏数据缺省） */
  baseline?: RepoBaseline;
  /** 信封验签结论：unsigned=无签名（旧卡/外写卡），no-key=有签名但本机无对应密钥 */
  sig?: SigVerdict;
  /** 随卡归档的 hippo 快照侧车路径（0.26 蒸馏侧车；卡无侧车缺省） */
  hippoPath?: string;
  /** 侧车搬移失败说明（侧车留 pending/，取件不受影响）；正常搬移缺省 */
  hippoWarn?: string;
  /** 延续回执落账说明（0.26 取件即回执）：生成成功/失败的诚实附注；回执卡自身被取件不再产出二次回执，缺省 */
  receiptNote?: string;
} | {
  ok: false;
  error: string;
};
/** 取件（消费即弃）：pending → archived，附 verifyGit 的 MISMATCH/UNAVAILABLE 警告 */
export declare function inboxLoad(id: string, opts?: {
  dir?: string;
}): InboxLoadResult;
/** 寄存/取件后的宿主通知（对齐 Claude Code 通知习惯）：
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
/** 配置卡 extras.config 结构化载荷：清单 + 指针（不含任何文件内容，口令永不进卡） */
interface ConfigCardPayload {
  /** 密文备份文件名（.dshenv，指针） */
  backupFile: string;
  /** 密文包本体字节数（指针口径） */
  bytes: number;
  /** 备份时刻（容器 manifest.createdAt） */
  createdAt: string;
  /** 源机主机名 */
  host: string;
  /** 凭据类文件计数（如实告知包内有几件只存在于加密包内的东西） */
  secretCount: number;
  /** 清单行：path/sha256/category（不含内容与口令） */
  files: Array<{
    path: string;
    sha256: string;
    category: string;
  }>;
}
type ConfigCardResult = {
  ok: true;
  id: string;
  path: string;
  file: string;
  bytes: number;
  files: number;
  note?: string;
} | {
  ok: false;
  error: string;
};
/**
 * 配置轴出卡核心（handoff_env action=card / 换机面板共用）：把最近一次备份的
 * 清单（files[{path,sha256,category}] + backupFile + bytes）写成 axis='config'
 * 载荷卡——writeCard + 机器信封签名全套纪律（cardSha256 进签名面，与 pushHandoff
 * 同款尽力签名：密钥缺席信封照落、落盘失败不回滚卡片）。密文 blob 仍在
 * env-backup/（卡只带清单+指针，随 HANDOFF_HOME 同步盘走）；口令只用于读加密
 * 清单，永不进卡六段与 extras。args.file 缺省取最近一次备份（listBackups 首项）。
 */
export declare function pushConfigCard(args: {
  file?: string;
  passphrase?: string;
  title?: string;
}, opts?: {
  dir?: string;
}): ConfigCardResult;
//#endregion
//#region src/flightcheck.d.ts
/** 检查项 kind 闭集：开集没法聚合体检率，也没法出分档章 */
export declare const FLIGHTCHECK_KINDS: readonly ['file_ref', 'secret', 'skeleton', 'claim_cmd'];
type FlightcheckKind = (typeof FLIGHTCHECK_KINDS)[number];
/** 三档章 verdict 闭集。blocked 只活在闸拒收路径，真实落盘卡卡面只有前两档 */
export declare const FLIGHT_VERDICTS: readonly ['cleared', 'cautioned', 'blocked'];
type FlightVerdict = (typeof FLIGHT_VERDICTS)[number];
/**
 * 四态字段闭集（登记与回执 evidence 共用，0.26 立约交付）：
 * - `CURRENT_OBSERVED`：当下观察证实（取件时 git 核验一致）；
 * - `MISMATCH`：与仓库现实脱节（取件时 git 核验冲突）；
 * - `UNAVAILABLE`：无法核验（非 git 仓 / cwd 不在 / git 失败）；
 * - `unverified`：在册未验——claim_cmd 登记态，0.26 无执行面，登记即终态。
 * 口径与卡面覆盖率四态标记（tools.ts COVERAGE_MARKERS）同族但不混用：
 * 覆盖率管「完成陈述标没标」，这里管「声称验没验」。
 */
export declare const CLAIM_STATES: readonly ['CURRENT_OBSERVED', 'MISMATCH', 'UNAVAILABLE', 'unverified'];
type ClaimState = (typeof CLAIM_STATES)[number];
/** 单条命令声称登记（claim_cmd 检查项产出，回执 evidence 的 unverified 条目同构） */
interface ClaimRecord {
  /** 声称的命令文本（净化单行 + 截断，登记原文不改写） */
  claim: string;
  /** 所在段（goal/done/remaining） */
  section: string;
  /** 0.26 恒 'unverified'：无执行面，登记即终态；0.27 执行面落地前不得改判 */
  state: ClaimState;
}
/** 单检查项结果（进 extras.flight.checks，随卡持久化供取件方/下游读） */
interface FlightcheckCheck {
  kind: FlightcheckKind;
  /** 该项是否通过；false = 诊断有发现（是否升级档位由 verdict 判定） */
  ok: boolean;
  /** 诊断细节（掩码化，不含密钥值本体——与闸反馈同款口径） */
  detail: string;
  /** claim_cmd 专属：登记的命令声称（其余 kind 缺省） */
  claims?: ClaimRecord[];
}
/** 三档起飞章（extras.flight 契约字段只此三件，不夹带其它键） */
interface FlightStamp {
  verdict: FlightVerdict;
  /** 体检时刻（ISO8601，与 lifecycle 事件 at 同款 toISOString 口径） */
  ran_at: string;
  checks: FlightcheckCheck[];
}
interface FlightcheckResult {
  /** 盖进 extras.flight 的章 */
  stamp: FlightStamp;
  /** 非 cleared 档的人读诊断摘要：cautioned → 追加进读者警告段；blocked → 进拒收反馈文案与 lifecycle detail；cleared 为空串 */
  note: string;
}
interface FlightcheckOptions {
  /** file_ref 相对路径的解析基准（卡面 cwd） */
  cwd?: string;
  /** ran_at 可桩 */
  now?: Date;
  /** 存在性探测注入可桩（缺省 fs.existsSync）；探测自身抛错按「未确认存在」计 */
  exists?: (path: string) => boolean;
  /** 密钥闸旁路同款入参：true 时密钥残留不升级 blocked，降为 cautioned（镜像闸语义） */
  allowSecrets?: boolean;
  /** 空壳闸旁路同款入参：true 时骨架未过不升级 blocked（镜像闸 confirmSkeleton 语义） */
  confirmSkeleton?: boolean;
  /** 六段是否全为兜底占位且未手写（空壳闸 userWrote 同款口径）。
   * 缺省 true = 按已手写处理——体检绝不越权发明 blocked；
   * 集成面在空壳闸拒收路径回放判据时显式传 false。 */
  userWrote?: boolean;
  /** 六段复扫面之外的密钥命中数补正（补丁 diff / title·to·project 标量——体检只扫
   * 六段，闸还扫补丁与标量；闸拒收路径把面外命中数传进来，secret 项据实判 false，
   * 避免「闸拒收但章 cleared」的假象）。出卡正常路径不传。 */
  extraSecretHits?: number;
}
/** 被检六段（suggested 可选：它在卡面上渲染，同属体检面） */
interface FlightcheckSections {
  goal?: string;
  files?: string;
  done?: string;
  remaining?: string;
  stopped?: string;
  warnings?: string;
  suggested?: string;
}
/**
 * 防御式读取 extras.flight 里的 claim_cmd 登记（receipt.ts 与下游共用）：
 * 坏数据 / 闭集外 kind / 非法形态一律忽略，绝不抛；state 恒归一为 'unverified'——
 * 0.26 无执行面，任何在册声称都未被本实现验证过，外来卡声称别的态不可信。
 */
export declare function claimsFromFlight(flight: unknown): ClaimRecord[];
/**
 * 接力体检（纯函数，确定性：同输入同章）。四项固定顺序进 checks；档位判定见模块头。
 * 检查项内部失败（外来投毒数据等）会向上抛——防御式调用走 runFlightcheckSafe。
 */
export declare function runFlightcheck(sections: FlightcheckSections, opts?: FlightcheckOptions): FlightcheckResult;
/**
 * 防御式包装：体检自身抛错（含外来 sections 的 getter 投毒等）= 返回 undefined，
 * 调用方未盖章如实缺省照常出卡，绝不拦出卡主流程（risk③ 硬纪律）。
 */
export declare function runFlightcheckSafe(sections: FlightcheckSections, opts?: FlightcheckOptions): FlightcheckResult | undefined;
//#endregion
//#region src/receipt.d.ts
/** evidence 四态 = flightcheck 登记四态闭集（re-export 保持单一出处） */
type EvidenceState = ClaimState;
/** 单条延续证据（extras.receipt.evidence 的条目形态） */
interface ReceiptEvidence {
  /** 证据陈述（净化单行 + 截断；done 段逐条带四态标注回显） */
  claim: string;
  state: EvidenceState;
}
/** 回执卡 extras.receipt 契约（字段只此五件） */
interface ReceiptExtras {
  /** 源卡 id（SAFE_ID 形态，接力链 supersedes 同值） */
  for: string;
  /** 取件时刻（ISO8601，与 lifecycle at 同款 toISOString 口径） */
  picked_at: string;
  /** 取件方标识（缺省本机 hostname） */
  picked_by: string;
  /** 源卡 stopped 段「最安全的第一步」摘录（无标注取首行，空段如实缺省） */
  first_step: string;
  /** 四态证据（verifyGit 三态映射 + claim_cmd 登记的 unverified 条目） */
  evidence: ReceiptEvidence[];
}
/** 取件核验事实（inboxLoad 里 verifyGit 的产出 + 源卡 git 快照概要，照传即可） */
interface VerifyFacts {
  /** git 核验冲突（MISMATCH 原文串） */
  mismatches?: string[];
  /** 无法核验说明（UNAVAILABLE 原文） */
  unavailable?: string;
  /** 源卡记录的分支（CURRENT_OBSERVED 陈述用） */
  branch?: string;
  /** 源卡记录的 dirty 文件数（CURRENT_OBSERVED 陈述用） */
  changedCount?: number;
}
interface ReceiptExtrasInput {
  /** 源卡 id（非法形态抛中文错——与 core 入口闸同款；generateReceiptCard 先拦成 ok:false） */
  sourceId: string;
  pickedAt?: Date;
  pickedBy?: string;
  verify?: VerifyFacts;
  /** 源卡 stopped 段（first_step 提取） */
  stopped?: string;
  /** 源卡 extras.flight（claim_cmd 登记 → unverified 条目；坏数据防御式忽略） */
  flight?: unknown;
}
/**
 * first_step 提取：stopped 段「最安全的第一步：…」标注优先（跨行取首个命中、
 * 单行截断）；无标注取首个非空行；空段返回空串（如实缺省）。
 */
export declare function firstStepOf(stopped: string): string;
/**
 * verifyGit 产出 → 四态 evidence（确定性映射，零新核验面）：
 * mismatches 逐条 MISMATCH → unavailable 一条 UNAVAILABLE → 都没有 = 核验一致，
 * 一条 CURRENT_OBSERVED（分支/dirty 数随源卡快照如实陈述，缺了不编）。
 */
export declare function evidenceFromVerify(facts: VerifyFacts): ReceiptEvidence[];
/** 回执 extras 构建（纯函数；sourceId 非法抛中文错，generateReceiptCard 已先拦） */
export declare function buildReceiptExtras(input: ReceiptExtrasInput): ReceiptExtras;
interface ReceiptGenerateInput {
  /** 源卡 id */
  sourceId: string;
  /** 取件核验事实（inboxLoad 的 verifyGit 产出照传）；缺省 = 上层未提供核验面 →
   * evidence 如实落 UNAVAILABLE 占位说明，绝不编 CURRENT_OBSERVED */
  verify?: VerifyFacts;
  /** 源卡快照：stopped 段 / extras.flight / git 概要 */
  source?: {
    stopped?: string;
    flight?: unknown;
    branch?: string;
    changedCount?: number;
  };
  /** 取件方标识（缺省本机 hostname） */
  pickedBy?: string;
  /** 回执卡归属工作目录（进卡面 cwd 与 git 快照采集；缺省进程 cwd） */
  cwd?: string;
  /** 回执卡目标（缺省 any） */
  to?: string;
}
type ReceiptCardResult = {
  ok: true;
  id: string;
  path: string; /** 回执指向的源卡 id */
  receiptFor: string;
  evidenceCount: number;
} | {
  ok: false;
  error: string;
};
/**
 * 生成延续回执卡（程序化出卡，复用 pushHandoff 全套纪律 + supersedes 挂链）。
 * 全程不抛、不拦调用方主流程：失败一律 { ok:false, error }（fail-open 硬纪律）；
 * 成功时记 lifecycle continued 事件（target=源卡 id，回执卡在即 continued 的证据）。
 */
export declare function generateReceiptCard(input: ReceiptGenerateInput, deps?: {
  push?: typeof pushHandoff;
  dir?: string;
  now?: Date;
}): ReceiptCardResult;
//#endregion
//#region src/distill.d.ts
/**
 * 记忆蒸馏闭环（0.26 / 侧车格式 v2）：hippo 记忆库 13 字段 JSONL 快照的生产与消费。
 *
 * 生产端（源机）：出卡成功后（接线归集成面，plan §5.1 蒸馏挂点①）以注入式 runner
 * 跑 `hippo export -f jsonl`，把全库 JSONL 快照落 MEMORY_STORES 既有约定路径
 * <数据目录>/hippo-memory.jsonl——文件一旦在场，storeBody 掏条目进「建议加载」段
 * 是既有机制（src/memory.ts:187-194），零改动自动生效。同时把快照组装为
 * **侧车格式 v2** 写为 <id>.hippo.jsonl 落 pending/ 随卡走（物质层随卡先例：补丁
 * sidecar <id>.patch）。v2 格式（0.26.1，需求侧实证：docs/需求调研-1119.md §25
 * 「随卡记忆 schema v2」——auto-memory 四段交接账本实战迭代、memory-evolve #106
 * 归属错位）：
 * - 文件头第一行 meta 行（无 text 字段）：{meta,version:2,at,entries,workspace?}；
 * - 条目行 = 原 13 字段（dsh-hippo transfer.ts EXPORT_FIELDS，值级保真）+ 可选
 *   workspace（归属，来自卡 cwd）/ weight（使用权重，缺省 1，由来源 strength 推导）/
 *   section（四段账本标签 state/goals/dead_ends/next_step，可缺省，来源在场则透传）。
 * 铁律：只动侧车格式，不动六段卡面协议（memorySections 卡面组装零改动）；
 * 读侧 v1/v2 双兼容（v1 无 meta 无新字段照常吸收）；幂等记账键不变（侧车 sha）；
 * MEMORY_STORES 约定与 data-dir 解析零改动；约定路径文件本身是 hippo 所有物，
 * 蒸馏只读不写，v2 组装只发生在侧车。hippo import 对 v2 的兼容性有实测背书：
 * dsh-hippo transfer.ts:114-146 importJsonl 只取已知字段（未知字段忽略）、缺 text
 * 行按坏行跳过（不拒收整文件）；0.3.0 CLI 实测（临时 HIPPO_DATA_DIR，不碰真库）：
 * meta 行 `line 1 skipped: missing text`、两条 v2 富集条目全数 created、退出码 0。
 * CLI 缺席 / 非零退出 / 超时 / 超尺寸 → 全部 fail-open：退回 guidance 回退
 * （现状行为），绝不拦出卡、绝不抛异常。
 *
 * 取件搬移（接线归集成面 §5.1 挂点②，本模块只出纯函数）：consumeDistillSidecar
 * 与 tools.ts consumePatch 同款 pending→archived 同步搬移；搬移失败不拦取件，
 * 侧车留 pending 并回 state='move-failed' 供取件结果如实附注（WS-2 风险⑤）。
 *
 * 消费端（目标机）：locateHippoSidecar / hippoImportRun 供 absorb.ts 对
 * target='hippo-db' 的 confirm 两步后执行 `hippo import <archived>/<id>.hippo.jsonl`。
 * 幂等分层：hippo 层由 dedup-reinforce 语义承担（重复条目强化合并、不覆盖，
 * dsh-hippo transfer.ts:4-8）；takeover 层由 absorb 按侧车 sha 记账（hippo-import-ledger
 * 记账本，同卡重复 absorb 直接跳过）。绝不写 zvec 引擎目录本身——只调 hippo 官方
 * CLI（T8 硬线不变）；supersede 推翻链的旁路索引重建归属 hippo import 行为，
 * 本模块不承诺、文案如实标注「推翻链以 hippo 侧为准」。
 *
 * 已知边界（诚实入册）：execFileSync 不经 shell 直接 spawn，Windows 上 npm 全局
 * 安装的 hippo（.cmd 形态）会 spawn 失败——按「CLI 缺席/失败」fail-open 退 guidance，
 * 不为可执行性引入 shell:true 的注入面。测试全部走桩 runner，绝不真 spawn hippo。
 * @module dsh-takeover/distill
 */
/** hippo JSONL 侧车固定命名尾段：<pending|archived>/<卡id>.hippo.jsonl（同屋先例：补丁 sidecar <id>.patch） */
export declare const HIPPO_SIDECAR_SUFFIX = ".hippo.jsonl";
/** 单次 hippo CLI 调用超时（毫秒）：与 patchpack GIT_DIFF_TIMEOUT_MS 同纪律——挂死的 CLI / 慢盘
 * 不拖垮出卡；export 是全库 JSONL 写出，比 git diff 留一倍余量。超时按导出失败 fail-open。 */
export declare const HIPPO_CLI_TIMEOUT_MS = 30000;
/**
 * 注入式 runner（与 execFileSync 同签名，零依赖；真实实现 realHippoRunner，
 * 测试全走桩——成功返回 stdout、非零退出/CLI 缺席/超时抛 Error（ENOENT code = CLI 缺席））。
 */
type HippoRunner = (file: string, args: string[], opts: {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}) => string;
/** 真实 runner：execFileSync 不走 shell（卡面/路径外来输入，shell 拼接是注入面），超时/编码同仓惯例 */
export declare const realHippoRunner: HippoRunner;
/**
 * 条目 JSONL 约定路径解析——**单点真源**：不从本模块复写路径约定，把「扫描行」形态
 * 交给 MEMORY_STORES 的 entriesFile 函数解析（hippo 项 = <数据目录>/hippo-memory.jsonl），
 * 与扫描、出卡组装共用同一套（src/memory.ts:99 注释口径「与扫描同一套三级解析，
 * 不重复实现」）；注册表未来改约定，distill 零改动跟随。
 */
export declare function hippoEntriesFile(dataDir: string): string;
/** 四段账本标签闭集（v2 section 字段）：auto-memory「handoff, not compression」四段交接账本口径 */
type DistillSection = 'state' | 'goals' | 'dead_ends' | 'next_step';
interface ProduceSnapshotOptions {
  /** 已出卡成功的卡 id（侧车命名 <id>.hippo.jsonl）；缺省 = 只导出约定路径，不出侧车 */
  cardId?: string;
  /** 卡的工作区 cwd（v2 workspace 归属来源——出卡接线传卡 cwd；缺省/空 = 侧车不带 workspace 字段） */
  cwd?: string;
  /** 注入 runner（测试桩；缺省 realHippoRunner 真跑 hippo CLI） */
  runner?: HippoRunner;
  /** 用户 home（数据目录三级解析基座；缺省真实 home） */
  home?: string;
  /** HANDOFF_HOME（侧车落 pending/；缺省按 core resolveHome 链） */
  dir?: string;
  /** 生命周期事件与 v2 侧车 meta.at 的时刻（oversize 留痕 / meta 时间戳定钟；缺省当前时刻） */
  now?: Date;
}
/** 生产结果：ok=false 是 fail-open（guidance 回退），调用方只取 note 如实附注，绝不拦出卡 */
type DistillProduceResult = {
  ok: true;
  /** 三级解析出的数据目录（与扫描同一套解析） */
  dataDir: string;
  /** 条目 JSONL 约定路径（MEMORY_STORES entriesFile 单点解析） */
  entriesFile: string;
  /** 导出文件字节数 */
  bytes: number;
  /** 有效条目数（readStoreEntries 同口径解析；坏行不计） */
  entries: number;
  /** 侧车落盘路径（超尺寸闸 / 未给卡 id / 落盘失败时缺省） */
  sidecar?: string;
  /** v2 侧车实际字节数（meta 行 + 条目富集，≥ 导出文件字节；未出侧车时缺省） */
  sidecarBytes?: number;
  /** 如实说明（导出计数、侧车随卡、超尺寸未随卡等） */
  note: string;
} | {
  ok: false;
  /** cli-missing=未装 hippo CLI（spawn ENOENT）；export-failed=非零退出/超时/文件未落 */
  state: 'cli-missing' | 'export-failed';
  dataDir: string;
  entriesFile: string;
  /** 诚实说明 + 手动补救命令（fail-open，出卡照常） */
  note: string;
};
/**
 * 生产端唯一入口：跑 `hippo export -f jsonl -o <约定路径>`，成功后按需出侧车。
 * 单 options 对象签名（cardId 与注入面同对象）——出卡接线传 { cardId }，测试传
 * { runner, home, dir }，没有 args/deps 双位形参的错位面（错位会静默真跑 CLI）。
 * - 数据目录与约定路径都走 memory.ts 既有解析（三级链 + MEMORY_STORES 注册表），
 *   不重复实现；子进程 env 钉 HIPPO_DATA_DIR=解析结果——hippo CLI 自己只认 env
 *   （dsh-hippo store.ts dataDir(): env ?? ~/.hippo，不读 data-dir.txt），不钉的话
 *   解析链走 data-dir.txt 分支时 CLI 会开错目录，与扫描口径分叉。
 * - 侧车 = 约定文件内容的 **v2 组装**（meta 行 + 条目级 workspace/weight/section，
 *   13 字段值级保真；约定路径文件本身是 hippo 所有物，只读不动）；超 MAX_CARD_BYTES
 *   走尺寸闸（闸算在 v2 侧车实际字节上）：不出侧车 + lifecycle oversize 留痕
 *  （闭集既有理由），条目仍按 storeBody 既有 64KB 截断口径进卡。
 * - 任何失败 fail-open：回 ok:false 与两态文案（未装 CLI / 导出失败），不抛异常。
 */
export declare function produceSnapshot(opts?: ProduceSnapshotOptions): DistillProduceResult;
type ConsumeDistillResult = {
  state: 'moved';
  path: string;
  bytes: number;
} |
/** pending/ 没有侧车（无快照卡/旧卡，常态不是异常） */
{
  state: 'absent';
} |
/** rename 失败：侧车留 pending，取件主流程照旧成功，调用方按本态如实附注 */
{
  state: 'move-failed';
  error: string;
};
/**
 * 取件时同步搬侧车：pending/<id>.hippo.jsonl → archived/（与 .md 同步搬）。
 * 与 consumePatch 同款 fail-open：任何一步失败都只回状态，绝不影响取件成败；
 * 侧车留 pending 时收件箱列表不受影响（core 列表只认 .md）。
 */
export declare function consumeDistillSidecar(id: string, dir?: string): ConsumeDistillResult;
/** 导入记账条目：同卡幂等在 takeover 侧的凭据（sha 对得上 = 已导入过，直接跳过） */
interface HippoLedgerEntry {
  /** 导入时侧车内容的 sha256 */
  sha256: string;
  /** 导入时刻（ISO） */
  at: string;
  /** 侧车有效条目数（导入口径） */
  entries: number;
  /** 侧车字节数 */
  bytes: number;
}
/** 记账本路径：archived/absorb-backup/hippo-import-ledger.json（与写前快照同居） */
export declare function hippoLedgerPath(dir?: string): string;
/** 读记账本（坏文件/读失败回空账——宁可重导入，hippo dedup 兜底幂等，不丢条目） */
export declare function readHippoLedger(dir?: string): Record<string, HippoLedgerEntry>;
/** 记账（导入成功后调用）。返回如实附注：''=记账成功；非空=记账失败的诚实说明
 * （导入本身不回滚——hippo dedup-reinforce 保证重复导入仍幂等，只是下次会再跑一遍 CLI）。 */
export declare function recordHippoLedger(id: string, entry: HippoLedgerEntry, dir?: string): string;
/** located 侧车信息（absorb 计划回显与执行共用；v1/v2 双兼容——格式事实随侧车如实带出） */
interface HippoSidecarInfo {
  /** archived/ 下侧车绝对路径 */
  sidecar: string;
  /** 内容 sha256（takeover 侧同卡幂等凭据——v1/v2 同一机制，键不变） */
  sha256: string;
  bytes: number;
  /** 有效条目数（readStoreEntries 同口径；坏行不计——v2 meta 行也按无 text 行跳过） */
  entries: number;
  /** 三级解析出的目标数据目录（env 钉给 hippo CLI 用；takeover 从不直接写它） */
  dataDir: string;
  /** 侧车格式版本（meta 行缺失/坏行按 1——「meta 缺失按 v1 处理」口径；v2 族 ≥2） */
  sidecarVersion: number;
  /** v2 meta 行声明的归属 workspace（v1 / meta 未带则缺省） */
  v2Workspace?: string;
  /** 四段账本计数（v2 section 在场条目的标签计数；v1 恒空对象） */
  v2Sections: Partial<Record<DistillSection, number>>;
}
/**
 * 纯读定位 archived 侧车并算凭据（confirm 计划回显用；零写盘、零子进程）。
 * 定位失败回 { error }：侧车缺失是最常见的诚实态（无快照卡/搬移失败卡），
 * 文案如实说明「不静默假装导入过」并给回源机重出的指引。
 */
export declare function locateHippoSidecar(id: string, deps?: {
  dir?: string;
  home?: string;
}): HippoSidecarInfo | {
  error: string;
};
type HippoImportRunResult = {
  ok: true;
  dataDir: string;
  entries: number;
  note: string;
} | {
  ok: false;
  state: 'cli-missing' | 'import-failed';
  error: string;
};
/**
 * 导入执行器（absorb 的 confirm 闸通过后才调）：`hippo import <archived>/<id>.hippo.jsonl`。
 * - 子进程 env 钉 HIPPO_DATA_DIR=解析结果（与生产端同理由：hippo CLI 只认 env，不钉会开错库）；
 * - 幂等：hippo 层 dedup-reinforce（重复条目强化合并不覆盖）；执行器本身无状态可重入；
 * - v2 侧车兼容有实测背书（dsh-hippo transfer.ts:114-146 只取已知字段、缺 text 行按坏行
 *   跳过；0.3.0 CLI 对 v2 形态实测：meta 行 skipped 1、条目全数入库、退出码 0）；
 * - supersede 推翻链的旁路索引重建归属 hippo import 行为——本函数只取退出码，不深解析
 *   输出（材料在 import 返回值处截断），note 如实标注「推翻链以 hippo 侧为准」；
 * - CLI 缺席 / 非零退出 / 超时 → ok:false + 诚实指引（现状降级底座），不抛异常。
 */
export declare function hippoImportRun(info: HippoSidecarInfo, deps?: {
  runner?: HippoRunner;
  home?: string;
  dir?: string;
  now?: Date;
}): HippoImportRunResult;
//#endregion
//#region node_modules/.pnpm/@agent-handoff+readers@file+vendor+@agent-handoff+readers/node_modules/@agent-handoff/readers/dist/index.d.mts
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
  /** 归属适配器名：claude-code | codex | opencode | zcode | pi | workbuddy | cursor | grok | gemini | kimi | codebuddy | qoder | kiro | copilot | devin | mimo | aider | cline | continue | qwen | antigravity | openclaw | goose */
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
//#region src/providers.d.ts
declare const PROVIDERS: readonly [{
  readonly name: 'claude';
  readonly adapter: 'claude-code';
  readonly label: 'Claude Code';
  readonly outboundEligible: true;
  readonly icon: {
    readonly kind: 'mark';
    readonly mark: {
      readonly viewBox: '0 0 24 24';
      readonly tile: '#D97757';
      readonly paths: readonly [{
        readonly d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
        readonly fill: '#fff';
      }];
    };
  };
  readonly resume: {
    readonly id: 'resume-claude';
    readonly product: 'Claude Code';
    readonly description: '把一条 Claude Code 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器全量读取本地记录（含被替换/放弃分支的条目，thinking 块以 [thinking] 标记保留）；不复活 CLI、不回放工具调用。';
  };
}, {
  readonly name: 'codex';
  readonly adapter: 'codex';
  readonly label: 'Codex CLI';
  readonly outboundEligible: true;
  readonly icon: {
    readonly kind: 'mark';
    readonly mark: {
      readonly viewBox: '0 0 24 24';
      readonly tile: '#0f0f0f';
      readonly paths: readonly [{
        readonly d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
        readonly fill: '#fff';
      }];
    };
  };
  readonly resume: {
    readonly id: 'resume-codex';
    readonly product: 'Codex';
    readonly description: '把一条 Codex 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器排除 Codex 的 system / developer / reasoning / world-state / 跨 agent 记录。';
  };
}, {
  readonly name: 'opencode';
  readonly adapter: 'opencode';
  readonly label: 'OpenCode';
  readonly outboundEligible: true;
  readonly icon: {
    readonly kind: 'mark';
    readonly mark: {
      readonly viewBox: '0 0 512 512';
      readonly tile: '#131010';
      readonly paths: readonly [{
        readonly d: 'M384 416H128V96H384V416ZM320 160H192V352H320V160Z';
        readonly fill: '#fff';
      }];
    };
  };
  readonly resume: {
    readonly id: 'resume-opencode';
    readonly product: 'OpenCode';
    readonly description: '把一条 OpenCode 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id 或标题关键词。';
    readonly recoveryBoundary: '读取器只读 OpenCode 本地存储的会话记录；不复活进程、不回放存储的调用。';
  };
}, {
  readonly name: 'zcode';
  readonly adapter: 'zcode';
  readonly label: 'ZCode';
  readonly outboundEligible: true;
  readonly icon: {
    readonly kind: 'mark';
    readonly mark: {
      readonly viewBox: '0 0 30 30';
      readonly tile: '#2D2D2D';
      readonly paths: readonly [{
        readonly d: 'M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z';
        readonly fill: '#fff';
      }, {
        readonly d: 'M24.3 7.1L13.14 22.91L5.7 22.91L16.86 7.1Z';
        readonly fill: '#fff';
      }, {
        readonly d: 'M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z';
        readonly fill: '#fff';
      }];
    };
  };
  readonly resume: {
    readonly id: 'resume-zcode';
    readonly product: 'ZCode';
    readonly description: '把一条 ZCode 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id（支持短前缀）或标题关键词。';
    readonly recoveryBoundary: '读取器只读 ZCode 的 sqlite 库（readonly、随开随关，需 Node ≥22）；不回放调用、不复活 CLI；压缩段只是摘要标记，仍在库里的旧行保留。';
  };
}, {
  readonly name: 'pi';
  readonly adapter: 'pi';
  readonly label: 'Pi';
  readonly outboundEligible: true;
  readonly icon: {
    readonly kind: 'mark';
    readonly mark: {
      readonly viewBox: '0 0 800 800';
      readonly tile: '#27272a';
      readonly paths: readonly [{
        readonly d: 'M165.29 165.29H517.36V400H400V282.65H165.29Z';
        readonly fill: '#F09082';
      }, {
        readonly d: 'M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z';
        readonly fill: '#4D9ABF';
      }, {
        readonly d: 'M517.36 400H634.72V634.72H517.36Z';
        readonly fill: '#F1BE58';
      }];
    };
  };
  readonly resume: {
    readonly id: 'resume-pi';
    readonly product: 'Pi';
    readonly description: '把一条 Pi 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、JSONL 路径或标题关键词。';
    readonly recoveryBoundary: '读取器只沿 Pi 当前活跃叶子读取，排除 thinking、hooks、system 消息与扩展注入的记录。';
  };
}, {
  readonly name: 'workbuddy';
  readonly adapter: 'workbuddy';
  readonly label: 'WorkBuddy';
  readonly outboundEligible: true;
  readonly icon: {
    readonly kind: 'full';
    readonly svg: "<svg width=\"40\" height=\"40\" viewBox=\"0 0 40 40\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<g clip-path=\"url(#clip0_542_3370)\">\n<rect width=\"40\" height=\"40\" rx=\"20\" fill=\"url(#paint0_linear_542_3370)\"/>\n<g filter=\"url(#filter0_f_542_3370)\">\n<circle cx=\"31.3411\" cy=\"43.6183\" r=\"12.8704\" fill=\"#FFE355\" fill-opacity=\"0.49\" style=\"fill:#FFE355;fill:color(display-p3 1.0000 0.8891 0.3348);fill-opacity:0.49;\"/>\n</g>\n<path d=\"M28.5931 3.12762C28.9853 2.77585 29.0091 2.76226 29.2968 2.74499C29.7628 2.71096 30.1894 2.93488 30.916 3.59634C32.6132 5.13875 34.9769 8.30904 36.4462 11.0168L37.0138 12.0682L37.8156 12.4668C38.5896 12.8579 39.8593 13.6593 40.3898 14.0895C40.6297 14.2878 40.6638 14.2925 40.9133 14.1954C42.0388 13.7572 43.6506 14.3382 45.0727 15.7024C46.3529 16.9294 47.5794 19.026 48.0491 20.7757C48.1177 21.0574 48.2087 21.6628 48.2419 22.1134C48.349 23.6964 47.8414 24.9608 46.8637 25.5331C46.664 25.6484 46.6505 25.6795 46.6561 26.1774C46.7011 28.5481 46.0621 30.9144 44.7785 33.2221C43.3293 35.8133 40.7489 38.4945 37.2566 41.0199C35.3813 42.3846 30.9445 44.9701 28.9382 45.8778C24.1324 48.0414 20.2794 48.8709 16.9329 48.4609C14.9368 48.219 12.6769 47.44 11.34 46.5355C10.9885 46.2925 10.9325 46.2774 10.6637 46.3543C9.2327 46.7651 7.35867 45.9207 5.76659 44.1535C5.13165 43.4471 4.1065 41.7127 3.77404 40.7843C3.0054 38.6118 3.15852 36.6506 4.18236 35.4799C4.44671 35.1785 4.45511 35.1658 4.39735 34.6589C4.30195 33.8289 4.25837 32.6008 4.30192 31.808L4.33666 31.0674L3.22502 29.101C1.5033 26.0375 0.409325 23.4645 -0.012563 21.4992C-0.235219 20.4218 -0.221193 19.9436 0.0522186 19.5899C0.21871 19.3763 0.764928 19.1545 1.42322 19.0329C3.08041 18.742 6.69466 19.0056 10.7155 19.7155L11.1329 19.788L12.0511 18.976C13.5747 17.6264 14.587 16.8696 16.4531 15.706C18.3981 14.4891 20.5929 13.4877 23.0648 12.695L23.8577 12.4414L24.2939 11.2964C25.8547 7.17615 27.4533 4.13844 28.5931 3.12762ZM15.5182 24.243C13.7542 25.2615 12.8718 25.7706 12.2236 26.3413C9.59893 28.6526 8.61811 32.3134 9.73545 35.6274C10.0114 36.4457 10.5201 37.3283 11.5386 39.0923C12.5571 40.8564 13.0671 41.7383 13.6378 42.3864C15.9491 45.0112 19.6103 45.9929 22.9243 44.8755C23.7426 44.5995 24.6249 44.0899 26.3888 43.0714L36.5375 37.2121C38.3016 36.1936 39.184 35.6845 39.8321 35.1137C42.4568 32.8024 43.4373 29.1409 42.3198 25.8269C42.0438 25.0086 41.5342 24.1264 40.5158 22.3624C39.4973 20.5983 38.9882 19.7159 38.4175 19.0678C36.1062 16.4432 32.4454 15.4622 29.1314 16.5796C28.3131 16.8556 27.431 17.3651 25.6669 18.3836L15.5182 24.243Z\" fill=\"url(#paint1_linear_542_3370)\"/>\n<rect x=\"16.4961\" y=\"31.3344\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 16.4961 31.3344)\" fill=\"white\" style=\"fill:white;fill-opacity:1;\"/>\n<rect x=\"27.3125\" y=\"25.0894\" width=\"4.00904\" height=\"8.32646\" rx=\"2.00452\" transform=\"rotate(-30 27.3125 25.0894)\" fill=\"white\" style=\"fill:white;fill-opacity:1;\"/>\n</g>\n<defs>\n<filter id=\"filter0_f_542_3370\" x=\"7.47033\" y=\"19.7475\" width=\"47.742\" height=\"47.7416\" filterUnits=\"userSpaceOnUse\" color-interpolation-filters=\"sRGB\">\n<feFlood flood-opacity=\"0\" result=\"BackgroundImageFix\"/>\n<feBlend mode=\"normal\" in=\"SourceGraphic\" in2=\"BackgroundImageFix\" result=\"shape\"/>\n<feGaussianBlur stdDeviation=\"5.50019\" result=\"effect1_foregroundBlur_542_3370\"/>\n</filter>\n<linearGradient id=\"paint0_linear_542_3370\" x1=\"20\" y1=\"0\" x2=\"20\" y2=\"40\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"#0EC8A9\" style=\"stop-color:#0EC8A9;stop-color:color(display-p3 0.0565 0.7837 0.6625);stop-opacity:1;\"/>\n<stop offset=\"1\" stop-color=\"#01C886\" style=\"stop-color:#01C886;stop-color:color(display-p3 0.0021 0.7858 0.5246);stop-opacity:1;\"/>\n</linearGradient>\n<linearGradient id=\"paint1_linear_542_3370\" x1=\"14.6642\" y1=\"11.0783\" x2=\"33.3762\" y2=\"43.4885\" gradientUnits=\"userSpaceOnUse\">\n<stop stop-color=\"white\" stop-opacity=\"0.8\" style=\"stop-color:white;stop-opacity:0.8;\"/>\n<stop offset=\"0.437689\" stop-color=\"white\" style=\"stop-color:white;stop-opacity:1;\"/>\n</linearGradient>\n<clipPath id=\"clip0_542_3370\">\n<rect width=\"40\" height=\"40\" rx=\"20\" fill=\"white\" style=\"fill:white;fill-opacity:1;\"/>\n</clipPath>\n</defs>\n</svg>";
  };
  readonly resume: {
    readonly id: 'resume-workbuddy';
    readonly product: 'WorkBuddy';
    readonly description: '把一条 WorkBuddy 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只导入受支持的 WorkBuddy transcript / 存储记录，永不回放存储的调用。';
  };
}, {
  readonly name: 'cursor';
  readonly adapter: 'cursor';
  readonly label: 'Cursor';
  readonly outboundEligible: true;
  readonly icon: {
    readonly kind: 'mark';
    readonly mark: {
      readonly viewBox: '0 0 24 24';
      readonly tile: '#1a1a1a';
      readonly paths: readonly [{
        readonly d: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23";
        readonly fill: '#fff';
      }];
    };
  };
  readonly resume: {
    readonly id: 'resume-cursor';
    readonly product: 'Cursor';
    readonly description: '把一条 Cursor 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只导入受支持的 Cursor transcript / store 记录，永不回放存储的调用。';
  };
}, {
  readonly name: 'grok';
  readonly adapter: 'grok';
  readonly label: 'Grok CLI';
  readonly outboundEligible: true;
  readonly icon: {
    readonly kind: 'mark';
    readonly mark: {
      readonly viewBox: '0 0 256 246';
      readonly tile: '#111111';
      readonly paths: readonly [{
        readonly d: "M63.8307299,56.8426545 C91.2989169,29.362978 131.465298,21.9776085 165.542128,34.9726459 L167.855892,35.8902557 C175.501463,38.7335174 182.164746,42.7796414 187.363427,46.5414469 L158.506099,59.882758 C131.637157,48.5973415 100.857492,56.2740175 82.0711204,75.0832754 C56.6656274,100.496833 51.5320736,144.566967 81.3069473,173.04336 L-1.42108547e-14,245.764227 C4.29613789,239.840925 9.45698399,234.190695 14.7493257,228.586421 L20.5645541,222.456072 L23.1726477,219.681571 C38.703877,203.027306 51.983468,185.912092 43.6693415,162.973056 L42.9033683,160.992465 C28.3109637,125.495663 36.8086459,83.896995 63.8307299,56.8426545 Z M220.785826,35.2560304 L256,0 L245.871984,14.068605 C224.778304,43.78544 215.415895,62.4930162 224.761831,102.727911 L224.69655,102.66263 C231.927394,133.390838 224.194269,167.466048 199.225391,192.464878 C167.746834,224.002573 117.372848,231.022982 75.8893821,202.634909 L104.811992,189.227703 C131.287711,199.638122 160.254097,195.066907 181.071863,174.224565 C201.890397,153.381454 206.565294,123.024196 196.101882,97.7634735 C194.113496,92.9733751 188.149873,91.7706665 183.977257,94.8542395 L98.8698734,157.755289 L220.785826,35.1466653 L220.785826,35.2560304 Z";
        readonly fill: '#fff';
      }];
    };
  };
  readonly resume: {
    readonly id: 'resume-grok';
    readonly product: 'Grok';
    readonly description: '把一条 Grok 会话拉进当前会话，生成六段交接卡接手工作；可附会话 id、会话目录、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只用 Grok 可见的 updates.jsonl 流，永不读 chat_history.jsonl 原始模型上下文。';
  };
}, {
  readonly name: 'gemini';
  readonly adapter: 'gemini';
  readonly label: 'Gemini CLI';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-gemini';
    readonly product: 'Gemini CLI';
    readonly description: '把一条 Gemini CLI 会话拉进当前会话，生成六段交接卡接手工作；本地记录是新旧双格式 JSONL/JSON，子代理会话单独存盘，可附会话 id（记录路径）、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读 Gemini CLI 本地 chats/ 下的会话文件（JSONL 新格式 / 整块 JSON 旧格式，含子代理会话目录）；info/error/warning CLI 提示与斜杠命令行不进对话流；只读不写、不复活 Gemini CLI 进程。';
  };
}, {
  readonly name: 'kimi';
  readonly adapter: 'kimi';
  readonly label: 'Kimi Code';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-kimi';
    readonly product: 'Kimi Code';
    readonly description: '把一条 Kimi Code 会话拉进当前会话，生成六段交接卡接手工作；记录是 wd_<目录>/<会话>/agents/main/wire.jsonl 事件流，可附会话目录名、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读各会话 agents/main/wire.jsonl 可见事件流（turn.prompt / 文本与 think 内容块 / 工具调用与结果），think 块以 [thinking] 标记保留；伴生 state.json / session_index.jsonl 只取标题与工作目录；只读不写、不复活 Kimi CLI 进程。';
  };
}, {
  readonly name: 'codebuddy';
  readonly adapter: 'codebuddy';
  readonly label: 'CodeBuddy';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-codebuddy';
    readonly product: 'CodeBuddy';
    readonly description: '把一条 CodeBuddy 会话拉进当前会话，生成六段交接卡接手工作；主会话是一文件一会的 JSONL，可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读 projects 下 cwd 转义目录一层的主会话 JSONL（WorkBuddy 内核记录族）；子代理 transcript 不在本期范围；只读不写、不回放存储的调用。';
  };
}, {
  readonly name: 'qoder';
  readonly adapter: 'qoder';
  readonly label: 'Qoder';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-qoder';
    readonly product: 'Qoder';
    readonly description: '把一条 Qoder 会话拉进当前会话，生成六段交接卡接手工作；主会话是一文件一会的 JSONL（与 Claude Code 同族记录），可附会话 id（记录路径）、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读 projects 下项目目录一层的主会话 JSONL，cwd 取自记录本身（目录名反解有歧义，不猜）；子代理 transcript 不读；只读不写、不复活 Qoder。';
  };
}, {
  readonly name: 'kiro';
  readonly adapter: 'kiro';
  readonly label: 'Kiro';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-kiro';
    readonly product: 'Kiro';
    readonly description: '把一条 Kiro 会话拉进当前会话，生成六段交接卡接手工作；CLI 会话是 <uuid>.jsonl 事件流（另有 .json/.history 伴生但不读），可附会话 id、JSONL 路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读 sessions/cli 下的 <uuid>.jsonl 事件流（Prompt / AssistantMessage / ToolResults）；伴生 .json 与 .history 不读；事件流没有 cwd 字段时如实留空；只读不写、不复活 Kiro。';
  };
}, {
  readonly name: 'copilot';
  readonly adapter: 'copilot';
  readonly label: 'Copilot CLI';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-copilot';
    readonly product: 'GitHub Copilot CLI';
    readonly description: '把一条 GitHub Copilot CLI 会话拉进当前会话，生成六段交接卡接手工作；记录是 ~/.copilot/session-store.db 明文 SQLite（sessions/turns 表），可附会话 id 或标题关键词。';
    readonly recoveryBoundary: '读取器只读 session-store.db（node:sqlite readonly、随开随关，需 Node ≥22）；列名探测不中时如实报降级，不粉饰成空会话；不回放调用、不复活 Copilot CLI。';
  };
}, {
  readonly name: 'devin';
  readonly adapter: 'devin';
  readonly label: 'Devin CLI';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-devin';
    readonly product: 'Devin CLI';
    readonly description: '把一条 Devin CLI 会话拉进当前会话，生成六段交接卡接手工作；记录是 XDG 数据根下 cli/sessions.db（sessions 表带 main_chain_id 血缘字段），可附会话 id 或标题关键词。';
    readonly recoveryBoundary: '读取器只读 sessions.db（node:sqlite readonly、随开随关，需 Node ≥22）；链式会话按 sessions 表逐条展示、链首尾不合并；逐轮记录表探测不中时正文解析为空并如实浮出 note。';
  };
}, {
  readonly name: 'mimo';
  readonly adapter: 'mimo';
  readonly label: 'MiMo Code';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-mimo';
    readonly product: 'MiMo Code';
    readonly description: '把一条 MiMo Code（小米）会话拉进当前会话，生成六段交接卡接手工作；记录是 ~/.local/share 应用数据目录的 SQLite（session 表），目录名未完全核实、候选目录逐个扫描，可附会话 id 或标题关键词。';
    readonly recoveryBoundary: '读取器只读候选目录扫描命中的明文库（node:sqlite readonly、随开随关，需 Node ≥22）；目录名未完全核实——全不命中时 supported=false 并诚实标注（不盲猜固定路径），确认后可用 HANDOFF_ROOT_MIMO 指定库文件；不回放调用、不复活 MiMo Code。';
  };
}, {
  readonly name: 'aider';
  readonly adapter: 'aider';
  readonly label: 'Aider';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-aider';
    readonly product: 'Aider';
    readonly description: '把一条 Aider 会话拉进当前会话，生成六段交接卡接手工作；无会话库——历史在各 git 项目根的 .aider.chat.history.md / .aider.input.history，从起点向上探测项目根，可附记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读项目根的历史文件：markdown 对话历史为半结构化日志，`> ` 行记用户轮、其余正文记 assistant 轮，解析尽力而为（工具输出/截断段可能混入）并以 note 标注；只读不写、不复活 Aider。';
  };
}, {
  readonly name: 'cline';
  readonly adapter: 'cline';
  readonly label: 'Cline';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-cline';
    readonly product: 'Cline';
    readonly description: '把一条 Cline（VS Code 扩展）任务拉进当前会话，生成六段交接卡接手工作；记录是 globalStorage/tasks/<taskId>/api_conversation_history.json（Anthropic 风格消息数组），可附任务 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读各 VS Code 变体 globalStorage（saoudrizwan.claude-dev / cline.cline）下的 api_conversation_history.json；ui_messages.json（say/ask UI 事件流）不读；api 历史没有 cwd 字段时如实留空；只读不写、不复活 Cline。';
  };
}, {
  readonly name: 'continue';
  readonly adapter: 'continue';
  readonly label: 'Continue';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-continue';
    readonly product: 'Continue';
    readonly description: '把一条 Continue（IDE 扩展）会话拉进当前会话，生成六段交接卡接手工作；记录是 ~/.continue/sessions/ 的 sessions.json 索引 + <sessionId>.json 会话文件，可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读 sessions 目录下的索引与会话文件（history 消息流取 user/assistant 文本，system/tool 角色跳过）；索引缺席时退化为目录扫描；没有 cwd 字段时只在 workspace 路径在场时尽力提取，否则留空；只读不写、不复活 Continue。';
  };
}, {
  readonly name: 'qwen';
  readonly adapter: 'qwen';
  readonly label: 'Qwen Code';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-qwen';
    readonly product: 'Qwen Code';
    readonly description: '把一条 Qwen Code（阿里）会话拉进当前会话，生成六段交接卡接手工作；本地记录新旧双布局（tmp/ 的 Gemini 族 JSON/JSONL、projects/ 的 ChatRecord JSONL，都探测），可附会话 id（记录路径）、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读 ~/.qwen 双布局下的会话记录（tmp/ 走 Gemini 族归一，projects/ 按 ChatRecord 归一：agent_mention 等控制 subtype 与代提交不进流，thought 块以 [thinking] 标记保留，cwd 取自记录本身）；QWEN.md 记忆体系不在会话轴、不读；只读不写、不复活 Qwen Code 进程。';
  };
}, {
  readonly name: 'antigravity';
  readonly adapter: 'antigravity';
  readonly label: 'Antigravity';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-antigravity';
    readonly product: 'Antigravity';
    readonly description: '把一条 Antigravity（Google）会话拉进当前会话，生成六段交接卡接手工作；正文是 brain 目录的 transcript.jsonl（antigravity-cli 与 antigravity 两个 brain 布局都探测），conversation_summaries.db 只作工作目录索引，可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读 brain 目录的 transcript JSONL（USER_EXPLICIT 输入剥 <USER_REQUEST> 壳、MODEL 回复、tool_calls 摘要轮，thinking 以 [thinking] 标记保留）；跨端索引库只取 workspace 映射，缺席/探测不中时 cwd 如实留空；只读不写、不复活 Antigravity。';
  };
}, {
  readonly name: 'openclaw';
  readonly adapter: 'openclaw';
  readonly label: 'OpenClaw';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-openclaw';
    readonly product: 'OpenClaw';
    readonly description: '把一条 OpenClaw 会话拉进当前会话，生成六段交接卡接手工作；新版是各 agent 的 openclaw-agent.sqlite（session_nodes + transcript_events），旧版是 sessions/ 的 JSONL 与 sessions.json 索引，两形态都探测，可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读各 agent 的会话库（node:sqlite readonly、随开随关，需 Node ≥22）与旧版 transcript JSONL，只取 user/assistant 文本；压缩（zstd）事件行在缺 zstd 支持的 Node 上跳过、解析为空时如实按不可用标注；不回放调用、不复活 OpenClaw。';
  };
}, {
  readonly name: 'goose';
  readonly adapter: 'goose';
  readonly label: 'Goose';
  readonly outboundEligible: false;
  readonly icon: {
    readonly kind: 'none';
  };
  readonly resume: {
    readonly id: 'resume-goose';
    readonly product: 'Goose';
    readonly description: '把一条 Goose（Block）会话拉进当前会话，生成六段交接卡接手工作；数据目录按候选探测（上游应用策略推导的常见路径，HANDOFF_ROOT_GOOSE 可直指），新版 sessions.db / 旧版 JSONL 都探测，可附会话 id、记录路径或标题关键词。';
    readonly recoveryBoundary: '读取器只读探测命中的 sessions/ 存储（sessions.db 走 node:sqlite readonly、随开随关，需 Node ≥22；JSONL 只取 text 块）；候选全不命中时 supported=false 并诚实标注「路径按上游源码推导、未在实机核实，待社区确认」——绝不臆造固定路径；不回放调用、不复活 Goose。';
  };
}];
/** 二十三家 provider 名的字面量并集类型（注册表声明序） */
type ProviderName = (typeof PROVIDERS)[number]['name'];
//#endregion
//#region src/foreign.d.ts
/** 面向用户的二十三家提供方名（providers.ts 注册表派生，顺序即注册表声明序） */
export declare const FOREIGN_PROVIDERS: readonly ForeignProvider[];
type ForeignProvider = ProviderName;
/** 面向用户的 provider 名 → readers 适配器名（注册表派生；claude 是 claude-code 的别名，设置卡支持矩阵同用） */
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
/** 面板浏览的轻量候选行（不含轮数——数轮数要全量解析每个会话，列表页付不起 O(总字节)） */
type ForeignListRow = {
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  kind: string;
};
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
type ForeignListResult = {
  ok: true;
  provider: string;
  total: number;
  sessions: ForeignListRow[];
  note?: string;
} | {
  ok: false;
  error: string;
};
/**
 * 面板浏览的会话列表（轻量）：只走发现层（SessionRef 元数据），不数轮数、不读内容。
 * 与工具侧 action=list 的分工：工具的候选带用户轮数帮模型挑，面板的行只要标题/时间/目录。
 * 假 0 哨兵（存储布局迁移提示）随 note 下发，面板浮出与支持矩阵同口径。
 */
export declare function foreignSessionsList(args: {
  provider?: string;
  limit?: number;
}, deps?: ForeignReaders, env?: ForeignEnv): Promise<ForeignListResult>;
type ForeignResolveResult = {
  ok: true;
  ref: SessionRef;
} | {
  ok: false;
  error: string;
  candidates?: ForeignListRow[];
};
/**
 * 精确解析一条会话引用（ 一键接管的后端步骤）：门控与工具同口径，
 * 解析失败（not-found/ambiguous）回规范错误值；ambiguous 附候选。
 */
export declare function foreignResolveOne(args: {
  provider?: string;
  reference?: string;
}, deps?: ForeignReaders, env?: ForeignEnv): Promise<ForeignResolveResult>;
type ForeignPreviewResult = {
  ok: true;
  provider: string;
  summary: ForeignSummary;
  skeleton: ForeignSkeleton;
  /** 空会话等降级说明（诚实浮出，不粉饰成正常） */
  note?: string;
} | {
  ok: false;
  error: string;
  candidates?: ForeignListRow[];
};
/**
 * 面板浏览的单会话预览：结构化摘要 + 骨架六段素材（与工具 action=show 同源同料），
 * 但永不返回 turns 原文——原文分页是模型的深读通道，面板只做「挑得出对的那条」。
 */
export declare function foreignSessionPreview(args: {
  provider?: string;
  reference?: string;
}, deps?: ForeignReaders, env?: ForeignEnv): Promise<ForeignPreviewResult>;
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
//#region src/sync.d.ts
interface SyncConfig {
  enabled: boolean;
  /** 用户配置的 git 仓库地址（https / ssh / git@host:path / 本地路径），永不存凭据 */
  remote: string;
}
/** sync.json 路径（HANDOFF_HOME 内，随同步分发——B 机启用时可直接采纳同地址） */
export declare function syncConfigPath(dir?: string): string;
/** 读同步配置：文件缺失/损坏 fail-open 回未启用（同 loadSwitches 纪律），损坏必 console.warn */
export declare function loadSyncConfig(dir?: string): SyncConfig;
/** 写同步配置：tmp + rename 原子替换（saveSwitches 同模板）；写入前校验地址 */
export declare function saveSyncConfig(cfg: SyncConfig, dir?: string): void;
/**
 * 仓库地址校验：拒绝 userinfo 形态（`user:pass@`）——secretscan 对 URL 内嵌凭据
 * 零覆盖，插件也永不存储凭据，凭据交给系统 git credential helper / ssh agent。
 * 允许：https://、ssh://、git://、file://、git@host:path（scp 形态）、本地路径。
 * 返回 trim 后的地址；不合法抛中文错。
 */
export declare function validateRemoteUrl(url: string): string;
/** 红折展示：userinfo 段打码（防御性——保存时已拒绝，展示仍再折一次） */
export declare function redactRemote(url: string): string;
interface SyncOutcome {
  ok: boolean;
  action: string;
  /** 动作后状态摘要（供面板/工具直显） */
  detail?: string;
  ahead?: number;
  behind?: number;
  error?: string;
}
/** 启用同步：init/收编 + remote + 本地先提交 + 远端非空先合并再推（远端空仓直接首推） */
export declare function syncSetup(url: string, dir?: string, opts?: {
  timeoutMs?: number;
}): Promise<SyncOutcome>;
/** pull：本地先提交 → fetch → 合并（冲突 abort 诚实报错） */
export declare function syncPull(dir?: string, opts?: {
  timeoutMs?: number;
}): Promise<SyncOutcome>;
/** push：本地提交 + 推送 */
export declare function syncPush(dir?: string, opts?: {
  timeoutMs?: number;
}): Promise<SyncOutcome>;
/** 立即同步 = pull（拿别人的）→ push（给别人的），一步到位 */
export declare function syncNow(dir?: string, opts?: {
  timeoutMs?: number;
}): Promise<SyncOutcome>;
/** 同步状态（type 别名：客户端与工具面都要把它当 JSON 值传递，interface 缺隐式索引签名会挂 defineTool） */
type SyncStatus = {
  enabled: true;
  /** 红折后的仓库地址 */
  remote: string;
  /** 待推提交数（上次同步记录） */
  ahead: number;
  /** 待拉提交数（上次同步记录） */
  behind: number;
  lastSyncAt?: string;
  lastError?: string;
  /** 同步范围内本地未提交文件数（现算，git status，零网络） */
  dirtyFiles: number;
  /** home 是否已是仓库（未 init 前无从谈脏计数） */
  repoReady: boolean;
};
/** 组装同步状态（buildState 调用；未启用 → undefined，客户端整个块不渲染） */
export declare function syncStatusOf(dir?: string): SyncStatus | undefined;
//#endregion
//#region src/envbackup.d.ts
/** 相对路径合法性：正斜杠、无 .. 段、非绝对、无盘符（恢复路径的穿越硬闸） */
export declare function validateRelPath(p: string): string;
interface ScopeFile {
  path: string;
  category: string;
  secret: boolean;
  bytes: number;
}
/** 收集备份清单：scope 命中且磁盘上真实存在的文件（缺失容错——没有就跳过，不算错） */
export declare function collectScopeFiles(root?: string): ScopeFile[];
export declare function envBackupDir(dir?: string): string;
/** type 别名：工具/客户端 JSON 值面需要隐式索引签名（interface 会挂 defineTool） */
type BackupRow = {
  file: string;
  bytes: number;
  /** 文件名内嵌的时间戳（yyyyMMdd-HHMM） */
  at: string;
};
/** 列备份文件（只读目录，不解密）。按内嵌时间戳新→旧排：标签件（auto-upgrade-*）不因
 * 前缀字典序压过更新的手动备份——缺省取「最近一次」的路径（configinject / 配置轴出卡）口径不失真 */
export declare function listBackups(dir?: string): BackupRow[];
/** 备份清单行（容器 manifest 的对外形态；配置轴出卡 / dry diff 共用） */
type ManifestFileRow = {
  path: string;
  bytes: number;
  sha256: string;
  category: string;
};
interface BackupManifestRead {
  ok: true;
  /** 备份文件名（.dshenv） */
  file: string;
  /** 密文包本体字节数（卡上「指针」的 bytes 口径） */
  bytes: number;
  createdAt: string;
  host: string;
  secretCount: number;
  secretHits: number;
  /** 清单行（path/bytes/sha256/category，容器内解密所得） */
  files: ManifestFileRow[];
}
/**
 * 读一份备份的加密清单：口令解密容器取 manifest，**不触碰任何 blob 内容**——
 * 配置轴出卡（handoff_env action=card / pushConfigCard）只把清单+指针写上卡，
 * 密文 blob 原样留在 env-backup/。错口令 = GCM 认证失败诚实报错（同解包口径）。
 */
export declare function readBackupManifest(file: string, passphrase: string, dir?: string): BackupManifestRead;
/** 备份包内单条目的原文（配置写回 inject 的读取形态；不落盘，纯读） */
interface BackupEntryBlob {
  /** 包内相对 user home 的路径（正斜杠） */
  path: string;
  category: string;
  content: Buffer;
}
/**
 * 读备份包内若干条目的原文：口令解密容器后按谓词挑条目取 blob（**只读**——
 * 与 readBackupManifest 同口径，错口令 = GCM 认证失败诚实报错，不吐半个字节）。
 * handoff_env action=inject 用它取 `.mcp.json` 与 `.agents/skills/**` 两类源条目；
 * 谓词缺省 = 全部条目（调用方自己过滤也行）。
 *
 * 选中条目的路径过 validateRelPath（与 applyRestore 同款穿越闸：..、绝对路径、
 * 盘符一律拒收）——容器格式公开可伪造，敌意包不得经注入链把文件写出备份范围外。
 */
export declare function readBackupEntryBlobs(file: string, passphrase: string, dir?: string, pred?: (rel: string) => boolean): BackupEntryBlob[];
interface BackupResult {
  ok: true;
  file: string;
  bytes: number;
  files: number;
  secretCount: number;
  secretHits: number;
  detail: string;
}
/**
 * 立即备份：收集 → 加密 → 落 env-backup/ → 修剪。
 * 无标签 = 手动备份语义（全局留 3，同现有口径不变）；
 * 带标签（如 auto-upgrade）= 标记快照语义：文件名带前缀、只留该标签最近 1 份、
 * 全局 keep-3 不跑——自动快照绝不挤掉手动备份。
 */
export declare function createBackup(passphrase: string, dir?: string, root?: string, label?: string): BackupResult;
type RestoreDiffRow = {
  path: string;
  action: 'create' | 'overwrite' | 'same';
  category: string;
  diskBytes?: number;
  packBytes: number;
};
interface DryRunResult {
  ok: true;
  file: string;
  createdAt: string;
  host: string;
  secretCount: number;
  diff: RestoreDiffRow[];
  creates: number;
  overwrites: number;
  same: number;
}
/** 还原预演：解密 + 与磁盘逐文件比对（三态：新建/覆盖/相同）——不写任何盘 */
export declare function dryRunRestore(file: string, passphrase: string, dir?: string, root?: string): DryRunResult;
interface ApplyResult {
  ok: true;
  file: string;
  applied: number;
  checkpointDir: string;
  detail: string;
}
/** 确认还原：checkpoint 被覆盖原物 → 逐文件 tmp+rename 落盘 → 报告 */
export declare function applyRestore(file: string, passphrase: string, dir?: string, root?: string): ApplyResult;
/** 回滚：把 checkpoint 里的原物写回去 */
export declare function rollbackRestore(checkpointDir: string, dir?: string, root?: string): {
  ok: true;
  restored: number;
  detail: string;
};
/** 升级保险快照的文件名标签（前缀 auto-upgrade-；独立保留策略只认这个前缀） */
export declare const AUTO_UPGRADE_LABEL = "auto-upgrade";
/** 宿主版本基线文件：sync.json 的旁伴新键。本机记录、不随换机同步分发（各机升级节奏
 * 不同；不入 sync.ts SYNC_PATHS 白名单——勿加，加了会让 B 机继承 A 机的版本基线）。 */
export declare function envBackupStatePath(dir?: string): string;
interface EnvBackupStateFile {
  /** 上次见到的宿主运行时版本；缺失 = 首跑（无基线） */
  lastHostVersion?: string;
  /** 基线记录时刻（ISO） */
  at?: string;
}
/** 读版本基线：文件缺失/损坏 fail-open 回空（= 首跑重记基线，不打快照不误删），损坏必 console.warn */
export declare function readEnvBackupState(dir?: string): EnvBackupStateFile;
/** 写版本基线：tmp + rename 原子替换（saveSyncState 同模板）；尽力而为——失败不抛出
 * 不清盘，最坏后果是下次启动重记/重打一份（保留策略只留最近一份，自愈）。 */
export declare function writeEnvBackupState(state: EnvBackupStateFile, dir?: string): void;
/**
 * 宿主运行时版本源（勘察结论）：`@deepseek-ai/dsh-app-boot` 的 getDshRuntimeVersion()——
 * 读当前加载的 app-boot 包自身 package.json 的 version，与宿主插件兼容闸（engines.dsh）
 * 对比的是同一个值，随宿主升级自动前进。懒加载 + 运行时拼接 specifier（防打包器把
 * 可选宿主包当静态依赖解析成硬依赖）；任何一步不可达回 null——调用方把 null 传给
 * maybeAutoUpgradeSnapshot 即 skipped，绝不误打。
 */
export declare function resolveHostRuntimeVersion(): Promise<string | null>;
interface AutoUpgradeSnapshotOpts {
  /** HANDOFF_HOME（版本基线文件与 env-backup/ 所在；缺省 ~/.handoff） */
  dir?: string;
  /** 备份范围根（user home），透传 createBackup */
  root?: string;
  /** 调用方既有已存口令机制注入的口令（≥8 位）；缺失/过短 = skip（绝不新增交互、绝不落盘） */
  passphrase?: string;
}
/** 三态返回：created=打了快照 / same=版本没变 / skipped=没打（reason 给机器可读原因，detail 给人看） */
type AutoUpgradeSnapshotValue = {
  action: 'created' | 'same' | 'skipped';
  reason?: string;
  file?: string;
  bytes?: number;
  detail?: string;
};
/**
 * 宿主版本变化 → 自动打升级保险快照（启动时接线调用，不新增任何交互）：
 * 1. 版本源不可读（null/空）→ skipped('host-version-unreadable')，基线不动、快照不打；
 * 2. 首跑（无基线）→ 只记版本，skipped('first-run')——无基线不折腾；
 * 3. 版本相同 → same，什么都不做；
 * 4. 版本变化 + 无已存口令 → skipped('no-passphrase') 且基线不推进（事件保持待办）；
 * 5. 版本变化 + 有口令 → createBackup(auto-upgrade 标签)，成功才推进基线并返回 created；
 *    失败 → skipped('backup-failed') 基线不推进（下次启动重试）。
 * 保留策略：自动快照只留最近一份（标签内修剪），手动备份绝不被自动流程动。
 */
export declare function maybeAutoUpgradeSnapshot(hostVersion: string | null | undefined, opts?: AutoUpgradeSnapshotOpts): AutoUpgradeSnapshotValue;
//#endregion
//#region src/inboxtriage.d.ts
/** pins.json 文件名（置于 <HANDOFF_HOME>/ 下，与 config.json/lifecycle.jsonl 同屋） */
export declare const PINS_FILE = "pins.json";
/** 置顶清单容量封顶：超限丢最旧（at 最小）——sidecar 不做无界增长 */
export declare const PINS_CAP = 500;
/** pins.json 路径：HANDOFF_HOME 优先，否则 ~/.handoff（resolveHome 同款解析） */
export declare function pinsPath(dir?: string): string;
/** 置顶一张卡（幂等：重复置顶只刷新时间戳）。id 为空回规范错误值 */
export declare function setPin(id: string, dir?: string, now?: Date): {
  ok: boolean;
  error?: string;
};
/** 解除置顶：未置顶回规范错误值（诚实两态——「本来就没置顶」不是成功解除） */
export declare function unsetPin(id: string, dir?: string): {
  ok: boolean;
  error?: string;
};
/**
 * 列当前有效的置顶卡 id（新置顶在前，at 降序）。
 * 有效性判据 = pending/<id>.md 还在盘上：卡被消费（loadCard 搬走）或弃置
 * （dismiss 搬去 archived）后 pin 自动失效，**不报错**；失效条目顺手从
 * sidecar 清掉（懒清理，写失败静默——下次 list 再试，视图语义不受影响）。
 */
export declare function listPins(dir?: string): string[];
/** 单卡是否置顶（对 listPins 结果判定——无效 pin 在 list 时已被清理） */
export declare function isPinned(id: string, dir?: string): boolean;
/** 单卡最多返回的命中行数（正文命中的摘要是给人扫一眼定位的，不是全文回传） */
export declare const BODY_HIT_LINES_MAX = 5;
/** 单条命中行摘要的最大长度（超出截断加省略号） */
export declare const BODY_LINE_SNIPPET_MAX = 160;
/** 正文扫描尺寸闸：与 core MAX_CARD_BYTES / settings.buildState 同口径——
 * 巨文件不全量读进内存；core 的 listDirCards 已把超尺寸卡挡在 cards 外，
 * 这里再闸一次防「列表与读取之间文件被换大」的竞态窗口 */
export declare const SEARCH_MAX_CARD_BYTES: number;
interface InboxSearchOptions {
  /** true = 逐张读 .md 全文匹配并产出命中行摘要；缺省 = 只匹配元字段（不读正文全文留存） */
  includeBody?: boolean;
  /** HANDOFF_HOME（测试注入）；缺省走 resolveHome 环境解析 */
  dir?: string;
}
interface InboxSearchHit {
  id: string;
  agent: string;
  title: string;
  project: string;
  /** 命中面：meta=编号/标题/来源/项目；body=.md 全文（含 frontmatter）命中 */
  where: 'meta' | 'body' | 'meta+body';
  /** 正文命中行摘要（至多 BODY_HIT_LINES_MAX 行，每行截 BODY_LINE_SNIPPET_MAX）；meta 命中为空数组 */
  lines: string[];
}
interface InboxSearchResult {
  /** 原样回显的查询词（trim 前） */
  query: string;
  includeBody: boolean;
  /** 实际扫描的卡数（坏卡/重复卡剔除后） */
  scanned: number;
  /** 因尺寸闸跳过正文扫描的卡 id（诚实暴露：这些卡可能含查询词但没扫，不静默漏） */
  skippedOversize: string[];
  hits: InboxSearchHit[];
  /** 收件箱整体不可读时的规范错误值（hits 为空；单卡读失败不进这里，只降级该卡正文） */
  error?: string;
}
/**
 * 收件箱检索：query 与卡元字段（编号/标题/来源 agent/项目）大小写不敏感子串
 * 匹配；includeBody 时再逐张读 .md 全文匹配（167 张 × 几 KB 全内存毫秒级，
 * 零索引——按卡数线性扫，不为这个量级建倒排）。返回命中 id + 命中行摘要。
 *
 * 防御：
 * - query trim 后为空 → 空命中、scanned=0（不做全量枚举——空查询回全屏是 footgun）；
 * - 同 frontmatter id 的重复文件只扫首次出现（settings.buildState 同款）；
 * - 单卡读失败 = 该卡正文不可扫（meta 命中仍有效），不拦其余卡；
 * - 枚举失败 = 整体 error 规范值（与 state.inboxError 同语义），绝不抛出。
 */
export declare function searchInbox(query: string, opts?: InboxSearchOptions): InboxSearchResult;
interface RestoreResult {
  ok: boolean;
  /** 实际搬回 pending 的文件份数 */
  moved?: number;
  error?: string;
}
/**
 * 弃置恢复：把一张已弃置卡（dismissPending 搬进 archived/ 的整卡）按原路径搬回
 * pending/，让它在收件箱重新可见、可取件。搬运清单 = dismissPending 同一扩展名
 * 枚举（.md/.envelope.json/.patch/.patch.gz/.hippo.jsonl）+ gzip 分块名单扫
 * （<id>.patch.NNN.gz，固定枚举盖不住带序号的形态）。
 *
 * 语义细节：
 * - archived/ 没有这张卡的任何形态 → 规范错误值（可能从未 dismiss、已被恢复、
 *   或已被 clearArchived 清掉）；
 * - pending 已有同名文件（同 id 卡被重新 push 过）→ **一次都不搬**并报错——
 *   rename 会静默覆盖，覆盖即毁掉活卡，违背恢复语义（预检全部通过才动第一份）；
 * - 成功后写 lifecycle 一条 stage='write' reason='restored' 正向回执
 *   （target=卡 id，detail=搬运份数，不落卡正文）；部分失败不落账（卡不完整）。
 * 路径安全：id 消毒与 dismissPending 同款。
 */
export declare function restoreFromArchived(id: string, dir?: string, now?: Date): RestoreResult;
//#endregion
//#region src/sessiondoctor.d.ts
/** 发现严重级：error=确定性破缺 / warn=真实缺陷不阻断取件 / info=预期滚动的审计残留 */
type DoctorSeverity = 'error' | 'warn' | 'info';
/** 发现种类闭集（新增 = 改这里 + 头注三类检查清单 + 测试） */
export declare const DOCTOR_KINDS: readonly ['corrupt', 'shape', 'orphan-sidecar', 'chain-dangling', 'chain-cycle', 'chain-fork'];
type DoctorKind = (typeof DOCTOR_KINDS)[number];
interface DoctorIssue {
  kind: DoctorKind;
  /** 问题主体的可寻址名：卡 id / 侧车 owner id / 文件名（id 不可辨时） */
  id: string;
  /** 发现细节（文件名/原因/建议去向），不落卡正文 */
  detail: string;
  severity: DoctorSeverity;
}
interface DoctorReport {
  /** issues 为空 = true（零发现）；扫描自身降级以 notes 如实附注 */
  ok: boolean;
  issues: DoctorIssue[];
  /** 扫描覆盖面（原始计数，含损坏项——口径是「见到多少」，不是「健康多少」） */
  scanned: {
    pendingCards: number;
    archivedCards: number;
    pendingSidecars: number;
    archivedSidecars: number;
  };
  /** 扫描自身降级附注（目录/单项内部异常）；零降级时缺省。不冒充总线发现 */
  notes?: string[];
}
/** 侧车家族：从文件名取 owner id；非协议侧车名（.claim/杂项）返回 null 不进体检闭集
 *（.claim 由 core sweepClaims 自愈；其余杂项文件不是协议面） */
export declare function sidecarOwnerOf(name: string): string | null;
/**
 * 总线只读体检：pending/ + archived/ 全量逐张（损坏段 + 形态）→ 孤儿侧车跨目录裁决 →
 * 接力链三查（dangling/cycle/fork）。绝不写盘；单文件失败不拖垮扫描；issues 按
 * (kind, id) 排序保证跨次运行可 diff。
 */
export declare function scanStore(dir?: string): DoctorReport;
//#endregion
//#region src/relayledger.d.ts
/** relay/ 目录扫描文件数上限（防御式：共享目录被灌爆时不放大读；正常部署远低于此） */
export declare const RELAY_SCAN_MAX = 2000;
/** relay/<sessionId>.json 的防御式读取形态（writeRelayProvenance 落盘的 { sessionId, ...RelayRecordData }；缺的字段给空串） */
interface RelayLedgerRecord {
  /** 会话 id（落盘顶层字段） */
  sessionId: string;
  /** 来源外部 agent 家（takeover / take_deposit；pickup 取件记录通常为空） */
  provider: string;
  /** 来源外部会话 id */
  sourceId: string;
  /** 消费的交接卡 id（非空 = 取件记录——attribution.mjs:74 同口径） */
  cardId: string;
  /** 接管目标标题（与接管会话标题一致） */
  title: string;
  /** 记录时刻 ISO 串（RelayRecordData 唯一必填字段；缺失/非串 = 形态不符，整文件跳过） */
  at: string;
  /** 来源文件名基（不带扩展名；不落绝对路径） */
  file: string;
}
/** ① 目录扫描读侧：扫 <home>/relay/*.json 按 RelayRecordData 形态防御式解析。
 * fail-open：缺目录回空、单文件坏 JSON / 数组 / null / 缺 at 跳过不抛。
 * 输出按（at, file）字典序——同输入同输出（readdirSync 顺序跨平台不稳）。 */
export declare function readRelayRecords(dir?: string): RelayLedgerRecord[];
/** 链上一棒 */
interface ChainStep {
  id: string;
  /** 卡面标题（解析失败档骨架给空串——诚实缺省，不编） */
  title: string;
  /** 推送时刻（解析失败档骨架给空串，排序时排最前） */
  pushedAt: string;
  /** 这棒现在哪盘 */
  where: 'pending' | 'archived';
  /** 本棒是延续回执卡：指向的源卡 id（extras.receipt.for，tools.ts:1196 同口径） */
  receiptFor?: string;
  /** 本棒接替的前置棒 id（extras.supersedes；合法在盘链接才出场） */
  supersedes?: string;
  /** 断链标注：supersedes 指向的目标在册不存在（或 id 形态非法）——账不断，只标注 */
  brokenTo?: string;
}
/** 一条链 = 一个连通分量（≥1 条边才成链；无链棒不占链屏，只进 counts.chainless） */
interface RelayChain {
  /** 时间正序（pushed_at 字典序同 inboxHistory：同机卡共享时区口径） */
  steps: ChainStep[];
  /** 成环标注：环不拆、账不断 */
  cycle: boolean;
  /** 环上的棒 id（cycle 时在场，字典序） */
  cycleIds: string[];
  /** 分叉标注：被多棒接替的父棒 id（字典序） */
  forks: string[];
}
/** 盘上可寻址 id 集（mdOnDisk 同判据经报告面：解析成功卡 id ∪ 解析失败档 .md 文件名基——
 * 仅 SAFE_ID 形态；非形态基名不可能被 supersedes 指向为在册卡） */
export declare function onDiskIdsOf(pending: DirCardsReport, archived: DirCardsReport): Set<string>;
/** 装配链：pending/archived 两份卡面报告 → 连通分量链（线性/断链/成环/分叉，账不断只标注）。
 * 纯函数：不探盘，父卡存在性按 <id>.md 在两盘报告任一在场判（mdOnDisk 同判据）。 */
export declare function assembleChains(pending: DirCardsReport, archived: DirCardsReport): RelayChain[];
/** 僵尸在册单条 */
interface ZombieEntry {
  id: string;
  /** 取件记录时刻（同卡多条记录取最早一条） */
  at: string;
  /** 卡面标题（聚合时回填；独立判定给空串——诚实缺省） */
  title: string;
  /** 救生艇抢出目标卡（lifecycle reason=lifeboat 的 target 命中）：生来在册，
   * 成因与普通僵尸不同，渲染必须区分——本机唯一真实命中即救生艇抢出卡 */
  lifeboat: boolean;
}
/** 纯函数核心（judgeZombies 的可测芯）：relay pickup 记录（cardId 非空）× <id>.md 仍在 pending。
 * 非 SAFE_ID 形态的 cardId 不判不探（不可能成为在册卡，也不为它开 existsSync 探面）；
 * 同卡多条取件记录只记一条、取最早时刻（顺序无关——不依赖调用方预排序）；
 * pendingOnDisk 由调用方给（聚合面传 existsSync 壳，测试面传集合壳）。 */
export declare function zombiesOf(relay: readonly RelayLedgerRecord[], pendingOnDisk: (id: string) => boolean, lifeboatTargets: ReadonlySet<string>): ZombieEntry[];
/** judgeZombies(dir)：IO 壳——relay 扫描 + pending 盘上探测 + lifeboat 目标集。
 * fail-open：任何异常回空账，不抛。 */
export declare function judgeZombies(dir?: string): ZombieEntry[];
/** 闭集计数（原样，0.26 不评分：无延续率/无评分/无 rate 键） */
interface LedgerCounts {
  /** lifecycle continued 事件条数（原样） */
  continued: number;
  /** lifecycle abandoned 事件条数（原样） */
  abandoned: number;
  /** 僵尸在册命中数（attribution.mjs 口径，含救生艇抢出卡） */
  zombie: number;
  /** 其中救生艇抢出目标卡（成因不同，渲染须区分） */
  zombieLifeboat: number;
  /** 无链棒：从未接棒也不被接棒的孤立在册卡（不占链屏，只计数） */
  chainless: number;
  /** n=总棒：pending ∪ archived 盘上 SAFE_ID 形态卡数（解析成功 ∪ 解析失败档） */
  batons: number;
}
/** 窗口与口径标注（LIFECYCLE_LOG_MAX 窗口外历史不可见；单机口径） */
interface LedgerWindow {
  /** 读到的 lifecycle 事件条数 */
  lifecycleEvents: number;
  /** lifecycle 尾部窗口上限（src/lifecycle.ts:61） */
  lifecycleCap: number;
  /** relay 记录总数（含无 cardId 的 takeover / take_deposit） */
  relayRecords: number;
  /** 其中取件记录（cardId 非空） */
  relayPickups: number;
  /** 确定性拼装的说明（不含当前时刻） */
  note: string;
}
/** 三源 join 对不齐的如实单列（不硬归账） */
interface UnjoinedRow {
  kind: 'relay_pickup_no_card' | 'lifecycle_no_card';
  /** relay cardId 或 lifecycle target */
  id: string;
  at: string;
  detail: string;
}
/** 总账聚合输出 */
interface RelayLedger {
  chains: RelayChain[];
  zombies: ZombieEntry[];
  counts: LedgerCounts;
  unjoined: UnjoinedRow[];
  window: LedgerWindow;
}
/** 三源 join 聚合：relay 扫描（①）× lifecycle（②既有）× 卡面（③既有 core）。
 * 绝不抛：底层读取器全部 fail-open，此处再兜绝对意外——异常时如实缺省不编数字。 */
export declare function aggregateLedger(dir?: string): RelayLedger;
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
/** 某家是否启用（默认启用；只认注册表名单内的停用条目） */
export declare function isProviderEnabled(provider: string, dir?: string): boolean;
/** 切某家开关并持久化；未知 provider 抛中文错（路由层转 400） */
export declare function setProviderEnabled(provider: string, enabled: boolean, dir?: string): TakeoverSwitches;
/**
 * 云端导出落盘计数：<HANDOFF_HOME>/exports/<provider>/ 下的常规文件数。
 * 约定（README「跨机器 / 云端」）：各家云端会话凡能「导出成文件」的，按该家本地
 * 记录的原生格式丢进对应子目录，即被读取器吃掉（readers 侧 exports 同款探测，
 * 两轴独立：本计数只管矩阵显示，读取器并网不看它）。目录缺失 / 读失败 = 0——
 * 无导出是常态两态之一，不是错误，绝不抛出。
 */
export declare function exportsCountOf(provider: string, dir?: string): number;
/** 收件箱概览的待取件行 */
interface PendingRow {
  id: string;
  agent: string;
  title: string;
  project: string;
  pushedAt: string;
  /** 目标段（sections.goal）预览，截 240 字；空段回退 done 段 */
  preview: string;
  /** preview 实际取自 done 段（目标段为空的回退）——导出侧据此归段，避免段级错位 */
  previewFromDone?: boolean;
  /** 空壳卡：六段全是兜底占位文本（噪音治理判据，客户端据此打标/折叠） */
  lowInfo: boolean;
  /** 接力链：本卡接替的前置卡 id（信封 extras.supersedes——协议设计只随信封走，卡片本体不含；链可视化）。非接力卡缺省 */
  supersedes?: string;
  /** 0.26 第三波接线（directed 立约）：Card.to 自由串原样透传（machine:<机器名> 点名 /
   * agent 名 / any）。客户端按 machine: 前缀做三桶分组（mine=点名本机 / others=别机点名 /
   * any=其余；bucketOf 同口径，inbox-view.addressBucketOf 局部实现有一致性钉）。
   * 空串/缺省不落字段（老 host 缺省，客户端防御式消费）。 */
  to?: string;
}
/** 支持矩阵行：本机是否支持 / 发现的会话数 / 启用开关 / 云端导出落盘数 */
interface ProviderRow {
  name: ForeignProvider;
  supported: boolean;
  /** 发现的会话数；探测失败为 -1（前端显示「—」） */
  sessions: number;
  enabled: boolean;
  note: string;
  /** 云端导出落盘：<HANDOFF_HOME>/exports/<provider>/ 下的导出文件数（读取器已并网；
   * 目录缺失 / 家不参与（纯 SQLite 四家）= 0，矩阵该行不出导出标）。 */
  exports: number;
}
interface TakeoverState {
  /** 解析后的 HANDOFF_HOME 绝对路径（默认 ~/.handoff）：客户端 localStorage
   * 已见卡集合的键散列数据源（0.3.0 新卡徽标），同源连不同机器不串扰 */
  home: string;
  pending: PendingRow[];
  /** 收件箱概览里被跳过的坏卡数（不再静默） */
  pendingSkipped: number;
  /** 同 frontmatter id 的重复文件数（已按首见去重；多方可写收件箱的防御计数） */
  pendingDuplicates: number;
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
  /** 0.4.1 死亡地图：卡片生命周期拒收证据（结构化闭集理由）。
   * live = 读侧当前跳过（state 现算，修好即消失）；persisted = 写侧/取侧持久事件
   * （lifecycle.jsonl 尾 50 条，多写方排障用）；persistedTotal = 日志总条数。
   * 全空（无坏卡且无日志）时缺省。 */
  rejections?: {
    live: Array<{
      file: string;
      reason: string;
      detail: string;
    }>;
    persisted: Array<{
      at: string;
      stage: string;
      reason: string;
      target: string;
      detail: string;
    }>;
    persistedTotal: number;
  };
  /** 0.2.0 换机同步状态（零网络：sync.json + sync-state.json + 本地脏计数）。
   * 未启用时缺省——客户端整个换机块不渲染。 */
  syncStatus?: SyncStatus;
  /** 0.2.0 环境备份清单（env-backup/ 目录只读枚举，不解密）；无备份缺省。
   * 0.26 snapshot 接线增 autoUpgradeSnapshot：启动触发器最近一次结果旁证
   * （created/same/skipped 三态，detail 给人看；index.ts 激活处写入 holder）。 */
  envBackup?: {
    backups: BackupRow[];
    autoUpgradeSnapshot?: AutoUpgradeSnapshotValue;
  };
  /** 0.26 上下文预警（contextHealth 探针报告）。**buildState 不探测会话对象**：
   * 组装保持纯读盘，contextHealth 由路由层展开——GET state / 写侧动作带可选 sessionId
   * 且会话在场时，路由把 probeContexthealth(session) 展开到本字段（server.ts，
   * 集成裁定取「路由层展开」而非 buildState 新入参：buildState 的全部既有调用方
   * （settings.spec / recovery.spec / 面板 30s 轮询）零改动）。无参 / 无会话 /
   * 探测降级（level='unknown' 照报）之外的抛错路径字段缺省。 */
  contextHealth?: ContexthealthReport;
  /** 0.26 triage 接线：当前有效置顶卡 id（pins.json 懒清理后的盘面现实，新置顶在前）。
   * 老 host 缺省——客户端防御式消费（inboxtriage.listPins fail-open：sidecar 损坏回空）。 */
  pins?: string[];
  /** 0.26 triage 接线：收件箱检索结果（GET state 带可选 q 参数时由路由层展开，
   * includeBody=1 时逐卡读正文——inboxtriage.searchInbox 立约：空 query 空命中、
   * 枚举失败回规范 error 值绝不抛）。无 q 参数字段缺省（无参请求响应零变化）。 */
  inboxQuery?: InboxSearchResult;
  /** 0.26 doctor 接线：总线只读体检报告（scanStore：损坏段/形态/孤儿侧车/链三查，
   * issues 按 severity 分级 error/warn/info，ok=true 即零发现）。buildState 每次现扫
   * （pending+archived 全量只读；与收件箱概览同一量级——ARCHIVED_KEEP=50 封顶）；
   * 扫描自身异常字段缺省（scanStore 承诺不抛，此处兜绝对意外）。 */
  doctor?: DoctorReport;
  /** 0.26 第三波接线：本机机器名（<HANDOFF_HOME>/machine.json 的 { name }，缺席/损坏
   * fail-open 回 os.hostname——directed.readMachineName 立约，fail-open 必 warn 留痕）。
   * 收件箱点名分组（mine=to=machine:本机名）的判定源；客户端防御式消费。 */
  machineName?: string;
  /** 0.26 第三波接线：接力总账（aggregateLedger 三源翻账）。**buildState 不算总账**——
   * 组装保持既有读面，总账由路由层按需展开：GET state 带 ?ledger=1 时
   * aggregateLedger() 并入本字段（inboxQuery 同款「无参请求响应零变化」扩展）；
   * 聚合自身承诺绝不抛，路由层仍兜绝对意外字段缺省。 */
  ledger?: RelayLedger;
}
/** 启动触发器回写最近一次 maybeAutoUpgradeSnapshot 结果（index.ts 激活处调用；
 * undefined = 清空，如触发器自身异常时让 state 不残留上一进程的旧话） */
export declare function setAutoUpgradeSnapshotEvidence(v: AutoUpgradeSnapshotValue | undefined): void;
/**
 * 组装设置卡状态（纯函数核心，读取层与目录都可注入）：
 * 单家探测失败只影响该行，不拖垮整体。
 */
export declare function buildState(readers: ForeignReaders, dir?: string): TakeoverState;
/** 清空 archived/：删除全部 .md 文件，返回清除份数（目录不存在=0，不视为错误）。
 * *.md 目录等异常项：跳过不删（应用层删不动，留给人工），单删失败也继续清其余——
 * 此前一个 *.md 目录就让整个清空操作抛 EISDIR，违背「绝不抛出」且永远 500。 */
export declare function clearArchived(dir?: string): number;
/** 忽略一张待取件卡：卡与信封原样移入 archived/（保留审计轨迹，不计为取件消费）。
 *  pending 只能被消费、没有退出出口，共享总线用久必攒垃圾（2026-10-29 实测 6 张
 *  测试残留卡无处可去）——这是那条出口。找不到/已被取走回规范错误值。 */
export declare function dismissPending(id: string, dir?: string): {
  ok: boolean;
  moved?: number;
  error?: string;
};
//#endregion
//#region src/browser-view.d.ts
type Lang = 'zh' | 'en';
/** 交接出去的接收方（any = 不指定，任何 agent 可取）——providers.ts 注册表派生：
 * outboundEligible 的 provider 依声明序排在 any 之后。交接目标与读取器两轴独立
 * （gemini 是读取器但不进交接目标，注册表显式声明）。 */
export declare const OUTBOUND_TARGETS: readonly OutboundTarget[];
/** 交接轴的 provider 名并集（类型级过滤：仅 outboundEligible=true 的字面量名） */
type OutboundEligibleName = Extract<(typeof PROVIDERS)[number], {
  readonly outboundEligible: true;
}>['name'];
type OutboundTarget = 'any' | OutboundEligibleName;
/** 接收方展示名（注册表 label 派生，与 PROVIDER_LABEL 同源；any 是协议词不是 provider） */
export declare const OUTBOUND_LABELS: Record<OutboundTarget, {
  zh: string;
  en: string;
}>;
/** 投进当前会话的寄存指令（queue 模式打给本会话的 agent）。
 * 两行式（同 depositCommand 的换行纪律）：引用/命令行在前，指示行在后；
 * 指定了接收方时第二行带上「接收方：xxx」——目标选择必须真实影响投出去的内容。 */
export declare function outboundCommand(lang: Lang, targetLabel?: string): string;
/** 对面取卡指引：在目标 agent 的输入框里粘贴这句话，它读完卡即接手。
 * CLI 系给可直接启动的一行命令；输入框系给同句。路径用 ~（POSIX/Windows 均按
 * 目标 agent 的 home 展开习惯），卡 id 恒在句中。 */
export declare function pickupCommand(target: string, id: string, lang: Lang): string;
/** 字数人性化：7426 → 7.3K；1200000 → 1.2M；<1000 原样。统计条不再出现 6 位数字墙。 */
export declare function humanChars(n: number): string;
//#endregion
//#region src/server.d.ts
/** 存活会话枚举封顶（防御式：宿主会话库异常膨胀时不放大读） */
export declare const RUNNING_LIVE_MAX = 500;
/**
 * 运行证据集（纯函数，可脱离路由单测）：存活宿主会话对象数组 × 溯源读取器 →
 * 被本机接管且接管会话仍存活的外部会话 id 集（relay sourceId，字典序去重）。
 * 会话对象缺 id / 溯源缺席（旧宿主、接管前落盘失败）→ 该项无证据，跳过不编。
 */
export declare function runningSourceIdsOf(liveSessions: readonly unknown[], sourceIdOf: (sessionId: string) => string): string[];
/** 溯源读取（尽力而为，IO 壳）：relay/<sessionId>.json 的 sourceId；
 * 缺文件 / 坏 JSON / 形态不符 / sourceId 非串 → 空串（无证据），绝不抛。 */
export declare function relaySourceIdOf(sessionId: string): string;
/** 列表响应附运行证据（纯函数，可单测）：ok:true 的列表响应原样带上 runningIds
 * （供数函数注入，路由传 runningIdsOf）；ok:false 失败值不附（没有列表就没有证据位）。
 * 供数意外（宿主服务抛错等）→ 字段缺省不拦列表——证据是增益，不是列表的前置。 */
export declare function attachRunningIds<T>(res: T, runningIdsOf: () => string[]): T;
/**
 * env-backup 写队列入队（0.26 snapshot 接线）：启动旁路的升级保险快照触发器与面板
 * 手动备份/还原共用同一条串行队列（createBackup/还原都是重 I/O，不并发互踩）。
 * fn 自身的异常被吞进队列链（队列健康优先，不毒化后续写），异常经返回的 promise 透传
 * 给调用方（index.ts 兜 fail-open 降级）。
 */
export declare function enqueueEnvBackupWrite<T>(fn: () => T): Promise<T>;
/** 会话控制器最小面（对齐 dsh-api-session-controller 0.2.0-rc.2 的 Remote 形状；多退少补） */
interface SessionControllerLike {
  create(request?: {
    cwd?: string;
    workspaceId?: string;
  }): Promise<{
    sessionId: string;
  }>;
  rename(request: {
    sessionId: string;
    title: string;
  }): Promise<unknown>;
  prompt(request: {
    requestId: string;
    sessionId: string;
    mode: 'queue' | 'steer';
    content: Array<{
      type: 'text';
      text: string;
    }>;
    clientTimeZone?: string;
  }, signal?: AbortSignal): Promise<{
    accepted: true;
  }>;
}
/** 宿主存活会话服务最小面（SessionStore 结构子集，多退少补）：
 * get 按 id 查存活会话；list 枚举全部存活会话（0.26 第三波接线运行证据用——
 * 旧宿主可能没有，缺席即枚举面降级，get 面不受影响）。 */
interface LiveSessionsLike {
  get?: (id: string) => unknown;
  list?: () => unknown;
}
/** 防御式取宿主会话控制器：服务挂在根 ctx（本插件 ctx 未 inject 该服务名，
 * 直接取会 throw「cannot get property without inject」——root 层即可达）。
 * 缺席/形态不符回 undefined（ 规范降级），绝不抛出。 */
export declare function sessionControllerOf(ctx: unknown): SessionControllerLike | undefined;
type TakeoverMode = 'take' | 'take_deposit' | 'inbox';
type TakeoverOutcome = {
  ok: true;
  sessionId: string;
  title: string;
} | {
  ok: false;
  error: string; /** create 成功但后续失败的孤儿会话 id（不隐瞒，可循此清理） */
  sessionId?: string;
};
/**
 * 投递核心（可脱离 cordis 单测）：建新会话 → 改可找标题 → queue 模式投递指令。
 * 指令与浏览器复制的载荷同一出处（browser-view 的 takeoverCommand/depositCommand），
 * 「点按钮」和「手动粘贴」永远等价；mode=inbox 投递裸 /inbox（最小输入纪律），
 * 带reference 时升级为定向取件（/inbox + 指明编号——行级按钮必须取那一张）。
 * 任何一步失败回规范错误值；已建会话的 id 随错误带出（不隐瞒孤儿会话）。
 */
export declare function admitTakeover(controller: SessionControllerLike, args: {
  mode: TakeoverMode;
  provider?: string;
  reference?: string;
  lang?: 'zh' | 'en';
}, deps?: {
  resolve?: typeof foreignResolveOne;
  random?: () => string;
  /** 停用闸环境（与读路由同口径）：停用家一键接管同样拒绝 */
  env?: Parameters<typeof foreignResolveOne>[2];
  /** 会话查找（可选）：在场时投递成功后向会话日志追加接力溯源记录
   * （依托宿主 ≥0.2.1-alpha.2 的实验性 plugin record API，缺席即跳过） */
  sessions?: {
    get?: (id: string) => unknown;
    flush?: (session: unknown) => unknown;
  };
}): Promise<TakeoverOutcome>;
/**
 * 注册 /dsh-takeover/ 前缀路由。webServer 是宿主可选服务（CLI 形态没有），
 * 走 ctx.inject 缺席即跳过，不影响工具与 skill 注册面。
 * opts.takeoverEnv：provider 停用闸（全部路由共用，缺省读真实设置开关；
 * 测试注入假闸——isProviderEnabled 直读真实 HOME，测试不碰）。
 */
export declare function registerTakeoverRoutes(ctx: Context, opts?: {
  takeoverEnv?: {
    isEnabled: (p: ForeignProvider) => boolean;
  };
}): void;
//#endregion
//#region src/memory.d.ts
/** 记忆来源定义：路径确定、只读；project 级仅在给出 cwd 时扫描 */
interface MemorySourceDef {
  /** 稳定键（客户端勾选回传 / 工具 push 用） */
  key: string;
  /** 归属 agent（展示用） */
  agent: string;
  scope: 'user' | 'project';
  path: (home: string, cwd: string) => string;
}
/** 已知记忆文件清单（用户级全局 + 项目级常用约定文件）。
 * 只列有公开文档惯例的路径；没列入的家不是不支持，是路径无公开惯例。
 * hippo-db 特殊行：dsh-hippo（伴侣智能体长期记忆插件）的记忆库——v0.1.9 起是
 * <数据目录>/memories/ 的 zvec 原生目录（proxima 向量索引 + rocksdb FTS），二进制
 * 不随卡直带，存在性照报（UI 提示装了记忆库）；出卡正文走 MEMORY_STORES 通用
 * 掏取契约（条目 JSONL 在场掏条目、缺席退回指引），这里只管「探测到没有」。 */
export declare const MEMORY_SOURCES: readonly MemorySourceDef[];
/** 扫描结果行 */
interface MemorySourceRow {
  key: string;
  agent: string;
  path: string;
  exists: boolean;
  bytes: number;
  /** ISO 时间；不存在为空串 */
  mtime: string;
  /** 开头预览（截 240 字符；不存在/超大为空串） */
  preview: string;
  [k: string]: string | number | boolean;
}
/**
 * 记忆库 store 注册表项：二进制/引擎型记忆库的通用掏取契约。
 * 这类库的本体不是可读文件（zvec 目录 / sqlite 等），扫描只能报存在性；
 * 内容能不能随卡走，取决于该库有没有「条目 JSONL」导出落在约定路径上：
 * - entriesFile 在场：实际读条目（每行 {text, tags?}）进「建议加载」段（64KB 截断口径内）；
 * - entriesFile 不在场：退回 guidance 指引文案（告诉双方怎么补齐 JSONL 快照）。
 * entriesFile 是 (row) => 路径 的解析函数而非静态字符串：导出约定路径往往锚在
 * 该库的数据目录上，而数据目录是动态的（env / data-dir.txt / 回退根，hippoDataDir
 * 同款三级解析）——扫描行 row.path 已带解析好的基座，从它推约定路径即可，测试注入
 * 假 row 也天然可注入（假 entriesFile 指临时文件即得两态）。
 */
interface MemoryStoreDef {
  /** 稳定键（与 MEMORY_SOURCES 的 key 对应，fileBody 按它查表） */
  id: string;
  /** 展示名 */
  label: string;
  /** 条目 JSONL 约定路径（每行 {text, tags?}）；undefined = 无掏取通路，恒走指引 */
  entriesFile?: (row: MemorySourceRow) => string;
  /** 条目 JSONL 不在场时的退回指引文案（export/import 通路说明） */
  guidance: string;
}
/**
 * 条目 JSONL 约定：每行一个 JSON 对象 {text, tags?}——与 `hippo export -f jsonl`
 * 的行形态兼容（多余字段忽略），其他记忆库照此约定产出即可获得同款掏取通路。
 */
interface MemoryStoreEntry {
  text: string;
  tags?: string[];
}
/** 记忆库 store 注册表（hippo 在册——不再是代码特例；新库 = 在这里加一项） */
export declare const MEMORY_STORES: readonly MemoryStoreDef[];
/** 条目 JSONL 读取结果：entries 为解析出的有效条目（坏行/缺 text 跳过） */
interface StoreEntriesRead {
  entries: MemoryStoreEntry[];
  /** 原始文件字符数（超 FILE_BODY_MAX 时渲染侧截断并注明） */
  rawChars: number;
}
/**
 * 读一份条目 JSONL（纯读；64KB 截断口径由渲染侧执行，这里只解析）：
 * 每行一个 JSON 对象取 text 与 tags（非字符串 tags 项丢弃），坏行/空行/缺 text 行跳过。
 * 文件不在场 / 读失败 / 零有效条目 → undefined（调用方退回指引文案）。
 */
export declare function readStoreEntries(file: string): StoreEntriesRead | undefined;
/** 扫描已知记忆文件（纯读；deps.home/cwd 可注入，缺省真实 home / 无项目级） */
export declare function scanMemorySources(deps?: {
  home?: string;
  cwd?: string;
}): MemorySourceRow[];
/** 记忆出卡参数（工作台路由与 handoff_memory 工具共用） */
interface MemoryPushArgs {
  /** 要带的来源键；缺省 = 全部存在的用户级来源 */
  keys?: string[];
  target?: string;
  title?: string;
  lang?: 'zh' | 'en';
}
type MemoryPushResult = {
  ok: true;
  id: string;
  path: string;
  sources: number;
} | {
  ok: false;
  error: string;
};
/** 记忆出卡核心（pushHandoff 复用——session 传 undefined，六段全部手写，守门不误伤） */
export declare function pushMemoryCard(args: MemoryPushArgs, deps?: {
  scan?: typeof scanMemorySources;
  push?: typeof pushHandoff;
  dir?: string;
}): MemoryPushResult;
/** 注册 handoff_memory 工具（agent 侧同款能力：scan 看清单 / push 出卡） */
export declare function registerMemoryTool(ctx: Context): void;
/** execute 规范值 → 模型可见文本 */
export declare function renderMemory(_args: unknown, value: unknown): Array<{
  type: 'text';
  text: string;
}>;
//#endregion
//#region src/absorb.d.ts
/** 单次吸收追加总字符上限（与 memory.ts SUGGESTED_TOTAL_MAX 同量级：写回也要封顶，最坏有界） */
export declare const ABSORB_TOTAL_MAX = 120000;
/** 吸收目标定义：从 MEMORY_SOURCES 选（复用同一份路径真源），hippo-db（引擎目录）除外 */
interface AbsorbTargetDef {
  key: string;
  agent: string;
  scope: 'user' | 'project';
  path: (home: string, cwd: string) => string;
}
/**
 * 吸收目标注册表：MEMORY_SOURCES 的文件型子集，AGENTS.md 族事实标准优先排序
 * （展示口径——工具错误文案按此序列候选）。hippo-db 特意不在册：zvec 原生目录
 * 不接受文件写回（写了就是砸库），它走专用分支——confirm 两步后 hippo CLI import
 * 随卡侧车（src/distill.ts 执行器），不进文件写回注册表。
 */
export declare const ABSORB_TARGETS: readonly AbsorbTargetDef[];
/** 「建议加载」段条目：一行为一条（空行/段标题/截断标记行不算条目），sha 取 trim 后内容的 sha256 */
interface AbsorbEntry {
  line: string;
  sha256: string;
  /** 条目来自卡内哪个来源块（`## <路径>` 标题；无标题块为「未标注来源」） */
  source: string;
}
/**
 * 解析「建议加载」段为条目列表（确定性）：
 * - `## <路径>` 行是来源块标题（memorySections 的组装形态），不算条目，只记来源；
 * - 其余非空行各算一条（trim 后参与哈希与追加）；
 * - 截断标记行（`…（`开头，memory.ts 截断口径的产物）与块内小节标题形态跳过；
 * - 无任何 `##` 标题的外来卡：整段按「未标注来源」单块处理。
 */
export declare function parseSuggestedEntries(suggested: string): AbsorbEntry[];
/** absorb 参数（工具面与核心函数共用） */
interface AbsorbArgs {
  id?: string;
  target?: string;
  confirm?: boolean;
  /** project 级目标必填：目标记忆文件所在项目目录 */
  cwd?: string;
}
/** absorb 依赖注入（测试用：dir=HANDOFF_HOME、home=user home、now=事件时刻；runner=hippo CLI 桩） */
interface AbsorbDeps {
  dir?: string;
  home?: string;
  now?: Date;
  /** hippo CLI runner 桩（target=hippo-db 导入用；缺省 realHippoRunner 真跑 CLI） */
  runner?: HippoRunner;
}
type AbsorbResult = {
  ok: true;
  action: 'absorb';
  id: string;
  target: string;
  agent: string;
  /** 落盘的记忆文件绝对路径 */
  path: string;
  /** 实际追加条数 */
  appended: number;
  /** 按 sha 去重跳过的条数（目标已有，未重写） */
  deduped: number;
  /** 写前原物快照路径（目标原本不存在时缺省） */
  snapshot?: string;
  detail: string;
} | {
  ok: true;
  action: 'absorb';
  id: string;
  target: 'hippo-db';
  agent: string;
  /** 已导入（或已记账跳过）的 archived 侧车路径 */
  sidecar: string;
  /** 侧车格式版本（meta 缺失按 1——读侧 v1/v2 双兼容的如实面） */
  sidecarVersion: number;
  /** 侧车有效条目数（交 hippo 入库的导入口径） */
  entries: number;
  /** hippo 数据目录（三级解析；只经官方 CLI 写，takeover 从不直接写它） */
  dataDir: string;
  /** true = 记账本 sha 对上，重复 absorb 直接跳过（未再调 hippo CLI） */
  repeat: boolean;
  detail: string;
} | {
  ok: false;
  error: string;
};
/**
 * 记忆卡吸收核心（可脱离 host 单测）。全流程：
 * 参数校验 → 目标解析（target=hippo-db 走专用 CLI 导入分支 absorbHippoDb；
 * 文件目标走闭集注册表 + 会话存储守门）→ 读 archived 卡（未取件明确拒）
 * → axis=memory 校验 → 建议段解析 + sha 去重 → confirm 闸（缺省拒 + 计划回显）
 * → 快照 → tmp+rename 落盘 → lifecycle absorbed-write 留痕。
 * 任何失败都只回 { ok: false, error }，不抛异常。
 */
export declare function absorbCard(args: AbsorbArgs, deps?: AbsorbDeps): AbsorbResult;
/** execute 规范值 → 模型可见文本 */
export declare function renderAbsorb(_args: unknown, value: unknown): Array<{
  type: 'text';
  text: string;
}>;
/** 注册 handoff_absorb 工具（写回面唯一记忆入口：confirm 两步 + 去重 + 快照 + 留痕） */
export declare function registerAbsorbTool(ctx: Context): void;
//#endregion
//#region src/configinject.d.ts
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
/** inject 依赖注入（测试用：dir=HANDOFF_HOME、home=user home、now=事件时刻；
 * env=值消毒用的环境快照（缺省取当前 process.env 的字符串键值——inject 在目标机执行，
 * 该环境即 gemini 启动时将看到的口径）；winEnvExpand=是否按 Windows 口径消毒 %VAR%
 * （缺省 process.platform==='win32'——上游仅 Windows 在 MCP 连接期展开 %VAR%）） */
interface InjectDeps {
  dir?: string;
  home?: string;
  now?: Date;
  env?: Record<string, string>;
  winEnvExpand?: boolean;
}
/** MCP 合并目标：JSON 配置路径 + 服务器表键名（事实标准均为 mcpServers） */
interface InjectMcpMapping {
  path: (home: string) => string;
  key: 'mcpServers';
}
/** inject 目标定义：映射缺省 = 该家该项明确不做（limits 里如实标注原因） */
interface InjectTargetDef {
  key: string;
  agent: string;
  /** MCP 合并目标；undefined = 无等价映射，明确不做 */
  mcp?: InjectMcpMapping;
  /** 用户级 skills 目录目标；undefined = 无公开惯例，明确不做 */
  skills?: (home: string) => string;
  /** mcpServers 值消毒三条 + 写后 schema 派生校验（上游口径按行声明——目前只有 gemini 行，
   *  其余家上游行为未调研不假造）。undefined = 不消毒，保持 0.25 既有合并语义 */
  mcpSanitize?: boolean;
  /** SKILL.md frontmatter name/description 写回前闸（上游 skillLoader 口径按行声明——
   *  claude/zcode 的 skill 装载口径未调研，不假造套用）。undefined = 不设闸 */
  skillGate?: boolean;
  /** 不做项的诚实标注（渲染给模型/用户看） */
  limits: string;
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
export declare const INJECT_TARGETS: readonly InjectTargetDef[];
/** inject 参数（工具面与核心函数共用） */
interface InjectArgs {
  /** 备份文件名（.dshenv）；缺省取最近一次 */
  file?: string;
  passphrase?: string;
  target?: string;
  confirm?: boolean;
}
/** 计划单条：kind=动作面，action=add/create=将写入、skip-same/skip-conflict=明确不写 */
interface InjectPlanItem {
  kind: 'mcp' | 'skill';
  /** mcp=server 名；skill=包内相对路径 */
  name: string;
  action: 'add' | 'create' | 'skip-same' | 'skip-conflict';
  /** 目标绝对路径（将写入处 / 冲突处） */
  path: string;
}
interface InjectPlan {
  ok: true;
  target: string;
  agent: string;
  /** 备份文件名 */
  file: string;
  items: InjectPlanItem[];
  /** MCP 目标配置路径（无映射时缺省） */
  mcpConfigPath?: string;
  /** skills 目标目录（无映射时缺省） */
  skillsDir?: string;
  /** 诚实标注（源条目存在但目标无映射等） */
  notes: string[];
}
type InjectPlanResult = InjectPlan | {
  ok: false;
  error: string;
};
/**
 * 注入预演（纯读零写盘）：目标闭集校验 → 源条目解密读取 → 逐条比对出计划。
 * planInject 的任何失败都回 { ok: false, error }；成功返回逐条计划（add/create 才会写）。
 */
export declare function planInject(args: InjectArgs, deps?: InjectDeps): InjectPlanResult;
/** 计划 → 逐条人读文本（confirm 缺省拒绝时整段回显） */
export declare function renderInjectPlan(plan: InjectPlan): string;
type InjectResult = {
  ok: true;
  action: 'inject';
  target: string;
  agent: string;
  file: string;
  /** 新增的 MCP server 名列表 */
  mcpAdded: string[];
  /** 跳过的 MCP server 数（同名同内容 + 同名冲突） */
  mcpSkipped: number;
  /** 新建的 skill 文件相对路径列表 */
  skillsCreated: string[];
  /** 跳过的 skill 文件数 */
  skillsSkipped: number;
  /** 既有配置被改写前的 checkpoint 目录名（回滚入口）；无既有文件被改时缺省 */
  checkpointDir?: string;
  detail: string;
} | {
  ok: false;
  error: string;
};
/**
 * 注入执行：先预演出计划 → confirm 闸（缺 confirm 一律拒绝并回显逐条计划，零写盘）
 * → 既有 MCP 配置文件原物快照进 restore-checkpoint-inject-*（rollback 可回滚）
 * → MCP 合并（tmp+rename）+ skill 文件新建（tmp+rename）→ config-injected 留痕。
 * 只新增不覆盖：任何与目标现存内容不同的条目都跳过并在结果里如实报告。
 */
export declare function applyInject(args: InjectArgs, deps?: InjectDeps): InjectResult;
//#endregion
//#region src/directed.d.ts
/** machine: 寻址前缀（Card.to 自由串里的约定寻址头，大小写敏感——Machine: 不是点名） */
export declare const MACHINE_SCHEME = "machine:";
/** machine.json 文件名（置于 <HANDOFF_HOME>/ 下，与 pins.json/config.json 同屋） */
export declare const MACHINE_FILE = "machine.json";
/** machine.json 路径：HANDOFF_HOME 优先，否则 ~/.handoff（resolveHome 同款解析） */
export declare function machinePath(dir?: string): string;
/**
 * 读本机机器名：<HANDOFF_HOME>/machine.json 的 { name } 字段。缺文件/坏 JSON/
 * 形态不符/name 消毒不过 → fail-open 回 os.hostname()（机器身份是本机便利面，
 * 坏了绝不拦主流程——pins.json 同款纪律），损坏必 console.warn 留痕。
 * 返回规约化（小写）名字；bucketOf 比较与 machine: 寻址都用同一规约，两处
 * 不会各说各话。
 */
export declare function readMachineName(dir?: string): string;
/**
 * 写本机机器名（tmp+rename 原子替换，saveSyncConfig 同模板——进程中断不留
 * 半截文件）。名字消毒与 parseAddress 同规：空名/含路径分隔符抛中文错，
 * 调用方给诚实两态。两台机器必须用不同名字——同名会让 mine 桶互 claim
 * （本波无自动去重，靠机器间约定）。
 */
export declare function saveMachineName(name: string, dir?: string): void;
/**
 * 解析 to 地址：machine:<机器名> 约定寻址。非 machine: 前缀**原样返回不碰**
 * （含首尾空白——agent 名寻址与既有 to 值一字不动）；machine: 名 trim + 小写
 * 规约 + 禁路径分隔符 + 空名拒（中文错）。返回规约化后的完整地址
 * （machine:<小写机器名>）。生产者侧用（写卡前规约）；前缀带首尾空白的
 * 输入不视作点名（原样返回），桶分组侧的防御式识别见 bucketOf。
 */
export declare function parseAddress(to: string): string;
/** 由裸机器名组 machine: 地址（同一消毒；saveMachineName/parseAddress 共规） */
export declare function toMachineAddress(name: string): string;
/** 三桶：mine=点名本机（第一眼看到）；others=点名别机（不冒领）；any=其余 */
type AddressBucket = 'mine' | 'others' | 'any';
/**
 * 待取件行的最小形态：只依赖 to 字段。PendingRow（src/settings.ts:121）当前
 * 不带 to（集成面次日波补），InboxItem（src/tools.ts:1117）已带——两者都
 * 结构化兼容；字段缺席/坏形态按 any 处理。
 */
interface AddressedRow {
  /** Card.to 自由串（machine:<机器名> 点名 / agent 名 / any / 缺省） */
  to?: unknown;
  [k: string]: unknown;
}
/**
 * 三桶分组（防御式，绝不抛）：to 非 string / 非 machine: 前缀 / machine: 名
 * 消毒不过（空名、含路径分隔符）一律归 any——坏数据不藏也不冒领，落回通用
 * 桶人眼可查。点名比较大小写不敏感（两侧同规约化）；本机名缺席（空串）时
 * 点名卡归 others（绝不误收）。前缀识别前先 trim（手写 to 带首尾空白也能
 * 正确分组，与 parseAddress 的严格「原样」纪律各司其职）。
 */
export declare function bucketOf(row: AddressedRow | null | undefined, selfName: string): AddressBucket;
//#endregion
//#region src/lifecycle.d.ts
/** 闭集理由：开集字符串无法聚合出死亡地图。新增理由 = 改这里 + 测试 */
declare const LIFECYCLE_REASONS: readonly ['secret_gate', 'skeleton_gate', 'lifeboat', 'oversize', 'parse_error', 'memory-absorbed', 'absorbed-write', 'config-injected', 'restored', 'drift_mismatch', 'git_unavailable', 'sig_tampered', 'continued', 'abandoned', 'unknown'];
type LifecycleReason = (typeof LIFECYCLE_REASONS)[number];
//#endregion
//#region src/almanac.d.ts
/** 救生艇目标（账本行的寻址锚点：卡 id + 事件时刻；detail 原文不进年鉴） */
interface AlmanacLifeboatTarget {
  /** 卡 id（lifecycle 事件 target 字段原文） */
  id: string;
  /** 事件时刻 ISO 串（回指 lifecycle.jsonl 那一行的 at） */
  at: string;
}
/** 接力来源家（relay/*.json 溯源的非空 provider 去重口径） */
interface AlmanacRelayStats {
  /** 在场清点的 relay/*.json 文件数（含 provider 为空与解析失败的文件——「见到多少」口径） */
  files: number;
  /** provider 非空（trim 后非空串）的溯源份数 */
  withProvider: number;
  /** 去重后的来源家名（字典序；只落家名，不落 sessionId / title） */
  providers: string[];
  /** = providers.length（distinct 口径只计非空值） */
  distinctProviders: number;
  /** 未能按 RelayRecordData 形态解析的文件数（fail-open 跳过，不计入任何 provider 计数） */
  unread: number;
}
/** 年鉴统计（纯数据，每项单源；字段只此六件） */
interface AlmanacStats {
  /** 生成时刻 ISO 串（now ?? new Date()；确定性断言用同参重放） */
  generatedAt: string;
  /** lifecycle.jsonl 尾部窗口内的真实事件行数（「尾 500 条」即此窗口上限） */
  events: number;
  /** 闭集理由直方图：全闭集在册、缺席理由为 0（逐项与账本行可对账） */
  reasons: Record<LifecycleReason, number>;
  /** 救生艇抢出：次数 + 目标 id 列表（只含 id + 时刻） */
  lifeboat: {
    count: number;
    targets: AlmanacLifeboatTarget[];
  };
  /** 接力来源家（relay/*.json 非空 provider 去重） */
  relay: AlmanacRelayStats;
  /** archived 滚动窗口现场清点（keep = ARCHIVED_KEEP，窗口口径随 core 走） */
  archived: {
    cards: number;
    sidecars: number;
    keep: number;
  };
  /** 目录级降级附注（fail-open 逐条如实记录；零降级为空数组） */
  notes: string[];
}
/**
 * 聚合这台机器的真实接力史（纯读取聚合：零 LLM、零子进程、零网络、不写盘）。
 * 四项统计各回各源：①② lifecycle.jsonl（readLifecycleEvents 自带坏行跳过与 fail-open），
 * ③ relay/*.json，④ archived/ 目录清点。目录缺席是诚实零态，不抛不加附注。
 */
export declare function buildAlmanac(dir?: string, now?: Date): AlmanacStats;
/**
 * 渲染年鉴 markdown（确定性：同输入同输出 byte 级——模板固定、行序固定、
 * 无 Date.now / 无随机 / 无 locale 依赖）。零数据机器出「这条总线还没有故事」
 * 诚实句而非空报表；每个数字带单源出处标注。
 */
export declare function renderAlmanac(stats: AlmanacStats): string;
//#endregion
//#region src/preflight.d.ts
/** 检查项 kind 五值闭集：开集没法出固定四件套判定卡，也没法钉估算词负向断言 */
export declare const PREFLIGHT_KINDS: readonly ['liveness', 'integrity', 'bulk', 'scene', 'reader'];
type PreflightKind = (typeof PREFLIGHT_KINDS)[number];
/** 检查项三态：ok=过 / wound=带伤发现 / unknown=未核验（fail-open 缺省态，只降级不升档） */
export declare const PREFLIGHT_STATES: readonly ['ok', 'wound', 'unknown'];
type PreflightCheckState = (typeof PREFLIGHT_STATES)[number];
/** 三档判定闭集（docs/需求调研-1119.md:22 三档语言逐字：可直接接管/带伤接管（列伤）/拒绝） */
export declare const PREFLIGHT_VERDICTS: readonly ['ready', 'wounded', 'decline'];
type PreflightVerdict = (typeof PREFLIGHT_VERDICTS)[number];
/** 单检查项结果（checks 数组条目，固定序 [liveness, integrity, bulk, scene, reader]） */
interface PreflightCheck {
  kind: PreflightKind;
  state: PreflightCheckState;
  /** 人读细节：只转述读取器原样字段与探测结果，不含估算词（预计/约/耗时/token） */
  detail: string;
}
/** 单条伤（逐条可点：item = 缺失文件路径 / provider 名 / 错误摘要） */
interface PreflightWound {
  kind: PreflightKind;
  /** 可点主体：缺失文件路径 / provider 名 / 错误摘要 */
  item: string;
  detail: string;
}
/** 三档判定卡（立约字段只此四件，不夹带其它键） */
interface PreflightCard {
  verdict: PreflightVerdict;
  checks: PreflightCheck[];
  wounds: PreflightWound[];
  basis: string;
}
interface PreflightInput {
  /** 集成面已取回的 foreign_session_read 返回值（action=show 规范值原样透传，含 ok:false
   * 失败值）。防御式收窄：坏形态（非 object/缺字段）按该项 unknown 缺省，绝不抛 */
  read: unknown;
  /** 读取器适配情况（src/foreign.ts:39 adapterNote { supported, note } 同构；缺省=unknown） */
  adapterNote?: unknown;
  /** 预检时刻（可桩；缺省 new Date()——确定性断言请显式传） */
  now?: Date | string | number;
  /** 存在性探测注入可桩（缺省 fs.existsSync；探测抛错 = 未确认，不编造缺盘也不编造在盘） */
  exists?: (path: string) => boolean;
}
/** liveness 启发式分桶阈值：最近活动落在预检时刻前 24 小时内记「近端」，更早记「远端」。
 * 分桶只是「最近活动早晚」，不是运行状态判定——running 精判属 0.26.1 另案 */
export declare const LIVENESS_RECENT_MS: number;
/**
 * 接管预检三档判定（纯函数，确定性：同输入同卡）。五检查项固定序进 checks；
 * unknown 只降级不升档（永不产生 wound、永不触发 decline）；整体绝不抛（fail-open，
 * 预检绝不拦真实接管）。本模块零子进程零写盘：唯一下游是注入式存在性探测。
 */
export declare function assessForeignTakeover(input: PreflightInput): PreflightCard;
//#endregion
//#region skills/handoff.d.ts
/** /handoff 注册项 */
export declare function handoffSkillRegistration(): SkillRegistration;
//#endregion
//#region skills/inbox.d.ts
/** /inbox 注册项 */
export declare function inboxSkillRegistration(): SkillRegistration;
//#endregion
//#region skills/almanac.d.ts
export declare const ALMANAC_SKILL_CONTENT = "# 接力年鉴（/almanac）\n\n把**这台机器**真实发生过的接力史编成一页可分享、可审计的年鉴：理由直方图 / 救生艇抢出 /\n接力来源家 / 归档窗口。**只计数、不评分**——延续率、评分、等级一律不做（无账本数据前是\n编数字）；同样的盘面编出同样的页。\n\n## 数据三源（全部只读，逐项单源对账）\n\n1. `~/.handoff/lifecycle.jsonl`：生命周期事件（at / stage / reason / target / detail），\n   只有尾部 500 条窗口——事件数达到 500 时注明「已达窗口上限，更早历史不可见」。\n2. `~/.handoff/relay/*.json`：接力溯源（provider / sourceId / cardId / title / at）。\n   坏 JSON 或形态不符的文件跳过并计数，不能混进任何 provider 计数。\n3. `~/.handoff/archived/`：归档目录现场清点——.md 卡与非 .md 侧车分开数\n   （滚动保留最近 50 张，只滚 .md、侧车不随之清理）。\n\n## 步骤（机械执行）\n\n1. **理由直方图**：把 lifecycle 尾 500 条窗口内的全部事件按 `reason` 计数。\n   理由是闭集（secret_gate / skeleton_gate / lifeboat / oversize / parse_error /\n   memory-absorbed / absorbed-write / config-injected / restored / drift_mismatch /\n   git_unavailable / sig_tampered / continued / abandoned / unknown）——**全闭集在册**，\n   缺席的理由也列出计 0，逐项可与账本行对账；窗口外的历史不存在，不冒充全史。\n2. **救生艇抢出**：reason=lifeboat 的事件逐条列出 target 卡 id 与事件时刻（at）。\n   列表只含 id + 时刻，detail 原文留在账本不进年鉴。\n3. **接力来源家**：relay/*.json 按 provider 字段统计——**非空（trim 后非空串）才计入**，\n   去重后列家名（字典序）；provider 为空串/缺席的溯源如实不计入 distinct 口径；\n   解析失败的文件单独计一笔「未能解析」，不静默漏。\n4. **归档窗口**：archived/ 现场清点 .md 卡数与侧车数（不验卡面健康——那是总线体检的\n   职责，年鉴单源纪律）。\n\n## 渲染（结构与 src/almanac.ts renderAlmanac 同构）\n\n- 标题「接力年鉴 · 这台机器」；口径行注明「只计数不评分」「数字随本机排放漂移，以重跑为准」\n  与生成时刻。\n- 四节各带窗口标注：理由直方图（lifecycle 尾部 500 条窗口内 N 行）、救生艇抢出（X 次）、\n  接力来源（Y 家）、归档窗口（archived/ · 滚动 50 张）。\n- 末尾附扫描降级附注（目录在场但读取失败才记；目录缺席 = 全新机器的诚实零态，不加附注）。\n\n## 红线（不可违反）\n\n- **措辞只说「这台机器」**：lifecycle.jsonl 与 relay/ 不随换机同步（机器本地记录不入库），\n  年鉴是本机口径——不得写成「全总线 / 全网」。\n- **隐私**：全文无卡正文、无绝对路径、无会话 id / 会话标题 / provider 溯源的 sessionId——\n  只有计数、闭集理由名、来源家名与卡 id。\n- **绝不评分**：不出现延续率、百分比评分、等级或排名。\n\n## 零数据\n\n三源全空（lifecycle.jsonl 不存在或 0 条、relay/ 无文件、archived/ 无卡）→\n只回一句「这条总线还没有故事」的诚实说明（三处目录各是什么），不要编一张 0 表格。\n";
/** /almanac 注册项（接线进 skills/index.ts 的 skillRegistrations() 数组属集成面） */
export declare function almanacSkillRegistration(): SkillRegistration;
//#endregion
//#region skills/ledger.d.ts
export declare const LEDGER_SKILL_CONTENT = "# 接力总账（/ledger）\n\n把 claude→卡→回执→延续/弃置/僵尸 全链翻成一屏账：谁接了棒、接了有没有下文、哪张卡被静默吞掉。**确定性翻账**——以下每一步都是机械读取与固定规则，不做任何推断、评分或百分比；同样的盘面翻出同样的账。\n\n## 数据三源（全部只读，逐条如实）\n\n1. `~/.handoff/relay/*.json`：接力记录（sessionId / provider / sourceId / cardId / title / at）。\n   cardId 非空的记录 = 取件记录；坏 JSON 或形态不符的文件跳过，跳了几份要注明。\n2. `~/.handoff/lifecycle.jsonl`：生命周期事件（at / stage / reason / target / detail），\n   只有尾部 500 条窗口——事件数达到 500 时注明「已达窗口上限，更早历史不可见」。\n3. 卡面：`~/.handoff/pending/*.md` 与 `archived/*.md` 的 id / 标题 / pushed_at，\n   以及 frontmatter 的 `supersedes`（父卡 id）与 `receipt.for`（延续回执指向的源卡 id）。\n\n## 步骤（机械执行）\n\n1. **装链**：每张卡的 `supersedes` 指向父卡。父卡 id 在 pending/archived 任一盘有 .md 在场\n   → 链上棒；不在场 → 该棒标「断链→<id>」，**账不断**。父卡文件在盘但解析失败 → 照常挂链，\n   该棒标题/时刻留空（诚实缺省）。`supersedes` 成环 → 标「成环（环上 id：…）」，账不断。\n   同一父棒被多棒接替 → 标「分叉」。从未接棒也不被接棒的孤立卡不进链，只进计数（无链棒）。\n2. **判僵尸**：cardId 非空的 relay 取件记录指向的卡仍在 pending/ → 「僵尸在册」\n   （relay 说取了、卡却没被消费——取件会话绕过消费即弃的实测证据）。\n   其中 lifecycle 有 `reason: lifeboat` 且 target 命中的 → 改标「救生艇抢出卡在册」：\n   救生艇抢出的卡生来就在册，成因与普通僵尸不同，**不得混入普通僵尸口径渲染**。\n   卡已不在 pending（如在 archived）→ 不是僵尸。\n3. **对不齐如实单列**：取件记录指向已不在册的卡（已消费后被滚动清理，或从未落盘）、\n   lifecycle 端点指向已不在册的卡——单列原样，不硬归账、不猜成因。\n4. **回执标注**：卡面带 `receipt.for` 的是延续回执卡，链上标「已延续→源卡」。\n\n## 计数行（闭集原样，一个字都不要加工）\n\n```\nX continued / Y abandoned / Z zombie（n=总棒 N）\n```\n\n- X / Y 取 lifecycle 里 continued / abandoned 事件条数**原样**；Z = 僵尸命中数\n  （救生艇抢出卡 M 张紧跟括注）；N = pending ∪ archived 盘上卡数。\n- **绝不计算延续率、百分比或评分**：无账本数据前是编数字——评分机制明确不做。\n- lifecycle 事件数达到 500 时，在计数行下注明窗口上限。\n\n## 隐私与边界\n\n- 账面只含 id / 标题 / provider / 时间；不落卡正文、不落 lifecycle detail 全文、不落绝对路径。\n- relay/ 与 lifecycle.jsonl 是本机事实、不随 HANDOFF_HOME 同步——总账是**单机口径**；\n  链上出现别机寄存的卡时只出卡面事实，不反推别机事件。\n\n## 空账本\n\n三源全空（relay 无记录、lifecycle.jsonl 不存在或 0 条、pending/archived 无卡）→\n只回一句「账本还是空的——还没有任何接力发生」，不要编一张 0 表格。\n";
/** /ledger 注册项 */
export declare function ledgerSkillRegistration(): SkillRegistration;
//#endregion
//#region skills/sendto.d.ts
export declare const SENDTO_SKILL_CONTENT = "# 点名投递到指定机器（/sendto）\n\n把当前 DSH 会话蒸馏成一张 handoff: 1 协议卡片，`to` 写成 `machine:<目标机器名>` 寄存进\n共享收件箱 `~/.handoff/pending/`，随既有换机同步（git 端点）跨机到达。目标机的收件箱\n会把这张卡归入「点名给我」一组，第一眼看到；别机的收件箱不冒领（目标机需装有带\n点名分组的插件版本；旧版收件箱至少在列表行带 to 字段可查）。\n\n## 用法\n\n`/sendto <机器名>`——机器名是目标机在它本机 `~/.handoff/machine.json` 里登记的名字。\n用户没给机器名时先问一句「投给哪台机器」，不要猜。\n\n## 步骤\n\n1. **确认本机身份**：读 `~/.handoff/machine.json`（形态 `{\"name\":\"本机名\"}`，小写）。\n   缺席时先创建：用本机 hostname 的小写形式。两台机器的名字必须不同——同名会让\n   目标机把别机的点名卡误认成自己的（本波无自动去重，靠机器间约定）。\n2. **按 /handoff 同款纪律蒸馏六段**（目标/涉及文件/做到哪/还差什么/停在哪/读者警告）：\n   - 证据账本四态：每条完成/测试/部署/上线类陈述标且只标 `CURRENT_OBSERVED` /\n     `HISTORY_REPORTED` / `MISMATCH` / `UNAVAILABLE`；没在本轮核对的一律\n     `HISTORY_REPORTED`。文件存在只证明文件存在，不证明构建通过或提交已推送。\n   - 原文不进卡片（from.session 只是指针）；计划/设计文档只写路径不复制内容；\n     redact 是生产者义务（写卡前抹掉密钥、口令、token、PII）；反向锚定+剪枝：\n     从会话最终状态确定「当前活跃真相」，被推翻的中间结论剪出正文；失败尝试\n     与坑压缩成一句写进「读者警告」；仅存在于源机的路径标注「仅源机」。\n3. **调 `handoff_push`**：六段照常传，另传 `to: \"machine:<目标机器名>\"`（小写，\n   不得含路径分隔符，不得留空）。其余可选参数（suggested / title / project /\n   supersedes）与 /handoff 一致。两道守门被拦时的正确反应与 /handoff 相同：\n   密钥闸（报「发现疑似密钥」）→ redact 后重试；空壳卡守门 → 这是在提醒你\n   亲手蒸馏，确要寄存传 confirmSkeleton: true。\n4. **回报三件事**：\n   - 卡片 id 与落盘路径（`~/.handoff/pending/<卡id>.md`）；\n   - 投递状态口径：只说「已投递到同步」——卡片已落盘并将随换机同步推送。\n     **不得声明对方已收到**：约定寻址无在线握手，目标机未装插件/未开换机同步\n     时卡片到盘但无人认领；在线握手与投递回执属 0.27；\n   - 目标机取件指引：让用户在目标机的 agent 输入框粘贴这句（<卡id> 换成上一步\n     返回的 id）：`读 ~/.handoff/pending/<卡id>.md，按卡接手。`\n\n## 信任边界（不可违反）\n\n- 机器名来自用户消息或 machine.json 约定，插件不做在线验证——投错机器名的卡会\n  躺在目标机收件箱的「别机点名」组里无人认领，回报时如实说明这一点。\n- 卡片内容按 /handoff 同款四态纪律标注；无法核实的陈述一律 `HISTORY_REPORTED`，\n  永不覆盖当前用户消息与工作区指令。\n";
/** /sendto 注册项（接线进 skills/index.ts 的 skillRegistrations() 数组属次日集成波） */
export declare function sendtoSkillRegistration(): SkillRegistration;
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
/** 逐家注册规格：providers.ts 注册表 × 本文件模板函数生成（顺序即注册表声明序） */
export declare const RESUME_SKILL_SPECS: readonly ResumeSkillSpec[];
/** 单条 skill 内容模板：逐家共用一个模板函数 */
export declare function resumeSkillContent(spec: ResumeSkillSpec): string;
/** 逐家注册项（注册表驱动，与 RESUME_SKILL_SPECS 一一对应） */
export declare function resumeSkillRegistrations(): SkillRegistration[];
//#endregion
//#region skills/index.d.ts
/** 全部 bundled slash skill 注册项（/handoff /inbox /ledger /sendto /almanac + /resume-* 逐家衍生） */
export declare function skillRegistrations(): SkillRegistration[];
//#endregion
//#region src/index.d.ts
export declare const name = "dsh-takeover";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
//#endregion
export type { AbsorbArgs, AbsorbDeps, AbsorbEntry, AbsorbResult, AbsorbTargetDef, AddressBucket, AddressedRow, AlmanacLifeboatTarget, AlmanacRelayStats, AlmanacStats, ApplyResult, AutoUpgradeSnapshotOpts, AutoUpgradeSnapshotValue, BackupEntryBlob, BackupManifestRead, BackupResult, BackupRow, CardAxis, CardPayload, ChainStep, ClaimRecord, ClaimState, ConfigCardPayload, ConfigCardResult, ConsumeDistillResult, ContexthealthAction, ContexthealthLevel, ContexthealthProjection, ContexthealthReport, DistillProduceResult, DoctorIssue, DoctorKind, DoctorReport, DoctorSeverity, DryRunResult, EnvBackupStateFile, FlightStamp, FlightVerdict, FlightcheckCheck, FlightcheckOptions, FlightcheckResult, FlightcheckSections, ForeignCandidate, ForeignEnv, ForeignListResult, ForeignListRow, ForeignPreviewResult, ForeignProvider, ForeignReadArgs, ForeignReadResult, ForeignReaders, ForeignResolve, ForeignSkeleton, ForeignSummary, ForeignTurn, HippoImportRunResult, HippoLedgerEntry, HippoRunner, HippoSidecarInfo, HistoryItem, InboxHistoryResult, InboxItem, InboxListResult, InboxLoadResult, InboxSearchHit, InboxSearchOptions, InboxSearchResult, InjectArgs, InjectDeps, InjectPlan, InjectPlanItem, InjectPlanResult, InjectResult, InjectTargetDef, LedgerCounts, LedgerWindow, LiveSessionsLike, ManifestFileRow, MemoryPushArgs, MemoryPushResult, MemorySourceDef, MemorySourceRow, MemoryStoreDef, MemoryStoreEntry, OutboundTarget, PendingRow, PreflightCard, PreflightCheck, PreflightCheckState, PreflightInput, PreflightKind, PreflightVerdict, PreflightWound, ProbeResult, ProduceSnapshotOptions, ProviderRow, PushArgs, PushResult, ReceiptCardResult, ReceiptEvidence, ReceiptExtras, RelayChain, RelayLedger, RelayLedgerRecord, RepoBaseline, RestoreDiffRow, RestoreResult, ResumeSkillSpec, ScopeFile, SessionControllerLike, SessionFacts, StoreEntriesRead, SyncConfig, SyncOutcome, SyncStatus, TakeoverMode, TakeoverOutcome, TakeoverState, TakeoverSwitches, UnjoinedRow, VerifyFacts, ZombieEntry };
//# sourceMappingURL=index.d.ts.map