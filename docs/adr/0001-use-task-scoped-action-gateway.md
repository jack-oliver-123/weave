---
status: accepted
---

# 使用 Task 级 Action Gateway Session

Weave 将所有模型数据交换、业务工具、持久化和未来远程能力收敛到一个 Task 级 `Action Task Session`。其 Interface 由 `openTask`、`perform`、`resolveAuthorization` 和 `close` 组成；`perform` 首版只接受 `Model Exchange Request | Action Batch Request` 这个封闭、版本化的 `Gateway Request` 联合。Action Gateway 的 Implementation 独占输入与输出守卫、五层防线、批次授权预检、HITL 挂起、能力票据、任务沙箱、结果披露和审计，从而使 AgentLoop 无法绕过安全 Seam 直接调用模型、工具或 Sandbox Runner。

## Considered Options

- 只暴露 `openTask / transact / close`：Interface 更小，但结构化 HITL 决定需要隐藏的交互 Adapter，不利于与 ConversationManager 的 Task Action 协议明确衔接。
- 使用通用双向命令与事件通道：最容易扩展 MCP、hooks 和 plugins，但会让调用方承担关联、背压和安全状态顺序，并把 Action Gateway 变成较薄的消息协议。
- 采用 Task 级 `perform / resolveAuthorization`：保留较深的 Module，同时让同一 Run 的授权挂起与恢复成为明确、窄范围的交互入口。

## Consequences

- AgentLoop 只提交动作提案并消费已经允许披露的事件与结果；`Denied Result` 返回当前迭代并允许 Agent 继续重新规划。
- 每个 `Action Proposal` 必须在预检前映射为一个不可拆分的 `Normalized Action + Capability Manifest`；任一所需能力被拒绝都会拒绝整个动作，工具结果披露则作为执行后新产生的独立动作授权。
- 授权等待保持当前 Run，不通过新的模型调用或自然语言回复恢复；`resolveAuthorization` 只能绑定当前已展示请求的动作摘要与授权纪元。
- 本地工具、Memory 以及新的 MCP、hook、plugin 或动作类型必须作为 `Action Batch Request` 内部动作，在 Gateway 内通过可信、版本化注册扩展；不得为其增加新的公开 `performXxx` 入口，未知类型或无法表达最小权限的能力失败关闭。
