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
| Code baseline | `aece33e2d1e9f1b0289606397775fd7be6171ab4` — `feat(core): harden agent runtime execution` |
| Remote | `origin/rewrite/runtime-lite`；code baseline 已 push |
| 当前 milestone | P1.3 ✅ 已完成、已提交 |
| 下一个 milestone | P1.4 Real LLM（未开始） |
| Tests | **81 passed / 9 files**（`pnpm test`） |
| Typecheck | **0 错**（`pnpm typecheck`） |
| Production LOC | `packages/agent-core/src/` 13 文件 / **1076 行**（去空行、整行 `//` 与块注释后 644 行） |
| 工作区 | 除 `.zcode/` 与 `.zcodeignore`（untracked，**不得提交**）外，改动均已入库 |

```text
P1.1 Core Contracts        ✅  b96937d
P1.2 Minimal ReAct Loop    ✅  c24fe68
P1.3 Runtime Engineering   ✅  aece33e  ← code baseline
P1.4 Real LLM              ⬜  next
P1.5 Persistence + E2E     ⬜
```

仓库形态：pnpm workspace，只有一个包 `packages/agent-core`。**无构建步骤**（`main` 指向 `src/index.ts`）、**无 CI**、**无 Cordis / pi-ai 依赖**；devDependencies 仅 `typescript` / `vitest` / `@types/node`（`pnpm-workspace.yaml` 里 `allowBuilds: esbuild: true`，否则 `pnpm <script>` 跑不起来）。模块路径导入一律带 `.js` 后缀（ESM + `moduleResolution: bundler`）。

> SPEC 的实际文件名是 `docs/PHASE1_AGENT_CORE_SPEC .md` —— `SPEC` 与 `.md` 之间**有一个空格**，按此路径打开。

---

## 2. Architecture Snapshot

**组装方向**（启动时，谁构造谁）——只有 composition root 知道全部依赖：

```text
composition root (host / test)
  ├── createSession(id)
  ├── createToolRegistry()  ──register(tool)
  ├── createDefaultContextBuilder(systemPrompt?)
  ├── createAgentLoop({ modelClient, tools, contextBuilder })
  └── createAgentRuntime({ loop })            ← Runtime 不构造 Loop
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
         │        ├─ text-delta    ──> emit(assistant/chunk)
         │        └─ tool-call     ──> 收进本 step 的 toolCalls
         ├──> ToolRegistry.execute(name, input, context) ──> ToolExecutionResult
         │        tool/call 在派发前 emit，tool/result 在派发后 emit
         └──> Session.append(...)   写 message/assistant, tool/call, tool/result
```

关键点：**Loop 从不读日志**（不调 `session.events()`）。每一步都重新经 ContextBuilder 从 Session 派生 request，日志是唯一事实来源。模型输入的构造路径只有 ContextBuilder 一条（`deriveMessages()` 在 `src/` 内的唯一调用点是 `context-builder.ts`），但 `Session.events()` / `deriveMessages()` 是公开 API，宿主与测试当然可以直接读。`run()` 与 `stream()` **共用同一条 `driveTurn()`**，唯一差别是事件推给谁（no-op 还是 channel）。

---

## 3. Completed Milestones

### P1.1 Core Contracts

八个契约，均已定稿并实现：`RuntimeContext`（`src/runtime/runtime-context.ts`）、`RuntimeEvent`（四种，各带 `sessionId` + `turnId`，`turn/end` 另有可选 `error`）、`SessionEvent`（六类 + `TurnEndReason`）、`Session`（append-only，`append` 只生成 `seq` / `time`）、`Tool`（`execute` 是**方法签名**，失败是值 `ToolExecutionResult`）、`ToolRegistry`（Map 实现，`execute` 不抛业务失败）、`ModelClient`（`stream(request, context)`，失败一定是 throw）、`ContextBuilder`（systemPrompt + `deriveMessages()` + tool schemas）。

### P1.2 Minimal ReAct Loop

DoD 链路跑通（User → Model → Tool → Result → Model → Final Answer）；`FakeModelClient` / `EchoTool` 只在 `tests/helpers/`；覆盖 plain turn、同一 step 内多 tool call、多 step tool 链、tool 抛错恢复、unknown tool 恢复、非字符串 tool 输出渲染。

### P1.3 Runtime Engineering

- `AgentLoop`（`src/loop/agent-loop.ts`，315 行）：ReAct 编排 + 步预算 + 模型重试 + 取消检查点 + 事件发射；`runTurn()` 返回 `TurnOutcome`（不再是字符串）。
- `AgentRuntime`（`src/runtime/agent-runtime.ts`，220 行）：`run()` 与 `stream()` 两个 facade 共用 `driveTurn()`；Runtime 持有 turn 边界与 RuntimeEvent 信封（`turnId` 唯一生产者）。
- `src/errors.ts`：`errorMessageOf` 从 tool-registry 抽出，loop 与 registry 共用。
- 四种结局全部真实落地并被测试：`completed` / `max_steps` / `cancelled` / `error`；**循环内部任何失败都不会留下未闭合的 turn**。
- 覆盖：步预算（含边界：第 12 步仍可作答）、重试成功 / 重试耗尽 / 已产出 text 不重试 / 空输出重试、pre-abort（0 次 model 调用）、流中途 abort、tool 块中途 abort 的 call/result 补齐、tool 自身失败仍是 observation、RuntimeEvent 顺序与信封、`run()`/`stream()` 同路径、消费者提前 break 后 turn 仍闭合。

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
10. **每个完成的 model step 恰好一条 `message/assistant`**（先落日志再判分支；空 text 的 tool step 也写一条）。**被取消或失败的 step 不写**：它没有完成，半截的 step 不是会话事实。
11. **structural shallow isolation only**：`append` 单层浅拷贝 + `Object.freeze`；`deriveMessages` 的 assistant 分支新建数组 + 新建 `ToolCall` 对象。**`ToolCall.input` 保持原引用，不做 deep clone，不递归 deepFreeze**。
12. **`message/assistant` 事件自携带 `toolCalls`**，使 `deriveMessages()` 成为逐事件 1:1 映射；**`tool/call` 事件不产出任何投影消息**（它是「已派发」这一刻的事实记录）。

**模型与工具契约**
14. **`ModelEvent.tool-call` 是已拼装完整的成品**，不是增量 delta。provider 的 argument-delta 累积属于 ModelClient 实现内部 —— 这是 Loop 里没有任何 stream assembler 的原因。
15. **provider-specific assembler 不进 Loop**。
16. **`ModelEvent.done` = 当前 model step 的终止事件**：遇到即停止消费；**同时允许 AsyncIterable 自然结束也表示 step 完成**。实现必须用**带标签 break 真正退出 `for await`**，label 的实际形状是 `modelStep: for await (...) { ... break modelStep; }`，绝不能写成只 break switch。**自然结束但无 text 且无 tool call 不算「完成」**，而是可重试的失败（见 #30）。
17. **ModelClient 失败一定是 throw / 迭代中途 reject**，绝不通过 `ModelEvent` 表达失败（所以刻意没有 error 变体）。取消与失败的区分靠 `context.signal.aborted`。
18. **Core-level retry 归 AgentLoop；adapter 不得实现 retry** —— 否则两边相乘。重试在**尚未产出 text 时是静默的**（Phase 1 没有 attempt 类事件，SPEC §5.2 明确不加）；只有重试耗尽才把原因写进 `turn/end.error`，所以「重试决策留在 Core 侧、可被 Core 观测」指的是它发生在 Core，而不是每次尝试都要发事件。
19. **ToolRegistry 只做 dispatch / catch / normalize**：不验证 schema、不做字符串化、不并行。
20. **P1.1 不做 schema validation**：`inputSchema: unknown`，不加 JSON Schema validator（P1.4 再定）。
21. **Tool execution serial，且 tool/call → tool/result 逐调用交替**：`tool/call A → tool/result A → tool/call B → tool/result B`，不是批量 `call A, call B, result A, result B`。
22. **`tool-call` 事件浅复制**（`toolCalls.push({ ...event.call })`），防止 client 事后改写 Loop 已记录的数据。
23. **`ToolRegistry.execute()` 对 Tool 执行路径不抛业务失败**：unknown tool / `Tool.execute` throw / 非 Error throw 统一规范化为 `{ ok: false, error }` 观察结果，交回模型。**`register()` 等配置 / 管理 API 的错误仍允许抛异常**。
24. **tool 结果 → 文本的转换只发生在 `agent-loop.ts` 的 `toolResultContent()`**：`!ok → error`；string → 原样；否则 `JSON.stringify(value) ?? String(value)`；抛错 → `<unserializable tool result>`。它必须是全函数。

**接口稳定性**
25. **P1.1 定义 `Tool.execute` 必须用方法签名**，不能改成属性接函数类型 —— TS 对方法参数做双变检查，改成属性会因参数逆变导致 `Tool<string, number>` 无法注册。
26. **`AgentRuntime.run()` 的参数与返回类型名不变**（仍是 `run(input: AgentRuntimeInput): Promise<TurnResult>`），P1.3 只新增 `stream(): AsyncIterable<RuntimeEvent>`。**`TurnResult` 以附加方式扩展**为 `{ turnId, text, reason, error? }`，`AgentLoop.runTurn()` 的返回类型由 `Promise<string>` 放宽为 `Promise<TurnOutcome>` —— 否则 Runtime 无从得知 reason，只能硬编码 `completed`。
27. **`ToolSchema` 是独立类型**，不是 `Tool` 的子集 —— 防止 `execute` 意外随 schema 进入 ModelRequest。

**运行时纪律**
28. **`MAX_STEPS = 12` 是常量，不是配置项**。一次 **step = 一次 model 调用 + 它请求的 tool 派发**；预算在 model 调用**之前**检查，所以「第 12 步请求了 tool」不会被拒绝执行，只是不会再有第 13 步。**abort 检查在预算检查之前**，取消的 turn 记 `cancelled` 而不是 `max_steps`。
29. **`MAX_MODEL_ATTEMPTS = 3`**（1 次 + 2 次重试），**重试不消耗 step 预算**：单 turn 最多 12 × 3 = 36 次 provider 调用。
30. **重试条件只有一个：该次尝试尚未产出 text**。tool call 在 step 完成前既不入日志也不 emit，因此可以整体丢弃后重试；text 已经到达观众，不能重来 → 直接把失败报出来。**空输出（无 text 无 tool call）算可重试失败**，不静默返回空答案。
31. **abort 优先于 retry，也优先于 max_steps**；`signal.aborted` 是区分「取消」与「模型坏了」的唯一依据，错误类型不参与判断（于是 AbortError 也被记作 cancelled，而不是 error）。
32. **取消或失败发生在 step 中途时，该 step 的 `assistant/chunk` 只到过 stream，不进日志**：日志里没有半截 step，但 `stream()` 的消费者确实看过那些 chunk（`run()` 路径下这些 chunk 没有观众）。
33. **每个 `message/assistant.toolCalls` 之后、下一条 message 之前，必须有对应的 `tool/result`**：取消时未派发的 call 补记 `tool/call` + `tool/result{ ok: false, content: "tool not executed: the turn was cancelled" }`；`ToolRegistry.execute` 若违反自己的契约抛错，由 loop 的 `dispatchTool()` 兜成 `{ ok: false }`。这条不变量是给下一个 provider 请求用的：悬空 tool call 会被 provider 拒绝。
34. **turn 闭合双保险**：loop 内部兜底（`runTurn()` 的 try/catch，把任何逃出的异常变成 `cancelled` / `error` 结局）**加上** Runtime 的 `runLoop()` 再兜一层 —— 因为 Loop 是注入依赖，而 turn 边界的承诺属于 Runtime。两层的边界是 `Session.append` 本身：Session 是本地 append-only 日志，它若抛错，没有能写下 `turn/end` 的人。
35. **`turn/end` 记录 `TurnOutcome.error`（有则写）**，`SessionEvent` 与 `RuntimeEvent` 两个类型同时具备该字段；内置 loop 只在 `reason: "error"` 时产生它。
36. **`RuntimeEvent` 保持四种，不加 `assistant/message`**：一个 step 的内容就是它的 chunk 拼接，边界就是 `tool/call` / 下一条 chunk / `turn/end`；Phase 3 还没有消费者，加冗余表示只会多一份要同步的东西。
37. **`stream()` 的消费者提前 break 不 abort turn**：turn 继续跑到闭合，日志完整；要中止必须 abort signal。channel 队列无上限（生产者与消费者之间隔着一次 model 调用，阻塞消费者等于阻塞它要报告的东西）。
38. **`ToolResult.ok = false` 用于「未执行」**：取消导致的未执行记录为失败观察，是当前类型下唯一诚实且 provider 合法的表达。

---

## 5. Current Public API

`packages/agent-core/src/index.ts` 是唯一出口。签名摘要：

```ts
createSession(id: string): Session
  readonly id: string
  append(event: SessionEventInput): SessionEvent      // 生成 seq / time，返回存储形态
  events(): readonly SessionEvent[]                   // 冻结快照
  deriveMessages(): ModelMessage[]

createToolRegistry(): ToolRegistry
  register(tool: Tool): () => void                    // 重名抛错；disposer 幂等
  get(name: string): Tool | undefined
  list(): Tool[]
  execute(name, input, context): Promise<ToolExecutionResult>   // 不抛业务失败

createDefaultContextBuilder(systemPrompt?: string): ContextBuilder
  build({ session, tools, context }): Promise<ModelRequest>

createAgentLoop(deps: {
  modelClient: ModelClient; tools: ToolRegistry; contextBuilder: ContextBuilder;
}): AgentLoop
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

`AgentRuntimeInput.signal` 现在是**真正的取消开关**：abort 后 turn 在下一个检查点停下并以 `cancelled` 闭合。SPEC §5.9 建议里的 `cancel(...)` / `getSession(...)` **没有实现**（HANDOFF 从未冻结它们）：取消走调用方自己的 signal，session 由组装的调用方持有。

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
pnpm test         # vitest run                     → 81 passed (9 files)
```

测试分布：session 12 / tool-registry 16 / context-builder 6 / derive-messages 10 / agent-loop 7 / agent-runtime 2 / react-loop 3 / agent-loop-limits 15 / agent-runtime-stream 10。

注意：编译期断言（穷尽 switch、`Tool<string,number>` 可赋值性）只在 `typecheck` 下生效，`test` 单独跑不覆盖 —— 将来加 CI 必须两条命令都跑。

---

## 8. Deferred Decisions / Technical Debt

### P1.4 Real LLM（开工清单）

- `PiAiModelClient` 包 `@earendil-works/pi-ai`（npm 实测 0.87.1，ESM-only，`engines: node >=22.19`），覆盖 OpenAI-compatible（`api: "openai-completions"`）与 Anthropic（`api: "anthropic-messages"`）。
- **provider 截断 / 超时必须以 throw 表达，不得用静默 natural end** —— 因为 Loop 把「流自然结束」也当作 step 完成（#16）。pi-ai 的终端事件是 `done` / `error`（含 `stopReason: "length"` = 截断、"aborted"、"error"），adapter 负责把它们翻译成 Core 的 throw 或正常结束。
- **Tool input validation strategy 再决定**：SPEC §5.5 把「参数验证」列为 ToolRegistry 职责，当前实现没有；pi-ai 自带 `validateToolCall`（TypeBox）可复用。
- **Tool result serialization contract 再决定**，包括 bigint：当前 `JSON.stringify(10n)` 会抛，导致**成功的** tool 结果被渲染成 `<unserializable tool result>`。
- **Provider adapter 不得在 yield 之后继续 mutate 已交给 Core 的 `ToolCall` / `input` 对象**：pi-ai 的 `partial` 是共享可变累加器，`toolcall_delta` 期间不能把它交给 Core。
- 连续同角色 tool 消息的 provider 归一由 adapter / pi-ai 处理，**不得改 `deriveMessages`**。

### P1.5 Persistence + E2E

- `SessionStore` seam：先 `MemorySessionStore`，再视进度做 `SQLiteSessionStore`。
- 从既有日志构造 Session 供 `SessionStore.load`（加可选第二参数即可）、真实 LLM + Calculator Tool E2E。

### Later

- `deriveMessages()` 目前全量重建（正确，不改）；将来若要缓存放 Session 内部，**压缩 / 裁剪永远属于 ContextBuilder**。
- tool schema 暴露顺序（P2 插件加载序 / P1.4 prompt cache；当前 Map 插入序已确定且稳定）。
- 重名注册策略（P2 若需 last-wins）。
- `inputSchema` 收窄（与验证机制同时进行）。
- `assistantSteps` helper 在多个测试文件中逐字重复（已裁决不处理）。
- 取消与真实错误同时发生时按 `cancelled` 记账（#31 的代价）：错误原因不进日志。若将来两者都要留痕，得给 `turn/end` 增加独立字段或事件类型。

---

## 9. Explicit Non-Goals

Phase 1 内不做：Multi-Agent / Subagent、Planner / Plan-and-Execute / ToT、Workflow Engine、MCP、Skills、Browser / Shell / Code Interpreter、Web UI / React / Tauri、业务插件（Music / Calendar / Gmail）、GraphRAG / vector DB / Context Compaction、复杂 permission sandbox 与 human-in-the-loop approval。完整清单见 SPEC §7。

---

## 10. Next Window

**Next milestone: P1.4 Real LLM**

启动顺序：

1. 先读 `docs/PHASE1_AGENT_CORE_SPEC .md`（注意文件名里的空格）。
2. 再读本文件。
3. Explore 当前 `packages/agent-core/src` 与 `tests`，核对真实代码与本文档。
4. **先 Plan P1.4，不直接 Implement。** 批准后再动手。

P1.4 的 P0 待设计问题（其余见 §8）：

1. pi-ai 的 `error` 终端事件（含 `aborted`）如何翻译成 Core 的 throw 与 `cancelled`，而不与「自然结束=step 完成」冲突？
2. `toolcall_delta` 的累加放在 adapter 哪一层，如何保证交给 Core 的 `ToolCall` 之后再不被 mutate？
3. 真实 provider smoke 用什么凭据、跑什么最小用例；没有凭据时如何明确标记 `REAL_PROVIDER_SMOKE = NOT RUN` 而不假称已验证。

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
