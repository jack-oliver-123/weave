## MODIFIED Requirements

### Requirement: 归一化协议流生命周期
协议客户端 SHALL 把原生流映射为协议无关的开始、文本增量、完成和错误结果，并 SHALL 隔离所有供应商 SDK 类型。完成结果 SHALL 携带完成原因，并在供应商返回时携带真实的输入、输出、缓存读取和缓存写入 token usage；系统不得估算缺失 usage，也不得仅凭重复请求推断缓存命中。

#### Scenario: 产生文本增量
- **WHEN** 原生协议产生有效文本增量
- **THEN** 客户端按原始顺序输出等价的协议无关文本增量

#### Scenario: 返回基础 usage
- **WHEN** 原生完成事件包含输入和输出 token 数量
- **THEN** 统一完成结果包含对应的 `inputTokens` 与 `outputTokens`

#### Scenario: 返回缓存 usage
- **WHEN** 原生完成事件包含缓存读取或缓存写入 token 数量
- **THEN** 统一完成结果分别保留 Provider 返回的真实缓存读取与缓存写入数量

#### Scenario: usage 缺失
- **WHEN** 原生协议或兼容网关未返回任一 usage 分项
- **THEN** 统一完成结果将对应字段保持为空并将缓存效果视为不可验证，不得生成推测值

#### Scenario: 达到输出上限
- **WHEN** 原生协议因输出 token 上限终止
- **THEN** 统一完成结果将完成原因标记为截断，而不是网络或协议错误

### Requirement: 请求保持客户端无状态
每次请求 SHALL 发送上层提供的完整中立 `messages` 历史，并 SHALL 不使用 Provider 端会话状态。请求 SHALL 独立携带结构化 `system`、当前阶段允许的 `tools` 以及等价的自动工具选择配置；即使业务工具关闭，请求仍 SHALL 携带控制工具、完整稳定 System Prompt 和当前动态 SystemReminder。静态 System 内容 MUST 位于动态内容之前，SystemReminder MUST NOT 伪装成用户或 assistant 消息。

三个协议适配器 SHALL 按各自原生能力保持静态 System 内容、动态系统上下文、工具定义和普通历史的语义边界。缓存是 Provider 能力而不是正确性前提：适配器 SHALL 形成缓存友好的稳定前缀，并且只有目标 Provider 明确支持时才 SHALL 发送其原生缓存控制字段；兼容网关未支持或拒绝缓存字段时 MUST NOT 改变 Prompt 语义或静默删除动态上下文。

`thinking: false` SHALL 在 Anthropic Messages 请求中映射为 `thinking.type=disabled`；DeepSeek Chat Completions SHALL 使用顶层 `thinking.type=disabled`，DeepSeek Responses SHALL 使用 `reasoning.effort=none`。其他 OpenAI 根地址 SHALL 不接收这些自动禁用字段。OpenAI Responses 请求 MUST NOT 使用 `previous_response_id` 串联服务端会话。统一的 `max_tokens` SHALL 映射为各协议对应的输出限制字段。

#### Scenario: 发送私有运行历史
- **WHEN** AgentLoop 在同一运行内完成业务工具批次并开始下一迭代
- **THEN** 协议客户端收到完整稳定 System 段、当前 SystemReminder、上层提供的完整中立运行历史和当前阶段工具定义

#### Scenario: 不创建服务端 Responses 会话链
- **WHEN** 使用 OpenAI Responses profile 发起第二次或后续请求
- **THEN** 请求包含本地提供的完整历史且不包含 `previous_response_id`

#### Scenario: 业务工具启用请求
- **WHEN** ReAct 或 Plan 执行阶段允许业务工具
- **THEN** 请求同时发送当前业务工具、当前控制工具、自动工具选择、稳定 System Prompt 和动态 SystemReminder

#### Scenario: 业务工具禁用请求
- **WHEN** `tools.enabled` 为 `false`
- **THEN** 请求不发送工作区业务工具，但仍发送控制工具、稳定 System Prompt 和动态 SystemReminder

#### Scenario: 动态状态发生变化
- **WHEN** 相邻请求的当前步骤或迭代状态不同但静态模块版本相同
- **THEN** 适配器保持静态前缀逐字不变并只改变对应动态片段，不按轮次省略或重复稳定规则

#### Scenario: Provider 不支持缓存控制
- **WHEN** 目标模型或兼容网关没有明确支持所选原生缓存控制字段
- **THEN** 适配器不发送该字段，仍发送语义完整的三个请求字段，并把缓存效果报告为不可验证

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
Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 适配器 SHALL 从同一份中立工具定义生成协议请求，不得让业务工具或 AgentLoop 控制工具依赖 Provider SDK 类型。三个适配器 SHALL 传递语义等价的名称、用途、适用与不适用场景、输入 Schema、结果信封、错误语义和工具配合说明，并 SHALL 支持每次请求动态组合业务与控制工具。Provider 明确拒绝工具能力时 SHALL 返回模型服务错误，MUST NOT 对同一运行静默降级为普通文本完成。

系统 SHALL 在静态工具使用模块与相关工具说明中强化同一份权威行为契约，包括优先使用能够直接完成任务的专用工具，以及修改现有文件前读取本次任务所需的相关区段与上下文。创建已确认不存在的新文件 SHALL 先检查目标路径和同类文件约定但无需读取不存在的文件；大文件无需机械全文读取；内容变化、读取失败或证据过期时 SHALL 重新读取；自动生成文件 SHALL 修改源文件并执行生成流程。两处表述 MUST 保持语义一致，不得形成相互冲突的独立规则。

#### Scenario: Anthropic 动态工具定义
- **WHEN** 使用 Anthropic Messages 发起 AgentLoop 请求
- **THEN** 请求使用 `input_schema` 表达当前阶段允许的业务工具与控制工具及其完整中立说明

#### Scenario: 两种 OpenAI 动态工具定义
- **WHEN** 分别使用 Chat Completions 和 Responses 发起 AgentLoop 请求
- **THEN** 两个请求使用各自函数工具格式表达与当前中立定义等价的名称、说明和参数 Schema

#### Scenario: 修改已有文件前读取相关内容
- **WHEN** 模型准备调用编辑工具修改一个已存在文件
- **THEN** 静态提示与编辑工具说明都要求本任务已读取相关区段和必要上下文，且无需为满足形式要求机械读取整个大文件

#### Scenario: 创建确认不存在的新文件
- **WHEN** 模型已确认目标文件不存在并准备创建
- **THEN** 工具契约要求先检查目标路径和同类文件约定，但不要求读取不存在的目标文件

#### Scenario: Provider 拒绝控制工具字段
- **WHEN** 兼容网关明确拒绝工具定义或工具选择字段
- **THEN** 系统报告脱敏模型服务错误且不把普通文本响应降级解释为完成
