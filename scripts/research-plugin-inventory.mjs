import { readFileSync } from 'node:fs'

const base = 'D:/CodingProjects/_dsh-compat-test/node_modules/@deepseek-ai/'
// 1) host 侧 inventory 全文（只有 6KB，直接看）
const inv = readFileSync(base + 'dsh-host-plugin-inventory/lib/index.js', 'utf8')
console.log('===== host plugin-inventory（全文要点）=====')
console.log(JSON.stringify(inv.slice(0, 2600)))
