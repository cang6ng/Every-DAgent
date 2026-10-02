# Phase 4 M1 Contract Errata

## Status

APPROVED / FROZEN

本文件是 Phase 4 Frozen Contract 的受限补充（restricted supplement）。它只覆盖以下四项，不增加任何其他语义、能力或范围：

- E1 — Storage Fault Presentation
- E2 — Run / Turn Durable Ownership
- E3 — History Page Limit and Fragment Semantics
- E4 — RequestId Encoded Byte Limit

该冻结表示这些条款自此成为冻结契约的一部分，不代表 M1 实现完成、任一 finding 已关闭或批准进入后续批次；finding 关闭与批次放行仍由各自的实施与独立复审决定。

- Protocol generation 保持 `"2"`；不新增 operation。
- 不进入 M2、M3、M4、Multi-Agent、Workflow、Marketplace 及其他未来能力。
- Contract authority：本 Errata 与原 [PHASE4_PLATFORM_SPEC.md](./PHASE4_PLATFORM_SPEC.md)（Frozen SPEC）一起，共同构成后续 M1 implementation／review 的 contract authority；本文件不修改任何冻结文件；[PHASE4_HANDOFF.md](./PHASE4_HANDOFF.md) 中历史阶段状态不作为本文件对当前实现的状态声明。
- 批准依据：Independent Contract Review PASS，0 BLOCKER / 0 MAJOR / 0 MINOR，READY FOR CONTRACT APPROVAL: YES。
- Frozen baseline：`6fad5c6f5753e712806c1453a512b902b2f13e6c`；核对的 implementation baseline：`b8bc2c930d66af92d55eaa1d62628150a1e59f17`。
- E1–E3 是已有语义的显式澄清及验收约束；E4 是必要的 Protocol v2 有界性修订。仅这些明确条款补充冻结契约，其他目标不变。

## E1 — Storage Fault Presentation

### 既有歧义／缺陷

**裁决：A，澄清，不改变状态语义。** SPEC §4 的状态诚实、§7.2 的提交未知／连接失效以及 §9.4 的 stale 语义，已经禁止把无法确认的执行当作可信当前状态。只关闭故障发生时已有的连接，却允许新连接从同一 faulted Host 成功取得普通 running snapshot，违反这些要求。缺少的是对后续 bootstrap 的明确验收描述，不是新的 Run 状态。

本条仅针对当前实例已经不可恢复地进入 `storageFault`、不能继续确认 durable outcome 的情形；不替代 §7.2 中仍能通过提交事实确认结果的正常恢复路径。

### 冻结澄清：MUST / MUST NOT / MAY

- **MUST**：故障成立后，失效已有订阅并终止相应连接；对随后到达的连接与订阅同样保持故障边界，直到新实例完成 startup reconciliation。不能只处理故障发生瞬间的连接集合。
- **MUST**：若仍接收并处理合法的 `subscriptions.open`，返回现有 `STORAGE_UNAVAILABLE` error，不返回成功 snapshot、不建立 follow stream。连接本身被拒绝或关闭也是允许的失败路径；两者都不能使 Client bootstrap 成功。
- **MUST**：在 fault 与 snapshot capture／发送竞争时，防止故障后的成功 bootstrap；故障前已发布的 cut 只能作为失效旧状态保留。Client 通过现有连接、同步失败及 stale/lost 语义呈现不可确认；新 Client 没有可信 cut 时不得自造一个。
- **MUST**：停止新写入与新 execution；仍能回答的合法写请求返回 `STORAGE_UNAVAILABLE`。对已有执行的 abort 请求与真实 settle 约束继续遵循 §7.2，不把关闭连接当作取消执行或撤销副作用。
- **MUST NOT**：通过 snapshot、Run 查询或其他读路径把受影响 unfinished Run 宣称为可信的 current running；不得为了展示而持久化或发布 fabricated `completed`、`failed`、`interrupted`，也不得新增 wire `unknown` RunStatus。
- **MUST NOT**：因重新连接、再次 describe 或一次读取成功就解除该不可恢复故障。对于该故障留下且重启后仍无已提交 terminal 的 unfinished Run，只有 startup reconciliation 能产生 durable `interrupted`；若 terminal 实际已提交，则恢复原 terminal，不覆盖为 interrupted。
- **MAY**：在入口直接拒绝／关闭新连接；或保留连接返回安全错误。`host.describe` 可返回仍真实的身份和静态能力，但 describe 成功不等于 current-state bootstrap 成功，也不证明 Host 可执行。
- **MAY**：保留有明确 stale 标记的旧 Client cut，或提供能独立确认的既有 immutable canonical 读取；不得借此洗白受影响执行的 current 状态。实现也可统一拒绝 fault 后的业务读取，无须新增 degraded snapshot DTO。

### 验收条件

1. 注入 terminal commit outcome 无法确认：原 Client 失去 current 同步状态，Host 不发布伪终态，新写入／execution 被拒绝。
2. Host 不重启，创建全新 Client 并多次重连：每次都只能得到连接失败或 `subscriptions.open` 的 `STORAGE_UNAVAILABLE`，不能得到可信 running snapshot；覆盖故障与订阅建立竞争。
3. 拒绝 bootstrap 不能隐式修改 durable Run、canonical 或释放尚未 settle 的 execution ownership。
4. 新 Host 完成 reconciliation 后，未提交 terminal 的 running marker 对应 `interrupted/unknown` 与 blocked；已提交 terminal 保持原事实。旧 Client 的 stale 展示不是 durable interrupted。

### Public / wire 行为是否变化

无新增 wire shape、operation、error code 或 Run 状态。错误实现的成功 bootstrap 改为既有错误／连接失败，是恢复冻结的 presentation truth，而不是增加产品能力。

### 是否允许 persistence schema 变化

本条不需要，也不授权专门的 schema 变化；`storageFault` 不成为跨重启恢复的执行状态。

### 影响的既有 findings

R02。不得据此重新打开已关闭的 R04 或其他 findings。

## E2 — Run / Turn Durable Ownership

### 既有歧义／缺陷

**裁决：A，显式化既有 logical invariant。** SPEC §6 已要求 Run 保存原接受输入、turnId、提交 identity 和已提交范围，§7.1 要求 Run terminal 与 turn/index 原子提交，§8 要求验证 Run/history 关联；继承的 Phase 3 SPEC §7.3、§8.2 还要求 Run.text 保留原输入、turnId 一旦绑定不可更换。这里的关联只能是该 Run 实际执行并提交的那个 Turn，不能是任意结构合法的 Turn。

“每个 Turn 当前只被一个 Run 引用”不能证明这种归属：交换两个 Run 的 turnId／range 后仍可保持唯一性与结构正确；只验证 turn closure/tool pairing 也不能发现 `Run.text = ORIGINAL`、canonical user text 为 `TAMPERED`。

### 冻结澄清：MUST / MUST NOT / MAY

- **MUST**：每个 `completed` Run 拥有且只拥有它实际提交的一个完整 Turn；每个 Host-managed canonical Turn 只属于实际提交它的一个 Run。其他带 committed range 的 settled Run 同样满足归属约束。没有 canonical 提交的 host failure／interrupted Run 不得被迫补出 Turn；已知执行 turnId 不等于已提交 ownership。
- **MUST**：durable proof 同时绑定 `runId`、session identity（含 generation 的一致语义）、`turnId` 与精确 committed 半开范围，并能独立核对 Run 上的指针。仅从当前 `Run.turnId` 反查、统计引用数或重新生成所谓证明，不构成原提交归属证据。
- **MUST**：在同一 terminal transaction 中保存完整 canonical facts、Turn 的 owner binding、Run terminal／turnId／range 及既有 Session high-water/revision 更新。提交后 binding 不得重新指派给另一 Run；显式 Session delete 仍按原契约删除关联事实。
- **MUST**：canonical Turn 的首个 user fact 与 owner Run 的 accepted input 逐字相同。Frozen managed text semantics 是保留原字符串，不 trim、不做 Unicode normalization、换行改写、大小写转换或显示截断；比较解码后的文本值，而不是要求 JSON escaping 写法相同。
- **MUST**：terminal 提交前、提交结果确认及恢复／读取验证使用一致的 ownership 与 input 约束。发现不匹配须按既有 corruption 语义拒绝／隔离该事实，不输出可信 terminal/history，也不能用于模型窗口。仍允许有界、按需验证，不要求启动全量加载历史。
- **MUST NOT**：把 range、reason、时间相近、相同文本、tool pairing 正确或一对一引用关系单独当成原始 ownership 的充分证明；不得自动把不匹配的 Run、Turn 或 user text 改写到彼此一致。
- **MAY**：在现有 turn index 上持久保存 `runId`，并强制 owner Run 唯一、Turn identity 唯一及 session identity 一致。这是当前实现的最小可接受方案，与既有逻辑实体一致，不新增逻辑实体。也可用同一事务持久写入、具备同等独立核对能力的等价绑定，不强制 SQL 表名。

Turn 唯一性按既有 session identity 下的 `turnId` 判定；若存储已保证 `turnId` 全局唯一，可以使用 `UNIQUE(turn_id)`。否则使用等价的复合唯一约束，不能为本条额外引入跨 Session 的 public ID 规则。`UNIQUE(run_id)` 防止同一 Run 认领两个 Turn，但这些约束必须与双向 binding、session/range/input 验证共同成立，不能单独替代它们。

本条要求证明的是正常受管写入和指定损坏反例下的关联完整性，不是密码学防篡改。攻击者若能协调重写数据库中的全部相互印证事实，本条不声称仍能重建原始历史；不引入签名、外部账本或 full tracing。

### 验收条件

1. 正常提交、重启、查询及模型窗口读取均保留同一 Run–Turn–range–input 关联；合法的非 completed settled turn 不被误拒。
2. 只交换 Run A／Run B 的 turnId 与对应完整 range，即使两者输入相同、reason 相同且各只有一个 claimant，也必须被独立 owner binding 拒绝。
3. 保留 Run accepted input，篡改 canonical 首个 user text，必须拒绝；保留合法前后空白、Unicode 和换行的原输入则应通过。
4. 重复 owner、跨 session identity、range 不一致与缺少 binding 均不得发布为可信提交；terminal transaction 失败不得留下半份 binding。
5. E3 的合法页面片段不得因缺少页外 call/result 被误报 corruption；完整 durable Turn 的 pairing 与本条 ownership 校验仍必须保留。

### Public / wire 行为是否变化

不改变 Protocol DTO、generation 或 operation。Turn owner proof 属于内部 persistence enforcement；不要求将 `Turn.runId` 暴露为新 wire 字段。对错误关联拒绝读取是落实已有损坏检测契约。

### 是否允许 persistence schema 变化

**允许且当前 schema 需要补充持久证明。** 当前 turns index 没有 owner 字段，单靠现有 Run 指针不能拒绝上述交换反例；采用最小 `Turn.runId` 方案需增加内部 schema version 和原子 migration，而不能只改新库建表语句。

迁移遵循 SPEC §17：已知版本按序原子迁移、失败 rollback、未知版本拒绝、保留 storageId／Session identity／seq。旧库若已有 canonical Turn，不能仅复制待验证的 `Run.turnId` 反向生成 binding，再宣称证明了原始 ownership；即使逐字文本相等，也不能证明两个同输入 Run 未被交换。仅当旧版另有足够独立的持久证据时才可据此迁移；无法证明时明确拒绝启用这些事实或启动失败，保留原库，不自动删库、重建、改写文本或猜测配对。本条不新增数据修复／导入工具。

### 影响的既有 findings

R05；E3 涉及其与 R12 的 fragment schema 依赖。R04 不重新打开。

## E3 — History Page Limit and Fragment Semantics

### 既有歧义／缺陷

**裁决：A，保持 caller 最大项数语义，明确为 hard maximum，排除 target/hint。** SPEC §9.2 明确允许 turn 内分段，§16 规定 item 与实际编码尺寸两类上限先达到者生效，但正文没有逐字列出 `items.length <= limit`。当前公开参数注释仅表述 caller 希望的项数及不得超过单页容量，也没有授权为 pairing 超过 caller limit。本条补明这个不等式，不将页级 50 项上限误当作 caller limit，也不采用实现中“允许多返回一项”的解释。

完整 canonical Turn 的合法性与某一 history page 的自包含配对是两件事。把完整 turn 的配对要求套到任意 page，既会误拒合法片段，也会诱导突破 caller limit。

### 冻结澄清：MUST / MUST NOT / MAY

- **MUST**：对于合法 `limit=N`，响应始终满足 `items.length <= N`，且同时满足 Host 的有效单页 item 上限、page payload 与完整 frame byte 上限。省略 limit 时沿用既有默认值；本条不另定默认值或放宽参数合法域。
- **MUST**：页面保留稳定 session/turn/item/occurrence identity、真实 seq 或等价位置、准确 coverage／fragment 边界以及同一 fence 的正确 cursor。coverage 按 canonical seq 语义报告，不从展示 item 数反推；过滤非展示事件不得伪造缺口或完整性。
- **MUST**：response schema、runtime codec 与 Client page fold 接受合法片段。页外缺少另一半不是本页 corruption；页内已提供事实若 identity 或 pairing 互相矛盾，仍须拒绝。
- **MUST NOT**：为 occurrence pairing 超过 caller limit、复制页外 item、跳过事实或报告虚假 complete turn。不得用 page schema 接受片段为理由弱化 repository 的完整 Turn closure、tool pairing、ownership 校验。
- **MAY**：合法 page 只含一个 tool-call，或只含一个 tool-result；可从 turn 中间开始，也可在同一 tool occurrence 的 call 与 result 之间切页。前提是上述 identity、连续 coverage、cursor 与片段标志足以定位，且不冒充 complete turn。
- **MAY**：在 item 或 byte 边界前返回更少 items；后续 cursor 必须准确续读，不能遗漏、重叠伪造 coverage 或无限返回同一位置。选择边界不必为了配对而扩页。

允许的是已提交完整 Turn 的读取片段，不是持久化半个 Turn，也不是给模型使用不完整的 tool history。Core/model 窗口继续只读取连续完整 Turns。

### 验收条件

1. 对包含 tool-call/tool-result 的合法已提交 Turn，以 `limit=1` 分页；每页最多 1 item，call-only 与 result-only 页均可通过 schema/codec/Client，并能按稳定 occurrence 关联。
2. 从 turn 内部／occurrence 中间续读，cursor 连续推进；遍历固定 fence 不丢展示事实、不重复计 coverage，不把片段当完整 Turn。
3. emoji、控制字符 escaping 与 byte 边界同时满足 item、payload、frame 限制；不能因 `limit` 很小而偷偷扩页。
4. 真正损坏的完整 durable Turn 仍被拒绝；证明 R05 false-positive 的修复没有取消完整事实验证。

### Public / wire 行为是否变化

不新增字段或 operation，不把 hard maximum 改成 hint。实现与 fragment validator 需要符合已冻结的页面语义；修正错误的过强配对校验不构成新的 wire 能力。

### 是否允许 persistence schema 变化

本条不需要 schema 变化。E2 的内部 owner proof 可独立配合分页验证，不把 page 当作新的持久实体。

### 影响的既有 findings

R05 的合法 fragment false-positive，以及原 Batch 2 R12 的 fragment schema finding。允许后续将 R12 的这个依赖与 R05 一起实施／验收，不代表 R12 已关闭，也不提前关闭或扩大到其他 Batch 2 findings。

## E4 — RequestId Encoded Byte Limit

### 既有歧义／缺陷

**裁决：B，必须作最小 v2 amendment。** SPEC §16 要求合法状态能够首次订阅／重订阅，并按包含 envelope 与 escaping 的实际 frame 字节数闭合；但继承的 requestId 只有非空字符串约束，没有可供 prospective snapshot 使用的独立有限预算。不能把 256 KiB 整帧边界当作 requestId 的可用预算，否则剩余响应内容没有可保证的空间。当前 36 B placeholder 不能证明对其他合法 requestId 的可表示性。

### 冻结修订：MUST / MUST NOT / MAY

**固定 `MAX_REQUEST_ID_BYTES = 128`。** 计量为解码后的原始 requestId 字符串经 UTF-8 编码的字节数，不是字符数、UTF-16 code unit 数或 JSON source 中的字符数；非空要求保持不变。不改其他 identity 的语义或上限。

64 B 足够 UUID，但对带前缀／组合的普通关联标识偏紧；128 B 保留充足空间且远小于 frame 上限，也保留本轮 128 B 反例作为合法验收输入。256 B 对当前关联用途没有必要收益。因此采用稳定的 128 B，不作为可协商的任意放大配置。

- **MUST**：Protocol v2 所有现有 requestId envelope 位置使用相同非空及 UTF-8 byte 上限，包括请求、对应响应、Host 生成的 ID 和关联恢复逻辑。公开约束、runtime schema、codec 与 Host 计量使用同一定义；不能仅限制某个 Client 的 ID generator。
- **MUST**：超过 128 B 的 incoming requestId 归类为 **`INVALID_REQUEST`**，不是 `LIMIT_EXCEEDED`，并在业务 dispatch 前拒绝。这是 envelope identity 非法，不是合法业务请求超过运行／页面预算。
- **MUST**：同时保持继承的非法 envelope 关联规则：超限 requestId 已不是合法可恢复关联 ID，因此走 connection protocol fault，关闭连接，不发送含非法 requestId 的关联 response。`INVALID_REQUEST` 在此是校验分类，不承诺对非法 ID 发出 wire error；合法 requestId 携带其他无效参数时，仍可原样关联并返回相应现有 error。carrier 先发现整帧超限时，仍按既有 frame fault 规则处理。
- **MUST**：对合法 requestId，成功／错误 response 继续逐字原样 echo，不 trim、不截断、不 hash、不重新分配 ID。非法 response envelope 仍按既有协议故障处理，不响应 response。
- **MUST**：startup 与所有相关 prospective snapshot/frame 检查，为任何合法 requestId 预留其**最坏实际 JSON 编码成本**，以 `MAX_REQUEST_ID_BYTES` 为基础，而不是固定 36 B，也不是简单放入 128 个普通 ASCII 字符。
- **MUST**：计入 escaping。对于当前 JSON 编码，128 B 原字符串的 JSON string token 保守上界为 `2 + 6 * MAX_REQUEST_ID_BYTES = 770` B（含双引号）；128 个 U+0000 可达到此界。其字段名、冒号、逗号及其余完整 envelope 必须另外计入，不能重复遗漏或用 raw UTF-8 128 B 代替 770 B。若 carrier 还有外层编码，继续独立检查该层，不能把此界直接当作 wrapped frame 的界。
- **MUST**：actual capture 使用真实 requestId 组装并 encode 真实 response，再检查完整 frame；prospective reservation 不替代实际计量。对同一已接受状态，在所有其他维度满足既有预留约束的前提下，合法 requestId 不得仅因其长度或转义开销使 snapshot response 超过 frame limit。
- **MUST NOT**：用生产 Client 通常生成 UUID、某个示例 ID 正好放得下、临时 `LIMIT_EXCEEDED`／`INTERNAL_ERROR` 或反复断连，代替上述对所有合法 requestId 的保证；不得为 echo 超限 ID 单独放宽 error response schema。
- **MAY**：通过最坏成本占位值或等价精确上界计算完成 prospective 检查；actual capture 可利用真实 ID 较小而剩余的预算，但所有 coverage 和 frame 约束继续成立。

### 验收条件

1. 128 B 非空 ID 合法，129 B 非法；覆盖 ASCII、中文、emoji 的不同字符数，证明按 UTF-8 bytes 而非 `.length` 验证。所有现有 envelope 方向及关联恢复使用相同边界。
2. 超限请求在 dispatch 前拒绝，零业务副作用；不能用超限 ID 关联错误 response，不能截断后匹配其他 pending request。合法 ID 的成功／错误响应原样 echo。
3. 对 prospective ACCEPT 的临界 snapshot 状态，分别以 36 B UUID、128 B ASCII、128 B 多字节文本，以及 128 个 U+0000 请求首次订阅／重订阅。actual response 均满足 256 KiB 完整 frame 上限；覆盖 startup 与状态增长后的 prospective 路径。
4. JSON escaping 与 carrier 外层包装分别计量；用 36 B 或普通 128 B ASCII placeholder 替换最坏预留时，边界测试必须能失败，不能只测远离上限的状态。
5. 非 requestId 因素导致超限时，既有拒绝／缩小且诚实报告 coverage 的规则不变；本条不是对任意状态都可编码的无条件承诺。

### Public / wire 行为是否变化

**有，且仅收紧 requestId 合法域。** 这是同一 Protocol v2 的安全上限修订，旧实现接受的超长 ID 将被拒绝；不宣称对所有旧 v2 输入无行为变化。envelope shape、合法 ID 原样 echo、operation、error code 集合均不变，无新增协商 operation 或 capability。

### 是否允许 persistence schema 变化

本条不需要 schema 变化；requestId 是通信关联身份，不转为 durable execution identity，不扩展 submissionId／runId 等持久身份规则。

### 影响的既有 findings

R28。

## Compatibility

- Protocol generation remains `"2"`；不引入 v3 或双栈。
- no new operation：复用现有 operation、error、connection 与 stale 语义。
- no M2/M3/M4 scope：不新增 Context Budget、Settings 或 HITL 实施范围。
- no new capability：不新增 Multi-Agent、Workflow、plugin marketplace、full tracing 或其他产品能力。
- no architecture redesign：Host authority、完整 settled canonical、restart reconciliation、无执行恢复、分层与 bounded reading 均保持不变。
- E1–E3 保持既有语义；E2 允许最小内部 schema enforcement，不能把不可证明的旧数据迁移成已证明。E4 明确收紧 requestId 合法域，不用 generation 升级掩盖或扩大此次修订。

## Implementation Impact

仅列后续经批准实施所需范围；本文件不执行以下修改：

- Host 的 fault 后连接／`subscriptions.open` 入口及 current-state 读取防护；复用 Client 的 bootstrap 失败、stale/lost 路径，不新增展示 DTO 或 durable 终态。
- Host repository 的最小 Turn owner proof、原子 terminal binding、accepted input 一致性校验、相应内部 schema version／migration 与有界读取验证；memory/durable 业务契约保持一致。
- `sessions.history` 的 hard item limit 与 fragment 投影，以及现有 Protocol schema／codec／Client fold 对 call-only、result-only 页面片段的支持；只连带处理 R12 的该项依赖。
- Protocol v2 requestId byte 约束与关联恢复；Host startup／prospective／actual frame 计量同步使用同一边界及 JSON escaping 成本。
- 上述四项的定向回归与边界验收；不扩大到其他已关闭 findings 或其他 Batch 2 工作。

本次交付仅新增本文件，以独立 docs-only commit 提交，不修改 production code、测试、Frozen SPEC 或 HANDOFF，不 push，不进入 implementation。
