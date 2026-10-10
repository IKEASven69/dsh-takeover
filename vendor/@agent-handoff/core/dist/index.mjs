import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
//#region src/yaml.ts
/** 去掉空行与整行注释，记录缩进 */
function linesOf(src) {
	const out = [];
	for (const raw of src.split(/\r?\n/)) {
		if (raw.trim() === "") continue;
		const text = raw.trimStart();
		if (text.startsWith("#")) continue;
		out.push({
			indent: raw.length - text.length,
			text
		});
	}
	return out;
}
/** 解析 frontmatter 文本为顶层 map */
function yamlParse(src) {
	const lines = linesOf(src);
	if (lines.length === 0) return {};
	const [v] = parseBlock(lines, 0, lines[0].indent);
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("frontmatter 顶层必须是键值对");
	return v;
}
function parseBlock(lines, i, indent) {
	if (i >= lines.length) return [null, i];
	if (lines[i].text.startsWith("- ") || lines[i].text === "-") return parseList(lines, i, indent);
	return parseMap(lines, i, indent);
}
/** 键行：`key:` 或 `key: value`，key 不含冒号 */
const KEY_LINE = /^([^:]+?):(?:\s+(.*))?$/;
function isKeyLine(s) {
	return KEY_LINE.test(s) && !s.startsWith("{") && !s.startsWith("\"") && !s.startsWith("'");
}
function parseMap(lines, start, indent) {
	const obj = {};
	let i = start;
	while (i < lines.length) {
		const ln = lines[i];
		if (ln.indent < indent) break;
		if (ln.indent > indent) throw new Error(`YAML 缩进错误：${ln.text}`);
		if (ln.text.startsWith("- ") || ln.text === "-") break;
		const m = KEY_LINE.exec(ln.text);
		if (!m) throw new Error(`YAML 行无法解析：${ln.text}`);
		const key = unquote(m[1].trim());
		const rest = m[2];
		if (rest === void 0) {
			if (i + 1 < lines.length && lines[i + 1].indent > indent) {
				const [v, ni] = parseBlock(lines, i + 1, lines[i + 1].indent);
				obj[key] = v;
				i = ni;
			} else {
				obj[key] = null;
				i++;
			}
		} else {
			obj[key] = parseInline(rest);
			i++;
		}
	}
	return [obj, i];
}
function parseList(lines, start, indent) {
	const arr = [];
	let i = start;
	while (i < lines.length) {
		const ln = lines[i];
		if (ln.indent < indent) break;
		if (ln.indent > indent) throw new Error(`YAML 列表缩进错误：${ln.text}`);
		if (!ln.text.startsWith("- ") && ln.text !== "-") break;
		const dash = ln.text === "-" ? "" : ln.text.slice(2);
		if (dash === "") {
			if (i + 1 < lines.length && lines[i + 1].indent > ln.indent) {
				const [v, ni] = parseBlock(lines, i + 1, lines[i + 1].indent);
				arr.push(v);
				i = ni;
			} else {
				arr.push(null);
				i++;
			}
		} else if (isKeyLine(dash)) {
			const sub = [{
				indent: ln.indent + 2,
				text: dash
			}];
			let j = i + 1;
			while (j < lines.length && lines[j].indent > ln.indent) {
				sub.push(lines[j]);
				j++;
			}
			const [v] = parseMap(sub, 0, ln.indent + 2);
			arr.push(v);
			i = j;
		} else {
			arr.push(parseInline(dash));
			i++;
		}
	}
	return [arr, i];
}
/** 解析行内值：flow map / flow 列表 / 引号字符串 / 数字 / 布尔 / 裸字符串 */
function parseInline(raw) {
	const s = raw.trim();
	if (s.startsWith("{")) return parseFlowMap(s);
	if (s.startsWith("[")) return parseFlowList(s);
	if (s.startsWith("\"")) return parseDoubleQuoted(s);
	if (s.startsWith("'")) return parseSingleQuoted(s);
	const bare = stripComment(s);
	if (bare === "" || bare === "~" || bare === "null") return null;
	if (bare === "true") return true;
	if (bare === "false") return false;
	if (/^-?\d+$/.test(bare)) return parseInt(bare, 10);
	if (/^-?\d*\.\d+$/.test(bare)) return parseFloat(bare);
	return bare;
}
/** 裸标量去掉行尾注释（` #...`） */
function stripComment(s) {
	const at = s.indexOf(" #");
	return (at === -1 ? s : s.slice(0, at)).trim();
}
/** 顶层逗号切分（尊重引号与 {}[] 嵌套） */
function splitTopLevel(s, sep) {
	const out = [];
	let depth = 0;
	let quote = null;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (quote === "\"") {
			cur += c;
			if (c === "\\") cur += s[++i] ?? "";
			else if (c === "\"") quote = null;
			continue;
		}
		if (quote === "'") {
			cur += c;
			if (c === "'") quote = null;
			continue;
		}
		if (c === "\"" || c === "'") {
			quote = c;
			cur += c;
		} else if (c === "{" || c === "[") {
			depth++;
			cur += c;
		} else if (c === "}" || c === "]") {
			depth--;
			cur += c;
		} else if (c === sep && depth === 0) {
			out.push(cur);
			cur = "";
		} else cur += c;
	}
	if (cur.trim() !== "") out.push(cur);
	return out;
}
function parseFlowMap(s) {
	const end = s.lastIndexOf("}");
	if (end === -1) throw new Error(`flow map 缺少 }：${s}`);
	const inner = s.slice(1, end);
	const obj = {};
	for (const entry of splitTopLevel(inner, ",")) {
		const colon = entry.indexOf(":");
		if (colon === -1) throw new Error(`flow map 项无法解析：${entry}`);
		const key = unquote(entry.slice(0, colon).trim());
		const val = entry.slice(colon + 1).trim();
		obj[key] = val === "" ? null : parseInline(val);
	}
	return obj;
}
function parseFlowList(s) {
	const end = s.lastIndexOf("]");
	if (end === -1) throw new Error(`flow 列表缺少 ]：${s}`);
	const inner = s.slice(1, end).trim();
	if (inner === "") return [];
	return splitTopLevel(inner, ",").map((x) => parseInline(x));
}
function parseDoubleQuoted(s) {
	let out = "";
	let i = 1;
	for (; i < s.length; i++) {
		const c = s[i];
		if (c === "\\" && i + 1 < s.length) {
			const n = s[++i];
			out += n === "n" ? "\n" : n === "t" ? "	" : n;
		} else if (c === "\"") return out;
		else out += c;
	}
	throw new Error("双引号字符串未闭合");
}
function parseSingleQuoted(s) {
	let out = "";
	for (let i = 1; i < s.length; i++) if (s[i] === "'") {
		if (s[i + 1] === "'") {
			out += "'";
			i++;
		} else return out;
	} else out += s[i];
	throw new Error("单引号字符串未闭合");
}
function unquote(s) {
	if (s.startsWith("\"")) return parseDoubleQuoted(s);
	if (s.startsWith("'")) return parseSingleQuoted(s);
	return s;
}
const isScalar = (v) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
/** 裸写会歧义就加双引号（过度加引号是安全的，解析器认） */
function needsQuote(s) {
	if (s === "") return true;
	if (/^\s|\s$/.test(s)) return true;
	if (/^(true|false|null|~)$/.test(s)) return true;
	if (/^-?[\d.]+$/.test(s)) return true;
	if (/[\n\r\t]/.test(s)) return true;
	return /[:"'#{}[\],&*!|>%@`?]/.test(s) || s.startsWith("-");
}
function emitScalar(v) {
	if (v === null) return "";
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (!needsQuote(v)) return v;
	return `"${v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n")}"`;
}
/** key 校验：含冒号/空白/引号的 key 会在回读时静默错位，直接拒写（协议键均为安全形态） */
const SAFE_KEY = /^[A-Za-z0-9_.\-]+$/;
function emitKey(k) {
	if (!SAFE_KEY.test(k)) throw new Error(`YAML 键无法安全输出：${k}（键只允许字母、数字、_ . -）`);
	return k;
}
function emitMap(obj, indent) {
	const pad = " ".repeat(indent);
	const out = [];
	for (const [k, raw] of Object.entries(obj)) {
		if (raw === void 0) continue;
		const key = emitKey(k);
		const v = raw;
		if (isScalar(v)) out.push(`${pad}${key}: ${emitScalar(v)}`.trimEnd());
		else if (Array.isArray(v)) {
			if (v.length === 0) out.push(`${pad}${key}: []`);
			else if (v.every((x) => isScalar(x))) {
				out.push(`${pad}${key}:`);
				for (const x of v) out.push(`${pad}  - ${emitScalar(x)}`);
			} else {
				out.push(`${pad}${key}:`);
				for (const item of v) Object.entries(item).filter(([, val]) => val !== void 0).forEach(([ek, ev], idx) => {
					const ekey = emitKey(ek);
					const prefix = idx === 0 ? `${pad}  - ` : `${pad}    `;
					if (isScalar(ev)) out.push(`${prefix}${ekey}: ${emitScalar(ev)}`.trimEnd());
					else {
						out.push(`${prefix}${ekey}:`);
						out.push(...emitMap(ev, indent + 6));
					}
				});
			}
		} else {
			out.push(`${pad}${key}:`);
			out.push(...emitMap(v, indent + 2));
		}
	}
	return out;
}
/** 块式 YAML 输出（不带 --- 边界） */
function yamlEmit(obj) {
	return emitMap(obj, 0).join("\n");
}
//#endregion
//#region src/card.ts
/** 六段固定顺序 + 可选「建议加载」 */
const SECTION_KEYS = [
	"goal",
	"files",
	"done",
	"remaining",
	"stopped",
	"warnings"
];
const HEADING_TO_KEY = {
	目标: "goal",
	涉及文件: "files",
	做到哪: "done",
	还差什么: "remaining",
	停在哪: "stopped",
	读者警告: "warnings",
	建议加载: "suggested"
};
const KEY_TO_HEADING = Object.fromEntries(Object.entries(HEADING_TO_KEY).map(([h, k]) => [k, h]));
/** 生成卡片 id：ho-<时间戳36进制>-<随机4位> */
function generateId() {
	return `ho-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
/** 合法卡片 id 形态（与文件名规则一致，拒绝路径穿越等外来 id） */
const SAFE_ID = /^ho-[a-z0-9]+-[a-z0-9]{4}$/;
/** id 入口闸：loadCard/writeCard 落盘前必过，不合规直接报中文错 */
function assertSafeId(id) {
	if (!SAFE_ID.test(id)) throw new Error(`非法卡片 id：${id}（只允许 ho-<小写字母或数字>-<4位小写字母或数字> 形态）`);
}
/** 拆分 frontmatter 与正文；无 frontmatter 返回 null */
function splitFrontmatter(text) {
	const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
	if (!m) return null;
	return {
		front: m[1],
		body: m[2]
	};
}
/** 解析正文六段：按 `## 标题` 切，缺段给空，未知段忽略 */
function parseSections(body) {
	const sections = {
		goal: "",
		files: "",
		done: "",
		remaining: "",
		stopped: "",
		warnings: ""
	};
	const re = /^##\s+(.+?)\s*$/gm;
	const hits = [];
	let m;
	while ((m = re.exec(body)) !== null) {
		const key = HEADING_TO_KEY[m[1].trim()];
		if (key !== void 0) hits.push({
			key,
			start: m.index,
			end: re.lastIndex
		});
	}
	hits.forEach((h, i) => {
		const next = i + 1 < hits.length ? hits[i + 1].start : body.length;
		sections[h.key] = body.slice(h.end, next).trim();
	});
	return sections;
}
const VALID_STATUS = [
	"pending",
	"in_progress",
	"completed"
];
const asStr = (v, dflt = "") => typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : dflt;
const asMap = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : {};
/**
* 键净化：外来 frontmatter 会出现「能解析不能渲染」的键（如含空格的 `my key`，
* yamlEmit 的 emitKey 对其抛错）——曾经把 loadCard 变成「先归档后渲染失败」，
* 调用方收到 ok:false 卡片却已被消费。进 Card 前统一净化为可安全输出的键
* （非法字符替换 _，值保留，后写者覆盖同名），使解析能力与渲染能力对齐。
*/
function sanitizeKey(k) {
	if (SAFE_KEY.test(k)) return k;
	const out = k.replace(/[^A-Za-z0-9_.\-]/g, "_").slice(0, 128);
	return out === "" ? "_" : out;
}
function sanitizeKeys(obj) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) out[sanitizeKey(k)] = v;
	return out;
}
/** frontmatter map → Card：缺字段给默认值，未知字段保留（版本纪律） */
function frontmatterToCard(obj, sections, fallbackId) {
	const { handoff, id, from, to, project, cwd, pushed_at, git, tasks, ...rest } = obj;
	const fromMap = asMap(from);
	const gitMap = asMap(git);
	const taskList = Array.isArray(tasks) ? tasks : [];
	return {
		handoff: typeof handoff === "number" ? handoff : 1,
		id: asStr(id) || fallbackId || generateId(),
		from: {
			agent: asStr(fromMap.agent),
			session: asStr(fromMap.session),
			title: asStr(fromMap.title),
			...sanitizeKeys(restOf(fromMap, [
				"agent",
				"session",
				"title"
			]))
		},
		to: asStr(to, "any"),
		project: asStr(project),
		cwd: asStr(cwd),
		pushed_at: asStr(pushed_at),
		git: {
			branch: asStr(gitMap.branch),
			changed: Array.isArray(gitMap.changed) ? gitMap.changed.map((x) => asStr(x)) : [],
			...sanitizeKeys(restOf(gitMap, ["branch", "changed"]))
		},
		tasks: taskList.map((t) => {
			const tm = asMap(t);
			const status = asStr(tm.status);
			return {
				text: asStr(tm.text),
				status: VALID_STATUS.includes(status) ? status : "pending",
				...sanitizeKeys(restOf(tm, ["text", "status"]))
			};
		}),
		sections,
		extras: sanitizeKeys(rest)
	};
}
/** 已知键之外的透传部分 */
function restOf(obj, known) {
	const out = {};
	for (const [k, v] of Object.entries(obj)) if (!known.includes(k)) out[k] = v;
	return out;
}
/** Card → frontmatter map（键序固定，extras 殿后） */
function cardToFrontmatter(card) {
	const { agent, session, title, ...fromRest } = card.from;
	const { branch, changed, ...gitRest } = card.git;
	const fm = {
		handoff: card.handoff,
		id: card.id,
		from: {
			agent,
			session,
			title,
			...fromRest
		},
		to: card.to,
		project: card.project,
		cwd: card.cwd,
		pushed_at: card.pushed_at,
		git: {
			branch,
			changed,
			...gitRest
		}
	};
	if (card.tasks.length > 0) fm.tasks = card.tasks.map((t) => {
		const { text, status, ...rest } = t;
		return {
			text,
			status,
			...rest
		};
	});
	for (const [k, v] of Object.entries(card.extras)) fm[k] = v;
	return fm;
}
/** 渲染规范卡片文本：frontmatter（块式 YAML）+ 六段正文（顺序固定） */
function renderCard(card) {
	const parts = [
		"---",
		yamlEmit(cardToFrontmatter(card)),
		"---",
		""
	];
	for (const key of SECTION_KEYS) parts.push(`## ${KEY_TO_HEADING[key]}`, "", card.sections[key].trim(), "");
	if (card.sections.suggested?.trim()) parts.push("## 建议加载", "", card.sections.suggested.trim(), "");
	return parts.join("\n");
}
/** 严格模式：必须有 frontmatter；缺字段仍给默认值（版本纪律） */
function parseCard(text) {
	const split = splitFrontmatter(text);
	if (!split) throw new Error("卡片缺少 YAML frontmatter（严格模式）；无 frontmatter 的纯 Markdown 卡片请用 parseCardLenient");
	let obj;
	try {
		obj = yamlParse(split.front);
	} catch (e) {
		throw new Error(`frontmatter 解析失败：${e.message}`);
	}
	return frontmatterToCard(obj, parseSections(split.body));
}
/**
* 宽松模式（语义 3）：无 frontmatter 的纯 Markdown 也能解析——
* 六段缺段给空，id 从文件名取或按规则生成。兼容 Matt Pocock 式临时卡片。
*/
function parseCardLenient(text, hint) {
	if (splitFrontmatter(text)) return parseCard(text);
	const fromFile = hint?.filename?.replace(/\.md$/i, "");
	const fallbackId = fromFile !== void 0 && SAFE_ID.test(fromFile) ? fromFile : generateId();
	return frontmatterToCard({}, parseSections(text), fallbackId);
}
//#endregion
//#region src/store.ts
/** ~/.handoff 目录语义：pending 待取件 / archived 已消费（滚动 50）/ 消费即弃 */
/** archived 滚动保留份数（SPEC 第一节） */
const ARCHIVED_KEEP = 50;
/** 单卡读取尺寸闸：收件箱按设计是多写方共享目录，读侧对外来巨文件必须有界（8 MiB 足够任何合法六段卡） */
const MAX_CARD_BYTES = 8388608;
/** 目录解析：显式 dir 优先，其次 HANDOFF_HOME（空串/空白视同未设——`??` 不滤空串，
* 曾让收件箱静默重定向到宿主进程 cwd 的相对路径 pending/，跨进程/重启即丢卡），否则 ~/.handoff */
function resolveHome(dir) {
	if (dir !== void 0 && dir.trim() !== "") return dir;
	const env = process.env["HANDOFF_HOME"];
	if (env !== void 0 && env.trim() !== "") return env;
	return join(homedir(), ".handoff");
}
const pendingDir = (dir) => join(resolveHome(dir), "pending");
const archivedDir = (dir) => join(resolveHome(dir), "archived");
/** 渲染卡片写入 pending/，返回文件路径 */
function writeCard(card, dir) {
	const id = card.id || generateId();
	assertSafeId(id);
	card.id = id;
	const pd = pendingDir(dir);
	mkdirSync(pd, { recursive: true });
	const p = join(pd, `${id}.md`);
	writeFileSync(p, renderCard(card), "utf-8");
	return p;
}
function listDirCards(d) {
	const report = {
		cards: [],
		skipped: []
	};
	if (!existsSync(d)) return report;
	for (const f of readdirSync(d)) {
		if (!f.endsWith(".md")) continue;
		try {
			if (statSync(join(d, f)).size > 8388608) {
				report.skipped.push({
					file: f,
					reason: `卡片超过 ${MAX_CARD_BYTES} 字节上限（疑似异常文件，跳过）`
				});
				continue;
			}
			const card = parseCardLenient(readFileSync(join(d, f), "utf-8"), { filename: f });
			if (!SAFE_ID.test(card.id)) {
				report.skipped.push({
					file: f,
					reason: `卡片 id「${card.id}」不合法（load 必败，跳过）`
				});
				continue;
			}
			if (!existsSync(join(d, `${card.id}.md`))) {
				report.skipped.push({
					file: f,
					reason: `卡内 id「${card.id}」与文件名不对应（load 无从取件，跳过）`
				});
				continue;
			}
			report.cards.push(card);
		} catch (e) {
			report.skipped.push({
				file: f,
				reason: e instanceof Error ? e.message : String(e)
			});
		}
	}
	if (report.skipped.length > 0) console.warn(`[handoff] ${d}：跳过 ${report.skipped.length} 张坏卡——${report.skipped.map((s) => `${s.file}（${s.reason}）`).join("；")}`);
	report.cards.sort((a, b) => (b.pushed_at || "").localeCompare(a.pushed_at || "") || b.id.localeCompare(a.id));
	return report;
}
/** 列 pending/（只读不消费） */
const listPending = (dir) => listPendingReport(dir).cards;
/** 列 archived/（只读不消费） */
const listArchived = (dir) => listArchivedReport(dir).cards;
/** 列 pending/ 并附坏卡清单（inboxList/state 用它暴露 skipped 计数） */
const listPendingReport = (dir) => listDirCards(pendingDir(dir));
/** 列 archived/ 并附坏卡清单 */
const listArchivedReport = (dir) => listDirCards(archivedDir(dir));
/**
* 消费即弃（语义 3）：pending → archived，返回卡片。
* 二次取件同一 id 报错「收件箱无此待取件」。
*/
function loadCard(id, dir) {
	assertSafeId(id);
	const src = join(pendingDir(dir), `${id}.md`);
	if (!existsSync(src)) throw new Error(`收件箱无此待取件：${id}（可能已取过——消费即弃）`);
	if (statSync(src).size > 8388608) throw new Error(`卡片超过 ${MAX_CARD_BYTES} 字节上限，拒载（卡片保留在收件箱）`);
	const card = parseCardLenient(readFileSync(src, "utf-8"), { filename: `${id}.md` });
	try {
		renderCard(card);
	} catch (e) {
		throw new Error(`卡片无法渲染，取件被拒绝（卡片保留在收件箱）：${e instanceof Error ? e.message : String(e)}`);
	}
	const ad = archivedDir(dir);
	mkdirSync(ad, { recursive: true });
	renameSync(src, join(ad, `${id}.md`));
	try {
		trimArchived(ad);
	} catch (e) {
		console.warn(`archived 滚动清理失败（取件本身已成功）：${e.message}`);
	}
	return card;
}
/** archived 滚动：按 mtime 留最新 ARCHIVED_KEEP 份，其余删除；*.md 目录等异常项不进候选 */
function trimArchived(ad) {
	const files = [];
	for (const f of readdirSync(ad)) {
		if (!f.endsWith(".md")) continue;
		const p = join(ad, f);
		try {
			const st = statSync(p);
			if (!st.isFile()) continue;
			files.push({
				f,
				mtime: st.mtimeMs
			});
		} catch {
			continue;
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	for (const x of files.slice(50)) try {
		rmSync(join(ad, x.f));
	} catch {}
}
//#endregion
//#region src/git.ts
/** git 核验与快照：卡片快照是 HISTORY_REPORTED，核验冲突标 MISMATCH，无法核验标 UNAVAILABLE */
/** 同步跑 git，失败抛错（由调用方降级为 UNAVAILABLE，不往外 throw）。
* `-c core.fsmonitor=false`：卡片 cwd 是外来输入，仓库本地 fsmonitor 钩子是卡片作者
* 可布置的命令执行面（读一张卡 = 执行一段卡片作者的 shell）——快照与核验一律禁用。 */
function git(cwd, args) {
	return execFileSync("git", [
		"-C",
		cwd,
		"-c",
		"core.fsmonitor=false",
		...args
	], {
		encoding: "utf-8",
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	}).trim();
}
/** `git status --porcelain` 输出 → 文件路径列表（处理改名 `old -> new`） */
function porcelainPaths(out) {
	return out.split("\n").filter((l) => l.trim() !== "").map((l) => {
		let p = l.slice(3);
		const arrow = p.indexOf(" -> ");
		if (arrow !== -1) p = p.slice(arrow + 4);
		return p.replace(/^"|"$/g, "");
	});
}
/** 推送时刻快照采集：非 git 目录静默降级为空快照 */
function collectGitSnapshot(cwd) {
	try {
		return {
			branch: git(cwd, ["branch", "--show-current"]),
			changed: porcelainPaths(git(cwd, [
				"-c",
				"core.quotePath=false",
				"status",
				"--porcelain"
			]))
		};
	} catch {
		return {
			branch: "",
			changed: []
		};
	}
}
/** 取件核验：分支或 dirty 集合与卡片快照不一致 → 中文 mismatch；cwd 不在/git 失败 → UNAVAILABLE 不 throw */
function verifyGit(card) {
	const cwd = card.cwd;
	if (!cwd) return {
		mismatches: [],
		unavailable: "卡片未记录 cwd，git 核验不可用（UNAVAILABLE）"
	};
	if (!existsSync(cwd)) return {
		mismatches: [],
		unavailable: `工作目录不存在：${cwd}，git 核验不可用（UNAVAILABLE）`
	};
	let branch;
	let changed;
	try {
		branch = git(cwd, ["branch", "--show-current"]);
		changed = porcelainPaths(git(cwd, [
			"-c",
			"core.quotePath=false",
			"status",
			"--porcelain"
		]));
	} catch (e) {
		return {
			mismatches: [],
			unavailable: `git 核验失败（${cwd} 可能不是 git 仓库）：${e.message.split("\n")[0]}（UNAVAILABLE）`
		};
	}
	const mismatches = [];
	if (branch !== card.git.branch) mismatches.push(`分支不一致：卡片记录「${card.git.branch || "（空）"}」，当前「${branch || "（空）"}」（MISMATCH）`);
	const recorded = new Set(card.git.changed);
	const now = new Set(changed);
	const gone = [...recorded].filter((f) => !now.has(f));
	const added = [...now].filter((f) => !recorded.has(f));
	if (gone.length > 0) mismatches.push(`卡片记录已改动、当前已不 dirty 的文件：${gone.join("、")}（MISMATCH）`);
	if (added.length > 0) mismatches.push(`当前 dirty 但卡片未记录的文件：${added.join("、")}（MISMATCH）`);
	return { mismatches };
}
/** 随卡补丁上限：截断的补丁不能 apply（半截 hunk 比没有更危险），超限就整份拒带 */
const PATCH_MAX_BYTES = 524288;
/** untracked 清单上限（只列清单不带货，防 node_modules 级噪音进卡） */
const UNTRACKED_LIST_MAX = 20;
/** 推送时刻采集未提交改动补丁：git diff HEAD（已暂存+未暂存）。
* 非 git 目录返回 null（调用方静默跳过）；unborn 分支（无 HEAD）按干净处理——
* 没有基线就没有 diff，新文件走 untracked 清单提示。复用 fsmonitor=false 闸：
* 卡片 cwd 是外来输入，本地钩子是卡片作者可布置的命令执行面。 */
function collectPatch(cwd, maxBytes = PATCH_MAX_BYTES) {
	try {
		git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	} catch {
		return null;
	}
	let patch = "";
	try {
		patch = git(cwd, [
			"-c",
			"core.quotePath=false",
			"diff",
			"HEAD"
		]);
	} catch {
		patch = "";
	}
	let untracked = [];
	try {
		untracked = git(cwd, [
			"-c",
			"core.quotePath=false",
			"ls-files",
			"--others",
			"--exclude-standard"
		]).split("\n").filter((l) => l.trim() !== "").slice(0, 20).map((f) => {
			let bytes = 0;
			try {
				if (existsSync(join(cwd, f))) bytes = statSync(join(cwd, f)).size;
			} catch {}
			return {
				file: f,
				bytes
			};
		});
	} catch {}
	const bytes = Buffer.byteLength(patch, "utf-8");
	if (bytes > maxBytes) return {
		patch: "",
		bytes,
		truncated: true,
		untracked
	};
	return {
		patch,
		bytes,
		truncated: false,
		untracked
	};
}
//#endregion
export { ARCHIVED_KEEP, MAX_CARD_BYTES, PATCH_MAX_BYTES, SAFE_ID, SAFE_KEY, SECTION_KEYS, UNTRACKED_LIST_MAX, archivedDir, assertSafeId, cardToFrontmatter, collectGitSnapshot, collectPatch, frontmatterToCard, generateId, listArchived, listArchivedReport, listPending, listPendingReport, loadCard, parseCard, parseCardLenient, parseSections, pendingDir, porcelainPaths, renderCard, resolveHome, sanitizeKey, verifyGit, writeCard, yamlEmit, yamlParse };
