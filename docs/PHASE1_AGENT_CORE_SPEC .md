# Every-DAgent Phase 1：最小 Agent Core SPEC

> 状态：Development Spec\
> 阶段目标：Phase 1 --- 最小 Agent Core\
> 范围：Runtime + Loop + Context + Tools + Session\
> 技术方向：TypeScript；Cordis 作为宿主/生命周期基础设施；参考 DSH Core
> 设计，但不复制其产品级复杂度。

------------------------------------------------------------------------

## 1. Phase 1 目标

Phase 1 的目标不是实现完整 Agent
Framework，而是实现一个**可独立运行、可测试、可扩展的最小单 Agent
Runtime**。

完成后，即使没有 Web UI、Tauri、Chinook、Calendar
等业务插件，也必须能够独立完成：

``` text
User Input
    ↓
AgentRuntime.run()
    ↓
Session.append(user)
    ↓
ContextBuilder.build()
    ↓
ModelClient
    ↓
LLM 返回 Tool Call
    ↓
ToolRegistry.execute()
    ↓
Session.append(tool result)
    ↓
再次调用 Model
    ↓
Final Answer
    ↓
Runtime Event Stream
```

Phase 1 的核心验收标准是：**真实 LLM + 一个简单 Tool 能完成完整 ReAct
Tool Calling 闭环。**

------------------------------------------------------------------------

## 2. 项目长期阶段边界

Every-DAgent 按以下路线开发：

``` text
Phase 1
最小 Agent Core
Runtime + Loop + Context + Tools + Session

        ↓

Phase 2
Plugin Contract + PluginManager
enabled / disabled / manifest / permissions

        ↓

Phase 3
通用 Web App Shell
React + TypeScript + Vite
Chat / Sessions / Plugins / Settings

        ↓

Phase 4
Tauri Adapter
复用同一个 Web UI
封装成 Desktop

        ↓

Phase 5
不断增加 Business Plugins
Music / Calendar / Gmail / ...
```

因此 Phase 1 **禁止提前实现 Phase 2～5 的功能**。

------------------------------------------------------------------------

## 3. Phase 1 设计原则

### 3.1 单 Agent 优先

v0.1 只支持单 Agent。

只提前保留四种"接口意识"：

1.  `AgentRuntime.run(input)`：统一执行入口。
2.  `Tool.execute(input, context)`：工具拥有稳定执行契约。
3.  `Session`：独立管理会话状态。
4.  `ContextBuilder`：上下文构建可替换。

不实现 Agent Registry、Agent Manager、Subagent、Agent-to-Agent
Communication。

### 3.2 Core 保持普通 TypeScript

Cordis 用于：

-   Service 注册；
-   依赖注入；
-   生命周期；
-   Effect / dispose；
-   后续插件接入。

AgentLoop、Session、Tool 等核心对象本身应保持清晰的普通 TypeScript
结构，不把业务逻辑绑定到 Cordis API。

### 3.3 参考 DSH，而不是复制 DSH

重点参考：

-   `packages/core/agent-loop`
-   `packages/core/tools`
-   `packages/core/session`
-   `packages/core/system-prompt`
-   Runtime Context / Persistence seam

原则：

> 按问题参考源码，不按目录复制源码；保留核心思想，删除 Harness
> 产品级复杂度。

### 3.4 Provider 不重复造轮子

Core 自己定义 `ModelClient` 契约。

具体 Provider 通过 adapter 接入，优先使用 `pi-ai` 等现成模型库。

AgentLoop 不允许直接依赖 OpenAI、Anthropic、DeepSeek SDK。

------------------------------------------------------------------------

## 4. Phase 1 总体架构

``` text
                         AgentRuntime
                    Core 对外统一入口
             createSession / run / cancel / getSession
                              │
                              ▼
                         AgentLoop
                       单 Agent ReAct
                              │
             ┌────────────────┼────────────────┐
             ▼                ▼                ▼
      ContextBuilder      ModelClient      ToolRegistry
             │                │                │
             │                │                ▼
             │                │               Tool
             │                │
             └────────────┐   │
                          ▼   ▼
                         Session
                   append-only events
                   deriveMessages()

RuntimeContext 横向贯穿 Runtime / Loop / Tool：
sessionId / userId? / AbortSignal

SessionStore 与 Session 解耦：
MemorySessionStore → 第一优先
SQLiteSessionStore → Phase 1 后段
```

------------------------------------------------------------------------

## 5. 核心模块

### 5.1 RuntimeContext

职责：保存由 Runtime 控制、而非由 LLM 提供的执行上下文。

v0.1 最小字段：

``` ts
interface RuntimeContext {
  sessionId: string;
  userId?: string;
  signal: AbortSignal;
}
```

关键原则：

> LLM 控制业务参数；Runtime 控制系统上下文。

`userId` 等身份信息不得要求 LLM 作为 Tool 参数提供。

------------------------------------------------------------------------

### 5.2 SessionEvent

Session 使用简化的 append-only Event Log。

v0.1 只定义六类核心事件：

``` text
turn/start
message/user
tool/call
tool/result
message/assistant
turn/end
```

`turn/end.reason` 至少支持：

``` text
completed
max_steps
cancelled
error
```

暂不加入 DSH 中复杂的 step、checkpoint、inbox、compaction、attempt
等事件。

------------------------------------------------------------------------

### 5.3 Session

职责：

-   保存 Session ID；
-   append event；
-   返回只读事件历史；
-   将 Session Event 投影为模型可见消息。

核心能力：

``` ts
interface Session {
  readonly id: string;
  append(event: SessionEvent): void;
  events(): readonly SessionEvent[];
  deriveMessages(): ModelMessage[];
}
```

原则：

-   Event 主体 append-only；
-   不允许调用方直接修改历史；
-   Session 是会话事实记录；
-   Model Context 是 Session 的派生结果，不等同于 Session。

------------------------------------------------------------------------

### 5.4 Tool

Runtime 不理解 Music、Calendar、Gmail 等业务，只理解统一 Tool Contract。

概念接口：

``` ts
interface Tool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: unknown;

  execute(
    input: Input,
    context: RuntimeContext
  ): Promise<Output>;
}
```

LLM 可见：

``` text
name
description
inputSchema
```

Host-only：

``` text
execute()
RuntimeContext
业务 Service
数据库连接
```

v0.1 Tool 串行执行。

------------------------------------------------------------------------

### 5.5 ToolRegistry

职责：

-   Tool 注册；
-   Tool 注销；
-   Tool 查找；
-   输出模型可见 Tool Schema；
-   参数验证；
-   Tool 执行；
-   Tool Error 标准化。

概念接口：

``` ts
interface ToolRegistry {
  register(tool: Tool): () => void;
  get(name: string): Tool | undefined;
  list(): Tool[];
  execute(
    name: string,
    input: unknown,
    context: RuntimeContext
  ): Promise<ToolExecutionResult>;
}
```

建议标准结果：

``` ts
type ToolExecutionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };
```

`register()` 返回 dispose 函数，为 Phase 2 Cordis Plugin
生命周期预留接口。

v0.1 不实现：

-   parallel tool execution；
-   exclusive tool；
-   approval；
-   permission policy；
-   retry pipeline；
-   MCP。

------------------------------------------------------------------------

### 5.6 ModelClient

职责：隔离 Agent Core 与具体模型 Provider。

核心接口：

``` ts
interface ModelClient {
  stream(
    request: ModelRequest,
    context: RuntimeContext
  ): AsyncIterable<ModelEvent>;
}
```

`ModelRequest` 至少包含：

``` ts
interface ModelRequest {
  systemPrompt?: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
}
```

`ModelEvent` v0.1 至少支持：

``` text
text-delta
tool-call
done
```

后续可扩展 reasoning、usage 等，但不进入 v0.1 必选范围。

第一版真实 Provider：

-   OpenAI Compatible；
-   Anthropic。

优先通过 pi-ai adapter 实现。

------------------------------------------------------------------------

### 5.7 ContextBuilder

职责：决定每次模型调用看到什么。

接口概念：

``` ts
interface ContextBuilder {
  build(input: {
    session: Session;
    tools: ToolRegistry;
    context: RuntimeContext;
  }): Promise<ModelRequest>;
}
```

`DefaultContextBuilder` v0.1 只负责：

``` text
System Prompt
+
Session.deriveMessages()
+
Tool Schemas
```

v0.1 不做：

-   Context Compaction；
-   RAG；
-   GraphRAG；
-   Long-term Memory Retrieval； -复杂 Tool Filtering。

保留 ContextBuilder 接口是为了以后增加这些能力时不修改 AgentLoop。

------------------------------------------------------------------------

### 5.8 AgentLoop

AgentLoop 是 Phase 1 的核心编排器。

采用单 Agent ReAct：

``` text
Build Context
      ↓
Call Model
      ↓
Tool Call ?
  ┌───┴────┐
 No       Yes
 │         │
Final    Execute Tool
Answer      │
 │       Append Result
 │         │
结束 ←── Next Step
```

核心行为：

1.  从 ContextBuilder 获取 ModelRequest；
2.  调用 ModelClient；
3.  消费 Streaming ModelEvent；
4.  若得到最终文本且无 Tool Call，结束 turn；
5.  若得到 Tool Call，按顺序调用 ToolRegistry；
6.  将 tool/call 与 tool/result 追加到 Session；
7.  重新构建 Context；
8.  进入下一 step；
9.  超过 `maxSteps` 时强制终止。

默认：

``` text
maxSteps = 12
```

v0.1 不实现 Planner / Plan-and-Execute / ToT / Workflow。

------------------------------------------------------------------------

### 5.9 AgentRuntime

AgentRuntime 是 Core 对外 Facade。

建议最小 API：

``` text
createSession()
run(...)
cancel(...)
getSession(...)
```

`run()` 对外输出 Runtime Event Stream，而不是只返回最终字符串。

建议：

``` ts
AsyncIterable<RuntimeEvent>
```

至少支持：

``` text
assistant/chunk
tool/call
tool/result
turn/end
```

这样 Phase 3 Web App 可以直接消费 Runtime Events，而不理解 AgentLoop
内部实现。

------------------------------------------------------------------------

### 5.10 SessionStore / Persistence

Session 与 Persistence 解耦。

概念接口：

``` ts
interface SessionStore {
  create(...): Promise<void>;
  load(sessionId: string): Promise<Session | null>;
  append(
    sessionId: string,
    events: SessionEvent[]
  ): Promise<void>;
}
```

开发顺序：

1.  `MemorySessionStore`；
2.  Core 闭环稳定；
3.  再实现 `SQLiteSessionStore`。

SQLite 不得阻塞最小 ReAct Core 的完成。

------------------------------------------------------------------------

## 6. Streaming、Retry、Cancel 与错误

### Streaming

Streaming 是 v0.1 第一等能力。

内部尽量统一走 Streaming 路径，不维护两套完全独立的模型执行逻辑。

### LLM Retry

简单重试 2～3 次即可。

不实现：

-   provider fallback；
-   circuit breaker； -复杂路由。

### Tool Error

Tool 异常由 ToolRegistry 标准化为失败结果，并作为 Tool Result 提供给
LLM，使模型能够决定如何向用户解释或继续行动。

### Cancel

使用 `AbortSignal`。

ModelClient 和 Tool 都应能够获得同一个 RuntimeContext.signal。

------------------------------------------------------------------------

## 7. Phase 1 Non-Goals

以下全部明确不属于 Phase 1：

``` text
PluginManager
Plugin manifest
Plugin enabled / disabled
Plugin permissions

MCP Client / Server
Skills
Subagent
Multi-Agent
Planner
Plan-and-Execute
ToT
Workflow Engine
Graph Runtime

Web UI
React App
Tauri

Business Plugins
Music / Calendar / Gmail / Finance

Context Compaction
Semantic Memory
Vector Database
GraphRAG

Browser
Shell
Code Interpreter

复杂 Permission Sandbox
Human-in-the-loop Approval
Hot Reload
Distributed Execution
Cloud Runtime
```

长期记忆若未来进入系统，应优先作为 Tool / Plugin 能力，而不是写死进
AgentLoop。

------------------------------------------------------------------------

## 8. 推荐目录

``` text
packages/
└── agent-core/
    ├── src/
    │   ├── runtime/
    │   │   ├── agent-runtime.ts
    │   │   ├── runtime-context.ts
    │   │   └── runtime-event.ts
    │   │
    │   ├── loop/
    │   │   └── agent-loop.ts
    │   │
    │   ├── model/
    │   │   ├── model-client.ts
    │   │   └── pi-ai-client.ts
    │   │
    │   ├── tools/
    │   │   ├── tool.ts
    │   │   └── tool-registry.ts
    │   │
    │   ├── session/
    │   │   ├── session-event.ts
    │   │   ├── session.ts
    │   │   └── session-store.ts
    │   │
    │   ├── context/
    │   │   └── context-builder.ts
    │   │
    │   └── index.ts
    │   │
    │   └── adapters/
    │       └── cordis/              # 若实际接入需要，可后置
    │
    └── tests/
```

目录允许根据现有仓库结构微调，但模块边界不要随意合并。

------------------------------------------------------------------------

## 9. 开发里程碑

### P1.1 --- Core Contracts

实现：

``` text
RuntimeContext
RuntimeEvent
SessionEvent
Session
Tool
ToolRegistry
ModelClient
ContextBuilder
```

暂不实现 AgentLoop。

要求：

-   typecheck 通过；
-   单元测试通过；
-   API 保持最小；
-   不提前加入未来字段。

建议 commit：

``` text
feat(core): define runtime contracts
```

### P1.2 --- Minimal ReAct Loop

增加：

``` text
AgentLoop
AgentRuntime
FakeModelClient
FakeTool
```

Fake Model 第一次返回 Tool Call，第二次返回 Final Answer。

必须跑通：

``` text
User
→ Fake Model
→ Tool Call
→ ToolRegistry
→ Fake Tool
→ Tool Result
→ Fake Model
→ Final Answer
```

建议 commit：

``` text
feat(core): implement minimal react loop
```

### P1.3 --- Runtime Engineering

增加：

``` text
maxSteps = 12
AbortSignal
Runtime Event Streaming
Tool Error normalization
LLM Retry
Session append-only tests
```

重点验证异常和边界条件。

### P1.4 --- Real LLM

实现：

``` text
PiAiModelClient
OpenAI Compatible
Anthropic
```

要求 AgentLoop 不出现任何具体 Provider 逻辑。

### P1.5 --- Persistence & Real E2E

先 MemorySessionStore，再视进度实现 SQLiteSessionStore。

最后使用真实 LLM + 简单 Calculator Tool 做 E2E。

------------------------------------------------------------------------

## 10. Definition of Done

Phase 1 必须至少验证：

``` text
✓ 普通对话
✓ 单次 Tool Call
✓ 连续多步 Tool Call
✓ Tool 报错
✓ LLM 报错并简单 Retry
✓ maxSteps 生效
✓ 用户 Cancel
✓ Session History 正确
✓ deriveMessages 正确
✓ Streaming 正确
```

最终真实 E2E：

``` text
User:
“Use the calculator tool to calculate 21 × 2.”

        ↓
AgentRuntime
        ↓
真实 LLM
        ↓
tool_call: calculator({ a: 21, b: 2 })
        ↓
ToolRegistry
        ↓
CalculatorTool
        ↓
42
        ↓
Session
        ↓
真实 LLM
        ↓
“The result is 42.”
        ↓
turn/end
```

达到以上条件即认为 **Phase 1 完成**。

不要求 Web UI、Tauri 或业务 Plugin 才算完成。

------------------------------------------------------------------------

## 11. 规模约束

Agent Core production code（测试、第三方依赖、业务插件不计）：

``` text
目标：约 1500 LOC
警戒：约 2500 LOC
上限审查点：3000 LOC
```

如果 Phase 1 明显超过 3000 LOC，应暂停新增功能，检查是否引入了 DSH
的产品级复杂度或提前实现后续 Phase。

------------------------------------------------------------------------

## 12. 开发约束

1.  不修改 Phase 1 之外的产品架构。
2.  不为了"以后可能需要"提前增加抽象。
3.  不重复实现成熟 Provider SDK/协议。
4.  AgentLoop 不依赖具体业务 Tool。
5.  AgentLoop 不依赖具体 LLM Provider。
6.  Session 与 Context 分离。
7.  Session 与 Persistence 分离。
8.  Tool 的业务输入与 RuntimeContext 分离。
9.  先 Fake Model/Fake Tool，再接真实模型。
10. 每个里程碑完成后先测试和 review，再进入下一阶段。
11. 参考 DSH 时记录借鉴点；不要无选择复制大段产品代码。
12. 若直接复用第三方源码，遵守原项目 License 与 attribution 要求。

------------------------------------------------------------------------

## 13. Phase 1 最终一句话

> Every-DAgent Agent Core v0.1 是一个基于 TypeScript、由 Cordis
> 承载生命周期与服务组合、通过统一 ModelClient 接入模型、以 append-only
> Session 保存事实、以可插拔 ContextBuilder 构造上下文、通过
> ToolRegistry 执行业务能力，并由最小 ReAct AgentLoop 驱动的单 Agent
> Runtime。
