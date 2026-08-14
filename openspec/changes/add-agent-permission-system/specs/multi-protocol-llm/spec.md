## MODIFIED Requirements

### Requirement: 本地 YAML 配置模型 profile
系统 SHALL 默认读取 `~/.weave/config.yaml`，并 SHALL 支持通过 `--config <path>` 覆盖配置路径。配置 SHALL 包含 `default_profile` 和 `profiles` 列表，每个 profile SHALL 使用唯一 `name`，并包含 `protocol`、`model`、`base_url`、`credential`、`thinking`，可选包含 `max_tokens` 和 `tools.enabled`；`credential` MUST 是操作系统凭据存储中的非秘密引用标识，MUST NOT 是凭据原文。配置根节点也可选包含 `tools.enabled`。工具启停优先级 SHALL 为命令行 `--tools` 或 `--no-tools`、当前 profile 的 `tools.enabled`、根节点的 `tools.enabled`、默认值 `true`；最终可用工具还 MUST 受权限模式和沙箱 Capability Report 收紧。除 `enabled` 外的未知 `tools` 字段 SHALL 被拒绝。

旧 `api_key: ${ENVIRONMENT_VARIABLE}` MAY 在本 major 作为显式弃用迁移入口读取，但 MUST 仅由宿主 Credential Broker 解析，MUST 发出不含值的弃用诊断，并 MUST 在下一 major 移除。明文 `api_key` MUST 被拒绝。系统 SHALL 提供本地 `credential set`、`credential delete` 和 `credential list` 管理入口；写入 MUST 从隐藏输入或 stdin 接收，list MUST 只显示引用元数据而不显示秘密。

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
- **WHEN** profile 包含明文 `api_key`、弃用的 `${ENVIRONMENT_VARIABLE}` 引用或新的 `credential` 引用
- **THEN** 明文配置被拒绝，环境引用仅走带警告的宿主迁移通道，而 credential 引用在不暴露秘密的情况下通过校验

#### Scenario: 默认启用工具
- **WHEN** 命令行、当前 profile 和根节点均未设置工具启停
- **THEN** 系统把配置意图解析为启用工具，但只向模型提供当前权限与已认证后端实际可用的能力

#### Scenario: 命令行禁用工具
- **WHEN** 用户传入 `--no-tools`，即使配置中启用了工具
- **THEN** 系统不创建业务工具 Runner，并使用受 Input/Output Guard 保护的纯文本路径

#### Scenario: 工具配置字段无效
- **WHEN** 任一 `tools` 对象包含 `enabled` 以外字段或 `enabled` 不是布尔值
- **THEN** 系统在启动 TUI 前输出中文字段级诊断并以非零状态退出

### Requirement: 请求保持客户端无状态
每次 Provider 请求 SHALL 由 Action Gateway 通过不透明 `ModelExchangeRef` 提供最终序列化的 `system`、`tools` 与 `messages`，并 SHALL 不使用 Provider 端会话状态。协议客户端 MUST NOT 接收 ConversationStore、Secure Context Ledger、权限规则、授权决定、票据、凭据原文或未守卫的原始消息；它只可发送 Input Guard 已批准的当前 envelope。固定 System 内容 MUST 位于其他协议字段之前，动态项目、计划、历史、路径、记忆和运行状态 MUST 保持为带 provenance 的 untrusted message，不能伪装成 system。

三个协议适配器 SHALL 按各自原生能力保持固定 System、工具定义和普通消息的语义边界。缓存是 Provider 能力而不是正确性前提：适配器 SHALL 形成缓存友好的固定前缀，并且只有目标 Provider 明确支持时才 SHALL 发送其原生缓存控制字段；兼容网关未支持或拒绝缓存字段时 MUST NOT 改变 Prompt 语义、目标绑定或静默删除已授权上下文。

`thinking: false` SHALL 在 Anthropic Messages 请求中映射为 `thinking.type=disabled`；DeepSeek Chat Completions SHALL 使用顶层 `thinking.type=disabled`，DeepSeek Responses SHALL 使用 `reasoning.effort=none`。其他 OpenAI 根地址 SHALL 不接收这些自动禁用字段。OpenAI Responses 请求 MUST NOT 使用 `previous_response_id` 串联服务端会话。统一的 `max_tokens` SHALL 映射为各协议对应的输出限制字段。

#### Scenario: 发送私有运行历史
- **WHEN** AgentLoop 在同一运行内完成动作批次并开始下一迭代
- **THEN** 协议客户端只收到 Gateway 为当前 `ModelExchangeRef` 生成的固定 System、已授权消息与当前能力塑形工具定义

#### Scenario: 不创建服务端 Responses 会话链
- **WHEN** 使用 OpenAI Responses profile 发起第二次或后续请求
- **THEN** 请求包含 Gateway 提供的完整本地上下文且不包含 `previous_response_id`

#### Scenario: 业务工具启用请求
- **WHEN** ReAct 或 Plan 执行阶段允许业务工具
- **THEN** 请求只发送权限模式与已认证 backend 共同允许的业务工具、当前控制工具、自动工具选择和固定 System 协议

#### Scenario: 业务工具禁用请求
- **WHEN** `tools.enabled` 为 `false`
- **THEN** 请求不发送工作区业务工具，但仍可发送控制工具和固定 System 协议

#### Scenario: 动态状态发生变化
- **WHEN** 相邻请求的当前步骤或迭代状态不同但固定协议版本相同
- **THEN** 适配器保持固定 System 前缀逐字不变，并仅在 untrusted messages 中更新已授权动态状态

#### Scenario: Provider 不支持缓存控制
- **WHEN** 目标模型或兼容网关没有明确支持所选原生缓存控制字段
- **THEN** 适配器不发送该字段，仍发送语义完整的已授权请求，并把缓存效果报告为不可验证

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

### Requirement: Task 必须固定模型目的地

Action Task Session MUST 在创建时固定 provider profile、protocol、model、规范化 origin 和 Credential Reference。模型目的地授权 MUST 绑定这些值；HTTP 重定向、自动 fallback、负载均衡到不同 origin、运行中模型切换或兼容网关改写目的地 MUST 被拒绝或作为新的 Task 显式建立，不能继承旧 destination grant。

#### Scenario: Provider 返回跨主机重定向
- **WHEN** 固定模型 origin 的请求响应要求重定向到另一主机
- **THEN** 协议客户端不跟随重定向，当前模型交换失败且不会向新主机发送上下文或凭据

### Requirement: 原始模型流与工具提案必须由 Gateway 保管

协议适配器 SHALL 把原始文本 delta、tool call delta、usage 和完成事件送入 Gateway 的 Output Guard 与 proposal assembler。AgentLoop MUST 只收到通过发布守卫的文本事件、安全工具描述及不透明 `ProposalBatchRef`，MUST NOT 收到原始工具参数、未发布敏感字节或 Provider 原生事件。Provider tool call 组装失败 SHALL 在任何动作执行前产生脱敏协议错误。

#### Scenario: 模型同时返回敏感文本和工具调用
- **WHEN** 原始流包含被 Output Guard 暂停的 sensitive 文本以及完整业务工具提案
- **THEN** Gateway 保管两者，先完成对应披露与动作授权，AgentLoop 不接触未发布文本或原始参数

### Requirement: Provider 凭据必须在发送边界按引用注入

协议客户端 MUST 仅向 Credential Broker 提交当前固定 profile 的 Credential Reference 和当前目标 origin。Broker SHALL 在宿主网络发送边界注入所需认证材料，秘密 MUST NOT 写入请求对象诊断、重试载荷、错误、日志、模型上下文或沙箱。认证失败 MUST 返回脱敏错误且不得提示模型读取配置或环境变量。

#### Scenario: Provider 返回 401
- **WHEN** 使用 Credential Reference 的固定模型请求收到认证失败
- **THEN** 用户得到不含秘密的 profile 诊断，模型和 AgentLoop 不接触凭据值
