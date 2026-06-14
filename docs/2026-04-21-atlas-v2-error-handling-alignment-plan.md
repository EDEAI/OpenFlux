# Atlas V2 错误处理对齐方案

Date: 2026-04-21

## Summary
将 OpenFlux 的 `atlas_managed` 错误处理从“依赖 SDK message + 模糊匹配 + 宽泛状态码兜底”改为“按 HTTP 状态码 + `detail` 前缀”的结构化处理，并只在 `invalid_token` 场景触发重新登录。

当前最主要的偏差有 4 个：
- Atlas 返回的是扁平错误体 `{ code, detail }`，而当前 OpenAI SDK 错误链默认只识别 `error` 包裹结构，导致 OpenFlux 实际只拿到 `403 status code (no body)` 这类无信息错误。
- 当前 `classifyOpenAIError()` 仍在用 `includes()` 和 `401/403 => AUTH_ERROR` 的宽兜底，不符合文档要求的“按状态码 + `detail` 前缀”处理。
- 当前 `401` 会被统一视为重新登录场景，但文档明确只有 `invalid_token` 才应该清理登录态并触发重新登录；`upstream_http_error` 下游供应商返回的 `401` 不能误触发登录。
- 当前 `atlas_openflux_runtime` 为空时仍可能走 fallback openai 链路，这与文档“`user_info` 为空时不应进入 `atlas_managed` 标准链路”冲突。

## Key Changes
### 1. Atlas 错误采集与归一化
- 在 `atlas_managed` 的 HTTP 传输层统一做错误归一化，不再依赖 SDK 最终抛出的 `status code (no body)`。
- 对 OpenAI 协议，使用 SDK 支持的自定义 `fetch` 拦截非 `2xx` 响应；对其他协议使用等价的请求包装层，确保所有 Atlas 协议都能拿到原始 `{ code, detail }`。
- 归一化结果必须保留：
  - HTTP 状态码
  - 完整 `detail`
  - `detail` 前缀（按第一个 `:` 切分出的错误码）
  - `detail` 后半段可读说明
  - 请求协议类型
  - 请求 URL
  - 是否 `stream=true`
- 运行日志至少记录上面这些字段；移除现在这种仅靠临时 `console.error` 打原始对象的调试式日志。

### 2. LLMError 结构与分类规则
- 扩展内部 `LLMError`，增加 Atlas 专用字段：
  - `atlasCode?: string`
  - `atlasDetail?: string`
  - `recoveryAction?: 'reauth' | 'fix_request' | 'contact_admin' | 'retry_later' | 'none'`
  - `allowModelFallback?: boolean`
- Atlas 网关自有错误统一按 `(HTTP 状态码 + atlasCode)` 分类：
  - `401 + invalid_token` -> `AUTH_ERROR`，`recoveryAction='reauth'`，`allowModelFallback=false`
  - `400 + invalid_request_body` -> 非重试客户端错误，`recoveryAction='fix_request'`
  - `404 + invalid_request_path` -> 非重试客户端接线错误，`recoveryAction='fix_request'`
  - `403 + no_org_context` -> 非重试配置/权限错误，`recoveryAction='contact_admin'`
  - `503 + no_available_model` -> 非重试组织配置错误，`recoveryAction='contact_admin'`
  - `403 + quota_blocked` -> `RATE_LIMITED`，`recoveryAction='retry_later'`，但不触发登录
  - `403 + content_blocked` -> `CONTENT_FILTERED`，`recoveryAction='none'`
  - `502 + rewrite_request_failed/build_request_failed/read_response_failed` -> 网关内部错误，非登录问题，`allowModelFallback=false`
  - `502 + upstream_request_failed` -> 可视为链路故障，可有限重试，但 `allowModelFallback=false`
- `upstream_http_error` 不按文档里举例的 `400/401/429/500` 做 Atlas 专属分支处理；它只作为“这是上游供应商错误”的标记。
  - 需要从 `detail` 中提取真实上游状态码和说明
  - 然后回到 OpenFlux 现有的供应商错误处理逻辑：
    - `401/403` -> `AUTH_ERROR`
    - `429` -> `RATE_LIMITED`
    - `400` 命中内容审核/上下文超限时继续细分
    - `5xx` -> `SERVICE_UNAVAILABLE`
  - 但这类上游错误即使被分成 `AUTH_ERROR`，也不能触发 NexusAI 重新登录
- Atlas 错误的分类不得再依赖 `includes()` 模糊匹配作为主路径；字符串匹配只能作为缺失结构字段时的保底兜底。

### 3. `atlas_managed` 运行时行为修正
- 只在 `recoveryAction === 'reauth'` 时发送 `nexusai.auth-expired`。
- `invalid_token` 时必须：
  - 清理 `OpenFluxChatBridge` 中的 token、username、atlasRuntime 和持久化文件
  - 使当前 `atlas_managed` 进入“未认证托管态”
  - 阻止继续拿同一失效 token 请求网关，直到用户重新登录成功
- 其他错误一律不弹登录，不自动切换协议，不自动切换默认模型，不自动降级到 local/managed。
- `agent loop` 中不要再把所有 `AUTH_ERROR` 都拼成“请重新登录 NexusAI 账号”；改为基于 `recoveryAction` 生成提示文案。
- 对 Atlas 网关自有错误统一禁止 `fallbackLlm` 自动切换，避免违反文档“不要在失败后自行改用别的默认模型”。
- `upstream_http_error` 恢复为 OpenFlux 原有的供应商错误处理行为；只修正一点：这类错误永远不能触发 `nexusai.auth-expired`。
- `atlas_openflux_runtime` 为空时：
  - 不构建 Atlas fallback openai provider
  - 不进入 `atlas_managed` 标准链路
  - 保持模式选择为 `atlas_managed` 但处于不可用态，后续聊天直接返回明确错误，不触发登录弹层

### 4. 前端与现有协议
- 保持现有协议不变：
  - `nexusai.auth-expired`
  - `chat.error`
- 前端继续只在 `nexusai.auth-expired` 时弹登录框并走 `pendingAuthRetry` 自动重发。
- `chat.error.payload.message` 改为显示网关归一化后的用户可读文案；完整 `detail` 只进日志，不直接把原始 Atlas 错误对象塞进聊天内容。
- `pendingAuthRetry` 只用于 `invalid_token` 重新登录成功后的自动重试；`quota_blocked`、`content_blocked`、`no_available_model`、`no_org_context` 等场景不走重试。

## Important Interface Changes
- 不新增前后端 WebSocket 协议消息类型。
- 内部 `LLMError` 需要新增 Atlas 专用元数据字段：
  - `atlasCode`
  - `atlasDetail`
  - `recoveryAction`
  - `allowModelFallback`
- `OpenFluxChatBridge` 需要支持“清理失效登录态但不等价于用户主动 logout”的内部能力，供 `invalid_token` 自动失效处理使用。

## Test Plan
- `invalid_token`：
  - 返回 `401 + invalid_token`
  - 网关清理本地登录态
  - 只发送一次 `nexusai.auth-expired`
  - 前端弹登录框，登录成功后自动重发
  - 同一失效 token 不再继续请求网关
- `no_org_context`：
  - 返回 `403 + no_org_context`
  - 不弹登录
  - 提示当前账号无 Atlas 组织上下文
  - 不自动降级，不自动切协议
- `no_available_model`：
  - 返回 `503 + no_available_model`
  - 不弹登录
  - 提示当前组织未配置 OpenFlux 默认模型
  - 不自动降级
- `quota_blocked`：
  - 返回 `403 + quota_blocked`
  - 不弹登录
  - 提示配额不足
  - 不立即自动重试
- `content_blocked`：
  - 返回 `403 + content_blocked`
  - 不弹登录
  - 提示内容安全拦截
  - 不自动重试原请求
- `rewrite_request_failed/build_request_failed/read_response_failed`：
  - 返回 `502`
  - 记录完整 `detail`
  - 不弹登录
  - 不切 fallback 模型
- `upstream_request_failed`：
  - 返回 `502`
  - 记录完整 `detail`
  - 可做有限同链路重试，但不切 fallback 模型
- `upstream_http_error`：
  - 分别模拟若干真实上游错误状态
  - 确认它们继续走 OpenFlux 现有供应商错误分类
  - 但无论上游返回什么，都不会触发 `nexusai.auth-expired`
- `atlas_openflux_runtime` 为空：
  - 启动恢复、切换模式、登录成功后都验证不会进入 Atlas fallback openai 链路
  - 聊天时返回明确不可用错误，不弹登录
- `stream=true`：
  - 在未收到任何有效 chunk 前返回网关错误
  - 前端按普通失败处理，不把错误文本当成模型输出流的一部分展示

## Assumptions
- Atlas 网关所有错误都遵循文档中的扁平结构 `{ code, detail }`，并且 `detail` 前缀是稳定契约。
- OpenAI SDK 的默认错误封装不适合直接用于 Atlas 错误判定，因此必须在传输层拦截原始响应。
- 现有前端登录弹层和登录成功后自动重发链路继续复用，不新增新的 UI 模式或协议。
