# Phase 3 Platform — Handoff

> 用途：恢复 Phase 3 当前架构、基线与阶段入口；不是 changelog、审查记录或实施计划。
> 规范真源：[PHASE3_PLATFORM_SPEC.md](./PHASE3_PLATFORM_SPEC.md)。

## 1. Current Status / Baseline

| 项目 | 当前事实 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Code baseline | `166b1ee77ac01fe487270a0f2e1c027d695ab051` — `test(p3.3): complete platform acceptance coverage`；P3.3 封存基线，随本次 sealing commit 一并 push |
| Phase 3 SPEC baseline | `d5d1525a0c168651569ea99dd2fdb89f1fba6dc7` — `docs: freeze Phase 3 platform architecture`；规范内容未改，仅状态行随封存同步 |
| Phase 1 | **COMPLETE**；历史真实 provider 人工 PASS 与自动验证证据见 Phase 1 HANDOFF |
| Phase 2 | **COMPLETE**；四包已交付，独立复审与 HANDOFF 轻量审查 PASS，用户已确认封存；217 offline tests passed、Phase 2 real-provider NOT RUN |
| P3.0 Explore / SPEC | **COMPLETE**；已批准架构及正式 SPEC 已冻结 |
| P3.1 — Protocol Contract | **COMPLETE**；`@every-dagent/protocol` 已实现，最终独立审查 PASS，三个 implementation commits 已 push |
| P3.2 — Host Application Boundary | **COMPLETE**；`@every-dagent/host` 已实现，Targeted Re-review 最终 PASS，implementation 与 hardening commits 已 push |
| P3.3 — Client Core + Transport Proof | **COMPLETE**；`@every-dagent/client` 与 `apps/web` 已实现，最终 Final Closure Audit PASS（32 / 32 findings CLOSED），封存提交随本次 sealing push |
| Independent Review（P3.3） | **PASS — 0 BLOCKER / 0 MAJOR / 0 MINOR**；原独立审查为 0 BLOCKER / 29 MAJOR / 3 MINOR，现已全部 CLOSED |
| Phase 3 当前授权 | 仅 P3.3 封存（HANDOFF 更新、sealing commit、push）；**不授权 P3.4 implementation**，不授权调用真实 provider |
| P3.4 implementation | **NOT STARTED**；`Generic Web Shell` 尚未创建，下一轮单独授权 |
| 文档交付范围 | 本次只更新 `docs/PHASE3_HANDOFF.md`，并对 `PHASE3_PLATFORM_SPEC.md` 做最小状态行同步；不重写 SPEC |
| Next | **P3.4 Generic Web Shell（Master Plan）**；下一轮单独授权 |

### P3.3 Sealing Baseline / Verification

P3.3 交付 React-free `@every-dagent/client` 与 `apps/web`（`node:http` binding + `fetch`/SSE client channel）。实现提交为 `f096cf5` `feat: add Every-DAgent client core` 与 `cfaa7ef` `feat(web): add transport proof`；其后自 `d44b7db` 至 `166b1ee` 的 20 个 review-driven fix/test commit（client 生命周期与展示、reverse seam、web framing/背压/限额/origin/deadline、platform acceptance 正式化）全部原样保留，未 squash/amend。封板轮三个提交为 `4eb1c46` `fix(web): stop charging a pending line's trailing CR`、`ae1373f` `fix(web): close final transport edge cases`、`166b1ee` `test(p3.3): complete platform acceptance coverage`。

P3.3 Final Closure Audit：**PASS**，32 / 32 findings CLOSED（0 BLOCKER / 0 MAJOR / 0 MINOR），Repository integrity PASS，审计基线即上表 Code baseline。

| 检查 | 最终结果 |
| --- | --- |
| Client tests | **180 PASS** |
| Host tests | **169 PASS** |
| Protocol tests | **159 PASS** |
| Web（no-browser） | **106 PASS / 1 SKIP** |
| Memory carrier | **13 PASS** |
| Boundary / ownership | **40 PASS** |
| Old offline regression | **217 PASS**；既有测试完整保留 |
| Full offline（显式排除 real-provider，no-browser） | **912 PASS / 1 SKIP / 0 FAIL** |
| Platform acceptance | **20 / 20 PASS** |
| Real Chrome smoke | **1 PASS**（真实 Chrome，非 IAB 替代） |
| No-browser smoke | **1 SKIP**；SKIP 不计 PASS |
| Real provider | **NOT RUN** |
| `pnpm typecheck` 与各 package tsc | PASS |
| `git diff --check` | PASS |

**Real provider NOT RUN 是 frozen P3.3 scope 允许的最终状态**：P3.3 验收不依赖真实 provider，这不是遗漏测试，也不是 blocker；Phase 1 的历史真实 provider 人工 PASS 不转记为 P3.3 验证。

P3.3 交付能力：React-free `@every-dagent/client`（connect / reconnect / resync、presentation store、sequence 与 stream ownership、unknown write outcome 处理、reverse HostRequest 机制）、memory carrier、真实 Web transport（HTTP upstream + SSE downstream、UTF-8 与 framing、bounded transport budgets、backpressure、Origin / Host 安全校验、absolute deadlines）、真实 Chrome transport smoke，以及正式 platform acceptance 回归。

P3.3 不实现（冻结边界，不得按已实现引用）：P3.4 React Web Shell、rich tool UI、full HITL、OAuth、durable pause/resume、multi-agent、workflow、marketplace、hot reload。

### P3.2 Implementation Baseline / Verification

以下两个提交共同构成 P3.2 已交付基线，原样保留，未 squash/amend；已推送至 `origin/rewrite/runtime-lite`，远端已核验为当时的 Code baseline：

- `bca4f21da167820db5f9499528e9a05540a655e9` — `feat: add Every-DAgent host boundary`
- `1276707271afd6c8e9a4ba626dbbc21e496b4912` — `fix(host): harden lifecycle and protocol boundaries`

`@every-dagent/host` 已实现 authoritative Host：Session / Run ownership、submission dedup、唯一 token RegistryGate（execution / mutation lease）、Client-independent Runtime drain、canonical settled publication、subscription atomic cut、plugin lifecycle coordination、取消 ownership（abort 不提前释放）、Core → Protocol safe projection 与安全错误映射、shutdown 生命周期（唯一 completion、等待真正 settle、cleanup 失败不谎报）。production reverse 业务注册表仍为空，`host.describe` 如实声明 `reverseRequests=false`。新增 production dependency 仅为三个 workspace 包（`agent-core` / `plugin-system` / `protocol`），无第三方新增。

第二个提交覆盖 Targeted Re-review 的 B1 与 M1–M6：shutdown completion ownership、admission task 先于外部回调登记、settled log 语义闭合校验、correlatable 非法帧的 requestId 消费、cancel 投影故障、ready Session 忙语义，并补齐对应回归测试。

| 检查 | 已记录结果 |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm exec tsc --noEmit -p packages/host/tsconfig.json` | PASS |
| `pnpm exec tsc --noEmit -p packages/protocol/tsconfig.json` | PASS |
| Host tests | **14 files / 141 tests PASS** |
| Protocol tests | **7 files / 159 tests PASS** |
| Old offline regression | **21 files / 217 tests PASS**；既有测试完整保留 |
| Full offline（显式排除 real-provider） | **42 files / 517 tests PASS** |
| `pnpm install --frozen-lockfile` | PASS |
| `git diff --check` | PASS |
| Real provider | **NOT RUN** |

### P3.1 Implementation Baseline / Verification

以下三个提交共同构成 P3.1 已交付基线，原样保留，未 squash/amend；已推送至 `origin/rewrite/runtime-lite`，远端已核验为当时的 Code baseline：

- `0b49652675754b253e3a6d43576151112212b57f` — `feat: add Every-DAgent protocol contract`
- `3fadceca2911756559d4527d0d4381d9caffb1bd` — `fix(protocol): harden validation boundaries`
- `17288dbaffdccfd10a34b66cfbdfd461e611a83c` — `fix(protocol): close validation review gaps`

Protocol Contract 已实现 DTO/types、12 operations、8 events、JSON-safe guard、runtime validation、decode/validate/encode、transport-neutral channel contract、reverse request 基础 envelope 与 test-only fixtures。唯一新增 production dependency 为精确锁版 `valibot@1.5.0`。当时未实现的 Host/Client/Web、pending manager、timeout runtime、reconnect、Host projection 与业务 HITL，已由后续 P3.2 / P3.3 交付。

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

Phase 1/2 文档与既有 contract 保持不变；Phase 1 历史真实 provider PASS 不转记为 P3.1 验证；P3.1 封存记录见下文历史小节，未重跑测试或调用真实 provider。

## 2. Architecture Decisions

已批准 AD-1–AD-17 与 15 条 Platform Laws 的规范表述见 SPEC §2–§3。P3.0–P3.3 已实现部分与后续 Shell 的规范要求如下，不将后续能力记为已实现：

- Every-DAgent 是 Agent Application Platform，目标是 small kernel / stable boundaries / rich extension surfaces。
- 既有 `agent-core`、`model-pi-ai`、`plugin-system`、`plugin-calculator` 边界不变；Plugin Runtime 不另建包。
- 独立 `protocol`、`host`、React-free `client` 与 `apps/web` 均已创建；P3.1–P3.3 已交付，Shell 尚未创建。
- Protocol 独立于 Core / Plugin System / provider / UI（不依赖 React）；使用 lightweight bidirectional Request/Response + Events。
- 代际 `"1"`、host.describe 与 capability shapes/validation 为协议契约；Host 侧协商（版本、instance 绑定、重复 describe 语义）已在 P3.2 实现，没有 semver/range solver/自动降级。
- Control/Interaction Plane 是同包 namespace；内部对象经 Host 投影成 runtime-validated JSON DTO，投影已由 P3.2 实现（含 DisplayInput、canonical、PluginSummary、安全错误）。
- Host 拥有 Session/Run、submission dedup、registry 协调、AbortController、投影与执行政策；v1 单 active run（`limits.maxActiveRuns = 1`），竞争 busy → reject。
- Host 权威（P3.3 冻结）：Session、Run 状态、插件协调与执行政策只由 Host 决定；Client 只持有可丢弃的展示副本，不写回 canonical。
- requestId、submissionId、runId、Core turnId 各司其职；同方向 requestId 在一次逻辑连接内不复用（含可关联但非法的帧），重复即连接级 protocol fault。submission 去重只覆盖同一 Host 生命周期，不承诺跨重启 exactly-once。
- Run terminal 区分 completed/limited/failed/cancelled；cancelRequested 独立，只有 Runtime iterator 真正 settle 后才释放执行 ownership。settled Core 日志在发布前按 outcome 校验其闭合结构，无法验证即 failed/host_error + blocked Session。
- `accepted` ≠ `completed`（P3.3 冻结）：accepted 只是 Host 接受，终态只能经运行或 Host 自身故障到达；cancelRequested 是独立事实，不等于已停止，仍可能最终 completed。
- RuntimeEvent ≠ SessionEvent（P3.3 冻结）：`SessionEvent` 是 Core 的持久事实，`HostEvent` 是 Host 的投影事实，Client 不得按 Core 事件语义解读 Host 事件。
- live draft 与已发布 canonical 分离（live ≠ canonical）；terminal correction 原子更新 Run/Session，Client 不写回 Core history。
- 显式 subscriptions.open/close 提供 snapshot + follow cut（open 的 snapshot 与响应在同一同步 cut 中，响应先于新 stream 任何事件）；stream sequence 不是 Session seq。gap/reconnect 重新同步，不建设 durable replay。
- Client 负责通信关联、快照/增量与不可变展示（P3.3 已交付）；Shell 只通过 Client，Runtime Plugin 无 UI 仍完整工作。
- 通信层不自动 replay 非幂等写入（P3.3 冻结）：失去应答的写入对 Client 是 unknown，是否重发由上层决定，transport 不代做。
- Reverse request：HostRequest envelope、Host 侧 pending、Client 侧 handler 与结果契约、按 epoch / stream / pending entry 的 ownership 已在 P3.3 实现；**reverse registration/profile 是 internal seam**，不是公开面，**production reverse 业务注册表仍为空**，`host.describe` 如实声明 `reverseRequests=false`；不承诺审批/OAuth/picker/form 产品。
- Rich UI 将来采用 tool + optional presentation/resource；v1 无未知占位字段、动态 renderer、slot、iframe runtime；Client 当前只做 generic fallback（P3.3 冻结），rich UI 留给后续阶段。
- AG-UI/MCP/MCP Apps 仅为未来 adapter 方向，不成为内部真源。

## 3. Milestones

| Milestone | 目标 | 状态 |
| --- | --- | --- |
| P3.0 — Architecture Explore / SPEC | 冻结平台边界与可审计目标契约 | **COMPLETE**；Explore / SPEC 已完成并冻结 |
| P3.1 — Protocol Contract | DTO、校验、方法/事件、版本能力、transport port 与 fixtures | **COMPLETE**；实现、验证、最终 Independent Review PASS，implementation commits 已 push |
| P3.2 — Host Application Boundary | 组合、目录、执行协调、取消、投影、snapshot/subscription | **COMPLETE**；实现与 review hardening、Targeted Re-review PASS（0/0/0），commits 已 push |
| P3.3 — Client Core + Transport Proof | React-free client、CLI fixture、一个 Web binding、双向 seam | **COMPLETE**；Final Closure Audit PASS（32/32 CLOSED，0/0/0），封存提交已 push |
| P3.4 — Generic Web Shell | Chat/Sessions/Plugins/Host 状态与通用工具卡片 | **NEXT**；implementation **NOT STARTED**，下一轮单独授权 |
| P3.5 — Platform Acceptance | 替换、竞争、断线、JSON 与兼容性验收及独立审查 | 未开始 |

各 milestone 的 Goal / Deliverables / DoD / Forbidden Scope 见 SPEC §20；A/B/C/F/G/H/I/J/K 验收见 §19。本 HANDOFF 不复制全部 API、测试矩阵或逐文件实施步骤。

## 4. Next Window / Scope Discipline

**Next = P3.4 Generic Web Shell（Master Plan）。**

P3.3 已封存，其阶段结论、验收数字与冻结边界见 §1–§2；P3.3 的 repair 过程细节不进入本文件。下一窗口以 Phase 3 SPEC 为主，复核真实 Git 与既有包边界（`protocol` / `host` / `client` / `apps/web` 的 public 面），再为 P3.4 限定路径、依赖与验收形成 Master Plan。**P3.4 implementation = NOT STARTED**。不得因本文存在而自动实施 P3.4–P3.5、调用真实 provider、标记后续 milestone COMPLETE 或执行后续 commit/push；本次 P3.3 封存的 Git 授权不延伸到后续工作。

P3.4 及以后仍未交付的能力：React Web Shell、rich tool UI、full HITL、OAuth、durable pause/resume、multi-agent、workflow、marketplace、hot reload。Client 侧 generic fallback 仍是当前唯一展示策略；rich UI 只能作为后续阶段的可选增强，不改变已冻结的 Protocol 与 Host 权威边界。实现遇到 Phase 1/2/3 冻结契约冲突、新 production dependency、范围扩大或需弱化既有测试时，停止并返回架构裁决。

更新本文件只维护当前 baseline、architecture、milestones 与 next。未实现、未验证和未获授权的内容不得记为完成；不追加聊天记录或 changelog。`.zcode/`、`.zcodeignore` 是原有未跟踪项，不属于提交范围；禁止顺手 stage。
