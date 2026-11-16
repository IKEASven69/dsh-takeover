/**
 * Tier 2 跨机演示守门（0.25.0）：scripts/demo-tier2.mjs 以子进程整跑一遍，
 * 断言退出码 0 且终点横幅在场——演示链路（Kiro fixture → readers discover/parse
 * → 蒸馏六段卡 → syncNow 跨机 → B 机取件断言 Turn/六段）随全量测试保持贯通。
 *
 * 为什么跑子进程而不是内联：演示脚本自身就是交付物（README 开发节入口），
 * 以它为唯一真源整跑一遍，脚本与测试永不漂移；脚本内断言失败即退出码 1，
 * 这里只断言「进程退出码 0 + 全链横幅」，中间步骤由脚本自身断言负责。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEMO = join(REPO_ROOT, 'scripts', 'demo-tier2.mjs')

// 演示链路含多趟 git 子进程（syncSetup/syncNow ×3）——Windows 下给足余量，仍远低于真挂死面
const TIMEOUT_MS = 120_000

test('demo-tier2：Tier2 跨机演示整跑一遍——退出码 0、全链横幅在场', () => {
  const stdout = execFileSync(process.execPath, ['--import', 'tsx/esm', DEMO], {
    encoding: 'utf-8',
    timeout: TIMEOUT_MS,
    // 演示自身已把断言失败写进输出并以退出码 1 退出——不吞不粉饰
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.equal(
    stdout.includes('✅ Tier 2 跨机接力：Kiro discover → parse → 蒸馏 → 跨机 → 取件，全链绿。'),
    true,
    `终点横幅缺失，演示未跑通。stdout 尾部：\n${stdout.slice(-2000)}`,
  )
  assert.equal(stdout.includes('❌'), false, '演示输出含失败断言标记（❌）')
})
