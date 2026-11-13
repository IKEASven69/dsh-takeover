import { Context } from "@deepseek-ai/cordis";
import { Agent } from "@deepseek-ai/dsh-agent";
import { SkillRegistration } from "@deepseek-ai/dsh-skill";
//#region src/signing.d.ts
type SigVerdict = 'ok' | 'tampered' | 'unsigned' | 'no-key';
//#endregion
//#region node_modules/.pnpm/@agent-handoff+core@file+vendor+@agent-handoff+core/node_modules/@agent-handoff/core/dist/index.d.mts
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
 * opts.extras 是插件侧内部出卡通道（pushMemoryCard 等程序化调用方覆盖 axis/payload
 * 立约缺省）：不进 handoff_push 工具入参面，模型输入到不了 extras，密钥闸不旁路。
 */
export declare function pushHandoff(session: unknown, args: PushArgs, opts?: {
  dir?: string;
  extras?: Record<string, unknown>;
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
  /** 归属适配器名：claude-code | codex | opencode | zcode | pi | workbuddy | cursor | grok | gemini */
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
}];
/** 九家 provider 名的字面量并集类型（注册表声明序） */
type ProviderName = (typeof PROVIDERS)[number]['name'];
//#endregion
//#region src/foreign.d.ts
/** 面向用户的九家提供方名（providers.ts 注册表派生，顺序即注册表声明序） */
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
/** 列备份文件（只读目录，不解密） */
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
interface BackupResult {
  ok: true;
  file: string;
  bytes: number;
  files: number;
  secretCount: number;
  secretHits: number;
  detail: string;
}
/** 立即备份：收集 → 加密 → 落 env-backup/ → 修剪留 3 */
export declare function createBackup(passphrase: string, dir?: string, root?: string): BackupResult;
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
/** 某家是否启用（默认启用；只认九家名单内的停用条目） */
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
  /** preview 实际取自 done 段（目标段为空的回退）——导出侧据此归段，避免段级错位 */
  previewFromDone?: boolean;
  /** 空壳卡：六段全是兜底占位文本（噪音治理判据，客户端据此打标/折叠） */
  lowInfo: boolean;
  /** 接力链：本卡接替的前置卡 id（信封 extras.supersedes——协议设计只随信封走，卡片本体不含；链可视化）。非接力卡缺省 */
  supersedes?: string;
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
  /** 0.2.0 环境备份清单（env-backup/ 目录只读枚举，不解密）；无备份缺省 */
  envBackup?: {
    backups: BackupRow[];
  };
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
/** 九家注册规格：providers.ts 注册表 × 本文件模板函数生成（顺序即注册表声明序） */
export declare const RESUME_SKILL_SPECS: readonly ResumeSkillSpec[];
/** 单条 skill 内容模板：九条共用一个模板函数 */
export declare function resumeSkillContent(spec: ResumeSkillSpec): string;
/** 九条注册项（注册表驱动，与 RESUME_SKILL_SPECS 一一对应） */
export declare function resumeSkillRegistrations(): SkillRegistration[];
//#endregion
//#region skills/index.d.ts
/** 全部 bundled slash skill 注册项（/handoff /inbox + /resume-* 九条） */
export declare function skillRegistrations(): SkillRegistration[];
//#endregion
//#region src/index.d.ts
export declare const name = "dsh-takeover";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
//#endregion
export type { ApplyResult, BackupManifestRead, BackupResult, BackupRow, CardAxis, CardPayload, ConfigCardPayload, ConfigCardResult, DryRunResult, ForeignCandidate, ForeignEnv, ForeignListResult, ForeignListRow, ForeignPreviewResult, ForeignProvider, ForeignReadArgs, ForeignReadResult, ForeignReaders, ForeignResolve, ForeignSkeleton, ForeignSummary, ForeignTurn, HistoryItem, InboxHistoryResult, InboxItem, InboxListResult, InboxLoadResult, ManifestFileRow, MemoryPushArgs, MemoryPushResult, MemorySourceDef, MemorySourceRow, MemoryStoreDef, MemoryStoreEntry, OutboundTarget, PendingRow, ProbeResult, ProviderRow, PushArgs, PushResult, RepoBaseline, RestoreDiffRow, ResumeSkillSpec, ScopeFile, SessionControllerLike, SessionFacts, StoreEntriesRead, SyncConfig, SyncOutcome, SyncStatus, TakeoverMode, TakeoverOutcome, TakeoverState, TakeoverSwitches };
//# sourceMappingURL=index.d.ts.map