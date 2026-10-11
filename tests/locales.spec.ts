/**
 * 词典规范测试：zh/en 键集完全对齐、zh 值必含中文（界面词零英文纪律）、
 * interpolate 占位符行为。词典新增键漏译在这里拦下。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DICTS, NS, interpolate } from '../src/locales.ts'

test('词典规范：zh/en 键集完全对齐（无漏译）', () => {
  const zh = Object.keys(DICTS.zh).sort()
  const en = Object.keys(DICTS.en).sort()
  assert.deepEqual(zh.filter((k) => !en.includes(k)), [], 'zh 有 en 无')
  assert.deepEqual(en.filter((k) => !zh.includes(k)), [], 'en 有 zh 无')
  assert.ok(zh.length >= 30, `词典键数异常：${zh.length}`)
})

test('词典规范：zh 值必含中文（品牌/命令/工具标识符除外）', () => {
  const allowAsciiOnly = new Set(['appTitle']) // 品牌词开头不算违规，但 appTitle 也含中文
  for (const [k, v] of Object.entries(DICTS.zh)) {
    assert.match(v, /[\u4e00-\u9fff]/, `zh.${k} 缺中文：${v}`)
    void allowAsciiOnly
  }
})

test('interpolate：{name} 占位替换；缺参保原样', () => {
  assert.equal(interpolate('拉取 {name} 会话', { name: 'Claude Code' }), '拉取 Claude Code 会话')
  assert.equal(interpolate('确认清空 {n} 张？', { n: 3 }), '确认清空 3 张？')
  assert.equal(interpolate('拉取 {name} 会话'), '拉取 {name} 会话')
  assert.equal(interpolate('纯文本', undefined), '纯文本')
})

test('NS：命名空间为 dsh-takeover', () => {
  assert.equal(NS, 'dsh-takeover')
})
