/*!
 * second-impl —— `handoff: 1` 开放协议的最小独立实现。
 *
 * 依据：agent-handoff/SPEC.md（handoff: 1）。
 * 仅依赖 node 内置模块（node:fs / node:path / node:os），零第三方依赖。
 *
 * 适配器契约（default 导出）：
 *   name: string                        实现名
 *   home(): string                      当前生效的 ~/.handoff 根（HANDOFF_HOME 覆盖，空串视同未设）
 *   writeCard(text?): { id }            生成 id 并写入一张合法六段卡到 pending/
 *   listPending(): string[]             pending/ 全部卡片 id（文件名去 .md）
 *   load(id): { text }                  消费即弃：pending → archived，返回卡全文；缺失/二次取件 throw Error
 *   writeRaw(filename, text): void      把任意文本文件放进 pending/（边界向量入口）
 *
 * 另导出 parseCardText(text)：宽松解析器（frontmatter 字段默认值 / 未知字段进 extras /
 * 六段缺段给空串），对应 SPEC 语义 3 与版本纪律，供需要结构化视图的调用方使用。
 *
 * 路径安全：id 先过黑名单闸（分隔符 / `..` / 控制字符 / Windows 保留名），
 * 再用 path.resolve 做包含性二次校验，任何穿越形态都抛错，绝不盲目拼路径。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const NAME = 'second-impl-minimal';

/** 六段必选 + 一段可选（SPEC 二：正文段落，顺序固定） */
const REQUIRED_HEADINGS = ['目标', '涉及文件', '做到哪', '还差什么', '停在哪', '读者警告'];
const OPTIONAL_HEADING = '建议加载';
const ALL_HEADINGS = [...REQUIRED_HEADINGS, OPTIONAL_HEADING];

/** archived/ 滚动保留份数（SPEC 一） */
const ARCHIVE_KEEP = 50;

/** 生成侧 id 形态闸：ho-<时间戳36进制≥7位>-<随机小写4位>（小写字母数字） */
const GENERATED_ID_RE = /^ho-[a-z0-9]{7,}-[a-z0-9]{4}$/;

// ---------------------------------------------------------------------------
// 目录语义
// ---------------------------------------------------------------------------

function home() {
  const env = process.env.HANDOFF_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.handoff');
}

function pendingDir() {
  return path.join(path.resolve(home()), 'pending');
}

function archivedDir() {
  return path.join(path.resolve(home()), 'archived');
}

function ensureDirs() {
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.mkdirSync(archivedDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * id / 文件名黑名单闸：目录分隔符、盘符、`..`、控制字符、首尾dot、
 * 结尾点或空格（Windows 会静默吞掉）、Windows 保留设备名一律拒绝。
 */
function assertSafeName(id, label) {
  const bad = (reason) => new Error(`${label}非法（${reason}）: ${String(id)}`);
  if (typeof id !== 'string' || id.length === 0 || id.length > 255) throw bad('空或超长');
  if (/[\x00-\x1f]/.test(id)) throw bad('含控制字符');
  if (/[\\/:*?"<>|]/.test(id)) throw bad('含路径分隔符或 Windows 非法字符');
  if (id.includes('..')) throw bad('含路径穿越片段');
  if (id.startsWith('.') || /[. ]$/.test(id)) throw bad('首字符为点或以点/空格结尾');
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(id)) throw bad('Windows 保留设备名');
  return id;
}

/** 拼路径前做包含性二次校验：目标必须落在 dir 内部。 */
function safeJoin(dir, name) {
  const base = path.resolve(dir);
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) {
    const err = new Error(`路径越界，拒绝拼接: ${name}`);
    err.code = 'EPATHESCAPE';
    throw err;
  }
  return target;
}

/** load 里区分「路径越界（安全错误，必须上抛）」与「文件不存在（继续找）」。 */
function isPathEscape(err) {
  return Boolean(err) && err.code === 'EPATHESCAPE';
}

// ---------------------------------------------------------------------------
// id 生成
// ---------------------------------------------------------------------------

function randomToken(len) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function generateId() {
  const ts = Date.now().toString(36).padStart(7, '0');
  let id = `ho-${ts}-${randomToken(4)}`;
  let guard = 0;
  while (
    fs.existsSync(path.join(pendingDir(), `${id}.md`)) ||
    fs.existsSync(path.join(archivedDir(), `${id}.md`))
  ) {
    id = `ho-${ts}-${randomToken(4)}`;
    guard += 1;
    if (guard > 9999) throw new Error('id 生成冲突过多，放弃');
  }
  if (!GENERATED_ID_RE.test(id)) throw new Error(`内部错误：生成的 id 不合形态 ${id}`);
  return id;
}

// ---------------------------------------------------------------------------
// 朴素 YAML 序列化（写出侧）
// ---------------------------------------------------------------------------

function quoteYaml(s) {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 值序列化：仅白名单字符构成的裸标量直接输出，其余一律双引号并转义。 */
function yamlScalar(value) {
  const s = String(value);
  if (s === '') return '""';
  if (/^-?\d+(\.\d+)?$/.test(s) || /^(true|false|null|yes|no|on|off)$/i.test(s)) {
    return quoteYaml(s); // 避免字符串被读成数字/布尔
  }
  if (/^[A-Za-z0-9_][A-Za-z0-9_ ./@+-]*$/.test(s) && !/\s$/.test(s)) return s;
  return quoteYaml(s);
}

function renderFrontmatter(id) {
  const lines = [
    '---',
    'handoff: 1',
    `id: ${id}`,
    `from: { agent: ${yamlScalar(NAME)}, session: ${yamlScalar(`adapter://${NAME}/local`)}, `
      + `title: ${yamlScalar('最小符合性交接卡')} }`,
    'to: any',
    'project: ""',
    `cwd: ${yamlScalar(process.cwd())}`,
    `pushed_at: ${yamlScalar(new Date().toISOString())}`,
    'git: { branch: "", changed: [] }',
    'tasks: []',
    '---',
    '',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 正文构造（写出侧）
// ---------------------------------------------------------------------------

function defaultBody(id) {
  const pendingPosix = pendingDir().replace(/\\/g, '/');
  return [
    '## 目标',
    '',
    `由 ${NAME} 适配器写入的最小符合性卡片，用于验证写入/列出/取件链路。`,
    '',
    '## 涉及文件',
    '',
    `- ${pendingPosix}/${id}.md`,
    '',
    '## 做到哪',
    '',
    '- CURRENT_OBSERVED 卡片已写入 pending/。',
    '',
    '## 还差什么',
    '',
    '- 等待取件方消费本卡。',
    '',
    '## 停在哪',
    '',
    `停在写卡完成时刻。最安全的第一步：listPending() 后 load("${id}")。`,
    '',
    '## 读者警告',
    '',
    '- HISTORY_REPORTED 本卡为适配器合成内容，不含真实现场指令。',
    '',
    '## 建议加载',
    '',
    '- 无需预载。',
    '',
  ].join('\n');
}

function headName(line) {
  const m = line.match(/^##[ \t]*(.*?)[ \t]*$/);
  if (!m) return null;
  const name = m[1].replace(/[：:][ \t]*$/, '');
  return ALL_HEADINGS.includes(name) ? name : null;
}

/** 扫描六段（含可选段）：返回各段内容与出现集合；同名段取第一处。 */
function scanSections(body) {
  const lines = String(body).split(/\r?\n/);
  const heads = [];
  for (let i = 0; i < lines.length; i += 1) {
    const n = headName(lines[i]);
    if (n) heads.push({ i, name: n });
  }
  const sections = {};
  const present = new Set();
  for (const h of ALL_HEADINGS) {
    const first = heads.find((x) => x.name === h);
    if (!first) {
      sections[h] = '';
      continue;
    }
    present.add(h);
    const next = heads.find((x) => x.i > first.i);
    const end = next ? next.i : lines.length;
    sections[h] = lines
      .slice(first.i + 1, end)
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
  }
  return { sections, present };
}

/** 宽松正文归一：已有全部六段则原样保留；否则补齐缺段（无段正文归入「目标」）。 */
function normalizeBody(text) {
  const { sections, present } = scanSections(text);
  if (REQUIRED_HEADINGS.every((h) => present.has(h))) {
    return `${String(text).replace(/\s*$/, '')}\n`;
  }
  const lines = String(text).split(/\r?\n/);
  const firstHead = lines.findIndex((l) => /^##[ \t]/.test(l));
  // 无任何标题时整段文本就是「目标」内容；有标题时只收标题前的引导文本。
  const preamble = firstHead === -1
    ? String(text).trim()
    : (firstHead > 0 ? lines.slice(0, firstHead).join('\n').trim() : '');
  const out = [];
  for (const h of REQUIRED_HEADINGS) {
    out.push(`## ${h}`, '');
    const piece = [h === '目标' ? preamble : '', sections[h]]
      .map((s) => (s || '').trim())
      .filter((s) => s !== '')
      .join('\n\n');
    out.push(piece !== '' ? piece : '（无）', '');
  }
  if ((sections[OPTIONAL_HEADING] || '').trim() !== '') {
    out.push(`## ${OPTIONAL_HEADING}`, '', sections[OPTIONAL_HEADING].trim(), '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 写卡
// ---------------------------------------------------------------------------

/** 卡片已带 frontmatter 时：仅把 id 行同步为生成的文件名 id，其余原样保留。 */
function syncFrontmatterId(text, id) {
  const m = text.match(/^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
  if (!m) return text;
  let fm = m[2];
  if (/^id:[ \t]*\S/m.test(fm)) {
    fm = fm.replace(/^id:[ \t]*\S.*$/m, `id: ${id}`);
  } else if (/^id:[ \t]*$/m.test(fm)) {
    fm = fm.replace(/^id:[ \t]*$/m, `id: ${id}`);
  } else {
    fm = fm.trim() === '' ? `id: ${id}` : `id: ${id}\n${fm}`;
  }
  return m[1] + fm + m[3] + text.slice(m[0].length);
}

function buildCardContent(id, text) {
  if (typeof text === 'string' && text.trim() !== '') {
    if (/^\uFEFF?---[ \t]*\r?\n/.test(text)) {
      // 调用方给了完整卡：原样写入，只同步 id（SPEC：id 与文件名一致）。
      return syncFrontmatterId(text, id);
    }
    // 调用方给的是正文：补齐六段，保证写出的永远是合法六段卡。
    return `${renderFrontmatter(id)}\n${normalizeBody(text)}`;
  }
  return `${renderFrontmatter(id)}\n${defaultBody(id)}`;
}

// ---------------------------------------------------------------------------
// 朴素 YAML / Markdown 解析（读取侧，宽松模式）
// ---------------------------------------------------------------------------

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** 按顶层逗号切分 flow 集合内容，忽略引号与嵌套括号内的逗号。 */
function splitFlow(s) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let q = null;
  let esc = false;
  for (const ch of s) {
    if (esc) { cur += ch; esc = false; continue; }
    if (q) {
      if (ch === '\\') { cur += ch; esc = true; continue; }
      if (ch === q) q = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[') { depth += 1; cur += ch; continue; }
    if (ch === '}' || ch === ']') { depth -= 1; cur += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '' || parts.length) parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** 第一个不在引号内的冒号位置。 */
function findColon(s) {
  let q = null;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (q) {
      if (ch === '\\') esc = true;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ':') return i;
  }
  return -1;
}

function parseFlowMap(inner) {
  const out = {};
  for (const part of splitFlow(inner)) {
    const ci = findColon(part);
    if (ci === -1) continue;
    out[unquote(part.slice(0, ci))] = parseScalarToken(part.slice(ci + 1));
  }
  return out;
}

function parseScalarToken(s) {
  const t = s.trim();
  if (t === '') return '';
  if (t.startsWith('{') && t.endsWith('}')) return parseFlowMap(t.slice(1, -1));
  if (t.startsWith('[') && t.endsWith(']')) {
    return splitFlow(t.slice(1, -1)).map((x) => unquote(x));
  }
  return unquote(t);
}

/** 仅当 ` #` 出现在引号外才视为行尾注释（朴素处理）。 */
function stripComment(v) {
  let q = null;
  let esc = false;
  for (let i = 0; i < v.length; i += 1) {
    const ch = v[i];
    if (esc) { esc = false; continue; }
    if (q) {
      if (ch === '\\') esc = true;
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '#' && i > 0 && /[ \t]/.test(v[i - 1])) return v.slice(0, i).trim();
  }
  return v;
}

/**
 * 朴素 frontmatter 解析：顶层标量、块映射（from/git 一层）、块列表
 * （tasks 的 flow-map 项）、flow 集合（{...} / [...]）。能覆盖 SPEC 字段表全部形状。
 */
function parseFrontmatter(fm) {
  const lines = fm.split(/\r?\n/);
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || /^\s/.test(line)) { i += 1; continue; }
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) { i += 1; continue; }
    const key = m[1];
    const val = stripComment(m[2].trim());
    if (val !== '') {
      out[key] = parseScalarToken(val);
      i += 1;
      continue;
    }
    // 空值：后面跟块映射或块列表
    const nested = {};
    const list = [];
    i += 1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') { i += 1; continue; }
      const item = l.match(/^[ \t]*-[ \t]*(.+)$/);
      if (item) { list.push(parseScalarToken(stripComment(item[1].trim()))); i += 1; continue; }
      if (l.trim() === '-') { list.push(''); i += 1; continue; }
      if (/^\s/.test(l)) {
        const nm = l.trim().match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
        if (nm) {
          const nv = stripComment(nm[2].trim());
          if (nv === '') {
            // 更深一层的块列表（如块式 git.changed）
            const sub = [];
            let j = i + 1;
            while (j < lines.length) {
              const l2 = lines[j];
              if (l2.trim() === '') { j += 1; continue; }
              const it2 = l2.match(/^[ \t]*-[ \t]*(.+)$/);
              if (it2) { sub.push(parseScalarToken(stripComment(it2[1].trim()))); j += 1; continue; }
              break;
            }
            if (sub.length) { nested[nm[1]] = sub; i = j; continue; }
            nested[nm[1]] = '';
            i += 1;
          } else {
            nested[nm[1]] = parseScalarToken(nv);
            i += 1;
          }
        } else {
          i += 1;
        }
        continue;
      }
      break; // 回到顶层
    }
    if (list.length) out[key] = list;
    else if (Object.keys(nested).length) out[key] = nested;
    else out[key] = null;
  }
  return out;
}

const KNOWN_KEYS = new Set(['handoff', 'id', 'from', 'to', 'project', 'cwd', 'pushed_at', 'git', 'tasks']);

/** 字段表默认值 + 未知字段进 extras（SPEC 版本纪律）。 */
function normalizeFields(raw) {
  const pick = (obj, k, dflt) =>
    (obj && obj[k] !== undefined && obj[k] !== null ? obj[k] : dflt);
  const fromRaw = pick(raw, 'from', {});
  const gitRaw = pick(raw, 'git', {});

  const extras = {};
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      if (!KNOWN_KEYS.has(k)) extras[k] = raw[k];
    }
  }

  let handoff = 1;
  const hv = pick(raw, 'handoff', 1);
  const hn = typeof hv === 'number' ? hv : parseInt(String(hv), 10);
  if (!Number.isNaN(hn)) handoff = hn; // 解析不出时按 v1 处理，不硬失败

  const changedRaw = pick(gitRaw, 'changed', []);
  const tasksRaw = pick(raw, 'tasks', []);

  return {
    handoff,
    id: String(pick(raw, 'id', '')),
    from: {
      agent: String(pick(fromRaw, 'agent', '')),
      session: String(pick(fromRaw, 'session', '')),
      title: String(pick(fromRaw, 'title', '')),
    },
    to: String(pick(raw, 'to', 'any')),
    project: String(pick(raw, 'project', '')),
    cwd: String(pick(raw, 'cwd', '')),
    pushed_at: String(pick(raw, 'pushed_at', '')),
    git: {
      branch: String(pick(gitRaw, 'branch', '')),
      changed: Array.isArray(changedRaw)
        ? changedRaw.map(String)
        : (changedRaw === '' ? [] : [String(changedRaw)]),
    },
    tasks: Array.isArray(tasksRaw) ? tasksRaw : (tasksRaw ? [tasksRaw] : []),
    extras,
  };
}

/**
 * 宽松解析：无 frontmatter 的纯 Markdown 也能解析（六段缺段给空串，
 * id 由调用方从文件名取）。永不抛错。
 */
function parseCardText(text) {
  const s = String(text);
  const fmMatch = s.match(/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)(?:\r?\n---[ \t]*(?:\r?\n|$))/);
  const raw = fmMatch ? parseFrontmatter(fmMatch[1]) : {};
  const body = fmMatch ? s.slice(fmMatch[0].length) : s;
  const { sections } = scanSections(body);
  return {
    hasFrontmatter: Boolean(fmMatch),
    raw,
    fields: normalizeFields(raw),
    sections,
    body: body.replace(/^\r?\n/, ''),
  };
}

// ---------------------------------------------------------------------------
// archived/ 滚动保留
// ---------------------------------------------------------------------------

function pruneArchived(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const stats = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      stats.push({ name: e.name, mtime: st.mtimeMs });
    } catch {
      /* 竞态消失的文件忽略 */
    }
  }
  if (stats.length <= ARCHIVE_KEEP) return;
  // 最近优先：mtime 新者靠前；同 mtime 时文件名大者（时间戳部分更新）靠前。
  stats.sort((a, b) => (b.mtime - a.mtime) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  for (const victim of stats.slice(ARCHIVE_KEEP)) {
    try {
      fs.unlinkSync(path.join(dir, victim.name));
    } catch {
      /* 删不掉的留给下次滚动 */
    }
  }
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

const adapter = {
  name: NAME,

  home,

  writeCard(text) {
    ensureDirs();
    const id = generateId();
    let bodyText;
    if (typeof text === 'string') bodyText = text;
    else if (text == null) bodyText = undefined;
    else bodyText = String(text);
    const content = buildCardContent(id, bodyText);
    fs.writeFileSync(path.join(pendingDir(), `${id}.md`), content, 'utf8');
    return { id };
  },

  listPending() {
    let entries;
    try {
      entries = fs.readdirSync(pendingDir(), { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      ids.push(/\.md$/i.test(e.name) ? e.name.slice(0, -3) : e.name);
    }
    return ids.sort();
  },

  load(id) {
    assertSafeName(id, '卡片 id');
    const pDir = pendingDir();
    const aDir = archivedDir();

    // pending/ 里先找 <id>.md，再退回精确同名（writeRaw 放的非 .md 文件）。
    let src = null;
    for (const name of [`${id}.md`, id]) {
      try {
        const p = safeJoin(pDir, name);
        if (fs.statSync(p).isFile()) { src = p; break; }
      } catch (err) {
        if (isPathEscape(err)) throw err; // 其余视为不存在，试下一个候选
      }
    }
    if (!src) {
      let archived = false;
      for (const name of [`${id}.md`, id]) {
        try {
          if (fs.statSync(safeJoin(aDir, name)).isFile()) { archived = true; break; }
        } catch (err) {
          if (isPathEscape(err)) throw err;
        }
      }
      if (archived) {
        throw new Error(`收件箱无此待取件（${id} 已消费归档，二次取件被拒绝）`);
      }
      throw new Error(`收件箱无此待取件: ${id}`);
    }

    const text = fs.readFileSync(src, 'utf8');
    fs.mkdirSync(aDir, { recursive: true });
    const dst = safeJoin(aDir, path.basename(src));
    try {
      fs.renameSync(src, dst);
    } catch {
      // 极端跨盘场景兜底：复制 + 删除。
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    }
    pruneArchived(aDir);
    return { text };
  },

  writeRaw(filename, text) {
    if (typeof filename !== 'string' || filename.trim() === '') {
      throw new Error(`writeRaw 非法文件名: ${String(filename)}`);
    }
    assertSafeName(filename.trim(), 'writeRaw 文件名');
    let name = filename.trim();
    // listPending 的 id 定义是「文件名去 .md」、取件按 <id>.md 寻址，
    // 无扩展名时自动补 .md，保证 列出→取件 闭环。
    if (!/\.md$/i.test(name)) name += '.md';
    ensureDirs();
    const p = safeJoin(pendingDir(), name);
    fs.writeFileSync(p, text == null ? '' : String(text), 'utf8');
  },
};

export default adapter;
export { parseCardText, scanSections };
