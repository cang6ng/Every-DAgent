# Every-DAgent Phase 2 — Plugin System SPEC

> 状态：目标设计与 milestone contract 已冻结；实现尚未开始。
> 范围：Plugin Contract + PluginManager；下一阶段为 P2.0 Package Boundary。
> 基线：`rewrite/runtime-lite` / `641ca74c9b69f6dffa2671d7b38009407792d8aa`。
> Phase 1 COMPLETE；其 SPEC 与 HANDOFF 冻结，不承载 Phase 2 的后续变更。

## 1. 目标与规范边界

建立最小、可解释、可扩展的 in-process Plugin System，使 Music、Calendar、Gmail、Memory 等未来业务以插件存在。
AgentRuntime、AgentLoop、Session、ContextBuilder、ToolRegistry、ModelClient contract 保持业务无关与 provider-neutral。
本文的“必须”“不得”是实现约束；本文描述目标，不表示功能已完成。实际进度见 [PHASE2_HANDOFF.md](./PHASE2_HANDOFF.md)。
Phase 1 的真实状态以 [PHASE1_HANDOFF.md](./PHASE1_HANDOFF.md) 为基线；历史设计见 [Phase 1 SPEC](<./PHASE1_AGENT_CORE_SPEC .md>)。

Phase 2 最小验收链路：

```text
register plugin → tool absent
→ enable → tool present
→ Agent calls calculator → tool result 42
→ disable → tool absent
→ new ModelRequest has no calculator schema
→ registry.execute("calculator", ...) returns unknown tool
→ re-enable → clean new activation
```

## 2. Architecture Decisions

1. P2.0 拆出 `@every-dagent/model-pi-ai`；Core 不保留 provider dependency 或兼容重导出。
2. Plugin Contract 与 Manager 放在独立的 `@every-dagent/plugin-system`，不进入 Core。
3. PluginContext 只暴露 ScopedToolRegistrar，不暴露裸 ToolRegistry、Runtime、Loop、Session 或通用 service lookup。
4. 生命周期仅使用 `activate(context)` + `context.onDispose(...)`；无 `deactivate()`、返回 disposer 或通用 effect framework。
5. 工具通过 staging → preflight → synchronous commit 发布；失败执行补偿清理。
6. 生命周期并发采用 **busy → reject**；不使用 per-plugin FIFO queue、排队等待或 removal-pending 状态。
7. `PluginPermission` 第一版仅为 `"storage"`；未实现的能力不提前进入 public contract。
8. Permissions 是 host capability declaration / policy gate，不是 security sandbox。
9. 工具集合只在宿主保证共享 registry 的 turn 与直接工具执行均 idle 时变更；Manager 不自动检查 idle。
10. P2.0 暂留 CalculatorTool 于 Core；P2.4 将真实工具与 CalculatorPlugin 归入 `plugin-calculator`，不留兼容出口。
11. Phase 2 不引入 Cordis。它擅长 service registry、lifecycle、scope 与 effect/dispose，但不能替代本项目的 ID 管理、tool staging、batch visibility、permissions 和生命周期状态。未来确有 service dependencies / nested plugins 时再复评。
12. 不改变 Core 的 retry、cancel、Session、Tool 输入校验与 RuntimeContext 语义；通用 schema validation 不属于本期。

## 3. Package Boundary 与 P2.0 迁移

目标生产依赖方向如下；所有跨 workspace package 依赖显式使用 `workspace:*`：

```text
model-pi-ai ────────> agent-core
     └─────────────> @earendil-works/pi-ai@0.87.1
plugin-system ─────> agent-core
plugin-calculator ─> plugin-system
         └────────> agent-core
```

- `agent-core` 删除 pi-ai runtime dependency；src、tests、public API 均不得引用 pi-ai 或其类型。
- 不得将 pi-ai 转为 Core 的 devDependency；保留 ModelClient、ModelRequest、ModelEvent 等中立契约。
- `model-pi-ai` 依赖 Core 与锁定的 SDK；导出 `createPiAiModelClient`、`PiAiModelClientOptions`、`PiAiStreamSource`。
- Core 删除上述 adapter 的出口；调用者改用新包，不保留 compatibility re-export。
- 跨包使用公共 package 出口，不通过相邻包的 `src` 私有路径导入。
- 继续使用当前私有 ESM/TypeScript 源码包形态；不新增打包、发布框架，不升级 SDK。

| 当前文件或内容 | P2.0 目标归属 |
| --- | --- |
| `agent-core/src/model/pi-ai-client.ts` | `model-pi-ai/src/pi-ai-client.ts` |
| `pi-ai-client.test.ts` | `model-pi-ai/tests/` |
| `pi-ai-integration.test.ts` | `model-pi-ai/tests/`，保留 faux / stubbed socket 验证 |
| `helpers/fake-pi-ai-stream.ts` | `model-pi-ai/tests/helpers/`，不能遗留在 Core 编译范围 |
| `real-provider.e2e.test.ts` | 根级 `tests/integration/` |
| `calculator-roundtrip.test.ts` 的 faux 往返部分 | 根级 `tests/integration/calculator-roundtrip.test.ts` |
| 同文件的四项 CalculatorTool 单元测试 | 暂留 `agent-core/tests/calculator.test.ts` |
| 共用的 `helpers/session-lifecycle.ts` | 根级 `tests/helpers/`；仍是测试辅助代码，不是生产出口 |
| 其余 provider-neutral 测试，包括 `session-store.test.ts` | 原地保留 |

根级 integration 是 composition root，显式声明所需 workspace / SDK 开发依赖；不能依赖偶然 hoist。
根 tsconfig 必须覆盖新增 `tests`；各包保留自己的 src/tests 类型检查范围。
不得让 model-pi-ai 反向依赖 plugin package 来容纳组合测试，也不得为 helper 新建共享生产包。
全仓安装仍包含 SDK，与 Core 自身零 provider dependency 不矛盾；不得用根依赖掩盖 Core 残留引用。
P2.0 不迁移 CalculatorTool 实现、不修改其出口和行为；P2.4 再单独完成该迁移。

## 4. Public Contracts

以下为 `plugin-system` 的规范声明；代码块中的 `declare` 仅表示接口，不表示已有实现。
`Tool`、`ToolRegistry` 复用 Core；不复制一套插件专用 Tool 契约。

```ts
import type { Tool, ToolRegistry } from "@every-dagent/agent-core";

export type PluginPermission = "storage";

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly permissions?: readonly PluginPermission[];
}

export type PluginDisposer = () => void | Promise<void>;

export interface ScopedToolRegistrar {
  register(tool: Tool): void;
}

export interface PluginStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginCapabilities {
  readonly storage?: PluginStorage;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly tools: ScopedToolRegistrar;
  readonly capabilities: PluginCapabilities;
  onDispose(disposer: PluginDisposer): void;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  activate(context: PluginContext): void | Promise<void>;
}

export type PluginStatus =
  | "disabled"
  | "enabling"
  | "enabled"
  | "disabling"
  | "error";

export interface PluginFailure {
  readonly operation: "enable" | "disable";
  readonly phase: "permissions" | "activate" | "commit" | "dispose";
  readonly message: string;
  readonly cleanupErrors: readonly string[];
}

export interface PluginInfo {
  readonly manifest: PluginManifest;
  readonly status: PluginStatus;
  readonly lastFailure?: PluginFailure;
}

export interface PluginManagerOptions {
  readonly tools: ToolRegistry;
  readonly grants?: Readonly<Record<string, readonly PluginPermission[]>>;
  readonly storage?: (pluginId: string) => PluginStorage;
}

export interface PluginManager {
  register(plugin: Plugin): void;
  unregister(id: string): Promise<void>;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  get(id: string): PluginInfo | undefined;
  list(): readonly PluginInfo[];
}

export declare class PluginBusyError extends Error {
  constructor(pluginId: string);
}

export declare function createPluginManager(
  options: PluginManagerOptions,
): PluginManager;
```

### 4.1 Manifest、ID 与快照

- `id/name/version` 必填；name/version 必须是非空白字符串，version 是诊断元数据，不引入 semver solver。
- ID 区分大小写且仅接受小写标识：`^[a-z][a-z0-9._-]*$`；大写或空白直接拒绝，不 trim、不 normalize。
- 同一 Manager 的 plugin ID 唯一；重复 register 同步抛错，无覆盖、无 last-wins。
- register 只登记定义，初始 disabled；不执行 activate、不取得 storage、不发布工具。
- register 复制并冻结 manifest 与 permissions 数组；省略 permissions 等同空集合，重复声明按集合语义检查。
- 运行时遇到 contract 外的 permission 值必须拒绝，不默认为已授权；grants 同样校验并在 Manager 创建时复制。
- get/list 返回冻结的只读快照，含独立的 failure/cleanupErrors 数据，不泄露插件对象或内部资源栈。
- list 按注册顺序；get(missing) 返回 undefined；无状态事件总线、历史错误日志或持久化目录。

### 4.2 Tool、activation scope 与清理登记

- Tool name 仍是全局模型可见名称；不自动 namespace / prefix / 改名。所有冲突拒绝，existing owner 不被覆盖。
- 插件必须保持注册描述稳定，不在 staging 或启用期间修改 name、schema 或 execute；本期不实现任意对象的深冻结。
- 每次从 disabled 开始的 enable 创建新 scope；enabled no-op 不创建 scope。旧 disposer 与 capability handle 不复用。
- activate 可以异步；Manager 必须等待其返回的 Promise，但不自动追踪插件未 await 的后台任务。
- activate 成功或失败后，tools.register 与 onDispose 登记入口均 seal；晚到调用同步抛错。
- 插件取得资源后应尽快 onDispose；Manager 无法自动清理从未登记的资源。
- ScopedToolRegistrar.register 返回 void；Manager 自动持有真实 registry disposer，插件不能注销别人的工具。
- 启用后不支持动态增删工具或追加 disposer；重新组织能力必须走下一次完整 activation。

## 5. PluginManager 状态机与 API 结果

| 当前状态 | enable | disable | unregister |
| --- | --- | --- | --- |
| missing | reject | reject | fulfilled no-op |
| disabled | 开始 enable 流程 | fulfilled no-op | 删除记录 |
| enabling | PluginBusyError | PluginBusyError | PluginBusyError |
| enabled | fulfilled no-op | 开始 disable 流程 | 内部 disable，成功后删除 |
| disabling | PluginBusyError | PluginBusyError | PluginBusyError |
| error | reject，保留失败 | reject，不重复 cleanup | reject，不删除记录 |

所有异步 API 的失败以 Promise rejection 返回；register 配置错误同步抛出。
PluginBusyError 的 name 为 `PluginBusyError`，message 标识 plugin ID；其余错误可用明确 message 的 Error。
missing、busy、error 状态拒绝，以及重复 register，不覆盖已有 lastFailure。
没有 force reset、recovery API、自动 lifecycle retry、自动等待或 FIFO queue。

### 5.1 Enable

1. 检查 ID 和状态；disabled 必须在第一个异步让出点及调用任何外部回调前进入 enabling。
2. 检查全部 declared permissions、host grants 和实现可用性。
3. 创建新 scope；需要 storage 时取得宿主 scoped view，并包装成本 scope 的 handle。
4. 调用并等待 activate(context)。
5. seal tools.register 与 onDispose。
6. preflight 全部 staged tools；通过后执行无 await 的同步 commit。
7. 全部成功才进入 enabled，清除上次 lastFailure；enable Promise fulfilled。

权限或 storage factory 失败归 permissions 阶段；不调用 activate、不发布工具。
activate 失败归 activate；preflight/commit 失败归 commit。失败路径先 seal，再执行已登记资源的清理。
失败且清理干净：disabled + lastFailure，原 enable Promise reject，允许宿主以后显式重试。
失败且 rollback/cleanup 也失败：error + lastFailure，保留原始错误与全部清理错误，不能重新 enable。

### 5.2 Disable / unregister

- disable(enabled) 在外部回调或异步让出前进入 disabling；先撤销工具，再串行执行插件 cleanup。
- 所有清理成功后 disabled；任意清理错误进入 error，disable Promise reject。
- unregister(enabled) 使用内部清理流程，不调用需要重新经过公开状态检查的 disable 来实现自己。
- 注销清理期间保持 disabling；清理成功后直接删除记录并完成操作，不暴露可重新 enable 的中间窗口。
- unregister(disabled) 删除记录；unregister(error) 拒绝；不得自动删除 plugin storage data。
- 清理记录每次 activation 最多尝试一次；error 上的重复调用不重新执行已经尝试过的 disposer。

### 5.3 Busy rejection 与宿主调用纪律

enabling/disabling 期间，enable/disable/unregister 一律立即返回 rejected Promise，不排队、不复用进行中的 Promise。
即使请求目标相同也拒绝：两个未等待的 enable 不合并；只有已经 enabled 的 enable 才是 no-op。
Host / UI 必须 await 上一个 lifecycle operation 完成后再发起同插件操作。
不同插件可同时 activation；同步 commit 按实际完成顺序处理冲突。要求确定顺序时，宿主逐个 await。
不实现 entry identity queue、old queue/new plugin race、removal-pending 或 queue reentrancy 机制。

### 5.4 失败记录

PluginFailure 记录最近一次实际生命周期失败，不是任意 API 调用错误日志。
- operation 为 enable 或 disable；unregister 的内部清理失败记作 disable。
- phase 区分 permissions / activate / commit / dispose。
- enable 失败的 message 保留原始失败；cleanupErrors 独立保存全部 rollback/cleanup 错误，不覆盖原始原因。
- disable 清理失败以 dispose 为 phase，message 概括失败；cleanupErrors 保留各项详情。
- 非 Error throw 必须安全规范化为字符串；不能因格式化失败而中断剩余 cleanup。
- 成功重新 enable 清除旧失败；disabled no-op 不抹掉 activation failure。
- 不写 Session、turn/end，不自动 console.log、持久化或上报；错误字符串规范化不等于凭据脱敏。

## 6. Tool Staging、Commit 与 Rollback

activate 内 ctx.tools.register 只写 scope staging，不能立即写共享 ToolRegistry。
preflight 必须检查 staging 内部重名及与真实 registry 的冲突；全部通过后才尝试提交。
Manager 可提前报告内部重名，但 preflight 仍是批量发布前的最终检查。
提交在一个无 await 的同步代码段中，按 staging 顺序调用 ToolRegistry.register 并收集 disposer。
全部成功才 enabled；任何一次 register 失败，只逆序撤销本次已成功取得的 registrations，不删除已有 owner。
随后执行已登记的 plugin cleanup；rollback 干净回 disabled，任何 rollback/cleanup 错误进入 error。
默认 MapToolRegistry 满足同步注册、重名无副作用、disposer 幂等且不移除后继注册的约束。
注入其他 registry 也必须满足该契约，不得在抛错前留下无法通过 disposer 撤销的隐藏注册。

这里保证的是 **ToolRegistry registration lifecycle 的补偿式原子性**：
- activation 尚未完成时，本插件的 staging 工具不可见。
- 对当前非重入同步 registry 与正常异步消费者，成功后全部可见；失败并成功回滚后无本次残留。
- 不承诺任意自定义 registry 的重入观察、跨线程发布或外部副作用的全局事务。
- 不是数据库事务、HTTP rollback、文件写回滚；storage 写入也不会自动撤销。

### 6.1 Cleanup 协议

1. 逆工具注册顺序尝试所有 tool disposer；同步抛错也收集并继续。
2. 然后按 onDispose 登记的 LIFO 顺序逐个调用并 serial await。
3. 一个 cleanup 失败不阻断剩余 cleanup；每个已登记 disposer 每次 activation 最多尝试一次。
4. 全部尝试结束后使 scope capability 失效；失败同样失效，但不能据此谎报资源已清理。

正常清理时，工具必须先从 registry 消失，再执行 plugin cleanup，避免清理过程中继续发现工具。
若注入的 tool disposer 自身失败，仍尝试其他清理并进入 error；不得承诺失败的注册一定已经消失。
永不 settle 的 activation/cleanup 会使操作保持 busy；不通过 timeout、强制 kill 或跳过清理伪造成功。
未登记的后台工作不受自动管理；撤销 registration 不撤销已经持有的 Tool 对象引用。

## 7. Storage Permission 与 Capability

PluginPermission 第一版仅 `"storage"`；不声明 network / credentials，未来实现对应能力时再扩 union。
Host composition root 提供 grants，默认 deny；例如 `grants: { "my-plugin": ["storage"] }`。
每次实际 activation 检查：**manifest declared + host grant + host implementation available**。
全部条件成立才取得并注入 storage；未声明时，即使 host 已授权且有实现，也不调用 factory、不注入。
声明但未授权，或声明且获准但 host 未提供实现，enable 必须 reject；不得先 activate 再报错。
授权配置按 plugin ID 匹配，不是用户级业务授权；本期无授权 UI、授权持久化或运行中撤权 API。

### 7.1 Storage view

- storage(pluginId) 是同步 host factory，返回仅属于该插件的 scoped view；不得把全局 storage 暴露给插件。
- get/set/delete 的异步契约由 host 实现；key/value 为 string，get 缺失返回 undefined。
- 宿主保证不同 plugin ID 的数据隔离；测试用内存 fixture 验证同 key 不串数据。
- Manager 包装每次 activation 的 handle；不负责数据库、文件系统、迁移或存储持久性。
- disable/unregister 不自动删数据；再次 enable 可以取得同一数据视图，但必须得到新的生命周期 handle。
- 注册入口 seal 与 capability 失效不同：enabled 时不能再登记资源，但 storage 仍有效。
- cleanup 期间 storage 仍有效；全部清理尝试结束后，旧 handle 的新调用必须 reject。
- 每个 handle 检查自己所属 scope 是否失效；重新 enable 不能使旧 handle 复活。
- 失效不取消已发起的操作，不回滚数据写入；storage 方法失败按普通 Promise rejection 传播。

### 7.2 安全边界

**Plugin Permission System does NOT sandbox untrusted code.**
in-process JS plugin 仍可能直接 import node:fs、use fetch、read process.env 或 load modules。
本期权限仅约束 host-provided capabilities；不给 capability 不代表剥夺 Node 或 JavaScript 的环境权限。
恶意第三方插件隔离可能需要 separate process、WASM 或 IPC capability sandbox，均不属于 Phase 2。

## 8. Running Agent 并发边界

Phase 2 不支持 turn 正在执行时动态 enable/disable plugin。
Host 在变更共享 ToolRegistry 的生命周期之前，必须保证共享 registry 的全部 Agent turn 和直接 tool execution 均 idle。
Host 必须 await 相关 lifecycle operations 完成后才允许新 turn 或工具执行；仅在 idle 时发起但不等待，不满足契约。
只登记元数据的 register、get/list 不需要阻塞 turn；Manager 不检测 idle，不替宿主实现调度锁。

原因：旧 model request 看见 tool A，随后 A 被移除或替换，旧 call 按名称查询当前 registry 时，可能 unknown tool，也可能误执行同名新 owner。
本期不实现 turn-level registry snapshot、generation routing、execution drain coordinator、hot reload 或 automatic cancellation。
RuntimeContext 与 signal 原样透传，不因插件边界复制或替换；不修改 Runtime/Loop 去感知 PluginManager。

## 9. Milestones 与 Definition of Done

每个 milestone 单独 Plan、批准、Implement、Review、Fix、验证；不得跨 milestone 顺手扩展范围。
所有测试名必须与实际断言一致；既有离线断言保留，不用 skip、弱化类型或改预期掩盖迁移问题。

### P2.0 — Package Boundary

**Goal：** Core 的物理包边界与 provider-neutral 契约一致。
**Deliverables：** 按 §3 迁移 adapter、测试、helper、公共出口；新增 model-pi-ai package/config，更新 workspace 依赖、lockfile 与根测试配置。
**Tests：** 根 typecheck、全量离线测试、单独 Core typecheck/tests；检查 Core src/test/public API/importer 无 pi-ai；验证跨包公共入口可解析。
**Acceptance Criteria：** 基线 130 条离线测试全部保留并通过；Core 无 pi-ai runtime/dev dependency；adapter 行为不变；SDK 固定 0.87.1；真实 E2E 移位但无凭据仍 skip。
**Non-goals：** CalculatorTool 迁移、PluginManager、schema validator、SDK 升级、构建/发布体系。

### P2.1 — Plugin Contract

**Goal：** 冻结可直接实现的最小 public API。
**Deliverables：** plugin-system 包与 §4 契约、出口；记录 manifest/ID、seal、busy/error 与 scope 语义。
**Tests：** typecheck、契约类型测试、public API review；确认 permission union 仅 storage，复用 Core Tool 类型。
**Acceptance Criteria：** 接口与本文一致，无裸 registry、deactivate、返回 disposer 或预留未实现 permission；可以尚无 Manager 完整实现，不以假实现伪装完成。
**Non-goals：** 完整生命周期实现、持久化、通用 service/effect framework。

### P2.2 — PluginManager

**Goal：** 实现目录、状态机、工具生命周期与可诊断失败。
**Deliverables：** §5–§6 的 register/enable/disable/unregister/get/list、staging/preflight/commit、rollback、LIFO cleanup、busy-reject；无权限声明的插件完整可用。
**Tests：** register、duplicate plugin ID、enable/disable、各自幂等、missing ID、tool conflict、multiple-tool staging、activation failure、partial commit rollback、cleanup LIFO、cleanup failure、error state、unregister enabled、busy reject。
**Acceptance Criteria：** deferred Promise 测试证明 busy 立即拒绝且不排队；activation 未完成时工具不可见；commit 故障注入证明旧 owner 保留且本批回滚；所有已登记 cleanup 尽力执行，失败不被吞掉。
**Non-goals：** 队列、自动等待/重试、force reset、运行中工具切换；storage 完整注入留 P2.3，P2.2 对尚未落地的 storage 请求必须 fail closed，不提前放行。

### P2.3 — Storage Permission + Lifecycle Hardening

**Goal：** 落实 default-deny 与 scope-bound storage，完善异常边界。
**Deliverables：** §7 gate 与 scoped injection、memory test fixture；seal/失效、错误归一与清理失败语义的完整验证。
**Tests：** declared + granted + provided → works；undeclared → unavailable 且 factory 未调用；not granted → reject；not implemented → reject；不同 plugin ID 存储隔离；factory 失败不 activate。
**Tests（生命周期）：** sealed registrar、late onDispose、disable 后旧 storage handle invalid、re-enable 不复活旧 handle、cleanup 中 storage 仍有效、多个 cleanup failure、非 Error throw normalization。
**Acceptance Criteria：** 未授权不取得 capability、不 activate；全部清理尝试后旧 handle 失效，即使 cleanup 失败；grants/manifest 原对象修改不能改变已登记政策；仅实现 storage contract/injection，不宣称 sandbox。
**Non-goals：** SQLite、filesystem DB、migration、credential store、network/credentials capability、动态授权或进程隔离。

### P2.4 — CalculatorPlugin + E2E

**Goal：** 用真实生产工具证明 Plugin System，而不是恢复业务应用。
**Deliverables：** plugin-calculator 包，createCalculatorTool 与 createCalculatorPlugin 出口；插件 id 为 calculator，工具名称保持 calculator，无权限声明；迁移工具实现/单测，删除 Core 的 calculator 出口，不兼容重导出。
**Tests：** 保留乘法、非法参数、非有限积、schema 四项单测；FakeModel deterministic plugin E2E 覆盖 §1 全链路与 session tool result 42；disable 后新 ContextBuilder request 无 calculator，execute 返回 unknown tool；re-enable 无重复注册且新 scope 干净。
**Acceptance Criteria：** Agent 确实调用注册工具，不能只断言最终文本 42；Runtime/Loop/Session 无插件业务分支；根级组合测试使用公共包入口。
**Evidence：** 分开记录 FakeModel deterministic plugin E2E、pi-ai faux provider integration、real-provider credential-gated E2E；前两层不能当真实 LLM 证据。保留真实 smoke/工具往返，有凭据时验证，无凭据明确 skip，不阻塞确定性插件验收。
**Non-goals：** Chinook、Music/Calendar/Gmail、UI、业务存储、反向依赖 adapter 或新增复杂示例。

### P2.5 — Final Audit

**Goal：** 核实交付与 SPEC 一致，形成 Phase 2 封存依据。
**Deliverables：** 独立审查全部 package/public API、状态/失败路径、工具 ownership、权限边界；更新 Phase 2 HANDOFF 的事实与证据。
**Tests：** 全量 typecheck 与离线测试；Core 独立边界检查；复核每项 lifecycle/permission/E2E 验收断言，单列真实 provider 实际 pass/skip。
**Acceptance Criteria：** P2.0–P2.4 DoD 全满足；无 Core 反向依赖、无队列/未实现权限名；无未关闭 blocker；检查最终 diff、LOC、敏感错误输出，代码/文档表述一致。无新增 build/lint 配置时不得虚报执行这些检查。
**Non-goals：** 为审计顺手重构、补 UI/MCP、扩大示例、把 skipped real-provider 测试记为 pass。

## 10. 目标文件布局

```text
docs/PHASE2_PLUGIN_SPEC.md
docs/PHASE2_HANDOFF.md
packages/agent-core/                 # 保留 provider-neutral src/tests
packages/model-pi-ai/
  package.json / tsconfig.json
  src/pi-ai-client.ts / index.ts
  tests/pi-ai-client.test.ts / pi-ai-integration.test.ts
  tests/helpers/fake-pi-ai-stream.ts
packages/plugin-system/
  package.json / tsconfig.json
  src/plugin.ts / permissions.ts / plugin-manager.ts / activation-scope.ts / index.ts
  tests/plugin-contract.test.ts / plugin-manager.test.ts / plugin-lifecycle.test.ts
  tests/permissions.test.ts / helpers/memory-storage.ts
packages/plugin-calculator/
  package.json / tsconfig.json
  src/calculator.ts / calculator-plugin.ts / index.ts
  tests/calculator.test.ts
tests/helpers/session-lifecycle.ts
tests/integration/calculator-roundtrip.test.ts
tests/integration/calculator-plugin.e2e.test.ts
tests/integration/real-provider.e2e.test.ts
```

文件可在对应 milestone Plan 中按职责小幅合并；不得借此改变包依赖方向或新增框架。
activation-scope 仅管理本次暂存注册、disposer 和 handle 有效性，不扩展成通用 effect system。

## 11. Non-goals 与变更纪律

Phase 2 不做：Cordis integration、MCP、Skills、Multi-Agent、Subagent、Planner、Workflow Engine、UI、Tauri。
不做 plugin marketplace、remote plugin install、hot reload、plugin dependency graph、version solver、plugin update system。
不做 security sandbox、network capability、credentials capability、SQLite、filesystem DB、持久化凭据库。
不做 dynamic runtime tool switching、force reset、automatic lifecycle retry、lifecycle queue 或通用 Tool schema validation。
不为未来需求预建兼容层、宿主框架或能力注册系统；production 新依赖必须先裁决。

实现发现 SPEC ambiguity、public API conflict、new dependency required、frozen decision must change 或 major scope expansion 时，必须 STOP 并报告 blocker，返回 Astra / 人工裁决，不自行选择新架构。
架构批准不等于自动授权 commit/push；阶段执行纪律与当前进度见 Phase 2 HANDOFF。
