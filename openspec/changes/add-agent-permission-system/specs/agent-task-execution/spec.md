## MODIFIED Requirements

### Requirement: 通过解耦的异步 AgentLoop 运行任务
系统 SHALL 使用与会话存储、交互界面、具体 Provider、具体工具注册及沙箱实现解耦的 AgentLoop 运行每次模型任务。AgentLoop SHALL 只接收不可变运行输入、Task 级 `ActionTask` 能力和取消信号，并 SHALL 返回 `AsyncIterable<AgentEvent>`；它 MUST NOT 直接接收 `LlmClient`、`ToolExecutor`、原始会话历史或任意 Runner 句柄，MUST NOT 直接调用模型、工具、网络、凭据或沙箱，也 MUST NOT 感知斜杠命令、终端布局或具体模型协议。

每次运行 SHALL 分配唯一 `runId`。同一任务因规划、完善、请求输入、修订、停止后继续或取消后恢复而创建的新运行 SHALL 使用新的 `runId`，并 SHALL 保持同一个 `taskId`；一个用户 turn 可以关联多个运行。HITL 权限等待与决定 SHALL 暂停并恢复同一个 ActiveRun，不得为权限决定创建新 `runId` 或额外模型调用。

#### Scenario: 启动独立运行
- **WHEN** 上层提交有效任务快照、已打开的 `ActionTask` 和取消信号
- **THEN** AgentLoop 创建唯一 `runId`，只通过 ActionTask 请求模型交换或动作批次，并只通过异步 `AgentEvent` 流报告运行状态

#### Scenario: 请求输入后继续原任务
- **WHEN** 一个任务等待用户回答且上层携带匹配的 `taskId` 与 `questionId` 恢复执行
- **THEN** 系统创建新 `runId`、保留原 `taskId`，递增授权 epoch，并由 Secure Context Ledger 为新运行提供筛选后的任务上下文

### Requirement: 默认以 ReAct 模式自主完成任务
普通用户输入 SHALL 显式以 `react` 模式创建新的任务。ReAct 运行 SHALL 在每次迭代中通过 ActionTask 取得一个完整模型响应、提交该响应对应的不透明动作批次引用、观察有序结果并允许模型调整下一步，直到模型通过控制工具停止或运行触发硬停止条件。AgentLoop MUST NOT 接触或重新构造模型返回的原始业务工具参数。

一次迭代 SHALL 定义为“一次完整模型响应及其触发的完整动作批次”。ReAct 单次运行最多 SHALL 执行 10 次迭代。权限拒绝、路径拒绝、正常票据过期、策略拒绝和普通业务工具失败 SHALL 作为 `isError: true` 的结构化观察反馈模型，计入迭代与调用预算，并不得单独终止运行；安全完整性故障除外。

#### Scenario: 工具失败后调整方案
- **WHEN** ReAct 迭代中的业务工具返回结构化失败且运行仍在限制内
- **THEN** AgentLoop 把已获 model destination 授权的安全失败结果作为观察交回模型，并允许下一迭代调整参数、工具或方案

#### Scenario: 权限拒绝后调整方案
- **WHEN** 动作批次中的一个动作返回 `PERMISSION_DENIED` 或 `PREVIOUSLY_DENIED`
- **THEN** AgentLoop 不停止 Task，把不含受保护数据的拒绝结果反馈模型，并允许模型选择低权限替代方案或完成任务

#### Scenario: 达到 ReAct 上限
- **WHEN** ReAct 运行完成第 10 次迭代但仍未进入合法控制终态
- **THEN** AgentLoop 不再调用模型，以 `iteration_limit` 结束当前运行并确定性报告已完成工作、未完成项和最后异常

## ADDED Requirements

### Requirement: 权限等待必须暂停同一个 ActiveRun

当完整动作批次预检产生一个或多个 `ask` 时，AgentLoop SHALL 发布结构化 `authorization_requested` 事件并暂停当前 ActiveRun、当前迭代和对应 `ProposalBatchRef`。暂停期间系统 MUST 只接受绑定该请求的 `resolve_authorization` 或 Task 取消，普通输入、计划决定、其他控制工具和新的模型交换 MUST 返回 busy。决定完成后 SHALL 在同一 `runId` 内继续尚未执行的批次，且预检前 MUST 没有任何批次动作开始执行。

#### Scenario: 同一批次需要人工授权
- **WHEN** 五层决策链把一个模型动作批次中的两项标记为 `ask`
- **THEN** 系统一次展示两项但逐项收集决定，在同一运行中解析完整决定集后才执行获准动作或返回拒绝结果

### Requirement: 计划审批不得授予动作权限

Plan 的 `planId + version` 审批 MUST 只允许进入计划执行状态，MUST NOT 创建工具、路径、网络、凭据、披露或持久化授权。计划执行中的每个动作仍 MUST 按当前权限模式、规则、epoch 和五层决策链单独预检。

#### Scenario: 已批准计划包含高风险 shell
- **WHEN** 用户批准 Plan 后模型提出需要 HITL 的 shell 动作
- **THEN** 计划批准不满足该动作授权，系统仍暂停同一运行并展示独立权限请求

### Requirement: 安全完整性故障必须终止 Task

票据签名或绑定不匹配、票据重放、Runner 身份失败、沙箱认证丢失、执行前审计失败及其他安全不变量破坏 MUST 作为 `security_integrity_failure` 终止整个 Task、撤销未使用票据并阻止继续模型调用。系统 MUST NOT 把该类故障包装成模型可尝试绕过的普通工具错误。

#### Scenario: Runner 报告票据摘要不匹配
- **WHEN** Runner 重新规范化后的动作摘要与票据绑定摘要不同
- **THEN** AgentLoop 收到 Task 终止事件而不是普通观察，且模型没有机会提交修改后的同一动作
