# Phase 2 Plugin System — Handoff

> 用途：跨窗口恢复 Phase 2 当前事实；目标设计与验收契约见 [PHASE2_PLUGIN_SPEC.md](./PHASE2_PLUGIN_SPEC.md)。
> 本文不是第二份 SPEC、聊天记录或 changelog。只保留当前状态、冻结决定、验证证据与下一步。

## 1. Current Status

| 项目 | 当前事实 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Code baseline | `cfd9c803ebf79a851c3d9e5653b1edae2eef3bba` — `feat: split pi-ai model adapter from core` |
| Phase 2 起点 / Phase 1 final docs commit | `641ca74c9b69f6dffa2671d7b38009407792d8aa` — `docs: mark Phase 1 complete in handoff` |
| Phase 1 | **COMPLETE**；代码、自动化测试与人工真实 provider E2E 的封存证据见 Phase 1 HANDOFF |
| Phase 2 | **P2.0 COMPLETE ✅**；目标设计已冻结，P2.1 Plugin Contract next |
| 下一 milestone | **P2.1 — Plugin Contract ← NEXT**，尚未 Plan/Implement |
| 当前仓库实现 | 已有 `packages/agent-core`、`packages/model-pi-ai`；尚无 plugin-system、plugin-calculator 包 |
| P2.0 交付 | Plan、Implementation、Verification、Independent Review、code commit、push 均已完成；`origin/rewrite/runtime-lite` 已同步至 Code baseline |
| 本轮变更 | 仅更新本文记录 P2.0 完成事实；未暂存、未 commit/push，production/tests/config 未修改 |
| 原有未跟踪项 | `.zcode/`、`.zcodeignore`，不属于提交范围，不得顺手提交 |

Phase 1 文档冻结：`docs/PHASE1_AGENT_CORE_SPEC .md`（SPEC 后有空格）、`docs/PHASE1_HANDOFF.md`。
不得继续向它们写入 Phase 2 内容；旧文档描述的是封存时的包位置，不要求随 Phase 2 迁移更新。

### Verification Baseline

P2.0 code commit 前的最终验证结果，对应上表 Code baseline；本次仅更新文档，未重跑代码测试：

```text
pnpm typecheck
  → PASS / 0 errors
pnpm exec vitest run --exclude '**/real-provider.e2e.test.ts'
  → 15 files / 130 tests passed
pnpm exec vitest run packages/agent-core/tests
  → 12 files / 103 tests passed
pnpm exec vitest run packages/model-pi-ai/tests
  → 2 files / 25 tests passed
```

根级 faux integration 的 2 tests 已包含在离线 130 条中，不另计；既有离线测试与断言保留，文件数增加来自 calculator 单测与组合测试拆分。
Core 的 manifest、src、tests、public API 与独立编译闭包均确认无 pi-ai；公共包入口解析及依赖归属验证通过，SDK 仍精确为 0.87.1。

真实 provider：本 milestone 未真实调用。`tests/integration/real-provider.e2e.test.ts` 的两条 credential-gated 测试已在无 key 环境下确认 **skipped**，不计入离线 130 条，也不记为 real-provider PASS。上述全量离线命令显式排除了该文件。
Phase 1 的真实 smoke 与 calculator DoD 人工通过记录仍是历史封存证据，不当作 P2.0 的真实 provider 验证。

Independent Review：**PASS — BLOCKER 0 / MAJOR 0 / MINOR 0**。

## 2. Frozen Inputs from Phase 1

- AgentRuntime / AgentLoop / ModelClient contract 保持 provider-neutral；P2.0 仅迁移 adapter 的包归属，未改变这些契约。
- ToolRegistry.register 返回同步幂等 disposer；duplicate name 拒绝，不覆盖 existing owner。
- ToolRegistry.execute 将 unknown tool 与业务异常规范化为失败 observation；不在拆包时改变输入校验责任。
- ContextBuilder 每个 model step 读取当前 registry；Loop 按名称查询工具，没有 turn-level registry snapshot。
- RuntimeContext/signal 原样共享；Session、retry、cancel 与 turn 边界继续沿用 Phase 1 契约。
- PluginManager 不进入 Runtime / Loop；running-turn hot switching 不受现有 Core 支持。Phase 2 将宿主 idle 前置条件正式冻结，见下一节。

其他 Phase 1 细节按需查原 HANDOFF，不复制其全部 frozen decisions。

## 3. Phase 2 Frozen Decisions / Current Truth

P2.0 package boundary 已实际完成，不再是迁移计划；后续插件契约与生命周期设计仍是冻结目标，尚未实现。

1. `@every-dagent/agent-core` 已是 provider-neutral physical package：无 pi-ai runtime/dev dependency，src/tests/public API 无 pi-ai 引用；不再导出 PiAiModelClient adapter API，不反向依赖 model-pi-ai、不保留兼容重导出。ModelClient contract 保持不变。
2. 已新增 `@every-dagent/model-pi-ai`，依赖 `@every-dagent/agent-core = workspace:*`、`@earendil-works/pi-ai = 0.87.1`；公开 `createPiAiModelClient`、`PiAiModelClientOptions`、`PiAiStreamSource`。Adapter unit/integration/fake helper 已随迁；根级 `tests/integration/` 承载 real-provider 与 calculator composition tests，所需 workspace/SDK devDependencies 已显式声明。
3. CalculatorTool 的实现、单测与 `createCalculatorTool` 出口当前仍留 Core；P2.4 再移到 plugin-calculator，与 CalculatorPlugin 一起交付，移除 Core calculator 出口。
4. P2.1 才开始独立 plugin-system 包的 contract；PluginManager 实现留 P2.2。不引入 Cordis，也不预建通用 service/effect framework。
5. 生命周期只有 activate(context) + context.onDispose；上下文仅有 scoped registrar、pluginId、获准 capability，不暴露裸 ToolRegistry。
6. 工具 staging → preflight → synchronous commit；失败逆序撤销本批 registrations，再 LIFO、serial await 清理插件资源；全部清理均尝试，每项每次 activation 最多一次。
7. 生命周期 **busy → reject**：enabling/disabling 时 enable/disable/unregister 均拒绝 PluginBusyError；不排队、不自动等待或重试。此决定覆盖 Explore 的 per-plugin FIFO 建议。
8. PluginPermission **仅 storage**，默认 deny；declared + granted + provided 才注入。此决定覆盖 Explore 的 network/credentials 预留名建议。
9. Storage 只做 contract、scoped injection 与 memory test fixture；cleanup 期间 handle 有效，全部尝试后失效，重新 enable 不复活旧 handle。无持久化后端。
10. 清理干净的 activation failure 回 disabled + lastFailure；清理失败进 error，禁止 enable/disable/unregister 掩盖错误，无 force reset。
11. Host 必须保证共享 registry 的全部 turn 与直接工具执行 idle，并 await lifecycle 完成再恢复执行；Manager 不检测 idle、不提供 drain/generation routing。
12. Permissions 仅管理 host-provided capabilities，**不 sandbox untrusted in-process JS**；外部副作用不属于 registration rollback 事务。
13. 新 scope、seal、manifest/ID、公开接口、错误记录的精确语义以 SPEC §4–§8 为准，不在本文复制接口。

## 4. Milestones

| Milestone | 状态 | 交付边界 |
| --- | --- | --- |
| P2.0 — Package Boundary | **✅ COMPLETE** | 包边界与测试迁移已完成，SDK 0.87.1，CalculatorTool 暂留 Core |
| P2.1 — Plugin Contract | **← NEXT** | 尚未 Plan/Implement；最小契约与 public API review |
| P2.2 — PluginManager | not started | 状态机、工具生命周期、rollback、cleanup、busy rejection |
| P2.3 — Storage Permission + Lifecycle Hardening | not started | storage policy/injection、scope 失效与故障矩阵 |
| P2.4 — CalculatorPlugin + E2E | not started | 工具迁出 Core、插件启停与 Agent 调用闭环 |
| P2.5 — Final Audit | not started | 依赖/API/生命周期/权限/验证证据审计与封存 |

各 milestone 的 Goal / Deliverables / Tests / Acceptance Criteria / Non-goals 见 SPEC §9。
FakeModel deterministic plugin E2E、pi-ai faux provider integration、real-provider credential-gated E2E 必须分别记账；skip 不算 pass。

## 5. Next Window

Next milestone：**P2.1 — Plugin Contract**。

下一开发窗口流程：

1. Read `docs/PHASE2_PLUGIN_SPEC.md`。
2. Read `docs/PHASE2_HANDOFF.md`。
3. 核对 Git 基线，然后 Explore only P2.1，不重新设计冻结架构。
4. 由 GPT-6 Astra 输出 Detailed P2.1 Plan。
5. 人工批准。
6. 同一开发窗口切换 DSFlash Implement，仅实施已批准的 P2.1 Plan。
7. 转独立 Astra Review 窗口完成审查。
8. 回开发窗口由 DSFlash Fix，按审查结果修复并验证。

P2.1 仅交付 plugin-system contract、公共出口与契约类型测试；不得提前实现 PluginManager 完整状态机、storage capability backend 或 CalculatorPlugin，也不迁移 CalculatorTool。
目前没有待人工裁决的架构 blocker；实现中出现冲突必须按下节停下，不以“合理默认值”改写冻结架构。

## 6. Maintenance Rule

职责：**Architecture / Plan / Review：GPT-6 Astra；Implementation / Fix：DSFlash。**

每个 milestone 延续：

```text
Implement
→ Astra Independent Review
→ DSFlash Fix
→ 验证通过
→ commit/push code（须另获明确授权）
→ update Handoff
→ lightweight review
→ docs commit/push（须另获明确授权）
→ close milestone
```

DSFlash 不自行修改 frozen architecture。遇到以下任一情况必须 STOP：

- SPEC ambiguity；
- public API conflict；
- new dependency required；
- frozen decision must change；
- major scope expansion。

输出具体 blocker、证据与受影响契约，返回 Astra / 人工裁决；不得自行选择一个“合理方案”继续。
本轮仅授权更新 `docs/PHASE2_HANDOFF.md`，不授权 implementation、staging、commit 或 push；流程描述不构成未来 Git 操作授权。

更新本文时只维护当前真相：

- 写 **Code baseline** 与已知 milestone commit，不以未来 HEAD 自引用文档提交。
- 更新状态、已完成能力、实际测试/类型检查结果、真实 E2E pass/skip 与必要 LOC。
- 目标能力未实现不得记为完成；移除已解决的当前问题，不累积聊天/逐提交历史。
- 新裁决先经批准写入 SPEC，再同步本文摘要；不修改冻结的 Phase 1 文档。
- 更新 Next Window；每阶段仅操作批准范围，禁止 `git add -A`，提交前展示路径级摘要。
