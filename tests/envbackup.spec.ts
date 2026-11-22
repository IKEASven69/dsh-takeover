/**
 * 环境备份/恢复测试（0.2.0 wave2）：root 全注入（不碰真实 user home / 真实 HANDOFF_HOME）。
 * 钉死的不变量：
 * - 备份 = 单个加密 .dshenv：凭据类内容（SECRET-*）在包体与目录里都不存在明文
 * - 错口令 = GCM 认证失败诚实报错，不吐内容
 * - 恢复三段纪律：dry 预演（三态 diff）→ apply（checkpoint 先行）→ rollback 可逆
 * - 路径穿越硬闸（../ / 绝对路径 / 盘符）
 * - 范围容错（缺文件不算错）+ 黑名单目录（node_modules）不进包 + 修剪留 3
 * - 升级保险快照（0.26.1）：首跑只记版本 / 版本变化才打且删旧自动份 / 相同 skip /
 *   无口令 skip+原因且基线不推进 / 手动快照绝不被自动流程清 / 版本源不可读绝不误打
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parseCard, renderCard } from '@agent-handoff/core'
import {
  AUTO_UPGRADE_LABEL,
  applyRestore,
  collectScopeFiles,
  createBackup,
  dryRunRestore,
  envBackupDir,
  envBackupStatePath,
  listBackups,
  maybeAutoUpgradeSnapshot,
  pruneBackups,
  readBackupManifest,
  readEnvBackupState,
  resolveHostRuntimeVersion,
  rollbackRestore,
  validateRelPath,
  writeEnvBackupState,
} from '../src/envbackup.ts'
import { inboxLoad, pushConfigCard } from '../src/tools.ts'

const PASS = 'correct-horse-8'

/** 仿真全家桶 user home：含凭据类 3 个 + 普通配置/登记/skills */
function fakeUserHome(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-env-${label}-`))
  const mk = (rel: string, content: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), content, 'utf-8')
  }
  mk('.dsh/.credentials.yaml', 'SECRET-CREDENTIALS-CONTENT')
  mk('.dsh/typesafe-key', 'SECRET-KEY-CONTENT')
  mk('.dsh/settings.yaml.imported', 'ui-onboarding: done')
  mk('.dsh/profiles/web/cordis.yml', 'plugins: []')
  mk('.dsh/profiles/web/package.json', '{"name":"web"}')
  mk('.agents/skills/myskill/SKILL.md', '# my skill\n')
  mk('.agents/skills/junk/node_modules/deep/blob.bin', 'should-not-collect')
  mk('.agents/skills/myskill/.state/last-run.json', 'runtime-state-not-a-skill')
  mk('.agents/.skill-lock.json', '{"version":1}')
  mk('.zcode/v2/setting.json', '{"locale":"zh"}')
  mk('.zcode/v2/credentials.json', '{"token":"SECRET-TOKEN-CONTENT"}')
  return root
}

function rmRf(p: string): void {
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

test('备份 roundtrip：单加密文件落 env-backup，凭据类计数如实，明文不落盘', () => {
  const root = fakeUserHome('a')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-a-'))
  try {
    const r = createBackup(PASS, home, root)
    assert.equal(r.ok, true)
    assert.equal(r.secretCount, 3, '.credentials.yaml / typesafe-key / zcode credentials 三件凭据类')
    assert.ok(r.files >= 8, `至少收集 8 个文件：${r.files}`)
    const dir = envBackupDir(home)
    const listing = readdirSync(dir)
    assert.equal(listing.filter((f) => !f.endsWith('.dshenv')).length, 0, 'env-backup 目录里只有 .dshenv，无明文伴生')
    const buf = readFileSync(join(dir, r.file))
    assert.ok(!buf.includes('SECRET-CREDENTIALS-CONTENT'), '凭据内容在包体里必须不可见（已加密）')
    assert.ok(!buf.includes('SECRET-TOKEN-CONTENT'))
    assert.equal(listBackups(home).length, 1)
    // 短口令拒收
    assert.throws(() => createBackup('short', home, root), /8 位/)
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('跨机还原：空机器 dry=全新建 → apply 落盘逐字节一致', () => {
  const rootA = fakeUserHome('b-a')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-b-'))
  const rootB = mkdtempSync(join(tmpdir(), 'dsh-env-b-'))
  try {
    createBackup(PASS, home, rootA)
    const { file } = listBackups(home)[0]!
    // B 机：dry → 全部 create
    const dry = dryRunRestore(file, PASS, home, rootB)
    assert.equal(dry.creates, dry.diff.length)
    assert.equal(dry.overwrites, 0)
    // apply → 文件逐字节一致
    const applied = applyRestore(file, PASS, home, rootB)
    assert.equal(applied.applied, dry.creates)
    assert.equal(readFileSync(join(rootB, '.dsh', '.credentials.yaml'), 'utf-8'), 'SECRET-CREDENTIALS-CONTENT')
    assert.equal(readFileSync(join(rootB, '.agents', 'skills', 'myskill', 'SKILL.md'), 'utf-8'), '# my skill\n')
    assert.ok(existsSync(join(rootB, '.dsh', 'profiles', 'web', 'cordis.yml')))
    // 再 dry：全部 same；apply：0 落盘不碰盘
    const dry2 = dryRunRestore(file, PASS, home, rootB)
    assert.equal(dry2.same, dry.diff.length)
    const applied2 = applyRestore(file, PASS, home, rootB)
    assert.equal(applied2.applied, 0)
    assert.match(applied2.detail, /未动任何文件/)
  } finally {
    rmRf(rootA); rmRf(home); rmRf(rootB)
  }
})

test('覆盖还原可逆：改盘后 dry 标 overwrite → apply 先 checkpoint → rollback 还原前状态', () => {
  const rootA = fakeUserHome('c-a')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-c-'))
  const rootB = fakeUserHome('c-b')
  try {
    createBackup(PASS, home, rootA)
    const { file } = listBackups(home)[0]!
    // B 机（与 A 同构但 settings 文件内容不同）先对齐到备份，再改盘制造 overwrite 场景
    applyRestore(file, PASS, home, rootB)
    const settingsB = join(rootB, '.dsh', 'settings.yaml.imported')
    writeFileSync(settingsB, 'ui-onboarding: locally-changed', 'utf-8')
    const dry = dryRunRestore(file, PASS, home, rootB)
    assert.equal(dry.overwrites, 1, '只有被改的那个文件是 overwrite')
    assert.equal(dry.diff.find((r) => r.action === 'overwrite')?.path, '.dsh/settings.yaml.imported')
    // apply → checkpoint 留住本机改法 → rollback 找回
    const applied = applyRestore(file, PASS, home, rootB)
    assert.equal(applied.applied, 1)
    assert.match(readFileSync(settingsB, 'utf-8'), /ui-onboarding: done/, '落盘为备份版')
    assert.ok(applied.checkpointDir !== '')
    const rolled = rollbackRestore(applied.checkpointDir, home, rootB)
    assert.equal(rolled.restored, 1)
    assert.match(readFileSync(settingsB, 'utf-8'), /locally-changed/, '回滚找回本机改法')
  } finally {
    rmRf(rootA); rmRf(home); rmRf(rootB)
  }
})

test('错口令：解密诚实失败，不吐内容', () => {
  const root = fakeUserHome('d')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-d-'))
  try {
    createBackup(PASS, home, root)
    const { file } = listBackups(home)[0]!
    assert.throws(() => dryRunRestore(file, 'wrong-passphrase', home, root), /解密失败/)
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('路径穿越硬闸：.. / 绝对路径 / 盘符 / 空段全部拒收', () => {
  assert.throws(() => validateRelPath('../escape'), /穿越/)
  assert.throws(() => validateRelPath('a/../../b'), /穿越/)
  assert.throws(() => validateRelPath('C:/win/users'), /绝对路径/)
  assert.throws(() => validateRelPath('/etc/passwd'), /绝对路径/)
  assert.throws(() => validateRelPath(''), /空路径/)
  assert.equal(validateRelPath('.dsh/settings.yaml.imported'), '.dsh/settings.yaml.imported')
  assert.equal(validateRelPath('.dsh\\profiles\\web\\cordis.yml'), '.dsh/profiles/web/cordis.yml', '反斜杠归一')
})

test('范围容错 + 黑名单：缺失文件不算错；node_modules 永不进包；修剪留 3', () => {
  const root = fakeUserHome('e')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-e-'))
  try {
    const files = collectScopeFiles(root)
    assert.ok(!files.some((f) => f.path.includes('node_modules')), '黑名单目录不收集')
    assert.ok(files.some((f) => f.path === '.dsh/.credentials.yaml' && f.secret))
    assert.ok(files.every((f) => !f.path.endsWith('/')), '收集产物全是文件')
    // 空家也容错
    const empty = mkdtempSync(join(tmpdir(), 'dsh-env-empty-'))
    try {
      assert.deepEqual(collectScopeFiles(empty), [])
      assert.throws(() => createBackup(PASS, home, empty), /没有找到任何文件/)
    } finally { rmRf(empty) }
    // 修剪：5 个候选留 3
    mkdirSync(envBackupDir(home), { recursive: true })
    for (const f of ['20261101-0000-x.dshenv', '20261102-0000-x.dshenv', '20261103-0000-x.dshenv', '20261104-0000-x.dshenv', '20261105-0000-x.dshenv']) {
      writeFileSync(join(envBackupDir(home), f), 'x', 'utf-8')
    }
    assert.equal(pruneBackups(3, home), 2)
    assert.equal(listBackups(home).length, 3)
  } finally {
    rmRf(root); rmRf(home)
  }
})

// ---------- 配置轴转正（D5 裁决）：readBackupManifest + pushConfigCard（清单+指针出卡） ----------

test('readBackupManifest：口令解密取清单（path/sha256/category 齐全），bytes=密文包本体；错口令诚实失败', () => {
  const root = fakeUserHome('f')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-f-'))
  try {
    createBackup(PASS, home, root)
    const { file } = listBackups(home)[0]!
    const m = readBackupManifest(file, PASS, home)
    assert.equal(m.file, file)
    assert.ok(m.files.length >= 8, `清单应齐：${m.files.length}`)
    const cred = m.files.find((f) => f.path === '.dsh/.credentials.yaml')
    assert.ok(cred, '凭据类文件路径/类别照报（内容只在加密包里）')
    assert.equal(cred?.category, 'dsh-core')
    assert.match(cred?.sha256 ?? '', /^[0-9a-f]{64}$/)
    assert.equal(m.bytes, statSync(join(envBackupDir(home), file)).size, 'bytes = 密文包本体大小（指针口径）')
    assert.ok(m.createdAt !== '' && m.host !== '')
    // 错口令：GCM 认证失败诚实报错
    assert.throws(() => readBackupManifest(file, 'wrong-passphrase', home), /解密失败/)
    // 非 .dshenv 文件名拒收
    assert.throws(() => readBackupManifest('nope.zip', PASS, home), /不合法/)
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('pushConfigCard round-trip：清单+指针成 axis=config/payload=manifest 载荷卡；round-trip 不丢；口令不进卡', () => {
  const root = fakeUserHome('g')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-g-'))
  try {
    // 无备份 → 规范报错
    const none = pushConfigCard({ passphrase: PASS }, { dir: home })
    assert.equal(none.ok, false)
    if (!none.ok) assert.match(none.error, /没有可出卡的环境备份/)
    // 短口令拒收（不碰加密清单）
    createBackup(PASS, home, root)
    const { file } = listBackups(home)[0]!
    const short = pushConfigCard({ passphrase: 'short' }, { dir: home })
    assert.equal(short.ok, false)
    if (!short.ok) assert.match(short.error, /8 位/)
    const r = pushConfigCard({ passphrase: PASS }, { dir: home })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.file, file, '缺省取最近一次备份')
    const raw = readFileSync(join(home, 'pending', `${r.id}.md`), 'utf-8')
    const card = parseCard(raw)
    // 四轴立约：config 轴 + manifest 载荷
    assert.equal(card.extras['axis'], 'config')
    assert.equal(card.extras['payload'], 'manifest')
    const cfg = card.extras['config'] as { backupFile: string; bytes: number; createdAt: string; host: string; secretCount: number; files: Array<{ path: string; sha256: string; category: string }> }
    assert.equal(cfg.backupFile, file)
    assert.ok(cfg.bytes > 0, '密文包指针 bytes 在场')
    assert.equal(cfg.secretCount, 3, '凭据类计数如实（与备份一致）')
    assert.ok(cfg.files.some((f) => f.path === '.dsh/.credentials.yaml' && f.category === 'dsh-core' && /^[0-9a-f]{64}$/.test(f.sha256)))
    // 双重 round-trip：renderCard → parseCard，config 嵌套载荷（对象数组过迷你 YAML）逐值等值
    const again = parseCard(renderCard(card))
    assert.equal(again.extras['axis'], 'config')
    assert.deepEqual(again.extras['config'], cfg)
    // 口令永不进卡
    assert.doesNotMatch(raw, new RegExp(PASS))
    // 六段口径：清单路径+指纹在 files 段、恢复三步在 suggested
    assert.match(raw, /\.dsh\/\.credentials\.yaml/)
    assert.match(raw, /sha256=/)
    assert.match(raw, /action=dry/)
    assert.match(raw, /HISTORY_REPORTED/)
    // 签名全套纪律：机器信封随落（cardSha256 进签名面）
    assert.ok(existsSync(join(home, 'pending', `${r.id}.envelope.json`)), '信封应随卡落 pending/')
    // 取件回读：config 卡正常 load 且带回 axis
    const load = inboxLoad(r.id, { dir: home })
    assert.equal(load.ok, true)
    if (!load.ok) return
    assert.equal(load.axis, 'config')
    assert.match(load.text, /备份清单 \d+ 个文件/)
  } finally {
    rmRf(root); rmRf(home)
  }
})

// ---------- 升级保险快照（0.26.1）：宿主版本变化 → 自动 auto-upgrade 标签快照 ----------

/** env-backup 目录全部文件名（原始名单，含标签件；目录缺失回 []） */
function listAllBackupFiles(home: string): string[] {
  const d = envBackupDir(home)
  return existsSync(d) ? readdirSync(d) : []
}

/** env-backup 目录里的自动快照（auto-upgrade- 前缀）名单 */
function autoFiles(home: string): string[] {
  return listAllBackupFiles(home).filter((f) => f.startsWith(`${AUTO_UPGRADE_LABEL}-`))
}

test('升级快照·首跑：只记基线版本不打快照（无基线不折腾）', () => {
  const root = fakeUserHome('up-a')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-upa-'))
  try {
    const r = maybeAutoUpgradeSnapshot('0.2.2-rc.1', { dir: home, root, passphrase: PASS })
    assert.deepEqual({ action: r.action, reason: r.reason }, { action: 'skipped', reason: 'first-run' })
    // 基线落在 sync.json 的旁伴新键（envbackup-state.json，本机记录）
    assert.equal(envBackupStatePath(home), join(home, 'envbackup-state.json'))
    const state = readEnvBackupState(home)
    assert.equal(state.lastHostVersion, '0.2.2-rc.1')
    assert.ok(state.at !== undefined && state.at !== '', '基线记录时刻在场')
    assert.equal(listAllBackupFiles(home).length, 0, '首跑不产生任何备份文件')
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('升级快照·版本变化：自动打 auto-upgrade 快照（可解密）+ 旧自动份被删；版本相同 skip', () => {
  const root = fakeUserHome('up-b')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-upb-'))
  try {
    // 首跑记 v1
    maybeAutoUpgradeSnapshot('0.2.2-rc.1', { dir: home, root, passphrase: PASS })
    // 预埋一份旧自动快照（老时间戳）——升级后必须被清（只留最近一份）
    mkdirSync(envBackupDir(home), { recursive: true })
    const oldAuto = 'auto-upgrade-20261118-0900-oldhost.dshenv'
    writeFileSync(join(envBackupDir(home), oldAuto), 'stale-auto-not-a-real-pack', 'utf-8')
    // v1 → v2：created
    const r = maybeAutoUpgradeSnapshot('0.2.3-rc.1', { dir: home, root, passphrase: PASS })
    assert.equal(r.action, 'created')
    assert.match(r.file ?? '', /^auto-upgrade-\d{8}-\d{4}-/, '自动快照带 auto-upgrade- 标签前缀')
    assert.equal(readEnvBackupState(home).lastHostVersion, '0.2.3-rc.1', '成功才推进基线')
    const autos = autoFiles(home)
    assert.equal(autos.length, 1, '只留最近一份自动快照')
    assert.equal(autos[0], r.file)
    assert.ok(!autos.includes(oldAuto), '旧自动份已被删')
    // 自动快照是真备份：口令可解密，全家桶清单齐全
    const m = readBackupManifest(r.file ?? '', PASS, home)
    assert.ok(m.files.length >= 8, `自动快照清单齐全：${m.files.length}`)
    assert.equal(m.secretCount, 3)
    // v2 → v3 再升一次：仍是 created，仍只有一份自动快照。同分钟内连升两回会得到同名
    // 文件（时间戳+主机名相同）——覆盖即「最近一份」，保留不变式照样成立；用范围内容
    // 变化证明存留的是新一轮的包（旧内容让位）。
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'mystery-root.json'), 'cycle2-marker', 'utf-8')
    const r2 = maybeAutoUpgradeSnapshot('0.2.4-rc.1', { dir: home, root, passphrase: PASS })
    assert.equal(r2.action, 'created')
    assert.equal(autoFiles(home).length, 1, '第二轮升级后仍只留最近一份')
    const m2 = readBackupManifest(autoFiles(home)[0] ?? '', PASS, home)
    assert.ok(m2.files.some((f) => f.path === '.dsh/mystery-root.json'), '存留自动份是新一轮内容（旧份已让位）')
    // 版本相同：same，不新增文件
    const n = listAllBackupFiles(home).length
    const r3 = maybeAutoUpgradeSnapshot('0.2.4-rc.1', { dir: home, root, passphrase: PASS })
    assert.deepEqual({ action: r3.action, reason: r3.reason }, { action: 'same', reason: undefined })
    assert.equal(listAllBackupFiles(home).length, n, 'same 不动任何文件')
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('升级快照·无口令：skip + 原因，基线不推进（口令就位后补打）——绝不新增交互', () => {
  const root = fakeUserHome('up-c')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-upc-'))
  try {
    maybeAutoUpgradeSnapshot('0.2.2-rc.1', { dir: home, root, passphrase: PASS })
    // v1 → v2 但无已存口令：skip + 原因；基线仍是 v1（升级事件保持待办）
    for (const pass of [undefined, '', 'short']) {
      const r = maybeAutoUpgradeSnapshot('0.2.3-rc.1', { dir: home, root, passphrase: pass })
      assert.deepEqual({ action: r.action, reason: r.reason }, { action: 'skipped', reason: 'no-passphrase' })
      assert.equal(readEnvBackupState(home).lastHostVersion, '0.2.2-rc.1', '无口令 skip 不推进基线')
    }
    assert.equal(autoFiles(home).length, 0, '无口令绝不打快照')
    // 口令就位：同一次升级（v1 基线仍在）补打成功
    const r = maybeAutoUpgradeSnapshot('0.2.3-rc.1', { dir: home, root, passphrase: PASS })
    assert.equal(r.action, 'created')
    assert.equal(readEnvBackupState(home).lastHostVersion, '0.2.3-rc.1')
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('升级快照·手动快照不被清：3 份手动备份原样保留，自动份独立只留一份', () => {
  const root = fakeUserHome('up-d')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-upd-'))
  try {
    maybeAutoUpgradeSnapshot('0.2.2-rc.1', { dir: home, root, passphrase: PASS })
    // 预埋 3 份手动备份（不同时间戳；内容原样不动即「不被清」的判据）
    mkdirSync(envBackupDir(home), { recursive: true })
    const manuals = ['20261101-0000-manual-a.dshenv', '20261102-0000-manual-b.dshenv', '20261103-0000-manual-c.dshenv']
    for (const f of manuals) writeFileSync(join(envBackupDir(home), f), `manual-${f}`, 'utf-8')
    // 升级打自动快照
    const r = maybeAutoUpgradeSnapshot('0.2.3-rc.1', { dir: home, root, passphrase: PASS })
    assert.equal(r.action, 'created')
    const after = listAllBackupFiles(home)
    for (const f of manuals) {
      assert.ok(after.includes(f), `手动备份 ${f} 未被自动流程清掉`)
      assert.equal(readFileSync(join(envBackupDir(home), f), 'utf-8'), `manual-${f}`, '手动备份内容原样')
    }
    assert.equal(autoFiles(home).length, 1, '自动快照独立保留策略：只留最近一份')
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('升级快照·版本源不可读：skipped + 原因，绝不误打、基线不记不动', () => {
  const root = fakeUserHome('up-e')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-upe-'))
  try {
    // 首跑遇不可读：连基线都不记（不折腾）
    for (const bad of [null, undefined, '', '   '] as Array<string | null | undefined>) {
      const r = maybeAutoUpgradeSnapshot(bad, { dir: home, root, passphrase: PASS })
      assert.deepEqual({ action: r.action, reason: r.reason }, { action: 'skipped', reason: 'host-version-unreadable' })
    }
    assert.equal(existsSync(envBackupStatePath(home)), false, '不可读时不记基线')
    assert.equal(listAllBackupFiles(home).length, 0, '不可读时绝不误打')
    // 已有基线遇不可读：基线原样、快照不打
    writeEnvBackupState({ lastHostVersion: '0.2.2-rc.1' }, home)
    const r = maybeAutoUpgradeSnapshot(null, { dir: home, root, passphrase: PASS })
    assert.deepEqual({ action: r.action, reason: r.reason }, { action: 'skipped', reason: 'host-version-unreadable' })
    assert.equal(readEnvBackupState(home).lastHostVersion, '0.2.2-rc.1')
    assert.equal(listAllBackupFiles(home).length, 0)
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('升级快照·备份失败：skipped + 原因，基线不推进（下次启动重试，不烧掉升级事件）', () => {
  const root = fakeUserHome('up-f')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-upf-'))
  const empty = mkdtempSync(join(tmpdir(), 'dsh-env-emptyf-'))
  try {
    maybeAutoUpgradeSnapshot('0.2.2-rc.1', { dir: home, root, passphrase: PASS })
    // v1 → v2 但备份范围空（全家桶未安装）：backup-failed，基线不推进、不留半成品
    const r = maybeAutoUpgradeSnapshot('0.2.3-rc.1', { dir: home, root: empty, passphrase: PASS })
    assert.deepEqual({ action: r.action, reason: r.reason }, { action: 'skipped', reason: 'backup-failed' })
    assert.match(r.detail ?? '', /没有找到任何文件/)
    assert.equal(readEnvBackupState(home).lastHostVersion, '0.2.2-rc.1')
    assert.equal(autoFiles(home).length, 0)
    // 恢复正常范围：同一升级事件重试成功
    const r2 = maybeAutoUpgradeSnapshot('0.2.3-rc.1', { dir: home, root, passphrase: PASS })
    assert.equal(r2.action, 'created')
    assert.equal(readEnvBackupState(home).lastHostVersion, '0.2.3-rc.1')
  } finally {
    rmRf(root); rmRf(home); rmRf(empty)
  }
})

test('升级快照·基线文件损坏：fail-open 按首跑重记（不打快照不误删），warn 不抛', () => {
  const root = fakeUserHome('up-g')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-upg-'))
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(envBackupStatePath(home), '{broken json', 'utf-8')
    assert.deepEqual(readEnvBackupState(home), {})
    const r = maybeAutoUpgradeSnapshot('0.2.2-rc.1', { dir: home, root, passphrase: PASS })
    assert.deepEqual({ action: r.action, reason: r.reason }, { action: 'skipped', reason: 'first-run' })
    assert.equal(readEnvBackupState(home).lastHostVersion, '0.2.2-rc.1', '损坏后重记基线')
    assert.equal(listAllBackupFiles(home).length, 0)
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('listBackups：标签件时间戳从首个时间戳段提取，排序按时间新→旧（标签不压过更新的手动份）', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-lb-'))
  try {
    mkdirSync(envBackupDir(home), { recursive: true })
    for (const f of ['20261101-0000-a.dshenv', 'auto-upgrade-20261115-0900-x.dshenv', '20261110-0000-b.dshenv']) {
      writeFileSync(join(envBackupDir(home), f), 'x', 'utf-8')
    }
    const rows = listBackups(home)
    assert.deepEqual(rows.map((r) => r.file), [
      'auto-upgrade-20261115-0900-x.dshenv',
      '20261110-0000-b.dshenv',
      '20261101-0000-a.dshenv',
    ], '按内嵌时间戳新→旧')
    assert.equal(rows[0]!.at, '20261115-0900', '标签件的 at 是时间戳，不是前缀')
    assert.equal(rows[2]!.at, '20261101-0000')
    // 无标签件时行为与旧口径一致（文件名字典序=时间序）
    rmSync(join(envBackupDir(home), 'auto-upgrade-20261115-0900-x.dshenv'), { force: true })
    assert.deepEqual(listBackups(home).map((r) => r.file), ['20261110-0000-b.dshenv', '20261101-0000-a.dshenv'])
  } finally {
    rmRf(home)
  }
})

test('createBackup 标签闸：非法标签拒收（路径字符/大写/下划线），合法标签件带前缀且手动修剪口径不变', () => {
  const root = fakeUserHome('up-h')
  const home = mkdtempSync(join(tmpdir(), 'dsh-env-home-uph-'))
  try {
    assert.throws(() => createBackup(PASS, home, root, '../evil'), /标签不合法/)
    assert.throws(() => createBackup(PASS, home, root, 'Auto_X'), /标签不合法/)
    const r = createBackup(PASS, home, root, AUTO_UPGRADE_LABEL)
    assert.match(r.file, /^auto-upgrade-\d{8}-\d{4}-/)
    assert.match(r.detail, /手动备份未动/)
  } finally {
    rmRf(root); rmRf(home)
  }
})

test('resolveHostRuntimeVersion：宿主外环境（缺 @deepseek-ai/dsh-app-boot）诚实降级为 null', async () => {
  // 本仓 node_modules 无宿主 app-boot 包（真机由宿主 node_modules 提供）——缺席即 null，
  // 调用方拿到 null 传 maybeAutoUpgradeSnapshot 即 skipped（绝不误打）。正路径由真机验证。
  const v = await resolveHostRuntimeVersion()
  assert.equal(v, null)
})
