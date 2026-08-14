## Context

参见 `proposal.md` 的动机。当前 `buildSystemPrompt` 根据四个阶段返回单个字符串，`LlmRequest` 再携带 `messages`、`tools` 与可选 `systemPrompt`；三个 codec 分别把该字符串映射到 Anthropic `system`、Chat Completions `system` message 和 Responses `instructions`。工具说明已由中立 `ToolDefinition` 生成，但运行时提示、环境上下文、来源审计和缓存 usage 尚无统一契约。

本变更横跨 shared 类型、AgentLoop、Prompt 构建、工具描述、三个 Provider codec、usage 聚合和 live smoke。三种协议及兼容网关对系统内容、显式缓存控制和缓存 usage 的支持并不完全相同，因此公共层只能保证语义边界和稳定前缀，不能保证缓存必然命中。

## Goals / Non-Goals

**Goals:**

- 建立单一、类型化、确定性的 Prompt 组装入口，使输入来源、信任等级、稳定性和 Provider 输出字段可审计。
- 用固定七模块表达跨项目通用的终端 Coding Agent 契约，同时让阶段、环境和未来扩展内容保持动态。
- 在不牺牲阶段最小工具集合的前提下形成缓存友好前缀，并归一化 Provider 实际返回的缓存读写指标。
- 让静态提示、工具说明和运行时状态各自只有一个权威语义来源，避免重复规则漂移。

**Non-Goals:**

- 不实现运行时权限系统、沙箱增强或把提示词当作安全执行边界。
- 不实现 `WEAVE.md` 发现与加载、自动记忆、Skill 加载、真实 MCP Server 接入或跨进程 Prompt 状态。
- 不实现统一字数限制、自动截断、自动摘要、LLM-as-judge、自动质量评分或 Prompt 优化闭环。
- 不承诺每个模型、官方端点或兼容网关支持显式缓存或返回缓存 usage。

## Decisions

### 1. 请求契约保持三个顶层字段，System 使用结构化组装结果

公共请求继续具有 `system`、`tools`、`messages` 三个语义字段，但 `system` 不再是裸字符串：

```ts
interface PromptAssembly {
  readonly system: {
    readonly stable: StableSystemPrompt;
    readonly reminder?: SystemReminder;
  };
  readonly tools: readonly ToolDefinition[];
  readonly messages: readonly ChatMessage[];
  readonly audit: PromptAudit;
}
```

`LlmRequest` 持有一个 `prompt: PromptAssembly` 与 `maxTokens`、`signal`，不再同时暴露 `messages`、`tools`、`systemPrompt` 的第二套入口。Provider codec 只消费已经组装并校验的对象，不能自行读取环境、任务状态或文件。

替代方案是仅新增 `dynamicSystemPrompt?: string` 并保留旧字段。它迁移量较小，但会留下两个可绕过来源校验的字符串入口，且无法审计片段来源，因此不采用。

### 2. 静态七模块使用封闭注册表和确定性版本

七个模块使用字符串联合 ID 与只读注册表：

```ts
type StaticPromptModuleId =
  | 'identity' | 'system_constraints' | 'task_modes'
  | 'action_execution' | 'tool_usage'
  | 'tone_style' | 'text_output';

interface StaticPromptModule {
  readonly id: StaticPromptModuleId;
  readonly version: string;
  readonly priority: number;
  readonly content: string;
}
```

构建时先校验完整 ID 集合、唯一 priority 与非空内容，再按 priority 排序并以 `\n\n` 连接。`promptVersion` 独立于模块版本；任一模块正文或顺序变化都必须更新对应版本和静态快照。首版不暴露运行时注册 API。

提示词内部明确冲突裁决，而不是依赖文本先后暗示权限。安全与授权部分写明这是模型行为约束；工具实际可用性、阶段限制和未来权限决策始终以运行时为准。

替代方案是一个长模板字符串。它简单但无法独立测试顺序、版本与未来插入，且修改任意段落都缺少可追踪边界，因此不采用。

### 3. SystemReminder 是容器，动态片段保留来源和信任

SystemReminder 不是第九个输入来源，也不是 Provider 新字段，而是动态 System 内容的内部容器：

```ts
type ReminderKind =
  | 'runtime_state' | 'environment' | 'activated_skill'
  | 'project_instructions' | 'memory';

type PromptTrust = 'trusted_runtime' | 'trusted_configuration' | 'untrusted_context';

interface SystemReminderFragment {
  readonly kind: ReminderKind;
  readonly source: string;
  readonly trust: PromptTrust;
  readonly content: StructuredReminderContent;
}
```

容器固定按 `runtime_state -> environment -> activated_skill -> project_instructions -> memory` 排序。首版构造器只开放 `runtime_state` 与 `environment`；后三类仅有类型和空输入路径，不提供加载器。

运行时片段使用封闭判别联合表达模式、阶段、预算、当前计划/步骤、协议纠正及预留的 `capability_change`。环境片段只接受 `cwd`、`workspaceRoots`、`os`、`shell`、`currentDate`、`timezone` 字段，不接受任意键值对象。

替代方案是将 Skill、环境和状态直接拼入一个 `<system-reminder>` 字符串。它无法阻止来源冒充，也难以测试何处破坏缓存，因此不采用。

### 4. 序列化标签不承担安全边界

内部结构是唯一事实来源。序列化器为片段生成固定英文标签与字段顺序，只为了帮助模型识别分区；程序从不反向解析标签。字符串值使用统一 XML 文本转义，拒绝无效控制字符，确保未来自由文本无法闭合或伪造容器边界。

运行时状态由窄构造函数生成并固定为 `trusted_runtime`。未来项目指令、Skill 和记忆即使被放入 system，也保留各自 source 与 trust，不能转换成运行时状态。工具结果和历史不提供进入 Reminder 的构造路径。

这种设计缓解边界混淆，但不能让模型获得真正的指令隔离；模型仍可能受不可信上下文影响。真正强制安全要求仍需运行时校验。

### 5. 稳定模式协议与动态当前状态分离

静态 `task_modes` 定义默认 ReAct、显式 `/plan`、控制工具终态、询问条件和完成证据标准。每次迭代的 `runtime_state` 只描述当前 mode、phase、iteration limit、可选 plan/step/criteria/evidence 和最后一次协议纠正。

每次请求都发送逐字相同的完整静态段和紧凑完整的当前动态段，不按轮次省略或重复规则。状态变化只改变 Reminder。AgentLoop 继续决定阶段工具集合，PromptBuilder 不读取 ConversationStore 或 TUI。

替代方案是首轮完整、每 N 轮重复。它会让相同状态因轮次产生不同 Prompt，破坏稳定前缀并制造难以解释的行为差异，且没有当前评测证据支持，因此不采用。

### 6. 工具行为契约由共享片段生成并保持最小暴露

“专用工具优先”和“编辑现有文件前读取相关上下文”定义为共享的权威规则片段。静态 `tool_usage` 引用面向全局的短版本；相关工具描述由同一常量/结构生成面向该工具的具体版本，避免复制两份可独立漂移的文本。

编辑前读取的语义包括：只读相关区段而非机械全文；新文件先检查路径和同类约定；文件变化、读取失败或证据过期时重读；生成文件改源头并运行生成流程。工具定义仍按阶段动态裁剪，缓存收益不能扩大能力暴露。

替代方案是把完整工具文档复制到 System Prompt。它增加稳定段和工具段重复，可能降低模型表现与缓存效率，因此只保留关键跨工具决策规则。

### 7. Provider 适配器分别映射 System 边界

中立 codec 先生成 `stableSystemText`、可选 `reminderText`、工具定义和消息历史；协议层按原生能力映射：

- Anthropic Messages：使用 system content blocks 保持稳定段在前、动态段在后；仅在 SDK 与目标端点能力明确时为稳定边界发送原生 `cache_control`。
- OpenAI Chat Completions：稳定段与动态段默认保持为连续的 `system` 消息；profile 可显式配置 `chat_system_mode: single`，为不接受连续高优先级消息的兼容端点合并为单一 `system` 表达，但不得降级为 user 消息。该配置不允许用于其他协议。
- OpenAI Responses：将稳定与动态 System 内容映射为 `instructions` 或支持的高优先级输入项，并按目标模型能力选择隐式或显式 Prompt caching；继续禁用 Provider 端会话链。

能力判断应来自明确的协议/profile 配置或 SDK 可用字段，不通过“先发送未知字段、失败再重试”探测，因为同一任务隐式重放可能重复模型或工具副作用。未支持显式缓存时仍发送完整语义，只是不发送缓存控制。

替代方案是强制三协议使用完全相同 JSON 形态。三种原生协议不存在该共同形态，这会把兼容假象推给网关，因此不采用。

### 8. usage 保留基础输入与缓存读写的独立指标

统一 usage 扩展为：

```ts
interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}
```

Anthropic 原生 `cache_read_input_tokens` 和 `cache_creation_input_tokens` 分别映射读取与写入。OpenAI 从响应 usage 的原生 input token details 中读取缓存命中，并在目标模型返回 cache write 指标时映射写入；Chat Completions、Responses 或兼容网关缺少字段时保持 `undefined`。

AgentLoop 和 ConversationManager 对同名可选字段逐项求和，只有至少一个真实值时才输出该项。`0` 是 Provider 明确返回的有效观测，不能与缺失混淆。live smoke 连续发送相同稳定前缀并记录原生归一化指标，但没有字段时结论必须是“不可验证”。

### 9. 审计使用版本、哈希和元数据，不记录正文

组装完成后使用稳定 JSON 编码与 SHA-256 分别计算稳定段哈希和完整组装哈希。审计记录包含 promptVersion、模块 ID/版本、哈希、动态 kind/source/trust、各段字符数、协议、模型及最终 usage，不包含 Prompt、历史、工具结果或密钥正文。

哈希用于关联测试与行为，不用于认证或权限判断。人工场景用固定场景 ID 对比变更前后，记录协议、模型、版本、工具轨迹、验证结果、延迟和 usage；不生成统计质量百分比。

### 10. 不新增内容硬上限，保留现有请求输出上限

本变更不按字符数截断、拒绝或摘要静态 Prompt、Reminder 或回答。可以观测字符数和 Provider usage 以发现膨胀，但行为不因建议预算改变。既有 profile `max_tokens` 仍映射 Provider 输出上限，它是请求生命周期保护，不是 System Prompt 中的统一回答字数要求。

静态输出规则只要求结论优先、精简务实、不使用表情符号，并保留必要证据、假设、验证状态与风险。语言默认跟随用户，项目指令未来可以设置默认语言但不能覆盖用户本轮明确指定。

### 11. 用终态决策规则修复人工评测中的过度调查

PQ-06 与 PQ-07 的真实模型轨迹表明，仅说明完成条件和授权原则不足以让模型及时收敛。静态 `task_modes` 与 `action_execution` 因此增加两条决策规则：必要工作和相关验证已经取得足够证据时，应立即调用 `complete_task`，不得继续无关调查、重复验证或创建任务未要求的文件；任务需要高影响操作但当前明确授权缺失时，只进行决定是否可执行所必需的最小只读预检，随后立即调用 `request_user_input`，不得用继续调查替代授权确认。

同一语义在 `complete_task` 与 `request_user_input` 的中立工具说明中以场景化 `useWhen` 再次强化。真实模型复测进一步证明静态规则本身仍可能受长工具历史影响，因此每批业务工具结果之后，下一轮通过动态 `SystemReminder` 注入一条短的终态决策检查；它只要求模型重新判断两类终态，不推断授权状态、不替模型判定验证是否充分，也不进入稳定 Prompt 缓存段。

该调整仍是模型行为软约束，不新增命令识别、审批状态、工具拦截或权限系统。静态 Prompt 及受影响模块版本递增到 `1.0.2`，并以 PQ-06/PQ-07 单场景真实模型复测记录定性结果，不生成自动分数。

## Risks / Trade-offs

- [更长的静态提示可能降低部分模型表现并增加首次缓存写入成本] → 七模块每条规则只陈述一次，快照审查变化，人工场景同时比较质量、token、延迟和成本，不以“模块齐全”替代评测。
- [SystemReminder 位于 system 层会放大未来不可信自由文本的影响] → 首版只允许封闭结构化来源；未来接入项目指令、Skill 和记忆时保留 trust/source、转义和独立验收，且不宣称标签提供安全隔离。
- [三协议系统角色与缓存能力不等价] → 用协议级契约测试验证语义映射，以 capability 判断启用原生字段；缺失指标明确报告不可验证。
- [工具说明与全局规则双重强化造成重复] → 从同一权威契约生成短全局规则与工具专属说明，并用测试锁定语义而非复制全文。
- [取消旧 `systemPrompt` 会产生较大编译迁移面] → 一次性迁移所有客户端、假 Provider、快照与 smoke；不保留歧义兼容层。
- [当前授权仅是 Prompt 软约束] → 文案明确残余风险；不把高风险询问描述成已强制拦截，后续权限系统独立设计。
- [审计哈希可能被误认为内容证明] → 文档和类型明确哈希只做关联与回归诊断，不参与授权、完整性认证或安全决策。

## Migration Plan

1. 先增加静态模块、Reminder、PromptAssembly、PromptAudit 和扩展 usage 类型，以编译错误列出旧请求入口。
2. 以验收测试先行实现静态模块注册表、环境白名单、动态片段序列化、信任构造器、稳定哈希和组装纯函数。
3. 将 AgentLoop 的阶段 Prompt 输入迁移为结构化运行状态，并保持当前工具 scope 与控制工具协议不变。
4. 迁移工具说明共享契约，再依次迁移 Anthropic、OpenAI Chat、OpenAI Responses codec 与客户端 usage 解析。
5. 删除旧 `systemPrompt` 路径，更新所有假 Provider、快照、集成闭环和 live smoke；不提供运行时兼容开关。
6. 运行分层测试、三协议契约、完整测试、类型检查、构建、严格 OpenSpec 与 WIKI 构建；真实缓存 smoke 仅在显式配置时运行并单独报告。

本变更没有磁盘数据迁移。回滚需要同时恢复旧 shared 请求类型、PromptBuilder 和三协议 codec，不能只回滚单个 Provider；回滚不会撤销已经发生的工作区工具副作用。
