# Phase 4 Durable & Safe Runtime — Handoff

> 用途：薄状态页，只记录基线、授权、阶段状态与下一入口，不复制 SPEC 或 Master Plan。
> 规范：[PHASE4_PLATFORM_SPEC.md](./PHASE4_PLATFORM_SPEC.md)。Phase 3 封板记录：[PHASE3_HANDOFF.md](./PHASE3_HANDOFF.md)。

## 1. Current Status / Baseline

| 项目 | 当前事实 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Phase 3 sealed baseline | `37ce3e6775c49883bc0fd9d046fe53a998ec56ca` — `docs: reseal phase 3 platform` |
| Code baseline | `1dc71d4762a1811e239a016cb089dc04eeb556db` — `test(web): verify live and canonical tool result safety`；sealing commit 只更新 Phase 3 HANDOFF |
| Phase 3 | **COMPLETE**；本轮不重新 review、不修改其封板文档 |
| Phase 4 design input | 最新版 Master Plan 已获用户批准作为 **P4.0 设计输入**；采用最终分页／Core 窗口方案，不采用旧累计历史容量上限草案 |
| 补充约束 | 完整 settled canonical；previous-host unfinished → interrupted；旧审批执行能力不跨重启；无 tool exactly-once/resume/workflow；provider construction 在 trusted composition；Node24 为当前基线而非永久上限 |
| Current authorization | **P4.0 freeze only**；仅两份 Phase 4 文档的冻结、独立提交与正常 push；不授权 implementation、M1、`/goal` 或安装依赖，等待新的实施授权 |
| SPEC 状态 | **COMPLETE / FROZEN**；authoring、八项作者自检与 Independent SPEC Review 已完成 |
| Independent SPEC Review | **PASS — 0 BLOCKER / 0 MAJOR / 0 MINOR；READY TO FREEZE P4.0: YES**（用户确认） |
| 最终冻结基线 | 本次独立提交 `docs: freeze phase 4 architecture` 所记录的两份文档；父提交为 `37ce3e6775c49883bc0fd9d046fe53a998ec56ca`；SPEC §1 起正文 SHA-256：`74ff38c32eec5718e466a1b76700cc92804655687269cd434ebacbb0d13c16fa`。提交 SHA 由 Git 记录及封板报告提供，不自引用尚未生成的提交 SHA |
| 当前修改范围 | 仅新增 `docs/PHASE4_PLATFORM_SPEC.md`、本 HANDOFF；无 production code/tests/manifests 修改 |

Phase 3 HANDOFF 的历史“Phase 4 未授权”不被追溯改写；当前仅 P4.0 文档冻结授权由本页和用户本次指令界定。P4.0 封板不等于批准 M1 实施。

## 2. Milestones

| Milestone | 状态 |
| --- | --- |
| P4.0 Architecture Freeze | **COMPLETE** |
| M1 Durable State | **NOT STARTED** |
| M2 Context Budget | **NOT STARTED** |
| M3 Configuration | **NOT STARTED** |
| M4 Tool Policy / HITL | **NOT STARTED** |
| M5 UX + Acceptance/Seal | **NOT STARTED** |

## 3. Verification / Next Boundary

- 本轮核对实际 Git 基线、最新版 Master Plan 全文、Phase 3 SPEC/HANDOFF 及相关现有契约；未重新评审 Phase 3。
- SPEC §21 记录八项作者自检；它不是独立审查 PASS，也不是新增能力的运行时验收。
- Authoring 轮已验证文档结构、相对链接、空白及变更范围；冻结轮只更新状态／审查结论／授权与基线，SPEC §1 起正文保持上述 SHA-256 不变。提交范围严格限于两份 Phase 4 文档，production/tests/manifests/lockfile 零改动。
- 未运行生产测试、typecheck、build、浏览器、磁盘恢复注入或真实 provider；文档检查不替代后续实现验收。
- Independent SPEC Review 已由用户确认 PASS（0/0/0），P4.0 已冻结；未开始任何实现。下一入口为等待新的 M1 实施授权，而非继续 SPEC authoring 或自动进入 M1。
- 不进入 M1，不调用 `/goal`。后续阶段需要新的明确授权；本页及 SPEC 不能替代授权。
- `.zcode/`、`.zcodeignore` 继续是有意 untracked，不 stage、不 commit；仅两份 Phase 4 文档获准独立提交及正常 push，禁止 amend/squash/rebase/force push。

## 4. M1 Batch 1 Closeout

> 本节为 Batch 1 正式 closeout 轮追加，只记录 Batch 1 关闭后的事实；以上 P4.0 冻结记录与 Milestones 表的历史事实不被追溯改写。

### Current State

| 项目 | 状态 |
| --- | --- |
| P4.0 Architecture Freeze | COMPLETE / FROZEN |
| M1 Batch 1 | **COMPLETE / CLOSED** |
| M1 Batch 2 | NOT STARTED |
| M1 | IN PROGRESS |
| M1 READY TO SEAL | **NO** |
| M2 | NOT STARTED |

关闭依据：Batch 1 初始 durable/safety repair 与其后的 repair chain 全部完成并经自验；最新正式记录——full offline **1192 passed / 0 failed / 16 skipped / 1208 total**、real Chrome strict **16/16 passed, 0 skipped**、typecheck **0 error**、`git diff --check` clean、latest negative controls **3/3 KILLED**、tracked/staged tree clean。

同时明确：**M1 ≠ COMPLETE；M1 ≠ SEALED** —— Batch 2 尚未完成，故 M1 READY TO SEAL = NO。

### Batch 1 Final Baseline

`5e5d0b671e812301a37277e1a2d6dd783d9686cd` — `fix(host): hold a page to both proofs a committed turn carries`

Batch 1 最终实现链的必要摘要（完整历史以 `git log` 为准）：durable state ownership（`bb8c025`）与 Protocol generation 2（`a590444` / `3996f50`）之后，是 repair 链条——request-id 边界与分页片段（`9c2d5ce`、`1327311`）、fault 边界（`4a2226b`）、history/commit trust（`5a9747b`、`0f81fb8`、`f1d624d`）、以及页证明收敛到"turn 侧绑定 + run 级范围结构"双证（`f5540c0`、`5e5d0b6`）。M1 契约权威不因本摘要改变，见下节。

`.zcode/` 内的 review / probe / mutation 文件与 scratch 记忆是过程证据，**不是** contract authority，也不构成本文档的组成部分；它们保持有意 untracked。

### Contract Authority

- `docs/PHASE4_PLATFORM_SPEC.md`
- `docs/PHASE4_M1_CONTRACT_ERRATA.md`（冻结于 `4a1ea52 docs: freeze phase 4 m1 contract errata`）

两者共同构成 M1 契约权威。Protocol generation 保持 `"2"`。

### Review Policy

Batch 1 最终由 **project owner** 基于实现结果、正式 regressions、mutation evidence 及既有 review chain 接受关闭。过程中发生过一轮 closure re-review（判 FAIL，指出 R05 两项实证残余）及其后的 repair 与复核；**没有发生“外部 Sol 最终独立审查 PASS”**，本节不作此表述，也不记录 M1 READY TO SEAL = YES。

### Remaining Batch 2

```
R07 R08 R11 R12 R17 R19
R20 R21 R22 R24 R26 R27
```

- **R12：E3 fragment dependency RESOLVED；R12 overall remains OPEN**（等待 Batch 2 完整处理）。
- 其余为 OPEN / NOT REVIEWED；本轮不重新分析或修复任何 finding，不开始 Batch 2。

## M1 Final Closeout / Seal

> 本节为 seal 轮追加，只记录 M1 关闭与该轮之后的事实；以上 P4.0 冻结与 Batch 1 closeout 的历史事实不被追溯改写。本节由独立 docs-only commit（`docs: seal phase 4 m1`）记录；文档不引用该提交自身的 SHA。

### Current State

| Milestone | 状态 |
| --- | --- |
| P4.0 | COMPLETE / FROZEN |
| M1 Batch 1 | COMPLETE / CLOSED |
| M1 Batch 2 | COMPLETE / CLOSED |
| M1 | **COMPLETE / SEALED** |
| M2 | NOT STARTED |
| M3 | NOT STARTED |
| M4 | NOT STARTED |
| M5 | NOT STARTED |

### M1 Final Implementation Baseline

`025abba9214286dafff7e5b31d029a91f9b743e9` — `fix(host): carry the active pair and one terminal projection`

Batch 2 的 5 个语义 commit（自 `f2f0807` 起，未 amend/squash/rebase）：`a069a07`（durable metadata monotone）、`9054fb8`（history cursor 绑定 committed truth）、`1be931a`（mutation 与 catalogue revision 原子发布）、`b760364`（client 单调 merge）、`025abba`（active pair + 唯一 terminal projection + 验收矩阵）。seal commit 只更新本 HANDOFF。

### Frozen Contract Authority

- `docs/PHASE4_PLATFORM_SPEC.md`
- `docs/PHASE4_M1_CONTRACT_ERRATA.md`（冻结于 `4a1ea52 docs: freeze phase 4 m1 contract errata`）

两者共同构成 M1 契约权威；本 milestone 的两份冻结文档自冻结以来未被修改（`git diff <freeze> 025abba -- <doc>` 为空）。Protocol generation 保持 `"2"`：M1 implementation 未修改 generation、未新增 operation/event/error code/DTO 字段、未引入 schema migration 或新依赖。

### M1 Delivered Capabilities

1. SQLite durable Host repository（独占 ownership、schema version、原子事务、提交未知判定）
2. complete settled-turn canonical persistence（只提交完整收敛 turn，旧 canonical 不被改写）
3. restart reconciliation 与 `interrupted` / `not-started` / `unknown` knowledge
4. bounded history paging 与固定 fence（hard item limit、片段合法、coverage 诚实）
5. durable Run↔Turn ownership proof（turn 侧 owner 绑定 + run 级范围双证）
6. storage fault fail-closed 边界（拒绝伪终态与 current-state bootstrap）
7. request/frame boundedness（requestId 128B、页与 frame 上限、outbox 背压）
8. monotonic durable metadata（时钟回退不回绕 `updatedAt` / run 时间序）
9. authoritative cursor validation（fence 必须是已提交 turn 边界，revision 由 turn index 推导，无签名框架）
10. monotonic Client projection（迟到页不复活/不回退/不抹 gap，`behind` 据 directory 重算）
11. race-safe snapshot/live convergence（active run 与其 session 成对入 cut；cut 后内容 drop+标记+排队复读）
12. atomic publication/revision semantics（rename 发布、plugin 先落 revision 再公告且不吞失败、cancel 公告 runs revision）
13. immutable Client response boundary（返回 DTO 冻结，改写不影响 replica）
14. complete public Run projection（五种终态经 `runs.list` / `runs.get` / snapshot 一致）
15. public-path acceptance coverage（memory + web 两 carrier、真实 Chrome、真实 host/client）

### Batch 2 Closure

Batch 2 的 12 项 finding 全部由 project owner 接受关闭：

```
R07 R08 R11 R12 R17 R19
R20 R21 R22 R24 R26 R27
```

- **R08**：closed by acceptance evidence（reconciliation 先于任何 frame、schema 不可打开的库不产生 host、同库第二 host 被拒）；future async settings/plugin composition readiness 属 **M3**，本轮未改 `createHost` 公开签名。
- **R12**：main finding CLOSED（E3 依赖已闭 + 两 carrier 的 `limit=1` 片段遍历验收）；两个 conservative boundary-flag false-negative 保留为 Hardening Backlog。
- 未重新打开 Batch 1 已关闭 finding；未发生新的 review chain。

### M1 Evidence

| 项目 | 结果 |
| --- | --- |
| full offline | **1249 passed / 0 failed / 0 skipped / 1249 total**（109 files；排除 `real-provider` 与 `.zcode/**`；本机有 Chrome，浏览器用例实际执行） |
| real Chrome strict | **17 passed / 0 failed / 0 skipped**（`pnpm test:web:browser`，required cases 按名 pin） |
| typecheck | root 与 browser project **0 error** |
| negative controls | **8/8 KILLED**（均业务断言失败，restore 一致） |
| `git diff --check` | clean |
| real provider | **NOT RUN**（未运行，不记为 PASS） |

全部 gate 在最终 implementation baseline `025abba` 上通过；seal 轮为 docs-only，未重跑上述 suite。

### M1 Hardening Backlog

非阻塞项，记录但不属于 M1 blocker；除 M2 自身依赖外不主动带入 M2 scope。

1. R12 两个 conservative boundary flags（页首 `turn/end`、页尾 `turn/start` 的 false-negative；从不冒充完整 turn）
2. async settings-driven composition readiness（→ M3）
3. signed/MAC cursor（Frozen M1 明确不要求）
4. plugin desired-state 持久化与恢复（→ M3）
5. `plugins.list` 的 catalogue revision enrichment
6. Core-error 终态 `error_code` 的 durable representation refinement
7. `runs.list` frame estimation refinement（页字节预算仍为逐项估计，未实际越界）
8. `.zcode/` scratch/reviewer tests 必须继续排除在正式 gate 之外

### M2 Boundary

下一个 milestone 为 **M2 — Context Budget**，状态 NOT STARTED。M2 不重新打开 M1，除非后续真实 regression 证明 M1 contract violation；本轮不定义 M2 implementation。

### Review Policy

M1 最终采用 **project-owner acceptance** 流程。Batch 1 有 implementation / regression / mutation 及既有 review chain（含一轮 closure re-review FAIL 与随后 repair）。Batch 2 基于 public-path reproducers、shared-invariant implementation、regression suite、targeted mutations（8/8 KILLED）与 real Chrome acceptance，由 project owner 接受关闭。

**没有发生“外部 Sol 最终独立审查 PASS”**，本节不作此表述。`.zcode/` 内的 probe / mutation / agent scratch 是过程证据，**不是** contract authority，也不构成本文档的组成部分；它们保持有意 untracked、不 stage、不 commit。

## M2 Final Closeout / Seal

> 本节为 seal 轮追加，只记录 M2 关闭与该轮之后的事实；以上 P4.0 冻结、Batch 1 closeout 与 M1 seal 的历史事实不被追溯改写。本节由独立 docs-only commit（`docs: seal phase 4 m2`）记录；文档不引用该提交自身的 SHA。

### Current State

| Milestone | 状态 |
| --- | --- |
| P4.0 | COMPLETE / FROZEN |
| M1 | COMPLETE / SEALED |
| M2 | **COMPLETE / SEALED** |
| M3 | NOT STARTED |
| M4 | NOT STARTED |
| M5 | NOT STARTED |

M2 不再重新打开，除非后续真实 regression 证明 Frozen M2 contract violation。

### M2 Final Implementation Baseline

`f0c00f79a11847dad105f4218b7493c49619a1c7` — `fix(model-pi-ai): reject unsupported bounded profiles at construction`

它由 M2 的 4 个 semantic implementation commits 与 1 个 owner repair commit 组成（自 `0dfe829` 起，未 amend/squash/rebase）：

| SHA | Subject |
| --- | --- |
| `3b8d08afec0957946a7be0cfb1e81208317e0238` | `feat(core): define bounded model context contract` |
| `1902cfb300162824b92362d38befb39f9011b47e` | `feat(core): select and guard bounded model requests` |
| `ea468dce072ec55f96e4412aed8f55bc1d799d77` | `fix(host): reject impossible runs before admission` |
| `f3cc7a2c862fc9fa037cc1813e05e146b602b107` | `feat(model-pi-ai): enforce request output caps` |
| `f0c00f79a11847dad105f4218b7493c49619a1c7` | `fix(model-pi-ai): reject unsupported bounded profiles at construction`（owner repair） |

seal commit 只更新本 HANDOFF。

### Frozen Contract Authority

- `docs/PHASE4_PLATFORM_SPEC.md`
- `docs/PHASE4_M1_CONTRACT_ERRATA.md`（冻结于 `4a1ea52 docs: freeze phase 4 m1 contract errata`）

两者共同构成契约权威；两份冻结文档自冻结以来未被修改。Protocol generation 保持 `"2"`：M2 implementation 与 owner repair **未修改 Frozen Contract**，未新增 wire operation/event/error/DTO，未引入 schema migration，未新增 production dependency，未改变 Protocol generation。

### M2 Delivered Capabilities

1. provider-neutral `ModelLimits`（adapter 声明，Core 校验、冻结、拒绝不可信值）
2. finite `ModelBudget`（由 limits 唯一推导，无调用方可自定义的 reserve）
3. required per-request `maxOutputTokens`
4. deterministic conservative UTF-8 estimator（stable JSON 语义成本）
5. dynamic arguments escaping accounting（tool arguments 的二次转义）
6. complete historical Turn suffix selection（whole turn only）
7. no-skip historical selection（放不下即结束选择）
8. current `ToolResult` model-only truncation（显式 marker、UTF-8 安全）
9. canonical context immutability（模型副本不写回 session/repository/canonical）
10. owned immutable `ModelRequest`（深拷贝 + 冻结 + cap 由 Core 写定）
11. independent per-attempt final guard（不信任 builder 自报，不用调用方给的 budget）
12. same-step retry request reuse（同一 frozen request）
13. follow-up step rebuild（每 step 重新读取 current ToolRegistry）
14. pre-admission context feasibility check（Host：lease 后、admit 前、零 durable 事实）
15. shared finite `LoopResourceLimits`（Core 与 Host wrapper 同一 profile）
16. whole-batch tool-call validation before first execution
17. post-side-effect resource-fault honesty（穿透 tool catch，不伪造 turn/end）
18. actual pi-ai output-cap enforcement（每次 invocation 前 payload guard）
19. supported bounded profiles：OpenAI-compatible、DeepSeek-compatible、Anthropic raw messages
20. unsupported output-cap profile fail-closed at adapter construction

### Budget Contract

```text
estimatedInput + R + S <= C
R = min(4096, modelMaxOutputTokens)
S = max(1024, ceil(0.1 * C))
```

首版 estimator 为 **UTF-8 conservative estimate + framing + dynamic escaping**，不是精确 tokenizer，也不宣称
`1 byte == 1 token`；保证的是有限请求、确定性估算与真实 output cap。模型 limits 由 adapter/composition 从
native metadata 解析并校验，Core 不按 model name 联网或猜测；未知/不可信 limits 不默认为无限。

### Context Selection Semantics

- M1 execution window（storage/read bounded candidate window）与 M2 model context（model-request bounded
  selection）是两个不同边界；M1 的 `16 turns / 256 KiB / real seq / whole turns` 未因 M2 改变。
- 历史上下文取 **recent complete-turn suffix**，whole Turn only：第一个旧 Turn 不 fit 即 `break`，
  不继续搜索更老 Turn；历史 Turn 内容不做任何截断。
- 只有当前 open Turn 的 `ToolResult.content` 允许 **model-only truncation**（显式 marker、确定性、
  code point 边界安全）；保留 call identity / tool identity / ok / pairing。
- canonical 永远不修改：session、repository、history page 与 durable commit 保留 tool 实际产生的字节。

### Runtime / Retry Semantics

- 每 model step：重新读取 current ToolRegistry，重新 build / estimate / select / guard；无 per-turn registry snapshot。
- same-step retry：复用同一个 owned immutable `ModelRequest`；每 attempt 重新执行 final budget guard。
- 保留既有语义：`MAX_STEPS = 12`、`MAX_MODEL_ATTEMPTS = 3`、retry only if no text、abort priority、
  staged tool call 在失败 attempt 中不执行、每 completed model step 恰好一个 assistant declaration。
- deterministic 失败（budget / limits / candidate / unsupported cap / managed declaration）一律 nonretryable；
  未知 provider 错误默认 safe nonretryable，不从 raw message 猜测 transient。

### Resource Profile

当前 M2 默认 runtime profile：`maxToolCallsPerStep = 16`、`maxNeutralItemBytes = 64 KiB`、
`maxCurrentTurnBytes = 1 MiB`、`maxJsonDepth = 32`。

这些是当前 **execution profile defaults**，不是 Protocol 永久法律；Core neutral item 上限与 Host durable
record 上限仍是两把不同的尺子，两道 guard 都保留。若未来将其配置化（M3），需要另行授权。

### Provider Profile Boundary

| 项目 | 事实 |
| --- | --- |
| SUPPORTED | OpenAI-compatible、DeepSeek-compatible、Anthropic raw messages |
| Unsupported / unaudited API profile | 在 **ModelClient construction** 确定性 fail closed；不得先形成 executable ready profile 再等第一次 ModelRequest 失败 |
| real provider | **NOT RUN**（未运行，不记为 PASS） |

证据分三类且禁止混淆：Core deterministic tests；real pi-ai serializer/body tests（真实 serializer + stubbed
transport，证明实际请求体 cap === R）；real provider **NOT RUN**。

### M2 Evidence

| 项目 | 结果 |
| --- | --- |
| full offline | **1355 passed / 0 failed / 0 skipped / 1355 total**（114 files；排除 `real-provider` 与 `.zcode/**`；本机有 Chrome，浏览器用例实际执行） |
| real Chrome strict | **17 passed / 0 failed / 0 skipped**（`pnpm test:web:browser`，required cases 全通过、无 SKIP） |
| adapter（`packages/model-pi-ai`） | **119 passed / 0 failed / 0 skipped** |
| repair integration/composition | **131 passed / 0 failed / 0 skipped** |
| typecheck | root 与 browser project **PASS** |
| `build:web` | **PASS** |
| `git diff --check` | clean |
| negative controls（原 M2） | **NC1–NC7 = 7/7 KILLED**（均业务断言失败，restore 一致、无 residue） |
| negative control（owner repair） | **NC8（construction→stream-time mutant）= KILLED** |
| real provider | **NOT RUN** |

全部 gate 在最终 implementation baseline `f0c00f7` 上通过；seal 轮为 docs-only，未重跑上述 suite。

### M2 Hardening Backlog

非阻塞项，记录但不属于 M2 blocker：

1. 未来 tokenizer-aware estimator 可替换 conservative estimator，但不得绕过 final guard。
2. 未来更多 pi-ai API profile 需各自 serializer/body cap evidence 才能进入 supported 集合。
3. provider transient retry classification 只能来自 typed trusted signal；不得 regex raw provider message。
4. selection / local diagnostic report 未来可增强，不新增 wire tracing。
5. `LoopResourceLimits` 的持久 settings 属 M3；未经授权不改公开签名。
6. M1 backlog 保持原状态，M2 seal 不重开 M1。

### M3 Boundary

下一个 milestone 为 **M3 — Configuration**，状态 **NOT STARTED**。既有 Frozen Phase 4 边界记录如下（本轮不
定义实现）：persistent non-secret settings、desired/effective state、credential seam、plugin
desired/config persistence、settings-driven composition readiness。本轮不 Plan、不 Implement、不改任何
settings production code。

### Review / Acceptance Policy

M2 采用：ChatGPT architecture research → Sol 6.1 Implementation Plan → DSFlash implementation →
project-owner acceptance → 一次 targeted owner repair → project-owner closeout。

**实施后没有发生“外部 Sol 最终独立 implementation review PASS”**，本节不作此表述。

Owner Repair 原因（精炼）：unaudited output-cap profile 原先在 **first request** 才 fail，owner 要求提升为
**adapter construction-time fail closed**，使 known-invalid execution profile 不能形成可执行 ready
composition，也不能先 admit durable Run 再暴露。Repair 完成后 full gates green、NC8 KILLED。

`.zcode/` 内的 probe / mutation / scratch 是过程证据，**不是** contract authority，也不构成本文档的组成
部分；它们保持有意 untracked、不 stage、不 commit。
## M3 Final Closeout / Seal

> 本节为 seal 轮追加，只记录 M3 关闭与该轮之后的事实；以上 P4.0 冻结、M1 Batch 1 closeout、M1 seal 与 M2
> seal 的历史事实不被追溯改写。本节由独立 docs-only commit（`docs: seal phase 4 m3`）记录；文档不引用该
> 提交自身的 SHA。

### Current State

| Milestone | 状态 |
| --- | --- |
| P4.0 | COMPLETE / FROZEN |
| M1 | COMPLETE / SEALED |
| M2 | COMPLETE / SEALED |
| M3 | **COMPLETE / SEALED** |
| M4 | NOT STARTED |
| M5 | NOT STARTED |

M3 不再重新打开，除非后续真实 regression 证明 Frozen Contract violation。

### Owner Acceptance

M3 IMPLEMENTATION **PASS**；M3 OWNER ACCEPTANCE **PASS**；M3 READY TO SEAL **YES**。Repair rounds：**0 / 1**
（本轮不使用 owner repair）。实现期（acceptance 之前）由 implementer 当轮发现并修复的缺陷不计为 owner
repair round，见本节 Review / Acceptance Policy。

### M3 Final Implementation Baseline

`fa814b8210ebe205f5436152c5b7335f1808815f` — `test(m3): close configuration acceptance`

它由 M3 的 5 个 semantic commits 组成（自 `0e823bd` 起，未 amend/squash/rebase）：

| SHA | Subject |
| --- | --- |
| `d363e5772c207252803acb6bbd22ece9b7527f52` | `feat(host): persist versioned configuration` |
| `48fb2525c0645f1e75c73cf723e3a5963ac64961` | `feat(host): compose runtime from persisted settings` |
| `6fd254ebebdd6f1d7ce41b637a9cd89e086db377` | `feat(host): restore persistent plugin intent` |
| `7bf25ee5822a04ec1fa14e58d7715b0f14c7578f` | `feat(protocol): expose persistent configuration state` |
| `fa814b8210ebe205f5436152c5b7335f1808815f` | `test(m3): close configuration acceptance` |

seal commit 只更新本 HANDOFF。

### Frozen Contract Authority

- `docs/PHASE4_PLATFORM_SPEC.md`
- `docs/PHASE4_M1_CONTRACT_ERRATA.md`

两者共同构成契约权威；两份冻结文档自冻结以来未被修改。Protocol generation 保持 `"2"`：M3 implementation
**未修改 Frozen Contract**，未重定义任何已冻结语义，未新增 production dependency。schema 由 **2 → 3**，
这是 M3 明确授权并要求的迁移。

### M3 Delivered Capabilities

1. durable versioned non-secret settings（`settings_namespaces`：namespace/schema_version/revision/value_json/updated_at）
2. namespace-scoped CAS（事务内重读 revision，冲突零写，revision 上界 fail closed）
3. 三个 namespace 域：`host`、`model`、`plugin:<pluginId>`（各自独立 revision，互不制造冲突）
4. desired / effective 分离（desired 落库，effective 是本实例内存事实）
5. restartRequired（只由 config/settings 的 revision 差异推导）
6. ordinary settings restart-to-apply（无 model/contextBuilder/system prompt/loop/plugin config 热换）
7. async settings-driven Host readiness（`createHost`/`composeHost` 返回 Promise，完成后才交出可执行 Host）
8. trusted provider/model catalog validation（精确 provider/model 查询）
9. trusted endpoint allowlist（canonical full base endpoint 精确匹配，拒绝时不回显 URL）
10. explicit composition-only credential boundary（CredentialProvider 只在 trusted composition 内部）
11. no ambient credential fallback（apiKey 必须显式，禁 `undefined → SDK credential store`）
12. trusted bootstrap defaults persisted once（首版验证后一次事务写入，此后不覆盖）
13. HostSettings runtime consumption（默认 ContextBuilder 的 systemPrompt、AgentLoop 的 maxSteps/maxModelAttempts）
14. ModelSettings runtime consumption（provider/model/baseURL/timeout 经 composition 真实落到 adapter）
15. M2 output reserve 集成（`outputReserveTokens` 只收紧、不放大 M2 默认 R，并贯穿 preflight/selection/final guard/实际 cap）
16. plugin config schema/version（descriptor 的 schemaVersion + defaultValue + 纯同步 validate）
17. registered / desiredEnabled / actual lifecycle 严格分离
18. plugin desired/effective config revision 分离
19. intent-first plugin lifecycle（先 durable intent，再 lifecycle；失败不回滚 desired）
20. startup plugin restore（每个最多一次尝试，不后台重试）
21. unknown plugin retention without code loading（保留 durable row，不 install/import/load）
22. `settings.get`（有界期望/生效快照；未托管 namespace 一律 CAPABILITY_NOT_SUPPORTED）
23. `settings.update`（expectedRevision + 封闭 schema full replacement，零写冲突）
24. `settings.updated`（bounded invalidation，只带 namespace/revision/restartRequired）
25. `SettingsSnapshot`
26. safe PluginSummary settings state（desiredEnabled/configRevision/effectiveConfigRevision/restartRequired/unavailable）
27. bounded Client settings projection（有界 cache、迟到读单调、事件只标 stale、不自动 replay）

### Desired / Effective Law

Database 只持久 **desired**：values、revision、schema/version。当前 Host 仅在内存维护 **effective**：
values 与 effective revisions。

effective **不是** durable flag，也**不是**上一 Host 的遗留事实：它由本实例在 readiness 中读取并校验
desired、经 trusted composition 构造执行后才成立，effectiveRevision 不从旧 Host 或 DB 继承。

- 普通 settings update：desired 前进、effective 不变、`restartRequired=true`。
- clean restart 成功后：desired 成为 effective、`restartRequired=false`。
- `desiredEnabled != actual` 只由 lifecycle 表达，**不得**被写成 restartRequired。

### Settings Whitelist

| Namespace | implemented（首版） | deferred | forbidden |
| --- | --- | --- | --- |
| HostSettings | `systemPrompt`（UTF-8 ≤8 KiB）；`loop.maxSteps`（1..现有 hard max）；`loop.maxModelAttempts`（1..现有 hard max） | `maxToolCallsPerStep`、`maxNeutralItemBytes`、`maxCurrentTurnBytes`、`maxJsonDepth` 的配置化；approval timeout | apiKey/token/auth、arbitrary SDK options、grants、DB path、module path、tool policy |
| ModelSettings | `provider`、`model`、`baseURL?`、`outputReserveTokens?`、`timeoutMs?` | `temperature`（需先有真实 adapter consumption） | 同上，另含 headers/retries/env、secret URL |
| PluginSettings | 版本化、经可信插件 schema 校验的 non-secret config | plugin config schema migration tooling | 安装位置/代码、权限自授、credentials |

HostSettings 的两项 loop 值只能收紧当前 hard profile，不能突破 M2 上限；ModelSettings 的 provider/model
必须精确命中 trusted catalog，baseURL 必须精确命中 trusted allowlist。

### Credential Boundary

CredentialProvider 只在 trusted composition 内部使用，首版支持 **controlled environment mapping** 与
**explicit injection**（映射声明变量名，禁止由 provider string 动态拼环境变量名）。

credential 不得进入：ordinary settings、SQLite config、Protocol DTO、ClientSnapshot、plugin config、
session metadata、ordinary logs/errors。missing credential 在 provider construction 之前 **startup fail
closed**；不得把 `undefined` 交给 SDK 触发 ambient credential store。

现有证据为 **real pi-ai serializer + stubbed transport**（真实序列化器 + 被替换的 socket）：证明受管
credential 确实进入 provider auth 请求（authorization header）。**real provider：NOT RUN**，不得记为 PASS。

### Plugin Truth Model

三层严格分离：**registered**（由 registered-only catalogue membership 表达，DB row 绝不是 installed
proof）、**desiredEnabled**（durable intent）、**actual lifecycle**（本实例事实）。config 另有两态：
**desired config revision** 与 **effective config revision**，以及由两者推出的 `restartRequired`。

- config update：restart-to-apply。
- enable/disable：可 live，但**只能使用本实例 current effective config**。
- intent write 必须先于 lifecycle；lifecycle 失败**不回滚** desired，actual 按真实 disabled/error/cleanup 上报。
- unknown plugin：保留 durable row，不自动 install/import/load，不进入 snapshot。
- plugin 的 effective config 在注册时绑定并 deep-freeze，`enable()` 不接收 config；不存在 hot reload /
  setConfig / dynamic resolver。

### Startup Readiness

顺序语义：storage ownership → schema/migration → load/bootstrap desired settings → validate desired →
trusted composition → credential resolution → execution dependency construction → M2 validation →
reconciliation → plugin registration/restore → readiness/publication checks → effective revisions → ready。

上述必要阶段全部完成前，不得返回 executable Host；任何一步失败按逆序释放（settle lifecycle → 释放
plugins → dispose composition → 最后关库）。durable failure **不得** fallback ephemeral。

### Protocol / Client

新增 `settings.get`、`settings.update`、`settings.updated` 与 `SettingsSnapshot`；`PluginSummary` 增加
desired/config/restart 安全状态；`HostSnapshot` 增加固定的 safe settings summaries；`capabilities.settings`
在 repository/dispatcher/Protocol/Client/readiness 全部接线完成后才置 `true`。Protocol 仍为 `"2"`。

`settings.updated` 只广播 bounded invalidation（namespace/revision/restartRequired），不广播完整 config 或
secret；丢失事件靠 resync/settings.get，不建设 durable event replay。

Client 保持 React-free、immutable、bounded、non-authoritative：有界 settings cache（当前 implementation
profile：最多 8 个 namespace）、迟到读不覆盖更高 revision、重连/换 Host 使旧 effective fact 失效（换
hostInstance 直接丢弃 cache）、写入不自动 replay（丢失应答靠显式 read 确认）。

### Credential Sentinel Evidence

正式测试在运行时生成 `CREDENTIAL_SENTINEL_M3_DO_NOT_LEAK_<random>`（不硬编码进源码），并先证明它确实
进入 trusted provider auth path（stubbed socket 收到 `authorization: Bearer <sentinel>`）。随后检查
runtime produced artifacts，全部 **0 次出现**：

| artifact | sentinel 出现次数 |
| --- | --- |
| SQLite logical rows / DB main file / journal-WAL-SHM 若存在 | 0 |
| actual encoded Protocol frames（host 方向） | 0 |
| SettingsSnapshot / settings.get/update result | 0 |
| PluginSummary / HostSnapshot | 0 |
| ClientSnapshot / cache | 0 |
| Session metadata/history、Run failure/terminal | 0 |
| startup safe error、provider construction failure | 0 |
| captured logs/stdout/stderr | 0 |

这是**系统受管 credential 流**的验收，不是通用 secret detector：它不声称能识别用户主动粘贴进聊天或普通
文本的秘密，也不宣称能隔离恶意同进程插件。

### M3 Acceptance

**A01–A40：40/40 PASS**（覆盖位置：`packages/host/tests/settings-repository.test.ts`、`settings-composition.test.ts`、
`settings-rpc.test.ts`、`plugin-configuration.test.ts`、`packages/model-pi-ai/tests/pi-ai-composition.test.ts`、
`packages/client/tests/settings.test.ts`、`settings-projection.test.ts`、`tests/integration/persistent-configuration.test.ts`、
`tests/integration/credential-boundary.test.ts`）。

额外的关键断言同样通过：host/model CAS 互不冲突；error 状态插件仍可先持久化 desired=false；
settings 迟到 read 不覆盖更高 revision；storageFault 后 settings 入口不绕过 M1 fail-closed
（`settings.get`/`settings.update` 都在 current-state 边界内）。

### Negative Controls

| NC | mutant | 结果 |
| --- | --- | --- |
| NC1 | settings CAS 忽略调用方 expectedRevision | **KILLED** |
| NC2 | startup 用 hardcoded/bootstrap model 而非持久化值 | **KILLED** |
| NC3 | credential 被写入 settings DB | **KILLED** |
| NC4 | missing credential 传 undefined 允许 ambient fallback | **KILLED** |
| NC5 | plugin lifecycle 先于 intent commit | **KILLED** |
| NC6 | lifecycle 失败后 rollback desired | **KILLED** |
| NC7 | pending plugin config 被当作 effective 使用/上报 | **KILLED** |
| NC8 | 每次 startup bootstrap 覆盖已有 desired | **KILLED** |

**8/8 KILLED**：每条均以 business assertion 失败，mutant 真实加载、restore 精确、恢复后目标测试重新变绿；
compile/import/not-run 不计入。

### M3 Evidence

| 项目 | 结果 |
| --- | --- |
| full offline（排除 `real-provider` 与 `.zcode/**`；本机有 Chrome，浏览器用例实际执行） | **1460 passed / 0 failed / 0 skipped / 1460 total** |
| real Chrome strict（`pnpm test:web:browser`） | **17 passed / 0 failed / 0 skipped**（原 17 required cases 全通过，无 SKIP；未新增 M3 browser case） |
| Host / repository | **391 passed** |
| plugin-system | **81 passed** |
| Protocol | **182 passed** |
| Client | **212 passed** |
| model-pi-ai（adapter） | **60 passed** |
| Integration | **152 passed** |
| typecheck（root + browser project） | **PASS** |
| `pnpm build:web` | **PASS** |
| `git diff --check` | clean |
| negative controls | **NC1–NC8 = 8/8 KILLED** |
| real provider | **NOT RUN**（未运行，不记为 PASS；faux provider / stubbed socket / serializer body 均不冒充 real-provider） |

全部 gate 在最终 implementation baseline `fa814b8` 上通过；seal 轮为 docs-only，未重跑上述 suite。

### M3 Hardening Backlog

非阻塞项，记录但不属于 M3 blocker：

1. `temperature` 等更多 ModelSettings 需要先有真实 adapter consumption。
2. 更多 `LoopResourceLimits` 的配置化需要单独的边界验收。
3. plugin config schema migration tooling（未来再做；绝不自动 fallback 到 default）。
4. M5 settings/restart UX。
5. 更强的真实 disk-full / read-only / cross-platform storage fault suite。
6. 未来更多 provider/profile 仍需各自的 serializer/body readiness evidence。
7. credential vault / OAuth 明确仍不属于当前能力。

以下**不是** backlog，它们是 M3 contract 本身：credential 不进入普通 settings/wire/DB/log、CAS 正确性、
plugin pending config 语义、startup readiness、endpoint trust。

### M4 Boundary

下一个 milestone 为 **M4 — Tool Policy / Minimal HITL**，状态 **NOT STARTED**。既有 Frozen Phase 4 边界
记录如下（本轮不定义实现）：prepared execution binding、policy 决策 allow / deny / require-approval、
Host-owned ApprovalRecord、approve 先于 tool invocation、same-host execution capability、
timeout/cancel/disconnect 竞态、每个 executionId at-most-once dispatch。

本轮不设计 M4、不实施 M4、不改 policy production code、不加 approval UI。

### Review / Acceptance Policy

M3 采用：ChatGPT architecture research（含 D1–D14 冻结决策）→ Sol 6.1 一份 Implementation Plan →
DSFlash 一次性 implementation（实现期内自行发现并修复缺陷，均在 acceptance 之前）→ project-owner
acceptance PASS。**Owner repair：NOT USED**（0 / 1）。

**实施后没有发生“外部 Sol 最终独立 implementation review PASS”**，本节不作此表述。

`.zcode/` 内的 probe / mutation / scratch 是过程证据，**不是** contract authority，也不构成本文档的组成
部分；它们保持有意 untracked、不 stage、不 commit。

## M4 Final Closeout / Seal

> 本节为 seal 轮追加，只记录 M4 关闭与该轮之后的事实；以上 P4.0 冻结、M1 Batch 1 closeout、M1 seal、M2
> seal 与 M3 seal 的历史事实不被追溯改写。本节由独立 docs-only commit（`docs: seal phase 4 m4`）记录；
> 文档不引用该提交自身的 SHA。

### Current State

| Milestone | 状态 |
| --- | --- |
| P4.0 | COMPLETE / FROZEN |
| M1 | COMPLETE / SEALED |
| M2 | COMPLETE / SEALED |
| M3 | COMPLETE / SEALED |
| M4 | **COMPLETE / SEALED** |
| M5 | NOT STARTED |

M4 不再重新打开，除非后续真实 regression 证明 Frozen Contract violation。

### M4 Final Implementation Baseline

`d30caea3f5acccf575557cb8d374f7c25aac7e75` — `test(m4): close hitl execution acceptance`

它由 M4 的 4 个 semantic commits 组成（自 `b37b246` 起，未 amend/squash/rebase）：

| SHA | Subject |
| --- | --- |
| `107aca08e075d0ab8be23386b797dd2802616a1a` | `feat(core): prepare bound tool executions` |
| `5667227ed6372e4e240ca2966a0342cab5a621ed` | `feat(host): enforce policy and coordinate tool approvals` |
| `3e622da65b6e03548d29d3e6edab6b3b0f30634e` | `feat(client): support typed tool approval replies` |
| `d30caea3f5acccf575557cb8d374f7c25aac7e75` | `test(m4): close hitl execution acceptance` |

seal commit 只更新本 HANDOFF。

### Frozen Contract Authority

- `docs/PHASE4_PLATFORM_SPEC.md`
- `docs/PHASE4_M1_CONTRACT_ERRATA.md`

两者共同构成契约权威；两份冻结文档自冻结以来未被修改（`git diff b37b246 d30caea -- docs/PHASE4_PLATFORM_SPEC.md docs/PHASE4_M1_CONTRACT_ERRATA.md` 为空）。Protocol generation 保持 **`"2"`**：M4 implementation **未修改 Frozen Contract**，未新增 frozen semantics，未新增 forward operation、error code 或 DTO；schema version 仍为 **3**（无 migration）；新增 production dependency 为零。

### Approval / Execution Profile

Frozen Contract 未规定具体数值，以下是 M4 的 current implementation profile（集中定义于
`packages/host/src/limits.ts`，不是 Protocol 永久 law，也不是 M3 Settings）：

| 项目 | 当前 profile |
| --- | --- |
| business approval deadline | 120 000 ms（Host monotonic clock 为 authority） |
| approval exact input | ≤ 24 KiB（不可完整表示时 fail closed，不静默截断） |
| ApprovalSnapshot encoding | ≤ 32 KiB |
| pending business approval | ≤ 1 |
| active deliveries / approval | ≤ 8（每 connection/stream 至多 1） |
| projection rendezvous | 有界内部等待，仅 fail closed，可被 cancel/closing/storageFault/run settle 立即唤醒 |

### M4 Delivered Capabilities

1. whole-group pre-log preparation（validate ALL → prepare ALL → 只有全部成功才写 assistant declaration）
2. provider-neutral Core prepared execution seam（`prepareBatch` / `executePrepared`，Core 不依赖 Host）
3. concrete function + receiver binding（注册时捕获，dispatch 时绝不重新读取 `tool.execute`）
4. owned immutable approval/execution authority input（deep-freeze authority snapshot）
5. isolated mutable Tool execution copy（Tool 改写自己的 input 不影响 authority/canonical）
6. ToolRegistry monotonic generation（仅真实 mapping 变化递增）
7. stable registration identity（delete+re-register 产生新 identity）
8. Host-managed executionId（prepare 时生成，不使用 provider callId）
9. trusted ToolPolicy（由 Trusted Composition 提供）
10. allow / deny / require-approval 三个决策，无第四种
11. unknown/unclassified tool default deny（Tool/plugin metadata 不能自我授予 allow）
12. Host-owned in-memory ApprovalRecord（进入 SQLite/Settings/Plugin KV/canonical/resume state 的通道不存在）
13. approval state / execution state separation
14. 120-second Host-authoritative business deadline（reconnect 不刷新）
15. final dispatch guard
16. synchronous dispatching → invocation critical section（中间无 await/lookup/policy/copy/publication/callback）
17. same-host executionId at-most-once dispatch（正常授权时 exactly once）
18. not-executed observations（固定安全文案，可按既有 Loop 继续）
19. executed/attempted failure disposition（sync throw / rejection / ok:false / abort 后 settle 均属 executed）
20. `tool.approval` reverse profile（唯一新增 production reverse method）
21. `approval.updated`（business authority 事件，先于对应 delivery）
22. multiple deliveries / first valid business decision wins
23. disconnect-safe approval persistence within current Host（只关闭 delivery）
24. same-host reconnect redelivery（同一 business record，新 stream/request，不 re-prepare/re-policy/不刷新 deadline/不重放旧答案）
25. old stream/epoch/reply invalidation（迟到答复零业务效果）
26. restart invalidates execution capability（新 hostInstance 无旧 approval/prepared/callable/resolver）
27. typed Client approval handler（`registerToolApprovalHandler`，唯一 approval 公共 seam）
28. Client business/reply state separation（`presentation.approval` vs `approvalReply`，`approvalCanRespond` 为推导值）
29. approval exact input boundedness（prospective frame 检查在 prepare 阶段）
30. execution lease retained while approval pending（second Run / settings / plugin / registry mutation 均 HOST_BUSY）
31. real Chrome HITL carrier acceptance（最小 harness 页面 + 3 个 strict required cases）

### Prepared Execution Law

Model tool declaration **≠** execution authority。Managed execution 的顺序是一条不可换序的链条：

```text
whole group validate → whole group prepare → only then assistant declaration →
policy → optional approval → final guard → bound invocation
```

Prepared execution 绑定：executionId、position（turn/step/callIndex）、concrete executor、receiver、
immutable authority input、registry generation、registration identity、Host-private policy/Run ownership。
批准后不得按 name lookup、不得重新读取 `tool.execute`、不得替换 arguments。

### Policy Law

ToolPolicy 由 Trusted Composition 提供，Host 拥有 enforcement。只允许 `allow` / `deny` /
`require-approval`；未知或未分类一律 `deny`。Policy 为 Host lifetime fixed：不能通过 Settings、
plugin config、model output 或 client 改变（不 hot reload）。Policy throw、返回非法值、Promise、
object 或 undefined 一律 fail closed、zero dispatch。

### Dispatch Safety

final guard 至少覆盖：hostInstance、current Run、execution lease、cancel/signal、business deadline、
prepared identity、registry generation、registration identity、policy identity/revision、
authorization、dispatch state。guard 通过后 **synchronously mark dispatching → immediately invoke the
already-bound function**，中间没有 await、动态 lookup、callback、publication、policy 或 client 交互。

同一 Host 同一 executionId：**at most one dispatch**；正常授权且 guard 成立时 **exactly one
dispatch**。不保证外部系统的 exactly-once 副作用，也不得以 `ok:false` 或 content 推断未发生副作用。

### Cancel / Timeout Semantics

cancel、timeout 与 approve 在 Host authority 上竞争并串行化：

- pre-dispatch 的 cancel/expire → zero dispatch；
- dispatch 已发生 → cancel 只能请求 abort，**不得**声称 rollback / not executed / 无外部副作用；
- tool throws 或 `ok:false` → 仍属 executed/attempted；
- executor 未 settle 前不得释放 execution lease。

### Approval Delivery

唯一 production reverse profile 是 `tool.approval`。Business ApprovalRecord 与 reverse delivery 严格
分离：

- disconnect：只关闭该 delivery；business approval 保持 pending，Run 不被取消；
- same-host reconnect：same approvalId / same executionId / same exact input / same business deadline，
  新的 stream/request delivery；不重新 prepare、不 re-policy、不刷新 deadline、不重放旧答案；
- multiple connections：first valid business decision wins；其余 reply 零业务效果、零二次 dispatch；
- 没有 approval-capable client：绝不 allow，保持 pending 至 deadline 后 expire（not-executed）。

### Business Deadline

Owner amendment 已落实：business approval 为固定 **120 秒**，Host monotonic clock 是 authority；
**delivery timeout 没有使用 30 秒人为缩短**——每次有效 delivery 覆盖当前剩余的 business approval
window（复用 reverse long-timeout segmentation）。验收记录：initial delivery `timeoutMs = 120000`；
business 走 30 秒后重连的新 delivery `timeoutMs = 90000`，且 `deadlineAt` 保持同一绝对值（重连不刷新
deadline）。

### Execution Lease

approval pending 期间保持既有 Run execution lease，因此 second Run、settings mutation、plugin
lifecycle mutation 与 registry mutation 都不能越过执行 ownership（均 HOST_BUSY）；reads、cancel 与
reverse reply 仍可处理。已 dispatch 且 executor 未 settle 时不得提前释放 lease。

### Restart Boundary

Pending approval 期间的真实 SIGKILL：old Run 按 M1 reconciliation 成为 `interrupted`（`unknown`），
session blocked。new Host 有新的 hostInstance，没有旧 ApprovalRecord、PreparedExecution、callable、
resolver 或 reverse pending；旧 reply 零效果；DB 中的 Run/input/history 只用于查询与 reconciliation，
**不得**用于重建 execution capability。不存在 `runs.resume`、`approvals.resume`、durable approval 或
per-tool execution checkpoint。

### Protocol / Client

Protocol 仍为 generation **`"2"`**，落实 Frozen v2 已声明的：`ApprovalSnapshot`、
`ToolApprovalResponse`、`tool.approval`、`approval.updated`、`HostSnapshot.approval`、
`run.tool.call`/`run.tool.result` 的 execution/invocation 关联与安全 execution disposition。
没有 forward approval API、`tools.execute`、resume API 或新 error code。

Client 的唯一 approval 公共 seam 是 typed `registerToolApprovalHandler`（或最终实际 public 等价
API）；不公开 generic reverse method registration、arbitrary JSON response API 或任何执行入口。
Client state 明确区分 **Host business approval**（来自 `approval.updated` 与 snapshot）与
**local delivery/reply state**（none/pending/sent/closed/failed）；`sent` 只表示已发出、等待 Host 确认。

### Related Local Fixes

M4 顺路闭合的三个直接相关安全问题（局部 prerequisite，未重开 M1/M2、未改 Frozen limits、无无关
重构）：

1. `ToolRegistry` disposer 捕获 registration key/identity，不在 dispose 时读取 mutable `tool.name`；
2. JSON ownership 精确保留合法 own `"__proto__"` 与 nested null-prototype 键（不调用 getter/toJSON/coercion）；
3. Host outbox 统一按真实 UTF-8 byte count 计量，不使用 JS `string.length` 作为 byte authority。

### Durable Execution Disposition

M4 的新 tool result facts 可以明确 `executed` / `not-executed`；旧 M1–M3 history 没有该字段时保持
legacy/unknown。禁止根据 `ok:false` 或 content 反向推断未产生外部副作用。

durable `tool/call`、`tool/result` record 当前**不额外保存 executionId**：executionId 继续用于
live/wire/approval identity，durable occurrence identity 保持现有 invocation identity（按 prompt §8
不得以 executionId 替代）。其原因进入 hardening backlog（见下）：直接加入 executionId 会改变 M1 冻结的
64 KiB at-bound record 行为。

### Acceptance Evidence

**A01–A36：36/36 PASS**。关键断言：allow = 1；deny = 0；pending pre-approve = 0；approve = 1；
duplicate approve = still 1；reject = 0；timeout = 0；cancel-before-dispatch = 0；restart 后旧
execution = 0；multiple deliveries dispatch ≤ 1；pending 期间 lease 保持；approval exact input 保真；
whole-group preparation failure = group 0。

覆盖位置：`packages/host/tests/tool-policy.test.ts`、`packages/host/tests/run.test.ts`、
`packages/host/tests/projection.test.ts`、`packages/host/tests/outbox-bytes.test.ts`、
`packages/client/tests/approval.test.ts`、`packages/agent-core/tests/tool-execution.test.ts`、
`tests/integration/tool-approval.test.ts`、`tests/integration/approval-crash.test.ts`、
`apps/web/tests/shell-approval.browser.test.ts`。

### Negative Controls

| NC | mutant | 结果 |
| --- | --- | --- |
| NC1 | require-approval 绕过 approval 直接派发 | **KILLED** |
| NC2 | dispatch 时重读 `Tool.execute` | **KILLED** |
| NC3 | duplicate/loser reply 二次决定 | **KILLED** |
| NC4 | disconnect 自动 cancel business approval | **KILLED** |
| NC5 | reconnect 重置 business/delivery deadline | **KILLED** |
| NC6 | final guard 忽略 registryGeneration | **KILLED** |
| NC7 | pending approval 释放 execution lease | **KILLED** |
| NC8 | restart 恢复旧 execution authority（跳过 reconciliation） | **KILLED** |

**8/8 KILLED**：每条均以 business assertion 失败，mutant 真实加载、逐文件 byte-identical restore、
恢复后目标测试重新变绿，无 residue。**NC2 特别控制**：registry generation 不变、仅替换原
Tool 的 `.execute` property，证明 killed 的是 concrete function binding，而不是被 generation
mismatch guard 代杀。

### M4 Evidence

| 项目 | 结果 |
| --- | --- |
| full offline | **1525 passed / 0 failed / 0 skipped / 1525 total**（排除 `real-provider` 与 `.zcode/**`；本机有 Chrome，浏览器用例实际执行） |
| real Chrome strict（`pnpm test:web:browser`） | **20 passed / 0 failed / 0 skipped**（原 Phase1–M3 required cases 17 + 新增 M4 required cases 3） |
| M4 browser cases | approve → exactly one dispatch；reject → zero dispatch；reconnect → same approval continues 且 exactly one dispatch |
| agent-core | **188 passed** |
| host | **422 passed** |
| client | **220 passed** |
| protocol | **183 passed** |
| plugin-system | **81 passed** |
| plugin-calculator | **7 passed** |
| model-pi-ai（adapter） | **60 passed** |
| integration | **161 passed** |
| A01–A36 | **36/36 PASS** |
| NC1–NC8 | **8/8 KILLED** |
| typecheck（root + browser project） | **PASS** |
| `pnpm build:web` | **PASS** |
| `git diff --check` | clean |
| real-provider | **NOT RUN**（未运行，不记为 PASS） |

全部 gate 在最终 implementation baseline `d30caea` 上通过；seal 轮为 docs-only，未重跑上述 suite。

### Review / Acceptance History

如实记录：ChatGPT → M4 architecture research → D1–D24 frozen；Sol 6.1 → one formal Implementation
Plan；ChatGPT → owner plan check → four implementation amendments；DSFlash → one-shot
implementation（实现期内自行发现并修复缺陷，均在 acceptance 之前）→ A01–A36 → NC1–NC8 → full
gates；ChatGPT → owner acceptance PASS。**Owner repair：NOT USED**（0 / 1）。

**没有发生“independent DSFlash review PASS”或“Sol implementation review PASS”**，本节不作此表述。

`.zcode/` 内的 probe / mutation / scratch 是过程证据，**不是** contract authority，也不构成本文档的
组成部分；它们保持有意 untracked、不 stage、不 commit。

### M4 Hardening Backlog

非阻塞项，记录但不属于 M4 blocker：

1. durable `tool/call`、`tool/result` 未来是否加入 executionId——需要先裁决与 M1 冻结的 64 KiB
   at-bound record 行为的兼容策略。
2. `PROJECTION_RENDEZVOUS_MS` / `APPROVAL_*` internal profile 的 future tuning，任何改动需重新给出
   boundary evidence。
3. M5 的正式 approval UI 与说明。
4. M1/M2/M3 原有 backlog 保持原状态。

以下**不是** backlog，它们是 M4 contract 本身：dynamic executor lookup、double dispatch、approval
races、business deadline correctness、execution lease、restart capability、exact approval input。

### M5 Boundary

下一个 milestone 为 **M5 — UX + Phase 4 Acceptance / Seal**，状态 **NOT STARTED**。M5 的 Frozen scope：
history/page coverage UX、session rename/delete UX、settings/restart UX、approval/interrupted
explanation UX、Phase 4 full cross-layer acceptance、real browser gate、final independent review /
seal。本轮不设计、不实施 M5，不重做 Shell architecture，不添加 archive/tag/folder，也不新增
workflow/multiagent。
