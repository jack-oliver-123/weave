# multi-protocol-llm Specification

## Purpose

定义 Weave 如何从本地配置选择模型，并通过统一的纯文本流式契约兼容 Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses 三种协议，同时隔离协议细节、错误和敏感信息。

## Requirements

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
