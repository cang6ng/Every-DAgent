# Every-DAgent Phase 4 — Durable & Safe Runtime SPEC

> 状态：P4.0 Architecture Freeze **COMPLETE / FROZEN**。
> Independent SPEC Review：**PASS — 0 BLOCKER / 0 MAJOR / 0 MINOR；READY TO FREEZE P4.0: YES**（用户确认）。
> 当前授权：**P4.0 freeze only**，仅两份 Phase 4 文档的冻结、独立提交与正常 push；不授权 M1–M5 implementation、`/goal` 或依赖安装。
> 阶段状态与基线见 [PHASE4_HANDOFF.md](./PHASE4_HANDOFF.md)。本文规定目标跨层契约，不声称代码已实现。

## 1. 规范地位与设计输入

### 1.1 输入与优先级

设计输入是用户批准的最新版《Every-DAgent Phase 4 Master Plan》（工作流 `dwfrun-1b3e5341-cfce-4386-b9bb-943131d6f201` 的最终 `phase4-plan`，26,141 bytes，SHA-256 `1d047087ddb8b226d4771cabbfa137917d6d5005a6c953b5517eb8a7b3640a4c`），不是更早的全量 snapshot／累计历史容量上限草案。该计划是会话产物，不虚构仓库内计划文件。

用户随后批准的六条补充约束优先：

1. Canonical Session 只包含完整 settled turn；crash 不提交半成品 assistant/tool execution。
2. Previous-host unfinished Run 在 startup reconciliation 后为独立的 `interrupted`。
3. Pending approval 不跨 Host restart 保留执行能力；同一 hostInstance 重连可继续有效审批，换实例后旧 prepared execution 与 reply 必须失效。
4. 不承诺跨进程 tool exactly-once，不恢复 tool execution，不引入 durable workflow。
5. Provider/model construction 留在 trusted composition boundary；Host provider-neutral，不直接依赖 provider implementation。
6. Node 24.x／`node:sqlite` 是当前支持与测试基线，不是永久平台上限。

本文“必须／不得”是验收约束。逻辑实体、身份、状态、事务和 public/wire 语义是规范；SQL 表名、helper、类名、目录拆分与具体存储算法不是架构法律。接口命名若仅为概念会明确标注；§14 的 operation/event 名称及语义是 v2 契约。

### 1.2 继承与明确替代

继承 [Phase 3 SPEC](./PHASE3_PLATFORM_SPEC.md) 的分层、JSON、ownership、取消、通信及通用渲染原则；Phase 1/2 的 Runtime/Loop 职责、工具生命周期协调继续成立。仅 §14–§15 列出的增量／破坏性变化替代对应旧契约，不追溯改写 Phase 1–3 历史文档。

代码基线仍为 Phase 3 sealed implementation。当前实际 `host.describe` 的 reverse 机制 capability 为 true，但 production reverse 业务 registry 为空（`packages/host/src/dispatch.ts:67-79`）。Phase 3 HANDOFF 的 reverseRequests=false 历史表述不用于推导 v2；本轮不修改或重新审查旧文档。

## 2. Scope / Non-goals

### 2.1 必须交付

- Durable State：完整已提交历史、Session metadata、Run、submission 去重、启动 reconciliation。
- Context Budget：每次模型请求有界，包括 system、工具定义、消息、结果和输出预留。
- Persistent Configuration：非秘密 settings、插件 desired state/configuration，以及独立 credential seam。
- Tool Policy / Minimal HITL：真实执行前 allow / deny / require-approval。
- Small Session UX：title、updatedAt、rename、delete、必要历史分页、最小 settings/approval 展示。

**长期保存与必要分页属于本阶段必交付能力。**不以累计历史事件数、总历史字节数、Session 数或 Run 数的固定产品上限强迫清理。现实上仍受可用磁盘、有限序号表示与资源容量约束；耗尽时诚实失败，不能回绕身份或自动删历史。

### 2.2 明确非目标

不做 multi-session concurrent runs、long-term Memory、Memory RAG、Scheduler、background tasks、Workflow engine、durable workflow、Multi-Agent、Agent-as-Tool、Files/Artifacts、Rich Plugin UI、MCP Apps、AG-UI integration、marketplace、plugin install/update、multi-user/accounts、Desktop/Tauri、full credential vault、OAuth、复杂 tracing。

也不做运行续接、自动模型／工具 replay、逐工具 durable checkpoint、跨进程 exactly-once、LLM summary、archive/folder/tag/favorite/pin/trash、fork/unblock、完整历史导出或备份管理产品。有限历史窗口不是 Memory，审批等待不是 workflow。

## 3. Architecture Decisions

| ID | 冻结的目标决定 | 规范落点 |
| --- | --- | --- |
| P4-AD-01 | Host 拥有 durable truth 与业务事务；Core 不依赖 Node/SQLite | §5–§7、§15 |
| P4-AD-02 | Canonical 只提交完整 settled turn；Run admission 独立持久化；不持久恢复执行 | §6–§8 |
| P4-AD-03 | 正式新增 interrupted；区分 not-started 与 unknown，后者默认 blocked | §8、§14 |
| P4-AD-04 | 完整事实长期留库，Core 显式有界窗口，读取／缓存／传输不随全历史增长 | §9–§10 |
| P4-AD-05 | Protocol v2 联动升级；分页、coverage、terminal summary 是显式契约变化 | §9、§14 |
| P4-AD-06 | 最终模型请求逐次预算校验，output reserve 必须落实真实 provider cap | §10 |
| P4-AD-07 | Settings 与 credentials 分离；设置通过受信 composition 实际构造模型 | §11 |
| P4-AD-08 | Plugin registered、desired enabled、actual lifecycle、configuration 分离 | §12 |
| P4-AD-09 | 整组 pre-log 验证、prepared binding 与 awaited pre-execution policy gate | §13 |
| P4-AD-10 | Approval 归 Host；delivery 归连接；只允许同 hostInstance 的有效执行能力 | §13–§14 |
| P4-AD-11 | 端到端按实际编码字节闭合；单项上限不成为累计历史上限 | §16 |
| P4-AD-12 | 当前 durable backend 使用 node:sqlite；本地盘单 Host、原子事务、排他写 ownership | §17 |
| P4-AD-13 | 明确 ephemeral 与 durable 模式；durable 失败不得静默降级内存 | §5、§17 |
| P4-AD-14 | Node 24.x 为当前测试基线而非永久上限；新增第三方生产依赖为零 | §17 |
| P4-AD-15 | 最小 UX；delete 不撤销副作用、不安全擦除，保留最小 submission tombstone | §9、§14、§18 |

批准 Master Plan 中 Host 事务、turn-batch/no-resume、interrupted、v2、窗口／分页、encoded-byte、factory、pre-execute HITL 均由上表承接。计划的具体 SQL/文件布局不提升为法律；其中 Node `<25` 的永久上限解释由用户补充约束明确排除。

## 4. Platform Laws / Invariants

1. **Small independent Kernel**：Core 无 Host、Plugin、Protocol、provider SDK、UI、Node/SQLite 依赖。
2. **Independent Protocol**：Protocol 无 Core/Plugin/provider/React 类型依赖，包括 type-only import。
3. **Host authority**：Session、Run、持久提交、审批、政策及插件协调由 Host 决定；UI 不执行工具。
4. **Presentation truth**：Client React-free；ClientSnapshot 是 UI presentation truth，不是数据库真源。
5. **事件分层**：RuntimeEvent != SessionEvent；live != canonical；UI 不能把 draft 或旧 live 写成 canonical。
6. **Settled publication**：观察到 turn/end 不等于 iterator settled；settled 不等于 durable committed；terminal/canonical 成功发布必须在提交确认后。
7. **状态诚实**：accepted != completed；cancel requested != stopped；unknown != failed；interrupted != completed/ordinary failed。
8. **序号诚实**：窗口不能重编号；partial history 不能伪装完整；stream sequence、Session seq、revision、cursor 不互相替代。
9. **执行前授权**：批准必须先于真实 tool invocation；观察事件或 UI 按钮不能代替 await gate。
10. **不恢复执行**：持久事实不是 continuation；重启不能重构旧 tool call 后执行。
11. **无通信重放**：通信层不得自动 replay 非幂等 writes，包括 approval reply、run start、rename/delete/settings/plugin 变更。
12. **取消无回滚**：abort 不证明副作用未发生；执行 lease 在真实执行 settle 前不得释放。
13. **概念分离**：Plugin permission != approval != sandbox；capability 也不是授权。
14. **JSON 与深隔离**：wire 必须严格 JSON/runtime validation；受管执行输入在日志与执行之前形成 owned JSON snapshot。
15. **安全错误**：外部异常不直接成为持久／wire 错误；无 stack/cause/header/body/credential 的透传。
16. **Generic fallback first**：无需富 UI 的普通工具、配置状态和审批均可通用展示。
17. **扩展边界**：AG-UI、MCP、MCP Apps 仍只是 future adapters；不成为内部真源。
18. **资源有界不删事实**：限制一次运行／读取／发送／缓存，不自动截断或淘汰已提交历史。

## 5. Durable State Ownership / Layer Responsibilities

| 层 | 拥有 | 不拥有 |
| --- | --- | --- |
| Core Session / Runtime / Loop | 当前窗口事实、真实 seq/time、turn 边界、ReAct、工具输入准备和 awaited execution seam、模型请求 guard | durable transaction、Run terminal authority、SQL、approval UI/provider construction |
| Core SessionStore | 既有 create/load/append 及 Memory 实现，可继续独立用于测试 | 跨 Session/Run/Settings 的业务事务 |
| Host repository boundary | admission/start/terminal 原子性、完整事实、索引／分页、CAS、reconciliation、tombstone | provider/tool 外部副作用的原子提交、执行续接 |
| Host | repository 调用顺序、Run/Session authority、执行 lease、policy/ApprovalRecord、投影与启动 readiness | provider implementation、凭据解析、浏览器状态 |
| Trusted composition | provider/model/catalog、CredentialProvider、可信插件注册、grants、tool policy、路径／endpoint 信任配置 | 绕过 Host 的产品执行入口 |
| SQLite backend | 实现存储契约、schema version、排他 ownership、耐久事务 | Core 模型语义、Client presentation |
| Client | 不可变、有界的目录/Run/history coverage、同步、审批展示及 reply 关联 | canonical 修复、执行权、凭据、持久真源 |
| Web | 经 Client 的最小交互、草稿和本地选择、通用安全文本渲染 | 另造 Host 状态、直接 fold wire events、直接调工具/provider |

新 Host repository 是业务持久边界，不强塞进旧 Core SessionStore，也不复用 `HostOptions.storage` 的 plugin-scoped KV 含义。必须有 memory 与 durable 等价业务契约测试；旧 MemorySessionStore 保留。

Durable 启动是异步 readiness 边界，顺序语义为：取得同一存储的独占 ownership → 检查／迁移 schema → 读取并校验非秘密 desired settings → 通过受信 composition 构造 execution dependencies → 校验 limits／预算 → reconciliation 与插件恢复 → ready。上述必要步骤全完成前不得接纳 Run。

Composition callback 接收不可变的 HostSettings、ModelSettings、settingsRevision，返回 provider-neutral ModelClient、可选 ContextBuilder 和资源释放能力。名称／参数组织可等价实现，不能把 provider SDK 类型引入 Host。Callback 返回前失败由 composition 清理其资源；成功返回后由 Host 接管释放，后续失败按依赖逆序关闭，数据库最后释放。不得因设置构造失败回退旧模型或空内存库。

明确 ephemeral 模式可继续用于测试／替换证明；它必须如实宣告 host-lifetime retention。Durable 模式失败不能偷偷变为 ephemeral。

## 6. Persistent Data Model（逻辑实体，非 SQL schema）

| 实体 | 必须保存的事实 |
| --- | --- |
| Storage identity/schema | 稳定 storageId、schema version；hostInstanceId 不作为可复用执行身份恢复 |
| Session metadata | 永不复用的 sessionId/generation、title、createdAt、updatedAt、metadata revision、historyRevision、committed nextSeq、高水位、ready/blocked 及安全原因、activeRunId |
| Canonical event/turn | 完整 versioned SessionEvent（原 seq/time/turnId/payload）、完整 turn 边界与可定位索引；不可从 UI 字符串反推模型事实 |
| Run | runId、submissionId、session identity、原接受输入、接受/开始/结束时间、所属 hostInstance、accepted/running/terminal、cancelRequested、turnId（若已知）、安全终态原因、提交 identity 与关联的已提交历史范围 |
| Submission dedup | storage 内唯一 submissionId、原 session/input 身份及对应 Run；删除后最小 retired tombstone |
| Settings | schema/version、revision、HostSettings/ModelSettings 的非秘密 desired 值 |
| Plugin desired/config | registered pluginId namespace 下 desiredEnabled、版本化非秘密 config、revision；不伪造 installed |
| Plugin KV | 既有 storage permission 控制的插件命名空间数据；不与 settings/credential 接口混为一物 |

Canonical 只包含完整 settled turn。Settled 不只指 completed：正常收敛且结构完整的 limited/cancelled/model-error turn 可提交；因 Host fault、崩溃或结构失败而不完整的 suffix 不可提交。Core 内存窗口中的未提交日志不是 durable canonical。

不持久为可恢复执行能力的对象：AbortController、lease/token、connection/stream、水位对应的 event buffer、live draft、prepared executor/receiver/closure、pending resolver、approval delivery。也不直接保存 ClientSnapshot、React state、加载页缓存、显示截断内容作为 canonical。

ApprovalRecord 的 authority 是当前 Host 内存；本阶段不提供跨重启可恢复审批队列。可持久的 Run 终态／安全摘要不含可调用能力。Restart 后可看到 interrupted Run，不会看到能执行旧工具的 pending approval。

逻辑完整性：Session 事件 seq 唯一连续；turn 边界可证明闭合；historyRevision 只在新增 canonical turn 时增长；metadata revision 在相关 metadata/状态改变时增长。时间用于展示，revision/seq 用于一致性；不因系统时钟回退回绕 seq 或把 updatedAt 变小。

## 7. Transaction Boundaries

### 7.1 Admission、开始与终态

| 边界 | 原子写入 | 后置规则 |
| --- | --- | --- |
| Session create | identity、初始 metadata、空 history high-water | 确认提交后返回；不复用旧 identity |
| Admission | submission identity、accepted Run、Session activeRunId/revision | commit 确认后才返回 accepted 并允许后续启动；canonical 无 user message |
| Start | accepted → running 的持久 marker | marker 确认前不得调用 Runtime/model/tool |
| Terminal success of storage | 全部新增完整 turn events、turn index、Run terminal、Session history/revision/updatedAt、清 activeRunId | 等 iterator settle、验证完整 suffix 后一次提交；确认后发布 terminal 与新 high-water |
| Host fault after execution | 安全 failed/host_error Run、blocked 原因、清 activeRunId | 仅存储可用且执行已 settle 时提交；旧 canonical 不变；不能伪造完整 turn |
| Cancel intent | Run cancelRequested 及相关 revision | 请求 abort 与持久意图分别如实处理；返回意图不是 stopped；不清 activeRunId 或提前释放 lease |
| Startup reconciliation | 前实例 unfinished → interrupted、清指针、Session ready/blocked | 幂等、完成后才 ready；不追加伪造 turn/end |
| Rename / delete / settings | 对应 CAS、关联事实与 revision | 全成或全不成；提交后发布 |

Runtime 内先记录 user/assistant/tool-call/tool-result，只是该次执行的 tentative suffix。**执行途中不单独把 user、assistant、tool result 提交到 canonical。**接受输入已在 Run 中持久化，crash 后不会把它误标为已完成对话。

Tool effect 不属于数据库事务。不得持有数据库写事务等待模型、用户审批或工具。禁止声称 SQLite rollback 可以撤销外部工具。

### 7.2 Commit 不确定与存储失败

- 每个业务提交具有可识别的 commit identity 与预期 revision/seq；相同完整批可核对或幂等重试存储，不重跑 Runtime/tool。
- COMMIT 回执异常不直接证明 rollback。先在同一 repository 查询事实；已提交则恢复原结果，确定未提交才能重试相同存储批。
- 无法确认时停止新写入／新执行，不发送虚假 completed/failed 终态；连接失效由 Client 表示 unknown。数据库重新可读后依提交事实恢复。
- 持久 start marker 成功而 terminal 未提交，即使进程曾观察 completed，重启也只能 interrupted/unknown。
- 不能因序号不匹配覆盖已有记录，不能补洞、重新编号、自动清库或换库掩盖错误。
- 存储故障不得阻止对仍在运行执行请求 abort；未持久确认的 cancelRequested 不冒充 durable 成功，Client 可见失败／unknown。cancel 与 terminal 竞争不能把已提交终态改回 running；实际执行未 settle 前不释放 lease。

## 8. Crash / Restart / interrupted Semantics

### 8.1 终态定义

RunStatus 新增 `interrupted`；对应 endReason 为 `interrupted`、live 为 null，附 `executionKnowledge: not-started | unknown` 和安全 restart 原因。它不是 Core TurnEndReason，不向 Core 添加虚构的 crash turn/end。

- `not-started`：只有 committed accepted 且没有 committed running marker，才可证明 Runtime 未启动。清 activeRunId，Session 可保持 ready，后续新 Run 需新 submission。
- `unknown`：已有 running marker 而无已提交 terminal；无法从停机前内存、日志文字或 UI 判断副作用。Session 默认 blocked，只可读／rename／delete，不继续执行；本阶段无 unblock API。
- 已提交 terminal 永不因重启降为 interrupted。interrupted 不会在查询时自动变 completed，不恢复执行。

### 8.2 每个崩溃点的确定解释

| Crash point | 重启后的 durable 结果 | Canonical / 执行 |
| --- | --- | --- |
| admission commit 前 | 无已提交 Run | 原 canonical；从未允许执行 |
| admission commit 回执未知 | 按数据库是否有提交判定，无记录或 accepted | 不因重发请求执行第二次 |
| accepted commit 后、start commit 前 | interrupted / not-started | 原 canonical，Session ready |
| start commit 后、Runtime/工具前 | interrupted / unknown | 原 canonical，blocked；marker 是保守边界 |
| assistant streaming / assistant 已在内存完成 | interrupted / unknown | 不保存半成品 canonical，不从 chunk 拼历史 |
| pending approval / 已批准但尚未派发 | interrupted / unknown | 旧 approval 和 prepared capability 消失；不重构工具调用 |
| tool execution 中 | interrupted / unknown | 副作用可能发生；不 replay |
| tool 已返回，result 未写内存或未提交 | interrupted / unknown | 不猜测成功/失败；原 canonical |
| turn/end 已产生但 iterator 未 settle | interrupted / unknown | end != settle；不提交该 turn |
| iterator 已 settle，terminal commit 前／事务 rollback | interrupted / unknown | 整批不进入 canonical |
| terminal commit 成功，通知/应答丢失 | 恢复原 terminal 和对应完整 turn | query/resync 可证实；不重新执行 |
| reconciliation 中再次 crash | 下次幂等完成同一恢复 | 不能重复改历史或恢复 execution |

即使 pending 时实际上尚无工具副作用，若 running marker 已存在也保守为 unknown；这不是宣称工具已经执行。

Startup 必须获取独占存储 ownership，生成新的 hostInstanceId，校验 schema 与恢复结构，处理所有 previous-host unfinished Run，完成后才 ready。storageId 不变不意味着 hostInstance 不变。损坏／迁移失败／不能确定终态时不提供可写 ready Host，不删库重建。

恢复结构校验必须识别非法 seq、turn closure、tool pairing、Run/history 关联；启动不要求将全历史加载进内存。可利用持久索引并在有界读取时校验；不得把未扫描的全部历史宣称已逐项验证。发现损坏明确隔离／拒绝使用该事实，不能静默丢弃或修复为成功。

## 9. Pagination / History Coverage / Session UX

### 9.1 Core 执行窗口

保留完整 `restoreSession` 从 seq=0 恢复的契约。新增显式窗口能力，携带 session identity、baseSeq、nextSeq 与已加载的连续完整近期 turns；窗口必须是 committed history 的连续后缀并接至当前 nextSeq，空窗口可 baseSeq=nextSeq。

窗口 append 使用真实 nextSeq，不从窗口数组长度重新编号；Host 仅提交本次新增 suffix。窗口 events/deriveMessages 只表示 loaded window，不宣称整个 Session。Host 启动与每个 Run 都不得先全量 restore 再截断；通过 turn 边界索引有界倒序读取，遇到放不下的旧 turn 停止，不跳过它继续全库搜索。运行结束释放窗口。

### 9.2 历史页：固定 fence

历史页身份包含 storageId、sessionId/generation、historyRevision、固定的 exclusive `fenceSeq`（首次请求时 committed nextSeq）、方向和不透明 cursor。响应必须报告覆盖区间、稳定 item identity、继续 cursor、是否到达该 fence 的两端；范围统一采用半开区间。

- 后续页只读取同一 fence 内不可变事实。追加新 turn 不使旧 fence 失效；rename 不改变 historyRevision，也不使历史 cursor 失效。
- 页面可以在 turn 内分段，必须保留 turn/occurrence/seq 或等价稳定定位与边界标志；片段不能称完整 turn。UI canonical item 是事件投影，过滤非展示事件不能让 coverage 出现伪造缺口。
- 模型历史读取走完整 turn 语义，不消费 UI 页缓存。UI 页读完不代表适合作为模型上下文。
- 删除使旧 generation/cursor 无效，返回 SESSION_NOT_FOUND；不能指向另一个 Session。无 Session identity 重用。
- cursor 必须绑定读取范围并校验，不能靠客户端篡改扩大权限或越过 fence；不要求长事务、服务器永久保存 cursor 或通用签名框架。

### 9.3 目录／Run 页：revision 与 keyset

Session 目录和 Run 列表采用稳定全序 keyset（时间排序必须有唯一 ID tie-breaker）与 collection revision。rename/admission/terminal/delete 等影响成员或摘要的写入更新对应 collection revision。旧 cursor 遇到 revision 改变返回 STALE_CURSOR；Client 重读，不拼接混合版本为完整目录。每页是短一致读取，不跨请求持有数据库事务。

持续变更时不保证一次遍历总能无重试完成，但不会静默漏项后宣称完整。缓存只保留有限窗口；旧记录留库。

### 9.4 Client coverage 与 resync

ClientSnapshot 至少区分：known Session summary、当前 history high-water/revision、loaded fence、已覆盖区间、gap、是否到达边界、stale/invalidated、live。未加载 != 不存在；某页为空 != 整个 Session 无历史；旧 fence 全覆盖 != 当前 high-water 全覆盖。

订阅 snapshot 是有界当前状态 cut，不是全库副本。terminal 原子更新 Run summary 与 Session high-water，并清除对应 live；新 canonical 尚未加载时展示明确 loading/gap，不用 live 补齐。

重连／gap 重新 snapshot；同 storage 的不可变页仅在重新核对 generation、高水位与有效性后可复用。新 hostInstance 一律清旧 live、审批投递和执行相关 pending。读请求可按 scope/epoch/revision 丢弃过时应答；通信写入不得自动重发。删除立即失效该 Session 缓存，迟到页不得复活它。

### 9.5 Small Session UX

title 使用确定性默认值，不调用 LLM 生成；rename 必须是有界非空文本并以预期 metadata revision 做 CAS。updatedAt 由 Host 维护：create、admission、terminal/reconciliation、rename 更新；读取／单个 streaming chunk 不刷新。

delete 是显式用户操作，不做 archive/trash。活动 Run／未释放 execution ownership 的 Session 不可删除；不得把 delete 偷换为 cancel。删除事务移除该 Session 的历史、Run 与目录事实，并使 generation 不可复用；保留最小 submission tombstone 防止旧 submission 再执行。删除后旧查询返回 not-found/retired，不泄漏原输入。

删除不撤销外部副作用、不安全擦除文件；UI 必须说明不可恢复的产品语义并确认。blocked Session 可读／rename／delete；新建 Session 不继承旧 prepared capability。

## 10. Context Budget Contract

### 10.1 输入与保证

ModelClient 必须提供 provider-neutral、有限且有效的 contextWindow 与 maxOutputTokens 能力信息。模型限额由 composition/adapter 解析；Core 不自行联网猜测型号。未知／不可信限额不得默认为无限。

每个 ModelRequest 必须包含本次有效 maxOutputTokens；ContextBuilder 获得 budget。最终发送前必须满足：

```text
estimatedInput + reservedOutput R + safetyMargin S <= contextWindow C
0 < R <= modelMaxOutputTokens
```

默认 R=min(4096, modelMaxOutputTokens)，S=max(1024, ceil(0.1*C))；经校验 settings 可选择更小合法 R。固定开销已耗尽输入空间时，在 model 调用前明确失败。

首版 estimator 使用保守的 UTF-8 字节成本及 adapter 声明的 framing 开销，而非英文字符/4 的乐观假设。必须包含 system、工具名/描述/schema、role/framing、文本、arguments、tool results 与标记。相同冻结请求的估算必须确定、可测。

**保证的是有限请求、明确估算不变量及实际输出 cap，不是任意 provider 的真实 token 数数学精确。**10%/1024 margin 不是未知 tokenizer 的严格上界；backend 不兼容或 provider 拒绝 context 时，安全结束该请求，不无限重试。未来 tokenizer/compaction 可以替换选择／估算策略，但不能修改 canonical 或跳过最终 guard。

### 10.2 选择与超限

- system 与 tool schemas 不做静默语义截断；固定部分超限则失败。
- 当前 user/current turn 必须结构合法且保留；旧历史选连续完整 turns 后缀，按整体移除最旧 turn，不拆 assistant/tool 配对。
- 单个近期旧 turn 放不下时允许窗口更小甚至无旧历史；这不删除存储。
- tool result 只可在模型专用副本中显式标记截断，不改 canonical；仍不能容纳当前 turn 时失败，不删除调用身份或伪造结果。
- 当前 user 不截断；输入过大在 admission 前拒绝。assistant/tool-call 参数不能通过截断成为另一个有效请求。
- 首次、每次 follow-up、每次 retry 发送前均通过 guard；custom builder 不能绕过。retry 使用同一不可变语义请求，不重跑工具。
- 确定性预算／结构／output-cap 不支持错误不可作为 transient failure 重试。

每个 provider 请求实际 output cap 不得大于 R；若 SDK 抬高 minimum、忽略字段或不能兑现，就拒绝该运行 profile，不以 adapter mock 通过代替实际请求体验证。

运行 profile 还必须有有限的 steps、每 step 调用数量、单项尺寸及当前 turn 暂存总量预算；这些是单次资源预算，不是全历史容量上限。生成超过边界时在派发对应工具前拒绝；已执行工具的异常结果按 §7/§16 处理。不能因无限追加当前 turn 而绕过“历史窗口有界”。本阶段无 LLM summary 或递归 compaction。

## 11. Settings / Credential Boundary

### 11.1 普通 settings

| Namespace | 持久配置 | 不接受 |
| --- | --- | --- |
| HostSettings | system prompt、context 预算策略、有限请求/审批超时等已定义非秘密值 | DB 路径、grants、可执行 policy、任意模块加载 |
| ModelSettings | provider、baseURL、model、已声明且受支持的参数（如 temperature、output reserve、timeout） | apiKey/token、authorization header、任意 SDK option bag、secret URL |
| PluginSettings | pluginId namespace、desiredEnabled、版本化且经可信插件 schema 校验的非秘密 config | 安装包位置、代码、权限自授、credentials |

provider/model 必须属于 composition 允许的 catalog；baseURL 必须满足 composition endpoint allowlist，禁止 userinfo/嵌入凭据。普通设置不能改变网络／执行信任边界。参数集合是封闭白名单，不支持的参数明确拒绝，不保存后假装生效。

设置读取返回 desired revision、effective revision、restartRequired 及有界安全状态。更新要求 expectedRevision；冲突返回 REVISION_CONFLICT；active Run／审批／执行 lease 未结束时拒绝 mutation。普通设置提交后只改变 desired，下一次干净启动才应用，不热换当前模型。

启动由同一锁库的持久值驱动 composition。构造成功并完成 required recovery 后才能把该 revision 声明为 effective；失败不冒用旧实例。effective 是当前实例事实，不是仅靠数据库一个标志证明。普通 get/snapshot 不返回任意巨大的配置集合。

### 11.2 CredentialProvider

CredentialProvider 只在 trusted composition 使用，首版支持受控 environment mapping 或 explicit injection。不提供 wire credential 写入/读取、vault/OAuth/picker。

缺少 credential 必须明确失败，不能把 undefined 传给 SDK 触发未声明的 ambient credential store。凭据仅传给受信 provider construction，不进入普通 SettingsStore、Session metadata、Protocol DTO、ClientSnapshot、UI 表单、错误日志。provider/startup 异常在离开受信边界前转换为固定安全分类，不复制原始 body/header/cause/URL。

配置 schema 白名单不是通用 secret detector；不保证识别用户主动粘贴进聊天或普通文本的所有秘密，也不宣称能隔离恶意同进程插件。验收的 credential sentinel 覆盖系统受管 credential 流及其异常路径，不能用上述限制为系统泄密免责。

## 12. Plugin Desired-state Persistence

- registered：composition 提供的可信插件对象；不由数据库安装或加载任意代码。
- installed：不属于本阶段；没有 install/update/marketplace 操作。
- desiredEnabled/config：持久意图；actual status：当前实例生命周期事实。
- enabled 不能从 desired=true 推断；config 不能授予 permission/grants。

enable/disable 在 Host idle/lifecycle 协调下先持久 desired intent，再调用现有生命周期。持久化失败不触发生命周期；生命周期失败保留 desired，actual 按真实 disabled/error/cleanup 状态展示，不假装已回滚意图。

启动每个 registered plugin 按当前 grants 和校验过的不可变 config 恢复，最多一次尝试，不后台自动重试。激活失败但 cleanup 已收敛时可呈现 unavailable/error；cleanup 不收敛不得进入可执行 ready。未知 plugin namespace 可留库并标 unavailable，不自动安装；只暴露有界状态，不把任意 namespace 列表塞入 snapshot。

Plugin configuration 更新遵循 Settings CAS 与 restartRequired；显式 enable/disable 可在 idle 时应用，但必须使用本实例 effective config，不能暗中应用 pending config。返回值分别说明 desired 与 actual，失败应答不意味着 desired write 没发生，Client 必须可查询确认。

## 13. Prepared Tool Execution / Policy / Approval

### 13.1 Precise execution boundary

在模型完整 step 返回后，**写 assistant 声明或派发本组任何工具之前**，必须先验证整组：同组 callId 非空且唯一，跨 step 重用合法；参数是 adapter 可接受的深度有限 JSON object；序列化和资源预算合法。失败时本组 executor 调用数为零。

该严格 profile 是 Phase 4 受管执行的新 public 行为，不追溯把旧 Core 任意 callId/unknown input 契约宣称已经有这些约束。历史 UI 标识仍使用稳定 occurrence/invocation，不以 provider callId 做全 Session 唯一键。

准备阶段不得调用工具或其他业务副作用。每个 prepared execution 绑定唯一 executionId、hostInstance/run/turn/step/occurrence、具体 executor 及 receiver、registry generation、owned 不可变输入、policy revision。批准后不得再按 name 查另一实现，也不得替换参数。插件执行获得隔离副本，不能修改已记录／已审批值。

Host 注入的 awaited execution 边界位于真正调用 executor 之前；Core 不导入 Host。tool/call 的 Host 投影与 pending approval 通过 execution identity 对齐，不能因 producer/consumer 异步让审批展示先于其调用身份。投影等待必须可被取消／关闭结束，不能死锁或借观察事件绕过 gate。

### 13.2 状态与 ownership

Policy 决策只有 allow、deny、require-approval。默认未知工具 deny；可信已审计纯计算工具可以 allow；能完整绑定展示输入的副作用工具可以 require-approval。不能稳定绑定时 fail closed，不退化为 allow。

| 状态/事实 | Owner | 合法转移与含义 |
| --- | --- | --- |
| prepared | 当前执行实例；Host 拥有其可派发能力 | policy allow → authorized；deny → denied；require-approval → pending |
| pending ApprovalRecord | Host | 首个合法 approve → approved；reject → denied；deadline → expired；cancel/Run 失效 → cancelled |
| approved / authorized | Host | 仅代表通过本次授权；仍须 final guard；不代表已执行 |
| dispatching | Host-controlled execution boundary | 同步占有一次派发后调用绑定 executor；不可退回 pending/approved |
| settled | 执行结果由 Core 收敛，Host 投影 | 成功/失败 observation；审批本身不能使 Run completed |
| denied / expired / cancelled | Host | 不派发，无重新打开；下一模型调用若提出新工具需新 executionId |
| delivery pending/answered/closed | 连接/stream request owner | 只负责收发关联，不决定业务批准，不复活 ApprovalRecord |

ApprovalSnapshot 与 execution phase 分开：approved 不被覆写成工具成功；execution 的 settled 也不等于 Run 已 durable terminal。业务 snapshot 明确 approvalId、executionId、Run/调用关联、deadline、安全工具名/输入、决策状态与可答复性。

默认审批绝对 deadline 为 120 秒；重连不刷新 deadline。Host monotonic 时钟决定超时，UI 的时钟只展示。final guard 检查取消、适用的审批／执行 deadline、hostInstance、Run、prepared identity、policy/registry generation 和有效授权；**同步占有 dispatching 与实际调用之间不得 await 或调用可重入外部 callback**。同一 executionId 重复进入必须拒绝。

deny/reject/timeout 为本次调用的安全 not-executed observation，不调工具；拒绝不是模型失败的同义词，可按既有 Loop 继续，但后续调用不继承批准。Policy 自身抛错或返回非法决策也必须 fail closed、零派发并给安全失败，不猜 allow、不自动重试政策副作用。approved/authorized 在 dispatch 前若取消、过期或 identity 失效，转入对应 cancelled/expired 状态；approval 的过期与执行失败不能混为工具已执行。cancel 走取消收敛；等待审批不释放 execution lease。

一旦派发，取消只发 abort，不承诺停止；不合作工具未 settle 时仍占用执行 ownership，不得先启动第二 Run 或改 registry。工具抛错／ok:false 也不能证明无副作用。

### 13.3 Disconnect / reconnect / restart / duplicate replies

- disconnect 关闭该 delivery pending，不批准、不拒绝、不自动 cancel Run；业务 ApprovalRecord 留在同一 Host 至 deadline/cancel/决策。
- 同 hostInstance 重连重新订阅当前状态，可用新 requestId/stream 投递同一仍有效 approval。只重新投邀请，不自动重发旧答案，不重新准备／执行工具。
- 支持多个连接观察同一审批时，首个合法决策胜出；其余交互置为已决，无双重派发。不引入多用户身份／权限体系。
- 每份答复校验 hostInstance、stream/connection epoch、requestId、approvalId、executionId、状态与deadline。重复、迟到、旧 stream／未知 pending 答复不改变业务状态。
- approve 与 cancel/timeout 竞争按 Host 串行化顺序处理；若 final guard 前已取消/过期则零次派发；若先 dispatch 则不能谎称取消撤销了执行。
- Host restart 更换 hostInstance；旧 prepared execution、pending resolver、reply 全部失效。数据库里的输入和 Run 只用于查询，不用于重建 callable。新实例没有可答复的旧 pending approval。
- 没有支持该 approval profile 的可用 Client 时不得执行。可保持 pending 到deadline，随后 not-executed；能力缺失不等于默认同意。

**保证同一 hostInstance 内同一 executionId 至多一次 dispatch。正常批准且 final guard 成立时恰好派发一次；不保证外部系统产生恰好一次副作用，不保证跨重启继续执行。**

## 14. Protocol v2 Contract Changes（完整增量清单）

### 14.1 Generation、identity、description

所有 v2 envelopes 的 protocolVersion 为字符串 `"2"`，沿用四象限、JSON guard、result XOR error、scope 与 pending schema 验证。v1 明确 UNSUPPORTED_PROTOCOL，不双栈、不静默降级。

host.describe 增加 storage identity、durable/ephemeral retention、分页/历史/设置/approval profile 的真实 capability 及有效 safety limits；maxActiveRuns 仍为 1。hostInstanceId 每次启动变化；storageId 可跨重启稳定但不赋予执行能力。requestId、submissionId、runId、turnId、executionId、approvalId 分工不同。

持久 submission 去重作用域变为同一 storage 内；相同 submission 与相同输入身份返回已有 Run，不创建新执行；冲突为 SUBMISSION_CONFLICT；retired 为 SUBMISSION_RETIRED。删会话后不释放 submission 身份。跨 hostInstance 的所有操作仍必须重新 describe 并使用当前实例；旧 envelope 不能复用。

Client 可显式查询同 storage 的既有 Run/submission 来确认 unknown outcome；不因数据库能去重就自动重放 start。旧 stream/approval 不能因 storageId 相同复用。

### 14.2 DTO 改变

| DTO | v2 变化 |
| --- | --- |
| SessionSummary | title、updatedAt、generation、metadata revision、historyRevision、committed high-water；ready/blocked 安全原因；activeRunId |
| SessionSnapshot / sessions.get result | 只提供 metadata/high-water，不再把 canonical 全数组作为完整 Session；历史走独立页 |
| HistoryPage | storage/session generation、固定 fence、historyRevision、实际 coverage、稳定 item/occurrence 位置、cursor、边界/turn 片段标志 |
| List page | bounded items、collectionRevision、keyset cursor、hasMore；不是全库 |
| RunSnapshot | 新 interrupted/endReason/knowledge；持久关联；active live 明确有界及截断标志；terminal live=null |
| HostSnapshot | 同一 watermark cut 的有界目录／Run 窗口、至多一 active Run、当前 approval、安全配置及插件状态；各窗口明确 coverage/hasMore |
| PluginSummary | desiredEnabled 与 actual lifecycle 分离、config revision、restartRequired/unavailable 安全状态，不含 secret |
| SettingsSnapshot | desired/effective revision、restartRequired、指定 namespace 的有界非秘密值／状态 |
| ApprovalSnapshot | §13 身份、deadline、输入、安全决策状态；不携 executor/closure |
| ClientSnapshot（非 wire） | 增加 pages/fence/coverage/gap/stale、settings/plugin intent、approval 与 reply 状态；仍是 UI 唯一 presentation truth |

完整 canonical item 内容只存在于已提交历史投影中；稳定 identity 可跨重启关联。raw Core events、ModelClient 类型或 Plugin 内部对象不直接成为 DTO。

### 14.3 Operation inventory

| Operation | v2 行为；未列额外能力不得暗增 |
| --- | --- |
| host.describe | §14.1 bootstrap 与真实能力/limits |
| sessions.list | revision/keyset 分页目录，替代全量列表 |
| sessions.create | 创建空 Session，返回 summary；非幂等，不自动重发 |
| sessions.get | 单 Session summary/high-water，不带全历史 |
| sessions.history（新增） | 固定 fence 的有界历史页；首次最新页与后续 cursor 读取 |
| sessions.rename（新增） | session identity、expectedRevision、title；CAS 后返回 summary |
| sessions.delete（新增） | session identity、expectedRevision；idle Session 原子删除，返回明确删除确认；无 trash |
| runs.start | durable admission 与 persistent dedup；输入受限；返回 accepted/已有 Run 不是 completed 承诺 |
| runs.get | 保留 runId XOR submissionId 查询；可查询持久终态，无执行副作用 |
| runs.list（新增） | Session scope 下 Run summary revision/keyset 分页 |
| runs.cancel | 持久 cancelRequested 意图与实际 settle 分离；不能恢复旧 Run |
| plugins.list | registered 插件的有界状态页；不列 installed marketplace |
| plugins.enable / plugins.disable | 持久 desired 与真实 lifecycle 结果；idle 协调，不能变 grants |
| settings.get（新增） | 按 host/model/plugin namespace 查询有界非秘密 desired/effective 状态 |
| settings.update（新增） | expectedRevision＋封闭 schema 配置更新；plugin config 同接口，不新增任意 KV RPC |
| subscriptions.open | 原子 snapshot+follow cut；有界窗口并声明缺省未加载范围 |
| subscriptions.close | 关闭 delivery/subscription，不 cancel Run、不改变 durable 事实 |

没有 tools.execute、runs.resume、approvals.resume、unblock、凭据操作、plugin install/update。政策／grants／provider executable 不能通过 settings 注入。

### 14.4 Reverse profile 与事件

新增唯一产品 reverse profile **tool.approval**：HostRequest 包含 ApprovalSnapshot 的可答复身份和有界输入，ClientResponse 仅允许 approve/reject 及绑定身份。沿用 pending profile runtime validation 和 HostRequest envelope；Client 公共 respond 能力增加 typed profile，不开放任意 JSON 执行接口。不另增与 reverse reply 重复的正向 approvals.approve API。

| Event | v2 语义 |
| --- | --- |
| session.created | 新 Session summary，不含全历史 |
| session.updated（新增） | metadata/revision/high-water/blocked 等安全摘要改变，不补齐未知历史 |
| session.deleted（新增） | session identity/generation 与目录 revision；缓存不可复活 |
| run.updated | 有界 active 状态；不得以 pending/approved 冒充 execution 完成 |
| run.output.delta | 仍为 live；截断／丢展示必须有明确信号，不能静默作为完整内容 |
| run.tool.call / run.tool.result | 绑定稳定 execution/invocation；安全 live 投影及截断标志，不是 durable commit |
| run.ended | 同一提交的 terminal Run summary＋Session summary/high-water＋collection revisions；不附全量 canonical |
| plugin.updated | desired/actual/config-revision 的有界摘要 |
| settings.updated（新增） | namespace/revision/restartRequired 失效通知，不广播全量设置或秘密 |
| approval.updated（新增） | 当前 Host 的权威审批状态，先于／伴随对应 delivery；不是执行命令 |
| collection.invalidated（新增） | sessions/runs/plugins scope 的新 revision；Client 不把旧页继续当当前完整目录 |
| host.request.cancelled | 仍只终止一次 delivery；业务 cancelled/expired 由 approval.updated 区分 |

collection revision 必须随对应变更原子前进；事件缺口仍靠 resync，不建设 durable event replay。run.ended 对 Run/Session 的更正仍须 Client 原子应用，不能为了分页破坏原 terminal correction 原则。

### 14.5 Errors 与兼容

沿用既有安全 ProtocolError envelope。v2 新增最小机器语义：STALE_CURSOR、REVISION_CONFLICT、SUBMISSION_RETIRED、LIMIT_EXCEEDED、SETTINGS_INVALID、STORAGE_UNAVAILABLE。无效 cursor 的格式错误为 INVALID_REQUEST；已删除 Session 为 SESSION_NOT_FOUND；不支持 profile 为 CAPABILITY_NOT_SUPPORTED。重复/迟到的无 pending response 按旧规则校验通用 envelope 后丢弃，不响应 response。

interrupted 是 Run terminal，不用普通 failed/error code 代替；模型预算/credential/provider 等 Run 失败只给安全分类与固定提示，不外泄原异常。存储提交未知时不能用 STORAGE_UNAVAILABLE 推导写入从未发生，Client 仍按 unknown 处理。

所有新增／变化 DTO 的 type、runtime schema、codec、Client fold、fixtures 必须同步验收；此处冻结语义字段与方法集合，不冻结内部 TypeScript 文件组织。

## 15. Public API Changes 与 Phase 1–3 Compatibility

| 边界 | 明确的 public/source 变化 | 仍保留 |
| --- | --- | --- |
| Core Session | 新显式 history window、baseSeq/nextSeq/loaded coverage 与 suffix append 语义 | 完整 restore 从零连续校验；Runtime 分配 turnId、Session 分配 seq/time |
| Core model/context | ModelClient limits、必需的 request output cap、builder budget、最终 guard；替代 adapter/fixtures 需升级 | provider-neutral ModelClient，完整 tool-call 输出，重试 ownership 在 Loop |
| Core tool execution | prepared execution 与 awaited policy seam；受管 profile 整组 JSON/identity validation、owned input | Tool 工具实现不依赖 Host/Protocol/UI，Core 原 unknown 类型不被 wire DTO 偷换 |
| Host | async durable readiness/repository、受信 execution factory、policy/approval ownership、分页/settings/Session mutation | provider-neutral，单 active Run，execution/mutation lease，ephemeral 明示模式 |
| Plugin | 版本化非秘密 config 输入、desired/actual 分离及重启应用 | 现有 grants/storage permission、staging/commit/cleanup 与 idle 契约 |
| Client | typed v2 operations、history coverage、settings、typed approval response；snapshot 形状 source-breaking | React-free、Host authority、unknown-write 不自动 replay |
| Web composition | 能等待 durable Host ready/close，trusted composition 受 settings 驱动 | browser 不导入 provider/Node，Web CLI 不自行选模型/读取凭据 |

v1 的 full snapshot/host-lifetime retention/空业务 reverse registry 明确被 v2 的目标能力替代，不声称是无破坏兼容扩展。RuntimeEvent 与 SessionEvent 仍不合并；审批是 Host interaction，不向 Session 添加虚假的审批 turn。Phase 1–3 回归的原则与故障语义继续成立；被显式替代的旧 wire shape 断言迁移到 v2，不删除安全反例来减少测试。

## 16. Limits and Safety Bounds

当前默认基线（UTF-8 bytes；KiB=1024 bytes）：

| 项目 | 默认上限/语义 |
| --- | --- |
| 用户输入 | 16 KiB 原始 UTF-8；admission 前校验 |
| 单编码事实 record | 64 KiB，包含事实 envelope 与 JSON escaping |
| 单页 | 最多 50 项，实际编码 page payload 最多 192 KiB，先达到者生效 |
| 任意完整 Protocol frame | 256 KiB，包含 envelope、所有组合字段及 escaping |
| Host outbox | 1 MiB，以实际 UTF-8 计量，有限发布批次/背压 |
| Approval deadline | 120 秒，不因重连延长 |
| active Run | 1，包括 pending approval 与尚未 settle 的 cancelled execution |

Web carrier 既有 frame/wrapped-record/queue 边界继续有效。两层编码均检查，不能只测 page payload；snapshot 里目录、active live、approval、settings/plugin 摘要的总和也必须满足完整 frame。合法静态状态必须能首次订阅／重订阅，不能靠连接反复超限关闭作为正常读取方式。

有限注册插件/schema/system 配置集也必须通过启动尺寸检查；不将全部 config 塞进 snapshot。超限预先拒绝该配置或缩小有明确 coverage 的展示窗口，不截断 policy 输入或伪造完整事实。Slow consumer 可断开并 resync，不承诺无限慢端不断线。

输入的原始 UTF-8 上限与编码 record 上限必须同时成立（例如控制字符 JSON escaping 会放大字节数）；admission 前必须确认已知输入及其安全应答可表示，不能先接受再发现 user record 无法落库。工具参数、assistant 声明等可预知超限在执行前拒绝。工具已产生超大结果时不得截断后冒充完整 canonical：执行 settle 后尽力持久安全 Host failure，保留旧 canonical 并 blocked，明确副作用可能发生；存储不可用则遵循提交未知规则。模型副本截断与 live 展示截断须有标记，不能回写存储。

本节单项／单次上限不授权累计历史总量限制。数值调整必须有显式支持声明与端到端边界验收，不得在某层偷偷放大到 carrier 无法承载。

## 17. Storage Backend、Migration / Compatibility

当前支持与测试基线为 **Node 24.x，最低已选测试版本 24.17.0，node:sqlite**；不把 `<25` 或永远 Node-only 的平台上限写成架构法律。后续 Node major／其他 backend 需验证同一契约再声明支持，不能把“未来可支持”当当前已验证。

新增第三方 production dependency 为零；不引入 ORM、tokenizer、schema 框架。当前 SQLite API 的 RC 风险需在支持记录中如实标明。pnpm 沿用 11.8.0；本轮不改 manifests/lockfile。

首版 storage profile：本地磁盘、单 Host 独占、单写 ownership；SQLite DELETE rollback journal、synchronous=EXTRA、foreign keys、EXCLUSIVE locking、零 busy wait 的 fail-fast 基线。必须真正取得锁，不只设置 PRAGMA 后自称独占；连接持有至所有执行与清理结束。上述是当前 backend profile，不是要求所有未来 backend 复制 SQL 参数。

不支持网络共享盘／两个 Host 写同库，不默认 WAL。成功提交的耐久性依赖 OS/VFS/硬件兑现同步；强杀测试不等于掉电／介质损坏认证。

Migration：新库建初始 version；已知旧版顺序迁移、单次迁移原子提交，失败 rollback；未来未知 schema version 拒绝启动，不自动降级、删库、重建或导入不可信 payload。Phase 3 内存状态无自动跨进程迁移来源，不虚构既有持久数据。

storageId 跨正常重启稳定；迁移不得重新编号 Session seq/identity 或复活 submission。后台压缩、备份、导出、自动清理不是本阶段。已授权显式 delete 的逻辑删除义务与 storage 物理擦除不是同一保证。

## 18. Explicit Guarantees / Non-guarantees

### 18.1 必须通过验收的保证

- 已确认 durable commit 的 Session canonical 与 Run terminal 可在正常重启／进程崩溃恢复后查询，且两者不半提交。
- Canonical 只有完整 settled turn；unfinished Run 恢复为 interrupted，不假装 completed/ordinary failed。
- 无自动旧 execution 恢复；Host restart 后旧 approval reply 零派发。
- 批准前零工具调用；合法批准且 final guard 成立时一次；重复批准最多一次；reject 零次。
- 历史长期保存，startup/每 turn/每页/cache/model request 有界；partial coverage 永不声称完整。
- Settings 重启实际生效，plugin desired intent 持久，actual 状态诚实。
- 受管 credential 不进入普通 SettingsStore/wire/log；Host 不依赖 provider implementation。
- v2 不自动降级／replay 非幂等写入；取消和 unknown outcome 仍诚实展示。

### 18.2 明确不保证

- 跨进程 tool exactly-once、跨外部系统事务、恢复 execution、取消回滚；ok:false 也不能证明没副作用。
- crash 中未提交 assistant/tool 中间结果的保全，或全部已显示 live 最终都进入 canonical。
- 断联后写入一定失败、批准应答已送达、approved 一定已执行、terminal 通知一定送达。
- 精确跨 provider token 计数、任意模型接受请求、不可信 SDK 自动遵守 cap；不支持者拒绝运行。
- 无限磁盘/单项大小/内存/网络吞吐，工具自身无限资源使用的 sandbox 隔离。
- 恶意同进程插件隔离、自动识别所有文本秘密、安全擦除、撤销已发出的外部请求。
- 网络盘、多 Host/多用户、未来 Node major 已验证、v1 Client 兼容、掉电／硬件损坏下绝对不丢数据。
- 在持续并发目录变更下无重试遍历、 durable live event replay、blocked Session 自动修复／续跑。

## 19. Milestone Acceptance Criteria

以下为将来授权后的验收标准，**不是本轮结果，也不是执行许可**。

| Milestone | 必须证明 | Forbidden scope |
| --- | --- | --- |
| P4.0 Architecture Freeze | SPEC/HANDOFF、AD与public/wire清单、八项自检、独立 SPEC review 后明确冻结状态 | 生产实现、测试修改、安装、M1、自动 `/goal` |
| M1 Durable State | memory/durable契约；admission/start/terminal原子性；所有crash点；interrupted；大历史窗口续写与分页；锁/迁移/磁盘错误；rename/delete存储语义 | 恢复执行、逐工具checkpoint、累计历史上限 |
| M2 Context Budget | 首轮/follow-up/retry/custom builder全guard；合法turn选择；整组pre-log错误零派发；实际provider请求体cap；确定性错误不重试 | LLM摘要、Memory/RAG、自动工具replay |
| M3 Configuration | settings CAS/desired/effective；composition确实使用持久值；credential sentinel；plugin intent/actual及失败恢复 | vault/OAuth、插件安装、自授grants、模型热更 |
| M4 Tool Policy / HITL | prepared绑定；approve前0次、approve后1次、重复仍1次、reject0次；deadline/cancel/断联/旧实例竞态；lease直到settle | durable pause/resume、多级表单／审批、workflow |
| M5 UX + Acceptance/Seal | 历史页coverage、rename/delete、settings/restart、审批/中断说明；全跨层回归、真实浏览器gate、独立审查与明确封板 | Shell重设计、archive/tag/folder、以人工检查替代自动安全断言 |

实施顺序：P4.0 → M1 → M2 → M3 → M4 → M5。P4.0 先冻结 factory/分页/执行 seam；M3 才落实全部配置应用，不能把缺接口留到穿透分层时临时决定。新增副作用工具在 M4 安全 gate 完成前不得作为产品能力开放。

### 19.1 故障与跨层验收矩阵

- 在 §8 每个 commit/执行边界子进程强杀，检查数据库事实、canonical、Run status、工具计数与第二次启动幂等性。
- 模拟 commit 成功但回执异常、确定 rollback、持久不可用，证明只重试存储批，不重跑 Runtime。
- 磁盘满／只读、schema migration rollback、未知version、损坏record、两Host锁竞争；失败无内存降级。
- 构造远超单页／窗口的大历史，继续追加；记录读取条数/字节及缓存，证明不是全量load后slice。
- fence期间追加、rename、delete、collection revision竞争、迟到读响应、重连/cache eviction；不得伪造complete coverage。
- 临界encoded frame首次订阅、terminal、重启重订阅，含emoji/escaping及组合snapshot；超限在可预知副作用前拒绝。
- 工具组重复/空callId、跨step复用、深层input突变、registry变化、重入；executor计数与prepared身份精确断言。
- 多delivery同approval、duplicate/late reply、cancel/timeout/dispatch边界、无Client、hostInstance切换；旧能力永不复活。
- 实际provider请求体 output字段／cap、预算错误不retry；credential sentinel不入DB/wire/log，真实provider仍另行授权。
- Windows Node24最低与最新补丁及Linux验证；所有未覆盖环境明确记NOT RUN，不以进程强杀声称掉电认证。

沿用项目现有检查：`pnpm typecheck`、`pnpm build:web`、`pnpm test:web:browser`；受控离线回归使用 `EVERY_DAGENT_NO_BROWSER=1 pnpm exec vitest run --exclude '**/real-provider.e2e.test.ts' --exclude '**/.zcode/**'`。Browser SKIP不算PASS；旧安全反例不删除，显式v2变更保留等价安全断言。

人工验收只补充审批可理解性、中断/unknown文案、分页/删除交互和小屏可读性，不能代替可自动验证的恢复、预算与零副作用断言。

## 20. Stop Conditions / Remaining Review Boundary

遇到需要多Host/网络盘、多用户、自动续跑、跨进程exactly-once、普通settings存凭据/grants、provider不能兑现cap、prepared无法稳定绑定、分页仍需全历史load、合法frame无法通过carrier时，停止并回到架构裁决，不堆兼容层或弱化测试。

本文已选定目标语义，无将“canonical 是否可含半成品”“restart 是否可执行旧 approval”留给实现者的开放项。仍需独立 SPEC review 核对：v2 inventory 是否足够且最小、分页cut/coverage一致性、提交未知与resource settle、执行线性化、窗口与完整turn校验是否闭合。运行时可行性、性能与平台测试是后续milestone证据，不在文档中冒称完成。

只有新的明确授权才能进入 M1；P4.0 authoring 完成、Master Plan 作为设计输入获批、独立 SPEC review 推荐，三者都不自动授权实现或Git操作。

## 21. P4.0 Authoring Self-check

以下是作者对规范文本的自检，不是独立 review 或实现测试 PASS。

| 检查 | 落点与结论 |
| --- | --- |
| 1. Master Plan architecture decisions 全覆盖 | §3 AD-01–15分别链接§5–§18；保留全部关键决策，剔除SQL/helper/文件拆分的法律地位；Node上限按补充约束纠正 |
| 2. 每个 crash point 有确定结果 | §7.2、§8表；无提交/accepted/start/stream/approval/tool/result/end/settle/terminal/reconciliation全覆盖；按持久事实而非UI猜测 |
| 3. 每个 approval 状态有 owner | §13表；prepared/execution与ApprovalRecord归Host控制，delivery归连接；restart旧能力无owner可恢复 |
| 4. partial history 不冒充 complete | §9 fence/coverage/gap/stale；§14 bounded snapshot和summary terminal；完整restore与窗口API分开 |
| 5. Context 有界 | §10估算不变量、逐请求guard、真实output cap、有限current-turn预算；§16单项/传输限制；不承诺精确token计数 |
| 6. secrets 不进普通SettingsStore | §11字段白名单、CredentialProvider/composition、无ambient fallback、安全错误；§18明确保证与信任边界 |
| 7. v2 change 完整且最小 | §14列generation/DTO/operations/reverse/events/errors；§15列source-breaking；无tools.execute/resume/credential/安装接口 |
| 8. Phase1–3原则不意外破坏 | §1.2、§4、§15逐层继承与显式替代；Host authority、独立Core/Protocol、React-free Client、live/canonical、cancel/unknown/no-replay全部保留 |
