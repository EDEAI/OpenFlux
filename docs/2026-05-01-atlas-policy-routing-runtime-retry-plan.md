# Atlas 策略路由与 Runtime 自愈更新方案

Date: 2026-05-01

## Summary
在现有 Atlas V2 错误处理和 runtime 热刷新基础上，补齐最新文档新增的策略路由规则，同时保留原本用于处理“Atlas 端人工修改 OpenFlux 默认模型导致客户端 runtime 过期”的自愈能力。

核心原则：
- `user_info.data.atlas_openflux_runtime` 仍是客户端选择协议和 SDK 的唯一真实来源。
- `no_available_model` 仍会触发一次 runtime 刷新，用于修复本地缓存 stale。
- `no_available_model: protocol_mismatch_after_policy` 是新增的策略路由强信号，也走同一套刷新 `user_info` + runtime 更新 + 自动重试一次流程。
- `policy_retry_required` 不刷新 `user_info`，按响应体中的 `policy_retry` 临时切目标协议和目标模型重试一次。

## Key Changes
- 保留现有 `no_available_model` 热刷新逻辑：
  - 当 `atlasCode === 'no_available_model'` 时，立即调用 `user_info` 刷新 runtime。
  - 如果刷新后 runtime 签名发生变化，则按最新 runtime 重建 LLM，并在同一轮聊天里自动重试一次。
  - 如果刷新后 runtime 未变化，则不重试，返回原始 `no_available_model` 归一化错误。
  - 如果刷新后 runtime 为空，则进入 `atlas_managed` 不可用态，返回明确错误，不弹登录。

- 对 `protocol_mismatch_after_policy` 增加明确识别：
  - 当 `atlasCode === 'no_available_model'` 且 `atlasDetail` 包含 `protocol_mismatch_after_policy` 时，日志中标记为策略路由协议变更。
  - 处理动作仍是刷新 `user_info`，按最新 `atlas_openflux_runtime.chat.protocol` 重建 LLM，并只在 runtime 变化时自动重试一次。
  - 不额外猜测目标协议，不直接从 `detail` 拼接 SDK；最终协议仍以刷新后的 `user_info` 为准。

- 支持 `409 policy_retry_required`：
  - Atlas transport 保留响应体中的 `policy_retry` 对象，并挂到 `LLMError.policyRetry`。
  - 识别 `409 + policy_retry_required` 时，不触发登录、不刷新 `user_info`、不写回持久化 runtime。
  - 按 `policy_retry.target_protocol` 选择 SDK 和 Atlas 网关路径，按 `policy_retry.target_model_id` 锚定目标模型，临时重试一次。
  - 重试时带上文档要求的 headers：
    - `X-Atlas-Requested-Model-Id`
    - `X-Atlas-Policy-Retry-Source-Request-Id`
    - `X-Atlas-Policy-Retry-Stage`

- `policy_retry_required` 是本轮请求临时重试：
  - 不更新 `.nexusai-token.json` 中的 `atlasRuntime`。
  - 不调用 `agentManager.updateLLM()` 改全局 LLM。
  - 优先给 Agent 执行入口增加本轮 `llmOverride`，让临时重试只影响当前请求。
  - 自动重试次数不得超过 `policy_retry.max_retry`，默认最多 1 次。

- 保持原有错误边界：
  - 只有 `invalid_token` 触发 `nexusai.auth-expired`。
  - `upstream_http_error` 继续走 OpenFlux 原有供应商错误分类，不触发 NexusAI 登录。
  - `quota_blocked`、`content_blocked`、`no_org_context` 不触发 runtime 刷新或策略重试。

## Interface Changes
- 内部 `LLMError` 增加策略重试元数据：

```ts
policyRetry?: {
  retryable: boolean
  reason: string
  stage: string
  current_protocol?: string
  target_protocol: 'openai' | 'anthropic' | 'google'
  target_model_id: number | string
  target_model_name?: string
  target_model_config_id?: number | string
  current_model_config_id?: number | string
  source_request_id?: string
  max_retry?: number
}
```

- `createAtlasGatewayFetch()` 需要解析并保留 Atlas 原始错误体中的 `policy_retry`，日志记录 `atlasCode`、`detail`、`policyRetry.stage`、`target_protocol`、`target_model_id`、`source_request_id`。

- Agent 执行链路增加内部-only 的本轮 LLM override 能力，用于 `policy_retry_required` 临时重试；不新增前端 WebSocket 协议。

## Test Plan
- 人工修改默认模型导致 runtime stale：
  - 本地缓存 runtime 为 `openai`，Atlas 端默认模型已改为 `anthropic`。
  - 首次请求返回普通 `503 no_available_model`。
  - 客户端刷新 `user_info`，发现 runtime 变化，切到 `anthropic` 并自动重试一次。

- 策略路由导致协议变化：
  - 首次请求返回 `503 no_available_model: protocol_mismatch_after_policy`。
  - 客户端刷新 `user_info`，按最新策略后 runtime 切 SDK 和网关路径，并自动重试一次。

- 普通不可恢复 `no_available_model`：
  - 刷新 `user_info` 后 runtime 未变化。
  - 不重试，直接提示组织默认模型不可用或未配置。

- `policy_retry_required`：
  - 返回 `409` 且带 `policy_retry`。
  - 客户端不调用 `user_info`。
  - 按 `target_protocol` 和 `target_model_id` 临时构建请求，带指定 headers 自动重试一次。
  - 不写回持久化 runtime，不改变后续默认协议。

- 非目标错误回归：
  - `invalid_token` 仍触发重新登录。
  - `upstream_http_error` 中的上游 `401` 不触发 NexusAI 登录。
  - `quota_blocked`、`content_blocked`、`no_org_context` 不触发 runtime 刷新或策略重试。

## Assumptions
- `no_available_model` 可以由本地 runtime stale 或策略路由协议变化触发，因此保留泛化刷新。
- `protocol_mismatch_after_policy` 是 `no_available_model` 的强语义子类，但不是唯一需要刷新 `user_info` 的场景。
- `policy_retry_required` 是单次请求上下文下的策略重试，不代表组织默认 runtime 永久变化。
