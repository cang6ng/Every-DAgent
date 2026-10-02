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
