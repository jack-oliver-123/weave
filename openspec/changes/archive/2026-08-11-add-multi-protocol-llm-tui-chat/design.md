## Context

见 `proposal.md` 的 Why。当前仓库只有共享契约与五层存根，`@anthropic-ai/sdk` 是唯一运行时依赖，尚无实际配置加载、LLM 请求、对话存储或终端渲染。现有分层约束要求交互层只负责输入与展示，引擎层负责对话和 LLM 通信，记忆层负责历史，跨层只传递 `src/shared/` 中的类型。

本变更同时引入三种外部流协议、全屏终端状态机、明文密钥配置和跨平台 PTY 验收，属于跨模块架构变更，因此需要在实现前固定适配边界与失败语义。

## Goals / Non-Goals

**Goals:**

- 让引擎和 TUI 完全不依赖供应商 SDK 类型或事件名。
- 让三个协议共享相同的对话、取消、超时、完成与错误语义。
- 让 `thinking: false` 在供应商默认启用思考时仍能保证纯文本流，同时不向标准 OpenAI 端点发送非标准字段。
- 把“屏幕上可见的转录”与“可发送给模型的已提交历史”分开，避免失败或取消污染后续上下文。
- 使用可替换的存储与客户端契约，为后续持久化、工具调用和 system prompt 留出扩展点。
- 在 Windows 与 WSL 中以可重复的 PTY 场景验证全屏 TUI，而不是只测试 React 组件快照。

**Non-Goals:**

- 不设计工具调用、MCP、Hooks、权限确认或 agentic loop。
- 不设计跨进程会话、压缩摘要、token 预算或服务端 Responses 会话链。
- 不实现 thinking/reasoning 内容输出、thinking 开启、用户可配置的思考强度、system prompt、Markdown 或费用计算；仅实现关闭 thinking 所需的固定请求映射。
- 不把配置、对话或密钥写入生产数据库，也不连接任何 Agents 或 OMS 数据库。

## Decisions

### 使用根级 composition root 组装各层

新增根级启动入口作为 composition root，负责先解析 CLI 和 YAML，再实例化进程内存储、协议客户端、对话管理器与 TUI。交互组件只依赖共享的引擎端口，引擎只依赖共享的客户端与存储端口；具体实现通过构造参数注入。

这样可以维持层间单向依赖，避免让 Ink 组件直接创建 SDK 客户端，或让协议适配器感知终端状态。备选方案是在 `src/interaction/index.ts` 直接导入所有实现，但会让交互层同时承担组装和业务依赖，不采用。

### 用统一无状态 LLM 客户端封装三个官方 SDK 适配器

定义协议无关请求：已提交消息、当前用户输入、输出上限与 `AbortSignal`；定义协议无关流事件：开始、文本增量、完成和安全错误。profile 在启动时解析为内部只读配置，由工厂创建以下适配器：

- Anthropic Messages：消费命名 SSE 事件并维护内容块索引状态机。
- OpenAI Chat Completions：消费 chunk 的 `choices[].delta.content` 与终止原因。
- OpenAI Responses：消费语义事件，提取创建、输出文本增量、完成和错误。

使用官方 SDK 处理 HTTP、SSE framing 与类型，适配器只处理协议语义。备选方案是统一使用 `fetch` 手写 SSE 解析，但会重复实现断流、错误与兼容处理，不采用。

`thinking: false` 是纯文本契约的一部分，而不是可忽略的提示。Anthropic Messages 使用 SDK 原生支持的 `thinking: {type: "disabled"}`；DeepSeek Chat Completions 使用同名顶层扩展；DeepSeek Responses 则使用 Responses 请求结构的 `reasoning: {effort: "none"}`。后一个映射经过真实 SSE 探测确认：顶层 `thinking` 会被 `/responses` 忽略并继续产生 reasoning delta，而 `reasoning.effort=none` 会直接产生文本 delta。两种 OpenAI 禁用映射都只在 `base_url` 主机为 `api.deepseek.com` 时附加，其他 OpenAI 根地址保持原请求。主机判断集中在协议适配层的共享请求扩展助手中，不进入对话管理器或交互层。

客户端每次接收完整本地历史，OpenAI Responses 不传 `previous_response_id`。这样三个客户端都可按调用无状态，重启或切换 profile 不需要清理供应商侧会话。代价是长会话会重复发送历史，本阶段按规格显式接受。

### 在适配器内维护严格但可前向兼容的流状态机

适配器验证必需事件、内容块索引和唯一终态；`ping` 与未知无状态事件不改变状态。非文本块、事件乱序、索引不匹配或缺少终态都转换为协议错误。此边界能让对话管理器只处理稳定事件，同时避免把半个合法流误当作完成。

每个请求有首事件与流静默两个 120 秒计时器。任何原生文本、状态或心跳事件重置静默计时器，不设置总时长限制。计时器与用户取消合并到同一个 `AbortSignal` 链，终态后必须释放定时器和 SDK stream。

### 把可见转录与已提交模型历史分开

`ConversationManager` 为每轮创建唯一 `turn_id`，串行驱动客户端并发布 turn 生命周期。`InMemoryConversationStore` 只保存原子提交的 user/assistant 对；TUI 自己维护可见转录，因此可以显示失败、取消和半截回答而不把它们发送给下一轮模型。

正常完成、`max_tokens` 截断完成和有文本拒答会提交；取消、超时、协议错误、网络错误和无文本拒答不会提交。失败时 turn 结果携带原始用户文本，TUI 用它恢复输入框。取消后的迟到事件通过活动 `turn_id` 和终态锁双重丢弃。

备选方案是用户提交时立即写入历史，再在失败时回滚；这会引入跨异步事件的回滚竞态，不采用。

### YAML 只表达稳定的跨协议配置

外部字段使用用户确认的 snake_case：`default_profile`、`profiles[].name`、`protocol`、`model`、`base_url`、`api_key`、`thinking`、`max_tokens`。加载后一次性映射为内部 camelCase 只读结构。

`max_tokens` 缺省为 4096；`thinking` 目前只接受 `false`，`true` 明确失败。`false` SHALL 由协议适配层映射为供应商支持的禁用控制，避免默认思考内容进入纯文本流。`api_key` 接受明文或完整的 `${ENVIRONMENT_VARIABLE}` 引用。配置解析和 Node 版本检查在进入 alternate screen 前完成，以便普通终端能保留完整诊断。

允许明文密钥是已确认的易用性选择。缓解措施是默认把真实配置放在用户目录、仓库只提交示例、禁止日志和错误回显密钥，并在所有错误进入共享契约前脱敏。不会把 API Key 复制到会话状态或测试夹具。

### 使用 Ink 7 的 alternate screen 构建单滚动区 TUI

Node.js 基线设为 22，使用 Ink 7 与 React。布局由静态头部、唯一 transcript viewport、可增长但不独立滚动的 composer、状态栏组成。只有 transcript 接收滚动状态；当用户离开底部时设置 follow=false，回到底部恢复。

TUI 以 turn 事件驱动 reducer：提交后立即显示 user 消息和 assistant 占位；delta 只追加到匹配 `turn_id` 的草稿；终态冻结该记录。状态耗时由本地单调时钟计算，费用和上下文比例保持空白。模型文本按纯文本渲染，不进行增量 Markdown 解析。

输入采用 `Enter` 提交、`Shift+Enter` 换行。`Ctrl+C` 由全局状态机处理：首次取消活动 turn 或清空空闲草稿，并启动 2 秒退出窗口；窗口内再次按下才卸载 TUI。退出必须恢复 alternate screen、raw mode、光标和信号监听器。

备选方案 OpenTUI 在当前 Node 环境需要更高版本与实验性 FFI；简单 readline REPL 又不满足已确认的全屏体验，因此均不采用。

### 在共享边界清理终端控制序列

用户输入在提交前、模型 delta 在累积前都经过同一文本清理器，移除 ANSI escape 与除换行、制表符外的 C0/C1 控制字符。清理后的文本同时用于渲染和模型历史，避免可见内容与后续上下文不一致。清理器不移除普通 Unicode 或代码围栏字符。

### 分离确定性测试与真实协议验收

单元测试覆盖 YAML 校验、三种协议事件转换、状态机乱序、错误脱敏、历史提交矩阵、超时和控制字符清理。集成测试使用脚本化假客户端验证从提交到终态的跨层事件。

TUI E2E 使用同一个确定性假流场景：Windows 通过 `psmux`，WSL2 Ubuntu 通过 `tmux` 发送按键、调整尺寸并捕获 pane。断言只出现一个头部、单一 transcript、正确的流式顺序、滚动行为、`Shift+Enter`、两段式 `Ctrl+C` 与终端恢复。

真实 smoke 使用显式命令和用户配置，默认测试永不读取真实配置或访问网络。Windows 分别对三个 protocol 完成两轮流式会话；WSL 任选一个 profile 完成真实 TUI 两轮冒烟。只有收到多个文本增量并正常终止才算协议通过，连接成功或仅收到首事件不算通过。

## Risks / Trade-offs

- [明文 API Key 存在本地泄露风险] → 默认使用用户级文件、提交无密钥示例、全链路脱敏，并测试错误与快照不含密钥。
- [兼容网关虽声明协议但事件序列不完整] → 每种 profile 做真实两轮 smoke，协议错误保留安全错误码而不放宽必需终态。
- [自动禁用参数误发到其他 OpenAI 端点] → 解析 `base_url` 主机，只对 `api.deepseek.com` 的 Chat 注入 `thinking.type=disabled`、对 Responses 注入 `reasoning.effort=none`，并用请求边界测试固定该行为。
- [未知供应商事件导致升级后中断] → 忽略未知无状态事件，但对改变内容或终态语义的未知事件失败关闭。
- [不裁剪历史最终触发上下文上限] → 保留全部本地历史并明确报错，后续以独立变更设计 token 预算和摘要。
- [`Shift+Enter` 在部分终端不可区分] → 把 Windows Terminal 与 WSL tmux 的真实按键场景设为验收门槛；不在未验证时宣称跨所有终端兼容。
- [Ink 重绘产生重复头部或覆盖历史] → 使用 alternate screen、唯一 viewport，并以 `psmux`/`tmux` pane 捕获验证滚屏边界和终端恢复。
- [取消与 SDK 迟到事件竞态] → 每轮唯一标识、唯一终态锁、AbortSignal 和终态后的事件丢弃共同防护。
- [真实 API smoke 有费用与外部波动] → 与默认套件分离、禁止自动重试，并分别报告本地测试与 live smoke 结果。

## Migration Plan

1. 先扩展共享契约与测试夹具，不改变现有存根的外部启动行为。
2. 实现并单测 YAML 加载、文本清理、进程内存储与三个协议适配器。
3. 接入 `ConversationManager`，用假客户端完成跨层流式集成测试。
4. 接入新的根级 composition root 与 Ink TUI，再增加 `psmux`/`tmux` E2E。
5. 提供 `config.example.yaml`，由用户在 `~/.weave/config.yaml` 配置真实 profile 后显式执行三协议 smoke。
6. 若发布后需要回滚，恢复原启动入口与依赖即可；本变更不迁移或修改持久化数据。

## Open Questions

无。会影响本次规格和任务拆分的产品、协议、配置、交互与验收决策均已在 grilling 阶段确认。
