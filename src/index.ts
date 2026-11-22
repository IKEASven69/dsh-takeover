/**
 * dsh-takeover host 半：会话接管插件（拉取 + 寄存 + 取件）。
 * 注册面 = 工具 handoff_push / handoff_inbox / handoff_memory / handoff_absorb /
 *          handoff_sync / handoff_env / foreign_session_read
 *        + slash /handoff /inbox /ledger /sendto /almanac + /resume-*×23。
 * 权限范围：写 ~/.handoff（可由 HANDOFF_HOME 覆盖）、读 git 状态、只读二十三家本地会话库。
 * @module dsh-takeover
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Context.skills merge（skills 服务声明由 dsh-skill 提供）。
import type {} from '@deepseek-ai/dsh-skill'
import { registerEnvBackupTool, registerInboxTool, registerPushTool, registerSyncTool } from './tools.ts'
import { registerForeignTool } from './foreign.ts'
import { registerMemoryTool } from './memory.ts'
import { registerAbsorbTool } from './absorb.ts'
import { enqueueEnvBackupWrite, registerTakeoverRoutes } from './server.ts'
import { isProviderEnabled, setAutoUpgradeSnapshotEvidence } from './settings.ts'
import { createBackup, dryRunRestore, applyRestore, rollbackRestore, listBackups, maybeAutoUpgradeSnapshot, resolveHostRuntimeVersion } from './envbackup.ts'
import { skillRegistrations } from '../skills/index.ts'

export const name = 'dsh-takeover'
export const inject = ['tools', 'skills'] // userQuestions 为软依赖（safeUserQuestions 兜缺席），硬声明会卡最小 cordis 上下文

export function apply(ctx: Context): void {
  // ③ 升级保险快照触发器（0.26 snapshot 模块接线）：插件激活即查宿主版本变化——
  // 版本源 = @deepseek-ai/dsh-app-boot 的 getDshRuntimeVersion()（勘察结论：与宿主
  // 插件兼容闸 engines.dsh 对比的是同一个值，随宿主升级自动前进；懒加载，宿主外
  // 环境回 null → skipped('host-version-unreadable') 绝不误打）。版本变化且有已存
  // 口令时自动打 auto-upgrade 标签快照（只留最近一份，手动备份绝不动）。fire-and-forget：
  // 失败/skip 不阻塞启动（maybeAutoUpgradeSnapshot 承诺不抛，此处仍兜绝对意外）；
  // 与面板手动备份共用 env-backup 写队列串行（enqueueEnvBackupWrite，重 I/O 不并发）。
  // 口令按 THREAT-MODEL T7 永不落盘、本插件无已存口令机制——缺席即诚实
  // skip('no-passphrase') 且基线不推进（升级事件保持待办），绝不新增交互。
  // 结果三态（created/same/skipped）经 settings 旁证 holder 进 state.envBackup.autoUpgradeSnapshot。
  void resolveHostRuntimeVersion()
    .then((v) => enqueueEnvBackupWrite(() => maybeAutoUpgradeSnapshot(v)))
    .then((r) => { setAutoUpgradeSnapshotEvidence(r) })
    .catch((e: unknown) => {
      try { ctx.logger.warn(`[dsh-takeover] 升级保险快照触发器异常（fail-open，不影响启动）：${e instanceof Error ? e.message : String(e)}`) } catch { /* logger 缺席 */ }
    })
  registerPushTool(ctx)
  registerInboxTool(ctx)
  // 设置卡停用闸：每次调用现读 config.json（开关改动即刻生效，无需重启）
  registerForeignTool(ctx, { isEnabled: (p) => isProviderEnabled(p) })
  registerMemoryTool(ctx)
  // 记忆写回（T8 显式授权动作）：confirm 两步 + 去重 + 快照可回滚，外部会话存储永不写
  registerAbsorbTool(ctx)
  registerSyncTool(ctx)
  registerEnvBackupTool(ctx)
  registerTakeoverRoutes(ctx)
  for (const reg of skillRegistrations()) ctx.skills.register(reg)
  ctx.logger.info('dsh-takeover: 会话接管已加载（工具 handoff_push / handoff_inbox / handoff_memory / handoff_absorb / handoff_sync / handoff_env / foreign_session_read + slash /handoff /inbox /ledger /sendto /almanac + /resume-*×23 + 设置卡 API /dsh-takeover/*）')
}

export { pushHandoff, inboxList, inboxLoad, inboxHistory, pushConfigCard, factsToSections, handoffHostNotice, baselineFromExtras, axisFromExtras, renderBaselineGuidance, inheritParentRemaining, HISTORY_TAIL_MAX, HISTORY_STOPPED_MAX, RELAY_REMAINING_MAX_BYTES } from './tools.ts'
export type { PushArgs, PushResult, InboxItem, InboxListResult, InboxLoadResult, InboxHistoryResult, HistoryItem, ConfigCardPayload, ConfigCardResult, CardAxis, CardPayload, RepoBaseline } from './tools.ts'
export { probeSessionEvents, collectFacts, todoToTasks } from './collect.ts'
export type { ProbeResult, SessionFacts } from './collect.ts'
// 0.26 模块导出面（集成接线 §5.1/§5.4）：上下文预警 / 接力体检 / 延续回执 / 记忆蒸馏。
// 全部是纯函数与立约类型——不新增工具名（registration.spec 的 7 名闭集不动）
export { probeContexthealth, WARN_RATIO, CRITICAL_RATIO } from './contexthealth.ts'
export type { ContexthealthReport, ContexthealthLevel, ContexthealthAction, ContexthealthProjection } from './contexthealth.ts'
export { runFlightcheck, runFlightcheckSafe, claimsFromFlight, FLIGHTCHECK_KINDS, FLIGHT_VERDICTS, CLAIM_STATES } from './flightcheck.ts'
export type {
  FlightVerdict,
  FlightStamp,
  FlightcheckCheck,
  FlightcheckResult,
  FlightcheckOptions,
  FlightcheckSections,
  ClaimRecord,
  ClaimState,
} from './flightcheck.ts'
export { generateReceiptCard, buildReceiptExtras, evidenceFromVerify, firstStepOf } from './receipt.ts'
export type { ReceiptExtras, ReceiptEvidence, ReceiptCardResult, VerifyFacts } from './receipt.ts'
export {
  produceSnapshot,
  consumeDistillSidecar,
  locateHippoSidecar,
  hippoImportRun,
  hippoLedgerPath,
  readHippoLedger,
  recordHippoLedger,
  realHippoRunner,
  hippoEntriesFile,
  HIPPO_SIDECAR_SUFFIX,
  HIPPO_CLI_TIMEOUT_MS,
} from './distill.ts'
export type {
  HippoRunner,
  DistillProduceResult,
  ConsumeDistillResult,
  HippoLedgerEntry,
  HippoSidecarInfo,
  HippoImportRunResult,
  ProduceSnapshotOptions,
} from './distill.ts'
export { FOREIGN_PROVIDERS, PROVIDER_TO_ADAPTER, disabledError, foreignSessionRead, foreignSessionsList, foreignSessionPreview, foreignResolveOne, summarizeTurns, registerForeignTool, renderForeign } from './foreign.ts'
export type {
  ForeignProvider,
  ForeignReadArgs,
  ForeignReadResult,
  ForeignReaders,
  ForeignEnv,
  ForeignResolve,
  ForeignCandidate,
  ForeignListRow,
  ForeignListResult,
  ForeignPreviewResult,
  ForeignSummary,
  ForeignSkeleton,
  ForeignTurn,
} from './foreign.ts'
export {
  buildState,
  clearArchived,
  dismissPending,
  exportsCountOf,
  isProviderEnabled,
  loadSwitches,
  saveSwitches,
  setProviderEnabled,
  setAutoUpgradeSnapshotEvidence,
  switchesPath,
} from './settings.ts'
export type { TakeoverState, TakeoverSwitches, PendingRow, ProviderRow } from './settings.ts'
// 0.26 扩展波导出面（triage 三件 + doctor 体检，纯函数层；接线在 server/tools 注册面）
export { setPin, unsetPin, listPins, isPinned, searchInbox, restoreFromArchived, pinsPath, PINS_FILE, PINS_CAP, BODY_HIT_LINES_MAX, BODY_LINE_SNIPPET_MAX, SEARCH_MAX_CARD_BYTES } from './inboxtriage.ts'
export type { InboxSearchOptions, InboxSearchHit, InboxSearchResult, RestoreResult } from './inboxtriage.ts'
export { scanStore, sidecarOwnerOf, DOCTOR_KINDS } from './sessiondoctor.ts'
export type { DoctorSeverity, DoctorKind, DoctorIssue, DoctorReport } from './sessiondoctor.ts'
export {
  loadSyncConfig,
  saveSyncConfig,
  syncConfigPath,
  syncNow,
  syncPull,
  syncPush,
  syncSetup,
  syncStatusOf,
  redactRemote,
  validateRemoteUrl,
} from './sync.ts'
export type { SyncConfig, SyncOutcome, SyncStatus } from './sync.ts'
export { createBackup, dryRunRestore, applyRestore, rollbackRestore, listBackups, readBackupManifest, collectScopeFiles, envBackupDir, validateRelPath, maybeAutoUpgradeSnapshot, resolveHostRuntimeVersion, envBackupStatePath, readEnvBackupState, writeEnvBackupState, AUTO_UPGRADE_LABEL } from './envbackup.ts'
export type { BackupRow, ScopeFile, BackupResult, BackupManifestRead, ManifestFileRow, DryRunResult, ApplyResult, RestoreDiffRow, AutoUpgradeSnapshotOpts, AutoUpgradeSnapshotValue, EnvBackupStateFile } from './envbackup.ts'
export { registerTakeoverRoutes, admitTakeover, sessionControllerOf, enqueueEnvBackupWrite, runningSourceIdsOf, relaySourceIdOf, attachRunningIds, RUNNING_LIVE_MAX } from './server.ts'
export type { SessionControllerLike, LiveSessionsLike, TakeoverMode, TakeoverOutcome } from './server.ts'
export { scanMemorySources, pushMemoryCard, registerMemoryTool, renderMemory, MEMORY_SOURCES, MEMORY_STORES, readStoreEntries } from './memory.ts'
export type { MemorySourceDef, MemorySourceRow, MemoryStoreDef, MemoryStoreEntry, StoreEntriesRead, MemoryPushArgs, MemoryPushResult } from './memory.ts'
export { absorbCard, registerAbsorbTool, renderAbsorb, parseSuggestedEntries, ABSORB_TARGETS, ABSORB_TOTAL_MAX } from './absorb.ts'
export type { AbsorbArgs, AbsorbDeps, AbsorbResult, AbsorbEntry, AbsorbTargetDef } from './absorb.ts'
export { planInject, applyInject, renderInjectPlan, INJECT_TARGETS } from './configinject.ts'
export type { InjectArgs, InjectDeps, InjectTargetDef, InjectPlan, InjectPlanItem, InjectPlanResult, InjectResult } from './configinject.ts'
export { readBackupEntryBlobs } from './envbackup.ts'
export type { BackupEntryBlob } from './envbackup.ts'
export { outboundCommand, pickupCommand, humanChars, OUTBOUND_TARGETS, OUTBOUND_LABELS } from './browser-view.ts'
export type { OutboundTarget } from './browser-view.ts'
// 0.26 第三波集成接线：四个新模块的导出面（全部纯函数与立约类型——不新增工具名，
// registration.spec 的 7 名闭集不动；接线挂点在 server/client/settings/skills 面）
// ① 接力总账（/ledger）：三源翻账聚合器（面板 GET state?ledger=1 路由层展开）
export {
  readRelayRecords,
  assembleChains,
  zombiesOf,
  judgeZombies,
  aggregateLedger,
  onDiskIdsOf,
  RELAY_SCAN_MAX,
} from './relayledger.ts'
export type {
  RelayLedger,
  RelayLedgerRecord,
  RelayChain,
  ChainStep,
  ZombieEntry,
  LedgerCounts,
  LedgerWindow,
  UnjoinedRow,
} from './relayledger.ts'
// ② 定向投递（/sendto）：machine.json 机器身份 + machine: 寻址 + 三桶分组立约
//    （纯函数层；面板三桶分组经 inbox-view 同口径局部实现，一致性有集成测试钉）
export {
  MACHINE_SCHEME,
  MACHINE_FILE,
  machinePath,
  readMachineName,
  saveMachineName,
  parseAddress,
  toMachineAddress,
  bucketOf,
} from './directed.ts'
export type { AddressBucket, AddressedRow } from './directed.ts'
// ③ 接力年鉴（/almanac）：整机聚合四项统计与确定性渲染
export { buildAlmanac, renderAlmanac } from './almanac.ts'
export type { AlmanacStats, AlmanacRelayStats, AlmanacLifeboatTarget } from './almanac.ts'
// ④ 接管预检（preflight）：「接得住吗」三档判定卡（面板接管按钮前置闸挂点）
export {
  assessForeignTakeover,
  PREFLIGHT_KINDS,
  PREFLIGHT_STATES,
  PREFLIGHT_VERDICTS,
  LIVENESS_RECENT_MS,
} from './preflight.ts'
export type {
  PreflightCard,
  PreflightCheck,
  PreflightWound,
  PreflightInput,
  PreflightKind,
  PreflightCheckState,
  PreflightVerdict,
} from './preflight.ts'
export {
  skillRegistrations,
  handoffSkillRegistration,
  inboxSkillRegistration,
  ledgerSkillRegistration,
  sendtoSkillRegistration,
  almanacSkillRegistration,
  resumeSkillRegistrations,
  resumeSkillContent,
  RESUME_SKILL_SPECS,
} from '../skills/index.ts'
export type { ResumeSkillSpec } from '../skills/index.ts'
export { LEDGER_SKILL_CONTENT, SENDTO_SKILL_CONTENT, ALMANAC_SKILL_CONTENT } from '../skills/index.ts'
