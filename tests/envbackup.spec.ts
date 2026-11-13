/**
 * 环境备份/恢复测试（0.2.0 wave2）：root 全注入（不碰真实 user home / 真实 HANDOFF_HOME）。
 * 钉死的不变量：
 * - 备份 = 单个加密 .dshenv：凭据类内容（SECRET-*）在包体与目录里都不存在明文
 * - 错口令 = GCM 认证失败诚实报错，不吐内容
 * - 恢复三段纪律：dry 预演（三态 diff）→ apply（checkpoint 先行）→ rollback 可逆
 * - 路径穿越硬闸（../ / 绝对路径 / 盘符）
 * - 范围容错（缺文件不算错）+ 黑名单目录（node_modules）不进包 + 修剪留 3
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { parseCard, renderCard } from '@agent-handoff/core'
import {
  applyRestore,
  collectScopeFiles,
  createBackup,
  dryRunRestore,
  envBackupDir,
  listBackups,
  pruneBackups,
  readBackupManifest,
  rollbackRestore,
  validateRelPath,
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
