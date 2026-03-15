# NexusAI 圆桌（聊天室）WebSocket 指令文档

**创建时间：** 2026-03-12  
**最后更新：** 2026-03-12  
**作者：** 安东辉、王驰、张健、高振东  
**状态：** 已发布  
**来源：** NexusAI 官方协议文档

## 文档概述
NexusAI 圆桌服务 WebSocket 聊天协议，用于用户与 Agent 的实时聊天通信。

## 更新记录
| 日期 | 版本 | 更新内容 | 更新人 |
|------|------|----------|--------|
| 2026-01-30 | v1.2 | 新增 Agent 发送图片（THINKING/IMGGEN/WITHFILECONTENTLIST） | 安东辉、张健、高振东 |
| 2025-07-11 | v1.1 | 新增技能/工作流用户补充入参文件 | 安东辉、王驰 |

## 连接

```
URL: wss://nexus-chat.atyun.com/?token=<token>
```

Token 与网页接口的 token 一致。

## 消息格式

### 客户端 → 服务端

格式：JSON 数组 `[指令, 参数]`

```json
["ENTER", 43]
["INPUT", "请简单介绍一下塞尔达传说系列游戏。"]
```

### 服务端 → 客户端（广播）

两种格式：
1. **指令**：`--NEXUSAI-INSTRUCTION-[指令, 参数]--`
2. **纯文本**：AI 回复内容流

## 客户端 → 服务端 指令列表

| 指令 | 描述 | 参数类型 | 示例 |
|------|------|----------|------|
| ENTER | 进入聊天室（必须先执行） | Int（聊天室 ID） | `["ENTER", 43]` |
| ISDESKTOP | 是否为桌面端 | Bool（默认 False） | `["ISDESKTOP", true]` |
| ENABLETHINKING | 开启思考模式 | Bool（默认 False） | `["ENABLETHINKING", true]` |
| ENABLEIMGGEN | 开启图片生成模式 | Bool（默认 False） | `["ENABLEIMGGEN", true]` |
| MCPTOOLLIST | MCP 工具列表 | List[Dict]（默认空） | 见文档 |
| TRUNCATE | 清除聊天室记忆 | Int（0=本聊天室） | `["TRUNCATE", 0]` |
| SETABILITY | 设置 Agent 能力 | Int（0=所有能力） | `["SETABILITY", 0]` |
| FILELIST | 用户发送的文件列表 | List[Int] | `["FILELIST", [120, 121]]` |
| INPUT | 发送消息开始聊天 | Str（不允许空） | `["INPUT", "你好"]` |
| MCPTOOLFILES | 用户补充文件（技能/工作流） | Dict{id, files_to_upload} | 见文档 |
| MCPTOOLRESULT | 桌面端回传第三方 MCP 工具结果 | Dict{id, result} | 见文档 |
| STOP | 停止聊天 | Null | `["STOP", null]` |

## 服务端 → 客户端 指令列表

| 指令 | 描述 | 参数类型 | 前端动作 |
|------|------|----------|----------|
| OK | ENTER/ISDESKTOP 等的确认响应 | Null | 忽略 |
| TRUNCATABLE | 是否可清除记忆 | Bool | 控制清除记忆按钮 |
| TRUNCATEOK | 清除记忆成功 | Int（聊天室 ID） | 忽略 |
| THINKING | 是否已开启思考模式 | Bool | 忽略 |
| IMGGEN | 是否已开启图片生成模式 | Bool | 控制图片生成标识 |
| CHAT | 用户消息确认，开始本轮聊天 | Str（消息内容） | 锁定输入框 |
| WITHFILELIST | 用户发送的文件详情 | List[Dict{name, url}] | 显示文件列表 |
| WITHFILECONTENTLIST | Agent 发送的文件/图片列表 | List[Dict{name, url}] | 显示在消息气泡 |
| REPLY | Agent 即将开始回复 | Int（Agent ID） | 新建消息气泡 |
| ABILITY | Agent 本次回复使用的能力 | Int（能力 ID） | Web 端显示能力名称 |
| TEXT | Agent 即将发送纯文本 | Null | 桌面端新建文本气泡 |
| 纯文本流 | AI 回复内容 | - | 追加到消息气泡 |
| MCPTOOLUSE | 开始调用 MCP 工具 | Dict{id, name, skill_or_workflow_name, files_to_upload, args} | 显示工具调用 |
| WITHMCPTOOLFILES | 用户补充文件确认 | Dict{id, files_to_upload, args} | 更新工具调用信息 |
| WITHWFSTATUS | 工作流执行状态 | Dict{id, status} | 更新工具状态 |
| WITHMCPTOOLRESULT | MCP 工具执行结果 | Dict{id, result} | 更新工具状态 |
| ENDREPLY | Agent 本次回复结束 | Int（Agent ID） | 忽略 |
| ENDCHAT | 本轮聊天结束 | Null | 解锁输入框 |
| TITLE | Agent 会话标题（仅桌面端） | Str | 更新会话标题 |
| STOPPABLE | 本轮聊天是否可停止 | Bool（默认 True） | 控制停止按钮 |
| ERROR | 聊天出错 | Str（错误信息） | 显示错误弹窗 |

## 单次聊天完整指令顺序

```
CHAT          → 用户消息确认
WITHFILELIST  → 用户文件列表
REPLY         → Agent 开始回复（Agent ID）
ABILITY       → Agent 能力（能力 ID）
TEXT          → Agent 开始发送文本
[纯文本流]    → AI 回复内容
MCPTOOLUSE    → MCP 工具调用（可选，可重复）
WITHMCPTOOLRESULT → 工具结果（可选）
ENDREPLY      → Agent 回复结束
ENDCHAT       → 本轮聊天结束
```

## MCPTOOLUSE 工具名称格式

- 技能：`nexusai__skill-<技能ID>`（如 `nexusai__skill-380`）
- 工作流：`nexusai__workflow-<工作流ID>`（如 `nexusai__workflow-405`）
- 其他 MCP 工具：标准名称

## WITHMCPTOOLRESULT 结果格式

技能/工作流成功：
```json
{"status": "success", "outputs": {...}, "file_list": [...]}
```

技能/工作流失败：
```json
{"status": "failed", "message": "错误信息"}
```
