---
status: accepted
---

# 先持久化审计再执行和披露

批次预检的标准化摘要、规则与模式裁决以及 HITL 决定必须在 Capability Ticket 签发前持久化；Sandbox Supervisor 也必须在原子消费 nonce、启动 Action Worker 前写入最小执行记录。动作结束后，结果元数据必须跨过 Outcome Audit Barrier，才可向 AgentLoop 释放内容。同一批只读动作可以合并 durable flush，但不能延迟到下一轮模型调用。

预执行审计失败会阻止签票和执行并产生 Security Integrity Failure。副作用已经完成后的结果审计失败会立即收权、终止 Task、报告副作用可能已经发生，且不把未经审计的结果交给模型。拒绝、取消、过期、重放检测和恢复冲突同样记录。Workspace Commit Broker 的事务日志承担恢复职责，不能被普通审计替代；两类记录都只保存关联 ID、摘要、裁决和状态，不复制 Prompt、参数、文件内容、stdout/stderr 或凭据。
