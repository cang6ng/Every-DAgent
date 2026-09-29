# Phase 3 Platform — Handoff

> 用途：恢复 Phase 3 当前架构、基线与阶段入口；不是 changelog、审查记录或实施计划。
> 规范真源：[PHASE3_PLATFORM_SPEC.md](./PHASE3_PLATFORM_SPEC.md)。

## 1. Current Status / Baseline

| 项目 | 当前事实 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Code baseline | `17288dbaffdccfd10a34b66cfbdfd461e611a83c` — `fix(protocol): close validation review gaps`；P3.1 实现与两轮 targeted fix 已 push |
| Phase 3 SPEC baseline | `d5d1525a0c168651569ea99dd2fdb89f1fba6dc7` — `docs: freeze Phase 3 platform architecture`；SPEC 本轮不修改 |
| Phase 1 | **COMPLETE**；历史真实 provider 人工 PASS 与自动验证证据见 Phase 1 HANDOFF |
| Phase 2 | **COMPLETE**；四包已交付，独立复审与 HANDOFF 轻量审查 PASS，用户已确认封存；217 offline tests passed、Phase 2 real-provider NOT RUN |
| P3.0 Explore / SPEC | **COMPLETE**；已批准架构及正式 SPEC 已冻结 |
| P3.1 — Protocol Contract | **COMPLETE**；`@every-dagent/protocol` 已实现，最终独立审查 PASS，三个 implementation commits 已 push |
| Independent Review | **PASS — BLOCKER 0 / MAJOR 0 / MINOR 0**；人工确认 P3.1 READY FOR PUSH: YES |
| Phase 3 当前授权 | 仅 P3.1 封存、既有实现提交 push，以及本文事实更新与 commit/push；不授权 P3.2 Plan 编写或 implementation |
| P3.2 implementation | **NOT STARTED**；host/client/apps/web 尚未创建，Phase 3 整体尚未完成 |
| 文档交付范围 | 仅 `docs/PHASE3_HANDOFF.md`；不修改 `PHASE3_PLATFORM_SPEC.md` |
| Next | **P3.2 Master Plan**；下一轮单独授权 |

### P3.1 Implementation Baseline / Verification

以下三个提交共同构成 P3.1 已交付基线，原样保留，未 squash/amend；已推送至 `origin/rewrite/runtime-lite`，远端已核验为 Code baseline：

- `0b49652675754b253e3a6d43576151112212b57f` — `feat: add Every-DAgent protocol contract`
- `3fadceca2911756559d4527d0d4381d9caffb1bd` — `fix(protocol): harden validation boundaries`
- `17288dbaffdccfd10a34b66cfbdfd461e611a83c` — `fix(protocol): close validation review gaps`

Protocol Contract 已实现 DTO/types、12 operations、8 events、JSON-safe guard、runtime validation、decode/validate/encode、transport-neutral channel contract、reverse request 基础 envelope 与 test-only fixtures。唯一新增 production dependency 为精确锁版 `valibot@1.5.0`。未实现 Host/Client/Web、pending manager、timeout runtime、reconnect、Host projection 或业务 HITL。

下表是 Code baseline 对应的第二轮 targeted fix 实测结果，不是本次封存重新运行的结果；最终 Independent Review PASS 来自人工提供的审查结论。

| 检查 | 已记录结果 |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm exec tsc --noEmit -p packages/protocol/tsconfig.json` | PASS |
| Protocol tests | **7 files / 159 tests PASS** |
| Old offline regression | **21 files / 217 tests PASS**；既有测试完整保留 |
| Full offline（显式排除 real-provider） | **28 files / 376 tests PASS** |
| `pnpm install --frozen-lockfile` | PASS |
| `git diff --check` | PASS |
| Real provider | **NOT RUN** |

Phase 1/2 文档与既有 contract 保持不变；Phase 1 历史真实 provider PASS 不转记为 P3.1 验证。本次封存只核验 Git、交付归属及文档事实，未重跑测试或调用真实 provider。

## 2. Architecture Decisions

已批准 AD-1–AD-17 与 15 条 Platform Laws 的规范表述见 SPEC §2–§3。以下区分已实现的 Protocol Contract 与后续 Host/Client 的规范要求，不将后续能力记为已实现：

- Every-DAgent 是 Agent Application Platform，目标是 small kernel / stable boundaries / rich extension surfaces。
- 既有 `agent-core`、`model-pi-ai`、`plugin-system`、`plugin-calculator` 边界不变；Plugin Runtime 不另建包。
- 独立 `protocol` 已创建；`host`、React-free `client` 与 `apps/web` 尚未创建。
- Protocol 不依赖 Core/Plugin System/provider/React；使用 lightweight bidirectional Request/Response + Events。
- 代际 `"1"`、host.describe 与 capability shapes/validation 已实现为协议契约；实际 Host 协商处理尚未实现，没有 semver/range solver/自动降级。
- Control/Interaction Plane 是同包 namespace；后续内部对象必须经 Host 投影成 runtime-validated JSON DTO，P3.1 不实现 projection。
- 后续 Host 必须拥有 Session/Run、registry 协调、AbortController、投影与执行政策；v1 单 active run，竞争 busy → reject。这些 Host 执行能力尚未实现。
- requestId、submissionId、runId、Core turnId 各司其职。submission 去重只覆盖同一 Host 生命周期，不承诺跨重启 exactly-once。
- Run terminal 区分 completed/limited/failed/cancelled；cancelRequested 独立，真正 settle 前不释放执行 ownership。
- live draft 与已发布 canonical 分离。terminal correction 原子更新 Run/Session；Client 不写回 Core history。
- 显式 subscriptions.open/close 提供 snapshot + follow cut；stream sequence 不是 Session seq。gap/reconnect 重新同步，不建设 durable replay。
- Client 负责通信关联、快照/增量与不可变展示；Shell 只通过 Client，Runtime Plugin 无 UI 仍完整工作。
- Reverse request 已实现基础 envelope 与 test-only 内存往返 fixture；production reverse 业务注册表为空。真实 Client/Web transport seam 验收仍属 P3.3，不承诺审批/OAuth/picker/form 产品。
- Rich UI 将来采用 tool + optional presentation/resource；v1 无未知占位字段、动态 renderer、slot、iframe runtime。
- AG-UI/MCP/MCP Apps 仅为未来 adapter 方向，不成为内部真源。

## 3. Milestones

| Milestone | 目标 | 状态 |
| --- | --- | --- |
| P3.0 — Architecture Explore / SPEC | 冻结平台边界与可审计目标契约 | **COMPLETE**；Explore / SPEC 已完成并冻结 |
| P3.1 — Protocol Contract | DTO、校验、方法/事件、版本能力、transport port 与 fixtures | **COMPLETE**；实现、验证、最终 Independent Review PASS，implementation commits 已 push |
| P3.2 — Host Application Boundary | 组合、目录、执行协调、取消、投影、snapshot/subscription | **NEXT：Master Plan**；implementation **NOT STARTED** |
| P3.3 — Client Core + Transport Proof | React-free client、CLI fixture、一个 Web binding、双向 seam | 未开始；具体 Web binding 尚未选择 |
| P3.4 — Generic Web Shell | Chat/Sessions/Plugins/Host 状态与通用工具卡片 | 未开始 |
| P3.5 — Platform Acceptance | 替换、竞争、断线、JSON 与兼容性验收及独立审查 | 未开始 |

各 milestone 的 Goal / Deliverables / DoD / Forbidden Scope 见 SPEC §20；A/B/C/F/G/H/I/J/K 验收见 §19。本 HANDOFF 不复制全部 API、测试矩阵或逐文件实施步骤。

## 4. Next Window / Scope Discipline

**Next = P3.2 Master Plan。**

P3.1 已封存。下一窗口以 Phase 3 SPEC 为主，复核真实 Git、既有四包与独立 protocol 边界，再为 P3.2 限定路径、依赖和验收形成 Master Plan。**P3.2 implementation = NOT STARTED**。不得因本文存在而自动实施 P3.2–P3.5、调用真实 provider、标记后续 milestone COMPLETE 或执行后续 commit/push；本次 P3.1 封存的 Git 授权不延伸到后续工作。

具体 Web binding、其连接关联/安全/限额在 P3.3 Plan 中裁决；这不改变 transport-neutral Protocol。实现遇到 Phase 1/2 冻结契约冲突、新 production dependency、范围扩大或需弱化既有测试时，停止并返回架构裁决。

更新本文件只维护当前 baseline、architecture、milestones 与 next。未实现、未验证和未获授权的内容不得记为完成；不追加聊天记录或 changelog。`.zcode/`、`.zcodeignore` 是原有未跟踪项，不属于提交范围；禁止顺手 stage。
