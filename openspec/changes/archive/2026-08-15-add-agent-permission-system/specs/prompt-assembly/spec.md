## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: 模型请求必须经过最终字节级守卫

协议适配器编码完成后、网络发送前，Input Guard MUST 对目标 provider profile、protocol、model、origin、最终 headers 和 body 字节再次校验 classification、destination grant、凭据模式和未授权动态内容。发现 credential、目标变化或未获披露授权时 MUST 阻止请求，且不得依赖 Prompt 文本要求模型自行忽略。

#### Scenario: 适配器在最终请求中引入未授权字段
- **WHEN** 最终序列化字节包含未出现在已授权 Ledger 视图中的敏感动态值
- **THEN** Input Guard 在网络发送前拒绝模型交换并记录不含正文的安全事件
