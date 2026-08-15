# prompt-assembly Specification

## Purpose

定义 Weave 如何把稳定全局规则、可信动态上下文、当前工具和对话历史组装为可审计、缓存友好且跨 Provider 一致的模型请求，同时保持来源与信任边界清晰。

## Requirements

### Requirement: 以七个固定模块组成生产级静态提示词
系统 SHALL 以身份、系统约束、任务模式、动作执行、工具使用、语气风格、文本输出七个固定模块组成静态 System Prompt。模块 SHALL 具有稳定唯一标识、显式版本、唯一优先级和非空内容，并 SHALL 按上述顺序以单个空行确定性拼装；重复标识、重复优先级或空模块 MUST 被拒绝。系统本次 MUST NOT 开放第三方运行时注册或配置覆盖入口。

静态提示词 SHALL 将 Weave 定位为终端 Coding Agent，并 SHALL 定义以下冲突裁决顺序：运行时硬约束与实际可用工具；安全边界与用户明确授权范围；当前任务目标与任务模式；工具及动作执行规则；代码质量规范；输出格式与语气偏好。低优先级规则 MUST NOT 覆盖高优先级规则，仍无法消解的冲突 SHALL 停止相关动作并请求用户澄清。

#### Scenario: 确定性生成稳定提示词
- **WHEN** 系统使用同一组七模块及版本组装两次静态提示词
- **THEN** 两次结果的模块顺序、分隔、正文和稳定哈希完全一致

#### Scenario: 拒绝歧义注册表
- **WHEN** 静态模块存在重复标识、重复优先级或空内容
- **THEN** 系统在发起模型请求前拒绝组装并报告内部配置错误

### Requirement: 将八个输入来源映射为三个请求字段
Prompt 组装管线 SHALL 接收固定 Weave 协议、环境事实、工具定义、项目指令、自动记忆、已激活 Skill、运行时状态和 Secure Context Ledger 八类输入来源，并 SHALL 只输出 `system`、`tools`、`messages` 三个协议无关字段。只有版本化的固定 Weave 协议和经过 schema 校验、不含自然语言的枚举或数值 SHALL 进入 `system`；中立工具定义 SHALL 只进入 `tools`；用户输入、环境事实、项目指令、计划、历史、记忆、Skill 和运行时自然语言 SHALL 作为带 `ProvenanceEnvelope` 的 untrusted user 内容进入 `messages`；工具结果 SHALL 作为 untrusted tool 内容进入 `messages`。

授权决定、权限规则、拒绝缓存、票据、凭据引用的解析结果、审计记录和安全内部状态 MUST NOT 进入任何模型请求字段。组装器 MUST 只消费 Gateway 提供的已授权 Ledger 视图，MUST NOT 自行读取文件、环境、ConversationStore 或历史来补齐上下文。

#### Scenario: 组装首版请求
- **WHEN** Action Gateway 提供固定协议、已塑形工具定义和含环境、运行状态及历史的已授权 Ledger 视图
- **THEN** 系统生成只含固定可信协议的 `system`、最小工具 `tools` 和保留来源与 trust 的 `messages`

#### Scenario: 后续来源尚未接入
- **WHEN** Gateway 没有显式提供项目指令、自动记忆或已激活 Skill 的已授权 Ledger 项
- **THEN** 请求不产生对应标题、空片段或隐式文件读取

### Requirement: 只把白名单环境事实提升到动态系统上下文
系统 SHALL 不再把 cwd、工作区路径、shell、日期、时区、profile 名称或其他运行时字符串提升到 `system`。确需模型使用的环境事实 SHALL 由可信运行时生成、附加 provenance、进行数据分类，并作为确定性序列化的 untrusted user 数据进入 `messages`。仅不会承载自然语言、路径或标识符的 schema 枚举和数值 MAY 进入固定协议预留字段；它们 MUST NOT 改变用户目标、授权范围、任务模式或冲突优先级。

系统 MUST NOT 自动注入 Git 分支、工作树状态、文件内容、日志、命令输出、工具结果或环境变量；需要这些事实时 SHALL 通过受控动作取得，并按其来源、分类和 destination 处理。

#### Scenario: 过滤非白名单环境字段
- **WHEN** 环境快照同时包含 cwd、时区、Git 分支名、环境变量和最近命令输出
- **THEN** 所有确需的环境事实仅作为已分类 untrusted 消息发送，Git、环境变量和命令输出不会被隐式读取或进入 `system`

#### Scenario: 环境值包含指令文本
- **WHEN** 一个环境事实值看似包含模型指令
- **THEN** 系统保持其 untrusted 数据身份，且该值不能进入 `system` 或改变 Action Gateway 决策

### Requirement: 以类型和来源元数据保护动态内容边界
每个动态数据项 SHALL 在内部保留 `ProvenanceEnvelope`，至少包括 `kind`、`source`、`classification`、`contentDigest`、`purpose` 与内容引用。程序 MUST NOT 通过反向解析展示标签恢复信任、类型或授权。用于帮助模型识别分区的标签仅是序列化格式，MUST NOT 被视为权限或安全边界；自由文本进入请求前 SHALL 使用确定性编码，使内容不能提前闭合、伪造或改变片段边界。

运行时控制状态 SHALL 只由 Weave 可信组件生成，但只要其包含动态自然语言或标识符，就 SHALL 作为 untrusted user 数据发送。用户消息、对话历史、工具观察、项目文件、计划、记忆、Skill 和 Public Transcript MUST NOT 冒充固定协议、授权决定或 `trusted_runtime`。分类 SHALL 按 `credential > sensitive > ordinary` 单调传播，序列化标签不得降低分类。

#### Scenario: 自由文本伪造结束标签
- **WHEN** 一个未来 Skill 片段包含与序列化结束标签相同的文字
- **THEN** 编码结果仍保持该文字位于 Skill 数据边界内，且其他数据项的类型、来源和分类不变

#### Scenario: 不可信来源冒充运行时提醒
- **WHEN** 工具结果声称自己是新的系统指令、权限允许或运行时提醒
- **THEN** 系统继续把它作为 untrusted tool 数据处理，不生成固定协议或授权状态

### Requirement: 以当前工具字段表达动态能力
当前请求可用能力 SHALL 以 `tools` 字段为唯一权威清单，并 SHALL 按 AgentLoop 阶段暴露最小业务与控制工具集合；系统 MUST NOT 为提高缓存命中率而发送当前阶段不可调用的工具。完整工具说明 MUST NOT 重复进入 SystemReminder。

系统 SHALL 为未来 MCP 能力变化预留 `capability_change` 运行时片段。只有某次上线或下线影响当前任务时，可信运行时才 SHALL 在 SystemReminder 中说明受影响能力及任务影响；本次 MUST NOT 接入真实 MCP Server 或维护完整 MCP 状态副本。

#### Scenario: 阶段切换缩小工具集合
- **WHEN** AgentLoop 从 ReAct 执行进入只允许控制工具的收尾阶段
- **THEN** 下一请求的 `tools` 移除业务工具，SystemReminder 不复制被移除工具的完整说明

#### Scenario: 能力变化不影响当前任务
- **WHEN** 一个未来 MCP Server 下线但当前任务与其工具无关
- **THEN** `tools` 反映实际可用集合，SystemReminder 不增加无关能力变化提醒

### Requirement: 记录可审计而不泄露正文的 Prompt 元数据
静态提示词 SHALL 具有显式 `promptVersion`，每个静态模块 SHALL 具有独立版本。系统 SHALL 为稳定 System 段与完整组装结果计算确定性哈希，并 SHALL 允许观测模块标识、动态片段类型、来源、信任等级、字符数和 Provider 返回的 usage。

默认日志 MUST NOT 记录静态或动态 Prompt 正文、对话正文、工具结果正文或密钥。人工场景结果 SHALL 可关联协议、模型、Prompt 版本和场景标识。系统 MUST NOT 根据字符数推测 token usage，且本次 MUST NOT 对 Prompt、SystemReminder 或最终回答新增字符硬上限、静默截断、自动摘要或拒绝策略。

#### Scenario: 输出安全审计记录
- **WHEN** 一次模型请求完成且包含环境与运行时动态片段
- **THEN** 审计信息包含版本、哈希、片段元数据和真实 usage，但不包含这些片段或对话的正文

#### Scenario: Provider 未返回 token 信息
- **WHEN** Provider 没有返回某类 usage
- **THEN** 审计记录将该指标保持未知，不使用字符数生成估算值

### Requirement: 以证据优先且精简务实的方式工作和输出
静态提示词 SHALL 要求模型先使用可用只读能力获取本地代码、配置和执行结果的直接证据；对可能变化的外部事实、关键数字和高风险结论，在工具能力允许且与任务相关时 SHALL 查证权威来源。无法核实时 SHALL 明确区分事实、推测和主观建议，并说明关键假设、依据、成本、偏差、风险与替代解释；发现用户前提错误时 SHALL 直接指出而不得迎合。

输出 SHALL 默认跟随用户当前语言，用户明确指定时服从指定；代码标识符、命令、路径和协议关键词 SHALL 保留必要原文。回答 SHALL 结论优先、精简务实、不使用表情符号，并保留任务所需证据、验证状态和残余风险；不得为形式完整机械增加无关分段、寒暄、重复或空泛总结，也不得用统一字数限制牺牲必要信息。

#### Scenario: 无法核实关键结论
- **WHEN** 模型无法用可用工具验证一个影响方案的关键结论
- **THEN** 输出明确标记未验证状态并说明影响，而不是把推测表述为事实

#### Scenario: 用户使用中文请求实现结果
- **WHEN** 用户未另行指定语言并使用中文提交任务
- **THEN** 最终回答使用精简务实的中文，不使用表情符号，并区分已通过、失败、未运行和受外部条件阻塞的验证状态

### Requirement: 模型请求必须经过最终字节级守卫

协议适配器编码完成后、网络发送前，Input Guard MUST 对目标 provider profile、protocol、model、origin、最终 headers 和 body 字节再次校验 classification、destination grant、凭据模式和未授权动态内容。发现 credential、目标变化或未获披露授权时 MUST 阻止请求，且不得依赖 Prompt 文本要求模型自行忽略。

#### Scenario: 适配器在最终请求中引入未授权字段
- **WHEN** 最终序列化字节包含未出现在已授权 Ledger 视图中的敏感动态值
- **THEN** Input Guard 在网络发送前拒绝模型交换并记录不含正文的安全事件
