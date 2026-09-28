# Phase 2 Plugin System — Handoff

> 用途：跨窗口恢复 Phase 2 当前事实；目标设计与验收契约见 [PHASE2_PLUGIN_SPEC.md](./PHASE2_PLUGIN_SPEC.md)。
> 本文不是第二份 SPEC、聊天记录或 changelog。只保留当前状态、冻结决定、验证证据与下一步。

## 1. Current Status

| 项目 | 当前事实 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Code baseline | `c717f1087e75a7055a18c51512b27b1a1cb28c58` — `test(plugin-system): cover lifecycle regression boundaries` |
| Phase 2 起点 / Phase 1 final docs commit | `641ca74c9b69f6dffa2671d7b38009407792d8aa` — `docs: mark Phase 1 complete in handoff` |
| Phase 1 | **COMPLETE**；代码、自动化测试与人工真实 provider E2E 的封存证据见 Phase 1 HANDOFF |
| Phase 2 | **代码已交付、独立复审 PASS、已 push；待 HANDOFF 轻量审查与文档封存**。本次不标记 Phase 2 COMPLETE |
| 当前仓库实现 | 四包均已落地：`agent-core`、`model-pi-ai`、`plugin-system`、`plugin-calculator` |
| 独立审查 | Astra Targeted Re-review **PASS — BLOCKER 0 / MAJOR 0 / MINOR 0**；唯一 MAJOR M1 已 RESOLVED |
| Code push | P2.1–P2.4 checkpoints 及两次测试补充共六个 commits 已推送至 `origin/rewrite/runtime-lite`；服务端分支已核验与 Code baseline 一致 |
| 已提交的 HANDOFF 基线 | `f3ee623abe58ab204c08d39777381201c2fde1f0` — `docs: update Phase 2 handoff for P2.0`；该文档提交已 push，本次更新尚未暂存或提交 |
| 下一步 | 仅审查本文当前事实与证据；文档 commit/push、封存状态变更须另获授权，不进入 Phase 3 |
| 原有未跟踪项 | `.zcode/`、`.zcodeignore`，不属于提交范围，不得顺手提交 |

Phase 1 文档冻结：`docs/PHASE1_AGENT_CORE_SPEC .md`（SPEC 后有空格）、`docs/PHASE1_HANDOFF.md`。
不得继续向它们写入 Phase 2 内容；旧文档描述的是封存时的包位置，不要求随 Phase 2 迁移更新。
Phase 2 SPEC 是冻结目标文档；其头部保留设计时的阶段背景，当前实现进度以本文为准。

### Verification Baseline

以下为 Code baseline 对应的**最近一次代码 push 前实测结果**，不是本次文档更新重新运行的结果。本次只核对 Git、代码归属和静态计数，未重跑 typecheck/tests。

| 命令 | 已记录结果 |
| --- | --- |
| `pnpm typecheck` | PASS / 0 errors |
| `pnpm exec tsc --noEmit -p packages/agent-core/tsconfig.json` | PASS |
| `pnpm exec tsc --noEmit -p packages/model-pi-ai/tsconfig.json` | PASS |
| `pnpm exec tsc --noEmit -p packages/plugin-system/tsconfig.json` | PASS |
| `pnpm exec tsc --noEmit -p packages/plugin-calculator/tsconfig.json` | PASS |
| `pnpm exec vitest run --exclude '**/real-provider.e2e.test.ts'` | **21 files / 217 tests passed** |
| `pnpm exec vitest run packages/plugin-system/tests` | **4 files / 81 tests passed** |
| `pnpm exec vitest run packages/plugin-calculator/tests` | **2 files / 7 tests passed** |
| `pnpm exec vitest run tests/integration/calculator-roundtrip.test.ts tests/integration/calculator-plugin.e2e.test.ts` | **2 files / 5 tests passed** |
| `git diff --check`、`git diff --check f3ee623` | PASS |

217 条离线测试分布：Core 99、model-pi-ai 25、plugin-system 81、plugin-calculator 7、根 faux integration 2、根 plugin E2E 3。
P2.0 的 130 条离线测试保留；CalculatorTool 四项单测迁包使 Core 从 103 变为 99，不是删除测试。新增离线测试共 87 条；两条 real-provider 测试另行记账。

最近边界核查确认：Core 无 provider/plugin dependency；跨包无私有 src import；SDK 仍为 0.87.1；无 lifecycle queue、force reset、Cordis、额外 permission 或 production storage backend。lockfile 第三方解析结果未变，仅新增批准的 workspace links。
没有新增 build/lint 配置，未声称执行 build/lint。生产物理 LOC（`src/**/*.ts`，含注释空行）：Core **1224**、model-pi-ai **329**、plugin-system **690**、plugin-calculator **72**。

### Independent Review / M1

审查结论来自人工反馈的 Astra Independent Final Review 及 Targeted Re-review，不是本次文档维护重新开展的独立审查。
唯一 MAJOR M1 是 **test coverage gap**，不是已证实的 production bug；Astra 的额外生产边界探针通过。
`c717f10` 仅新增四项生命周期回归测试，未改生产代码：多 cleanup failure 的完整顺序记录、原始 enable failure 与 cleanup errors 分离、同步 activate 的 immediate seal、unregister 从 disabling 直接到 missing 的无重入窗口。`plugin-lifecycle.test.ts` 现有 27 tests；最终 targeted re-review 为 **PASS / 0 blocker / 0 major / 0 minor，M1 RESOLVED**。

### 三层 E2E 证据

- **A — FakeModel + real PluginManager/Core/Tool：PASS。** `tests/integration/calculator-plugin.e2e.test.ts` 的三个确定性场景覆盖 register 后无工具、enable 后可见、真实 Session tool/call 输入 `{a:21,b:2}` 与配对 tool/result `ok: true / content: "42"`、disable 后新 ContextBuilder request 无 schema、execute 返回 unknown-tool 失败 observation、re-enable 得到新 Tool 且再次调用得到 `"30"`。不是仅凭最终文本包含 42 验收。
- **B — pi-ai faux / stubbed transport：PASS。** `packages/model-pi-ai/tests/` 的 25 条测试与根 `calculator-roundtrip.test.ts` 的两条组合测试保留并通过；不构成真实 LLM 证据。
- **C — Phase 2 real-provider = NOT RUN。** 本期未调用真实 provider。Batch 中曾在显式移除测试子进程凭据的环境下确认两条 credential-gated tests 为 **skipped**；最近代码 push 前的离线验证直接排除该文件。skip 不计 PASS，也不计入 217 条离线测试。

Phase 1 的真实 smoke/calculator DoD 人工 PASS 仅是历史封存证据，不改写为 Phase 2 PASS。
真实 provider 测试保留在 `tests/integration/real-provider.e2e.test.ts`；其 calculator 场景直接注册 CalculatorTool，不应描述为已验证的真实 provider 插件生命周期闭环。
默认验证继续显式排除 real-provider 文件；其现有 gate 只检查 `DEEPSEEK_API_KEY` 是否为 undefined，空字符串也不会 skip。不得自动使用环境中已有凭据；真实调用须另获授权，不读取或打印 key、不修改 `.env`。

## 2. Frozen Inputs from Phase 1

- AgentRuntime / AgentLoop / ModelClient contract 保持 provider-neutral；Phase 2 未改变 retry、cancel、Session、Tool 输入校验与 RuntimeContext 语义。
- ToolRegistry.register 返回同步幂等 disposer；duplicate name 拒绝，不覆盖 existing owner。
- ToolRegistry.execute 将 unknown tool 与业务异常规范化为失败 observation；输入校验仍由工具负责。
- ContextBuilder 每个 model step 读取当前 registry；Loop 按名称查询工具，没有 turn-level registry snapshot。
- RuntimeContext/signal 原样共享；Session、retry、cancel 与 turn 边界继续沿用 Phase 1 契约。
- PluginManager 不进入 Runtime / Loop；running-turn hot switching 不受现有 Core 支持，宿主 idle 前置条件仍必须满足。

其他 Phase 1 细节按需查原 HANDOFF，不复制其全部 frozen decisions。

## 3. Phase 2 Frozen Decisions / Current Truth

四包依赖方向已经落地，所有跨 workspace 依赖显式为 `workspace:*`：

```text
model-pi-ai ────────> agent-core
     └─────────────> @earendil-works/pi-ai@0.87.1
plugin-system ─────> agent-core
plugin-calculator ─> plugin-system
         └────────> agent-core
```

1. `agent-core` 是 provider-neutral physical package：无 provider/plugin runtime/dev dependency，不反向依赖 adapter 或插件；无 pi-ai 类型引用，不保留 adapter 或 calculator compatibility re-export。
2. `model-pi-ai` 公开 `createPiAiModelClient`、`PiAiModelClientOptions`、`PiAiStreamSource`；不依赖 plugin packages。根 `tests/integration/` 是 composition root，所需 workspace/SDK devDependencies 已显式声明。
3. CalculatorTool 实现与四项单测已在 P2.4 迁入 `plugin-calculator`；其公共出口仅 `createCalculatorTool`、`createCalculatorPlugin`。plugin id/tool name 均为 `calculator`，无权限声明，每次 activation 创建新 Tool。
4. 独立 `plugin-system` 已实现 SPEC §4 的契约、`createPluginManager` 与 `PluginBusyError`；内部 helpers 不从 package root 导出。无 Cordis、通用 service/effect framework。
5. 生命周期只有 activate(context) + context.onDispose；无 deactivate、无返回 disposer 协议。PluginContext 仅有 scoped registrar、pluginId、获准 capability 与 onDispose，不暴露裸 ToolRegistry。
6. 工具 staging → preflight → synchronous commit；Manager 持有真实 registry disposers。失败逆序撤销本批 registrations，再 LIFO、serial await 清理插件资源；全部清理均尝试，每项每次 activation 最多一次。
7. 生命周期 **busy → reject**：enabling/disabling 时 enable/disable/unregister 均拒绝 PluginBusyError；不排队、不合并请求、不自动等待或重试。enabled enable、disabled disable 为 no-op。
8. PluginPermission **仅 storage**，默认 deny；declared + granted + provided 才注入。未声明不调用 factory；未授权、无实现或 factory 失败都在 activate 前拒绝。
9. Storage 只做 contract、scoped injection 与 memory test fixture；host 负责 plugin ID 数据隔离。cleanup 期间 handle 有效，全部尝试后失效，失败同样失效；重新 enable 不复活旧 handle，disable/unregister 不删除 host 数据。无 production persistence backend。
10. activation 结束后 seal tools.register/onDispose；同步 activate 返回不额外 await。清理干净的 enable failure 回 disabled + lastFailure；清理失败进 error，禁止 enable/disable/unregister 重试清理或掩盖错误，无 force reset。unregister(enabled) 清理成功后直接删除记录，不暴露 disabled 重入窗口。
11. Host 必须保证共享 registry 的全部 turn 与直接工具执行 idle，并 await lifecycle 完成再恢复执行；Manager 不检测 idle、不提供 drain/generation routing。
12. Permissions 仅管理 host-provided capabilities，**不 sandbox untrusted in-process JS**。rollback 仅保证 registration lifecycle 的补偿清理，不回滚 storage 写入或外部副作用；tool disposer 自身失败时不能保证对应注册已消失。
13. Manifest/permissions 在 register 时复制冻结；grants 在 Manager 创建时复制校验；get/list 返回冻结快照。lastFailure 区分原始失败与 cleanupErrors，非 Error throw 安全归一；不自动日志上报，也不宣称错误文本已自动脱敏。精确接口与边界仍以 SPEC §4–§8 为准。

Core 的部分中立测试仍使用名为 `calculator` 的 stub 或消息数据；这不是生产 CalculatorTool 残留，不应为消除字符串命中修改既有测试。

## 4. Milestones

P2.1–P2.4 的实现与 Gate 已完成；代码按人工批准的 Batch Mode 统一接受最终独立审查，不能把各 Gate 表述为逐 milestone Independent Review。

| Milestone | 当前状态 | 交付 / checkpoint |
| --- | --- | --- |
| P2.0 — Package Boundary | **COMPLETE** | `cfd9c80`；adapter 迁出 Core，SDK 0.87.1。CalculatorTool 当时暂留 Core，现已在 P2.4 迁出 |
| P2.1 — Plugin Contract | 实现 / Gate 完成，已 push | `11c9f6d` — `feat: add plugin system contracts` |
| P2.2 — PluginManager | 实现 / strict Gate 完成，已 push | `9b3f160` — `feat: add plugin lifecycle manager` |
| P2.3 — Storage Permission + Lifecycle Hardening | 实现 / Gate 完成，已 push | `4f09721` — `feat: add scoped plugin storage capability` |
| P2.4 — CalculatorPlugin + E2E | 实现 / Gate 完成，已 push | `0024236` — `feat: add calculator plugin integration` |
| P2.5 — Final Audit | Self Audit、独立复审与最终代码验证完成；文档封存待完成 | `8023a66` 补 unregister cleanup-pending 测试；`c717f10` 补 M1 四项回归，均已 push |

各 milestone 的 Goal / Deliverables / Acceptance Criteria / Non-goals 见 SPEC §9；本文不重新定义 DoD。
当前代码无未关闭 review blocker/major/minor；这不等于本文已经通过轻量审查或 Phase 2 已获封存确认。

## 5. Next Window

**下一步仅为 HANDOFF 轻量审查，不再 Plan/Implement P2.1，也不进入 Phase 3。**

1. Read Phase 2 SPEC 与本文，核对实际 Git 的 Code baseline、分支与工作区；只接受已知的文档修改和 `.zcode*` 未跟踪项。
2. 对照最终验证与人工提供的 targeted re-review，确认 217 offline、81 plugin-system、7 plugin-calculator、5 root integration，以及 M1 RESOLVED。
3. 确认 real-provider 保持 NOT RUN；历史 skip / Phase 1 PASS 不得改记为 Phase 2 PASS。
4. 轻量审查通过后，等待单独的本文 commit/push 与封存授权；不得把更新文档或代码已 push 理解为 Phase 3 开工授权。

本次维护仅更新本文，整合既有未提交的 P2.0 状态说明；未修改 production/tests/config/SPEC，未暂存、未 commit/push，也未操作 `.zcode/`、`.zcodeignore`。

## 6. Maintenance Rule

职责：**Architecture / Plan / Review：GPT-6 Astra；Implementation / Fix：DSFlash。**

本次 P2.1–P2.5 的 Batch 执行例外由人工明确批准：共用 Master Plan，逐 milestone Implement → Verify → Gate PASS → local checkpoint → 下一阶段；Independent Review 延后至 P2.5 Self Audit 后统一开展。
Gate 不等于 Independent Review；本次 M1 test-only fix 后经 Astra targeted re-review PASS，再完成 Final Verification，并在另获 push 授权后推送已有 commit chain。上述授权只属于本次 Phase 2，不改写 SPEC 的技术契约，也不自动延伸到后续阶段。

剩余文档交付顺序：

```text
update Handoff（本次）
→ lightweight review
→ docs commit/push（须另获明确授权）
→ 封存状态确认（须人工确认；不自动进入 Phase 3）
```

DSFlash 不自行修改 frozen architecture。遇到以下任一情况必须 STOP：

- SPEC ambiguity、public API conflict 或 frozen decision must change；
- new production dependency required、milestone scope expansion 或跨阶段架构冲突；
- Core / permission / lifecycle contract 必须改变；
- 需要删除、skip 或弱化既有测试才能通过；
- 验证不满足 Gate，或出现无法归属的工作区 / 暂存区变更。

输出具体 blocker、证据与受影响契约，返回 Astra / 人工裁决；不得自行选择一个“合理方案”继续。
每轮仅执行当轮明确授权的范围；更新 HANDOFF 不自动授权 implementation、staging、commit 或 push，流程描述不构成未来 Git 操作授权。

更新本文时只维护当前真相：

- 写 **Code baseline** 与已知 milestone commit，不以未来文档提交自引用代码基线。
- 更新状态、已完成能力、实际测试/类型检查结果、三层 E2E 与必要 LOC；区分历史实测、本轮实测和静态清点。
- 未实现、未运行、未审查或未授权封存的内容不得记为完成；移除已解决的当前问题，不累积聊天/逐提交历史。
- 新架构裁决先经批准写入 SPEC，再同步本文摘要；不修改冻结的 Phase 1 文档。
- 更新 Next Window；每阶段仅操作批准范围，禁止 `git add -A` / `git add .`，提交前展示路径级摘要并显式逐文件 stage，排除 `.zcode*`。
