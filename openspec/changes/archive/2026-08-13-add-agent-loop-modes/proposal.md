## Why

Weave 已经能完成模型与工具的多回合闭环，但循环仍嵌在 `ConversationManager` 中，以“模型不再调用工具并返回文本”作为完成条件，缺少独立任务状态、可靠完成协议和面向复杂任务的规划模式。现在需要把运行内核抽成解耦的 `AgentLoop`，在保持三协议与单页 TUI 的前提下，让 Agent 能够自主执行、验证、调整，并让用户对结构化计划保有明确控制。

## What Changes

- 新增独立 `AgentLoop`，通过统一 `LlmClient` 与窄 `ToolExecutor` 接口驱动模型、业务工具和内部控制工具，并以 `AsyncIterable<AgentEvent>` 发布结构化运行事件。
- 默认使用 ReAct 模式：Agent 在有界迭代中行动、观察和调整，只有成功调用 `complete_task` 才能声明完成；支持请求用户输入、取消、迭代上限和无进展异常停止。
- 新增 `/plan <任务>` 任务模式：先使用只读工具生成带依赖、步骤成功标准和任务级成功标准的版本化结构化计划，等待用户确认后按步骤串行执行，每一步复用 ReAct 内核并提交验证证据。
- 新增进程内 `AgentTaskSession` 与 `PlanSession` 显式状态机，支持计划完善、自由输入修订、执行中请求信息、实质变更重新审批、取消后恢复和停止后继续，但不提供跨进程持久化。
- 新增 `submit_plan`、`complete_step`、`skip_step`、`complete_task`、`request_user_input` 与 `request_plan_revision` 等 AgentLoop 私有控制工具；它们不进入公共 `ToolRegistry`，也不写入普通会话历史。
- 使用基础提示词加 ReAct、Plan 规划、Plan 执行短片段的最小 `SystemPrompt`；不展示内部推理，中间行动说明由运行内核根据结构化状态确定性生成。
- 扩展单页 TUI：解析 `/plan`，在唯一转录区末尾展示结构化计划和 `执行计划`、`继续完善`、`退出任务` 三个选项，并允许自由输入补充要求；底部状态栏持续显示当前 ReAct/Plan 模式与 Plan 阶段；不增加弹窗或第二滚动区域。
- **BREAKING**：`UserTurn` 必须显式提供 `react | plan` 模式；原纯文本直通路径被统一 AgentLoop 取代，即使业务工具关闭，模型仍须通过内部控制工具结束任务。
- 本次不实现权限/HITL、完整生产级 System Prompt、并行计划步骤、多任务并存、Plan 跨进程恢复或新的业务工具系统。

## Capabilities

### New Capabilities

- `agent-task-execution`: 定义 ReAct 与 Plan 双模式、AgentLoop 事件流、控制工具、任务与计划状态机、停止/恢复语义、结构化计划及验证规则。

### Modified Capabilities

- `conversation-management`: 将模型与工具循环从会话管理器中解耦，统一所有输入的任务运行路径，并定义任务历史筛选、事件映射、排队和进程内状态边界。
- `terminal-chat`: 增加 `/plan` 入口、计划展示、固定选项与自由输入交互，同时保持单页、单滚动区域和既有按键约束。
- `multi-protocol-llm`: 要求三种协议统一承载独立 System Prompt、业务工具与 AgentLoop 私有控制工具，并支持唯一的结构化完成语义。
- `tool-execution`: 通过窄 `ToolExecutor` 契约向 AgentLoop 提供定义和有序批量执行，保留既有并发读取、独占写入、预算、取消和结果顺序语义。

## Impact

- Engine：新增 `AgentLoop`、`AgentTaskSession`、`PlanSession`、`PromptBuilder`、控制工具协议、无进展检测与运行结果；收缩 `ConversationManager` 为会话与任务编排器。
- Shared contracts：新增任务模式、Plan/PlanStep、运行标识、AgentEvent、停止原因和 `ToolExecutor` 等稳定类型；`TurnEvent` 继续作为交互层兼容边界。
- Provider adapters：三种 LLM 协议继续输出统一流事件，并将 `systemPrompt` 与中立控制工具定义转换为各自协议格式。
- Tool layer：以适配器封装现有 `ToolRegistry` 与 `ToolCallScheduler`，规划阶段只暴露 `read_file`、`glob`、`grep`，执行阶段使用配置允许的完整业务工具集。
- Interaction：在既有 Ink 单页 TUI 内增加 Plan 决策状态与键盘路由，不新增独立页面或滚动容器。
- Tests：新增状态机、提示词、控制工具、停止条件、三协议伪流、事件映射和 Plan TUI 的验收测试；真实 API smoke 保持可选且不作为本地完成门槛。
