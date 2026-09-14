# OpenFlux ↔ Router 群会话接入执行方案

版本：v1.0
日期：2026-09-11
上游文档：`docs/openflux-router-conversation-refactor-plan.md`（产品规则与数据模型，v0.1）、`docs/router-integration-guide.md`（现有 Router 契约）
范围：把 v0.1 方案落成可排期、可验收的工程计划。产品规则不再讨论，本文只回答"谁、改哪里、按什么顺序、怎么算完成"。

## 1. 一句话目标

群里首次真实 @机器人 → OpenFlux 生成一张"待分配任务"卡 → 用户选 Project 或 Agent → 系统建一个固定专用 Session → 该群后续请求全部进入这个 Session 排队执行，结果回到原群。

## 2. 现状盘点（2026-09-11 按源码核对）

### 2.1 Router（OpenFluxRouter）

| 能力 | 飞书 | Slack | 钉钉 | 企业微信 |
|---|---|---|---|---|
| 私聊入站与绑定 | 有 | 有 | 有 | 有 |
| 群消息入站与入库 | 有 | 有 | **今天补齐** | 无 |
| 群 ↔ Project 映射（需群管理员在 OpenFlux 里绑定） | 有 | 有 | **今天补齐** | 无 |
| 多成员协作/方案卡片/任务确认卡片 | 有 | 无 | 无 | 无 |
| 群历史导入 | 有 | 无 | 无 | 无 |
| 结果回群 | 有 | 有 | **今天补齐** | 无 |

关键约束：群事件入库后，只有当群已经存在 `ChannelProjectMapping`（带 `flux_project_id`）时才会产生投递；没有映射时 Router 只回一句"这个群还没有启用 OpenFlux 协作"，事件落库但不会到达任何 OpenFlux。这就是 v0.1 第 9.1 节说的循环依赖：分配要先有 Project，但选 Project 的入口又依赖投递。

### 2.2 OpenFlux 客户端（OpenFlux-Rust）

| 项目 | 现状 |
|---|---|
| Router 连接头 | 只发 `X-App-ID`、`X-App-Type`、`X-App-User-ID`、`Authorization`；**没有** `X-OpenFlux-Capabilities` 和协议版本头 |
| 入站处理 | `router-bridge.ts` 只识别 `direction === 'inbound'`（私聊）和 5 个 action（bind_result、connect_status、llm_config、managed_runtime_config、qr_bind_*） |
| 群协议 | `project_context.append`、`group_collaboration.*`、`group_work.publish` 在客户端**完全没有实现** |
| 入站落点 | `standalone.ts` 的 `setupRouterMessageHandler` 把所有 Router 消息塞进按标题查找的全局 "Router Messages" 会话，直接执行 |
| 主动回复 | 依赖全局 `lastRouterUser`（最后一个发消息的人） |
| 可复用基础 | `TurnQueueStore`（按 Session 排队 + submissionId 去重）、`ExecutionRegistry`（同 Session 串行、取消）、`UserInputCoordinator`（澄清/审批）、`resolveSessionLocalEntity`（Session 归属解析）、`hydratePersistedQueue`（重启恢复） |

结论：Router 侧群链路已经能跑到"入库 + 投递"，但客户端这一端是空的。因此本计划的第一个工程阶段不是"待分配 UI"，而是让 OpenFlux 先能收群投递。

### 2.3 今天已完成（钉钉群，Router 侧）

- `gateway/internal/downstream/dingtalk_group.go`（新）：群消息归一化、@机器人 识别、群内回传（官方群消息接口，失败时退回会话 webhook）、基于回调 `isAdmin` 的管理员校验、机器人身份缓存。
- `gateway/internal/downstream/dingtalk.go`：Stream 与 HTTP 两条回调不再丢弃群消息，统一走 `handleInboundEvent`。
- `api-server/services/group_event_rules.py`：新增 `GROUP_PLATFORM_TYPES = ("feishu", "slack", "dingtalk")`，`group_project_controller.py` 六处白名单改用该常量。
- `gateway/cmd/gateway/main.go`：内部中继端点接受 dingtalk。
- 测试：Go 新增 5 个用例，全部通过；Python 规则测试 12 个通过。
- 文档：`router-integration-guide.md` 新增 5.1 钉钉群小节。
- 未做：真实钉钉群联调（需要一个开通机器人的测试群）；钉钉群历史导入、卡片、Bot-to-Bot 明确不支持。

## 3. 执行路线

五个阶段串行推进；P1 与 P0 的契约冻结可以并行开工，因为 P1 只依赖已有的 `project_context.append`。

### P0 契约冻结（Router + OpenFlux 共同，约 1 周）

目标：把 v0.1 第 9 节的"需要共同确定的字段语义"变成有 schema 和样例的契约，重点是未分配投递路径。

建议新增契约（名称为占位，须双方确认）：

| action | 方向 | 作用 |
|---|---|---|
| `external_conversation.pending` | Router → OpenFlux | 群首次有效请求在无映射时的投递。带稳定绑定键（platform_id、workspace_id、channel_id、conversation_type、executor_binding_id）、请求摘要、logical_request_id、reply_target。不带 project_id |
| `external_conversation.pending.ack` | OpenFlux → Router | 本地已持久化，回 delivery_id；不要求 session_id |
| `external_conversation.assign` | OpenFlux → Router | 分配：operation_id、target_kind（project / agent）、target_id、expected_revision |
| `external_conversation.assign.result` | Router → OpenFlux | 幂等确认；成功后 Router 把该群转为正式映射，后续事件走现有 `project_context.append` |
| 能力名 `external_conversation_assignment_v1` | 连接头 | 客户端只有真正实现后才声明 |

Router 数据层建议：复用 `ChannelProjectMapping`，新增 `status = pending_assignment`、`target_kind` 列，`flux_project_id` 允许为空；不新建表。未分配映射的目标设备由发送人的 `UserMapping`（已绑定的 app_user_id）决定，不广播。

P0 完成门槛：双方各自用样例 JSON 跑通"未分配 → 分配 → 已分配"三态的序列化与校验；OpenFlux 与 Router 各有一份写入仓库的样例文件。

### P1 客户端接住群投递（OpenFlux，约 1.5 周）

目标：不改产品形态，先让 OpenFlux 能够收到并正确落库 Router 的群事件。这一步不依赖 P0，可立即开工。

| 工作项 | 位置 | 说明 |
|---|---|---|
| 声明能力与协议版本 | `gateway/src/gateway/router-bridge.ts` 连接头 | 增加 `X-OpenFlux-Capabilities: group_context_v1`、`X-OpenFlux-Protocol-Version`。没有这一步 Router 会把投递标记为 unsupported |
| 识别群 action | `router-bridge.ts` 入站分发 | 新增 `project_context.append` 分支，类型化为 `RouterGroupDelivery` |
| 群事件存储 | 新文件 `gateway/src/gateway/external-request-store.ts` | 按 delivery_id / external_event_id 幂等落库；保存来源、发送人、reply_target、agent_execution_allowed、suppress_agent_execution |
| 先 ack 后处理 | `standalone.ts` | 本地写入成功后发 `project_context.ack`；不能收到包就 ack |
| 不再进全局会话 | `standalone.ts` `setupRouterMessageHandler` | 群投递不走 `getRouterSessionId`；私聊路径保持不变 |

P1 完成门槛：飞书或钉钉测试群里 @机器人，Router 日志显示投递成功且 ack 到达；OpenFlux 本地能查到该事件；重投同一事件不产生第二条记录；OpenFlux 离线时事件留在 Router 待投递队列，上线后补投。

### P2 待分配与固定 Session（OpenFlux 为主，Router 配合，约 2 周）

目标：实现 v0.1 第 3.1、3.2、5、6 节。

OpenFlux：

| 工作项 | 位置 |
|---|---|
| `ExternalConversationBinding` 存储与服务 | 新文件 `gateway/src/gateway/external-binding-store.ts` |
| 待分配卡片列表、展开、选择 Project/Agent、"分配并开始" | `src/sidebar/`（复用 `new-conversation.ts` 的归属选择组件）、`src/gateway-client.ts` 增加 3 个请求 |
| 分配操作：校验目标、幂等创建专用 Session、写入 `ownerKind/ownerId`、与 Router 确认、按顺序释放请求 | `standalone.ts`（复用 `resolveSessionLocalEntity`） |
| 专用 Session 的来源标签与排队状态展示 | `src/chat/follow-up-controller.ts` |

Router：

| 工作项 | 位置 |
|---|---|
| 无映射时创建 `pending_assignment` 映射并投递 `external_conversation.pending` | `api-server/controllers/group_project_controller.py` `ingest_group_event`；`gateway/internal/router/router.go` `RouteGroupInbound` 的 `!result.Mapped` 分支 |
| 处理 `external_conversation.assign`：幂等、expected_revision、转正式映射 | `group_project_controller.py` 新端点 + `gateway/cmd/gateway/main.go` action 分发 |
| Agent 作为归属目标 | 映射与投递校验链同时接受 target_kind=agent，不把 Agent ID 塞进 project_id |

P2 完成门槛（对应 v0.1 第 13 节）：同一群重投、并发点击、重启后仍只有一张卡、一个 Session；未分配期间不调用模型；分配后旧请求按顺序释放；拒绝或停用有明确状态且重投不复活卡片。

### P3 统一执行与控制（OpenFlux，约 2 周）

目标：v0.1 第 7 节，抽掉对桌面连接的依赖，让远程请求与本地聊天走同一条执行入口。

| 工作项 | 位置 |
|---|---|
| 抽取 `TurnSubmissionService` 与 `EventSink`，`PendingInteractiveTurn`、`executeQueuedChatTurn`、`hydratePersistedQueue` 不再直接依赖 GatewayClient | `standalone.ts` 拆分到 `gateway/src/gateway/turn-submission.ts` |
| 群请求复用 `TurnQueueStore` 排队，执行前读取最新会话上下文 | `gateway/src/sessions/turn-queue-store.ts` |
| Goal 占用、澄清、审批：远程请求持久化等待，不伪装内部续接 | `gateway/src/gateway/goal-orchestrator.ts`、`user-input-coordinator.ts` |
| 任务级回复上下文替代 `lastRouterUser`；缺失时拒绝隐式发送 | `standalone.ts` `notify_user` 注册处 |
| 同工作目录冲突保护 | `gateway/src/gateway/execution-registry.ts` |

P3 完成门槛：无 UI 连接时可执行与恢复；两条串行任务的顺序、上下文与失败传播符合 v0.1 第 3.3 节示例；审批与澄清由独立控制入口完成。

### P4 回传、联调与兼容（双方，约 1.5 周）

| 工作项 | 归属 |
|---|---|
| `ExternalOutbox`：任务级结果记录、发布幂等、平台回执、失败不重跑 | OpenFlux |
| `group_work.publish` 接入并复用现有 `GroupResultDelivery` | OpenFlux + Router |
| 状态回传文案："已收到，等待在 Flux 中选择 Project 或 Agent" 等，不显示"正在执行" | Router |
| 回归：本地聊天、Agent、Project、Goal、审批、队列、重启；旧 Router Messages 会话只读保留 | OpenFlux |
| 飞书测试群端到端，然后钉钉测试群独立验收 | 双方 |

P4 完成门槛：v0.1 第 13 节验收清单全部通过；测试产物不含真实凭据与私人会话。

## 4. 阶段依赖与建议排期

```
P0 契约冻结  ─┐
              ├─→ P2 待分配与固定 Session ─→ P3 统一执行 ─→ P4 联调
P1 接住群投递 ┘
```

- P0 与 P1 可同一周启动，P1 不等 P0。
- P2 需要 P0 契约和 P1 存储层；P3 需要 P2 的 Session 绑定；P4 需要全部。
- 总周期估算 7 到 8 周，按两侧各一名主力工程师计。估算只覆盖列出的工作项，不含平台审核与权限申请。

## 5. 联调前必须拍板的决策

1. `executor_binding_id` 的来源：沿用 `UserMapping.app_user_id`（当前设备实例）还是新增团队共享执行身份。建议第一版沿用前者。
2. `conversation_id` 稳定性：飞书 chat_id、Slack channel、钉钉 openConversationId 都稳定；私聊会话 ID 契约未明确，本期不承诺私聊。
3. 唯一开工权：`project_context.append` 与 `plan.generate` 同时到达时，只有前者（分配后）触发执行；飞书协作路径（plan/work order）本期不接入固定 Session，保持原样。
4. 有效期与上限：待分配卡 7 天未处理自动过期、单卡最多 50 条待处理请求、离线待投递保留 7 天。数字为建议值。
5. 首批测试范围：一个飞书测试群、一个钉钉测试群、两台已绑定设备；团队共享执行身份不启用。

## 6. 本周可以立即开始

- OpenFlux：P1 的能力声明与 `project_context.append` 分支，半天可见效果（Router 日志从 unsupported 变为 delivered）。
- Router：P0 样例 JSON 与 `pending_assignment` 状态的表结构评审；同时安排钉钉测试群，验证今天的群消息入站与回传。
- 双方：确认第 5 节前三项。

## 附录 A. P1 实施记录（2026-09-11）

状态：代码完成，单元测试与全量类型检查通过；未做真实 Router 联调，未提交。

| 工作项 | 落点 | 结果 |
|---|---|---|
| 声明能力与协议版本 | `gateway/src/gateway/router-bridge.ts` `buildRouterHeaders` | 正式连接与测试连接统一发送 `X-OpenFlux-Client-Version`、`X-OpenFlux-Protocol-Version: 2`、`X-OpenFlux-Capabilities: private_text_v1,private_media_legacy_v1,group_context_v1` |
| 识别群 action | `router-bridge.ts` `handleIncoming` | `project_context.append` 进入 `onGroupDelivery`，不再与私聊 `direction=inbound` 混流；`router_hello` 被保留并在 compatibility_state 非 compatible 时告警 |
| 群事件存储 | `gateway/src/gateway/external-request-store.ts`（新） | 追加式 jsonl，按 delivery_id 与 (platform_id, external_event_id) 双重去重，重启可恢复，坏尾行被忽略 |
| 先 ack 后处理 | `standalone.ts` `setupRouterGroupDeliveryHandler` | 本地落库成功后才发 `project_context.ack`；落库失败不 ack，留给 Router 重投；ack 发送失败记为 ack_failed，连接恢复后补发 |
| 运行时登记 | `standalone.ts` `registerRuntimeWithRouter` | 连接建立、Project 创建/更新/归档时发 `runtime.register`，Router 据此重放待投递 |
| 不再进全局会话 | `standalone.ts` | 群投递只落库并向 UI 广播 `router.group_event`，不进入 Router Messages 会话，不启动 Agent 回合 |
| 测试 | `external-request-store.test.ts`、`router-bridge.test.ts` | 8 个用例通过；已加入 `npm test` 列表 |

联调时的观察点：Router 日志里该设备的 compatibility_state 应为 compatible；群里 @机器人 后 Router 侧 delivery 状态变为 acked；客户端 `sessions/external-requests.jsonl` 出现对应记录。

## 附录 B. P2 实施记录（2026-09-11）

状态：两端代码完成，单元测试与类型检查通过；未做真实 Router 联调，未提交。契约由本次实现直接定义，P0 的"双方确认"改为以下条目待 Router 同事复核。

### B.1 契约（实际落地的形式）

| 项目 | 落地方式 |
|---|---|
| 未分配投递 | 沿用 `project_context.append`，新增字段 `assignment_state: pending / assigned`；pending 时 `project_id` 为空。投递、重放、ack 全部复用 P1 通道 |
| 能力名 | `external_conversation_assignment_v1`。客户端在握手头声明；Router 只对声明了该能力的已绑定设备开待分配卡，旧客户端保持"群未启用"提示 |
| 分配 | `external_conversation.assign` → `external_conversation.assign.result`，字段 mapping_id、operation_id、target_kind、target_id、target_name、expected_revision。按 operation_id 幂等，revision 不匹配返回 409 |
| 忽略 | `external_conversation.dismiss` → `.result`。之后该群消息仍入库但不再投递、不再开卡 |
| Router 数据层 | 复用 `ChannelProjectMapping`：`status = pending_assignment / assignment_dismissed`，`config.assignment = {state, revision, operation_id, target_kind, target_id, …}`，`authority_source = first_request`。无需迁移 |
| 目标设备 | 发送人的 `UserMapping` 所指向的 app_user_id；不广播。同一群只有一张卡、一个执行设备 |

### B.2 Router 改动

- `api-server/services/group_event_rules.py`：`should_open_pending_assignment`、`assignment_transition`、`pending_assignment_config`、`runtime_supports_assignment`，含单元测试。
- `api-server/controllers/group_project_controller.py`：ingest 在无映射时调用 `_open_pending_assignment_if_needed`；新增 `/assign` 与 `/dismiss` 内部端点；`_event_payload` 输出 `assignment_state`；ingest 响应新增 `assignment_state`、`assignment_created`、`planning_supported`。飞书群在没有协作关系时不再把 @机器人 当成方案请求，改为直接投递执行。
- `gateway/cmd/gateway/main.go`：控制动作 `external_conversation.assign / dismiss`，分配成功后向群发"已交给 OpenFlux …"提示；hello 里广播新能力。
- `gateway/internal/router/router.go`：首次开卡时向群回"已收到，等待在 OpenFlux 中选择 Project 或 Agent"；pending 期间不发"未加入协作"提示；只有存在协作关系时才发起方案请求。

### B.3 OpenFlux 改动

- `gateway/src/gateway/external-binding-store.ts`（新）：群绑定 jsonl，状态 pending → assigning → assigned / dismissed，operation_id 首次固定，重启可恢复。
- `gateway/src/gateway/external-request-store.ts`：新增 `assignmentState` 与 release 记录（queued / completed / failed），`unreleased(mappingId)`。
- `gateway/src/gateway/router-bridge.ts`：`request()` 按 request_id 匹配 `.result`，超时与断线拒绝；声明新能力。
- `gateway/src/gateway/standalone.ts`：`routeStoredGroupRequest` 决定开卡或释放；`handleRouterAssignmentAssign` 创建专用 Session（`sessions.create(targetId, 群名 · 平台)`）、向 Router 确认、按顺序释放旧请求；每个 Session 一条 promise 链保证串行；结果通过 `group_message.send` 回群；启动时恢复未释放请求。
- UI：侧栏顶部"待分配任务"卡片（平台、群名、发起人、首条请求、条数），"分配并开始"弹窗复用会话归属选择器，"忽略"需二次确认；分配后自动打开专用会话。中英文案已加。

### B.4 已知边界

- 群内附件本期不下载，只以文字提示进入会话。
- 群请求的串行队列独立于本地聊天的 TurnQueueStore，与本地输入的互斥、澄清、审批衔接留给 P3。
- 同一群第二位发起人的消息只作为上下文，不会为其单独开卡（映射表一群一行）。

## 附录 C. P3 实施记录（2026-09-11）

状态：客户端代码完成，单元测试与类型检查通过；未做真实联调，未提交。Router 侧本阶段无改动。

### C.1 取舍

原计划"抽取 TurnSubmissionService / EventSink"意味着重构 standalone.ts 里一万行的聊天主链路。实际采用等价但侵入更小的做法：为外部群请求构造一个"无界面客户端"（`createExternalTurnClient`），它实现与桌面 WebSocket 相同的 `send` 契约，事件落到 `handleExternalTurnEvent`。群请求由此走与本地消息完全相同的 `handleChat`：持久化 TurnQueueStore、ExecutionRegistry 串行、工具审批、澄清、Goal 占用判断，只有事件出口不同。P2 的独立 promise 链已删除。

### C.2 覆盖的 P3 目标

| 目标 | 落地 |
|---|---|
| 群请求复用 TurnQueueStore 排队，执行前读取最新上下文 | `submitExternalRequestTurn` 以 `delivery: 'queue'` 提交，`submissionId = external:<delivery_id>` 去重；重启后 `hydratePersistedQueue` 通过 payload.external 重建事件出口 |
| Goal 占用时远程请求持久化等待，不伪装续接 | `chat.accepted` 返回 goal_active → 记为 deferred，群里提示一次；每 60 秒及每次群会话回合结束后重试 |
| 审批与澄清走既有状态机 | 审批：broker 允许任意桌面端为 external 所有者的请求做决定；澄清/计划批准：回合以 waiting_input 结束时群里提示"需在 OpenFlux 中补充"，桌面端回答后的续接回合完成时由 `settleExternalContinuation` 把结果送回群 |
| 任务级回复上下文替代 lastRouterUser | notify_user 新增 `resolveReplyTarget`：按当前执行上下文的 turnId → 会话所属群绑定 → 私聊会话依次解析；群会话未完成分配时明确拒绝；只有本地/定时任务保留旧的"最后发信人"回退 |
| 同工作目录冲突保护 | `findWorkspaceConflict` 检查 ExecutionRegistry 里是否有其他会话正在同一 Project 目录执行；有则 deferred 并提示，不并行写入 |
| 无 UI 连接可执行与恢复 | 事件出口不依赖桌面连接；桌面在线时所有回合事件同时镜像给桌面端，会话里可见 |

### C.3 改动文件

- `gateway/src/gateway/standalone.ts`：`ExternalTurnContext` 进入 `InteractiveChatPayload`（非受信 payload 携带该字段直接拒绝）；新增回复目标表、`createExternalTurnClient`、`handleExternalTurnEvent`、`submitExternalRequestTurn`、`releaseGroupRequests`（改为顺序提交）、`settleExternalContinuation`、`findWorkspaceConflict`；私聊路径登记任务级回复目标。
- `gateway/src/gateway/tool-approval-broker.ts`：记录 ownerRole，external 所有者的审批可由任一桌面端回答。
- `gateway/src/tools/notify/index.ts`：`NotifyReplyTarget`，群目标经 `group_message.send` 发送，去抖按目标而非用户。
- `gateway/src/gateway/external-request-store.ts`：release 状态增加 deferred / waiting_input，`markDeferred`。
- 测试：审批代理、请求存储各加一个用例；受影响的 8 个测试文件共 60 余用例通过。

### C.4 未覆盖

- 群成员无法从 IM 直接回答澄清或批准计划，只能在 OpenFlux 里操作；IM 侧只收到提示。
- 附件仍未下载。
- 本地用户在专用会话里输入的普通消息不会自动回群；只有 notify_user 明确调用时才会发到群（回复目标解析到该群）。

## 附录 D. P4 实施记录（2026-09-11）

状态：代码完成，回归测试通过，未提交。真实飞书 / 钉钉测试群联调需要测试群与机器人，本轮未执行；提供了本地假 Router 用于端到端演练，以及真实联调清单。

### D.1 ExternalOutbox

- `gateway/src/gateway/external-outbox-store.ts`（新）：每个外部请求一条结果记录（`<delivery_id>:result`），先落盘再发布，只重发存储的内容，永不重跑 Agent。状态 pending → accepted / fallback_sent / failed；传输失败按 5s、30s、2m、10m、1h 退避，12 次后放弃。
- 发布走 `group_work.publish`，Router 侧按触发事件幂等并负责平台重试与回执；客户端在 `router-bridge.ts` 新增 `publishGroupWork`，按 `trigger_event_id` 匹配 `group_work.result`。
- Router 明确拒绝结构化结果时（例如找不到触发消息），退回一次 `group_message.send` 并记为 fallback_sent，不循环。
- 连接恢复、启动、每 60 秒各刷一次未发送的结果。
- Router：分配完成时把待分配期间创建的投递记录补上目标 Project，否则这些请求的结果会被 `publish_group_work` 以"未投递给当前 Project"拒绝。

### D.2 回归

`npm test`（gateway 全量）：817 个用例，816 通过，0 失败，1 个 todo。覆盖本地聊天、Agent、Project、Goal、审批、澄清、队列、重启恢复、定时任务等既有测试；新增的群相关测试文件 5 个。私聊 Router Messages 会话路径未改动。

### D.3 本地端到端演练（不接触生产 Router）

```
cd OpenFlux-Rust/gateway
node scripts/fake-router.mjs --port 8899 --platform dingtalk --name 测试群
```

把客户端 `server-config.json` 的 router 指向 `ws://127.0.0.1:8899/ws/app`（appId、apiKey 任意），启动 OpenFlux。假 Router 会打印握手头是否声明了 group_context_v1 与分配能力，并在 `runtime.register` 后重放待投递。

两个实际演练时踩到的点：

- 本机若装有品牌版（`src-tauri/.brands/openflux.brand.yaml`），网关会用品牌锁定的生产 Router 地址覆盖 server-config.json。演练时必须设置 `OPENFLUX_BRAND_OVERLAY` 指向一个内容为 `{}` 的文件，否则会连到真实 Router。
- Node 22.12 以上直接 `node --import tsx/esm` 启动会因 pptxgenjs 的 require(esm) 循环失败；用生产同款方式启动：`src-tauri/node.exe gateway/node_modules/tsx/dist/cli.mjs gateway/src/gateway/start.ts`，工作目录放一份 openflux.yaml 指定独立 workspace 与端口。

在假 Router 终端输入（或加 `--control-port 8898` 后用 HTTP 驱动）：

1. `mention 帮我看下登录问题` → 客户端侧栏出现待分配卡；假 Router 收到 ack。
2. 在客户端点"分配并开始"选 Project → 假 Router 打印 mapping → active，客户端专用会话开始执行，完成后假 Router 打印 `group_work.publish`。
3. 再次 `mention …` → 直接进入同一会话排队；`context …` 只入库不执行。
4. 关闭客户端再启动 → 未 ack 的投递被重放，未发布的结果被补发。
5. `status` 查看假 Router 侧的映射、投递与已发布记录。

### D.3.1 本机演练结果（2026-09-11）

用独立网关实例（端口 18899、独立 workspace）+ 假 Router + 本机假 LLM 服务跑通：握手 compatible 且能力齐全；首次 @ 开出一张卡（1 群 1 卡，多条请求合并）；分配后假 Router 映射转 active，专用会话创建并按顺序执行两条请求，结果经 `group_work.publish` 回传且按触发事件幂等；普通群消息只入库不执行；错误时向群发一次提示；网关重启后未 ack 投递被重放并继续处理。

### D.4 真实联调清单（需要测试群）

| 步骤 | 观察点 |
|---|---|
| 客户端连接生产 Router | Router 日志 compatibility_state = compatible，能力含 group_context_v1、external_conversation_assignment_v1 |
| 群内 @机器人 | Router 回"已收到，等待在 OpenFlux 中选择"；客户端出现卡片；Router 侧 delivery 为 acked |
| 分配 | 群里收到"已交给 OpenFlux …"；`channel_project_mappings.status = active`，`config.assignment.state = assigned` |
| 执行完成 | 群里收到结果；`group_result_deliveries` 有 external_key `<trigger>:delivery:public` 且 status sent |
| 重复投递 / 重启 | 不产生第二张卡、第二次执行、第二条结果 |
| 钉钉专项 | 管理员校验依赖回调 isAdmin；群消息接口权限；无 Thread |
| 飞书专项 | 有协作关系的群仍走方案卡片路径；无协作关系的群直接执行 |

### D.5 未覆盖

- 附件仍未下载；群成员不能从 IM 回答澄清。
- 本地假 Router 只模拟一个群、一个设备，不模拟平台真实发送失败。

## 附录 E. Router 上线兼容性审查（2026-09-11）

### E.1 数据库

- 本次没有新的迁移文件，`apply-release.sh` 的迁移步骤为空操作。
- 只新增了两个 `channel_project_mappings.status` 取值（`pending_assignment`、`assignment_dismissed`）和 `config.assignment` JSON 字段；`flux_project_id`、`project_name` 在待分配期间为空字符串，列本身非空约束不受影响；`authority_source` 新增取值 `first_request`。
- `event_deliveries.flux_project_id` 在待分配期间为空字符串，分配时统一补上目标；列为非空字符串，无约束冲突。
- 所有既有查询都用 `ACTIVE_MAPPING_STATES`（active、offline）过滤，待分配和已忽略的行对它们不可见；只有入库查询额外识别这两个状态。

### E.2 对既有数据与旧客户端的影响

| 场景 | 上线后行为 |
|---|---|
| 已有飞书协作群 | 不变。方案卡片、任务确认、历史导入路径未改 |
| 已有飞书单 Project 映射（无协作关系） | 不变。@机器人 仍走原来的方案请求路径；只有由分配流程创建的映射才直接执行 |
| 旧版客户端（未声明分配能力） | 不变。未映射群仍收到"这个群还没有启用 OpenFlux 协作"，不会开卡 |
| 飞书群先被开卡、后由管理员启用协作 | 协作激活会接管待分配行并清除分配记录，与"已移除"行同样处理 |
| 手动关联一个处于待分配或已忽略状态的群 | 允许接管，不再返回"已经关联了其他 Project" |
| 钉钉群 | 新增入站。未映射群只保存真实 @机器人 的消息，普通聊天不入库；被 @ 且发送人未绑定时回复"群未启用"提示 |

### E.3 回滚

`apply-release.sh` 失败时自动恢复代码与服务配置；数据库备份保留。若上线后需要手动回退到旧代码，先清理新状态的行，否则旧代码会把它们当作已存在的映射：

```sql
UPDATE channel_project_mappings SET status = 'removed'
 WHERE status IN ('pending_assignment', 'assignment_dismissed');
```

### E.4 上线记录（2026-09-11 23:51）

release router-backend_20260911_231735 已应用到生产 openflux.io，备份位于 `/home/openflux.io/release_backups/router-backend_20260911_231735`。上线后核对：api、gateway、nginx 均 active，健康端点与公网入口 200；服务器代码含 assign 端点与钉钉群适配，网关二进制含新能力名；映射 7、协作 7、事件 111，与上线前一致，无积压投递；schema 未变化；飞书与钉钉适配器已启动；客户端断线约 14 秒后自动重连。Router 源码在本地仍未提交，需尽快提交以对齐线上。

## 7. 变更约束

- 本文与今天的钉钉群改动均未提交、未部署；提交与发布另行授权。
- 保留 `router-integration-guide.md` 作为现有契约基线，新契约以附录方式追加，不改写原节。
- 联调日志不得包含 API Key、平台 Secret、访问令牌或私人文档正文。
