# OpenFlux Atlas `atlas_managed` 对接文档 V2

## 1. 文档目的
- 本文档只说明一件事：
  - OpenFlux 本地 Agent 在 `atlas_managed` 模式下，如何对接 Atlas。
- 不包含：
  - `local` 模式
  - `router_managed` 模式

## 2. OpenFlux 需要对接的接口
- `POST https://nexus-api.atyun.com/v1/auth/login`
- `GET https://nexus-api.atyun.com/v1/auth/user_info`
- OpenAI-compatible 固定 `baseUrl`
  - `https://atlas-gateway.atyun.com/v1/atlas/model-egress/openai`
- Anthropic-compatible 固定 `baseUrl`
  - `https://atlas-gateway.atyun.com/v1/atlas/model-egress/anthropic`
- Google-compatible 固定 `baseUrl`
  - `https://atlas-gateway.atyun.com/v1/atlas/model-egress/google`

## 3. 对接总流程
1. 用户在 OpenFlux 中登录 NexusAI 账号。
2. OpenFlux 保存登录返回的 `access_token`。
3. OpenFlux 调用 `GET /v1/auth/user_info`。
4. OpenFlux 从 `user_info.data.atlas_openflux_runtime` 中读取：
   - `chat`
   - `embedding`
5. OpenFlux 本地 Agent 运行时：
   - 聊天请求使用 `atlas_openflux_runtime.chat.protocol` 选择协议和网关 `baseUrl`
   - embedding 请求使用 `atlas_openflux_runtime.embedding.protocol` 选择协议和网关 `baseUrl`
6. 使用 OpenAI、Anthropic 或 Google 官方 SDK，请求 Atlas 网关
7. Atlas 网关在运行时完成：
   - 用户/team/org 识别
   - OpenFlux 默认模型解析
   - 模型路由
   - 预算降级
   - 配额检查
   - 输入内容安全检查
   - 真实供应商访问

## 4. 核心规则

### 4.1 登录规则
- OpenFlux 使用普通 NexusAI 登录。

### 4.2 `user_info` 规则
- `user_info` 现在是 **必需步骤**，不是可选步骤。
- 原因：
  - OpenFlux 本地 Agent 需要通过它拿到 Atlas 为当前账号下发的本地 Agent 运行时默认模型和协议。
- `user_info.data.atlas_openflux_runtime` 返回的是 Atlas 策略预判后的有效运行时模型和协议。
- 如果当前账号命中模型路由策略，且路由目标会改变协议，OpenFlux 必须以 `user_info` 返回的协议为准。
- 如果 `user_info.data.atlas_openflux_runtime` 为空：
  - OpenFlux 不应进入 `atlas_managed` 的本地 Agent 标准链路。

### 4.3 协议选择规则
- 协议不是 OpenFlux 自己猜的。
- 协议由 `user_info.data.atlas_openflux_runtime` 返回：
  - 聊天能力看 `atlas_openflux_runtime.chat.protocol`
  - embedding 能力看 `atlas_openflux_runtime.embedding.protocol`
- 协议值只会是：
  - `openai`
  - `anthropic`
  - `google`
- 当前协议映射规则：
  - `chat / llm`
    - `Anthropic / Claude` -> `anthropic`
    - `Google / Gemini` -> `google`
    - 其余 LLM 供应商 -> `openai`
  - `embedding`
    - 当前只支持 `openai`

### 4.4 未指定模型规则
- OpenFlux 本地 Agent 在标准接法下，**不向 Atlas 显式指定模型**。
- `chat` 请求使用 Atlas OpenFlux 模块配置的 `chat` 默认模型
- `embedding` 请求使用 Atlas OpenFlux 模块配置的 `embedding` 默认模型
- 这里使用的不是 Atlas 全局默认模型，而是 **Atlas OpenFlux 模块自己的默认模型配置**。
- 如果默认模型命中 Atlas 模型路由策略，网关会按策略后的有效模型执行。
- 如果策略后的有效模型协议与原默认模型不同，`user_info` 会提前返回策略后的协议，OpenFlux 不需要也不应该自己猜测协议。

## 5. 登录接口

### 5.1 请求
```http
POST https://nexus-api.atyun.com/v1/auth/login
Content-Type: application/x-www-form-urlencoded

username=yideadmin%40nexusai.com&password=nexusaipwd
```

### 5.2 入参
| 字段 | 位置 | 是否必需 | 说明 |
| --- | --- | --- | --- |
| `username` | Form | 是 | 用户邮箱 |
| `password` | Form | 是 | 用户密码 |

### 5.3 成功返回示例
```json
{
  "access_token": "<jwt_access_token>",
  "token_type": "bearer"
}
```

### 5.4 OpenFlux 使用规则
- 保存 `access_token`
- 后续请求统一带：
  - `Authorization: Bearer <access_token>`

## 6. `user_info` 接口

### 6.1 请求
```http
GET https://nexus-api.atyun.com/v1/auth/user_info
Authorization: Bearer <access_token>
```

### 6.2 成功返回示例
```json
{
  "code": 0,
  "detail": "success",
  "data": {
    "uid": 57,
    "team_id": 26,
    "team_name": "亿得科技",
    "nickname": "administrator",
    "email": "yideadmin@nexusai.com",
    "permission_source": "atlas",
    "atlas_openflux_runtime": {
      "chat": {
        "model_id": 69,
        "model_config_id": 377,
        "model_name": "gpt-5",
        "protocol": "openai",
        "supplier_name": "OpenAI",
        "display_name": "OpenAI / gpt-5"
      },
      "embedding": {
        "model_id": 29,
        "model_config_id": 337,
        "model_name": "text-embedding-3-large",
        "protocol": "openai",
        "supplier_name": "OpenAI",
        "display_name": "OpenAI / text-embedding-3-large"
      }
    }
  }
}
```

### 6.3 OpenFlux 必须使用的字段
| 字段 | 用途 |
| --- | --- |
| `data.atlas_openflux_runtime.chat.protocol` | 本地 Agent 聊天请求应走哪个协议 |
| `data.atlas_openflux_runtime.embedding.protocol` | 本地 Agent embedding 请求应走哪个协议 |
| `data.atlas_openflux_runtime.chat.model_id` | 当前账号聊天能力对应的 OpenFlux 默认模型 |
| `data.atlas_openflux_runtime.embedding.model_id` | 当前账号 embedding 能力对应的 OpenFlux 默认模型 |

### 6.4 OpenFlux 使用规则
- 聊天能力：
  - 如果 `chat.protocol = openai`
    - 使用 OpenAI-compatible SDK
    - `baseUrl = https://atlas-gateway.atyun.com/v1/atlas/model-egress/openai`
  - 如果 `chat.protocol = anthropic`
    - 使用 Anthropic-compatible SDK
    - `baseUrl = https://atlas-gateway.atyun.com/v1/atlas/model-egress/anthropic`
  - 如果 `chat.protocol = google`
    - 使用 Google 官方 SDK
    - `baseUrl = https://atlas-gateway.atyun.com/v1/atlas/model-egress/google`
- embedding 能力：
  - 按 `embedding.protocol` 选择 SDK 与 `baseUrl`

## 7. 固定网关地址

### 7.1 OpenAI-compatible
- `https://atlas-gateway.atyun.com/v1/atlas/model-egress/openai`

### 7.2 Anthropic-compatible
- `https://atlas-gateway.atyun.com/v1/atlas/model-egress/anthropic`

### 7.3 Google-compatible
- `https://atlas-gateway.atyun.com/v1/atlas/model-egress/google`

### 7.4 说明
- 这是给 SDK 传的 `baseUrl`
- 不是让 OpenFlux 手动拼完整请求 URL
- OpenAI SDK 会自动请求：
  - `/chat/completions`
  - `/embeddings`
- Anthropic SDK 会自动请求：
  - `/messages`
- Google SDK 会自动请求：
  - `/v1beta/models/{model}:generateContent`
  - `/v1beta/models/{model}:streamGenerateContent?alt=sse`

## 8. 网关请求规则

### 8.1 固定 Header
| Header | 是否必需 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | `Bearer <access_token>` |

### 8.2 OpenAI-compatible Chat 示例
```http
POST https://atlas-gateway.atyun.com/v1/atlas/model-egress/openai/chat/completions
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "model": "gpt-4o",
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant."
    },
    {
      "role": "user",
      "content": "Hello"
    }
  ],
  "stream": false
}
```

### 8.3 OpenAI-compatible Embeddings 示例
```http
POST https://atlas-gateway.atyun.com/v1/atlas/model-egress/openai/embeddings
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "model": "text-embedding-3-large",
  "input": "NexusAI Atlas OpenFlux"
}
```

### 8.4 Anthropic-compatible Messages 示例
```http
POST https://atlas-gateway.atyun.com/v1/atlas/model-egress/anthropic/messages
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "model": "Claude Sonnet 4.5",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ],
  "stream": false
}
```

### 8.5 Google-compatible Chat 示例
```http
POST https://atlas-gateway.atyun.com/v1/atlas/model-egress/google/v1beta/models/gemini-2.5-flash:generateContent
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "Hello"
        }
      ]
    }
  ],
  "generationConfig": {
    "maxOutputTokens": 1024
  }
}
```

### 8.6 请求体中的 `model` 字段说明
- OpenAI 和 Anthropic 官方 SDK 通常要求请求体里保留 `model` 字段。
- 在 OpenFlux `atlas_managed` 的标准接法里：
  - OpenFlux 不通过请求头向 Atlas 显式指定模型
  - 实际执行模型由 Atlas 服务端的 OpenFlux 默认模型配置决定
- 因此，请求体中的 `model` 字段或 Google SDK 的 `model` 参数按 SDK 要求正常保留即可；OpenFlux 不需要把它当作 Atlas 选模控制项。

## 9. OpenFlux 需要实现的最小逻辑
1. 普通登录 NexusAI，获取 `access_token`
2. 调用 `GET /v1/auth/user_info`
3. 读取 `atlas_openflux_runtime.chat` 和 `atlas_openflux_runtime.embedding`
4. 按对应能力的 `protocol` 选择 OpenAI、Anthropic 或 Google 网关
5. 所有网关请求统一带 `Authorization: Bearer <access_token>`

## 10. 错误处理

### 10.1 返回格式
网关错误统一返回 HTTP 非 `2xx` 状态码，响应体格式如下：

```json
{
  "code": 400,
  "detail": "具体错误码: 具体错误内容"
}
```

- `code`
  - 等于实际 HTTP 状态码
- `detail`
  - 以 `错误码: 错误说明` 的形式返回

### 10.2 常见错误与 HTTP 状态码
| HTTP 状态码 | `detail` 前缀 | 含义 |
| --- | --- | --- |
| `400` | `invalid_request_body` | 请求体格式错误、JSON 非法、请求体不是合法对象 |
| `401` | `invalid_token` | `Authorization` 缺失、格式错误、token 无效或已过期 |
| `403` | `no_org_context` | 当前账号没有 Atlas 组织上下文 |
| `403` | `quota_blocked` | 配额校验未通过 |
| `403` | `content_blocked` | 输入内容被内容安全策略拦截 |
| `404` | `invalid_request_path` | Google 网关路径不支持 |
| `502` | `rewrite_request_failed` | 网关在内容脱敏后重写请求体失败 |
| `502` | `build_request_failed` | 网关构造上游请求失败 |
| `502` | `upstream_request_failed` | 网关无法连接真实供应商 |
| `502` | `read_response_failed` | 网关读取上游错误响应失败 |
| `503` | `no_available_model` | 当前组织未配置或无法解析 OpenFlux 默认模型 |
| `503` | `no_available_model: protocol_mismatch_after_policy` | Atlas 策略要求切到另一种协议的模型，客户端需要重新获取 `user_info` 后按新协议重试 |
| `409` | `policy_retry_required` | 运行时降级策略要求切到另一种协议的模型，客户端按响应体中的目标协议和目标模型重试一次 |
| `上游透传` | `upstream_http_error` | 真实供应商返回了 HTTP 错误，网关直接透传上游状态码 |

### 10.3 常见错误示例
#### `invalid_request_body`
HTTP 状态码：`400`
```json
{
  "code": 400,
  "detail": "invalid_request_body: request body must be a valid JSON object"
}
```

#### `invalid_token`
HTTP 状态码：`401`
```json
{
  "code": 401,
  "detail": "invalid_token: access token is missing, invalid, or expired"
}
```

#### `no_org_context`
HTTP 状态码：`403`
```json
{
  "code": 403,
  "detail": "no_org_context: current account is not bound to an Atlas organization"
}
```

#### `no_available_model`
HTTP 状态码：`503`
```json
{
  "code": 503,
  "detail": "no_available_model: OpenFlux default chat model is not configured for the current organization"
}
```

#### `no_available_model: protocol_mismatch_after_policy`
HTTP 状态码：`503`
```json
{
  "code": 503,
  "detail": "no_available_model: protocol_mismatch_after_policy stage=model_route current_protocol=anthropic target_protocol=openai current_model_config_id=1266 target_model_config_id=1518"
}
```

#### `policy_retry_required`
HTTP 状态码：`409`
```json
{
  "code": 409,
  "detail": "policy_retry_required: stage=downgrade_on_error current_protocol=openai target_protocol=anthropic current_model_config_id=1518 target_model_config_id=1266",
  "policy_retry": {
    "retryable": true,
    "reason": "policy_retry_required",
    "stage": "downgrade_on_error",
    "current_protocol": "openai",
    "target_protocol": "anthropic",
    "target_model_id": 110,
    "target_model_name": "Claude Sonnet 4.6",
    "target_model_config_id": 1266,
    "current_model_config_id": 1518,
    "source_request_id": "62dc9df2447911f1b86600155d61bb9e",
    "max_retry": 1
  }
}
```

#### `quota_blocked`
HTTP 状态码：`403`
```json
{
  "code": 403,
  "detail": "quota_blocked: user daily token quota exceeded"
}
```

#### `content_blocked`
HTTP 状态码：`403`
```json
{
  "code": 403,
  "detail": "content_blocked: request blocked by Atlas content safety policy"
}
```

#### `invalid_request_path`
HTTP 状态码：`404`
```json
{
  "code": 404,
  "detail": "invalid_request_path: unsupported google gateway path"
}
```

#### `rewrite_request_failed`
HTTP 状态码：`502`
```json
{
  "code": 502,
  "detail": "rewrite_request_failed: failed to rewrite request body after content masking"
}
```

#### `upstream_request_failed`
HTTP 状态码：`502`
```json
{
  "code": 502,
  "detail": "upstream_request_failed: failed to reach upstream model provider"
}
```

#### `upstream_http_error`
HTTP 状态码：透传真实供应商返回值，例如 `400`、`401`、`429`、`500`
```json
{
  "code": 429,
  "detail": "upstream_http_error: upstream provider returned 429 rate limit exceeded"
}
```

### 10.4 OpenFlux 处理原则
- OpenFlux 侧统一按 `HTTP 状态码 + detail 前缀` 处理错误，不要只看 `code`，也不要只做字符串模糊匹配。
- `detail` 建议按第一个 `:` 切分：
  - 前半段作为错误码
  - 后半段作为可读错误说明
- OpenFlux 收到非 `2xx` 响应时，建议至少记录：
  - 请求协议类型
  - 请求 URL
  - HTTP 状态码
  - 完整 `detail`
  - 是否为 `stream=true`
- `stream=true` 场景下：
  - 只要还没有收到有效 chunk，就按普通请求失败处理
  - 不要把网关错误当作模型正常输出的一部分展示到聊天内容里
- OpenFlux 不要对错误自动切换协议，也不要在失败后自行改用别的默认模型。
- `invalid_token`
  - 处理动作：清理本地登录态，提示用户重新登录
  - 不建议自动重试
  - 同一 token 连续出现该错误时，不要继续请求网关
- `invalid_request_body`
  - 处理动作：视为客户端请求构造错误
  - 优先检查 SDK 请求体、工具 schema、流式参数、Google 路径参数
  - 不建议直接重试同一请求
- `invalid_request_path`
  - 处理动作：检查 Google SDK 使用的 `baseUrl`、路径拼接和方法名
  - 这是客户端接线错误，不是模型服务故障
- `no_org_context`
  - 处理动作：提示当前账号没有 Atlas 组织上下文，无法使用 `atlas_managed`
  - 不建议自动重试
  - 可引导用户确认 Atlas 组织归属或联系管理员
- `no_available_model`
  - 处理动作：提示当前组织没有配置 OpenFlux 本地 Agent 对应能力默认模型
  - 不建议客户端自行降级或切换协议
  - 需要管理员在 Atlas OpenFlux 模块中补齐默认模型配置
- `no_available_model: protocol_mismatch_after_policy`
  - 处理动作：立即重新调用 `GET /v1/auth/user_info`
  - 用新的 `atlas_openflux_runtime.<capability>.protocol` 重新选择 SDK 和网关地址
  - 建议只自动重试一次，避免策略配置异常时形成循环
  - 如果重新获取 `user_info` 后仍然失败，应提示用户稍后重试或联系管理员
- `policy_retry_required`
  - 处理动作：按 `policy_retry.target_protocol` 选择 SDK 和网关地址，按 `policy_retry.target_model_id` 锚定目标模型后重试一次
  - 推荐重试 Header：`X-Atlas-Requested-Model-Id: <policy_retry.target_model_id>`
  - 同时带上：`X-Atlas-Policy-Retry-Source-Request-Id: <policy_retry.source_request_id>`
  - 同时带上：`X-Atlas-Policy-Retry-Stage: <policy_retry.stage>`
  - 这类错误不需要重新调用 `user_info`，因为它来自预算、不可用或运行错误等真实请求上下文
  - 自动重试次数不得超过 `policy_retry.max_retry`
- `quota_blocked`
  - 处理动作：提示配额不足
  - 不建议立即自动重试
  - 可提示用户稍后再试或联系管理员调整配额
- `content_blocked`
  - 处理动作：提示请求被内容安全策略拦截
  - 不建议自动重试同一原始输入
  - 若产品需要，可引导用户修改输入后重试
- `rewrite_request_failed`
  - 处理动作：视为网关内部错误
  - 可提示“请求改写失败，请稍后重试”
  - 建议记录完整 `detail` 并上报日志
- `build_request_failed`
  - 处理动作：视为网关内部错误
  - 可提示“模型请求构造失败，请稍后重试”
  - 建议记录完整 `detail` 并上报日志
- `upstream_request_failed`
  - 处理动作：视为网关到供应商的连接失败、超时或上下游链路中断
  - 可做有限次数重试，建议只对幂等请求或用户明确重试时触发
  - 若频繁出现，应优先检查网络、代理、超时配置和供应商连通性
- `read_response_failed`
  - 处理动作：视为网关读取上游响应失败
  - 可提示“模型响应读取失败，请稍后重试”
  - 建议记录完整 `detail` 并上报日志
- `upstream_http_error`
  - 处理动作：以真实供应商错误为准处理，不要假设它一定是 `502`
  - 典型情况：
    - `400`：请求参数或工具 schema 不合法，优先排查客户端请求
    - `401`：供应商侧认证问题，由 Atlas 服务端排查供应商配置
    - `429`：供应商限流，可提示稍后重试
    - `500`：供应商内部错误，可提示稍后重试
  - 建议把 `detail` 原样记录，方便区分是 Atlas 网关错误还是供应商返回错误
