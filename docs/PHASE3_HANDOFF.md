# Phase 3 Platform — Handoff

> 用途：恢复 Phase 3 当前架构、基线与阶段入口；不是 changelog、审查记录或实施计划。
> 规范真源：[PHASE3_PLATFORM_SPEC.md](./PHASE3_PLATFORM_SPEC.md)。

## 1. Current Status / Baseline

| 项目 | 当前事实 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Code baseline | `1dc71d4` — `test(web): verify live and canonical tool result safety`；最终 re-seal 的代码/测试基线（含 post-seal repair 链 `b8a5f85` → `426036e` → `9e21e4f` → `1dc71d4`），随本次 sealing commit 一并 push。P3.4/P3.5 交付提交为 `83842c7` — `feat(web): add generic agent shell` 与 `a104e96` — `test(web): add phase 3 shell acceptance coverage` |
| Phase 3 SPEC baseline | `d5d1525a0c168651569ea99dd2fdb89f1fba6dc7` — `docs: freeze Phase 3 platform architecture`；规范内容未改，仅状态行随封存同步 |
| Phase 1 | **COMPLETE**；历史真实 provider 人工 PASS 与自动验证证据见 Phase 1 HANDOFF |
| Phase 2 | **COMPLETE**；四包已交付，独立复审与 HANDOFF 轻量审查 PASS，用户已确认封存；217 offline tests passed、Phase 2 real-provider NOT RUN |
| P3.0 Explore / SPEC | **COMPLETE**；已批准架构及正式 SPEC 已冻结 |
| P3.1 — Protocol Contract | **COMPLETE**；`@every-dagent/protocol` 已实现，最终独立审查 PASS |
| P3.2 — Host Application Boundary | **COMPLETE**；`@every-dagent/host` 已实现，Targeted Re-review 最终 PASS |
| P3.3 — Client Core + Transport Proof | **COMPLETE**；`@every-dagent/client` 与 `apps/web` transport 已实现，Final Closure Audit PASS（32/32 CLOSED） |
| P3.4 — Generic Web Shell | **COMPLETE**；`apps/web` browser shell、应用服务器与构建已交付（`83842c7`） |
| P3.5 — Platform Acceptance | **COMPLETE**；验收矩阵与真实浏览器 gate 交付（`a104e96`）；post-seal review 问题（R01–R12）全部修复后重新封板（`1dc71d4`） |
| Phase 3 | **COMPLETE**；P3.0–P3.5 全部交付，R01–R12 = 12/12 CLOSED 后重新封板 |
| Independent Focused Review（对已 push 的早期 seal 复核） | 初始 **FAIL — 0 BLOCKER / 5 MAJOR / 7 MINOR**（R01–R12）；post-seal repair 后 **R01–R12 = 12 / 12 CLOSED，0 BLOCKER / 0 MAJOR / 0 MINOR，READY TO RE-SEAL: YES**（历史与证据见下） |
| Phase 3 当前授权 | 仅本次 re-seal（HANDOFF 更新、sealing commit、push）；**不授权 Phase 4**，不授权调用真实 provider |
| Next | **Phase 3 重新封板完成，Phase 4 ready（未授权）**；如需进入需新的授权与 Plan。Phase 3 SPEC §21 的 future scope 仍然成立 |

### P3.4 / P3.5 Sealing Baseline / Verification

P3.4 交付 `apps/web` 的 Generic Web Shell：browser 层（React，只消费 `@every-dagent/client` 公共入口与 `ClientSnapshot`）、应用服务器（page server + 原 P3.3 binding + 公开 `Host` 的组合）、构建（esbuild：page bundle + runnable server bundle）与命令行入口。原 P3.3 的七个 transport 文件、`apps/web` 三个 public exports、以及 `protocol`/`host`/`client`/`agent-core`/`plugin-system`/`plugin-calculator`/`model-pi-ai` 的生产代码与公共接口全部零改动。

交付与早期 seal 的提交原样保留，未 squash/amend：

- `83842c7` — `feat(web): add generic agent shell`（实现）
- `a104e96` — `test(web): add phase 3 shell acceptance coverage`（验收）
- `0f23000` — `docs: seal phase 3 platform`（早期 seal 文档，已 push）

早期 seal push 后，独立 focused review 判定 **FAIL（0 BLOCKER / 5 MAJOR / 7 MINOR，R01–R12）**。这是对已 push 的早期 seal 做的 post-seal repair；repair 按 finding 追加、原提交未 amend/未 squash：

- `b8a5f85` — `fix(web): close the focused-review findings in the shell and page server`
- `426036e` — `test(web): add a regression for each focused-review finding`
- `9e21e4f` — `fix(web): close remaining focused-review gaps`
- `1dc71d4` — `test(web): verify live and canonical tool result safety`（R11 残余：test-only gate 锁定 live 阶段，释放后再验证 canonical）

最终裁决：**R01–R12 = 12 / 12 CLOSED；0 BLOCKER / 0 MAJOR / 0 MINOR OPEN；READY TO RE-SEAL: YES**。

| 检查 | 实测结果（最终 re-seal 轮，code baseline `1dc71d4`） |
| --- | --- |
| `pnpm typecheck`（根 + `apps/web/tsconfig.browser.json`） | PASS；browser 项目真实包含全部 **16 个 browser source** + `http-channel` + rendering test（program 实测；有回归防止 include 被继承的 `exclude` 静默清空） |
| Protocol + Host + Client tests | **159 + 169 + 180 = 508 PASS** |
| Web（no-browser） | **181 PASS / 16 SKIP**（SKIP 全部为真实浏览器用例，离线按设计跳过；SKIP 不计 PASS） |
| 既有套件（`tests/integration` + agent-core / plugin-system / plugin-calculator / model-pi-ai） | **32 files / 313 PASS / 0 FAIL**（含 platform acceptance 20、memory carrier 13） |
| Boundary / ownership | **19 PASS**（`boundary.test.ts` 11：七个 transport 文件的每个相对 import 按解析后的真实目标校验；`shell-boundary.test.ts` 8：三层分层与浏览器图） |
| Old offline regression | 既有套件全部通过（见上，0 FAIL）；较早期记录数字只增不减 |
| Full offline（显式排除 real-provider 与 `.zcode/**`，no-browser） | **1002 PASS / 16 SKIP / 0 FAIL**（83 files / 1018 tests） |
| Real Chrome browser acceptance（strict gate） | **16 / 16 PASS，0 SKIP**；真实 Chrome 153.0.8010.53 |
| `pnpm build:web` | PASS（`dist/server.mjs` + `dist/public/{index.html,styles.css,app.js}`） |
| `git diff --check` | PASS |
| Real provider | **NOT RUN** |

真实浏览器 16 例 = 原 P3.3 transport smoke 1 例（保留未改）+ Shell 15 例（连接与目录、流式完成、calculator 卡片、第二插件卡片、late create 应答不夺 selection/草稿、reload 恢复、busy 与取消、limited、failed、插件失败、非 JSON 输入、危险 tool-result 惰性、断线重连、丢应答待确认、Host 重启）。`node apps/web/scripts/verify-browser.mjs` 在缺少浏览器、用例改名、零收集或出现 SKIP/todo 时一律失败——离线 no-browser 结果与真实浏览器 PASS 分开记账，绝不把 SKIP 记为 PASS。验收期间生成了页面截图用于人工视觉 sanity（连接态、完成态、工具卡片态），布局、可读性与状态呈现正常。

**最终能力（已交付、可用）**：Generic React Web Shell；React-free Client；会话列表 / 新建 / 选择（selection 绑定 hostInstanceId）；canonical + live 分离的会话渲染；流式输出；通用 tool call / result 卡片（含危险文本按 inert text 渲染，经真实工具路径与真实 Chrome 验收）；插件状态与生命周期 UI（error 插件无可操作按钮）；cancel / limited / failed / reconnect 的诚实呈现（cancel requested ≠ stopped、limited ≠ completed）；unknown-write outcome UX（不自动重发，显式查询或同 submissionId 重发）；真实 HTTP/SSE transport；reconnect / resync；browser / server 依赖隔离与严格 boundary 强制；真实 Chrome 严格验收 gate。

**未改的冻结边界**：Protocol 独立（不依赖 Core / provider / UI）；Host 权威；Client React-free；`ClientSnapshot` 是 presentation truth；live ≠ canonical；accepted ≠ completed；cancel requested ≠ stopped；非幂等写入不自动 replay；production reverse 业务注册表仍为空、`host.describe` 仍声明 `reverseRequests=false`；AG-UI / MCP / MCP Apps 仍是未来 adapter 方向。

早期 focused implementation review（范围：冻结架构边界、React 状态归属、Client 公共 API、reconnect/run UX、通用渲染、浏览器行为、测试覆盖）曾判定 PASS（0 BLOCKER / 0 MAJOR / 6 MINOR）并修复 6 项；随后对已 push 的 seal 复核判定 FAIL（0 / 5 / 7，R01–R12），repair 后 **12 / 12 CLOSED、0 / 0 / 0**。两段历史都在上方提交链中保留。

新增 production dependency（已批准、精确锁版）：`react@19.3.0`、`react-dom@19.3.0`，以及 workspace 依赖 `@every-dagent/client`、`@every-dagent/host`。新增根 devDependencies：`esbuild@0.28.2`、`@types/react@19.3.0`、`@types/react-dom@19.3.0`。

P3.4/P3.5 不实现（future scope，不得按已实现引用）：rich tool UI / artifact framework、full HITL、OAuth、credential vault、durable pause/resume、multi-agent、workflow、marketplace、hot reload、AG-UI/MCP/MCP Apps adapter、desktop/Tauri、Settings 产品页、provider 配置 CLI。production reverse 业务注册表仍为空，`host.describe` 仍如实声明 `reverseRequests=false`；Shell 只做 generic fallback 渲染。

### P3.3 Sealing Baseline / Verification

P3.3 交付 React-free `@every-dagent/client` 与 `apps/web`（`node:http` binding + `fetch`/SSE client channel）。实现提交为 `f096cf5` `feat: add Every-DAgent client core` 与 `cfaa7ef` `feat(web): add transport proof`；其后自 `d44b7db` 至 `166b1ee` 的 20 个 review-driven fix/test commit（client 生命周期与展示、reverse seam、web framing/背压/限额/origin/deadline、platform acceptance 正式化）全部原样保留，未 squash/amend。封板轮三个提交为 `4eb1c46`、`ae1373f`、`166b1ee`。

P3.3 Final Closure Audit：**PASS**，32 / 32 findings CLOSED（0 BLOCKER / 0 MAJOR / 0 MINOR），Repository integrity PASS。

P3.3 交付能力：React-free `@every-dagent/client`（connect / reconnect / resync、presentation store、sequence 与 stream ownership、unknown write outcome 处理、reverse HostRequest 机制）、memory carrier、真实 Web transport（HTTP upstream + SSE downstream、UTF-8 与 framing、bounded transport budgets、backpressure、Origin / Host 安全校验、absolute deadlines）、真实 Chrome transport smoke，以及正式 platform acceptance 回归。

| 检查 | 已记录结果（P3.3 封存轮） |
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

### P3.2 Implementation Baseline / Verification

以下两个提交共同构成 P3.2 已交付基线，原样保留，未 squash/amend；已推送至 `origin/rewrite/runtime-lite`：

- `bca4f21da167820db5f9499528e9a05540a655e9` — `feat: add Every-DAgent host boundary`
- `1276707271afd6c8e9a4ba626dbbc21e496b4912` — `fix(host): harden lifecycle and protocol boundaries`

`@every-dagent/host` 已实现 authoritative Host：Session / Run ownership、submission dedup、唯一 token RegistryGate（execution / mutation lease）、Client-independent Runtime drain、canonical settled publication、subscription atomic cut、plugin lifecycle coordination、取消 ownership（abort 不提前释放）、Core → Protocol safe projection 与安全错误映射、shutdown 生命周期（唯一 completion、等待真正 settle、cleanup 失败不谎报）。

### P3.1 Implementation Baseline / Verification

以下三个提交共同构成 P3.1 已交付基线，原样保留，未 squash/amend；已推送至 `origin/rewrite/runtime-lite`：

- `0b49652675754b253e3a6d43576151112212b57f` — `feat: add Every-DAgent protocol contract`
- `3fadceca2911756559d4527d0d4381d9caffb1bd` — `fix(protocol): harden validation boundaries`
- `17288dbaffdccfd10a34b66cfbdfd461e611a83c` — `fix(protocol): close validation review gaps`

唯一新增 production dependency 为精确锁版 `valibot@1.5.0`。

## 2. Architecture Decisions

已批准 AD-1–AD-17 与 15 条 Platform Laws 的规范表述见 SPEC §2–§3。P3.0–P3.5 已实现部分如下，不将 future scope 记为已实现：

- Every-DAgent 是 Agent Application Platform，目标是 small kernel / stable boundaries / rich extension surfaces。
- 既有 `agent-core`、`model-pi-ai`、`plugin-system`、`plugin-calculator` 边界不变；Plugin Runtime 不另建包。
- `protocol`、`host`、React-free `client`、`apps/web` 均已交付；`apps/web` 现分三层：transport（原七文件，P3.3 冻结）、browser shell、应用服务器。
- Protocol 独立于 Core / Plugin System / provider / UI；使用 lightweight bidirectional Request/Response + Events；代际 `"1"`，无 semver/range solver/自动降级。
- Control/Interaction Plane 是同包 namespace；内部对象经 Host 投影成 runtime-validated JSON DTO。
- Host 拥有 Session/Run、submission dedup、registry 协调、AbortController、投影与执行政策；v1 单 active run（`limits.maxActiveRuns = 1`），竞争 busy → reject。
- Host 权威：Session、Run 状态、插件协调与执行政策只由 Host 决定；Client 只持有可丢弃的展示副本，不写回 canonical。
- requestId、submissionId、runId、Core turnId 各司其职；submission 去重只覆盖同一 Host 生命周期，不承诺跨重启 exactly-once。
- Run terminal 区分 completed/limited/failed/cancelled；cancelRequested 独立；accepted ≠ completed。
- RuntimeEvent ≠ SessionEvent；live ≠ canonical；terminal correction 原子更新 Run/Session。
- 显式 `subscriptions.open/close` 提供 snapshot + follow cut；gap/reconnect 重新同步，不建设 durable replay。
- 通信层不自动 replay 非幂等写入；失去应答的写入对 Client 是 unknown，是否重发由上层（用户显式动作）决定。
- **P3.4 冻结的 Shell 边界**：Shell 只通过 Client 公共入口（`createClient`/`ClientError`/`ClientSnapshot`/typed operations）；`ClientSnapshot` 是 presentation truth，React 通过 `useSyncExternalStore` 直接消费；Shell 本地只保存用户输入与调用返回（binding 地址、selection+hostInstanceId、in-flight 标志、notices、unknown-write 记录），不复制 Host 状态、不 fold 事件、不写回 response。运行时 shell 的 tool/plugin 渲染完全 generic。
- **P3.4 冻结的 Unknown outcome 政策**：仅当 `outcome === "unknown"` 记录待确认；文案明确「可能已执行、不会自动重发」；恢复=显式查询（`runs.get`）或用户显式重发同一 submissionId；跨 Host 一律拒绝确认与重发；「忽略提示」只移除提示。
- **P3.4 冻结的应用组合**：`startShellServer({ host, staticRoot })` 组合 page server + 原 binding（page origin 双 loopback 拼写进入 allowlist）；CLI 两种模式 `--composition <module>`（模块导出 `createShellHost()`，可自 bundle 的 `createHost` 组合模型/插件）与 `--binding <origin>`（只服务页面）；两者都不选择模型、不读取凭据。
- Rich UI 将来采用 tool + optional presentation/resource；v1 无未知占位字段、动态 renderer、slot、iframe runtime。
- AG-UI/MCP/MCP Apps 仅为未来 adapter 方向，不成为内部真源。

## 3. Milestones

| Milestone | 目标 | 状态 |
| --- | --- | --- |
| P3.0 — Architecture Explore / SPEC | 冻结平台边界与可审计目标契约 | **COMPLETE** |
| P3.1 — Protocol Contract | DTO、校验、方法/事件、版本能力、transport port 与 fixtures | **COMPLETE** |
| P3.2 — Host Application Boundary | 组合、目录、执行协调、取消、投影、snapshot/subscription | **COMPLETE** |
| P3.3 — Client Core + Transport Proof | React-free client、CLI fixture、一个 Web binding、双向 seam | **COMPLETE** |
| P3.4 — Generic Web Shell | Chat/Sessions/Plugins/Host 状态与通用工具卡片 | **COMPLETE**；`83842c7` |
| P3.5 — Platform Acceptance | 替换、竞争、断线、JSON 与兼容性验收及独立审查 | **COMPLETE**；`a104e96` + post-seal repair 至 `1dc71d4`；R01–R12 全 CLOSED 后重新封板 |

各 milestone 的 Goal / Deliverables / DoD / Forbidden Scope 见 SPEC §20；A/B/C/F/G/H/I/J/K 验收见 §19。本 HANDOFF 不复制全部 API、测试矩阵或逐文件实施步骤。

## 4. Next Window / Scope Discipline

**Phase 3 已重新封板（PHASE 3 COMPLETE，READY FOR PHASE 4）；Phase 4 未授权。**

此后如需进入 Phase 4 或扩展 v1 之外的任何能力，需要新的授权与 Plan；本文件存在不构成任何实施或 Git 授权。仍未交付的 future scope 见 §1（rich tool UI、HITL、OAuth、durable pause/resume、multi-agent、workflow、marketplace、hot reload、外部协议 adapter、desktop、Settings/凭据产品、真实 provider 的常规化）。

操作要点：`pnpm typecheck` 现同时检查根项目与 browser 项目；`pnpm build:web` 产出可运行 bundle；`pnpm test:web:browser` 是真实浏览器严格 gate（缺浏览器即失败）；离线全量为 `EVERY_DAGENT_NO_BROWSER=1 pnpm exec vitest run --exclude '**/real-provider.e2e.test.ts'`。真实 provider 一律显式授权后才可调用。

更新本文件只维护当前 baseline、architecture、milestones 与 next。未实现、未验证和未获授权的内容不得记为完成；不追加聊天记录或 changelog。`.zcode/`、`.zcodeignore` 是原有未跟踪项，不属于提交范围；禁止顺手 stage。
