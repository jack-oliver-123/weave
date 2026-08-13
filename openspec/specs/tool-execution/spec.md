# tool-execution Specification

## Purpose

定义 Weave 如何把一个模型响应中的多个工具调用组织为有序批次，在受控并发、写入失败、取消及调用预算下执行，并把完整且可关联的反馈交还模型。

## Requirements

### Requirement: 按读取批次和写入屏障调度调用
系统 SHALL 按工具调用在完整模型响应中首次出现的顺序调度。连续的 `read_shared` 调用 SHALL 组成一个并行批次，共享固定并发上限 8；每个 `write_exclusive` 调用 SHALL 独占一个批次。后一批次 MUST 等待前一批次全部结束后才开始，结果 MUST 按模型原始调用顺序排列而不是按完成顺序排列。

#### Scenario: 混合调用分批执行
- **WHEN** 模型依次请求两个读取、一个编辑、一个读取和一个 Bash 调用
- **THEN** 系统依次执行并行读取批次、独占编辑批次、读取批次和独占 Bash 批次

#### Scenario: 只读批次超过并发上限
- **WHEN** 一个只读批次包含超过 8 个调用
- **THEN** 系统最多同时运行 8 个，并按原始顺序等待空闲执行槽且保持结果顺序

### Requirement: 根据失败类型决定后续执行
只读工具执行失败或其参数无效时，系统 SHALL 保存错误结果并继续后续调用。`write_exclusive` 工具执行失败或参数无效时，系统 SHALL 停止启动后续调用，并 SHALL 为每个未开始调用生成 `PRIOR_WRITE_FAILED`。未知工具因无可信执行模式 SHALL 按写入失败处理。已完成调用 MUST NOT 回滚。

#### Scenario: 只读调用失败
- **WHEN** 一个读取调用失败且后续仍有其他批次
- **THEN** 系统返回该错误并继续执行后续批次

#### Scenario: 写入调用失败
- **WHEN** 一个写入或 Bash 调用失败
- **THEN** 系统不启动后续批次，为剩余调用生成 `PRIOR_WRITE_FAILED`，并把全部结果返回模型重新规划

#### Scenario: 未知工具
- **WHEN** 模型请求注册中心中不存在的工具
- **THEN** 系统返回 `UNKNOWN_TOOL`，跳过其后的调用且不回滚此前结果

### Requirement: 取消正在运行和等待执行的调用
一次用户 turn 的所有模型请求和工具调用 SHALL 共用同一个取消信号。用户取消时，系统 SHALL 尽快终止正在执行的工具和子进程树，为已启动但未完成的调用生成 `TOOL_CANCELLED`，为尚未开始的调用生成 `TURN_CANCELLED`，并 SHALL 不再开始批次或发起后续模型请求。已完成工具及其副作用 MUST NOT 回滚。

#### Scenario: 取消并行读取批次
- **WHEN** 用户在多个只读调用并行执行时取消 turn
- **THEN** 系统终止未完成读取、标记等待调用并结束本轮，且保留取消前已完成结果

#### Scenario: 取消 Bash
- **WHEN** 用户在 Bash 子进程运行时取消 turn
- **THEN** 系统终止子进程树、保存 `TOOL_CANCELLED` 结果并且不执行后续批次

### Requirement: 限制模型回合和工具调用数量
AgentLoop 的模型迭代上限 SHALL 由运行模式决定：ReAct 单次运行最多 10 次迭代，Plan 规划或完善单次运行最多 10 次迭代，Plan 执行每个步骤最多 10 次且整个计划单次执行运行最多 50 次。一次迭代 SHALL 包含一个完整模型响应及其触发的完整工具批次。

单个模型响应最多 SHALL 包含 32 个业务工具调用，一次 AgentLoop 运行累计最多 SHALL 接受 100 个业务工具调用；失败、跳过和取消的业务调用均计入数量。控制工具必须单独调用且不计入业务调用上限。单响应超过 32 个业务调用时系统 MUST NOT 执行该响应中的任何调用，并 SHALL 把协议错误反馈给模型；达到累计 100 个业务调用后，后续请求 SHALL 只提供当前阶段控制工具，让模型完成、请求输入或请求计划修订，不得提供额外纯文本完成路径。

#### Scenario: 单响应业务调用过多
- **WHEN** 一个完整模型响应包含 33 个业务工具调用
- **THEN** 系统不执行其中任何调用，把稳定协议错误反馈模型，并计入当前迭代

#### Scenario: 达到累计业务调用上限
- **WHEN** 当前运行累计已接受 100 个业务工具调用
- **THEN** 后续模型请求只提供允许的控制工具，不再提供业务工具或普通文本完成降级

#### Scenario: 达到 Plan 步骤上限
- **WHEN** 当前 Plan 步骤完成第 10 次迭代仍未合法完成或暂停
- **THEN** 系统以 `iteration_limit` 停止当前运行且不执行该步骤的新工具调用

### Requirement: 限制单回合工具结果回传预算
一个模型回合产生的全部工具结果序列化后最多 SHALL 向下一模型回合提供 512 KiB。系统 SHALL 按原调用顺序分配预算，并 MUST 始终保留 `callId`、`providerCallId`、`toolName`、`isError`、摘要、错误码、错误说明和重新规划所需的安全错误详情。

预算不足时系统 SHALL 只截断成功结果中的大块数据，并 SHALL 标记 `truncated: true`；截断 MUST NOT 把实际成功的工具改为错误，也 MUST NOT 将完整结果另存临时文件。

#### Scenario: 成功数据超过总预算
- **WHEN** 多个成功工具结果合计超过 512 KiB
- **THEN** 系统按调用顺序保留有界数据、标记截断，并让模型能够使用更精确的读取或搜索重新查询

#### Scenario: 大结果中包含失败反馈
- **WHEN** 回合结果接近预算且后续调用失败
- **THEN** 系统仍完整保留失败调用的关联字段、错误码和安全说明

### Requirement: 保持调用标识和结果顺序可关联
每个工具调用 SHALL 同时持有 Weave 生成且在当前用户 turn 内唯一的 `callId`，以及 Provider 返回并用于协议回传的 `providerCallId`。同一模型响应中的重复 `providerCallId` SHALL 是协议错误；不同模型回合复用相同 Provider 标识可以接受，但 MUST 映射到不同内部标识。系统 MUST NOT 通过工具名或完成顺序猜测调用与结果的关联关系。

#### Scenario: 并行调用乱序完成
- **WHEN** 多个只读调用的完成顺序与请求顺序不同
- **THEN** TUI 使用内部标识更新正确状态，协议适配器使用 Provider 标识回传，并按原请求顺序保存结果

#### Scenario: 同响应标识重复
- **WHEN** Provider 在同一模型响应中为两个调用返回相同原始标识
- **THEN** 系统终止本轮并返回协议错误且不得执行歧义调用

### Requirement: 不提供跨调用事务或自动回滚
每个文件写入工具 SHALL 只保证自身原子性。后续工具失败、取消或系统错误 MUST NOT 自动回滚此前已成功的文件修改或 Bash 副作用。本次 MUST NOT 自动创建快照、Diff、Undo、Git 提交或跨调用事务。

#### Scenario: 后续验证失败
- **WHEN** 文件编辑成功但后续 Bash 测试失败
- **THEN** 编辑结果保持在工作区，模型收到真实失败反馈并可重新读取当前状态

### Requirement: 通过窄 ToolExecutor 契约提供业务工具
AgentLoop SHALL 只通过窄工具执行契约获取当前阶段的中立业务工具定义并执行有序调用批次。该契约 SHALL 接受 `AbortSignal` 并返回与原调用顺序一致的结构化结果及批次统计；AgentLoop MUST NOT 直接依赖公共工具注册中心、具体工具实例或调度器实现。

工具层 SHALL 可以使用现有注册与调度实现该契约，并 SHALL 保留连续只读调用并发上限、写入独占屏障、写入失败传播、结果预算、调用计数、取消及原始结果顺序。Plan 规划或完善阶段 SHALL 通过定义筛选只暴露 `read_file`、`glob`、`grep`，不得通过提示词要求替代工具层筛选。

#### Scenario: 执行混合业务工具批次
- **WHEN** AgentLoop 提交包含连续读取与独占写入的有序调用集合
- **THEN** ToolExecutor 按既有批次和屏障语义执行，并按原调用顺序返回结果而不暴露内部调度器

#### Scenario: 规划阶段请求业务工具定义
- **WHEN** Plan 处于规划或继续完善阶段
- **THEN** ToolExecutor 只返回三个只读定义，写入与 Bash 定义不进入模型请求

#### Scenario: 取消业务工具批次
- **WHEN** AgentLoop 的共享取消信号在批次运行期间中止
- **THEN** ToolExecutor 取消正在运行和等待执行的调用、返回有序取消结果并完成收尾
