# Phase 1 Agent Core — Handoff

> 用途：跨工作窗口（Zcode / Claude Code）恢复上下文。
> 只记录「截至当前 code baseline，Phase 1 实际已经完成什么、什么已冻结、什么被延迟、下一步从哪继续」。
> 它不是 SPEC、不是 Plan / Review 存档、不是 changelog、不是教程。
> 维护方式见文末 **Maintenance Rule**。

---

## 1. Current Status

| 项 | 值 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Code baseline | `42fdec9b57e7a0f52f65393927c2205dc61afffd` — `feat(core): add session persistence and calculator e2e` |
| Remote | `origin/rewrite/runtime-lite`；code baseline 已 push |
| 当前 milestone | P1.5 ✅ 代码已完成、已提交 |
| **Phase 1 状态** | **PARTIAL** —— 唯一未满足项是**一次成功的真实补全**（§7） |
| 下一个 milestone | 先用有效凭据跑通真实 E2E；之后才是 Phase 2 Plugin Contract + PluginManager |
| Tests | **129 passed / 2 skipped / 15 files**（`pnpm test`；2 个 skipped 是真实 provider 用例，见 §7） |
| Typecheck | **0 错**（`pnpm typecheck`） |
| Production LOC | `packages/agent-core/src/` 16 文件 / **1572 行**（去空行、整行 `//` 与块注释后 932 行）—— 略过 SPEC §11 的 ~1500 目标，远低于 ~2500 警戒 |
| Real provider | **未通过**：真实端点可达，但本机凭据被 provider 判为 invalid（§7 有原文） |
| 工作区 | 除 `.zcode/` 与 `.zcodeignore`（untracked，**不得提交**）外，改动均已入库 |

```text
P1.1 Core Contracts        ✅  b96937d
P1.2 Minimal ReAct Loop    ✅  c24fe68
P1.3 Runtime Engineering   ✅  aece33e
P1.4 Real LLM              ✅  b193d51
P1.5 Persistence + E2E     ✅  42fdec9  ← code baseline（代码完成；真实 E2E 待凭据）
```

仓库形态：pnpm workspace，只有一个包 `packages/agent-core`。**无构建步骤**（`main` 指向 `src/index.ts`）、**无 CI**；运行时唯一依赖是 `@earendil-works/pi-ai@0.87.1`（ESM-only，`engines: node >=22.19`，根 `package.json` 的 engines 与 `packageManager` 已对齐），devDependencies 仅 `typescript` / `vitest` / `@types/node`。**该依赖很重**：连同 `openai`、`@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`typebox` 等，生产闭包 80+ 个包（本仓 `.pnpm` 共约 131 MB，其中 pi-ai 生产闭包约 60 MB，其余是 dev 树）。adapter 对 pi-ai 只用 `import type`，所以 **Core 自己的模块图**运行时不会加载其中任何一个（构造 adapter 的宿主当然用的是真 pi-ai）。模块路径导入一律带 `.js` 后缀。

> SPEC 的实际文件名是 `docs/PHASE1_AGENT_CORE_SPEC .md` —— `SPEC` 与 `.md` 之间**有一个空格**，按此路径打开。

---

## 2. Architecture Snapshot

**组装方向**（启动时，谁构造谁）——只有 composition root 知道全部依赖：

```text
composition root (host / test)
  ├── createSession(id) / restoreSession(id, events)
  ├── createMemorySessionStore() ──create / load / append      ← 宿主侧，Core 不依赖
  ├── createToolRegistry()  ──register(tool) ── e.g. createCalculatorTool()
  ├── createDefaultContextBuilder(systemPrompt?)
  ├── createPiAiModelClient({ models, model, apiKey?, maxTokens?, timeoutMs? })   ← ModelClient
  ├── createAgentLoop({ modelClient, tools, contextBuilder })
  └── createAgentRuntime({ loop })            ← Runtime 不构造 Loop，也不构造 ModelClient
```

**运行期调用方向**（一个 turn 内，谁调用谁）：

```text
AgentRuntime.run(input)  ──┐
                           ├─> driveTurn()   写 turn/start, message/user, turn/end
AgentRuntime.stream(input) ┘                 生成 turnId 与 RuntimeContext
  │                                          把 Loop 事件盖成 RuntimeEvent 信封
  └──> AgentLoop.runTurn({ session, turnId, context, emit })
         ├──> ContextBuilder.build({ session, tools, context }) ──> ModelRequest
         ├──> ModelClient.stream(request, context) ──> ModelEvent*
         │      └─ 具体实现：PiAiModelClient ──> pi-ai Models.stream ──> provider HTTP
         ├──> ToolRegistry.execute(name, input, context) ──> ToolExecutionResult
         └──> Session.append(...)   写 message/assistant, tool/call, tool/result
```

关键点：**Loop 从不读日志**（不调 `session.events()`）。每一步都重新经 ContextBuilder 从 Session 派生 request，日志是唯一事实来源。模型输入的构造路径只有 ContextBuilder 一条，`run()` 与 `stream()` 共用同一条 `driveTurn()`。**Core / Loop 里没有任何 provider 分支**：OpenAI-compatible 与 Anthropic 的差异全部由 pi-ai 在 adapter 之下处理（adapter 自己会按设计写入 pi-ai 要求的 `api` / `provider` / `model` 元数据）。

---

## 3. Completed Milestones

### P1.1 Core Contracts

八个契约已定稿并实现（`RuntimeContext` / `RuntimeEvent` / `SessionEvent` / `Session` / `Tool` / `ToolRegistry` / `ModelClient` / `ContextBuilder`），细节即 §4 的对应条目与 §5 的签名。

### P1.2 Minimal ReAct Loop

DoD 链路跑通（User → Model → Tool → Result → Model → Final Answer）；`FakeModelClient` / `EchoTool` 在 `tests/helpers/`。

### P1.3 Runtime Engineering

`AgentLoop` 拿到步预算、模型重试、取消检查点与事件发射；`AgentRuntime` 的 `run()` / `stream()` 共用 `driveTurn()`，并持有 turn 边界与 RuntimeEvent 信封。四种结局（`completed` / `max_steps` / `cancelled` / `error`）全部落地并被测试。

### P1.4 Real LLM

`PiAiModelClient`（`src/model/pi-ai-client.ts`）把 `ModelRequest` 翻译成 pi-ai 的 `Context`、把 pi-ai 的事件流翻译成 `ModelEvent`、把每一种失败翻译成 throw；是 `src/` 里唯一 import pi-ai 的文件（只用 `import type`）。OpenAI-compatible 与 Anthropic 两条 wire path 都不自己实现协议，而是交给 pi-ai 的 provider 层。

### P1.5 Persistence + E2E

`MemorySessionStore`（宿主侧，Core 不依赖）、`restoreSession`（无损恢复）、`createCalculatorTool`（Phase 1 唯一的真实 Tool）。确定性验证覆盖 faux provider 的 DoD 往返与持久化往返（含带 tool call 的 turn）；真实模型那一层在 `tests/real-provider.e2e.test.ts`，结果见 §7。

---

## 4. Frozen Design Decisions

后续窗口**不得**随意推翻：

**范围与形态**
1. **Single Agent**；ReAct only（无 Planner / Plan-and-Execute / ToT / Workflow）。
2. **Phase 1 实现不使用 Cordis**。SPEC 把 Cordis 定位为宿主生命周期基础设施，但当前没有任何 Cordis 依赖，组装是手写 composition root。接入属后续 Phase。
3. **Long-term memory 不属于 core**；若引入，优先做成 Tool / Plugin。

**职责切分**
4. **AgentRuntime = turn lifecycle**：生成 `turnId`、构造 `RuntimeContext`、写 `turn/start` / `message/user` / `turn/end`。`AgentRuntimeDeps = { loop: AgentLoop }`。
5. **AgentLoop = ReAct 编排**：写 `message/assistant` / `tool/call` / `tool/result`。它**不生成 turnId、不写 turn 边界事件**；`turnId` 只是入参。
6. **`turnId` 由 Runtime 生成**（`globalThis.crypto.randomUUID()`，不引 `node:crypto`）。
7. **`AgentLoopInput` 不包含用户文本**：用户输入只进入 `AgentRuntime.run({ text })`，Runtime 先记录 `message/user`，Loop 后续每个 step 通过 ContextBuilder 从 Session 派生上下文。
8. **Runtime 与 Model / Tool 共用一个 `RuntimeContext` 实例**：一次 `run()` 内所有 ModelClient 与 Tool 拿到的是同一个对象、同一个 `signal` 引用；调用方传入的 signal 实例被原样透传（不被包装或替换）。

**数据与隔离**
9. **Session 是 append-only event log**；`seq` / `time` 由 Session 生成，`turnId` 由调用方生成 —— 调用方不能自行指定或伪造 `seq` / `time`，事件的语义 append 顺序由 Runtime / Loop 保证。
10. **每个完成的 model step 恰好一条 `message/assistant`**（先落日志再判分支；空 text 的 tool step 也写一条）。**被取消或失败的 step 不写**。
11. **structural shallow isolation only**：`append` 单层浅拷贝 + `Object.freeze`；`deriveMessages` 的 assistant 分支新建数组 + 新建 `ToolCall` 对象。**`ToolCall.input` 保持原引用，不做 deep clone，不递归 deepFreeze**。
12. **`message/assistant` 事件自携带 `toolCalls`**，使 `deriveMessages()` 成为逐事件 1:1 映射；**`tool/call` 事件不产出任何投影消息**。

**模型与工具契约**
14. **`ModelEvent.tool-call` 是已拼装完整的成品**，不是增量 delta。provider 的 argument-delta 累积属于 ModelClient 实现内部（P1.4 由 pi-ai 完成）—— 这是 Loop 里没有任何 stream assembler 的原因。
15. **provider-specific assembler 不进 Loop**。
16. **`ModelEvent.done` = 当前 model step 的终止事件**：遇到即停止消费；**同时允许 AsyncIterable 自然结束也表示 step 完成**。实现必须用**带标签 break 真正退出 `for await`**：`modelStep: for await (...) { ... break modelStep; }`。**自然结束但无 text 且无 tool call 不算「完成」**，而是可重试的失败（见 #30）。
17. **ModelClient 失败一定是 throw / 迭代中途 reject**，绝不通过 `ModelEvent` 表达失败。取消与失败的区分靠 `context.signal.aborted`。
18. **Core-level retry 归 AgentLoop；adapter 不得实现 retry**（pi-ai 侧的请求层默认也不重试，见 #41）。
19. **ToolRegistry 只做 dispatch / catch / normalize**：不验证 schema、不做字符串化、不并行。
20. **P1.1 不做 schema validation**：`inputSchema: unknown`，P1.4 已裁决见 #39。
21. **Tool execution serial，且 tool/call → tool/result 逐调用交替**。
22. **`tool-call` 事件浅复制**（`toolCalls.push({ ...event.call })`）。
23. **`ToolRegistry.execute()` 对 Tool 执行路径不抛业务失败**：unknown tool / throw / 非 Error throw 统一规范化为 `{ ok: false, error }` 观察结果。**`register()` 等配置 API 的错误仍允许抛异常**。
24. **tool 结果 → 文本的转换只发生在 `agent-loop.ts` 的 `toolResultContent()`**：`!ok → error`；string → 原样；否则 `JSON.stringify(value, bigintAsString) ?? String(value)`；抛错 → `<unserializable tool result>`。必须是全函数。

**接口稳定性**
25. **`Tool.execute` 必须用方法签名**（双变检查），不能改成属性接函数类型。
26. **`AgentRuntime.run()` 的参数与返回类型名不变**；`TurnResult` 附加扩展为 `{ turnId, text, reason, error? }`；`AgentLoop.runTurn()` 返回 `Promise<TurnOutcome>`。
27. **`ToolSchema` 是独立类型**，不是 `Tool` 的子集。

**运行时纪律**
28. **`MAX_STEPS = 12` 是常量**。一次 step = 一次 model 调用 + 它请求的 tool 派发；预算在 model 调用之前检查；**abort 检查在预算检查之前**。
29. **`MAX_MODEL_ATTEMPTS = 3`**（1 次 + 2 次重试），重试不消耗 step 预算：单 turn 最多 12 × 3 = 36 次 provider 调用。
30. **重试条件只有一个：该次尝试尚未产出 text**。tool call 在 step 完成前既不入日志也不 emit，所以可以整体丢弃重试。**空输出算可重试失败**。
31. **abort 优先于 retry，也优先于 max_steps**；`signal.aborted` 是区分取消与模型失败的**唯一**依据。
32. **取消或失败发生在 step 中途时，该 step 的 `assistant/chunk` 只到过 stream，不进日志**。
33. **每个 `message/assistant.toolCalls` 之后、下一条 message 之前必须有对应 `tool/result`**：取消时未派发的 call 补记 `tool/call` + `tool/result{ ok: false, content: "tool not executed: the turn was cancelled" }`；`ToolRegistry.execute` 若违反契约抛错，由 `dispatchTool()` 兜成 `{ ok: false }`。
34. **turn 闭合双保险**：loop 内部兜底 + Runtime 的 `runLoop()` 再兜一层。两层的边界是 `Session.append` 本身。
35. **`turn/end` 记录 `TurnOutcome.error`（有则写）**，`SessionEvent` 与 `RuntimeEvent` 两个类型同时具备。
36. **`RuntimeEvent` 保持四种，不加 `assistant/message`**。
37. **`stream()` 的消费者提前 break 不 abort turn**：turn 继续跑到闭合；要中止必须 abort signal。
38. **`ToolResult.ok = false` 用于「未执行」**。

**P1.4 新增（provider 边界）**

39. **Core 不做 tool input schema 校验，且这是裁决而非遗漏**。`Tool.inputSchema` 保持 `unknown`（P1.1 契约不变），模型给的参数直接进 `Tool.execute`；参数不合法由 **Tool 自己**抛错 → ToolRegistry 规范化为 `{ ok: false, error }` 观察结果 → 模型有机会纠正（`tests/pi-ai-integration.test.ts` 钉住了这条路径）。pi-ai 确实导出 `validateToolCall` / `validateToolArguments`（TypeBox，对纯 JSON Schema 也能用），但它自己的 wire adapter 从不调用它，所以「pi-ai 会替我们校验」是假的。**若将来要引入校验，唯一自洽的位置是 ToolRegistry**（放 adapter 会把「模型参数不合法」变成 step 失败 + 重试，模型反而失去纠正机会），且需要同时改 `Tool.inputSchema` 的契约（TypeBox）与 SPEC §5.5 的措辞 —— 属 Phase 2 插件场景（插件是外来代码，那时才需要主动防御）。
40. **adapter 的失败映射是**：pi-ai 的 `error` 终端 → throw（`aborted` 与 `error` 用不同措辞）；`done` 但 `message.stopReason` 是 `length`（截断）/ `pending` / `deferred` / `aborted` / `error` → throw；**流在没有终端事件的情况下结束 → throw**（因为 Core 把静默结束读作「step 完成」，这是它唯一不能收到的失败）。`stop` / `toolUse` 才是正常结束。未知事件或未知 stop reason 由 `never` 赋值在**编译期**挡住。
41. **adapter 不重试，并显式传 `maxRetries: 0`**。pi-ai 的请求层默认已是 0（`utils/provider-retry.js` 的 `options.maxRetries ?? 0`），SDK 客户端也被 pi-ai 强制 `maxRetries: 0`；显式写出来是为了让这个性质不会在 Core 脚下改变。
42. **provider 侧的消息归一（连续 tool 结果合并、role 映射）全部由 pi-ai 完成，`deriveMessages` 一行不改**。Anthropic 把连续 tool 结果折进一条 user message，OpenAI-compatible 保持独立 `role:"tool"` —— Core 与 Session 都不知道这个区别。
43. **adapter 交给 Core 的 tool call 是顶层复制**（`{ ...arguments }` 仅当它是对象）；**不是对象就原样透传**，绝不 spread 成 `{0: ...}`（那会凭空造出模型没给过的参数）。反向重放时，`input` 不是对象的记录会**抛本地错误**，而不是让 provider 去拒绝。
44. **凭据是宿主的责任**：adapter 只接受可选的 `apiKey`；不传则交给 pi-ai 自己的 credential store / 环境变量解析。Core 从不读凭据，任何地方都不打印它们。（注意：provider 的错误文本可能回显凭据片段，它会被记进 `turn/end.error`，将来持久化时会落盘 —— P1.5 若要写日志，需要留意这一点。）
45. **adapter 的依赖是 pi-ai 的一个切片**（`PiAiStreamSource`，只有 `stream`），而不是整个 `Models`：既让 adapter 说清自己依赖什么，也让测试能用脚本化事件驱动它。集成测试把 pi-ai 真实的 `Models` 交给它，所以签名漂移会在那里编译失败。

**P1.5 新增（持久化与真实 E2E）**

46. **恢复与记录是两个入口**：`createSession(id)` 新建，`restoreSession(id, events)` 从已记录的事件重建。理由：`append` 是**分配** `seq` / `time`，restore 是**照搬**它们；一个入口两种含义会让「谁来写这个信封」变得含糊。restore 逐条拒绝 `seq` 不连续或带空洞的日志（拒绝而不是静默重编号），并按 `append` 的方式做浅冻结。
47. **store 属于宿主，不属于 Core**：`SessionStore` 只被 composition root 调用；Loop / Runtime / ContextBuilder 一行都不依赖它（`AgentRuntimeDeps = { loop }` 保持不变），因此**存储失败不会变成 turn 的结局**。`append(sessionId, events)` 严格 append-only，且**要么整批接受要么整批拒绝**（不会半批入库）；`load` 返回的是副本，往 loaded session 上 append 不会写回 store（宿主自己决定何时 flush）。
48. **会话日志的隔离边界与 Session 一致**（#11 的推论）：`load` 复制信封与顶层 `data`，但 `toolCalls` 数组 / `ToolCall` / `input` 仍按引用共享。store 不额外深拷贝，因为 Core 的契约就是浅隔离；需要更强保证是 store 实现自己的决定。
49. **Phase 1 不做 SQLite**（这是裁决，不是遗漏）：SPEC §5.10 把 SQLite 列为「视进度」且明确「不得阻塞最小 ReAct Core」，而 SPEC §10 的 DoD 十项里没有任何持久化条目 —— seam 由 `MemorySessionStore` 证明。将来要做时：`node:sqlite`（Node ≥22.13 内置、零依赖，本机 v24.17 实测无 ExperimentalWarning 且 `@types/node` 已带类型）；形态是**事件表**（`(session_id, seq)` 主键 + payload），不做 migration 框架 / ORM；并且**不要从 `index.ts` 再导出它**，否则任何消费者一 import 本包就会加载 `node:sqlite`。
50. **Calculator Tool 是生产代码**（SPEC §9 P1.5 的交付物），不是测试夹具：纯 JSON Schema 字面量（**不引 TypeBox**，那是 pi-ai 的传递依赖）、`execute` 用方法签名（#25）、坏参数抛错走 observation 路径、**乘积非有限也抛错**（JSON 无法表示 `Infinity`，`JSON.stringify` 会给模型一个「成功」的 `null`）。
51. **假跑与真跑必须区分**：faux provider 的往返只在标题里写明「no real model」的文件里（`calculator-roundtrip.test.ts`）；真实模型的往返只在 `real-provider.e2e.test.ts`，凭据缺失时 skip（不是 pass）。**Fake 永远不能当成 Real LLM E2E 的证据。**

---

## 5. Current Public API

`packages/agent-core/src/index.ts` 是唯一出口。签名摘要：

```ts
createSession(id: string): Session
  append(event: SessionEventInput): SessionEvent      // 生成 seq / time
  events(): readonly SessionEvent[]                   // 冻结快照
  deriveMessages(): ModelMessage[]

restoreSession(id: string, events: readonly SessionEvent[]): Session  // 照搬已记录的 seq / time；拒绝不连续或带空洞的日志

createMemorySessionStore(): SessionStore
  create(sessionId): Promise<void>                    // 重名抛错
  load(sessionId): Promise<Session | null>            // 返回副本；往 loaded session append 不回写
  append(sessionId, events): Promise<void>            // 严格 append-only；整批接受或整批拒绝

createToolRegistry(): ToolRegistry
  register(tool: Tool): () => void                    // 重名抛错；disposer 幂等
  get(name) / list()
  execute(name, input, context): Promise<ToolExecutionResult>   // 不抛业务失败

createCalculatorTool(): Tool<{ a: number; b: number }, number>   // Phase 1 的真实 Tool

createDefaultContextBuilder(systemPrompt?: string): ContextBuilder
  build({ session, tools, context }): Promise<ModelRequest>

createPiAiModelClient(options: {
  models: PiAiStreamSource;    // pi-ai 的 Models（或测试里的脚本化实现）
  model: Model<Api>;           // 自带 api 协议与 baseUrl
  apiKey?: string; maxTokens?: number; timeoutMs?: number;
}): ModelClient
  stream(request, context): AsyncIterable<ModelEvent>

createAgentLoop(deps: { modelClient; tools; contextBuilder }): AgentLoop
  runTurn({ session, turnId, context, emit? }): Promise<TurnOutcome>
  // TurnOutcome = { reason: TurnEndReason; text: string; error?: string }
  // emit?: (event: AgentLoopEvent) => void   —— 无信封的 assistant/chunk | tool/call | tool/result

createAgentRuntime(deps: { loop: AgentLoop }): AgentRuntime
  run({ session, text, userId?, signal? }): Promise<TurnResult>
  // TurnResult = { turnId; text; reason: TurnEndReason; error? }
  stream({ session, text, userId?, signal? }): AsyncIterable<RuntimeEvent>

MAX_STEPS = 12            // 每次 turn 的 model 调用上限
MAX_MODEL_ATTEMPTS = 3    // 每个 model step 的尝试上限（1 + 2 次重试）
```

`AgentRuntimeInput.signal` 是**真正的取消开关**：abort 后 turn 在下一个检查点停下并以 `cancelled` 闭合。SPEC §5.9 建议里的 `cancel(...)` / `getSession(...)` **没有实现**（HANDOFF 从未冻结它们）：取消走调用方自己的 signal，session 由组装的调用方持有。

---

## 6. Current Turn / ReAct Flow

**plain turn**（4 事件）：`turn/start → message/user → message/assistant{text, toolCalls:[]} → turn/end{completed}`

**tool turn**（7 事件，DoD 路径）：`turn/start → message/user → message/assistant{text:"", toolCalls:[call-1]} → tool/call{call-1} → tool/result{call-1, ok:true} → message/assistant{text:"Echo: hello", toolCalls:[]} → turn/end{completed}`

**同一 step 内多个 tool call**：`message/assistant(A, B)` → `tool/call A → tool/result A → tool/call B → tool/result B`。**多 step**：上述 tool 块整体重复，每次重复前追加一条 `message/assistant`。

循环终止条件只有一个：**某个完成的 step 没有 tool call**，该 step 的 text 即最终答案。每个 model step 都**重新**通过 ContextBuilder 从 Session 派生 `ModelRequest`（含 systemPrompt、全量 messages、tool schemas），不存在增量拼接。

**turn 的四种结局**（`turn/end.reason`）：

| reason | 触发 | 日志形态 | `TurnResult.text` |
| --- | --- | --- | --- |
| `completed` | 某个完成的 step 没有 tool call | 完整 | 最终答案 |
| `max_steps` | 12 次 model 调用用尽，模型仍要工具 | 完整（第 12 步的 tool 也已派发并记录） | 第 12 步的 text（通常是 `""`） |
| `cancelled` | `signal.aborted` 在任一检查点成立 | 已记录的 call 全部有 result；被打断的 step 不落日志 | `""` |
| `error` | model step 重试耗尽，或 Core 自身抛错 | 同上 | `""`，原因在 `error` 字段 |

`run()` 对以上四种都**返回结果而不是 throw**；`stream()` 把同样的结局作为 `turn/end` 事件发出。

---

## 7. Verification Baseline

```bash
pnpm typecheck    # tsc --noEmit -p tsconfig.json  → 0 错
pnpm test         # vitest run                     → 129 passed, 2 skipped (15 files)
```

测试分布：session 12 / tool-registry 16 / context-builder 6 / derive-messages 10 / agent-loop 7 / agent-runtime 2 / react-loop 3 / agent-loop-limits 15 / agent-runtime-stream 10 / pi-ai-client 17 / pi-ai-integration 8 / session-restore 7 / session-store 10 / calculator-roundtrip 6。

注意：编译期断言（穷尽 switch、`never` 赋值、`Tool<string,number>` 可赋值性）只在 `typecheck` 下生效，`test` 单独跑不覆盖 —— 将来加 CI 必须两条命令都跑。

**Real provider E2E：未通过（凭据被 provider 拒绝）—— 这是 Phase 1 唯一的未满足项**

```bash
# 凭据存在时才会真的调用；不存在则 skip（不会假通过）
DEEPSEEK_API_KEY=... npx vitest run packages/agent-core/tests/real-provider.e2e.test.ts
```

2026-09-28 在本机运行（`deepseek/deepseek-flash`，`https://api.deepseek.com`，OpenAI-compatible）：两个用例（纯文本 smoke、真实模型 + calculator 往返）都真的发出了请求并返回

```text
401: {"message":"Authentication Fails, Your api key: ****mlbo is invalid", ...}
```

同一凭据直接用 pi-ai 调用（不经过本仓库任何代码）得到同样的 401，所以**不是 adapter 或 E2E 的问题**，是本机配置的 key 已失效（另有 `~/.dsh` 之外的其他工具配置未清点，未使用）。已经可以确认的是：请求构造、真实 HTTPS 往返、失败映射、Core 的 3 次重试、以及 E2E 自己的断言链都在真实端点上跑通了（turn 以 `error` 闭合，错误原文保留）。**一次成功的真实补全从未发生过**，因此 Phase 1 = PARTIAL：SPEC §10 的「真实 LLM + Calculator Tool → 42」闭环没有任何一次通过记录。

---

## 8. Deferred Decisions / Technical Debt

### 阻塞 Phase 1 完成的一项

- **一次成功的真实补全**：用有效凭据（`DEEPSEEK_API_KEY` 或 `E2E_PROVIDER` / `E2E_MODEL` 指向别的 provider）跑
  `npx vitest run packages/agent-core/tests/real-provider.e2e.test.ts`。两个用例都必须绿：
  纯文本 smoke，以及「真实模型 → `calculator({a,b})` → `42`」的 DoD 闭环。在此之前 Phase 1 = **PARTIAL**，不进入 Phase 2。
  首次运行时若失败，先分清三类原因：adapter/协议问题、模型没按 `description` 调用工具（可能要给 system prompt 或改 description）、以及 provider 侧的模型 id / 限流。

### Later

- **SQLite store**：Phase 1 不做（#49）。要做时按 #49 的形态（事件表、无 migration 框架、不从 `index.ts` 导出），并注意两点：`append` 的严格 seq 语义目前不幂等（重放同一次 flush 会报错，SQLite 崩溃恢复需要重新设计这一点）；若按 append 粒度落盘，崩溃可能把「有 tool call 无 result」的历史持久化下来 —— 落盘时机应与 #33 的不变量一起设计。
- **信封没有 `sessionId`**：事件信封只有 `turnId` / `seq` / `time`，所以「把 A 会话的事件装进 B 会话」在类型与运行时都无法检测（`restoreSession` 的注释把这条写成调用方义务）。按 session 分表 / 按 `session_id` 过滤的 store 天然规避；若将来要强校验，得给信封加字段（P1.1 契约变更）。
- **Tool input schema 校验**（TypeBox）留到 Phase 2 插件场景，位置必须是 ToolRegistry（#39）。
- `deriveMessages()` 目前全量重建（正确，不改）；将来若要缓存放 Session 内部，**压缩 / 裁剪永远属于 ContextBuilder**。
- tool schema 暴露顺序（P2 插件加载序 / prompt cache；当前 Map 插入序已确定且稳定）。
- 重名注册策略（P2 若需 last-wins）。
- `assistantSteps` helper 在多个测试文件中逐字重复（已裁决不处理）。
- 取消与真实错误同时发生时按 `cancelled` 记账（#31 的代价）：错误原因不进日志。
- `turn/end.error` 会带上 provider 的错误原文，而 provider 有时会回显凭据片段（#44）；真实 E2E 的失败分支也会把它打到 stdout。将来把日志落盘、上报或展示给他人前要留意。
- 真实端点上的 tool-call 往返仍未验证（argument delta → parsed input → tool 只有桩 socket 级证据）；真实 E2E 一旦跑通，这一条随之关闭。

---

## 9. Explicit Non-Goals

Phase 1 内不做：Multi-Agent / Subagent、Planner / Plan-and-Execute / ToT、Workflow Engine、MCP、Skills、Browser / Shell / Code Interpreter、Web UI / React / Tauri、业务插件（Music / Calendar / Gmail）、GraphRAG / vector DB / Context Compaction、复杂 permission sandbox 与 human-in-the-loop approval。完整清单见 SPEC §7。
---

## 10. Next Window

**P1.1–P1.5 的代码都已落地；Phase 1 只剩一件事：一次成功的真实补全（§8）。**

收尾动作（不需要新的设计）：

```bash
DEEPSEEK_API_KEY=... npx vitest run packages/agent-core/tests/real-provider.e2e.test.ts
```

通过后：把 §1 的 Phase 1 状态改为 COMPLETE、删掉 §8 的阻塞项、更新 §7 的数字，然后进入 Phase 2。

**Next milestone: Phase 2 Plugin Contract + PluginManager**（仅在上一行通过之后）。届时仍按固定顺序启动：

1. 先读 `docs/PHASE1_AGENT_CORE_SPEC .md`（注意文件名里的空格）。
2. 再读本文件。
3. Explore 当前 `packages/agent-core/src` 与 `tests`，核对真实代码与本文档。
4. **先 Plan，不直接 Implement。**

---

## Maintenance Rule

每个 P1.x milestone：

```text
Implement
  → Independent Review
  → Fix
  → Commit + Push code
  → Update HANDOFF in the same milestone window
  → Lightweight HANDOFF review
  → Commit + Push docs
  → Close window
```

HANDOFF 只保存「当前真相」，更新方式：

- 更新 Current Status（**Code baseline / latest milestone commit**、milestone、test 数、LOC）
- 更新 Completed Milestones（新完成的 milestone 归纳成最终状态）
- 更新 Frozen Decisions（新裁决加入；被推翻的删除而非留痕）
- 更新 Verification Baseline（只保留当前数字，不记历史流水账）
- **删除已经解决的 Deferred item**（不是标记为「已完成」）
- 更新 Next Window

不要追加聊天记录式内容、review 原文、逐 commit changelog。
