## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: 模型动作提案必须以不透明引用保管

Action Gateway MUST 在模型响应结束时保管原始业务工具调用，并向 AgentLoop 仅返回一次性、短时有效的 `ProposalBatchRef` 与不含敏感参数的安全描述。引用 MUST 绑定 task、run、iteration、model exchange、authorization epoch 和完整提案摘要；`ActionBatch` MUST 只接受该引用，MUST NOT 接受 AgentLoop 重建的工具名或参数。引用消费、过期或 epoch 变化后 MUST 不可复用。

#### Scenario: AgentLoop 重放旧批次引用
- **WHEN** AgentLoop 在引用已消费或授权 epoch 已变化后再次提交它
- **THEN** Gateway 不执行任何动作，并返回稳定的过期或协议错误
