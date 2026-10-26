# eval/ · 评测可复现包（0.4.1 归因版）

> 预注册口径：本文件在实验运行前写定，实验后不改判定标准——改动只能以「追加轮次/追加任务」的形式追加，不能追溯修改成功定义。这是给第三方复现用的入口；数字的当下快照在 `test-artifacts/`（本地，不入库）。

## 可复现的三件事

| 评测 | 问题 | 入口脚本 | 判定 |
|------|------|----------|------|
| 三臂对照实验 | 结构化交接卡是否真的优于纯文本与无卡？ | `node scripts/eval-three-arm.mjs --token <t> --handoff-home <dir>` | 产物文件确定性断言（见下） |
| 失败归因（死亡地图） | 卡都死在哪一环？ | `node scripts/attribution.mjs --home <dir>` | 闭集结局分类（见下） |
| 延续率回测 | 被消费的卡，工作真的延续了吗？账本标注与延续率是否相关？ | `node scripts/backtest-archived.mjs --archived <dir>` | git 提交 × 卡涉及文件的确定性重叠 |

三者的数据底座互相独立：三臂是**受控实验**（前置工作由脚本确定性写入，排除寄存侧噪声）；死亡地图是**观测数据合并**（lifecycle.jsonl + relay 记录 + archived 回测）；回测是**纯 git 证据**。任何一环都可单独重跑。

## 三臂对照实验（预注册）

### 假设

H1：同等信息量下，结构化六段卡的接手成功率 ≥ 纯文本段与最小对照。
H2（段落效用）：warnings 段携带的 marker 事实只在结构化臂物化（纯文本臂即便完成任务也常丢 marker）。
H0（阴性结果也是合法结果）：若 minimal 臂不输，如实报告——结构化的价值就不在单跳小任务场景。

### 臂设计（同源事实，三种结构；前置工作不经过模型）

- `structured`：六段结构化卡。事实分埋：work 事实在 remaining、marker 事实在 warnings、背景在 done。
- `plain`：薄卡。同源事实全部并入 goal 一段散文，其余段为空。
- `minimal`：最小对照。只有「继续这个仓库里的工作」，仓库文件即全部信息。

### 任务与判定（全部确定性，无 LLM 评判）

前置脚本写入：`TODO.md`（内容 `beta`）、`NOTES.md`（`step1: done`）。接手方成功 = 探针齐活：

1. `todoFlipped`：TODO.md 出现 `gamma` 且不再有独行的 `beta`；
2. `noteAppended`：NOTES.md 出现 `step2: done`；
3. `markerUsed`（段落效用探针）：step2 行带 `[TX-77]` 标记——**该标记只存在于交接物中**，仓库内没有任何线索；1/2 是任务完成，3 测「交接触发的事实被接手方遵守」。

### 统计口径（预注册声明）

- 默认 `--rounds 3`：每臂 n=3，**方向性证据，不做显著性宣称**。需显著性请用同脚本 `--rounds N` 延长（脚本无状态，可任意追加）。
- 成功判定是二值确定性断言，不引入评审模型，不存在评判噪声。
- 已知局限（如实声明）：单任务（两文件小收尾）、单模型（host 当前默认模型）、单机。结论外推到复杂任务/其他模型需追加任务集——脚本的任务组装（`armCardSections`/`makeWorkspace`）已参数化，欢迎按同口径扩任务。

## 复现步骤

```bash
# 0) 前置：本地 DSH host 运行中，且其 HANDOFF_HOME 与下面 --handoff-home 一致
#    （三臂卡会写进该 pending/，由 host 的 takeover 路由消费）

# 1) 三臂对照（默认 3 轮 × 3 臂 = 9 次真模型接手，约 30 分钟）
node scripts/eval-three-arm.mjs --token <host-web-token> \
  --handoff-home "$HOME/.handoff" --rounds 3 \
  --out test-artifacts/three-arm-report.json

# 2) 死亡地图（含上一步产生的写侧/取侧事件）
node scripts/attribution.mjs --home "$HOME/.handoff" \
  --out test-artifacts/attribution-report.json

# 3) 延续率回测（archived 目录可指任意一份真实归档）
node scripts/backtest-archived.mjs --archived "$HOME/.handoff/archived" \
  --out test-artifacts/backtest-report.json
```

种子与确定性：三臂脚本无随机源（id 后缀仅防文件名冲突，不进判定）；任务前置、探针判定、报告组装全部是纯文件操作——**同输入必同输出**。

## 死亡地图的闭集结局

| 结局 | 含义 |
|------|------|
| `write_rejected` | 写侧闸拒收（密钥闸/空壳闸），从未落盘 |
| `read_skipped` | 在册但读侧跳过（超尺寸/解析失败），永远不会被消费 |
| `survived` | 已消费且 git 延续证据成立 |
| `died_at_execution` | 已消费但无延续证据——**最值得归因的一格** |
| `unmeasurable` | 消费了但 cwd 缺失/非 git，无法归因（如实计数不粉饰） |
| `in_inbox` | 还在 pending（未到结局） |

理由字段是闭集（`src/lifecycle.ts` 的 `LIFECYCLE_REASONS`）；聚合口径见 `scripts/attribution.mjs` 头注释。

## 隐私纪律

回测与死亡地图的输出只含聚合计数、卡 id、文件 basename；评测任务集是合成的（无任何真实代码/文本）。明细报告写 `test-artifacts/`（.gitignore 内，不入库）。
