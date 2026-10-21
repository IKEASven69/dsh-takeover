# handoff: 1 符合性套件（conformance suite）

> 「开放协议」的资格来自第二实现。本目录是 handoff: 1 的**可执行符合性套件**：
> 任何声称实现了协议的代码，接一个适配器就能被打分。

## 用法

```bash
HANDOFF_HOME=<任意临时目录> node conformance/run.mjs --adapter <你的适配器.mjs> [--json <报告.json>]
```

MUST 全过 → exit 0（符合）；任一 MUST 红 → exit 1；SHOULD 红只记 notes 不挡结论。

## 适配器契约

一个 `.mjs` 文件，default 导出：

| 方法 | 语义 |
|---|---|
| `name: string` | 实现名 |
| `home(): string` | 当前生效的 `~/.handoff` 根（必须尊重 `HANDOFF_HOME` 环境变量） |
| `writeCard(text?): { id }` | 按规范生成 id 并写一张合法六段卡进 pending/ |
| `listPending(): string[]` | pending 里的卡片 id 清单（文件名去 `.md`） |
| `load(id): { text }` | 消费即弃取件；失败/二次取件必须 throw |
| `writeRaw(filename, text): void` | 把任意文本放进 pending/（边界向量用） |

适配器文件在 `HANDOFF_HOME` 已设置**之后**才被 import（模块加载时读 env 的实现也能测）。
样例：`conformance/adapter-core.mjs`（包 @agent-handoff/core）。

## 要求清单（全部推导自 SPEC.md 原文）

| 级别 | id | 要求 | SPEC 出处 |
|---|---|---|---|
| MUST | C1 | `HANDOFF_HOME` 覆盖目录根 | 一、 |
| MUST | C2 | 写入即投递（落 pending 即可列出） | 一、 |
| MUST | C3 | 文件名即 id：`ho-*` 形态，frontmatter id 与文件名一致 | 一、二、 |
| MUST | C4 | 六段必选标题按序在场；frontmatter 必填字段 | 二、 |
| MUST | C5 | 缺字段 frontmatter 给默认值，不报错 | 四、版本纪律 |
| MUST | C6 | 未知字段保留不报错；更高 `handoff` 版本容错 | 四、版本纪律 |
| MUST | C7 | 消费即弃：进 archived、离 pending；二次取件必报错 | 三、语义 3 |
| MUST | C8 | 宽松模式：无 frontmatter 纯 Markdown 可列出可取 | 三、语义 3 |
| MUST | C9 | 路径穿越 id 取件必须拒绝 | （安全性推论） |
| SHOULD | C10 | archived 滚动保留 50 份 | 一、 |
| SHOULD | C11 | 并发取件单胜者 | 语义 3 推论 |

## 已测实现（报告在 `conformance/results/`）

| 实现 | 结果 | 报告 |
|---|---|---|
| `@agent-handoff/core`（参考实现） | ✅ 符合（MUST 9/9，SHOULD 2/2） | `results/core.json` |
| `second-impl`（独立实现：只读 SPEC + 适配器契约，从零手写，与两仓代码零接触） | ✅ 符合（MUST 9/9，SHOULD 2/2） | `results/second-impl.json` |

## SPEC 歧义清单

独立实现过程暴露的规范含糊处记录在 `conformance/SPEC-NOTES.md`——第二实现的真正
产出不是「又过了」，而是这些**只有第二实现才会暴露的规范缺口**。
