//#region src/types.d.ts
/** 协议卡片类型（handoff: 1）。未知字段不丢：顶层进 extras，嵌套对象透传。 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed';
/** 任务快照：text + status 最小公分母（语义 4：迁快照不迁现场） */
export interface TaskSnapshot {
  text: string;
  status: TaskStatus;
  priority?: string;
  [k: string]: unknown;
}
/** 推送时刻的 git 快照（HISTORY_REPORTED，不是当下事实） */
export interface GitSnapshot {
  branch: string;
  changed: string[];
  [k: string]: unknown;
}
/** 来源：session 是指针不是原文（语义 2） */
export interface CardFrom {
  agent: string;
  session: string;
  title: string;
  [k: string]: unknown;
}
/** 六段正文 + 可选「建议加载」段 */
export interface CardSections {
  goal: string;
  files: string;
  done: string;
  remaining: string;
  stopped: string;
  warnings: string;
  suggested?: string;
}
export interface Card {
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
//#endregion
//#region src/yaml.d.ts
/**
 * 迷你 YAML 子集解析/输出：只覆盖本协议 frontmatter 用到的形态——
 * 标量、一层嵌套 map、flow map `{a: b}`、flow 列表 `[a, b]`、
 * 块式字符串数组、块式对象数组（tasks）。不引 yaml 包（零依赖纪律）。
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | {
  [k: string]: YamlValue;
};
/** 解析 frontmatter 文本为顶层 map */
export declare function yamlParse(src: string): Record<string, YamlValue>;
/** key 校验：含冒号/空白/引号的 key 会在回读时静默错位，直接拒写（协议键均为安全形态） */
export declare const SAFE_KEY: RegExp;
/** 块式 YAML 输出（不带 --- 边界） */
export declare function yamlEmit(obj: Record<string, YamlValue>): string;
//#endregion
//#region src/card.d.ts
/** 六段固定顺序 + 可选「建议加载」 */
export declare const SECTION_KEYS: readonly ['goal', 'files', 'done', 'remaining', 'stopped', 'warnings'];
/** 生成卡片 id：ho-<时间戳36进制>-<随机4位> */
export declare function generateId(): string;
/** 合法卡片 id 形态（与文件名规则一致，拒绝路径穿越等外来 id） */
export declare const SAFE_ID: RegExp;
/** id 入口闸：loadCard/writeCard 落盘前必过，不合规直接报中文错 */
export declare function assertSafeId(id: string): void;
/** 解析正文六段：按 `## 标题` 切，缺段给空，未知段忽略 */
export declare function parseSections(body: string): CardSections;
/**
 * 键净化：外来 frontmatter 会出现「能解析不能渲染」的键（如含空格的 `my key`，
 * yamlEmit 的 emitKey 对其抛错）——曾经把 loadCard 变成「先归档后渲染失败」，
 * 调用方收到 ok:false 卡片却已被消费。进 Card 前统一净化为可安全输出的键
 * （非法字符替换 _，值保留，后写者覆盖同名），使解析能力与渲染能力对齐。
 */
export declare function sanitizeKey(k: string): string;
/** frontmatter map → Card：缺字段给默认值，未知字段保留（版本纪律） */
export declare function frontmatterToCard(obj: Record<string, YamlValue>, sections: CardSections, fallbackId?: string): Card;
/** Card → frontmatter map（键序固定，extras 殿后） */
export declare function cardToFrontmatter(card: Card): Record<string, YamlValue>;
/** 渲染规范卡片文本：frontmatter（块式 YAML）+ 六段正文（顺序固定） */
export declare function renderCard(card: Card): string;
/** 严格模式：必须有 frontmatter；缺字段仍给默认值（版本纪律） */
export declare function parseCard(text: string): Card;
/**
 * 宽松模式（语义 3）：无 frontmatter 的纯 Markdown 也能解析——
 * 六段缺段给空，id 从文件名取或按规则生成。兼容 Matt Pocock 式临时卡片。
 */
export declare function parseCardLenient(text: string, hint?: {
  filename?: string;
}): Card;
//#endregion
//#region src/store.d.ts
/** archived 滚动保留份数（SPEC 第一节） */
export declare const ARCHIVED_KEEP = 50;
/** 单卡读取尺寸闸：收件箱按设计是多写方共享目录，读侧对外来巨文件必须有界（8 MiB 足够任何合法六段卡） */
export declare const MAX_CARD_BYTES: number;
/** 目录解析：显式 dir 优先，其次 HANDOFF_HOME（空串/空白视同未设——`??` 不滤空串，
 * 曾让收件箱静默重定向到宿主进程 cwd 的相对路径 pending/，跨进程/重启即丢卡），否则 ~/.handoff */
export declare function resolveHome(dir?: string): string;
export declare const pendingDir: (dir?: string) => string;
export declare const archivedDir: (dir?: string) => string;
/** 渲染卡片写入 pending/，返回文件路径 */
export declare function writeCard(card: Card, dir?: string): string;
/** 目录扫描报告：坏卡不拖垮列表，但逐个计数+告警（此前空 catch 静默吞掉，无跳过线索） */
export interface DirCardsReport {
  cards: Card[];
  skipped: Array<{
    file: string;
    reason: string;
  }>;
}
/** 列 pending/（只读不消费） */
export declare const listPending: (dir?: string) => Card[];
/** 列 archived/（只读不消费） */
export declare const listArchived: (dir?: string) => Card[];
/** 列 pending/ 并附坏卡清单（inboxList/state 用它暴露 skipped 计数） */
export declare const listPendingReport: (dir?: string) => DirCardsReport;
/** 列 archived/ 并附坏卡清单 */
export declare const listArchivedReport: (dir?: string) => DirCardsReport;
/**
 * 消费即弃（语义 3）：pending → archived，返回卡片。
 * 二次取件同一 id 报错「收件箱无此待取件」。
 */
export declare function loadCard(id: string, dir?: string): Card;
//#endregion
//#region src/git.d.ts
export interface GitVerifyResult {
  mismatches: string[];
  /** 无法核验时的中文说明（UNAVAILABLE）；可核验时为空 */
  unavailable?: string;
}
/** `git status --porcelain` 输出 → 文件路径列表（处理改名 `old -> new`） */
export declare function porcelainPaths(out: string): string[];
/** 推送时刻快照采集：非 git 目录静默降级为空快照 */
export declare function collectGitSnapshot(cwd: string): GitSnapshot;
/** 取件核验：分支或 dirty 集合与卡片快照不一致 → 中文 mismatch；cwd 不在/git 失败 → UNAVAILABLE 不 throw */
export declare function verifyGit(card: Card): GitVerifyResult;
/** 随卡补丁上限：截断的补丁不能 apply（半截 hunk 比没有更危险），超限就整份拒带 */
export declare const PATCH_MAX_BYTES: number;
/** untracked 清单上限（只列清单不带货，防 node_modules 级噪音进卡） */
export declare const UNTRACKED_LIST_MAX = 20;
export interface UntrackedFile {
  file: string;
  bytes: number;
}
export interface PatchBundle {
  /** git diff HEAD 的输出；空串 = 无改动或拒带（看 truncated） */
  patch: string;
  bytes: number;
  /** true = diff 超 PATCH_MAX_BYTES 被整份拒带（patch 为空串）；false 且 patch 空 = 工作区干净 */
  truncated: boolean;
  /** 未跟踪且未被 ignore 的新文件清单（内容不随卡，接手方需自行处理） */
  untracked: UntrackedFile[];
}
/** 推送时刻采集未提交改动补丁：git diff HEAD（已暂存+未暂存）。
 * 非 git 目录返回 null（调用方静默跳过）；unborn 分支（无 HEAD）按干净处理——
 * 没有基线就没有 diff，新文件走 untracked 清单提示。复用 fsmonitor=false 闸：
 * 卡片 cwd 是外来输入，本地钩子是卡片作者可布置的命令执行面。 */
export declare function collectPatch(cwd: string, maxBytes?: number): PatchBundle | null;
//#endregion