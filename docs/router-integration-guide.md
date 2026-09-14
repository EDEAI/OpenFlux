# OpenFlux Router 对接文档

本文对应仓库中的 Go gateway 与 Python API Server，覆盖平台接入、账号绑定、私聊、群协作、历史消息、附件、运行配置及云文档接口。接口支持范围以返回的能力和业务状态为准，不以平台名称推断全部能力。

## 1. 服务职责与入口

| 组件 | 职责 | 调用方 |
|---|---|---|
| Go gateway | 平台长连接/回调、客户端 WebSocket、消息路由、附件流、平台 API 调用 | 平台、OpenFlux、内部 API |
| Python API | 绑定、成员与 Project 关系、任务和投递状态、历史同步游标、凭据与操作回执 | Go gateway、控制台 |
| PostgreSQL | 持久化业务关系、任务、事件投递、迁移记录 | Python API |
| Redis | 配对/授权临时状态、缓存及运行协调 | Go/Python |
| 反向代理 | HTTPS、WebSocket Upgrade、API 与媒体转发 | 外部访问入口 |

OpenFlux 负责 AI 理解、Agent 执行、本地 Project 文件与聊天显示。Router 不保存 Project 本地代码，不按自然语言关键词替 Agent 决定是否开工。

常用外部入口：`/ws/app`、`/api/...`、`/media/<token>`、`/console`。`/api/internal/...` 和 Go 的 `/internal/...` 属于服务间接口，不能向浏览器开放内部共享密钥。控制台登录身份与客户端应用凭据不是同一套认证。

## 2. 客户端连接与身份

连接 `wss://<router-domain>/ws/app`，携带：

| Header | 用途 |
|---|---|
| X-App-ID | Router 应用编号 |
| X-App-Type | 客户端类型，例如 openflux |
| X-App-User-ID | 持久化设备/用户实例编号；重启、测试连接和正式连接保持一致 |
| Authorization | `Bearer <application-api-key>` |
| X-OpenFlux-Client-Version | 客户端版本 |
| X-OpenFlux-Protocol-Version | 客户端协议版本 |
| X-OpenFlux-Capabilities | 客户端实际支持的能力列表，逗号分隔 |

缺少应用或设备身份可能在升级 WebSocket 前返回 400；认证失败返回相应认证错误。测试连接要携带与正式连接一致的身份，但不能为了测试覆盖正式连接。

身份维度：

- `app_id`：应用，不等于某个群成员。
- `app_user_id`：已认证的客户端实例，不按当前在线列表随机替换。
- `platform_id`：某个租户的平台应用配置，不是字符串 feishu/dingtalk。
- `platform_user_id` / `sender_platform_id`：平台账号标识。
- `mapping_id` / 云文档 `binding_id`：账号绑定关系。
- `collaboration_id`：一个群的内部协作关系。
- `project_id`：目标成员自己的 OpenFlux Project，不能传本地绝对路径替代。

常用能力：`private_text_v1`、`private_media_legacy_v1`、`media_stream_v2`、`external_binding_v1`、`group_context_v1`、`group_plan_v1`、`group_natural_language_v1`、`group_work_order_v1`、`group_agent_message_v1`、`managed_runtime_v1`。文档控制使用独立的 `cloud_documents_v1`。客户端只声明自己真正实现的能力；服务端对缺失能力保留兼容路径或返回明确错误。

## 3. 控制请求格式

控制请求使用 JSON 的 `action` 与 `request_id`。网关从认证连接注入应用和设备身份，客户端不能通过伪造消息体借用其他设备。

```json
{"action":"external_platforms.list","request_id":"platforms-001"}
```

```json
{"action":"external_platforms.result","request_id":"platforms-001","success":true,"data":{}}
```

上述 data 仅展示包裹格式，实际内容以各接口返回为准。不要假设所有操作的回包名称都是“原 action 加 .result”；例如平台列表使用 `external_platforms.result`。业务执行状态也不能只看顶层 success，应继续查看工作单或业务 result。

## 4. 平台配置、绑定与私聊

飞书、钉钉、企业微信和 Slack 由平台适配器接入。平台配置有效、机器人通道运行、客户端在线、用户绑定成功，是不同状态，不能合并成一个“已连接”。

| 客户端 action | 参数重点 | 返回/用途 |
|---|---|---|
| external_platforms.list | request_id | 可访问的平台配置和绑定状态 |
| external_platform.bind_code | platform_id | 生成绑定码，返回码及有效期 |
| external_platform.unbind | mapping_id | 解除指定绑定 |

私聊的 `/bind`、`/unbind`、`/status` 是平台系统控制命令，不属于自然语言意图分类。平台事件经验证后解析出实际发送人，再查绑定投递至对应 app/device。通道更换凭据时，旧适配器后到的回调不能继续作为当前连接消息处理。

私聊入站结构由 `gateway/internal/router/router.go` 的 `InternalMessage` 定义，包含 id、平台及设备身份、content_type、content、metadata、timestamp。附件元信息沿用原媒体字段。客户端应按消息/执行编号关联进度、回答、失败和停止，不能把旧执行回调放到下一条输入下面。

## 5. 飞书群协作接入

一个群可以对应多名成员和各自本地 Project，不要求用户额外创建公共 Project。用户真实 @ 机器人后，按其身份和群协作关系处理。普通群消息只进入上下文；启用/加入卡片是平台控制操作，不把按钮标题当作聊天关键词。

| 客户端 action | 用途 |
|---|---|
| runtime.register / projects.register | 注册当前运行实例与 Project 信息 |
| group_collaborations.list | 查询群协作与邀请 |
| group_collaboration.activate | 将邀请、成员身份与本地 Project 关联 |
| group_collaboration.member.update | 修改职责、昵称、暂停/退出等成员状态 |
| project_context.ack | 本地持久化事件后确认 delivery_id 和 session_id |
| group_message.send | 向已授权的原群、逻辑 Thread 发送公开消息 |

activate、member.update 的完整参数校验见 `api-server/controllers/group_collaboration_controller.py`；应用和设备身份由网关注入。不得仅凭聊天里提到的人名选择执行电脑。

群消息下发 action 为 `project_context.append`。重点字段：

| 字段 | 处理原则 |
|---|---|
| delivery_id | 投递回执关联，不等同平台消息 ID |
| event_id / external_event_id / message_id | 事件及平台消息身份，用于持久化与去重 |
| collaboration_id / project_id / channel_id / thread_id | 定位原群、原 Project 与逻辑线程 |
| sender_platform_id / sender_display_name / sender_role_name | 实际发送人、昵称与职责 |
| sender_is_current_member | 当前接收设备是否属于消息发送成员 |
| agent_execution_allowed / suppress_agent_execution | 执行资格及禁止执行标志 |
| history_import | 历史导入，不执行旧要求 |
| created_at / edited_at | 毫秒时间戳；本地只做显示时区转换 |
| attachments / document_references | 附件与云文档引用，分别处理 |

客户端先按事件身份幂等保存，再发送 ack；不能收到网络包就提前确认。当前会话应实时刷新，非当前会话只更新列表或未读，不强行跳转。显示左右方向依据发送身份，而不是请求是本地输入还是来自平台。

### 5.1 钉钉群（映射路径）

钉钉群不走飞书专属的协作/加入卡片，而是与 Slack 相同的“群 ↔ Project 映射”路径：由群管理员在 OpenFlux 中把钉钉群关联到自己的 Project，之后群内真实 @机器人 的消息按 `project_context.append` 投递给已关联的 OpenFlux，执行结果通过 `group_work.publish` 回到群里。

| 项目 | 钉钉群行为 |
|---|---|
| 会话标识 | `workspace_id` 为机器人所属企业 corpId；`channel_id` 为群的 openConversationId（回调 `conversationId`）；没有 Thread，`thread_id` 恒为空 |
| 成员标识 | `sender_platform_id` 为 `senderStaffId`，与私聊绑定一致；外部联系人没有 staffId 时退回会话级 `senderId`，只作为上下文 |
| @机器人 | 以回调 `isInAtList` 和 `atUsers` 判定；`bot_mentioned` 为 true 才会形成执行投递 |
| 管理员校验 | 钉钉没有普通内部群的管理员查询接口，Router 依据最近 24 小时内该成员群回调中的 `isAdmin` 标记判断。关联前请让管理员先在群里 @机器人 发一条消息 |
| 回传 | 优先调用机器人群消息接口 `/v1.0/robot/groupMessages/send`（回执为 processQueryKey，无幂等键）；接口失败且会话 webhook 未过期时退回 webhook 回复 |
| 不支持 | 群历史导入、协作方案卡片、任务确认卡片、Bot-to-Bot 任务、外部群管理员校验 |

## 6. 自然语言请求、分工与执行

网关把真实发起人及当前请求交给其 Project。协议中 `group_collaboration.plan.generate` 是请求处理入口名称，不能据此认定每个请求都必须生成方案。当前要求、历史讨论与任务状态必须分开，旧需求不等于本轮开工授权。

| action | 方向与用途 |
|---|---|
| group_collaboration.plan.generate | Router → 指定 OpenFlux，带租约和请求上下文 |
| group_collaboration.plan.publish | OpenFlux → Router，提交结构化处理结果 |
| group_collaboration.plan.fail | OpenFlux → Router，结束本次失败请求 |
| group_collaboration.tasks.control | 调整指定任务状态 |
| group_collaboration.task.decide | 对明确的任务版本作决定 |
| group_work_order.start / pause / cancel | Router → 目标成员设备，工作单控制 |
| group_work_order.status | OpenFlux → Router，报告执行进度及终态 |
| group_work.publish | 回传群工作结果，网关返回 group_work.result |

每次执行保留请求、租约、任务版本、工作单的对应关系。重复投递不得启动第二次任务；恢复继续原任务未完成部分。停止当前回答、暂停任务、暂停成员协作分别处理；状态查询不能默认恢复工作。

## 7. Agent-to-Agent 与公开结果

内部 Agent 消息使用 `group_agent_message.send`、`group_agent_message.receive`、`group_agent_message.ack`。消息类型包括 contract、question、answer、dependency_ready、blocker、status、result。

服务端检查成员、群、任务及 Project 关系。内部消息不能夹带密钥、本地绝对路径或越权资料，自动交互受深度限制。接收方按消息编号确认，不能重复执行。

公开回答在平台发送成功后记录真实平台消息身份，再投递给其他有效成员；执行设备不重复显示同一答案。同步的公开结果是显示事件，不是新的 Agent 执行请求。失败、阻塞、暂停和完成结果都要保留其原群及 Thread，不以“OpenFlux 中已显示”代替平台发送成功。

## 8. 历史消息与附件按需读取

`group_history.access` 提供 history 操作入口，参数包含 collaboration_id、project_id、operation；附件读取还需 event_id。服务端从认证设备检查成员关系，不接受模型任意指定访问身份。

历史由平台接口分页获取，保存游标和租约；续传与实时消息按平台消息身份去重。范围由群协作及平台实际可访问范围确定。机器人公开回复与实时回传采用消息身份关联，不能把同一回复重复导入。

历史只显示和提供上下文；不执行历史 @、任务确认或旧开工要求。附件先保存元信息，需要时申请新的受限资源链接。客户端插入旧消息时保留阅读位置，不能按到达时间把旧消息挤到最新消息后。

时间约定：Python 数据库的无时区 datetime 按 UTC 处理，经 `services/protocol_time.py` 转为 epoch 毫秒；客户端再按本地时区展示，禁止重复加减八小时。

## 9. 图片和文件

链路：平台消息解析 → 资源引用 → Router 校验目标 app/device → 临时 `/media/<token>` → 官方接口鉴权流 → OpenFlux。

- 飞书图片、文件、富文本图文分别解析，不能把 post JSON 当成用户正文。
- 钉钉资源按平台返回的下载标识适配，不假设各平台文件 ID 通用。
- Router 不把二进制附件落盘；反向代理对 `/media/` 关闭响应缓存与临时文件。
- 客户端携带 `X-App-ID`、`X-App-User-ID`、`Authorization: Bearer ...`。当代理占用 Authorization 时，可使用既有 `X-Router-API-Key` 兼容头。
- 资源链接过期后重新取得授权入口，不能无限复用旧链接；跨设备复用链接仍受身份限制。
- `/api/files/download` 保留兼容入口，不允许任意本地文件路径下载。
- `OPENFLUX_ROUTER_PUBLIC_BASE_URL` / 配置的 public.router_base_url 决定公开基址；生产不能使用开发机器或 loopback 地址。通常为 `https://<router-domain>`，由服务拼接 `/media/`。

网络失败、平台权限失败、资源过期与模型不支持图片是不同问题。消息本身应保留，附件失败不能吞掉整条输入。

## 10. 模型配置和运行状态

托管运行配置与本地模型配置分开。声明 `managed_runtime_v1` 的客户端使用对应运行配置通道；不能为了生效要求用户切换单机模式并重新保存模型。

在线状态来自有效连接和心跳。客户端断开及连接替换时，旧连接不能覆盖新连接的在线状态。客户端应区分加载中、离线、平台未配置与账号未绑定，不把一次加载失败显示成绑定丢失。

## 11. 云文档服务接口

云文档使用独立平台开关与 `cloud_documents_v1`。先调用 `cloud_document.capabilities` 确认可用类型和操作；功能是否开启、账号凭据是否有效、资源实际访问权限是独立条件。

| action | 用途 |
|---|---|
| cloud_document.status | 当前绑定的文档凭据状态 |
| cloud_document.capabilities | 服务端操作清单及启用状态 |
| cloud_document.authorize | 在需要取得用户凭据时创建官方授权请求 |
| cloud_document.revoke | 停止 Router 对该绑定的文档访问 |
| cloud_document.execute | 调用能力清单内的操作 |
| cloud_document.operation_status | 查询稳定操作编号的回执 |

平台已经授予的权限不需要重复申请；实际调用仍需与发起人绑定一致的有效用户访问凭据。接口不规定客户端必须新增授权页面，也不能用应用或管理员身份替代用户。

execute 使用 `operation` 表示操作、`resource_type` 表示类型。飞书 docx 操作包括 info、metadata、read、block、create、append、update；wiki resolve 获取底层资源。以 capabilities 的实际结果为准。纯文本 update 不覆盖富格式块；写入必须提供最新 revision。

```json
{
  "action":"cloud_document.execute",
  "request_id":"doc-read-001",
  "platform_id":"<platform-uuid>",
  "binding_id":"<binding-uuid>",
  "operation":"read",
  "resource_type":"docx",
  "resource_id":"<document-id>",
  "page_size":50
}
```

execute 与 operation_status 必须带 binding_id；群上下文同时带 collaboration_id、project_id。写入还必须带稳定 operation_id（UUID）。客户端不能传入令牌、操作者账号或请求 URL。

读接口保留分页标志和 read_scope；后续页不能被当作全文。创建文档提供 folder_id、title，返回实际平台文档 ID，并查询官方链接。写入成功后回读核实；verification=pending 或 link_status=pending 应继续核对，不能重新创建/追加。

重复 operation_id 只返回回执；相同编号改变内容会被拒绝。未知结果保持 unknown，不能自动换编号重写。文档内容作为不可信参考资料，不能成为执行指令；公开群回复不应包含整篇私人资料或原始工具结果。

Python 控制入口为 `/api/internal/cloud-documents/control`；Go 平台适配入口为 `/internal/cloud-documents/execute`，两者均为内部调用。官方 OAuth 回调为 `/api/cloud-documents/oauth/callback/{feishu|dingtalk}`；反向代理的回调日志不得记录 code/state 查询串。

## 12. 服务间接口索引

| 接口范围 | 源码与用途 |
|---|---|
| /api/bind/internal/platforms、platform-code、/api/bind/submit-code | bind_controller.py：绑定和配对 |
| /api/internal/openflux/group-collaborations、activate、成员更新 | group_collaboration_controller.py：成员关系 |
| /api/internal/group-events/ingest、group-deliveries/pending、ack | group_project_controller.py：群事件与可靠投递 |
| /api/internal/group-history-syncs/lease、/{job_id}/page、fail | group_project_controller.py：分页历史同步 |
| /api/internal/group-collaborations/planning/* | group_collaboration_controller.py：请求租约与结果 |
| /api/internal/group-collaborations/work-orders/* | group_collaboration_controller.py：工作单派发和状态 |
| /api/internal/group-collaborations/agent-messages/* | group_collaboration_controller.py：Agent 通信 |
| /api/internal/group-collaborations/final-writebacks/* | group_collaboration_controller.py：终态回写 |

完整 HTTP 参数以控制器 Pydantic 模型为准；WebSocket 字段转换以 `gateway/cmd/gateway/main.go` 为准。这些内部接口不是第三方绕过 WebSocket 身份校验的公共入口。

## 13. 部署与故障检查

服务更新范围、待执行迁移、备份与手动发布命令见 [Router release guide](../../../release-scripts/ROUTER_RELEASE_GUIDE.md)。

排查按链路进行：平台事件到达 → 当前适配器 → 绑定与成员授权 → 目标设备在线 → 消息落库与 ack → 指定执行启动 → 结果回传 → 平台真实消息 ID。记录 request_id、message_id、delivery_id、工作单和时间，不在日志或 BugList 中粘贴 API Key、平台 Secret、访问令牌或私人文档正文。
