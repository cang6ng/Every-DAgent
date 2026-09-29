# Phase 3 Platform — Handoff

> 用途：恢复 Phase 3 当前架构、基线与阶段入口；不是 changelog、审查记录或实施计划。
> 规范真源：[PHASE3_PLATFORM_SPEC.md](./PHASE3_PLATFORM_SPEC.md)。

## 1. Current Status / Baseline

| 项目 | 当前事实 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Code baseline | `c717f1087e75a7055a18c51512b27b1a1cb28c58` — Phase 2 最终生命周期回归测试基线 |
| Freeze Cleanup 起始 Git baseline | `ce3b9f87a6b09833bcbed113ecf6cb5026c83183` — `docs: correct Phase 2 handoff completion status`；这是冻结提交的前置基线，不自引用本文件的未来提交 |
| Phase 1 | **COMPLETE**；历史真实 provider 人工 PASS 与自动验证证据见 Phase 1 HANDOFF |
| Phase 2 | **COMPLETE**；四包已交付，独立复审与 HANDOFF 轻量审查 PASS，用户已确认封存；217 offline tests passed、Phase 2 real-provider NOT RUN |
| P3.0 Explore / SPEC | **COMPLETE**；已批准架构及正式 SPEC 已冻结 |
| Phase 3 当前授权 | 仅清理、冻结并提交/推送这两个 Phase 3 文档；不授权 Master Plan 编写或 implementation |
| Phase 3 implementation | **未开始**；P3.1 implementation 未开始，protocol/host/client/apps/web 尚未创建 |
| 文档交付范围 | 仅 `docs/PHASE3_PLATFORM_SPEC.md` 与 `docs/PHASE3_HANDOFF.md` |
| Next | **P3.1 Master Plan**；下一轮单独授权 |

Phase 1/2 SPEC、HANDOFF 与既有 contract 保持不变。Phase 2 的测试数字是历史基线，不是 Phase 3 已运行或通过的证明；本轮未运行完整 Vitest suite、真实 provider 或 Web UI。

## 2. Architecture Decisions

已批准 AD-1–AD-17 与 15 条 Platform Laws 的规范表述见 SPEC §2–§3。当前必须保留的边界：

- Every-DAgent 是 Agent Application Platform，目标是 small kernel / stable boundaries / rich extension surfaces。
- 既有 `agent-core`、`model-pi-ai`、`plugin-system`、`plugin-calculator` 边界不变；Plugin Runtime 不另建包。
- 计划新增独立 `protocol`、`host`、React-free `client`，以及 `apps/web`；名字不代表已经创建。
- Protocol 不依赖 Core/Plugin System/provider/React；使用 lightweight bidirectional Request/Response + Events。
- 代际为 `"1"`，从 v1 提供 host.describe 与真实能力协商；没有 semver/range solver/自动降级。
- Control/Interaction Plane 是同包 namespace；内部对象必须经 Host 投影成 runtime-validated JSON DTO。
- Host 拥有 Session/Run、registry 协调、AbortController、投影与执行政策；v1 单 active run，竞争 busy → reject。
- requestId、submissionId、runId、Core turnId 各司其职。submission 去重只覆盖同一 Host 生命周期，不承诺跨重启 exactly-once。
- Run terminal 区分 completed/limited/failed/cancelled；cancelRequested 独立，真正 settle 前不释放执行 ownership。
- live draft 与已发布 canonical 分离。terminal correction 原子更新 Run/Session；Client 不写回 Core history。
- 显式 subscriptions.open/close 提供 snapshot + follow cut；stream sequence 不是 Session seq。gap/reconnect 重新同步，不建设 durable replay。
- Client 负责通信关联、快照/增量与不可变展示；Shell 只通过 Client，Runtime Plugin 无 UI 仍完整工作。
- Reverse request 只证明 transport/client seam；production reverse 业务注册表为空，不提前承诺审批/OAuth/picker/form。
- Rich UI 将来采用 tool + optional presentation/resource；v1 无未知占位字段、动态 renderer、slot、iframe runtime。
- AG-UI/MCP/MCP Apps 仅为未来 adapter 方向，不成为内部真源。

## 3. Milestones

| Milestone | 目标 | 状态 |
| --- | --- | --- |
| P3.0 — Architecture Explore / SPEC | 冻结平台边界与可审计目标契约 | **COMPLETE**；Explore / SPEC 已完成并冻结 |
| P3.1 — Protocol Contract | DTO、校验、方法/事件、版本能力、transport port 与 fixtures | **NEXT：Master Plan**；implementation 未开始 |
| P3.2 — Host Application Boundary | 组合、目录、执行协调、取消、投影、snapshot/subscription | 未开始 |
| P3.3 — Client Core + Transport Proof | React-free client、CLI fixture、一个 Web binding、双向 seam | 未开始；具体 Web binding 尚未选择 |
| P3.4 — Generic Web Shell | Chat/Sessions/Plugins/Host 状态与通用工具卡片 | 未开始 |
| P3.5 — Platform Acceptance | 替换、竞争、断线、JSON 与兼容性验收及独立审查 | 未开始 |

各 milestone 的 Goal / Deliverables / DoD / Forbidden Scope 见 SPEC §20；A/B/C/F/G/H/I/J/K 验收见 §19。本 HANDOFF 不复制全部 API、测试矩阵或逐文件实施步骤。

## 4. Next Window / Scope Discipline

**Next = P3.1 Master Plan。**

下一窗口以 Phase 3 SPEC 为主，复核真实 Git 与四包边界，再为 P3.1 限定路径、依赖和验收形成 Plan。不得因本文存在而自动实施 P3.1–P3.5、调用真实 provider、标记后续 milestone COMPLETE 或执行后续 commit/push；本次文档冻结的 Git 授权不延伸到后续工作。

具体 Web binding、其连接关联/安全/限额在 P3.3 Plan 中裁决；这不改变 transport-neutral Protocol。实现遇到 Phase 1/2 冻结契约冲突、新 production dependency、范围扩大或需弱化既有测试时，停止并返回架构裁决。

更新本文件只维护当前 baseline、architecture、milestones 与 next。未实现、未验证和未获授权的内容不得记为完成；不追加聊天记录或 changelog。`.zcode/`、`.zcodeignore` 是原有未跟踪项，不属于提交范围；禁止顺手 stage。
