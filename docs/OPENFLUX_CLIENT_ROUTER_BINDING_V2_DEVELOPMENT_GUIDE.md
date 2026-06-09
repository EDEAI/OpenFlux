# OpenFlux 客户端改造文档：Router 账号级绑定 V2.1

## 目标
OpenFlux 客户端继续使用 Router 生成二维码和现有绑定 UI；Atlas 管理链路下，扫码成功代表当前 NexusAI 账号激活这台 OpenFlux 客户端。

## 必改内容
- OpenFlux 客户端不直接调用 Router HTTP API 生成二维码；继续沿用现有 Router WebSocket 通道。
- 当前实现中，前端触发 `router.qr-bind` 后，本地 gateway 通过 `RouterBridge.requestQRBind()` 向 Router WebSocket 发送：
  - `{"action":"generate_qr_bind","nexusai_token":"Bearer <nexusai_access_token>"}`
- 客户端发送 `generate_qr_bind` 前必须确认当前已登录 NexusAI；未登录时不要发送该 WebSocket 命令，应先引导用户完成 NexusAI 登录。
- Router `/ws/app` 建连仍按原 Router 规则处理，不要求所有连接都携带 NexusAI token。
- NexusAI 账号级绑定只要求生成二维码命令携带 `nexusai_token`；不带 `nexusai_token` 的二维码属于旧 Router 设备级绑定流程，不进入 Atlas 账号级绑定管理。
- 二维码内容继续使用 Router 当前返回，不改为 Atlas 二维码。
- `app_user_id` 继续代表当前 OpenFlux 客户端实例。

## 绑定语义
- 同一 NexusAI 账号只有一个活跃 OpenFlux 客户端。
- 当前客户端扫码绑定成功后，会成为该账号的活跃客户端。
- 如果同账号在另一台 OpenFlux 客户端重新扫码绑定，当前客户端会被替换。
- 被替换后，客户端应在 Router 推送或下次状态检查时展示未激活/已被替换状态。

## 兼容规则
- OpenFlux 客户端侧不再提供“未登录 NexusAI 也生成 Router 二维码”的入口。
- 未登录 NexusAI 或无法取得有效 `access_token` 时，客户端应阻止发送 `generate_qr_bind` WebSocket 命令，并提示用户先登录 NexusAI。
- 携带 NexusAI token 时，Router 会校验桌面端身份，并要求手机端扫码时也携带同账号 NexusAI token。
- 普通 Router 模式仍可不带 NexusAI token 连接 `/ws/app`，避免影响非 NexusAI 账号绑定场景。

## 验收点
- 已登录 NexusAI 的 OpenFlux 客户端生成二维码成功。
- NexusAI 账号级二维码请求体包含 `nexusai_token`。
- 未登录 NexusAI 的 OpenFlux 客户端不能生成 Router 二维码，并提示先登录 NexusAI。
- 普通 Router `/ws/app` 连接不因缺少 NexusAI token 被拒绝。
- 手机 App 使用同账号 NexusAI 扫码绑定成功。
- 手机 App 使用不同 NexusAI 账号扫码绑定失败。
- 同账号另一台 OpenFlux 客户端重新绑定后，新客户端生效，旧客户端失效。
- 绑定成功后，Atlas OpenFlux 模块“客户端绑定”Tab 可看到账号级绑定记录。
- 绑定后原有 Router 聊天消息格式不受影响。
