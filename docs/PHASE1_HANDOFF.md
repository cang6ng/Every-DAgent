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
| Code baseline | `b193d51cd2691b0261ef4c3c31cdf06b131d2452` — `feat(core): add real model adapter` |
| Remote | `origin/rewrite/runtime-lite`；code baseline 已 push |
| 当前 milestone | P1.4 ✅ 已完成、已提交 |
| 下一个 milestone | P1.5 Persistence + E2E（未开始） |
| Tests | **106 passed / 1 skipped / 12 files**（`pnpm test`；skipped 是真实 provider smoke，见 §7） |
| Typecheck | **0 错**（`pnpm typecheck`） |
| Production LOC | `packages/agent-core/src/` 14 文件 / **1408 行**（去空行、整行 `//` 与块注释后 843 行） |
| Real provider | **未通过**：真实端点可达，但本机凭据被 provider 判为 invalid（§7 有原文） |
| 工作区 | 除 `.zcode/` 与 `.zcodeignore`（untracked，**不得提交**）外，改动均已入库 |

```text
P1.1 Core Contracts        ✅  b96937d
P1.2 Minimal ReAct Loop    ✅  c24fe68
P1.3 Runtime Engineering   ✅  aece33e
P1.4 Real LLM              ✅  b193d51  ← code baseline
P1.5 Persistence + E2E     ⬜  next
```

仓库形态：pnpm workspace，只有一个包 `packages/agent-core`。**无构建步骤**（`main` 指向 `src/index.ts`）、**无 CI**；运行时唯一依赖是 `@earendil-works/pi-ai@0.87.1`（ESM-only，`engines: node >=22.19`，根 `package.json` 的 engines 与 `packageManager` 已对齐），devDependencies 仅 `typescript` / `vitest` / `@types/node`。**该依赖很重**：连同 `openai`、`@anthropic-ai/sdk`、`@aws-sdk/client-bedrock-runtime`、`@google/genai`、`typebox` 等，生产闭包 80+ 个包（本仓 `.pnpm` 共约 131 MB，其中 pi-ai 生产闭包约 60 MB，其余是 dev 树）。adapter 对 pi-ai 只用 `import type`，所以 **Core 自己的模块图**运行时不会加载其中任何一个（构造 adapter 的宿主当然用的是真 pi-ai）。模块路径导入一律带 `.js` 后缀。

> SPEC 的实际文件名是 `docs/PHASE1_AGENT_CORE_SPEC .md` —— `SPEC` 与 `.md` 之间**有一个空格**，按此路径打开。

---

## 2. Architecture Snapshot

**组装方向**（启动时，谁构造谁）——只有 composition root 知道全部依赖：

```text
composition root (host / test)
  ├── createSession(id)
  ├── createToolRegistry()  ──register(tool)
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

八个契约，均已定稿并实现：`RuntimeContext`、`RuntimeEvent`（四种，各带 `sessionId` + `turnId`，`turn/end` 另有可选 `error`）、`SessionEvent`（六类 + `TurnEndReason`）、`Session`（append-only，`append` 只生成 `seq` / `time`）、`Tool`（`execute` 是**方法签名**，失败是值 `ToolExecutionResult`）、`ToolRegistry`（Map 实现，`execute` 不抛业务失败）、`ModelClient`（`stream(request, context)`，失败一定是 throw）、`ContextBuilder`（systemPrompt + `deriveMessages()` + tool schemas）。

### P1.2 Minimal ReAct Loop

DoD 链路跑通（User → Model → Tool → Result → Model → Final Answer）；`FakeModelClient` / `EchoTool` 放在 `tests/helpers/`（测试内部另有就地定义的桩工具与桩流，见 `tests/`）；覆盖 plain turn、同一 step 内多 tool call、多 step tool 链、tool 抛错恢复、unknown tool 恢复、非字符串 tool 输出渲染。
### P1.3 Runtime Engineering

- `AgentLoop`（`src/loop/agent-loop.ts`）：ReAct 编排 + 步预算 + 模型重试 + 取消检查点 + 事件发射；`runTurn()` 返回 `TurnOutcome`。
- `AgentRuntime`（`src/runtime/agent-runtime.ts`）：`run()` 与 `stream()` 共用 `driveTurn()`；Runtime 持有 turn 边界与 RuntimeEvent 信封。
- 四种结局全部落地并被测试：`completed` / `max_steps` / `cancelled` / `error`；**循环内部任何失败都不会留下未闭合的 turn**。

### P1.4 Real LLM

- `PiAiModelClient`（`src/model/pi-ai-client.ts`）：把 `ModelRequest` 翻译成 pi-ai 的 `Context`，把 pi-ai 的事件流翻译成 `ModelEvent`，把每一种失败翻译成 throw。是 `src/` 里唯一 import pi-ai 的文件（且只用 `import type`）。
- 支持 **OpenAI-compatible（`api: "openai-completions"`）与 Anthropic（`api: "anthropic-messages"`）** 两条 wire path：不是自己实现协议，而是把 `Model` / `Models` 交给 pi-ai 自带的 provider 层。
- 确定性验证分三层：adapter 单测（事件 / 失败 / 请求投影 / 选项透传）、真 pi-ai `fauxProvider` + 真 Core 的 DoD 往返、以及**只把 socket 换成桩的 wire 级测试**（真 wire adapter + 真 SSE 解析 + 真参数累加；Anthropic 那条同时证明 tool 结果被折进 user message）。
- 真实端点：`tests/real-provider.e2e.test.ts` 只在 `DEEPSEEK_API_KEY` 存在时运行；本次结果见 §7。

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

---

## 5. Current Public API

`packages/agent-core/src/index.ts` 是唯一出口。签名摘要：

```ts
createSession(id: string): Session
  append(event: SessionEventInput): SessionEvent      // 生成 seq / time
  events(): readonly SessionEvent[]                   // 冻结快照
  deriveMessages(): ModelMessage[]

createToolRegistry(): ToolRegistry
  register(tool: Tool): () => void                    // 重名抛错；disposer 幂等
  get(name) / list()
  execute(name, input, context): Promise<ToolExecutionResult>   // 不抛业务失败

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

**tool turn**（7 事件，DoD 路径）：

```text
turn/start
message/user
message/assistant{text:"", toolCalls:[call-1]}
tool/call     {callId:"call-1", name:"echo", input}
tool/result   {callId:"call-1", name:"echo", ok:true, content}
message/assistant{text:"Echo: hello", toolCalls:[]}
turn/end{reason:"completed"}
```

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
pnpm test         # vitest run                     → 106 passed, 1 skipped (12 files)
```

测试分布：session 12 / tool-registry 16 / context-builder 6 / derive-messages 10 / agent-loop 7 / agent-runtime 2 / react-loop 3 / agent-loop-limits 15 / agent-runtime-stream 10 / pi-ai-client 17 / pi-ai-integration 8。

注意：编译期断言（穷尽 switch、`never` 赋值、`Tool<string,number>` 可赋值性）只在 `typecheck` 下生效，`test` 单独跑不覆盖 —— 将来加 CI 必须两条命令都跑。

**Real provider smoke：未通过（凭据被 provider 拒绝）**

```bash
# 凭据存在时才会真的调用；不存在则 skip（不会假通过）
DEEPSEEK_API_KEY=... npx vitest run packages/agent-core/tests/real-provider.e2e.test.ts
```

2026-09-28 在 `deepseek/deepseek-flash`（`https://api.deepseek.com`，OpenAI-compatible）上运行的结果：端点返回 `401: {"message":"Authentication Fails, Your api key: ****mlbo is invalid", ...}`。同一凭据直接用 pi-ai 调用（不经过本仓库任何代码）得到同样的 401，所以**不是 adapter 的问题**，是本机配置的 key 已失效。可以确认的是：请求构造、真实 HTTPS 往返、失败映射、以及 Core 的 3 次重试都在真实端点上跑通了（turn 以 `error` 闭合，错误原文保留）。**一个成功的真实补全还没有发生过。**

---

## 8. Deferred Decisions / Technical Debt

### P1.5 Persistence + E2E

- `SessionStore` seam：先 `MemorySessionStore`，再视进度做 `SQLiteSessionStore`。
- 从既有日志构造 Session 供 `SessionStore.load`（加可选第二参数即可）、Calculator Tool、真实 LLM + Calculator 的 E2E（DoD 最后一块）。
- **Phase 1 是否算完成取决于真实补全**：凭据可用时跑 `real-provider.e2e.test.ts` 与 Calculator E2E；不可用时必须写明 `REAL_PROVIDER_SMOKE = NOT RUN/BLOCKED`，Phase 1 保持 PARTIAL。

### Later

- **Tool input schema 校验**（TypeBox）留到 Phase 2 插件场景，位置必须是 ToolRegistry（#39）。
- `deriveMessages()` 目前全量重建（正确，不改）；将来若要缓存放 Session 内部，**压缩 / 裁剪永远属于 ContextBuilder**。
- tool schema 暴露顺序（P2 插件加载序 / prompt cache；当前 Map 插入序已确定且稳定）。
- 重名注册策略（P2 若需 last-wins）。
- `assistantSteps` helper 在多个测试文件中逐字重复（已裁决不处理）。
- 取消与真实错误同时发生时按 `cancelled` 记账（#31 的代价）：错误原因不进日志。
- `turn/end.error` 会带上 provider 的错误原文，而 provider 有时会回显凭据片段（#44）；将来把日志落盘或展示给他人前要留意。
- 真实 provider 的 tool-call 往返（真实 endpoint 上的 argument delta → parsed input → tool）从未验证过；只有桩 socket 级的 wire 测试覆盖。

---

## 9. Explicit Non-Goals

Phase 1 内不做：Multi-Agent / Subagent、Planner / Plan-and-Execute / ToT、Workflow Engine、MCP、Skills、Browser / Shell / Code Interpreter、Web UI / React / Tauri、业务插件（Music / Calendar / Gmail）、GraphRAG / vector DB / Context Compaction、复杂 permission sandbox 与 human-in-the-loop approval。完整清单见 SPEC §7。
---

## 10. Next Window

**Next milestone: P1.5 Persistence + E2E**

启动顺序：

1. 先读 `docs/PHASE1_AGENT_CORE_SPEC .md`（注意文件名里的空格）。
2. 再读本文件。
3. Explore 当前 `packages/agent-core/src` 与 `tests`，核对真实代码与本文档。
4. **先 Plan P1.5，不直接 Implement。** 批准后再动手。

P1.5 的 P0 待设计问题：

1. `SessionStore` 的最小接口（`create` / `load` / `append`）与 `Session` 如何解耦；`load` 需要从既有事件重建 Session（`createSession` 加可选第二参数，还是单独的工厂函数），以及 `seq` / `time` / `turnId` 如何保真。
2. SQLite 在 Phase 1 是否真的需要（SPEC 说「先 Memory，SQLite 不得阻塞最小 ReAct Core」，DoD 未强制）；如果做，存的是事件表还是整份日志。
3. Calculator Tool 的契约（`{ a, b }` 的数字与错误路径），以及 E2E 在没有凭据时如何明确标记为 pending 而不是假通过。

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
