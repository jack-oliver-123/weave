## MODIFIED Requirements

### Requirement: 请求保持客户端无状态
每次请求 SHALL 发送上层提供的完整中立消息历史，并 SHALL 不使用 Provider 端会话状态。请求 SHALL 独立携带当前 AgentLoop 构建的 `systemPrompt`、当前阶段允许的业务与控制工具定义以及等价的自动工具选择配置；即使业务工具关闭，请求仍 SHALL 携带控制工具与最小 System Prompt。提示词 MUST NOT 伪装成用户或 assistant 消息。

`thinking: false` SHALL 在 Anthropic Messages 请求中映射为 `thinking.type=disabled`；DeepSeek Chat Completions SHALL 使用顶层 `thinking.type=disabled`，DeepSeek Responses SHALL 使用 `reasoning.effort=none`。其他 OpenAI 根地址 SHALL 不接收这些自动禁用字段。OpenAI Responses 请求 MUST NOT 使用 `previous_response_id` 串联服务端会话。统一的 `max_tokens` SHALL 映射为各协议对应的输出限制字段。

#### Scenario: 发送私有运行历史
- **WHEN** AgentLoop 在同一运行内完成业务工具批次并开始下一迭代
- **THEN** 协议客户端收到上层提供的完整中立运行历史、当前 System Prompt 和当前阶段工具定义

#### Scenario: 不创建服务端 Responses 会话链
- **WHEN** 使用 OpenAI Responses profile 发起第二次或后续请求
- **THEN** 请求包含本地提供的完整历史且不包含 `previous_response_id`

#### Scenario: 业务工具启用请求
- **WHEN** ReAct 或 Plan 执行阶段允许业务工具
- **THEN** 请求同时发送当前业务工具、当前控制工具、自动工具选择和对应模式 System Prompt

#### Scenario: 业务工具禁用请求
- **WHEN** `tools.enabled` 为 `false`
- **THEN** 请求不发送工作区业务工具，但仍发送控制工具和对应模式 System Prompt

#### Scenario: DeepSeek Chat Completions 端点禁用 thinking
- **WHEN** OpenAI Chat Completions profile 的 `base_url` 主机为 `api.deepseek.com` 且 `thinking: false`
- **THEN** 请求包含顶层 `thinking: {type: "disabled"}`，流中不得出现 reasoning 内容

#### Scenario: DeepSeek Responses 端点禁用 reasoning
- **WHEN** OpenAI Responses profile 的 `base_url` 主机为 `api.deepseek.com` 且 `thinking: false`
- **THEN** 请求包含 `reasoning: {effort: "none"}` 且不包含顶层 `thinking`，流中不得出现 reasoning item 或 reasoning delta

#### Scenario: 标准 OpenAI 端点不接收供应商扩展
- **WHEN** OpenAI profile 的 `base_url` 主机不是 `api.deepseek.com`
- **THEN** 请求不包含由 Weave 自动注入的 `thinking` 或 `reasoning` 禁用字段

### Requirement: 从中立定义映射三种工具协议
Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 适配器 SHALL 从同一份中立工具定义生成协议请求，不得让业务工具或 AgentLoop 控制工具依赖 Provider SDK 类型。三个适配器 SHALL 传递语义等价的名称、说明和输入 Schema，并 SHALL 支持每次请求动态组合业务与控制工具。Provider 明确拒绝工具能力时 SHALL 返回模型服务错误，MUST NOT 对同一运行静默降级为普通文本完成。

#### Scenario: Anthropic 动态工具定义
- **WHEN** 使用 Anthropic Messages 发起 AgentLoop 请求
- **THEN** 请求使用 `input_schema` 表达当前阶段允许的业务工具与控制工具

#### Scenario: 两种 OpenAI 动态工具定义
- **WHEN** 分别使用 Chat Completions 和 Responses 发起 AgentLoop 请求
- **THEN** 两个请求使用各自函数工具格式表达与当前中立定义等价的名称、说明和参数 Schema

#### Scenario: Provider 拒绝控制工具字段
- **WHEN** 兼容网关明确拒绝工具定义或工具选择字段
- **THEN** 系统报告脱敏模型服务错误且不把普通文本响应降级解释为完成

### Requirement: 提供完整的三协议工具闭环验收
默认自动化测试 SHALL 对三种协议分别覆盖独立 System Prompt、动态业务与控制工具定义、流式组装多个业务调用、有序批量执行、结果回传、协议纠正、`complete_task` 完成和 `request_user_input` 暂停的完整闭环。Plan 验收 SHALL 覆盖 `submit_plan`、步骤执行、`complete_step`、任务级完成和计划修订控制工具。测试 SHALL 同时覆盖文本与工具调用同消息、工具成功、未知工具、参数错误、执行失败、写入失败后跳过、取消、迭代与调用上限及跨运行筛选历史。

默认测试 MUST NOT 使用真实 API；真实 API AgentLoop smoke SHALL 保持手动可选并单独报告，未执行时不得描述为通过。

#### Scenario: 默认三协议 AgentLoop 闭环
- **WHEN** 执行默认集成测试
- **THEN** 可控假 Provider 对三个协议完成 ReAct 与 Plan 控制工具闭环且不读取真实 API 密钥

#### Scenario: 任一协议无法提交控制终态
- **WHEN** 一个协议能发出业务工具调用但无法接收结果并成功调用 AgentLoop 控制工具
- **THEN** 该协议的 AgentLoop 验收失败，系统不得宣称三协议双模式完成

#### Scenario: 未执行真实 smoke
- **WHEN** 本地自动化全部通过但未配置或未运行真实 Provider
- **THEN** 验证报告明确标记真实 API smoke 未验证，而不是标记通过
