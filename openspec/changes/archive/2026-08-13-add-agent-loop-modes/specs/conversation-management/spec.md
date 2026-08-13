## MODIFIED Requirements

### Requirement: 增量提交可关联的 Agent Loop 历史
系统 SHALL 在顶层任务开始时记录用户消息，并 SHALL 保存已经完成且会影响后续上下文的业务工具调用、业务工具结果、用户可见最终结果、计划快照和任务摘要。后续取消、系统错误、任务退出或恢复 MUST NOT 删除已完成业务轨迹、回滚外部副作用或把工作区恢复到旧状态。尚未完整组装的模型响应 MUST NOT 写入历史。

AgentLoop 私有运行历史中的内部推理文本、协议纠正消息和 `submit_plan`、`complete_step`、`skip_step`、`complete_task`、`request_user_input`、`request_plan_revision` 原始控制工具调用 MUST NOT 写入普通会话历史。系统 SHALL 只把控制工具产生的用户可见计划、问题、状态变化、最终结果与必要摘要转换为稳定历史。无论业务工具是否启用，系统 SHALL 使用同一增量历史原则，不再维护独立的纯文本原子提交路径。

#### Scenario: 无业务工具完成 ReAct 任务
- **WHEN** 业务工具关闭且模型通过 `complete_task` 正常完成任务
- **THEN** 系统保存用户消息与用户可见最终结果，但不保存原始控制工具调用或内部运行文本

#### Scenario: 工具执行后发生系统错误
- **WHEN** 业务工具已经成功修改工作区但后续模型请求发生协议错误
- **THEN** 系统保留用户消息、业务工具调用和结果，使恢复运行或后续任务能够理解实际副作用

#### Scenario: 取消正在执行的工具
- **WHEN** 用户在工具执行期间取消运行
- **THEN** 已完成轨迹保持不变，当前调用记录取消结果，未开始调用记录跳过结果，且私有运行历史不进入普通会话历史

#### Scenario: Plan 版本被修订
- **WHEN** 用户补充要求并产生新 Plan 版本
- **THEN** 系统保存可展示的版本化计划快照和必要变更摘要，不保存 `submit_plan` 原始调用

### Requirement: 对外发布完整 turn 生命周期
系统 SHALL 把一个用户提交表现为一个 turn，并 SHALL 发布一次 `turn_start`，把一个或多个 AgentLoop 运行的结构化 `AgentEvent` 映射为文本、工具、迭代、计划步骤、计划决策和任务状态事件，并 SHALL 为每次用户提交发布恰好一个兼容的 `turn_complete`、`turn_cancelled` 或 `turn_error` 终态。所有映射事件 SHALL 保留 `turnId`，并 SHALL 按需保留 `taskId`、`runId`、`planId`、`version`、`stepId` 等关联标识。

模型内部推理文本 MUST NOT 映射为 `text_delta`。完成事件 SHALL 汇总当前 turn 内全部运行的真实 usage、总耗时、模型迭代数、业务工具调用数和工具错误数。AgentLoop 的 `awaiting_input`、`plan_revision`、等待审批、可恢复停止与完成 SHALL 被映射为可区分的交互状态，不得被伪装为普通文本完成。

#### Scenario: 多迭代 ReAct 生命周期
- **WHEN** AgentLoop 经过多个业务工具批次后调用 `complete_task`
- **THEN** 上层收到一次开始事件、确定性行动与工具状态、最终结果以及一次汇总完成事件，不收到模型内部推理文本

#### Scenario: Plan 等待审批
- **WHEN** 规划运行成功提交结构化计划
- **THEN** 上层收到计划快照和等待审批状态，可继续接受计划决策或自由输入，而不把任务标记为已完成

#### Scenario: 错误或取消生命周期
- **WHEN** AgentLoop 因不可恢复错误、无进展或用户取消停止
- **THEN** 上层收到与停止原因匹配的兼容终态或可恢复任务状态，且终态后不得收到迟到事件

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

## ADDED Requirements

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
