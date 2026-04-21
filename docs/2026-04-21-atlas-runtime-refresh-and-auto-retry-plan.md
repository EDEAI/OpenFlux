# Atlas Runtime 热刷新与自动重试优化方案

Date: 2026-04-21

## Summary
修复 `atlas_managed` 在服务端切换默认模型协议后仍继续使用旧 `atlas_openflux_runtime` 的问题。方案采用启动时刷新 + 指定错误触发刷新，并在确认 runtime 已变化时同轮自动重试一次。

目标行为：
- 已登录的 `atlas_managed` 在启动恢复时优先使用最新 `user_info`，不盲信本地缓存。
- 运行中如果因 stale runtime 导致 `no_available_model`，自动刷新 `user_info`、按最新协议重建 LLM，并在同一轮聊天里透明重试一次。
- 只有 `invalid_token` 继续走重新登录；其他错误不弹登录、不降级到 local/managed。

## Key Changes
### 1. 增加统一的 Atlas runtime 刷新入口
- 在 `standalone` 层收敛一个内部 helper，负责：
  - 调用 `OpenFluxChatBridge.fetchUserInfo()`
  - 读取最新 `atlas_openflux_runtime`
  - 计算 runtime 签名并判断是否变化
  - 在有 `chat` 能力时重建 `atlas_managed` LLM
  - 同步更新 `agentManager`、`agentRunner`、CardManager、持久化 runtime
- runtime 变化判断以 chat + embedding 的能力签名为准，至少包含：
  - `protocol`
  - `model_id`
  - `model_config_id`
  - `model_name`
- 刷新入口返回结构化结果，至少区分：
  - `updated`：拿到新 runtime 且签名发生变化
  - `unchanged`：刷新成功但签名未变
  - `unavailable`：`atlas_openflux_runtime` 为空
  - `auth_expired`：`user_info` 返回 `invalid_token`
  - `failed`：网络或其他非认证失败

### 2. 启动恢复改为“先刷新，失败再决定是否回退缓存”
- 当前 `atlas_managed + 已恢复 token` 的启动路径改为：
  1. 先调用 `user_info`
  2. 若成功且有 `chat` runtime，用最新 runtime 构建 LLM
  3. 若成功但 runtime 为空，保持 `atlas_managed` 不可用态，不构建 fallback openai provider
  4. 若返回 `invalid_token`，清理登录态，进入未认证托管态
  5. 若是暂时性失败（网络/5xx），且本地持久化里有 runtime，则允许继续使用缓存 runtime 启动，同时记录“startup refresh failed, using cached runtime”
- 这样既能优先修正协议漂移，又不把启动可用性完全绑死在 `user_info` 成功上。

### 3. 对 `no_available_model` 做一次性 runtime 自愈
- 在 `atlas_managed` 的聊天执行链路里，遇到：
  - `LLMError.atlasCode === 'no_available_model'`
- 执行以下逻辑：
  1. 立即刷新一次 `user_info`
  2. 如果刷新结果为 `updated` 且新 runtime 有 `chat` 能力：
     - 按新 runtime 重建 LLM
     - 在同一轮聊天里自动重试一次原请求
  3. 如果刷新结果为 `unchanged`：
     - 不重试
     - 直接返回当前归一化的 `no_available_model` 错误
  4. 如果刷新结果为 `unavailable`：
     - 将 `atlas_managed` 置为不可用态
     - 返回明确错误，不重试
  5. 如果刷新结果为 `auth_expired`：
     - 清理登录态
     - 发送现有 `nexusai.auth-expired`
  6. 如果刷新结果为 `failed`：
     - 不重试
     - 保留原始 `no_available_model` 错误作为最终错误
- 自动重试只允许一次，避免进入刷新-失败循环。

### 4. 刷新触发范围保持最小
- 仅对这类“可能由 runtime 过期导致”的场景触发热刷新：
  - `no_available_model`
- 下面这些情况不触发 runtime 刷新：
  - `invalid_token`
  - `quota_blocked`
  - `content_blocked`
  - `no_org_context`
  - `upstream_request_failed`
  - `upstream_http_error`
  - 其他网关内部错误
- `upstream_http_error` 继续走原有供应商错误处理，不新增刷新或重登逻辑。

### 5. 现有接口与交互保持不变
- 不新增前端协议消息。
- 继续复用：
  - `nexusai.auth-expired`
  - `chat.error`
- `openflux.login` 和 `config.set-llm-source=atlas_managed` 仍然保留“登录/切换时主动 `fetchUserInfo`”行为。
- 不新增前端设置项，不改 Router 逻辑。

## Public APIs / Interfaces
- 无前端协议变化。
- 内部需要调整 `OpenFluxChatBridge.fetchUserInfo()` 的返回能力，从“无返回值”改为“结构化刷新结果”，以便 `standalone` 判断：
  - 是否认证失效
  - 是否拿到 runtime
  - runtime 是否发生变化
- 不改 `.nexusai-token.json` 文件格式；仍复用现有 token + runtime 持久化。

## Test Plan
- 启动恢复：
  - 本地缓存 runtime 为 `openai`，`user_info` 最新为 `anthropic`，启动后应直接切到 `anthropic`
  - `user_info` 临时失败但本地有缓存 runtime，应继续用缓存启动
  - `user_info` 返回 `invalid_token`，应清理登录态，不构建 LLM
- 运行时热刷新：
  - 首次请求命中 `503 no_available_model`，刷新后 runtime 从 `openai` 变为 `anthropic`，应重建并自动重试一次，最终成功
  - 首次请求命中 `503 no_available_model`，刷新后 runtime 未变化，应不重试，直接返回该错误
  - 首次请求命中 `503 no_available_model`，刷新后 runtime 为空，应进入不可用态并返回明确错误
- 非目标错误不误触发：
  - `quota_blocked` / `content_blocked` / `no_org_context` 不刷新 runtime、不重登
  - `upstream_http_error` 不刷新 runtime、不触发 `nexusai.auth-expired`
  - `invalid_token` 仍只走重新登录链路
- 回归：
  - `openflux.login` 后仍能按最新 runtime 构建协议
  - `config.set-llm-source=atlas_managed` 仍先拉 `user_info`
  - `atlas_managed` runtime 为空时仍不构建 fallback openai provider

## Assumptions
- `user_info.data.atlas_openflux_runtime` 是 Atlas 侧关于聊天/embedding 协议与默认模型的唯一真实来源。
- 协议漂移导致的这类错误，当前以 `no_available_model` 作为唯一自愈触发点。
- 自动重试仅在“刷新后 runtime 确实变化”时执行一次；否则不重试。
- 启动时如果 `user_info` 临时失败但本地有缓存 runtime，优先保证可用性，允许继续用缓存启动。
