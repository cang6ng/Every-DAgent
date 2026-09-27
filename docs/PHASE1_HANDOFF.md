# Phase 1 Agent Core — Handoff

> 用途：跨工作窗口（Zcode / Claude Code）恢复上下文。
> 只记录「截至当前 commit，Phase 1 实际已经完成什么、什么已冻结、什么被延迟、下一步从哪继续」。
> 它不是 SPEC、不是 Plan / Review 存档、不是 changelog、不是教程。
> 维护方式见文末 **Maintenance Rule**。

---

## 1. Current Status

| 项 | 值 |
| --- | --- |
| Branch | `rewrite/runtime-lite` |
| Code baseline | `c24fe68e769288602925886121aeb6705862ad8b` — `feat(core): add minimal ReAct agent loop` |
| Remote | `origin/rewrite/runtime-lite`；code baseline 已 push |
| 当前 milestone | P1.2 ✅ 已完成、已提交 |
| 下一个 milestone | P1.3 Runtime Engineering（未开始） |
| Tests | **56 passed / 7 files**（`pnpm test`） |
| Typecheck | **0 错**（`pnpm typecheck`） |
| Production LOC | `packages/agent-core/src/` 12 文件 / **725 行**（去空行与注释后 449 行） |
| 工作区 | 干净；仅 `.zcode/` 与 `.zcodeignore` 为 untracked，**不得提交** |

```text
P1.1 Core Contracts        ✅  b96937d
P1.2 Minimal ReAct Loop    ✅  c24fe68  ← code baseline
P1.3 Runtime Engineering   ⬜  next
P1.4 Real LLM              ⬜
P1.5 Persistence + E2E     ⬜
```

仓库形态：pnpm workspace，只有一个包 `packages/agent-core`。**无构建步骤**（`main` 指向 `src/index.ts`）、**无 CI**、**无 Cordis / pi-ai 依赖**；devDependencies 仅 `typescript` / `vitest` / `@types/node`。模块路径导入一律带 `.js` 后缀（ESM + `moduleResolution: bundler`）。

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
AgentRuntime.run(input)
  │   写 turn/start, message/user, turn/end；生成 turnId 与 RuntimeContext
  └──> AgentLoop.runTurn({ session, turnId, context })
         ├──> ContextBuilder.build({ session, tools, context }) ──> ModelRequest
         ├──> ModelClient.stream(request, context) ──> ModelEvent*
         ├──> ToolRegistry.execute(name, input, context) ──> ToolExecutionResult
         └──> Session.append(...)   写 message/assistant, tool/call, tool/result
```

关键点：**Loop 从不读日志**（不调 `session.events()`）。每一步都重新经 ContextBuilder 从 Session 派生 request，日志是唯一事实来源。Session 被 Runtime 与 Loop 共同写入，但没有任何一条读取路径绕过 ContextBuilder。

---

## 3. Completed Milestones

### P1.1 Core Contracts

八个契约，均已定稿并实现：

| 契约 | 位置 | 要点 |
| --- | --- | --- |
| `RuntimeContext` | `src/runtime/runtime-context.ts` | `{ sessionId, userId?, signal }`；由 Runtime 控制，LLM 永不提供 |
| `RuntimeEvent` | `src/runtime/runtime-event.ts` | 严格四种：`assistant/chunk` / `tool/call` / `tool/result` / `turn/end`，各带 `sessionId` + `turnId`。**目前无生产者** |
| `SessionEvent` | `src/session/session-event.ts` | 六类事件 + `TurnEndReason`；`turnId` 在信封上 |
| `Session` | `src/session/session.ts` | append-only；`append` 只生成 `seq` / `time` |
| `Tool` | `src/tools/tool.ts` | `execute` 声明为**方法签名**（双变检查），失败是值 `ToolExecutionResult` |
| `ToolRegistry` | `src/tools/tool-registry.ts` | Map 实现；重名注册抛错、disposer 幂等；`execute` 永不向调用方抛 |
| `ModelClient` | `src/model/model-client.ts` | `stream(request, context): AsyncIterable<ModelEvent>`；失败契约见 §4 |
| `ContextBuilder` | `src/context/context-builder.ts` | `DefaultContextBuilder` = systemPrompt + `deriveMessages()` + tool schemas |

### P1.2 Minimal ReAct Loop

- `AgentRuntime`（`src/runtime/agent-runtime.ts`，62 行）：turn 生命周期，`run()` 返回 `{ turnId, text }`。
- `AgentLoop`（`src/loop/agent-loop.ts`，145 行）：ReAct 编排，`runTurn()` 返回最终文本。
- `FakeModelClient` / `EchoTool` **只在 `tests/helpers/`**，不导出、不属 production。
- DoD 链路已跑通：User → Model → Tool → Result → Model → Final Answer。
- 覆盖路径：plain turn、多 tool call（同一 step 内串行）、多 step tool 链、tool 抛错恢复、unknown tool 恢复、非字符串 tool 输出渲染。
- 测试：7 文件 56 用例全绿（session 12 / tool-registry 16 / context-builder 6 / derive-messages 10 / agent-loop 7 / agent-runtime 2 / react-loop 3）。

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
8. **Runtime 与 Model / Tool 共用一个 `RuntimeContext` 实例**：一次 `run()` 内所有 ModelClient 与 Tool 拿到的是同一个对象、同一个 `signal` 引用。

**数据与隔离**
9. **Session 是 append-only event log**；`seq` / `time` 由 Session 生成，`turnId` 由调用方生成 —— 调用方不能自行指定或伪造 `seq` / `time`，事件的语义 append 顺序由 Runtime / Loop 保证。
10. **每个 model step 恰好一条 `message/assistant`**（先落日志再判分支；空 text 的 tool step 也写一条）。
11. **structural shallow isolation only**：`append` 单层浅拷贝 + `Object.freeze`；`deriveMessages` 的 assistant 分支新建数组 + 新建 `ToolCall` 对象。**`ToolCall.input` 保持原引用，不做 deep clone，不递归 deepFreeze**。
12. **`message/assistant` 事件自携带 `toolCalls`**，使 `deriveMessages()` 成为逐事件 1:1 映射；**`tool/call` 事件不产出任何投影消息**（它是「已派发」这一刻的事实记录）。

**模型与工具契约**
14. **`ModelEvent.tool-call` 是已拼装完整的成品**，不是增量 delta。provider 的 argument-delta 累积属于 ModelClient 实现内部 —— 这是 Loop 里没有任何 stream assembler 的原因。
15. **provider-specific assembler 不进 Loop**。
16. **`ModelEvent.done` = 当前 model step 的终止事件**：遇到即停止消费；**同时允许 AsyncIterable 自然结束也表示 step 完成**。实现必须用**带标签 break 真正退出 `for await`**，label 的实际形状是 `modelStep: for await (...) { ... break modelStep; }`，绝不能写成只 break switch。
17. **ModelClient 失败一定是 throw / 迭代中途 reject**，绝不通过 `ModelEvent` 表达失败（所以刻意没有 error 变体）。取消与失败的区分靠 `context.signal.aborted`。
18. **Core-level retry 归 AgentLoop；adapter 不得实现 retry** —— 否则两边相乘，且重试决策应留在 runtime event stream 与会话日志里。
19. **ToolRegistry 只做 dispatch / catch / normalize**：不验证 schema、不做字符串化、不并行。
20. **P1.1 不做 schema validation**：`inputSchema: unknown`，不加 JSON Schema validator（P1.4 再定）。
21. **Tool execution serial，且 tool/call → tool/result 逐调用交替**：`tool/call A → tool/result A → tool/call B → tool/result B`，不是批量 `call A, call B, result A, result B`。比 DSH 的并行 dispatch 更强的保证。
22. **`tool-call` 事件浅复制**（`toolCalls.push({ ...event.call })`），防止 client 事后改写 Loop 已记录的数据。
23. **`ToolRegistry.execute()` 对 Tool 执行路径不抛业务失败**：unknown tool / `Tool.execute` throw / 非 Error throw 统一规范化为 `{ ok: false, error }` 观察结果，交回模型。**`register()` 等配置 / 管理 API 的错误仍允许抛异常**。
24. **tool 结果 → 文本的转换只发生在 `agent-loop.ts` 的 `toolResultContent()`**：`!ok → error`；string → 原样；否则 `JSON.stringify(value) ?? String(value)`；抛错 → `<unserializable tool result>`。它必须是全函数。

**接口稳定性**
25. **P1.1 定义 `Tool.execute` 必须用方法签名**，不能改成属性接函数类型 —— TS 对方法参数做双变检查，改成属性会因参数逆变导致 `Tool<string, number>` 无法注册。
26. **P1.3 不改 `run()` 签名**，只新增 `stream(): AsyncIterable<RuntimeEvent>`；`run()` 长期可作为消费 `stream()` 的 convenience API。
27. **`ToolSchema` 是独立类型**，不是 `Tool` 的子集 —— 防止 `execute` 意外随 schema 进入 ModelRequest。

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
  execute(name, input, context): Promise<ToolExecutionResult>   // 永不 reject

createDefaultContextBuilder(systemPrompt?: string): ContextBuilder
  build({ session, tools, context }): Promise<ModelRequest>

createAgentLoop(deps: {
  modelClient: ModelClient; tools: ToolRegistry; contextBuilder: ContextBuilder;
}): AgentLoop
  runTurn({ session, turnId, context }): Promise<string>

createAgentRuntime(deps: { loop: AgentLoop }): AgentRuntime
  run({ session, text, userId?, signal? }): Promise<TurnResult>   // TurnResult = { turnId; text }
```

`AgentRuntimeInput.signal` 当前只是**转发**给 ModelClient 与 Tool，Loop / Runtime 都不对 abort 做反应（P1.3）。

---

## 6. Current Turn / ReAct Flow

**plain turn**（4 事件）：

```text
turn/start → message/user → message/assistant{text, toolCalls:[]} → turn/end{completed}
```

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

**同一 step 内多个 tool call**（逐调用交替）：

```text
message/assistant(A, B)
tool/call A → tool/result A
tool/call B → tool/result B
```

**多 step**：上述 tool 块整体重复，每次重复前追加一条 `message/assistant`。

循环终止条件只有一个：**某个 step 没有 tool call**，该 step 的 text 即最终答案。每个 model step 都**重新**通过 ContextBuilder 从 Session 派生 `ModelRequest`（含 systemPrompt、全量 messages、tool schemas），不存在增量拼接。

---

## 7. Verification Baseline

```bash
pnpm typecheck    # tsc --noEmit -p tsconfig.json  → 0 错
pnpm test         # vitest run                     → 56 passed (7 files)
```

当前 baseline：**typecheck 0 错 / 56 tests 全绿**。

注意：编译期断言（穷尽 switch、`Tool<string,number>` 可赋值性）只在 `typecheck` 下生效，`test` 单独跑不覆盖 —— 将来加 CI 必须两条命令都跑。

---

## 8. Deferred Decisions / Technical Debt

### P1.3 Runtime Engineering（开工清单）

- **`maxSteps = 12`**，超限强制终止。
- **Core-level LLM retry 2～3 次**，实现在 AgentLoop。
- **`AbortSignal` 真正生效**：ModelClient 与 Tool 都必须遵守 `context.signal`。
- **turn 闭合原因齐备**：`completed` / `max_steps` / `cancelled` / `error`。当前 `AgentRuntime` 硬编码 `reason: "completed"`，且 `run()` 内任何 throw 会冒泡且**不写 `turn/end`**，留下未闭合的 turn。
- **`RuntimeEvent` 生产者** + `AgentRuntime.stream(): AsyncIterable<RuntimeEvent>`；`run()` 保持 `Promise<TurnResult>`，**两者的内部关系待 P1.3 设计**（是否共用同一条 loop 产出路径）。
- **model / provider failure 通过 throw / rejection 传播**，由 Loop 转成 `error` turn end。
- **empty stream 在 retry 中的语义待定**：当前空 stream 是合法的空最终答案，做 retry 后「空输出」很可能应视为可重试异常。
- **`turn/end` 是否加 `error?: string`**：等做「LLM 报错」验收时，`RuntimeEvent` 与 `SessionEvent` 两个类型同时加。
- **`RuntimeEvent` 若需 assistant message 边界**：加**装配完成的** `assistant/message`，**不加**裸 `step` 索引。
- **会话日志不变量**：中途取消会留下「有 `message/assistant.toolCalls` 与 `tool/call`、却无 `tool/result` 与 `turn/end`」的历史 —— 该 session 的后续请求可能被 provider 拒绝。P1.3 需决定补齐策略。
- 补一个**循环上限测试**（`maxSteps` 生效）。

### P1.4 Real LLM

- `PiAiModelClient` / `@earendil-works/pi-ai`，覆盖 OpenAI-compatible 与 Anthropic。
- **provider 截断 / 超时必须以 throw 表达，不得用静默 natural end** —— 因为 Loop 把「流自然结束」也当作 step 完成。
- **Tool input validation strategy 再决定**：SPEC §5.5 把「参数验证」列为 ToolRegistry 职责，当前实现没有。
- **Tool result serialization contract 再决定**，包括 bigint：当前 `JSON.stringify(10n)` 会抛，导致**成功的** tool 结果被渲染成 `<unserializable tool result>`（已裁决不加 bigint 特判）。
- **Provider adapter 不得在 yield 之后继续 mutate 已交给 Core 的 `ToolCall` / `input` 对象**（浅隔离契约的边界；不得复用「边解析边累加」的同一对象再 yield）。
- 连续同角色 tool 消息的 provider 归一由 adapter 合并，**不得改 `deriveMessages`**。

### Later

- `SessionStore`：先 `MemorySessionStore`，再视进度做 `SQLiteSessionStore`（P1.5）。
- 从既有日志构造 Session 供 `SessionStore.load`（加可选第二参数即可）、真实 LLM + Calculator Tool E2E —— 均在 P1.5。
- `deriveMessages()` 目前全量重建（正确，不改）；将来若要缓存放 Session 内部，**压缩 / 裁剪永远属于 ContextBuilder**。
- tool schema 暴露顺序（P2 插件加载序 / P1.4 prompt cache；当前 Map 插入序已确定且稳定）。
- 重名注册策略（P2 若需 last-wins）。
- `inputSchema` 收窄（与验证机制同时进行）。
- `assistantSteps` helper 在两个测试文件中逐字重复（已裁决不处理）。

---

## 9. Explicit Non-Goals

Phase 1 内不做：Multi-Agent / Subagent、Planner / Plan-and-Execute / ToT、Workflow Engine、MCP、Skills、Browser / Shell / Code Interpreter、Web UI / React / Tauri、业务插件（Music / Calendar / Gmail）、GraphRAG / vector DB / Context Compaction、复杂 permission sandbox 与 human-in-the-loop approval。完整清单见 SPEC §7。

---

## 10. Next Window

**Next milestone: P1.3 Runtime Engineering**

启动顺序：

1. 先读 `docs/PHASE1_AGENT_CORE_SPEC .md`（注意文件名里的空格）。
2. 再读本文件。
3. Explore 当前 `packages/agent-core/src` 与 `tests`，核对真实代码与本文档。
4. **只 Plan P1.3，不直接 Implement。** 等批准后再动手。

P1.3 当前最重要的待设计问题：

1. `maxSteps` 放在 Loop 的循环计数还是 Runtime 的 step 预算？超限后 `runTurn()` 如何把非 completed 的结局传出去（它现在只返回 `string`）？
2. `runTurn()` 的返回类型是否放宽为结构化 outcome（如 `{ text, reason }`）？在 `run()` 签名不动的前提下，Runtime 如何拿到 reason 去写 `turn/end`？
3. `stream()` 与 `run()` 的关系：`run()` 是否实现为消费 `stream()` 的 convenience，还是两条独立路径共享同一个 Loop？
4. `RuntimeEvent` 由哪一层产生：Loop 提供 step / tool 级回调，还是 Runtime 消费 Loop 交出的有序事件序列？
5. abort 的检查点放在哪里（model step 之间 / tool 调用之间 / 迭代内部）？abort 后已写入的 `tool/call` 是否补 `tool/result` 以保证日志不变量？
6. retry 的边界：重试整个 model step，还是流中途失败也重试？（流已 yield 过 `text-delta` / `tool-call` 时重试会产生重复事件。）
7. 空输出（空 stream / 空 text）是否算可重试失败？
8. 错误表达的不对称要不要统一：Tool 失败是**值**，Model 失败是**异常**。`error` turn end 与 `run()` 是否还要 throw？

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
