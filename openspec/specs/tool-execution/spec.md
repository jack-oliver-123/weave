# tool-execution Specification

## Purpose

定义 Weave 如何把一个模型响应中的多个工具调用组织为有序批次，在受控并发、写入失败、取消及调用预算下执行，并把完整且可关联的反馈交还模型。

## Requirements

### Requirement: 按读取批次和写入屏障调度调用
系统 SHALL 先保管完整模型响应中的原始业务调用、按原始顺序为每项生成不可变 NormalizedAction 与 Capability Manifest，并对整个批次完成危险命令、路径、权限规则、权限模式和 HITL 五层预检。在全部 `ask` 获得逐项决定、全部拒绝项形成稳定结果且执行前审计持久化之前，MUST NOT 启动批次中的任何动作。

预检完成后，系统 SHALL 按模型调用首次出现顺序调度获准动作。连续 `read_shared` 动作 SHALL 组成并行批次，共享固定并发上限 8；每个 `write_exclusive` 动作 SHALL 独占一个批次。后一批次 MUST 等待前一批次全部结束后才开始，拒绝项占据其原始位置但不启动 Worker，结果 MUST 按模型原始调用顺序排列而不是按完成顺序排列。

#### Scenario: 混合调用分批执行
- **WHEN** 模型依次请求两个读取、一个编辑、一个读取和一个 shell 动作，且预检全部完成
- **THEN** 系统依次执行并行读取批次、独占编辑批次、读取批次和独占 shell 批次

#### Scenario: 只读批次超过并发上限
- **WHEN** 一个获准只读批次包含超过 8 个调用
- **THEN** 系统最多同时运行 8 个，并按原始顺序等待空闲执行槽且保持结果顺序

#### Scenario: 批次中存在待授权动作
- **WHEN** 第一个动作可自动允许而第三个动作需要 HITL
- **THEN** 系统在用户完成第三个动作的决定前不执行第一个动作，避免“先执行再询问”的部分副作用

### Requirement: 根据失败类型决定后续执行
权限拒绝、普通只读工具失败或参数无效时，系统 SHALL 保存安全错误结果并继续后续获准调用。`write_exclusive` 动作在 Worker 启动后执行失败、事务提交失败或参数无效时，系统 SHALL 停止启动后续调用，并 SHALL 为每个未开始调用生成 `PRIOR_WRITE_FAILED`。未知工具因没有受信定义与能力清单 SHALL 在预检时拒绝并按写入屏障处理。已由先前动作成功提交的变更 MUST NOT 自动回滚。

硬拒绝或用户拒绝某一动作 MUST NOT 自动拒绝批次中无依赖且已获准的其他动作；但系统 MUST 保持原始屏障顺序，并且模型只能在整个批次形成有序结果后继续下一次交换。安全完整性故障 MUST 终止 Task，不能继续后续动作。

#### Scenario: 只读调用失败
- **WHEN** 一个读取动作失败且后续仍有其他获准批次
- **THEN** 系统返回该错误并继续执行后续批次

#### Scenario: 写入调用失败
- **WHEN** 一个写入或 shell 动作在执行阶段失败
- **THEN** 系统不启动后续批次，为剩余调用生成 `PRIOR_WRITE_FAILED`，并把全部安全结果返回模型重新规划

#### Scenario: 未知工具
- **WHEN** 模型请求注册中心中不存在的工具
- **THEN** 系统返回 `UNKNOWN_TOOL`，跳过其后的调用且不回滚此前已提交结果

#### Scenario: 用户拒绝单个动作
- **WHEN** 用户在同一 HITL 请求中拒绝一个动作并允许另一个独立动作
- **THEN** 被拒绝项返回 `PERMISSION_DENIED`，获准项在整批预检完成后按原始屏障顺序执行

### Requirement: 取消正在运行和等待执行的调用
一次 ActiveRun 的模型交换、授权等待和动作调用 SHALL 共用同一个取消域。用户取消时，系统 SHALL 撤销当前 Task 未使用票据、终止正在执行的 Worker 与完整子进程树、丢弃当前动作未提交的 CoW 变更，为已启动但未完成的普通调用生成 `TOOL_CANCELLED`，为尚未开始的调用生成 `TURN_CANCELLED`，并 SHALL 不再开始批次或发起后续模型请求。已经由先前动作提交的副作用 MUST NOT 回滚。

取消授权对话 SHALL 返回 `PERMISSION_CANCELLED` 并结束当前运行，但 MUST NOT 把动作加入显式拒绝缓存。宿主即时 deny 或 revoke MAY 中止正在执行的动作并按安全策略终止 Task。

#### Scenario: 取消并行读取批次
- **WHEN** 用户在多个只读动作并行执行时取消 turn
- **THEN** 系统终止未完成 Worker、标记等待调用并结束本轮，且保留取消前已提交结果

#### Scenario: 取消 Bash
- **WHEN** 用户在 shell Worker 运行时取消 turn
- **THEN** 系统终止完整进程树、丢弃该动作未提交变更、保存 `TOOL_CANCELLED` 结果并且不执行后续批次

#### Scenario: 取消待授权批次
- **WHEN** 用户在 HITL 权限请求中选择取消
- **THEN** 系统关闭当前运行并返回 `PERMISSION_CANCELLED`，同一动作在后续新提案中仍可再次请求授权

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
AgentLoop SHALL 不再接收或调用 `ToolExecutor`。它 SHALL 只通过 Task 级 `ActionTask` 获取当前阶段和当前权限状态塑形后的中立工具定义、发起 `ModelExchange`，并使用不透明 `ProposalBatchRef` 提交 `ActionBatch`。该契约 SHALL 接受取消信号并返回与原调用顺序一致的安全结构化结果及批次统计；AgentLoop MUST NOT 直接依赖公共工具注册中心、具体工具实例、调度器、权限引擎、Provider 或 Runner。

Action Gateway SHALL 在内部组合定义筛选、规范化、五层预检、HITL、审计、票据签发、Runner 调度、结果守卫和披露。Plan 规划或完善阶段 SHALL 在权限塑形后最多只暴露 `read_file`、`glob`、`grep`；不可用或未认证能力 MUST 从模型定义中移除，同时运行时仍 MUST 对所有实际提案重新执行授权，不能只依赖隐藏工具。

#### Scenario: 执行混合业务工具批次
- **WHEN** AgentLoop 提交一个由当前模型交换产生的有效 `ProposalBatchRef`
- **THEN** ActionTask 完成预检和必要 HITL 后按既有批次屏障执行，并按原调用顺序返回安全结果而不暴露原始提案或内部调度器

#### Scenario: 规划阶段请求业务工具定义
- **WHEN** Plan 处于规划或继续完善阶段
- **THEN** ActionTask 最多返回三个已获当前模式允许且沙箱后端可提供的只读定义，写入与 shell 定义不进入模型请求

#### Scenario: 取消业务工具批次
- **WHEN** AgentLoop 的共享取消信号在授权等待或批次运行期间中止
- **THEN** ActionTask 取消等待和执行、撤销未使用票据、返回有序取消结果并完成收尾

### Requirement: 模型动作提案必须以不透明引用保管

Action Gateway MUST 在模型响应结束时保管原始业务工具调用，并向 AgentLoop 仅返回一次性、短时有效的 `ProposalBatchRef` 与不含敏感参数的安全描述。引用 MUST 绑定 task、run、iteration、model exchange、authorization epoch 和完整提案摘要；`ActionBatch` MUST 只接受该引用，MUST NOT 接受 AgentLoop 重建的工具名或参数。引用消费、过期或 epoch 变化后 MUST 不可复用。

#### Scenario: AgentLoop 重放旧批次引用
- **WHEN** AgentLoop 在引用已消费或授权 epoch 已变化后再次提交它
- **THEN** Gateway 不执行任何动作，并返回稳定的过期或协议错误
