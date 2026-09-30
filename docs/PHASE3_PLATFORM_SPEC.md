# Every-DAgent Phase 3 — Platform Architecture SPEC

> 状态：P3.0 Architecture Explore / SPEC COMPLETE；本文冻结 Phase 3 的目标契约，规范内容不随阶段推进改写；阶段状态（P3.0–P3.3）见 [PHASE3_HANDOFF.md](./PHASE3_HANDOFF.md)。
> 范围：Protocol + Host + React-free Client + Generic Web Shell。
> 前置基线：Phase 1 COMPLETE、Phase 2 COMPLETE；当前 Git 基线与阶段入口见 Phase 3 HANDOFF。
> 本文不是 Implementation Master Plan。阶段状态见 [PHASE3_HANDOFF.md](./PHASE3_HANDOFF.md)。

## 1. North Star 与规范地位

Every-DAgent 是由 provider-neutral Agent Kernel、受控扩展运行时与权威 Host 组成，通过独立协议向可替换 Client 提供能力的 **Agent Application Platform**。

原则：**small kernel / stable boundaries / rich extension surfaces**。扩展面意味着职责明确的窄契约，不意味着万能 PluginContext 或提前实现未来功能。

平台应证明：换 Runtime Plugin 不改 Core/Protocol/Client/Shell；换 ModelClient 不改 UI/Protocol；换 Client 不改 Runtime；换 Transport 不改应用语义。Runtime Plugin 不写 UI 仍完整可用；Rich UI 将来仅为 optional enhancement。

本文“必须 / 不得”是验收约束。“未来”不是 v1 API 或实现许可。下述 TypeScript 形状为规范声明，不是已存在的 production code；实现可以使用等价类型组织，但不得改变字段、状态与行为。凡标为 host-internal 的接口不属于 wire contract。

### 1.1 输入与现状

必读输入：

- [Phase 1 SPEC](<./PHASE1_AGENT_CORE_SPEC .md>) 与 [Phase 1 HANDOFF](./PHASE1_HANDOFF.md)。
- [Phase 2 SPEC](./PHASE2_PLUGIN_SPEC.md) 与 [Phase 2 HANDOFF](./PHASE2_HANDOFF.md)。
- 本会话已批准的《Every-DAgent Phase 3 Platform Architecture Explore》及人工给定 AD-1–AD-17；Explore 当前是会话交付物，不虚构仓库文件链接。
- 四包实际 `src`、公共出口、测试与根 workspace/TypeScript 配置。

真实基线：四包 `agent-core`、`model-pi-ai`、`plugin-system`、`plugin-calculator` 已落地。Core 无 provider/plugin 依赖；pi-ai 为独立 adapter，SDK 固定 `0.87.1`。现有包是 private ESM/TypeScript 源码包，无现成 Web build/lint 配置。

### 1.2 不得改变的 Phase 1/2 语义

- Runtime 管 turn 边界，Loop 管 ReAct；`turnId` 由 Runtime 生成。
- `run()` 返回 Promise；`stream()` 为 AsyncIterable；两者共用执行路径。
- 取消通过原样传递的 AbortSignal；停止消费 stream 不等于取消。
- ModelClient 只输出已组装完整 tool call；Core 无参数增量、message start/end 或 model-step stream 边界。
- RuntimeEvent 只有 `assistant/chunk`、`tool/call`、`tool/result`、`turn/end`，没有 sequence。
- SessionEvent 有 Session 分配的 `seq/time`、调用方给定的 `turnId`，没有 sessionId。Session 只保证既有浅隔离。
- 取消/失败的未完成 step 可已发送 chunk，但不写 assistant 日志。
- Tool 输入及 schema 仍为 unknown；通用 Tool 参数校验不因 Protocol 加入 Core。Protocol validation 是另一边界。
- Tool 结果已由 Loop 转为字符串；失败 observation、重试、步预算及取消结局保持不变。
- PluginManager 不感知 Runtime，不检测 idle；busy → reject、staging/commit/cleanup、storage gate 均保持原义。
- 共享 registry 的全部 turn 与直接工具执行 idle 后才允许工具生命周期变更；必须等 lifecycle settle 后才恢复执行。
- PluginPermission 仍仅 `storage`；不提前新增 interactive/UI/credentials permission。

## 2. Frozen Architecture Decisions

| ID | 冻结决定 |
| --- | --- |
| AD-1 | 目标是可替换 Host/Client 的 Agent Application Platform，不是单一 React App。 |
| AD-2 | Phase 3 不侵入 Phase 1/2 已冻结语义。 |
| AD-3 | 独立 `@every-dagent/protocol` 不依赖 Core、Plugin System、provider SDK、React。 |
| AD-4 | Lightweight bidirectional Request/Response + Events；不建设通用 RPC framework。 |
| AD-5 | Control/Interaction Plane 只做 namespace 与语义分离，不拆协议包。 |
| AD-6 | 协议代际采用字符串 `"1"`；不采用 semver negotiation/range solver/自动降级/多代兼容框架。 |
| AD-7 | v1 有 `host.describe`；只宣告真实能力；capability 不等于 permission/approval/sandbox。 |
| AD-8 | Internal type → Host projection → Protocol DTO；内部类型不成为 wire contract。 |
| AD-9 | 全部 wire payload JSON-safe 且 runtime validated；TypeScript 不替代校验。 |
| AD-10 | Host 是 Session、Run、插件协调、执行政策与协议投影的 authority。 |
| AD-11 | runId 与 turnId 分离；accepted/completed、cancel requested/stopped、live/canonical 分离。 |
| AD-12 | Draft 不回写 Core history；断线不伪造完成。 |
| AD-13 | 新增 React-free `@every-dagent/client`。 |
| AD-14 | Runtime Plugin 无 UI 仍完整工作；v1 仅 generic fallback。 |
| AD-15 | Rich UI 未来为 tool + optional presentation/resource；v1 无万能 ui/presentation/artifact 占位字段。 |
| AD-16 | AG-UI/MCP/MCP Apps 保持 adapter seam，不作内部真源。 |
| AD-17 | v1 只证明 reverse request 机制，不冻结完整审批/OAuth/picker/form 业务契约。 |

## 3. Platform Laws

1. **Kernel Independence**：Core 不依赖 Plugin Runtime、Host、Protocol、Client 或 UI。
2. **Protocol Boundary**：Client ↔ Host 的应用语义只通过 Protocol，不共享内部对象补充能力。
3. **Protocol Independence**：Protocol 无 Core/Plugin/Provider/React 类型依赖，包括 import type。
4. **JSON Boundary**：所有 wire message 通过 JSON 与方法/事件 schema 校验；禁止 JS 对象引用捷径。
5. **Host Authority**：Session、run 状态、插件协调和执行政策只由 Host 决定。
6. **Projection Direction**：Client presentation 不得反向写入或修复 Core Session。
7. **Live vs Canonical**：临时输出与已发布的 Session 投影可区分；断流不是正常完成。
8. **Acceptance vs Completion**：命令接受、执行完成、持久化成功是不同事实；v1 不宣称磁盘持久性。
9. **Cancel vs Stop**：取消请求不等于执行停止，不回滚外部副作用。
10. **Registry Coordination**：工具执行与插件工具集合变更满足 Phase 2 idle 契约。
11. **Security Vocabulary**：capability、permission、approval、sandbox 不得互相替代。
12. **Pre-execution Gate**：未来审批必须先于真实工具执行；观察 tool/call 后弹窗不是执行 gate。
13. **Generic Fallback**：普通 Tool 永远不需要 UI 插件才能使用；富 UI 缺失不影响基本能力。
14. **Replaceability**：Provider、Transport 与 Shell 替换不修改 AgentRuntime。
15. **Honest Support and Retry**：未实现能力不宣告支持；通信层不自动重试非幂等操作。

## 4. Packages、分层与依赖

```text
Product composition root
  ├─ inject ModelClient / ContextBuilder / trusted Plugin definitions
  ├─ Host (Sessions / Runs / registry coordination / projection)
  │    ├─ agent-core
  │    └─ plugin-system
  └─ Web server binding
              ⇅ Protocol JSON messages
       Web client binding
              ⇅
       React-free Client
              ⇅
       Generic React Shell
```

| 位置 | 职责 | 禁止依赖/职责 |
| --- | --- | --- |
| `packages/protocol` | DTO、envelope、operation/event schemas、codec/validation、结构化 transport port 契约 | Core、Plugin System、provider、React、具体网络实现、业务执行 |
| `packages/host` | 组合 Core/Plugin、目录、协调、投影、协议处理 | React、HTTP/WS/Tauri 对象、硬依赖 pi-ai、业务 Plugin 实现、第二套 Loop |
| `packages/client` | transport 消费、关联、同步、不可变 presentation | Core/Host 实现、Provider、工具执行、权限政策、凭据 |
| `apps/web` | 浏览器 Shell、Web client binding、独立 server bootstrap/binding | 前端导入 server/provider/secret 模块 |

允许：`host → protocol + agent-core + plugin-system`；`client → protocol`；`model-pi-ai → agent-core + pi-ai`；业务 Plugin → 现有 Plugin/Core 契约。所有跨 workspace 依赖显式声明并使用公共入口。

不新增 extension-runtime 包；plugin-system 已承担此职责。不因 transport、控制面、事件等名词另建空包。Web server/client 文件必须形成清晰模块图，不能从一个 barrel 把 Node/provider 代码带入浏览器。

继续私有 workspace 形态；Phase 3 所需 Web 构建配置可在对应 milestone 增加，不顺带建立包发布或多语言 codegen 平台。任何新 production dependency 在 milestone Plan 中明确裁决，不借本文默许引入库。

## 5. Protocol 通用规则与 JSON

### 5.1 基本类型

```ts
type ProtocolVersion = "1";
type JsonValue = null | boolean | number | string | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
type Id = string;
type Sequence = number;
```

运行时补充约束：

- number 必须有限；sequence/count 为非负 safe integer；不允许 NaN/Infinity。JSON 不能保真 -0，内部展示投影将其视为不可保真的值，而不是静默归一。
- JsonValue 是稠密数组或纯 JSON object，不含 undefined、bigint、function、symbol、循环、accessor、Date/Map/Set/class instance、自定义 toJSON 行为。
- Id 必须为非空字符串，不 trim、不大小写转换。ID 是 opaque；Client 不解析其组成。pluginId 继续满足 Phase 2 已有规则，不另改插件 ID 契约。
- 可选属性以省略表达；wire 不出现 undefined。只有声明允许 null 的字段能为 null。
- 已知对象字段必须满足 schema；接收方忽略未知字段且不将其作为能力。发送方只发送本版本定义的字段。未知 kind/method/event type 不等于未知可选字段，按下文处理。
- 不提供任何 ui/presentation/artifact/metadata: unknown 扩展袋。JsonValue 在这里用于真实 JSON 数据及消息参数，不授予任意业务扩展语义。
- codec/validator 必须校验 envelope、方向、scope、method-specific params/result/event payload 及跨字段约束。不得只写 `JSON.parse(...) as Type`。

完整消息为一帧 JSON object。Transport 必须提供有限缓冲和帧大小约束；具体 Web 限额在 P3.3 binding 决策中固定并测试，不由 HTTP status 或 WebSocket opcode改变 Protocol 含义。超限须显式失败/关闭连接，不能截断成一个有效但变义的对象。

### 5.2 ProtocolError

```ts
interface ProtocolError {
  readonly code: ProtocolErrorCode;
  readonly message: string;
}
type ProtocolErrorCode =
  | "INVALID_REQUEST" | "UNSUPPORTED_PROTOCOL" | "NOT_INITIALIZED"
  | "HOST_INSTANCE_MISMATCH" | "METHOD_NOT_FOUND" | "CAPABILITY_NOT_SUPPORTED"
  | "SESSION_NOT_FOUND" | "SESSION_UNAVAILABLE" | "RUN_NOT_FOUND"
  | "PLUGIN_NOT_FOUND" | "HOST_BUSY" | "PLUGIN_UNAVAILABLE"
  | "PLUGIN_PERMISSION_DENIED" | "PLUGIN_OPERATION_FAILED"
  | "SUBMISSION_CONFLICT" | "REQUEST_CANCELLED" | "INTERNAL_ERROR";
```

message 是 Host/Client 生成的安全提示，不复制未知异常。没有 stack/cause/rawError/debug payload。code 是机器语义，message 不是可解析 API。未来新增未协商的错误语义不得令旧端误判成功；未映射错误用 INTERNAL_ERROR。

不能恢复 requestId 的非法 JSON/envelope 属 connection protocol fault：关闭该逻辑连接，不发送无法关联的 response，不取消 run。可恢复合法 requestId 的未知 method 或非法 params 返回对应 error。响应 schema 非法时接收方关闭连接，已发送写操作的结果标为 unknown，不能认为未执行。

### 5.3 Envelope 与四象限

以下 Base + union 必须实现 `result XOR error`；不得用两个 optional 字段允许同时存在/都不存在。

```ts
interface RequestBase<M extends string, P> {
  readonly protocolVersion: "1";
  readonly requestId: Id;
  readonly method: M;
  readonly params: P;
}
type ClientRequestFor<M extends keyof OperationMap> =
  RequestBase<M, OperationMap[M]["params"]>
  & { readonly kind: "client-request" }
  & (M extends "host.describe"
      ? { readonly hostInstanceId?: never }
      : { readonly hostInstanceId: Id });
type ClientRequest = {
  [M in keyof OperationMap]: ClientRequestFor<M>
}[keyof OperationMap];
interface HostRequest extends RequestBase<string, JsonValue> {
  readonly kind: "host-request";
  readonly hostInstanceId: Id;
  readonly streamId: Id;
  readonly timeoutMs: number;
}
type ResponseBody<T> =
  | { readonly result: T; readonly error?: never }
  | { readonly error: ProtocolError; readonly result?: never };
interface HostResponseBase {
  readonly kind: "host-response";
  readonly protocolVersion: "1";
  readonly hostInstanceId: Id;
  readonly requestId: Id;
}
interface ClientResponseBase {
  readonly kind: "client-response";
  readonly protocolVersion: "1";
  readonly hostInstanceId: Id;
  readonly streamId: Id;
  readonly requestId: Id;
}
```

OperationMap 的全部键及 params/result 形状由 §8 方法表逐项定义，必须一一对应，不允许 string index signature。ClientRequest 是该 map 的判别联合，不是公开任意方法调用器。

`HostResponse<M> = HostResponseBase & ResponseBody<OperationMap[M]["result"]>`；wire 不重复携带 method，接收方按 pending requestId 找回 M 并验证对应 result。`ClientResponse<R> = ClientResponseBase & ResponseBody<R>`；R 是 pending reverse profile 的具体 result，未知方法只允许 error response。未关联的 response 先验证通用 JSON/envelope/XOR 后丢弃，不假装知道其方法 schema。

HostRequest 的基础 envelope 必须可接收未知 method 以返回 METHOD_NOT_FOUND，但 v1 production 业务方法注册表为空；不能用宽 JsonValue 参数绕过 §13 的 profile 校验。测试 profile 不进入产品 operation map。

`host.describe` 不带 hostInstanceId；其余 ClientRequest 必须带 describe 返回的 hostInstanceId。错误响应也由实际 Host 标记自己的 instance。HostInstanceId 每次 Host 创建重新生成，不能从固定 hostname、版本或端口推导。

### 5.4 Request identity 与顺序

- requestId 只关联一次逻辑连接内、某一发送方向的一次请求，不代表业务执行 ID。
- 同方向 requestId 在该连接内不得重用，即使旧请求已经结束；两方向分别记账，由 kind 消歧。
- Host 收到重复 ClientRequest ID 视为 protocol fault，关闭连接，不二次 dispatch。跨连接重复提交依靠 submissionId，不依靠 requestId。
- 响应可以乱序完成；必须按 requestId 关联。Client 不按“最后一个问题”处理响应。
- 对没有 pending 的合法 response（重复、取消后迟到）丢弃，不响应 response、不恢复请求、不改变执行状态。
- Client 失去连接后，pending 正向请求以本地 CONNECTION_LOST/结果未知结束；该错误不是 Host 对业务已拒绝的证明。**CONNECTION_LOST 是 Client-local transport outcome，不是 ProtocolErrorCode，不会出现在 wire 上。**
- 通信取消/超时不得暗中变成 runs.cancel。

## 6. Version、Capabilities 与 HostDescription

### 6.1 Generation

所有 v1 消息携带 `protocolVersion: "1"`。正整数代际用十进制字符串表示；当前只实现 1。描述 bootstrap 的 envelope/error 读取先于具体业务版本验证，以便报告 UNSUPPORTED_PROTOCOL，不执行未知代际业务。

没有共同代际则停止建立 Client 会话，不自动降级。包 semver、provider SDK 版本、MCP/AG-UI 版本与内部 Protocol generation 各自独立。

同代际只允许兼容的可选字段或 capability opt-in 方法/事件扩展；不得改变既有字段或 enum 意义。新客户端不能要求老 Host 支持未宣告能力。不要在 v1 实现多代翻译器。

### 6.2 能力形状

```ts
interface ClientCapabilities {
  readonly reverseRequests: boolean;
}
interface HostCapabilities {
  readonly sessions: boolean;
  readonly runs: boolean;
  readonly plugins: boolean;
  readonly subscriptions: boolean;
  readonly reverseRequests: boolean;
}
interface HostDescription {
  readonly protocolVersion: "1";
  readonly hostInstanceId: Id;
  readonly host: { readonly name: string; readonly version: string };
  readonly capabilities: HostCapabilities;
  readonly clientCapabilities: ClientCapabilities;
  readonly limits: { readonly maxActiveRuns: number };
  readonly retention: "host-lifetime";
}
```

HostDescription.clientCapabilities 是当前逻辑连接接受的 Client 能力，不代表其他连接。v1 无能力名扩展袋或 per-capability version solver。未来加入真实能力时可以增加可选字段；未知能力字段忽略。

完整 Phase 3 Host 的 sessions/runs/plugins/subscriptions 必须为 true，maxActiveRuns 必须为 1。反向机制实际可承载且经过测试才可宣告 reverseRequests=true；它仅表示可收发 envelope/关联/拒绝，不表示支持 approval/form/picker/OAuth。

Client.reverseRequests=true 的最低含义：能验证 HostRequest，未知 method 立即回 METHOD_NOT_FOUND，而不是挂起；没有业务 handler 仍可以支持基础机制。Host 只能在双方 reverseRequests=true 时发送 HostRequest。

v1 不公布 settings/credentials/artifacts/ui.apps/toolRenderers/frontendTools/subagents。capability 不等于权限或安全认证。

### 6.3 host.describe

请求 params：`{ supportedProtocolVersions: string[], client: { name: string, version: string }, capabilities: ClientCapabilities }`。versions 必须非空、去重且均为正整数代际字符串；name/version 非空。

响应：HostDescription。当前只选择 1，调用方不包含 1 则 UNSUPPORTED_PROTOCOL。成功后绑定该逻辑连接的 version/client capabilities。

重复 describe 参数相同返回等价描述；已初始化连接改变版本或 capabilities 返回 INVALID_REQUEST，需新连接，不在活动订阅中偷偷改变语义。describe 不创建 Session，不授予权限，不接受 userId 作为可信身份。v1 限可信本地/开发部署，公网鉴权和多租户产品不在范围内。

## 7. Protocol DTO

### 7.1 安全展示值与插件

```ts
type DisplayInput =
  | { readonly kind: "json"; readonly value: JsonValue }
  | { readonly kind: "unavailable"; readonly reason: "not-json-safe" };
interface PluginFailureSummary {
  readonly operation: "enable" | "disable";
  readonly phase: "permissions" | "activate" | "commit" | "dispose";
  readonly code: "PLUGIN_PERMISSION_DENIED" | "PLUGIN_OPERATION_FAILED";
  readonly message: string;
  readonly cleanupFailureCount: number;
}
interface PluginSummary {
  readonly id: Id;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly permissions: readonly "storage"[];
  readonly status: "disabled" | "enabling" | "enabled" | "disabling" | "error";
  readonly lastFailure?: PluginFailureSummary;
}
```

PluginSummary 是显式 DTO，不能 re-export PluginInfo。permissions 省略在内部时投影为 []。错误字符串不直传；仅保留安全的 operation/phase/code/count。不暴露 Plugin 对象、capability handle、scope 或裸 registry。插件描述与工具正文属于可信插件内容，不宣称 Host 能识别其中任意秘密；Shell 始终按数据渲染。

### 7.2 Canonical conversation

```ts
interface CanonicalBase {
  readonly id: Id;
  readonly turnId: Id;
}
type CanonicalItem =
  | (CanonicalBase & { readonly kind: "user"; readonly text: string })
  | (CanonicalBase & { readonly kind: "assistant"; readonly text: string })
  | (CanonicalBase & { readonly kind: "tool-call"; readonly invocationId: Id;
      readonly callId: string; readonly name: string; readonly input: DisplayInput })
  | (CanonicalBase & { readonly kind: "tool-result"; readonly invocationId: Id;
      readonly callId: string; readonly name: string; readonly ok: boolean; readonly content: string });
interface SessionSummary {
  readonly sessionId: Id;
  readonly createdAt: number;
  readonly status: "ready" | "blocked";
  readonly activeRunId: Id | null;
}
interface SessionSnapshot extends SessionSummary {
  readonly canonical: readonly CanonicalItem[];
}
```

canonical 是**已发布的、settled turn 的 Session 投影**，不等于 Core 当前内部 log 的全部内容：活动 turn 内部可以持续 append，但 v1 只在该 run 真正 settle 时原子发布其 canonical 更新。Host 不修改 Core append 时机。

- user/assistant 分别来自 message/user、message/assistant；只投影真实已记录文本，空 assistant 记录可以存在，Shell 可不画空气泡。
- tool-call/result 来自独立日志事件。assistant.toolCalls 不再复制到 canonical assistant 项，避免工具卡片重复。
- Item id 在同 Session/Host 生命周期内稳定，可由记录 seq 派生；wire 不把该 ID 或内部 seq 当 stream sequence。
- 每个 tool/call 的 invocationId 唯一，tool/result 与实际串行日志配对。Core callId 是原样保留的普通 string，允许空字符串和重复，不套用 Host Id 的非空约束。不得仅以 callId 索引：当前 Core 不保证它在同 step、同 turn 或跨 turn 唯一。
- 投影按日志顺序匹配工具调用/结果，并校验 turnId/callId/name 一致，不重排或伪造 observation。不解析 content 推断“已执行/未执行”：`ok:false` 也可能是未派发。
- SessionSummary.activeRunId 为 Host 关联；每 Session 至多一个 active run，terminal 后为 null。
- createdAt 为 Host 创建时的 epoch milliseconds，非客户端提供；v1 无 rename/delete/import/history-edit/title-generation API。
- blocked 表示 Host 检测到无法安全继续的内部 turn/日志或投影故障；保留最后成功发布的 canonical，不自动修复。见 §10.5。

### 7.3 Run 与 live presentation

```ts
type RunStatus = "accepted" | "running" | "completed" | "limited" | "failed" | "cancelled";
type EndReason = "completed" | "max_steps" | "error" | "cancelled" | "host_error";
type LiveItem =
  | { readonly kind: "text"; readonly itemId: Id; readonly text: string }
  | { readonly kind: "tool"; readonly itemId: Id; readonly invocationId: Id;
      readonly callId: string; readonly name: string; readonly input: DisplayInput;
      readonly result: null | { readonly ok: boolean; readonly content: string } };
interface RunBase {
  readonly runId: Id;
  readonly submissionId: Id;
  readonly sessionId: Id;
  readonly text: string;
  readonly turnId: Id | null;
  readonly cancelRequested: boolean;
}
type RunSnapshot =
  | (RunBase & { readonly status: "accepted" | "running";
      readonly endReason: null; readonly error: null; readonly live: readonly LiveItem[] })
  | (RunBase & { readonly status: "completed"; readonly endReason: "completed";
      readonly error: null; readonly live: null })
  | (RunBase & { readonly status: "limited"; readonly endReason: "max_steps";
      readonly error: null; readonly live: null })
  | (RunBase & { readonly status: "cancelled"; readonly endReason: "cancelled";
      readonly error: null; readonly live: null })
  | (RunBase & { readonly status: "failed"; readonly endReason: "error" | "host_error";
      readonly error: ProtocolError; readonly live: null });
```

text 是 Host 接受的原始用户输入，非模型推断。turnId 在实际可得前为 null；可从该次 Runtime stream 或归属该 run 的 Session 记录观察，一旦绑定不可更换。不得让 Client 提供 Core turnId 或强迫修改 Runtime 生成机制。

LiveItem 是 UI timeline，不是模型 message/step。连续 assistant/chunk 可追加到同一 text item；遇到 tool/call 后下一文本用新 item。这个分段仅是展示顺序，不声称 model-step 边界。Tool invocation/item IDs 由 Host 分配，result 回填当前未完成工具项，不重复插入一个成功工具。Live IDs 不承诺与 canonical IDs 相同。

terminal live=null，必须与 canonical correction 原子应用；失败/取消时未记录片段不晋升历史。v1 不保存“失败 draft 历史”产品。UI 可以显示 run failed/cancelled 提示，但不得说工具副作用已回滚。

## 8. Operation Set v1

Control Plane：host/sessions/plugins/subscriptions。Interaction Plane：runs 及 run events。一个包、一个 envelope；不因 namespace 拆 transport。

所有非 describe 方法共同错误：NOT_INITIALIZED、UNSUPPORTED_PROTOCOL、HOST_INSTANCE_MISMATCH、INVALID_REQUEST、CAPABILITY_NOT_SUPPORTED、INTERNAL_ERROR。未知 method 为 METHOD_NOT_FOUND。表中只列附加错误。错误响应不等于任意外部副作用已回滚。

### 8.1 方法表

| Method | Params schema | Result schema | 附加错误 | 幂等与重试语义 |
| --- | --- | --- | --- | --- |
| `host.describe` | §6.3 | HostDescription | — | 相同参数可重复；不自动降级 |
| `sessions.list` | `{}` | `{ sessions: SessionSummary[] }` | — | 只读；按创建顺序 |
| `sessions.create` | `{}` | `{ session: SessionSnapshot }` | — | 非幂等；每次新建空 Session；不自动重试 |
| `sessions.get` | `{ sessionId: Id }` | `{ session: SessionSnapshot }` | SESSION_NOT_FOUND | 只读，不包含未发布 Core 日志 |
| `runs.start` | `{ sessionId: Id, submissionId: Id, text: string }` | `{ run: RunSnapshot }` | SESSION_NOT_FOUND、SESSION_UNAVAILABLE、SUBMISSION_CONFLICT、HOST_BUSY | §10.2 去重；不自动重发 |
| `runs.get` | `{ runId: Id }` 或 `{ submissionId: Id }`，恰好一个 | `{ run: RunSnapshot }` | RUN_NOT_FOUND | 只读，用于丢失响应后查询；不另建 runs.status |
| `runs.cancel` | `{ runId: Id }` | `{ run: RunSnapshot }` | RUN_NOT_FOUND | 相同 run 重复请求不重复副作用；响应不是停止确认 |
| `plugins.list` | `{}` | `{ plugins: PluginSummary[] }` | — | 只读；按 Manager 注册顺序 |
| `plugins.enable` | `{ pluginId: Id }` | `{ plugin: PluginSummary }` | PLUGIN_NOT_FOUND、HOST_BUSY、PLUGIN_UNAVAILABLE、PLUGIN_PERMISSION_DENIED、PLUGIN_OPERATION_FAILED | idle 且已 enabled 时 no-op；不能自动 retry 失败 activation |
| `plugins.disable` | `{ pluginId: Id }` | `{ plugin: PluginSummary }` | PLUGIN_NOT_FOUND、HOST_BUSY、PLUGIN_UNAVAILABLE、PLUGIN_OPERATION_FAILED | idle 且已 disabled 时 no-op；不能自动 retry cleanup |
| `subscriptions.open` | `{}` | `{ snapshot: HostSnapshot }` | — | 创建/替换连接订阅；非可重放的旧 stream，见 §12 |
| `subscriptions.close` | `{ streamId: Id }` | `{ closed: boolean }` | — | 只关闭匹配的本连接 stream；已关闭/旧 stream 为 false，不影响新 stream |

这里新增 subscriptions.open/close 是完整同步必需的显式操作，不是通用订阅框架。v1 无过滤表达式、topic routing、事件历史查询或 subscribe 任意方法。

### 8.2 输入与操作边界

- runs.start.text 必须为 string 且包含非空白字符；原值不 trim、不改变。其余业务参数不接受 Client 注入 ModelMessage、Tool、SessionEvent、userId、grants 或 credentials。
- sessions.create 允许 Host 忙时创建空 Session；无 registry 变更。响应丢失可能留下一个空 Session，Client 通过 list重新取得目录，不自动再 create。
- runs.get 未找到是当前 hostInstance 内不存在，不证明其他/旧 instance 没执行过。
- plugins.enable/disable 必须 await Manager 操作 settle 后返回。失败时返回安全 error，同时通过 event/snapshot 反映真实 Manager 状态。
- PluginManager error 状态返回 PLUGIN_UNAVAILABLE；权限阶段失败投影为 PLUGIN_PERMISSION_DENIED；activate/commit/dispose 失败为 PLUGIN_OPERATION_FAILED。不得根据未约定的原错误文本做语义解析。
- v1 不提供 plugins.register/unregister/install、直接 tools.execute、settings CRUD 或 credentials API。
- 读方法在 active run/lifecycle 时可用；读取返回 Host 已发布的不可变快照，不泄露半个原子更新。
- 方法响应是一次查询/命令结果，不作为 Client event store 的替代写入通道，避免较旧 response 覆盖较新事件；见 §12.5。

## 9. HostEvent v1

```ts
type EventScope =
  | { readonly kind: "host" }
  | { readonly kind: "session"; readonly sessionId: Id }
  | { readonly kind: "run"; readonly sessionId: Id; readonly runId: Id }
  | { readonly kind: "plugin"; readonly pluginId: Id };
interface HostEventBase {
  readonly kind: "host-event";
  readonly protocolVersion: "1";
  readonly hostInstanceId: Id;
  readonly streamId: Id;
  readonly sequence: Sequence;
  readonly scope: EventScope;
}
```

HostEvent 为 base + 下表 type/payload 的判别联合。scope ID 必须与 payload 中相应 ID 一致。sequence 属单个 stream，**不是 Session seq、不是 run step、不是 request count**。

| type | scope | payload | 语义 |
| --- | --- | --- | --- |
| `session.created` | session | `{ session: SessionSnapshot }` | 一次新建后的空 canonical 目录记录 |
| `run.updated` | run | `{ run: ActiveRunSnapshot }` | accepted/running、首次 turnId 绑定、cancelRequested 改变；只允许非 terminal RunSnapshot |
| `run.output.delta` | run | `{ itemId: Id, text: string }` | 追加 live 文本；首次 itemId 创建 text item，不声称 message-start |
| `run.tool.call` | run | `{ item: LiveToolItem }` | result 必须 null；完整 input，表示 Core 报告调用，不表示已批准/一定已执行 |
| `run.tool.result` | run | `{ invocationId: Id, ok: boolean, content: string }` | 填入已知 live 工具项；不从 ok 推导是否执行过 |
| `run.ended` | run | `{ run: TerminalRunSnapshot, session: SessionSnapshot }` | 唯一 terminal/canonical 原子发布；run.live=null、session.activeRunId=null |
| `plugin.updated` | plugin | `{ plugin: PluginSummary }` | Host 调用 Manager 观察到的状态/安全失败快照 |
| `host.request.cancelled` | host | `{ requestId: Id, reason: "cancelled" | "timeout" }` | 当前 stream 下 reverse request 的控制取消；不是 run cancel |

ActiveRunSnapshot、TerminalRunSnapshot、LiveToolItem 是 §7 已有 union 的精确子集，不是另一套状态模型。

run.updated 中 live 为当时完整 live 快照；Client 替换该 run 快照，不重复追加已经包含的文本。收到 accepted/running 的 run.updated 时，Client 在同一个 store 更新中设置对应 session.activeRunId=runId；run.ended 则使用 payload.session 清除它。Session 必须已由 snapshot/session.created 建立，不能凭空补建。正常文本/工具变化使用 delta 事件；不为每 token 发全量 Session。

同一 run 的事件必须先有 accepted run.updated（或 snapshot 中已有 run），再有 running，之后才有内容事件。runId/sessionId/turnId 绑定及 LiveItem 身份须前后一致；result 只能填入当前未完成的工具 occurrence。重复 callId 即使出现在同一个 turn/同一步也不得覆盖、去重或少展示一次；invocationId 才是 UI 工具主键。

Host 只保证它确实观察到的插件状态：调用 Manager 后读取一次可见快照，Promise settle 后无论成功失败再读取最终快照。每次观察到公开内容变化（包括 status 不变但 lastFailure 改变），都更新 Host store 并发送 plugin.updated；比较字段内容，不凭每次 get 新建对象的引用判断变化。snapshot 与持续订阅必须来自同一已发布 store。

异步 activate/cleanup 期间可以观察到 enabling/disabling；同步 enable 可能直接观察到 enabled。不得伪造未观察到的中间状态，也不得包装同步 activate 为异步或修改 Manager 以增加事件总线。

v1 没有 message-start/end、model-step、tool-argument-delta、reasoning、usage、artifact、STATE_PATCH。也不发假的 persistence saved 事件。connection open/close 属 transport 本地状态，不伪装成 Host 已发送的完成事件。

收到未知 HostEvent type、scope/payload冲突或 schema非法：Client 不能猜测状态，标为 protocol error 并断开；只有普通 sequence gap 走重新同步，不对永久 schema不兼容无限重试。

## 10. Run Model 与提交去重

### 10.1 状态机

```text
accepted → running → completed
                   → limited       (Core max_steps)
                   → cancelled     (Core cancelled)
                   → failed        (Core error / Host execution failure)
accepted → failed                  (尚未开始 Core 的 Host 故障)
```

- accepted：输入合法、submission 去重记录和 run 记录已原子建立、registry execution ownership 已保留；不是等待队列。
- running：Host 开始并持续消费 Runtime.stream。Core turnId 可能尚不可得，允许 null。
- completed/limited/cancelled/failed 是不可逆 terminal。limited 必须独立于成功，不能把 max_steps 显示成完成回答。
- cancelRequested 是独立事实，不引入假 paused/stopping 状态。cancelRequested=true 仍可能最终 completed，不能覆盖 Core 的真实结局。
- accepted 后收到取消：先设置 signal；仍通过 Runtime 的预取消路径记录并 settle，正常进入 running→cancelled，不在 Host 私自伪造 Core turn。
- terminal 以 stream真正结束/settle为前提，不能仅在收到 turn/end 时释放 ownership。Runtime 可能在 end yield 后尚需退出 drain。
- runs.start 成功响应可为 accepted，或因重复提交/时序返回更晚状态；客户端不得要求响应永远是 accepted。

### 10.2 三种身份与 start response loss

- submissionId：Client 为一次明确用户提交生成；在一个 Host instance 内全局唯一，用于同一次提交去重。
- runId：Host 在接受时生成，作为取消、状态和事件的公开执行身份。
- turnId：Core 生成，Host 只观察并映射；未开始/早期故障可为 null。

runs.start 的原子接受规则：

1. 验证连接版本、instance、schema。
2. 查 submissionId：已存在且 sessionId/text 逐字相同，返回同一 run 当前快照；即使 Host 当前 busy 也返回已有 run，不重新执行。
3. 同 submissionId 但 sessionId/text 不同，SUBMISSION_CONFLICT；不改变原 run。
4. 未存在时检查 Session ready 和 registry gate。
5. 同一临界区内保留 gate、建立 run/dedup 记录、设置 session.activeRunId，并发布 accepted 状态；之后才启动异步执行。

被 INVALID_REQUEST/SESSION_NOT_FOUND/SESSION_UNAVAILABLE/HOST_BUSY 拒绝的请求不保留 submissionId。已接受后即使 Host 开始执行失败，dedup 记录仍保留。

Run/dedup 记录保留到 Host 销毁，v1 无 TTL 淘汰。相同请求并发竞争也只能建立一个 run。Client 不自动重发写操作；启动响应丢失后：

- 新连接 describe，确认相同 hostInstanceId；通过 subscriptions snapshot 或 runs.get(submissionId)查询。
- 找到则关联原 run；未知时可由用户明确决定重新提交，复用原 submissionId 的相同请求仍受去重保护。
- instance 改变：旧执行 outcome unknown，不自动用旧 submissionId 在新 Host 开新 run。
- 不承诺进程崩溃后的 exactly-once，也不声称断线期间没有外部副作用。

### 10.3 Host 并发政策

v1 一个 Host 最多一个 active run（accepted/running），共享 registry mutation 与执行互斥。插件 enable/disable 与 run start 竞争时 busy → reject，无 FIFO、自动等候、取消旧 run 或 drain coordinator。

plugin operation 从进入 Manager 前到其 Promise settle 后持有 mutation ownership。v1 为简化，其他插件 mutation 也拒绝并发。包括目标已 enabled/disabled 的 no-op 请求：Host busy 时仍拒绝，idle 时再应用 Manager 的 no-op 规则。

读操作、cancel、ClientResponse、订阅生命周期不等待该 gate。反向回应不能被等待该回应的 run 阻塞。

这是 Host implementation limit，通过 maxActiveRuns=1 公布；不是 Protocol 永远只允许一个 run 的架构 LAW。未来增加并发必须继续满足共享 registry idle 契约，不能借更改 limit 绕过协调。

### 10.4 取消

Host 每 run 持有一个 AbortController，signal 传给当前 Runtime 执行，不包装替换 Core 向 Model/Tool 共享的 signal。

runs.cancel 对 active run：cancelRequested 置 true，调用 abort，发布 run.updated 并返回当前快照；不等待工具结束才回 RPC。重复 cancel 不重复启动任何执行。terminal run 上 cancel 返回原终态，不追改 cancelRequested。

调用 abort 后，直到 Core/Tool 真正 settle 前仍保留 gate。若工具忽略 signal 且不 settle，Host 必须继续报告 active/busy；不能 timeout 后谎报 stopped。客户端断线、取消订阅、页面卸载不触发 abort。

真正 run.ended 原因来自 Core outcome；已完成工具副作用不回滚。取消与自然完成竞争允许 cancelled 或 completed，以实际 outcome 为准，而不是以 UI 点击先后猜测。

### 10.5 Host/投影故障

普通 Core error/cancel/max_steps 仍可具有合法闭合日志，正常发布 canonical。Protocol/网络投递失败不改变 run outcome，Host继续独立 drain。

若 Runtime.stream 抛出、缺 terminal，或 Host 无法验证/投影该 run 的闭合日志：

- 等执行真正 settle 后才释放 gate；run failed/endReason=host_error，返回安全 INTERNAL_ERROR。
- Session 标记 blocked，保留此前已发布 canonical，不把未知半日志包装成完整消息。
- run.ended 原子发布 blocked Session 与失败 Run；用户可创建新 Session，但不能自动在该 Session 再运行或修复其日志。
- 不改变 Tool 输入、篡改 Session、补写假的工具结果或吞掉故障。内部非 JSON输入本身不是此故障，应走 DisplayInput unavailable。

这是一条异常防线，不是持久化恢复系统。SessionStore 不加入 Runtime依赖；v1 无磁盘 flush 成功承诺。

## 11. JSON-safe Projection 与敏感数据

### 11.1 Client → Host

完整帧 JSON parse 后按方法 schema校验；非法输入拒绝。不能把字符串自动转数字、把非法对象归一化成另一请求或省略必须字段后继续执行。请求只能使用 §8 明确形状。

### 11.2 Internal → Client

Host 在观察/发布时构造自己的安全 DTO，不能把可变 nested input 引用放进队列。DisplayInput：

- 可完整保真为 JsonValue时，取独立深快照并输出 kind=json。
- 存在非 JSON值、循环、稀疏数组、accessor/自定义实例或读取失败时，整个该输入输出 kind=unavailable，不部分删字段、不改成 null、不调用用户 toJSON。
- 不调用真实 Tool 两次，不包装/替换传给真实 Tool 的 input，不因展示失败改变工具执行结果。
- Core 本来只做浅隔离，因此 live 与稍后 canonical 对 nested input 的观察可能不同；Protocol仅承诺每份已发布 DTO 不再随原对象变化，不补造 Core 没有保证的历史深隔离。

Tool.result.content 已是字符串，按文本透传，不解析它重建 arbitrary rich result。PluginInfo 仅抽取 §7 字段；原始失败消息和 cleanupErrors 只转成安全提示与计数。

### 11.3 安全错误

Host 使用固定、可审计的错误映射；原始 provider/plugin异常、stack、API key不进入 ProtocolError、Run.error 或 PluginFailureSummary。无法确定安全时给概括错误，不以“尝试过正则脱敏”宣称安全。

合法 Tool 正文与插件文本可能主动包含敏感数据；Host 不宣称能识别任意秘密。受信任插件/adapter不得把凭据当正常输出；Shell不把正文作为 HTML/JS执行。凭据不进入模型参数、session目录或 host.describe。

## 12. Snapshot、Stream 与 Resync

### 12.1 Snapshot 类型

```ts
interface Watermark {
  readonly streamId: Id;
  readonly sequence: Sequence;
}
interface HostSnapshot {
  readonly hostInstanceId: Id;
  readonly watermark: Watermark;
  readonly sessions: readonly SessionSnapshot[];
  readonly runs: readonly RunSnapshot[];
  readonly plugins: readonly PluginSummary[];
}
interface ConversationPresentationSnapshot {
  readonly session: SessionSnapshot;
  readonly activeRun: RunSnapshot | null;
}
```

HostSnapshot 是订阅初始化所需的完整当前视图，不是事件历史。v1 使用全量内存目录，无分页/过滤/磁盘回放。Session数组按创建顺序、Run按接受顺序、Plugin按注册顺序。

ConversationPresentationSnapshot 是 Client的派生只读视图，不单独传输；activeRun必须与 session.activeRunId一致，否则属于协议/同步错误。用户输入在 active run视图显示；terminal correction后从canonical user显示，不保留双份气泡。

### 12.2 Initial subscribe 原子边界

每逻辑连接至多一个活动 subscription。subscriptions.open执行一个不可被业务状态更新插入的 cut：

1. 为本连接生成新的、永不复用的 streamId；旧订阅失效。
2. 在同一 cut 中捕获完整 HostSnapshot，watermark={新 streamId, sequence:0}。
3. cut之后所有订阅可见事件从 sequence=1连续发送；打开前事实只在 snapshot中。
4. HostResponse(snapshot)必须在新stream任一HostEvent/HostRequest之前交付给Client。Transport binding对多物理通道暂存/排序，不能把这个race丢给React。

每次open都返回新stream及新snapshot，不恢复旧sequence。replacement取消旧stream pending reverse requests，不取消run。snapshot/事件均由Host自身已有presentation状态构造，不能读到半个run.ended。

### 12.3 Sequence 与水位

- sequence在单个stream内从1严格递增，每个HostEvent加1；response和HostRequest不消耗事件序号。
- 同一Host事实发送到不同connection可以有不同stream/sequence；没有全局持久事件编号承诺。
- snapshot.watermark是其覆盖边界；Client只应用此stream且sequence大于watermark的事件。
- Client expected=lastApplied+1；等于则应用；小于等于则视为重复丢弃；大于则gap，不应用该事件或猜测缺失内容，进入resync。
- 旧stream事件/反向请求全部丢弃，不因其sequence较大接受；stale close也不能关闭新stream。
- 同一stream重发同sequence必须是同一消息；binding不得让不同payload共用sequence。

### 12.4 Reconnect / gap / backpressure

连接丢失时保留最后presentation供展示，但标记 stale/connection lost，不能显示run已完成。重新connect：describe→确认instance→open新stream全量替换→再消费增量。

gap 时同连接重新 open；Client 同一时刻至多一个 open/resync 进行中，调用者的并发刷新请求合并到这个进行中的同步操作，不并发发出第二个 open。安装 snapshot 是 open response 的专用行为，不受 §12.5 普通 response 不覆写 store 的限制。

Client 每次 connect 使用新的本地 connection epoch；旧连接的迟到 response/onClose/listener 回调不得影响新连接。epoch 是本地生命周期标签，不进入 wire。打开期间不应用旧 stream 事件；新 snapshot 覆盖它们。发生第二次连接故障则结束该次尝试，不无限后台循环。

v1可提供用户触发reconnect/resync；不要求自动指数退避系统。若实现自动重试，仅限连接、describe、open及只读请求，且必须有明确终止；写操作绝不自动重发。

Host独立保留active run当前live timeline，所以同instance重连可获得已累积live前缀，不靠完整event replay。terminal不保留draft；新instance不恢复旧内存。若binding缓冲超限，关闭受影响connection，Clientresync；不得静默跳过事件保持假连续。

### 12.5 Terminal canonical correction 与 response竞争

Host run.ended 在同一逻辑事务中：验证canonical→更新Session activeRunId/status/canonical→设置Run terminal/live=null→发布合并事件。Client应用一个不可变更新，一次性替换canonical、移除draft与更新run，不显示旧draft加新history两份内容。

正常Core失败/取消只删除未记录部分，不删除此前已发布turn。显示“未完成文本不在历史中”不能暗示工具未执行。

只有 subscriptions.open snapshot和HostEvent驱动Client共享presentation store。sessions.get/runs.get/plugins.list及mutation responses返回调用者，但不能直接覆写event store；它们可能比已消费事件旧。需要刷新展示时open/resync，不使用response到达顺序猜新旧。

本节不提供durable event broker、跨重启replay、任意cursor恢复或客户端日志权威。

## 13. Reverse Request Seam

### 13.1 v1边界

HostRequest → ClientResponse是通信机制，不是通用远程执行权限。production reverse-method注册表为空；不导出 `test.ping`、approval、form、OAuth、picker等产品方法或capability。测试可在内部注入一个严格schema的test-only profile验证同一dispatcher，不使用绕过validation的后门。

Envelope.method/params是请求机制所需的名字和JsonValue容器；实际处理必须匹配已注册profile的具体schema。不得把它变成public `executeAnything(method, unknown)`，或用任意额外参数绕过v1operation集合。

### 13.2 基础生命周期

- Host只能在已describe、双方reverseRequests=true、已有活动stream的connection发请求。
- HostRequest含instance/stream/requestId、method、params、正safe integer timeoutMs；deadline由Host本地时钟执行，不信任Client时钟。
- Host在发送前建立pending，按(connection,streamId,requestId)关联。requestId本方向本连接不复用。
- Client先验证envelope；未知method立即回METHOD_NOT_FOUND；已知test profile校验params/result。不得未知就沉默或默认批准。
- ClientResponse必须匹配当前connection、instance、stream和pending request。另一connection不能答复；重复/迟到response不再次resolve、不产生业务副作用。
- Host resolve/reject pending最多一次；从pending移除先于回调，避免重入再次消费。
- Host主动取消或timeout：移除pending、结束Host等待；活动stream发host.request.cancelled。Client终止handler的本地AbortSignal，不再发成功响应；已在途response被Host忽略。
- timeoutMs控制通信等待，不是工具执行timeout。测试handler必须观察abort；无业务动作可被“等待超时”暗中批准。
- connection close、stream close/replacement、Host dispose取消该scope全部pending，并清理Client handlers。没有可送达stream时不要求发cancel事件。
- reverse request不自动跨重连重发、不存入Session、不持久化。新stream未知的旧request不得恢复。

未来引入HITL时另定义interaction/execution身份、授权人、一次性决定、跨连接恢复和执行gate；不得把本节requestId冒充durable interactionId。收到tool/call后审批无法阻止当前Core执行，未来gate必须在真实Tool执行之前。

## 14. Host Contract

### 14.1 Composition

建议冻结的最小host-internal依赖形状：

```ts
interface HostOptions {
  readonly modelClient: ModelClient;
  readonly contextBuilder?: ContextBuilder;
  readonly plugins: readonly Plugin[];
  readonly grants?: Readonly<Record<string, readonly PluginPermission[]>>;
  readonly storage?: (pluginId: string) => PluginStorage;
}
```

ModelClient/ContextBuilder取自Core，Plugin相关类型取自Plugin System；这些只属于host包，不进入protocol。缺省ContextBuilder为既有createDefaultContextBuilder；需要system prompt时由composition构造并注入。

Host建立一个ToolRegistry、对应PluginManager、使用同registry的Loop和Runtime，避免注入两个不一致registry。启动时只register所给可信插件，默认disabled；不动态扫描/安装模块。配置错误使Host构造失败，不能对外宣告已ready。

ModelClient由外部composition构造，可使用model-pi-ai或其他实现。Host不接受wire API key、不读取provider环境变量、不import pi-ai。storage仍遵守Phase2scoped view约定；是否持久化由注入者负责，v1无storage产品后端承诺。

### 14.2 Ownership

Host拥有：

- session目录及真正Session对象；一sessionId映射一个权威对象。
- run/dedup目录、AbortControllers、runId→turnId关联。
- registry/PluginManager和唯一coordination gate。
- 已发布canonical及active live投影、协议connections/subscriptions。
- reverse pending通信状态和安全错误映射。

Host业务处理层仅接收Protocol数据及内部ports，不拿HTTPRequest/WebSocket/Tauri handle。外部不能持有裸registry并绕过gate执行或改工具。v1不提供direct execution API。

### 14.3 Client-independent consumption

接受 run 后由 Host 后台任务持续 drain Runtime.stream，无论是否存在订阅。状态提交与 drain 不等待网络交付或客户端 ACK；send 只入有界本地队列。网络 send 异常只关闭该连接，不能抛入 Loop 或停止 drain；不得用一个浏览器的 for-await 作为 run 唯一驱动者。

若内部 live 投影/验证发生不可恢复错误，先记下 Host fault，停止发布不可信增量，但仍 drain 该 iterator 到真正 settle，再按 §10.5 发布 failed/blocked；不能因 mapper 抛错提前退出 for-await、误释放 gate。若 iterator 自身抛出，它已经结束；仍不得伪造 Core turn/end。

Host 根据流建立 live 视图，执行 settle 后从该 Session 实际日志构造 canonical。不要在 Client 重建事实日志，也不为 UI 给 Core 新增事件类型。

### 14.4 Host生命周期

Host shutdown 先拒绝新写操作、关闭 connections/取消 reverse pending，并对 active run 请求 abort。必须等待所有已获得 execution 或 mutation ownership 的任务真正 settle，包括已经接受的异步 enable/disable；连接关闭不能终止 activation。之后才串行 disable/cleanup 插件，shutdown 自身的清理不得与先前 mutation 并发。

不得在 run 未停或 lifecycle 未结束时清理 registry，也不得超时后声称全部资源已释放。永不 settle 的 activation/cleanup 会阻止 shutdown 完成，不能通过 force reset 绕开 Manager。清理失败由 Host 生命周期调用者收到安全失败；对其他可清理插件继续尽力清理，不谎报失败资源已释放。

Web binding可能需要进程信号处理，但不将SIGTERM/HTTP关闭语义写入Core。v1不承诺崩溃恢复或强杀安全。

## 15. Transport Contract

### 15.1 最小port

以下结构化类型由protocol定义或公开为其transport-neutral子模块，不携带网络实现；Host/Client共用，不新增transport包。

```ts
interface ProtocolChannelListener {
  onFrame(frame: string): void;
  onClose(): void;
}
interface ProtocolChannel {
  send(frame: string): void;
  listen(listener: ProtocolChannelListener): () => void;
  close(): void;
}
```

- channel交给Host/Client时已建立；连接建立失败由应用connect Promise表达，不假造HostResponse。
- 完整一帧一个JSON message，双向承载全部五类消息。send仅表示接受到有界本地发送队列，不表示远端已收到/业务完成。
- 单方向按send顺序交付；同一逻辑连接的多物理通道必须恢复此顺序。错误、无法入队、连接关闭时send同步失败并走close生命周期，不能静默丢弃。
- listener在发送任何协议消息前安装，每channel仅一个活动listener；事件不得在安装前丢失。listen返回值只移除listener，所有者销毁连接还须close。
- onClose最多一次；close幂等。失效连接不得把消息注入替代连接。网络层重复投递仍由request/stream identity规则防护。
- codec/validation在Host/Client入站处执行；即使in-memory fixture也必须走JSON stringify/parse，不能共享内部对象引用。
- 无HTTP status、SSE event name、WS opcode、stdio进程或原生文件句柄进入Protocol DTO。

### 15.2 具体binding

P3.3选择一个Web binding并在其Plan记录transport特有的origin/auth、连接关联、缓冲、帧限额、关闭和初始snapshot fence处理。HTTP+SSE、single WebSocket均可；不是Protocol长期LAW。

HTTP+SSE可将ClientRequest/ClientResponse通过上行HTTP送达，HostResponse/HostEvent/HostRequest通过适当下行路径送达。两物理通道须归属同一logical connection并满足§12.2，不能只实现Client command→Host event就声称reverse支持。

stdio/IPC可以实现同一port；v1不要求交付Tauri。native structured clone支持更多值不能扩宽Protocol JSON边界。测试至少两个carrier：强制JSON roundtrip的内存fixture与所选Web binding。

## 16. Client Contract

### 16.1 职责与最小表面

React-free client接受 `connect: () => Promise<ProtocolChannel>`，提供：

- connect/reconnect、disconnect与本地connection状态。
- §8 operation map约束的typed request Promise；不公开随意调用Host内部函数。
- response correlation、入站schema验证、event subscription。
- reverse request基础dispatcher、unknown拒绝、pending handler abort。
- describe→open初始化、gap/resync、stale stream拒收。
- live fold、terminal canonical correction。
- `getSnapshot()` + `subscribe(listener): disposer` 的不可变presentation读取；React适配只在apps/web。

本地 connection 状态至少区分 disconnected、connecting、connected、syncing、ready、lost、protocol-error。connected 表示通道在线但没有有效订阅，syncing 表示 describe/open/resync 进行中；ready 须已安装有效 snapshot，不能仅 WebSocket open 就称同步完成。没有有效 snapshot 时 getSnapshot 可为空；旧 snapshot 展示时必须标 stale。

发送针对本地当前 stream 的 subscriptions.close 时，Client 立即撤销该 stream 的可应用状态、清理该 scope 的 reverse handlers、保留但标 stale 的 snapshot，并退出 ready。连接仍在线且无新 open 时为 connected；close 响应无论 closed=true/false 都不恢复旧流，失败或响应丢失也不能继续宣称同步。后续 open 成功才能恢复 ready。针对旧 stream 的 close 及其迟到响应不得影响已经安装的新 stream。

Client snapshot由validated JSON数据构造并深隔离；调用方修改返回对象不得改变client状态。无状态变化时保留稳定snapshot引用，有变化一次发布完整一致快照，不让React看到半个terminal修正。

### 16.2 非职责

Client不得执行Agent/Tool、修改Core Session、判定插件权限、保存provider credentials、实现模型重试、猜测丢失事件、批准未知reverse request。用户新提交才生成新submissionId；网络重连不是新用户提交。

Client不自动retry runs.start、sessions.create、plugins.enable/disable，取消幂等也不应变成隐式取消所有旧run。单次调用者放弃等待不等于Host操作撤销。连接恢复先读状态，不直接重发pending命令。

## 17. Generic Shell Contract

Shell只通过Client；不得import host/core/plugin-system/provider或绕过Client直接调用transport接口。

Phase3最小UI：

- **Chat**：输入、提交、live文本、canonical历史、工具call/result、取消、终态提示。
- **Sessions**：list/create/select；无重命名、删除、历史编辑等额外功能。
- **Plugins**：列表、描述、状态、enable/disable、安全失败提示。error状态不提供假的reset/retry按钮。
- **Host/connection status**：instance、连接/同步/断线状态、busy限制；明确内存历史不保证重启保留。
- **Generic cards**：工具名、完整JSON或unavailable输入、结果文本和ok状态；不依赖calculator特例。

UI可为busy禁用按钮，但Host必须独立执法。cancel发送后显示“已请求取消”，收到terminal才显示“已停止/已结束”。启动响应丢失显示待确认，不自动再跑。断线不清除run为completed。同步后的partial消失应有失败/取消提示，不能暗示外部操作回滚。

Settings没有真实API需求则不提供伪页面。无business-specific page、Plugin React dependency、dynamic renderer、slot、iframe runtime。正文作为文本/安全格式呈现，不能执行HTML/JS。

## 18. Extension Taxonomy 与生态seam

| 类别 | 阶段 | 契约 |
| --- | --- | --- |
| Runtime Plugin | NOW | 保持Phase2Plugin/Manager，不新增通用服务查找 |
| Model Adapter | NOW | 既有ModelClient，provider-neutral |
| Host Capability | NOW / SEAM ONLY | 已有storage；未来真实实现才增加受控能力 |
| Agent Strategy | SEAM ONLY | 尊重现有Loop/ContextBuilder注入，不建StrategyManager |
| Protocol Adapter | SEAM ONLY | 将来AG-UI/MCP adapter独立映射，不影响内部Session authority |
| UI Extension | FUTURE | tool + optional presentation/resource；fallback始终可用 |

v1不建立一个包容所有类别的Plugin interface，也不新增万能字段。Tool结果已文本化；未来structured rich result必须另定义真实数据来源，不从字符串假装无损恢复。

AG-UI映射可把完整参数编码为一个args块，但不能声称原生argument delta或message boundary；其interrupt/resume不等于当前Core同turn等待。MCP能力/Apps资源契约不是Every控制面。具体互操作版本、授权与资源隔离在真正接入时另立范围。

## 19. Architecture Acceptance Tests

以下是必须交付的行为证据，不以文件存在或类型能编译替代。Fake、stubbed provider与真实LLM结果分别记账。

### A. Second Runtime Plugin

增加与calculator不同的最小测试Plugin（如文本统计）。只允许增加fixture及Hostcomposition注册，不修改Core/Protocol/Client/Shell。断言plugin自动列出、enable后真实工具被Agent调用、call/result由genericcard显示、disable后新request无schema且registry不再提供工具。不能只验最终文本。

### B. Second Client

无React CLI fixture通过同Protocol执行describe、session创建/读取、run、工具结果、取消及状态查询；不修改AgentRuntime。它是验收fixture，不扩建完整CLI产品。

### C. Replace ModelClient

至少两种不同实现形状的ModelClient注入同Host，UI/Protocol不改；保留既有model-pi-ai测试。离线contract证明与凭据授权下真实providerE2E分开，未运行不得记PASS。

### F. Registry Race

deferred Model/Tool与deferred plugin lifecycle制造并发：run start vs enable/disable；只有合法一方取得gate，另一方立即HOST_BUSY。验证accepted即占用、abort尚未settle仍占用、cleanup未结束不能新run、no-op也遵守Host政策。读/cancel/reverse response不能被执行gate阻塞。

### G. Draft / Canonical

模型输出partial后失败/取消；Client确实先显示live，terminal原子移除未记录部分并保留真正canonical；多tool与多step不重复卡片；max_steps显示limited；旧response不能覆写较新event。不得修改Core测试预期以迁就UI。

### H. Response Loss / Reconnect

接受runs.start后丢响应、断开、同instance重连；按submissionId找回原run，显式相同重复提交仍仅执行一次，不同payload为CONFLICT。并发重复提交只建一个run。新instance标旧outcomeunknown且不自动执行。重复/旧stream事件、gap、snapshot/follow竞态、slow channel溢出也必须覆盖；断线不取消run。

### I. Version / Capability / Validation

不支持代际明确拒绝且无自动降级；未describe不能调用业务；旧hostInstance写请求被拒绝；缺capability不得发该类操作；未知可选字段与未知事件类型行为不同；response result/error互斥；response/params/schema错误不进入业务。无能力名称冒充权限。

### J. Non-JSON Projection / Safe Errors

注入undefined、bigint、NaN/Infinity/-0、function、循环、稀疏数组、Date/Map、accessor/toJSON等内部input；DisplayInput诚实json/unavailable，真实Tool收到原对象且执行次数不变。已发布DTO不受后续修改影响。模拟provider/plugin error含secret，公开error不泄漏；不宣称过滤任意Tool正文。

### K. Reverse Request Seam

test-only profile通过真实client dispatcher与至少内存/Web两种binding往返；校验关联、unknown method拒绝、schema失败、重复/迟到response、不同连接冒充、timeout、取消、disconnect、subscription replacement。确保pending清空且最多resolve一次。fixture方法不能出现在product public operation/capability中，不标完整HITL已实现。

### 其他必要边界

- Protocol/Core/Provider/React依赖LAW的静态检查，Web前端bundle不含Host/provider/secret模块。
- run.end之后stream尚未settle的故障注入；ownership不得提前释放。
- 恶意/损坏内部日志的Hostfailed+blocked策略，不吞异常、补造历史。
- Session/Run/Plugin 目录返回快照，不能通过 Client 对象修改 Host。
- 同一步、跨 step 重复 callId 与空 callId 的 projection fixture 均保留独立 invocation，不额外收紧 Core 字符串契约。
- deferred activation、deferred cleanup 与 shutdown 竞争：已接受 mutation 真正 settle 后才开始 shutdown cleanup。
- 显式 close 当前订阅后退出 ready；旧 stream 的迟到 close response 不影响新 stream。
- generic fallback 在所有实际 v1 工具上可用；未来实现 Rich UI 时必须补充 resource 缺失/失败仍 fallback 测试，不以本期未实现 Rich UI 冒充该互操作已验收。

## 20. Phase 3 Milestones

这些条目定义phase boundaries，不是逐文件实施步骤或批量执行授权。

### P3.1 — Protocol Contract

**Goal：** 将本文wire/同步语义变成独立、可校验契约。

**Deliverables：** protocol 包的 DTO/envelope、operation/event map、validator/codec、transport-neutral port；版本能力、error、JSON 与 response XOR fixtures；空的反向业务注册表与 test-only profile 边界。

**DoD：** 所有声明有 runtime 校验和合法/非法 fixture；sequence/ID/scope 语义可测试；无 Core/Plugin/React/provider 依赖；方法集与本文一致；既有 typecheck/offline 测试保持通过。不能用 unknown cast 或虚假 capability 占位。

**Forbidden Scope：** Host 执行、React、业务 HITL、完整 Web server、通用 RPC/codegen、修改 Phase 1/2 契约。

### P3.2 — Host Application Boundary

**Goal：** 组合已有Core/Plugin形成权威Host。

**Deliverables：** composition、Session/Run/dedup 目录、AbortController、registry gate、投影、安全错误、协议 dispatch、snapshot/subscription 与 Client-independent drain；先通过 JSON fixture 驱动。

**DoD：** F/G/H/J 对应 Host 层断言通过；启动响应丢失或重复提交不重复执行；正常与故障 terminal 闭合；cancel 不提前释放；snapshot cut 与 canonical 修正原子；Plugin 失败保持 Phase 2 语义；没有 provider/HTTP/React 耦合。

**Forbidden Scope：** 并发调度队列、持久化恢复、完整 HITL gate、动态安装、registry hot switching、修改 Core/Manager、硬依赖 pi-ai。

### P3.3 — Client Core + Transport Proof

**Goal：** 证明Client与carrier可替换。

**Deliverables：** React-free Client、immutable presentation、request/reverse correlation、snapshot/resync、CLI fixture；选择并实现一个 Web binding，明确其连接关联、安全、限额与 snapshot fence。

**DoD：** B/H/I/K 与两种 carrier 的一致性通过；客户端不会自动重复写操作；gap/stale/close 行为正确；reverse 真正双向可达且只有 test-only 业务；Web binding 决定写入对应 HANDOFF/局部设计事实，不改变 Protocol LAW。

**Forbidden Scope：** 完整 CLI 产品、多个 transport 包、Tauri、UI 插件框架、业务 approval/OAuth/picker/form、AG-UI/MCP 完整 adapter。

### P3.4 — Generic Web Shell

**Goal：** 无业务硬编码的通用Web展示。

**Deliverables：** Chat/Sessions/Plugins/Hostconnection状态与generictoolcards；Web构建配置及必要自动化验收。

**DoD：** Shell仅依赖Client；真实页面验证run、tool、cancel、busy、断线重连与pluginfailure；calculator与第二Plugin均无专用renderer；自动build/typecheck/tests及适用UI路径通过，人工验收只补自动化不能判断的事项。

**Forbidden Scope：** Settings/Credentials产品、业务页面、dynamicReactloader、slot/iframe/artifact、Core或PluginAPI修改。

### P3.5 — Platform Acceptance

**Goal：** 以替换与故障测试证明平台而非demo。

**Deliverables：** A/B/C/F/G/H/I/J/K证据矩阵、独立架构/实现审查、依赖检查、最终HANDOFF事实。

**DoD：** 无未关闭blocker；typecheck、现有与新增离线测试、Web检查结果单列；真实providerPASS/SKIP/NOTRUN如实记录且需授权；文档/实现/能力声明一致；finaldiff无无关修改。完整HITL/RichUI等non-goal不得宣称交付。

**Forbidden Scope：** 借审计扩功能、弱化测试、自动真实provider调用、自动封存/commit/push。

## 21. Explicit Non-goals

Phase 3 不做：

- Cordis client tree、dynamic React plugin loader、slot framework。
- MCP Apps iframe runtime、artifact framework、完整 AG-UI/MCP/MCP Apps 兼容。
- protobuf/codegen platform、plugin daemon、marketplace、remote install。
- hot reload、generation routing、multi-agent/subagent、workflow/editor。
- durable pause/resume、cross-restart exactly-once、磁盘事件 broker、跨重启 replay。
- credential vault/OAuth 产品、不可信插件 sandbox。

不新增通用 service lookup、万能 unknown 扩展字段、空抽象包、设置框架、schema form 引擎或虚假的 checkpoint。Phase 3 运行内存状态在 Host 重启后丢失，Shell 必须诚实说明。

## 22. Verification、变更纪律与后续入口

SPEC 冻结不等于 implementation 授权；不得据此创建 production package、修改 Phase 1/2 contract 或跳过后续 Plan 审批。文档提交与推送按独立人工授权执行。

后续每milestone先形成限定路径与验收范围的Plan，经批准后实施；遇到以下情形必须返回架构裁决：需要改变Phase1/2冻结契约、新productiondependency、与本文状态/同步语义冲突、必须扩大non-goal、必须删改既有测试才能通过。

验证以实际命令/断言记账：原217条离线通过是Phase2历史证据，不是Phase3实测；真实provider未授权不自动调用，不读取/打印凭据。新增Web后必须执行实际存在的build/typecheck/tests和关键UI路径；不存在脚本不得虚报。

下一入口：**P3.1 Master Plan**。本文不授权该Plan实施或后续Git操作。
