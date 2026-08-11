## Purpose

定义 Weave 在单次进程内如何编排纯文本多轮对话、隔离活动 turn、提交可复用历史，并在取消、失败、截断和拒答等终止状态下保持一致且可预测的上下文。

## ADDED Requirements

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
系统 SHALL 在当前进程内保存已提交的 user/assistant 消息，并 SHALL 在每次新请求中提供全部已提交历史。系统 MUST NOT 自动截断、摘要或压缩历史，退出进程后 SHALL 不恢复历史。

#### Scenario: 完成两轮对话
- **WHEN** 第一轮正常完成后用户提交第二轮输入
- **THEN** 第二轮模型请求包含第一轮 user/assistant 消息和第二轮用户输入

#### Scenario: 上下文超过模型限制
- **WHEN** 完整历史超过所选模型或网关的上下文限制
- **THEN** 系统保留本地历史并显示统一错误，不得静默删除或摘要消息

#### Scenario: 重新启动程序
- **WHEN** 用户退出并重新启动 Weave
- **THEN** 新进程从空对话历史开始

### Requirement: 仅提交有效轮次到模型历史
系统 SHALL 在 assistant 输出达到可提交的终态后原子提交 user/assistant 消息对。取消、超时、网络错误、协议错误以及无文本拒答 SHALL 不进入后续模型历史。

#### Scenario: 正常完成后提交
- **WHEN** assistant 返回非空文本并正常完成
- **THEN** 系统把本轮 user/assistant 消息加入历史

#### Scenario: 取消半截回答
- **WHEN** 用户在收到部分文本后取消本轮
- **THEN** 界面可继续显示部分文本，但 user 消息和部分 assistant 文本均不进入模型历史

#### Scenario: 请求失败后不提交
- **WHEN** 请求在完成前超时或失败
- **THEN** 本轮 user/assistant 内容均不进入模型历史

#### Scenario: 截断完成后提交
- **WHEN** assistant 返回非空文本并因输出 token 上限结束
- **THEN** 系统提交本轮消息，并把终态标记为截断完成

#### Scenario: 有文本的拒答
- **WHEN** 模型以拒答或内容过滤状态返回非空文本
- **THEN** 系统提交本轮消息并标记模型拒答

#### Scenario: 无文本的拒答
- **WHEN** 模型以拒答或内容过滤状态结束且没有返回文本
- **THEN** 系统把本轮按失败处理且不提交历史

### Requirement: 对外发布完整 turn 生命周期
系统 SHALL 按 turn 发布 `turn_start`、零个或多个 `text_delta`，以及恰好一个 `turn_complete`、`turn_cancelled` 或 `turn_error` 终态事件。完成事件 SHALL 可携带真实 usage 与完成原因。

#### Scenario: 正常流式生命周期
- **WHEN** 模型成功流式返回多个文本片段
- **THEN** 上层先收到 `turn_start`，再按顺序收到对应 `text_delta`，最后收到一个 `turn_complete`

#### Scenario: 错误生命周期
- **WHEN** 模型请求在完成前失败
- **THEN** 上层收到一个 `turn_error` 且不得再收到该 turn 的文本或完成事件

#### Scenario: 取消生命周期
- **WHEN** 用户取消活动请求
- **THEN** 上层收到一个 `turn_cancelled` 且不得再收到该 turn 的文本或完成事件

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
