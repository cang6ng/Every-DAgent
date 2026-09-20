<div align="center">


# Every DAgent

### One Runtime. Many Plugins. An Agent for Everyday Life.

**一个桌面原生、插件化、可扩展的个人 AI Agent。  
围绕模块化 Agent Runtime、工具调用、持久化上下文与领域插件体系构建。**

React · TypeScript · Tauri · Rust · ReAct · Tool Calling · SQLite

[English](./README.md)

</div>

---

## 项目简介

**Every DAgent** 是一个可扩展的桌面 AI Agent，核心设计思想很简单：

> 保持 Agent Runtime 足够小，通过独立的领域插件不断扩展真实世界能力。

项目不会把模型、桌面 UI 与业务逻辑耦合在一起，而是将系统拆分为清晰的几层：

- **桌面应用**：基于 React、Fluent UI 与 Tauri 构建原生桌面体验
- **Agent Runtime**：负责模型调用、Agent Loop、工具、会话、上下文与持久化
- **Domain Plugins**：承载音乐、日历、任务、个人财务等独立能力
- **Tools & Services**：作为 Agent 与真实业务数据之间的显式能力边界
- **Local Storage**：保存会话、记忆与领域数据

当前 Reference Implementation 为 **Chinook Music**，覆盖音乐检索、推荐、订单查询与长期记忆。

这个项目的长期目标并不是做一个音乐聊天机器人。

它希望探索的是：

> **如何构建一套足够小、但完整可用的个人 Agent 架构，并在不重写核心系统的情况下持续吸收新的领域能力。**

---

## Demo

> Every DAgent 当前提供 Windows 桌面应用。

<!-- 替换为最佳桌面端全窗口截图 -->

<p align="center">
  <img src="/docs/Every_DAgent_首页.png" width="900" alt="Every DAgent Desktop" />
</p>


当前桌面端支持：

- Assistant 流式输出
- Tool 执行过程可视化
- 持久化会话历史
- Agent Activity Trace
- 模型端点配置
- Sidecar 自动恢复
- 本地长期记忆

---

## 工程亮点

### 模块化 Agent 架构

Every DAgent 将 Agent 系统拆分为五个核心职责：

```text
Model Client
     ↕
Agent Loop
     ↕
Tool Registry
     ↕
Session & Context
     ↕
Persistence
```

通过这一边界，模型交互、工具执行、会话状态和存储机制可以与具体领域业务逻辑保持独立。

### ReAct 风格工具执行

Agent 可以在模型推理与工具执行之间进行迭代：

```text
用户请求
    ↓
上下文组装
    ↓
   LLM
    ↓
需要 Tool？
 ↙       ↘
是        否
↓          ↓
执行工具    回答
↓
Tool Result
↓
   LLM
```

Tool 不直接写入桌面 UI 或 Model Client。

它们通过 Agent / Domain 边界注册，并通过显式 Contract 调用。

### 插件化领域层

业务能力位于 Agent Core 之外：

```text
Every DAgent
│
├── Agent Runtime
│
└── Domain Plugins
     │
     ├── Chinook Music        ✓ 已实现
     ├── Calendar             规划中
     ├── Tasks                规划中
     ├── Personal Finance     规划中
     └── ...
```

每个 Domain Plugin 独立拥有自己的：

- Tools
- Services
- 业务规则
- 存储访问
- 领域记忆行为

Desktop Host 不需要知道音乐推荐或发票查询如何实现。

Agent Runtime 也不需要知道底层数据库结构。

### 桌面原生 Agent 架构

Every DAgent 不是简单套一层 Web UI 调用 API。

项目采用多进程桌面架构：

```text
React + Fluent UI
        ↓
Tauri IPC / Channel
        ↓
Rust Desktop Host
        ↓
stdin / stdout JSONL
        ↓
Node Agent Process
        ↓
Agent Runtime
        ↓
Domain Plugin
```

Rust Host 管理应用生命周期以及长期运行的 Agent Sidecar。

Node 进程承载 Agent 执行环境。

两者通过轻量 JSONL 协议通信，而不是 HTTP / WebSocket。

### 持久化 Session 与长期记忆

Every DAgent 中的 Conversation 是可以恢复的 Agent Session，而不是一次性的聊天消息。

当前实现支持：

- Session History 持久化
- Session 恢复
- Customer-scoped 长期记忆
- Runtime Identity 传递
- SQLite 本地持久化

领域数据与长期记忆均绑定当前用户身份。

### 可观察 Tool 执行

Agent 的执行过程不会被隐藏在一个 Loading 动画背后。

桌面端能够展示：

```text
turn/start
model/start
tool/call
tool/result
assistant/chunk
turn/end
turn/error
```

这样可以从用户请求一直观察到最终回答。

### Runtime Recovery

Desktop Host 会监控 Node Agent Process。

如果 Sidecar 异常退出，应用可以：

1. 检测异常
2. 重启 Agent Process
3. 恢复上一个 Session
4. 重新 Hydrate 桌面状态
5. 继续接收请求

从而将进程生命周期问题保持在 Desktop Host 内部，而不是泄露到业务插件层。

---

# 系统架构

<p align="center">
  <img src="./docs/Every_Dagent_Structure.png"
       width="1000"
       alt="Every DAgent Architecture" />
</p>


系统主要分为六层：

| 层级                  | 职责                                                |
| --------------------- | --------------------------------------------------- |
| **Desktop App**       | Chat UI、会话历史、Tool Activity 与设置             |
| **Desktop Host**      | 原生生命周期、IPC、Sidecar 管理与恢复               |
| **Agent Runtime**     | 模型调用、Agent Loop、Tools、Context 与 Persistence |
| **Domain Plugins**    | 独立的现实领域能力模块                              |
| **Domain Services**   | 业务逻辑与存储抽象                                  |
| **External Services** | LLM Provider 与未来第三方 API                       |

整个架构遵循一个核心原则：

> **Agent 编排留在 Runtime 中，业务行为留在 Plugin 中。**

---

# 一次 Agent Turn 如何执行

完整的数据流如下：

```text
User
 │
 ▼
React Chat UI
 │
 ▼
Tauri Command
 │
 ▼
Rust Desktop Host
 │
 ▼
JSONL IPC
 │
 ▼
Agent Process
 │
 ▼
Session & Context
 │
 ▼
LLM
 │
 ├──────────── no tool ────────────┐
 │                                  │
 ▼                                  │
Tool Call                            │
 │                                  │
 ▼                                  │
Tool Registry                        │
 │                                  │
 ▼                                  │
Domain Plugin                        │
 │                                  │
 ▼                                  │
Service Layer                        │
 │                                  │
 ▼                                  │
SQLite / External Data               │
 │                                  │
 ▼                                  │
Tool Result                          │
 │                                  │
 └──────────────► LLM ◄─────────────┘
                    │
                    ▼
             Streaming Events
                    │
                    ▼
              Desktop UI
```

Frontend 不直接访问业务数据库，也不直接调用模型。

---

# Reference Domain — Chinook Music

Chinook Music 是 Every DAgent 的第一个完整领域实现，用于验证整套架构是否能够端到端工作。

它被定义为一个 **Reference Plugin**，而不是整个项目的身份。

### 已实现 Tools

| Tool                  | 能力                        |
| --------------------- | --------------------------- |
| `search_catalog`      | 搜索歌手、专辑与歌曲        |
| `find_similar_albums` | 查找相似专辑                |
| `popular_in_genre`    | 浏览指定 Genre 下的热门音乐 |
| `list_my_orders`      | 查询当前用户订单            |
| `get_invoice_details` | 查看当前用户拥有的发票明细  |
| `remember`            | 写入用户长期记忆            |
| `recall`              | 检索用户长期记忆            |

这些 Tools 展示了三类 Agent 能力：信息检索、用户范围内的业务操作，以及长期记忆。

---

# Agent Runtime

Agent Runtime 是 Every DAgent 的架构中心。

它刻意只保留少量职责：

```text
Agent Runtime
│
├── Model Client
│     └── LLM 请求 / 响应抽象
│
├── Agent Loop
│     └── model → tool → observation → model
│
├── Tool Registry
│     └── Tool 注册与分发
│
├── Session & Context
│     └── 会话生命周期与运行时上下文
│
└── Persistence
      └── Session 与状态持久化
```

Domain Layer 被有意排除在 Runtime Core 之外。

因此同一 Runtime 可以复用于不同的个人数据领域。

### 当前 Runtime

当前稳定版本在这一 Runtime 边界内部使用 **DeepSeek Harness（DSH）** 提供模型执行、Session 与 Tool Dispatch 等能力。

而 Desktop Host、JSONL Transport、Domain Boundary、Business Services、Storage Model 与 UI Event Projection 均保持与这一具体实现解耦。

### Runtime 演进方向

后续 Runtime 将进一步收缩为一个轻量级独立实现：

```text
Model Client
Agent Loop
Tool Registry
Session Context
Persistence
```

目标不是重新造一个大型 Agent Framework。

而是只保留一个可靠的 Single-Agent 应用真正需要的最小抽象。

---

# Desktop Architecture

## Frontend

```text
React
TypeScript
Fluent UI
Vite
```

Frontend 是纯表现层。

它负责：

- Conversation Rendering
- Session Navigation
- Agent Activity Visualization
- Model Settings
- Desktop Interaction

它不承载业务逻辑。

## Rust Desktop Host

Rust Host 基于 **Tauri v2**。

负责：

- Application Lifecycle
- Agent Sidecar Lifecycle
- IPC
- Process Monitoring
- Recovery
- Local Configuration
- Windows Packaging

当前项目首先支持 Windows，同时为未来 macOS 扩展保留清晰边界。

## Agent Bridge

Desktop Host 与 Node Agent Process 之间使用：

```text
stdin  → JSONL requests
stdout ← JSONL events
```

Bridge 保持极薄。

它只负责 Transport，而不是 Business Logic。

---

# Tool & Plugin Contract

每个领域通过 Tool 暴露能力，而不是把底层存储原语直接交给 LLM。

例如：

```text
get_invoice_details(invoice_id)
```

优于直接向模型开放任意 SQL 查询。

这样 Domain Layer 可以集中实现：

- Ownership Check
- Identity Boundary
- Parameter Validation
- Stable Business Semantics
- Controlled Data Access

模型决定：

> **应该使用哪个能力。**

Plugin 决定：

> **这个能力应该如何被安全实现。**

---

# 技术栈

| 模块                 | 技术                                 |
| -------------------- | ------------------------------------ |
| Desktop UI           | React 18 + TypeScript + Fluent UI v9 |
| Build                | Vite                                 |
| Native Host          | Tauri v2 + Rust                      |
| Agent Process        | Node.js + TypeScript                 |
| Runtime Transport    | stdin / stdout JSONL                 |
| Agent Runtime        | DSH-backed runtime boundary          |
| Business Layer       | TypeScript Domain Plugins            |
| Database             | SQLite / `better-sqlite3`            |
| Testing              | Vitest + Cargo Test                  |
| Package Management   | pnpm workspace                       |
| Windows Distribution | NSIS / MSI                           |

---

# 项目结构

```text
every-dagent/
│
├── apps/
│   ├── desktop/
│   │   ├── React frontend
│   │   └── Tauri / Rust host
│   │
│   ├── agent-bridge/
│   │   └── Desktop ↔ Agent JSONL transport
│   │
│   └── cli/
│       └── CLI Agent entry
│
├── plugins/
│   └── chinook/
│       ├── tools/
│       ├── services/
│       └── memory/
│
├── profiles/
│   └── chinook/
│
├── tests/
├── docs/
└── assets/
    ├── screenshots/
    └── architecture/
```

---

# Reliability & Testing

项目在 Agent 与 Desktop 两侧都提供自动化测试。

覆盖内容包括：

- Domain Services
- Tools
- Long-term Memory
- Agent Bridge
- Configuration
- Model Listing
- Agent E2E
- Desktop Reducers
- Architecture Invariants

运行：

```bash
pnpm test
```

当前 TypeScript 测试：

```text
15 suites
207 tests
```

Rust Desktop Host 具有独立的 Cargo Test：

```bash
cd apps/desktop/src-tauri
cargo test
```

---

# 快速开始

## 环境要求

- Windows 10 / 11
- Node.js >= 22
- pnpm
- Rust stable + MSVC toolchain
- WebView2

## 安装依赖

```bash
pnpm install
```

## 初始化本地数据

```bash
pnpm bootstrap
```

该命令会初始化本地 Chinook Domain 与 Memory Storage。

## 启动 CLI Agent

```bash
pnpm chinook-agent
```

## 启动桌面端

```bash
pnpm desktop
```

## 模型配置

桌面应用提供模型设置页面。

可以配置：

- Base URL
- API Key
- Model

当前实现支持 OpenAI-compatible Model Endpoint。

Credentials 仅保存在本地，不会提交到仓库。

---

# 设计原则

### 1. Keep the Agent Core Small

只有通用 Agent 职责应该进入 Runtime。

领域知识必须留在 Runtime 之外。

### 2. Tools Are Capability Boundaries

LLM 获得的是明确的领域能力，而不是无限制数据库访问。

### 3. Context Follows Execution

Identity、Session 与 Configuration 跟随 Agent Execution Context 传递。

### 4. Plugins Own Business Rules

Runtime 负责 Orchestration。

Plugin 决定领域操作真正意味着什么。

### 5. Desktop Is a Host, Not the Agent

React 与 Rust 负责用户交互和生命周期。

它们不承载 Agent 业务逻辑。

### 6. Prefer Explicit Data Flow

Tool Call、Tool Result 与 Agent Events 尽可能显式可观察，而不是隐藏在框架内部。

---

# Roadmap

### Agent Runtime

- [x] Persistent Agent Sessions
- [x] Tool Calling
- [x] Runtime Context
- [x] Local Persistence
- [x] Streaming Execution Events
- [ ] Lightweight Standalone Agent Loop
- [ ] Independent Model Client
- [ ] Standalone Tool Registry
- [ ] Runtime-level Budget & Termination Policies

### Domain Plugins

- [x] Chinook Music
- [ ] Calendar
- [ ] Tasks
- [ ] Personal Finance
- [ ] More User-authorized Domains

### Desktop

- [x] Windows Desktop Application
- [x] Streaming Chat
- [x] Tool Activity Visualization
- [x] Session History
- [x] Model Settings
- [x] Sidecar Recovery
- [ ] macOS Support

---

# Why Every DAgent?

很多 Agent Demo 从框架开始，最后停在一个 Chatbot。

Every DAgent 尝试从相反方向出发：

```text
Real Application
      ↓
Explicit Architecture
      ↓
Small Agent Runtime
      ↓
Composable Domain Plugins
```

这个项目关注的是：

> **如何把一个 LLM Agent 真正组织成一个可维护的桌面应用。**

核心问题包括：

- Agent Loop 应该放在哪里？
- 哪些信息应该进入 Context？
- 什么东西应该暴露成 Tool？
- Identity 应该在哪里被约束？
- Desktop Host 应该如何与 Agent 通信？
- 新增 Domain 时如何避免重写整个系统？
- Runtime 可以小到什么程度，同时仍然保持可用？

Every DAgent 是对这些问题的一次工程化回答。

---

# 当前边界

Every DAgent 当前是一个工程项目和 Reference Implementation，而不是面向生产环境的多用户平台。

目前边界包括：

- Windows-first
- Local Single-user Execution
- Demo Identity，而不是生产级 Authentication
- SQLite Local Persistence
- Chinook 是当前唯一完整 Domain Plugin
- 需要用户提供可用的模型 Credentials
- Windows Installer 尚未签名

这些限制是有意保留的：项目重点是 Agent Architecture，而不是生产级 SaaS Infrastructure。

---

# Inspirations

Every DAgent 在设计与实现过程中参考和研究了多个 Agent 系统及示例：

- **DeepSeek Harness** — Agent Runtime 与 Plugin Architecture
- **pi** — Lightweight Agent / Coding-Agent Design
- **LangChain Chinook Example** — 原始 Music Domain Agent Example

项目正在从 Framework-backed Implementation 逐步演进为更轻量、可独立控制的 Agent Runtime。

---

<div align="center">


## Every DAgent

**One Runtime. Many Plugins. An Agent for Everyday Life.**

Build real Agent applications,  
not just another LLM wrapper.

</div>
