## Purpose

定义 Weave 如何从本地配置选择模型，并通过统一的纯文本流式契约兼容 Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses 三种协议，同时隔离协议细节、错误和敏感信息。

## ADDED Requirements

### Requirement: 本地 YAML 配置模型 profile
系统 SHALL 默认读取 `~/.weave/config.yaml`，并 SHALL 支持通过 `--config <path>` 覆盖配置路径。配置 SHALL 包含 `default_profile` 和 `profiles` 列表，每个 profile SHALL 使用唯一 `name`，并包含 `protocol`、`model`、`base_url`、`api_key`、`thinking`，可选包含 `max_tokens`。

#### Scenario: 使用默认 profile 启动
- **WHEN** 用户未传入 `--profile`，且默认配置文件有效
- **THEN** 系统选择 `default_profile` 引用的 profile

#### Scenario: 命令行覆盖 profile
- **WHEN** 用户传入 `--profile <name>`，且该名称存在
- **THEN** 系统使用指定 profile 替代 `default_profile`

#### Scenario: profile 结构无效
- **WHEN** profile 名称重复、`default_profile` 不存在、字段缺失或字段类型无效
- **THEN** 系统在启动 TUI 前输出中文字段级诊断并以非零状态退出

#### Scenario: 使用默认输出上限
- **WHEN** profile 未配置 `max_tokens`
- **THEN** 系统使用 `4096` 作为该请求的输出 token 上限

#### Scenario: 校验输出上限
- **WHEN** profile 配置的 `max_tokens` 不是正整数
- **THEN** 系统拒绝配置并指出 `max_tokens` 字段无效

#### Scenario: 禁用 thinking
- **WHEN** profile 配置 `thinking: false`
- **THEN** 系统通过所选协议和兼容端点支持的请求字段显式请求非思考模式，且不得向上层输出 thinking 或 reasoning 内容

#### Scenario: thinking 输出尚未启用
- **WHEN** profile 配置 `thinking: true`
- **THEN** 系统在启动 TUI 前明确提示 thinking 暂未实现，且不得静默忽略该配置

#### Scenario: API Key 配置形式
- **WHEN** `api_key` 包含明文值或 `${ENVIRONMENT_VARIABLE}` 引用
- **THEN** 系统解析出请求所需密钥，但不得在诊断、终端状态或测试输出中回显密钥值

### Requirement: 支持三种流式 LLM 协议
系统 SHALL 支持 `anthropic-messages`、`openai-chat-completions` 和 `openai-responses` 三个 `protocol` 值。每个 profile 的 `base_url` SHALL 表示 API 根地址，具体请求路径 SHALL 由对应协议客户端追加。

#### Scenario: Anthropic Messages 流式回答
- **WHEN** 用户选择 `anthropic-messages` profile 并提交文本
- **THEN** 系统通过 Anthropic Messages 协议逐段产生纯文本回答

#### Scenario: OpenAI Chat Completions 流式回答
- **WHEN** 用户选择 `openai-chat-completions` profile 并提交文本
- **THEN** 系统通过 OpenAI Chat Completions 协议逐段产生纯文本回答

#### Scenario: OpenAI Responses 流式回答
- **WHEN** 用户选择 `openai-responses` profile 并提交文本
- **THEN** 系统通过 OpenAI Responses 协议逐段产生纯文本回答

#### Scenario: 会话期间固定 profile
- **WHEN** TUI 已使用某个 profile 启动
- **THEN** 系统在该进程会话期间始终使用同一 profile，且不提供热切换入口

### Requirement: 归一化协议流生命周期
协议客户端 SHALL 把原生流映射为协议无关的开始、文本增量、完成和错误结果，并 SHALL 隔离所有供应商 SDK 类型。完成结果 SHALL 携带完成原因，并在供应商返回时携带真实的输入和输出 token usage；系统不得估算缺失 usage。

#### Scenario: 产生文本增量
- **WHEN** 原生协议产生有效文本增量
- **THEN** 客户端按原始顺序输出等价的协议无关文本增量

#### Scenario: 返回 usage
- **WHEN** 原生完成事件包含输入和输出 token 数量
- **THEN** 统一完成结果包含对应的 `input_tokens` 与 `output_tokens`

#### Scenario: usage 缺失
- **WHEN** 原生协议或兼容网关未返回 usage
- **THEN** 统一完成结果将对应字段保持为空，且不得生成推测值

#### Scenario: 达到输出上限
- **WHEN** 原生协议因输出 token 上限终止
- **THEN** 统一完成结果将完成原因标记为截断，而不是网络或协议错误

### Requirement: 校验 Anthropic 流事件时序
Anthropic 适配 SHALL 按 `message_start`、`content_block_start`、一个或多个 `content_block_delta`、`content_block_stop`、一个或多个 `message_delta`、`message_stop` 的生命周期处理文本内容块。系统 SHALL 接受任意位置的 `ping`，并 SHALL 对未知但不改变状态的事件保持向前兼容。

#### Scenario: 正常 Anthropic 文本序列
- **WHEN** Anthropic 流按规定顺序产生一个或多个文本内容块并以 `message_stop` 结束
- **THEN** 系统按索引拼接文本并产生正常完成结果

#### Scenario: 收到心跳或未知无状态事件
- **WHEN** 正常事件之间出现 `ping` 或未知且不改变当前内容块状态的事件
- **THEN** 系统忽略该事件并继续处理当前流

#### Scenario: 原生事件乱序或未闭合
- **WHEN** 必需事件乱序、内容块索引不匹配或连接在 `message_stop` 前结束
- **THEN** 系统终止本轮并返回脱敏的协议错误

#### Scenario: 收到非文本内容
- **WHEN** 首版收到 tool、thinking 或其他非文本内容块
- **THEN** 系统终止本轮并返回不包含原始敏感载荷的协议错误

### Requirement: 校验 OpenAI 原生流
OpenAI Chat Completions 适配 SHALL 从增量 chunk 提取文本与完成原因；OpenAI Responses 适配 SHALL 从语义事件提取开始、文本增量、完成和错误。两者 SHALL 向上层提供相同的协议无关结果。

#### Scenario: Chat Completions 正常结束
- **WHEN** Chat Completions 流连续返回文本 delta 并给出终止原因
- **THEN** 系统输出等价文本并映射终止原因

#### Scenario: Responses 正常结束
- **WHEN** Responses 流产生创建、文本增量和完成语义事件
- **THEN** 系统输出等价文本并产生正常完成结果

#### Scenario: OpenAI 流异常结束
- **WHEN** OpenAI 流返回错误事件、缺少完成信号或产生首版不支持的非文本输出
- **THEN** 系统终止本轮并返回脱敏的协议错误

### Requirement: 请求保持客户端无状态
每次请求 SHALL 发送当前会话全部已提交消息，不发送 system prompt 或工具定义。`thinking: false` SHALL 在 Anthropic Messages 请求中映射为 `thinking.type=disabled`；DeepSeek Chat Completions SHALL 使用顶层 `thinking.type=disabled`，DeepSeek Responses SHALL 使用 `reasoning.effort=none`。其他 OpenAI 根地址 SHALL 不接收这些自动禁用字段。OpenAI Responses 请求 MUST NOT 使用 `previous_response_id` 串联服务端会话。统一的 `max_tokens` SHALL 映射为各协议对应的输出限制字段。

#### Scenario: 发送多轮历史
- **WHEN** 会话已有已提交的多轮消息并开始新请求
- **THEN** 协议客户端收到完整的 user/assistant 历史和当前用户输入

#### Scenario: 不创建服务端 Responses 会话链
- **WHEN** 使用 OpenAI Responses profile 发起第二轮或后续请求
- **THEN** 请求包含本地完整历史且不包含 `previous_response_id`

#### Scenario: 首版请求保持纯文本
- **WHEN** 任意协议发起请求
- **THEN** 请求不包含 system prompt、工具定义或 thinking 启用配置，且只允许携带保证纯文本模式所需的 `thinking.type=disabled` 或固定的 `reasoning.effort=none`

#### Scenario: DeepSeek Chat Completions 端点禁用 thinking
- **WHEN** OpenAI Chat Completions profile 的 `base_url` 主机为 `api.deepseek.com` 且 `thinking: false`
- **THEN** 请求包含顶层 `thinking: {type: "disabled"}`，流中不得出现 reasoning 内容

#### Scenario: DeepSeek Responses 端点禁用 reasoning
- **WHEN** OpenAI Responses profile 的 `base_url` 主机为 `api.deepseek.com` 且 `thinking: false`
- **THEN** 请求包含 `reasoning: {effort: "none"}` 且不包含顶层 `thinking`，流中不得出现 reasoning item 或 reasoning delta

#### Scenario: 标准 OpenAI 端点不接收供应商扩展
- **WHEN** OpenAI profile 的 `base_url` 主机不是 `api.deepseek.com`
- **THEN** 请求不包含由 Weave 自动注入的 `thinking` 或 `reasoning` 禁用字段

### Requirement: 流式请求可取消且有静默超时
系统 SHALL 支持取消活动请求，并 SHALL 对首个原生事件和后续事件静默分别应用 120 秒超时。每个文本、状态或心跳事件 SHALL 重置流静默计时器，系统 SHALL 不设置总生成时长上限。

#### Scenario: 首事件超时
- **WHEN** 请求开始后 120 秒内未收到任何原生事件
- **THEN** 系统取消请求并返回可重试的超时错误

#### Scenario: 流中途静默超时
- **WHEN** 流开始后连续 120 秒未收到文本、状态或心跳事件
- **THEN** 系统取消请求并返回可重试的超时错误

#### Scenario: 用户主动取消
- **WHEN** 上层取消活动请求
- **THEN** 协议客户端停止接收和转发后续事件，并返回取消结果而不是普通错误

### Requirement: 提供安全且一致的错误
协议错误 SHALL 归一化为安全错误码、中文提示和 `retryable` 标记。错误输出 MUST NOT 包含 API Key、鉴权头、完整响应头或未经筛选的供应商响应体。

#### Scenario: 供应商拒绝请求
- **WHEN** SDK 返回鉴权、限流、网络或服务端错误
- **THEN** 上层收到脱敏的统一错误以及正确的可重试标记

#### Scenario: 配置包含明文密钥
- **WHEN** profile 的 API Key 以明文存储
- **THEN** 任何启动诊断、运行错误和测试快照均不包含该明文值
