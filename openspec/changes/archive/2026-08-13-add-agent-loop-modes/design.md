## Context

Weave 当前把纯文本请求和工具循环都实现在 `ConversationManager` 中：它同时读取/写入会话历史、驱动 Provider 流、累计工具调用、执行 `ToolCallScheduler`、生成 `TurnEvent` 并处理取消。已有 `AgentEvent` 只是 `TurnEvent` 的类型别名，`src/engine/index.ts` 中的 `AgentLoop` 仍是空壳；三种 Provider 已能把中立工具定义与工具结果映射到原生协议，`LlmRequest` 也已经包含独立 `systemPrompt` 字段。

本变更需要在不破坏 Provider codec、核心业务工具语义和单页 TUI 的情况下，把模型/工具运行状态机从会话层分离，并在其上建立 ReAct 与 Plan 两种任务策略。所有状态仍只存在于当前进程，不引入权限系统、远程服务或新依赖。参见 `proposal.md` 与五份 delta specs。

## Goals / Non-Goals

**Goals:**

- 建立稳定依赖方向，使 AgentLoop 可在没有会话存储、TUI 和具体 ToolRegistry 的情况下独立测试。
- 用一套控制工具协议统一有业务工具和无业务工具时的完成、提问与修订语义。
- 让 Plan 的版本、审批、步骤状态和验证证据由显式状态机维护，而不是从模型文本推断。
- 保持 Provider 客户端无状态、工具层拥有调度策略、交互层拥有中文展示和键盘路由。
- 在迁移期间由 `ConversationManager` 映射 `AgentEvent -> TurnEvent`，避免三协议与 TUI 同时绑定运行内核细节。

**Non-Goals:**

- 不实现权限判断、HITL 工具授权、沙箱增强或生产级安全提示词。
- 不实现多任务并存、子 Agent、并行步骤、任务后台运行、跨进程恢复或 Plan 文件持久化。
- 不扩展公共业务工具集合，不改变六个核心工具自身的路径、预算或原子性契约。
- 不保留旧的纯文本直通完成语义，也不以解析普通文本替代控制工具。

## Decisions

### 1. 使用四层运行边界和单向依赖

依赖关系为：

```text
Interaction / TUI
        |
ConversationManager
        |
AgentTaskSession ---- PlanSession
        |
     AgentLoop
      /     \
LlmClient  ToolExecutor
```

`ConversationManager` 负责把输入路由到任务、提供已筛选会话上下文、持有活动任务、转发取消、把 AgentEvent 映射成 TurnEvent，并提交用户可见历史。`AgentTaskSession` 管任务级状态与多次运行关联；`PlanSession` 管 Plan 版本、审批和步骤状态；`AgentLoop` 只运行一次不可变快照。

`AgentLoop` 依赖 `LlmClient` 和 `ToolExecutor` 接口，不依赖 `ConversationStore`、Ink、Provider 实现、`ToolRegistry` 或 `ToolCallScheduler`。`shared/` 继续只承载无实现的跨层类型。

替代方案是让 `AgentLoop` 直接读写会话存储并持有 ToolRegistry。它会缩短装配代码，但会把运行协议与持久化、工具注册和交互生命周期重新耦合，无法独立验证恢复和历史筛选，因此不采用。

### 2. `run()` 是单次有限异步流，暂停和恢复创建新运行

每次 `AgentLoop.run(input)` 创建独立 `runId`、私有消息数组、计数器、无进展检测器和唯一 `AbortController`，并返回 `AsyncIterable<AgentEvent>`。`request_user_input`、`request_plan_revision`、迭代上限、异常或取消都会让本流产生唯一 `run_stopped` 后结束；继续任务时由上层用筛选后的任务快照创建新流。

这使异步流保持单向，不需要把用户输入反向注入生成器，也不会长期挂起模型连接。替代方案是在同一生成器内等待审批或回答，会引入双向通道、资源泄漏和取消竞态，因此不采用。

### 3. AgentEvent 是运行领域协议，TurnEvent 是兼容交互协议

`AgentEvent` 从 `TurnEvent` 别名改为独立判别联合。公共字段包含 `taskId`、`runId` 和时间/统计；迭代事件包含 `iteration`；Plan 事件按需包含 `planId`、`version`、`stepId`。核心事件包括：

- `run_started`、`iteration_started`、`iteration_completed`
- `tool_call_queued`、`tool_call_started`、`tool_call_completed`、`tool_call_skipped`
- `plan_submitted`、`plan_step_started`、`plan_step_completed`、`plan_step_failed`、`plan_step_skipped`
- `user_input_requested`、`plan_revision_requested`
- `run_stopped`

事件只携带结构化数据。工具行动文案由事件类型、工具名和结果摘要确定性构造；中文渲染在交互层。`ConversationManager` 保留 TurnEvent 外部入口并做显式映射，直到未来调用方可以直接消费 AgentEvent。

替代方案是一次性用 AgentEvent 替换所有 TurnEvent。它会把架构重构和 TUI 协议迁移绑在一起，扩大回归面，因此本版不采用。

### 4. 使用业务工具与控制工具双通道，但复用 Provider codec

控制工具使用普通 `ToolDefinition` 表达并与业务定义一同传给 Provider；现有 codec 无需知道某个工具是控制还是业务。AgentLoop 按阶段维护控制工具表并负责解析/校验：

| 阶段 | 业务工具 | 控制工具 |
|---|---|---|
| ReAct | 配置允许的完整集合 | `complete_task`、`request_user_input` |
| Plan 规划/完善 | `read_file`、`glob`、`grep` | `submit_plan`、`request_user_input` |
| Plan 步骤执行 | 配置允许的完整集合 | `complete_step`、`skip_step`、`request_user_input`、`request_plan_revision` |
| Plan 收尾 | 无 | `complete_task`、`request_user_input`、`request_plan_revision` |

一次响应只能是业务调用批次或单个控制调用。业务批次交给 ToolExecutor；控制调用在 AgentLoop 内验证并返回结构化观察或状态迁移，不进入公共 ToolRegistry。达到 100 个业务调用后下一请求只保留当前阶段控制工具，而不是做无工具纯文本收尾。

替代方案包括用模型文本标记完成，或把控制工具注册进公共 ToolRegistry。前者不可可靠区分临时说明、提问和完成；后者会污染业务工具配置、调度和会话历史，因此均不采用。

### 5. ToolExecutor 适配既有调度器而不复制调度策略

定义窄接口：按可选阶段筛选返回中立工具定义，并对有序调用集合执行一次批次，输入包含 `AbortSignal` 与当前业务调用计数，输出包含有序结果、总调用数和统计。工具层适配器内部继续组合 `ToolRegistry` 与 `ToolCallScheduler`，保留连续 `read_shared` 并发、`write_exclusive` 屏障、写失败传播、512 KiB 结果预算和取消收尾。

Plan 规划的只读约束通过定义筛选实现，模型根本看不到写入工具；不使用提示词模拟权限。这不是权限系统，而是运行阶段能力装配。

替代方案是把 scheduler 直接注入 AgentLoop。这样 AgentLoop 会知道工具层批次和计数实现，后续替换调度器时需要修改运行内核，因此不采用。

### 6. 私有运行历史与公共会话历史分离

AgentLoop 将本次请求收到的公共消息复制为私有运行历史。每个完整模型响应，包括模型在工具调用前输出的文本和控制调用，都会进入私有历史，以保持 Anthropic 等协议要求的 assistant 内容块关联；业务工具结果、控制校验错误和协议纠正观察也只在该运行内追加。

运行结束时返回 `RunOutcome`：用户可见结果、验证摘要、计划快照或问题、业务工具轨迹摘要、usage、计数和停止原因。`ConversationManager` 仅将用户输入、已完成业务工具轨迹、Plan 快照、问题/回答、最终结果和退出摘要写入公共历史。原始控制调用、纠正消息和工具前模型文本随私有历史释放。

替代方案是完整保存私有历史供恢复。它会泄露内部推理并让后续模型继承旧控制状态，且与“不跨运行保留原始内部历史”的契约冲突，因此不采用。

### 7. ReAct 使用唯一完成协议和硬停止边界

ReAct 一轮定义为一个完整模型响应加该响应的完整业务工具批次；控制工具响应本身也占一轮。模型仅输出文本时，AgentLoop 生成内部协议错误 `CONTROL_TOOL_REQUIRED` 作为观察并继续。`complete_task` 校验 `result` 与 `verificationSummary` 非空后直接产生完成 outcome，不再调用模型润色。

单次 ReAct 运行上限为 10。取消、迭代上限、不可恢复错误和连续三次相同批次指纹是硬停止；达到边界不进行额外总结请求。确定性停止摘要从运行统计、已完成工具结果和最后稳定错误构建。

批次指纹对工具名、稳定键排序后的参数和剔除 `durationMs`、时间戳等易变字段的结果摘要做稳定序列化和哈希。控制工具校验失败使用控制工具名、规范化输入和错误码生成指纹。连续重复计数在出现不同指纹或合法进展事件后清零。

替代方案是让模型自己判断是否卡住。已经陷入重复行为的模型不适合作为唯一保护，且会增加不可测试性，因此不采用。

### 8. Plan 是版本化数据模型和独立显式状态机

建议核心数据结构：

```ts
type PlanStepStatus =
  | 'pending' | 'in_progress' | 'completed'
  | 'failed' | 'skipped' | 'invalidated';

interface PlanStep {
  id: string;
  description: string;
  dependencies: readonly string[];
  successCriteria: readonly string[];
  status: PlanStepStatus;
  evidence: readonly string[];
  statusReason?: string;
}

interface Plan {
  planId: string;
  version: number;
  supersedesVersion?: number;
  goal: string;
  successCriteria: readonly string[];
  steps: readonly PlanStep[];
}
```

`PlanSession` 保存不可变版本数组与当前版本索引，并通过方法执行受控迁移，不允许调用方直接修改状态。`submit_plan` 首版创建 `planId` 和 version 1；完善/修订保留 planId，版本加一。依赖只能指向数组前项，因此一次线性扫描即可同时验证未知、自依赖、后向依赖和环。

已批准执行时一个 AgentLoop 持有完整当前版本，按数组顺序寻找下一有效步骤。步骤内运行 ReAct 子循环；`complete_step` 必须对 success criteria 逐项提交结果和 evidence，`skip_step` 必须提交理由。Plan 最终 `complete_task` 再校验所有有效步骤与任务级 criteria。

Plan 每步 10 次、整个执行运行 50 次；规划/完善是单独的 10 次运行。依赖不用于并行调度。替代方案是为每步创建完全独立 AgentLoop，但会丢失同一执行运行的私有观察上下文和全计划计数，因此不采用。

### 9. AgentTaskSession 统一两种模式的跨运行生命周期

`AgentTaskSession` 保存 `taskId`、模式、任务状态、运行摘要列表、累计运行次数、总迭代数、待回答问题和可选 PlanSession。顶层状态为：

```text
running -> completed
running -> awaiting_input -> running
running -> awaiting_approval -> running
running -> stopped -> running | exited
running -> cancelled -> running | exited
running -> exited
```

Plan 子状态进一步表达 `draft`、`awaiting_approval`、`executing`、`awaiting_input`、`awaiting_revision`、`cancelled`、`completed`。任务方法在每次迁移时校验两层组合，并用 `taskId + questionId`、`planId + version` 拒绝过期输入和审批。

一次会话只允许一个未结束任务。达到上限或异常后的“继续”是用户显式触发的新运行，因此重置单次运行预算，但保留累计诊断；不设置隐藏累计硬上限。取消后恢复 Plan 必须重新审批，回答当前 Plan 问题则无需重复审批。

替代方案是在 ConversationManager 中用多个布尔字段表达这些状态。它容易产生“执行中且等待批准”等非法组合，也使 ReAct 与 Plan 的恢复逻辑分裂，因此不采用。

### 10. PromptBuilder 是纯函数，提示词保持最小

`PromptBuilder` 接收运行阶段、工具可用性、限制摘要以及可选当前 Plan/步骤，返回单个 system prompt 字符串。基础片段只含四条：使用可用工具完成任务；不输出内部推理；缺信息调用 `request_user_input`；验证后调用 `complete_task`。模式片段只补充 ReAct 行动观察、Plan 的 `submit_plan`，或当前步骤的 `complete_step`/`skip_step`/修订规则。

工具的安全边界和用途继续由 ToolDefinition、工具实现和执行层保证，不把现有冗长工具说明复制进 System Prompt。本版不让 PromptBuilder读取 ConversationStore 或 TUI 状态，单元测试使用精确片段与“不包含”断言固定边界。

### 11. TUI 复用唯一转录区和输入框

交互层在提交前解析 `/plan`，并始终为顶层 `UserTurn` 填写显式 mode。为避免把审批、回答和恢复塞进 `metadata`，会话控制契约新增结构化 `TaskAction` 判别联合，至少表达 `approve_plan`、`refine_plan`、`exit_task`、`answer_question`、`continue_task` 和 `resume_task`，每个 action 携带对应的 `taskId` 以及 `planId + version` 或 `questionId`。`ConversationController.dispatch(action)` 与 `submit(turn)` 一样返回 `AsyncIterable<TurnEvent>`；TUI 不直接操作 Session 对象。

TUI reducer 增加计划快照、决策选项、任务停止/恢复和关联标识，但仍使用既有 transcript/viewport。计划以普通转录块渲染；选项作为该块末尾内容，不创建 Modal、独立页面或 ScrollView。

当 `awaiting_approval` 且 composer 为空时，`Up/Down` 只移动本地 option index，Enter 发出带 `planId + version` 的结构化决策；composer 非空时按键恢复编辑，Enter 发出计划修订。普通状态不消费 Up。`继续完善` 启动只读 planning run，`退出任务` 记录摘要并释放 active task。

### 12. 交互层从结构化输入与事件投影当前模式

TUI reducer 保存仅用于展示的任务模式与阶段。顶层提交使用已解析的 `UserTurn.mode` 进入 ReAct 运行或 Plan 规划；审批、完善、恢复等使用结构化 `TaskAction`；`plan_ready`、`plan_step` 和 `task_state` 事件推进待确认、执行、等待输入、已停止与已取消状态。TUI MUST NOT 从转录文案或模型输出反向推断模式。

现有底部状态栏左侧始终以模式开头：无活动任务为 `ReAct · 就绪`；Plan 任务为 `Plan · 规划中 | 待确认 | 执行 n/m | 等待输入 | 已停止 | 已取消`。滚动、队列、反馈和运行耗时是后缀，不得覆盖模式。Plan 完成或退出后回落到 `ReAct · 就绪`。这是交互层投影，不让 AgentLoop、ConversationManager 或 Provider 依赖中文展示文案。

## Risks / Trade-offs

- [Provider 对强制控制工具遵循不稳定] → 不使用 Provider 专属强制工具选择，先用统一提示词与结构化纠正；三协议伪流覆盖漏调、混调和非法参数，真实 smoke 单独报告。
- [移除纯文本直通会增加简单问答的模型轮次风险] → `complete_task` 是首轮可用控制工具，提示词保持极短；用无业务工具三协议测试固定首轮完成路径。
- [计划与任务双状态机组合复杂] → 所有迁移集中在领域对象方法，使用表驱动测试覆盖合法与非法组合，TUI 不直接修改状态。
- [运行私有历史释放后恢复信息不足] → RunOutcome 必须保留用户可见结果、计划快照、业务轨迹、问题/回答和确定性摘要；测试验证恢复上下文包含必要事实但不含内部文本。
- [批次指纹可能误判合理复查] → 阈值固定为连续三次，按整批而非单调用判断，并在参数、稳定结果或进展事件变化时重置。
- [AgentEvent 到 TurnEvent 映射导致一段时间存在两套事件类型] → 映射集中在 ConversationManager，契约测试逐项验证关联标识和唯一终态；未来可另立变更移除兼容层。
- [结构化 Plan 变得过重] → 本版仅支持线性串行步骤、字符串 success criteria 与简短 evidence，不实现 DAG 调度、附件或持久化迁移。

## Migration Plan

1. 先扩展 shared 类型并以编译失败暴露所有 UserTurn、AgentEvent 和 LlmRequest 调用点；为旧 TurnEvent 保留兼容类型。
2. 在不接入 TUI 的情况下实现并测试 PromptBuilder、控制工具、AgentLoop、无进展检测、AgentTaskSession 与 PlanSession。
3. 在工具层添加 ToolExecutor 适配器，复用并回归现有 ToolCallScheduler 行为。
4. 将 ConversationManager 的工具循环迁移到 AgentLoop，先保持现有 ReAct 工具闭环，再移除纯文本直通与普通文本完成路径。
5. 接入 Plan 命令、决策状态和单页 TUI 渲染，完成方向键与自由输入路由。
6. 跑分层测试、三协议伪流闭环、TUI 回归、类型检查、构建、完整测试和严格 OpenSpec 校验；真实 API smoke 只在显式配置时执行并单独报告。

回滚应按提交边界恢复到原 ConversationManager 循环与 UserTurn 契约；本变更没有数据迁移或持久化格式，因此回滚不需要转换磁盘状态。已经执行的工作区工具副作用不在自动回滚范围内。
