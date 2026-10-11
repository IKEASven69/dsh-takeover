#!/usr/bin/env node
// link-deps.mjs — 可选的离线构建路径：把 dsh checkout 里的宿主包 junction 链接到
// 本地 node_modules。正常构建不需要本脚本——
// @deepseek-ai/* 的 0.1.7-rc.2 已发布 npm，devDependencies 直接装。
// 只有在 npm 不可用、手边有 dsh checkout 时才用它：
//   node scripts/link-deps.mjs            # 用 DSH_CHECKOUT 环境变量指定的 checkout 路径
//   DSH_CHECKOUT=D:/CodingProjects/deepseek-harness node scripts/link-deps.mjs
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT = resolve(process.argv[2] || process.env.DSH_CHECKOUT || '')

if (!existsSync(join(CHECKOUT, 'packages'))) {
  console.error(`link-deps: 找不到 dsh checkout（${CHECKOUT}）；请设 DSH_CHECKOUT`)
  process.exit(1)
}

// [本地 node_modules 相对路径, checkout 相对路径]——仅构建期类型/打包供给，
// 运行时这些包由宿主注入（peerDependencies）。
const LINKS = [
  ['@deepseek-ai/cordis', 'vendor/cordis'],
  ['@deepseek-ai/cosmokit', 'vendor/cosmokit'],
  ['@deepseek-ai/schemastery', 'vendor/schemastery'],
  ['@deepseek-ai/dsh-tools', 'packages/core/tools'],
  ['@deepseek-ai/dsh-agent', 'packages/core/agent'],
  ['@deepseek-ai/dsh-skill', 'packages/skill/skill'],
  ['@types/node', 'node_modules/@types/node'],
]

console.log(`=== 链接构建依赖（checkout: ${CHECKOUT}）===`)
for (const [name, path] of LINKS) {
  const target = join(ROOT, 'node_modules', name)
  const from = join(CHECKOUT, path)
  if (!existsSync(from)) {
    console.error(`link-deps: 依赖目标缺失: ${from}`)
    process.exit(1)
  }
  rmSync(target, { recursive: true, force: true })
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(resolve(from), resolve(target), process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`  linked ${name} -> ${from}`)
}
console.log('=== link-deps 完成 ===')
