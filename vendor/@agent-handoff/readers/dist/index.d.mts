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
export declare function makeTurn(partial: Partial<Turn> & Pick<Turn, 'role' | 'text'>): Turn;
type Entry = Record<string, unknown>;
/** 逐行解析 transcript JSONL；非 JSON / 空行静默跳过（损坏记录不拖垮整会话） */
export declare function parseJsonl(text: string): Generator<Entry>;
/** tool_use 的人类可读一行摘要 */
export declare function summarizeToolCall(name: string, input: unknown): string;
/** 把一行 Claude transcript JSON 拆成 Turn 列表 */
export declare function entryToTurns(entry: Entry): Turn[];
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
/** 一个 agent 的会话发现结果（inventory）。 */
interface AgentInventory {
  agent: string;
  root: string;
  sessions: number;
  supported: boolean;
  note?: string;
}
/** 会话适配器：发现 + 解析两段。 */
interface SessionAdapter {
  readonly name: string;
  readonly root: string;
  readonly supported: boolean;
  note?: string;
  /** 发现本机全部会话（轻量，不读内容主体；zcode 只查 session 表元数据）。 */
  discover(): SessionRef[];
  /** 解析一个会话为 Turn 流。id 必须来自 discover()。 */
  parse(id: string): Turn[];
}
//#endregion
//#region src/resolve.d.ts
type ResolveResult = {
  kind: 'resolved';
  ref: SessionRef;
} | {
  kind: 'ambiguous';
  candidates: SessionRef[];
} | {
  kind: 'not-found';
  reference: string;
};
/**
 * 在 refs 中解析 reference：
 * - 'latest' / 空串 → 最新一条；
 * - id 精确命中 → 直接返回；
 * - 其余策略（id 前缀、路径、标题子串）合并候选，1 条解析、多条歧义、0 条 not-found。
 */
export declare function resolveReference(reference: string, refs: SessionRef[]): ResolveResult;
//#endregion
//#region src/codex.d.ts
export declare function parseCodexText(text: string): Turn[];
//#endregion
//#region src/opencode.d.ts
/** 旧版文件布局：一个 ses_*.json 会话文件 → Turn 流 */
export declare function parseOpenCodeSession(sessionFile: string, storageRoot: string): Turn[];
//#endregion
//#region src/zcode.d.ts
/** dbPath 可注入（单测用临时库），缺省真实 ~/.zcode/cli/db/db.sqlite。 */
export declare function parseZcodeSession(sessionId: string, dbPath?: string): Turn[];
//#endregion
//#region src/pi.d.ts
export declare function parsePiText(text: string): Turn[];
//#endregion
//#region src/cursor.d.ts
/**
 * 渲染一个 Cursor value 为 Turn 流（text 轮 + 工具调用轮 + 工具结果轮）。
 * 返回空数组 = 该 value 是系统提示 / 隐藏推理 / 空内容（调用方计数即可）。
 */
export declare function renderCursorValue(value: unknown): Turn[];
/** transcript JSONL 文本 → Turn 流（坏行静默跳过）。 */
export declare function parseCursorTranscriptText(text: string): Turn[];
/** store blob 解码：Buffer/字符串 → JSON；偶数长度纯十六进制串先试 hex 解码；失败 = 二进制/protobuf，返回 null。 */
export declare function decodeCursorBlob(raw: unknown): unknown | null;
/** store.db（blobs 表：id/data 或 key/value 等列名）→ Turn 流；缺库/缺 sqlite 返回 []。 */
export declare function parseCursorStore(dbPath: string): Turn[];
//#endregion
//#region src/grok.d.ts
/**
 * updates.jsonl 文本 → Turn 流。只读可见更新流；
 * chat_history.jsonl（原始模型上下文）不在此处也永不在此处被读取。
 */
export declare function parseGrokUpdatesText(text: string, cwd?: string, model?: string): Turn[];
/** 解析一个会话目录（或 summary.json / updates.jsonl 路径）。 */
export declare function parseGrokSession(id: string): Turn[];
//#endregion
//#region src/index.d.ts
export declare const AGENTS: SessionAdapter[];
/** 发现会话：给 agent 名只查该家；不给则查全部支持的家，单家失败不拖垮整体。 */
export declare function listSessions(agent?: string): SessionRef[];
/** 解析一个会话为 Turn 流；ref 可以是 SessionRef 或适配器 id 字符串。
 * 同一文件（mtime+size 指纹不变）重复读取命中缓存——list 对 20 个候选逐个
 * readSession 数用户轮、show 全量解析后才分页，无缓存时每次调用都重付
 * O(总字节) 的同步 readFileSync+JSON.parse（30s 轮询场景成倍放大）。
 * 缓存有界：条目上限与累计正文上限双闸，超出按 LRU 淘汰。 */
export declare function readSession(agent: string, ref: SessionRef | string): Turn[];
/** 测试钩子：清空解析缓存 */
export declare function clearSessionCache(): void;
/** 引用解析：先发现该 agent 的会话，再按 id/路径/标题规则匹配。 */
export declare function resolveAgentReference(agent: string, reference: string): ResolveResult;
/** 各 agent 的 inventory（root / 会话数 / 支持情况）。 */
export declare function inventory(): AgentInventory[];
//#endregion
export type { AgentInventory, ResolveResult, SessionAdapter, SessionRef, Turn };