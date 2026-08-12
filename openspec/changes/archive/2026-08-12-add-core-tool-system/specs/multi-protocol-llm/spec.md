## MODIFIED Requirements

### Requirement: 本地 YAML 配置模型 profile
系统 SHALL 默认读取 `~/.weave/config.yaml`，并 SHALL 支持通过 `--config <path>` 覆盖配置路径。配置 SHALL 包含 `default_profile` 和 `profiles` 列表，每个 profile SHALL 使用唯一 `name`，并包含 `protocol`、`model`、`base_url`、`api_key`、`thinking`，可选包含 `max_tokens` 和 `tools.enabled`；配置根节点也可选包含 `tools.enabled`。工具启停优先级 SHALL 为命令行 `--tools` 或 `--no-tools`、当前 profile 的 `tools.enabled`、根节点的 `tools.enabled`、默认值 `true`。除 `enabled` 外的未知 `tools` 字段 SHALL 被拒绝。

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

#### Scenario: 默认启用工具
- **WHEN** 命令行、当前 profile 和根节点均未设置工具启停
- **THEN** 系统将 `tools.enabled` 解析为 `true`

#### Scenario: 命令行禁用工具
- **WHEN** 用户传入 `--no-tools`，即使配置中启用了工具
- **THEN** 系统关闭工具功能并使用纯文本对话路径

#### Scenario: 工具配置字段无效
- **WHEN** 任一 `tools` 对象包含 `enabled` 以外字段或 `enabled` 不是布尔值
- **THEN** 系统在启动 TUI 前输出中文字段级诊断并以非零状态退出

### Requirement: 请求保持客户端无状态
每次请求 SHALL 发送当前会话全部已提交消息，并 SHALL 不使用 Provider 端会话状态。工具启用时，请求 SHALL 携带固定工具集合、工具使用系统指令和等价的自动工具选择配置；工具禁用或达到累计工具调用上限后的纯文本收尾请求 SHALL 不携带工具定义、工具选择配置或工具系统指令。`thinking: false` SHALL 在 Anthropic Messages 请求中映射为 `thinking.type=disabled`；DeepSeek Chat Completions SHALL 使用顶层 `thinking.type=disabled`，DeepSeek Responses SHALL 使用 `reasoning.effort=none`。其他 OpenAI 根地址 SHALL 不接收这些自动禁用字段。OpenAI Responses 请求 MUST NOT 使用 `previous_response_id` 串联服务端会话。统一的 `max_tokens` SHALL 映射为各协议对应的输出限制字段。

#### Scenario: 发送多轮历史
- **WHEN** 会话已有已提交的文本、工具调用和工具结果并开始新请求
- **THEN** 协议客户端收到完整的中立历史和当前用户输入，并转换为协议对应消息

#### Scenario: 不创建服务端 Responses 会话链
- **WHEN** 使用 OpenAI Responses profile 发起第二轮或后续请求
- **THEN** 请求包含本地完整历史且不包含 `previous_response_id`

#### Scenario: 工具启用请求
- **WHEN** `tools.enabled` 为 `true` 且尚未进入调用上限收尾
- **THEN** 请求发送六个工具定义、等价的 `auto` 工具选择和固定工具使用原则，且不强制模型必须调用工具

#### Scenario: 工具禁用请求
- **WHEN** `tools.enabled` 为 `false`
- **THEN** 请求不包含 system prompt、工具定义或工具选择配置，并保持现有纯文本请求行为

#### Scenario: DeepSeek Chat Completions 端点禁用 thinking
- **WHEN** OpenAI Chat Completions profile 的 `base_url` 主机为 `api.deepseek.com` 且 `thinking: false`
- **THEN** 请求包含顶层 `thinking: {type: "disabled"}`，流中不得出现 reasoning 内容

#### Scenario: DeepSeek Responses 端点禁用 reasoning
- **WHEN** OpenAI Responses profile 的 `base_url` 主机为 `api.deepseek.com` 且 `thinking: false`
- **THEN** 请求包含 `reasoning: {effort: "none"}` 且不包含顶层 `thinking`，流中不得出现 reasoning item 或 reasoning delta

#### Scenario: 标准 OpenAI 端点不接收供应商扩展
- **WHEN** OpenAI profile 的 `base_url` 主机不是 `api.deepseek.com`
- **THEN** 请求不包含由 Weave 自动注入的 `thinking` 或 `reasoning` 禁用字段

## ADDED Requirements

### Requirement: 从中立定义映射三种工具协议
Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 适配器 SHALL 从同一份中立工具定义生成协议请求，不得让工具实现依赖 Provider SDK 类型。三个适配器 SHALL 传递语义等价的名称、中文说明和输入 Schema；Provider 明确拒绝工具能力时 SHALL 返回模型服务错误，MUST NOT 对同一用户请求静默降级为纯文本重试。

#### Scenario: Anthropic 工具定义
- **WHEN** 使用 Anthropic Messages 且工具启用
- **THEN** 请求使用协议要求的 `input_schema` 表达六个中立工具定义

#### Scenario: 两种 OpenAI 工具定义
- **WHEN** 分别使用 Chat Completions 和 Responses 且工具启用
- **THEN** 两个请求使用各自函数工具格式表达与中立定义等价的名称、说明和参数 Schema

#### Scenario: Provider 拒绝工具字段
- **WHEN** 兼容网关明确拒绝工具定义或工具选择字段
- **THEN** 系统报告脱敏模型服务错误且不自动重新发送纯文本请求

### Requirement: 完整组装流式工具调用
协议适配器 SHALL 按 `providerCallId` 缓冲碎片化的工具名称和 JSON 参数，并 SHALL 只在当前模型响应正常结束且全部调用完整后输出有序调用集合。单个调用参数缓冲 MUST NOT 超过 64 KiB。普通文本和工具调用可以存在于同一 assistant 消息，尤其 Anthropic 文本块与 `tool_use` MUST 保持在同一消息中。

可可靠关联的未知工具、JSON 解析错误或参数校验错误 SHALL 转换为 `isError: true` 的工具结果并允许 Agent Loop 继续。缺少标识、同一响应重复标识、参数超过上限、流异常结束或其他无法可靠关联结果的情况 SHALL 是协议错误，且不得提前执行任何调用。

#### Scenario: 同时返回文本和多个工具调用
- **WHEN** 模型正常流式返回过程文本及多个碎片化工具调用
- **THEN** 系统保留同一 assistant 消息中的文本和调用，并在完整响应结束后按首次出现顺序交给调度器

#### Scenario: 参数 JSON 无效
- **WHEN** 一个有有效 Provider 标识的调用在完整响应结束后仍无法解析参数 JSON
- **THEN** 系统生成与该调用关联且 `isError: true` 的参数错误结果供模型修正

#### Scenario: 流未正常结束
- **WHEN** 工具调用参数尚未闭合时模型流异常终止
- **THEN** 系统返回协议错误且不执行该响应中的任何工具

### Requirement: 映射结构化工具结果
中立工具结果 SHALL 保留必填 `isError`。Anthropic Messages SHALL 把结果映射为对应 `tool_result`，将 `isError` 映射为原生 `is_error`，并以 JSON 文本承载结构化内容；OpenAI Chat Completions SHALL 使用对应 `tool_call_id` 的 `role: "tool"` 消息；OpenAI Responses SHALL 使用对应 `call_id` 的 `function_call_output`。两个 OpenAI 协议的输出 JSON MUST 包含 `isError`。

JSON 序列化 SHALL 使用紧凑、稳定字段顺序，省略 `undefined`，并 SHALL 拒绝 `NaN`、`Infinity`、`BigInt` 或循环引用；序列化失败 SHALL 是内部系统错误，不得伪造工具结果。

#### Scenario: 映射失败工具结果
- **WHEN** 任一工具返回 `isError: true`
- **THEN** 三种协议都向模型提供可稳定识别为错误且与原调用标识关联的结构化结果

#### Scenario: 工具结果不可序列化
- **WHEN** 中立结果包含协议适配器无法合法序列化的值
- **THEN** 系统以内部错误终止当前 turn 且不发送不完整工具结果

### Requirement: 提供完整的三协议工具闭环验收
默认自动化测试 SHALL 对三种协议分别覆盖发送工具定义、流式组装多个调用、分批执行、返回工具结果、模型继续生成最终文本的完整闭环，并 SHALL 覆盖文本与工具调用同消息、工具成功、未知工具、参数错误、执行失败、写入失败后跳过、取消、调用上限和跨用户轮次历史。默认测试 MUST NOT 使用真实 API；真实 API 工具 smoke SHALL 保持手动可选并单独报告。

#### Scenario: 默认三协议闭环
- **WHEN** 执行默认集成测试
- **THEN** 可控假 Provider 对三个协议完成全部工具闭环且不读取真实 API 密钥

#### Scenario: 任一协议闭环缺失
- **WHEN** 一个协议只能发出工具调用但无法接收结果并正常生成最终文本
- **THEN** 该协议的工具能力验收失败，系统不得宣称三协议工具功能完成
