---
status: accepted
---

# 模型动作提案由 Action Gateway 保管

原始模型 tool calls、来源信封、标准化动作及动作摘要不跨越 Action Gateway Seam。Model Exchange Result 只向 AgentLoop 返回已允许披露的文本、脱敏动作描述和短时单次 Proposal Batch Reference；后续 Action Batch Request 只接受该引用，不接受可由调用方构造或修改的 tool call payload。

Proposal Batch Reference 绑定 Task、Run、迭代、模型交换、授权纪元和批次摘要。Memory、MCP、hook 与 plugin 等动作同样必须由 Gateway 内可信、版本化 Adapter 形成提案批次。原始工具结果继续留在 Gateway，只有 Result Disclosure Action 获准的内容才能返回 AgentLoop。过期或已消费引用产生结构化拒绝，摘要、来源或身份不匹配及伪造迹象属于 Security Integrity Failure。该边界减少 AgentLoop 的灵活性，但避免敏感参数泄漏以及授权前后动作被调用方改写。
