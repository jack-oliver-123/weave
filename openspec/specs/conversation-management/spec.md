# conversation-management Specification

## Purpose

定义 Weave 在单次进程内如何编排纯文本多轮对话、隔离活动 turn、提交可复用历史，并在取消、失败、截断和拒答等终止状态下保持一致且可预测的上下文。

## Requirements

### Requirement: 串行处理唯一标识的 turn
系统 SHALL 为每轮用户请求分配唯一 `turn_id`，所有该轮流式事件 SHALL 携带相同标识。任一时刻最多 SHALL 有一个活动 turn，活动 turn 结束前的新提交 SHALL 被拒绝。

#### Scenario: 开始新 turn
- **WHEN** 当前没有活动 turn 且用户提交非空文本
- **THEN** 系统创建新的唯一 `turn_id` 并开始流式处理

#### Scenario: 拒绝并发提交
- **WHEN** 当前 turn 仍在生成且上层尝试提交另一条消息
- **THEN** 系统拒绝第二次提交且不创建新的模型请求

#### Scenario: 丢弃取消后的迟到事件
- **WHEN** 已取消 turn 的底层客户端随后产生迟到事件
- **THEN** 系统不得把该事件转发为当前或后续 turn 的内容

### Requirement: 在进程内维护完整已提交历史
系统 SHALL 在当前进程内维护 Task 私有 Secure Context Ledger 与单独的 Public Transcript。Ledger SHALL 保存经 Input Guard 接纳、带 `ProvenanceEnvelope` 且仍获对应 destination 授权的 user、assistant、工具调用、工具结果和控制状态；Public Transcript SHALL 只保存已经通过 Output Guard 并明确发布给用户的净化内容。ConversationStore MUST NOT 成为模型上下文的事实来源，也 MUST NOT 保存凭据原文、未发布敏感内容、原始授权决定、票据或安全内部状态。

每次模型交换 SHALL 从当前 Task 的 Ledger 派生；跨 Task 使用历史时，Public Transcript SHALL 重新作为 sanitized、untrusted 数据进入新 Ledger。系统 MUST NOT 自动用摘要降低分类或扩大披露范围。退出 Task 后 SHALL 销毁 Ledger；退出进程后 SHALL 不恢复普通会话历史。Provider 因已授权上下文过长而拒绝时系统 SHALL 返回 `CONTEXT_LIMIT_EXCEEDED`，不得静默删除当前用户输入或敏感边界。

#### Scenario: 完成两个含工具的用户轮次
- **WHEN** 第一轮完成工具调用和最终回答后用户提交第二轮输入
- **THEN** 第二轮模型请求只包含新 Ledger 允许发送给固定模型目标的内容，第一轮公开内容保持 untrusted，未公开工具结果不因出现在旧 Task 中而自动披露

#### Scenario: 上下文超过模型限制
- **WHEN** 当前模型可见的已授权上下文超过所选模型或网关的上下文限制
- **THEN** 系统保留 Ledger 并显示 `CONTEXT_LIMIT_EXCEEDED`，不得静默删除、降级分类或自动摘要受保护内容

#### Scenario: 重新启动程序
- **WHEN** 用户退出并重新启动 Weave
- **THEN** 新进程从空 Ledger 和空 Public Transcript 开始

### Requirement: 增量提交可关联的 Agent Loop 历史
系统 SHALL 在顶层任务开始时把经 Input Guard 接纳的用户消息记录到 Secure Context Ledger，并 SHALL 记录已经完成且会影响后续上下文的动作元数据、已授权工具结果引用、用户可见最终结果、计划快照和任务摘要。Public Transcript SHALL 只增量提交已向终端 destination 发布的内容。后续取消、系统错误、任务退出或恢复 MUST NOT 删除已完成动作事实、回滚已提交外部副作用或把工作区恢复到旧状态；尚未完整组装或尚未通过 Output Guard 的模型响应 MUST NOT 写入 Public Transcript。

AgentLoop 私有协议文本、协议纠正消息和 `submit_plan`、`complete_step`、`skip_step`、`complete_task`、`request_user_input`、`request_plan_revision` 原始控制工具调用 MUST NOT 写入 Public Transcript。系统 SHALL 只把控制工具产生且已获终端披露授权的计划、问题、状态变化、最终结果与必要摘要转换为稳定公开历史。权限请求、逐项决定、规则、票据、拒绝缓存和审计内部数据 MUST NOT 进入模型历史或 Public Transcript 正文。

#### Scenario: 无业务工具完成 ReAct 任务
- **WHEN** 业务工具关闭且模型通过 `complete_task` 正常完成任务
- **THEN** 系统保存已接纳用户消息与通过 Output Guard 的用户可见最终结果，但不保存原始控制工具调用或内部运行文本

#### Scenario: 工具执行后发生系统错误
- **WHEN** 工作区事务已经提交但后续模型请求发生协议错误
- **THEN** Ledger 保留动作及副作用摘要，Public Transcript 只保留已发布内容，使恢复运行能够理解事实而不泄露未授权工具结果

#### Scenario: 取消正在执行的工具
- **WHEN** 用户在动作执行期间取消运行
- **THEN** 已提交动作轨迹保持不变，当前未提交 CoW 变更被丢弃，未开始调用记录取消结果，且私有运行内容不进入 Public Transcript

#### Scenario: Plan 版本被修订
- **WHEN** 用户补充要求并产生新 Plan 版本
- **THEN** 系统保存可展示的版本化计划快照和必要变更摘要，不保存 `submit_plan` 原始调用，并递增授权 epoch

### Requirement: 对外发布完整 turn 生命周期
系统 SHALL 把一个用户提交表现为一个 turn，并 SHALL 发布一次 `turn_start`，把一个或多个 AgentLoop 运行的结构化 `AgentEvent` 映射为文本、工具、迭代、计划步骤、计划决策、权限请求和任务状态事件，并 SHALL 为每次用户提交发布恰好一个兼容的 `turn_complete`、`turn_cancelled` 或 `turn_error` 终态。所有映射事件 SHALL 保留 `turnId`，并 SHALL 按需保留 `taskId`、`runId`、`planId`、`version`、`stepId`、`authorizationRequestId` 等关联标识。

模型内部推理文本 MUST NOT 映射为 `text_delta`。完成事件 SHALL 汇总当前 turn 内全部运行的真实 usage、总耗时、模型迭代数、业务动作数、权限拒绝数和工具错误数。AgentLoop 的 `awaiting_authorization` SHALL 表示 ActiveRun 暂停而非 turn 终态；`awaiting_input`、`plan_revision`、等待计划审批、可恢复停止与完成 SHALL 被映射为可区分状态，不得伪装为普通文本完成。

#### Scenario: 多迭代 ReAct 生命周期
- **WHEN** AgentLoop 经过多个动作批次后调用 `complete_task`
- **THEN** 上层收到一次开始事件、确定性行动与工具状态、最终结果以及一次汇总完成事件，不收到模型内部推理文本或未授权内容

#### Scenario: Plan 等待审批
- **WHEN** 规划运行成功提交结构化计划
- **THEN** 上层收到计划快照和等待审批状态，可继续接受计划决策或自由输入，而不把任务标记为已完成

#### Scenario: 权限请求暂停运行
- **WHEN** 当前动作批次需要 HITL
- **THEN** 上层收到绑定当前 Task、Run 和 action digest 的权限请求，turn 保持活动且不发布完成终态

#### Scenario: 错误或取消生命周期
- **WHEN** AgentLoop 因不可恢复错误、无进展或用户取消停止
- **THEN** 上层收到与停止原因匹配的兼容终态或可恢复任务状态，且终态后不得收到迟到事件

### Requirement: 失败不自动重试
系统 SHALL 不自动重试任何失败的请求。失败后 SHALL 向交互层返回原始用户文本，使用户能够修改或再次提交。

#### Scenario: 可重试错误发生
- **WHEN** 请求因限流、临时网络故障或服务端错误失败
- **THEN** 系统报告 `retryable` 状态但不自动发起第二次请求

#### Scenario: 恢复失败输入
- **WHEN** 本轮以错误结束
- **THEN** 交互层能够取得本轮原始用户文本以恢复输入框

### Requirement: 对话存储与协议客户端解耦
对话历史 SHALL 由独立存储契约维护，协议客户端 SHALL 对每次调用保持无状态，交互层 SHALL 只提交用户输入并消费 turn 事件。

#### Scenario: 替换会话存储实现
- **WHEN** 后续把进程内存储替换为持久化存储
- **THEN** 协议客户端和终端事件契约无需改变

#### Scenario: 切换协议适配
- **WHEN** 使用不同 protocol 的 profile 启动新进程
- **THEN** 对话管理与终端层消费相同的消息和事件契约

### Requirement: 驱动有界的 Agent Loop
所有普通与 Plan 输入 SHALL 由独立 AgentLoop 运行，ConversationManager SHALL 只提供筛选后的会话上下文、创建或恢复任务会话、转发取消信号、映射事件并提交用户可见历史。ConversationManager MUST NOT 实现模型与工具循环、控制工具状态迁移、无进展检测或计划步骤执行。

普通输入 SHALL 使用 ReAct；Plan 规划、完善与执行 SHALL 使用对应运行阶段。业务工具失败 SHALL 是模型可消费反馈，不得单独终止任务。完成、迭代限制、取消、异常、等待输入和计划修订 SHALL 遵循 `agent-task-execution` 的统一停止协议。

#### Scenario: 普通输入统一进入 AgentLoop
- **WHEN** 用户提交显式 `react` 模式输入，无论业务工具是否启用
- **THEN** ConversationManager 创建 ReAct 任务并把运行委托给 AgentLoop，不走纯文本直通路径

#### Scenario: Plan 步骤继续执行
- **WHEN** 当前已批准步骤的 AgentLoop 运行因请求用户输入停止且用户提交匹配回答
- **THEN** ConversationManager 使用原任务与计划快照创建新运行，并继续映射其事件

### Requirement: 为模型提供固定工具使用原则
系统 SHALL 使用最小基础提示词与当前 AgentLoop 模式片段指导模型。基础提示词 SHALL 只要求模型使用可用工具完成任务、不输出内部推理、缺少信息时调用 `request_user_input`、完成并验证后调用 `complete_task`；ReAct、Plan 规划和 Plan 执行片段 SHALL 分别补充行动观察循环、`submit_plan` 计划提交与当前步骤验证协议。

提示词 MUST NOT 承担权限系统、完整安全策略、详细编码规范或终端展示格式。业务工具定义 SHALL 自己表达适用范围和输入输出约束；业务工具失败 SHALL 继续作为可调整策略的结构化反馈。

#### Scenario: ReAct 无需业务工具
- **WHEN** 用户请求可以直接完成且当前没有业务工具可用
- **THEN** 模型仍按最小 ReAct 协议验证结果并调用 `complete_task`，不得仅返回普通文本结束

#### Scenario: Plan 规划请求
- **WHEN** 系统开始 Plan 规划或继续完善
- **THEN** 模型收到基础片段、Plan 规划片段以及只读业务工具和控制工具定义

### Requirement: 会话层编排进程内任务状态
ConversationManager SHALL 为每个顶层输入创建或路由唯一活动 `AgentTaskSession`，并 SHALL 组合可选 `PlanSession`，但 MUST NOT 把完整任务或计划状态写入 `ConversationStore`。一个会话最多 SHALL 有一个未结束任务；运行期间到达的普通后续消息 SHALL 由交互层按 FIFO 排队，当前运行终止后再提交。等待 Plan 决策或用户输入时，普通输入 SHALL 按当前任务状态解释为计划修订或问题回答，不得创建歧义的新任务。

#### Scenario: 运行期间消息排队
- **WHEN** AgentLoop 正在运行且用户提交新的普通消息
- **THEN** 系统不把消息注入当前不可变运行，而是在当前运行终止后按 FIFO 处理

#### Scenario: 等待问题回答
- **WHEN** 当前任务处于 `awaiting_input` 且用户提交普通文本
- **THEN** 系统把文本绑定当前 `taskId + questionId` 作为回答，而不是创建新的 ReAct 任务

#### Scenario: 进程结束
- **WHEN** Weave 进程退出
- **THEN** 活动任务、Plan 版本和恢复状态被释放，普通会话存储不承担任务状态恢复

### Requirement: 会话层必须专门路由授权决定

ConversationManager MUST 将 `resolve_authorization` 作为结构化 TaskAction 路由到当前 `ActionTask`，并校验 `taskId + runId + authorizationRequestId + authorizationEpoch + actionDigest` 及逐项决定集合完全匹配。等待授权期间普通文本、问题回答和计划决策 MUST 返回 busy，不能被解释为自然语言授权。HITL 决定本身 MUST NOT 递增 epoch；新的自然语言、问题回答或计划修订 MUST 递增 epoch 并撤销旧授权。

#### Scenario: 用户在授权界面输入普通文字
- **WHEN** ActiveRun 正等待授权而上层提交未绑定请求的普通文本
- **THEN** ConversationManager 不把文本当作允许或拒绝，也不注入模型上下文，而是保持原授权请求并返回 busy
