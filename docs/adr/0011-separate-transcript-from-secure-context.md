---
status: accepted
---

# 公开转录与安全模型上下文分离

ConversationStore 不再同时承担 UI 历史和模型上下文职责。Public Transcript 只保存 Output Guard 允许在本地界面显示的脱敏用户文本、模型文本和安全摘要；Task 级 Secure Context Ledger 保存内容引用、Provenance Envelope、Data Classification、授权状态、模型原始输出、动作提案和工具原始结果，并由 Input Guard 组装模型请求。Model Exchange Request 只能引用 Ledger 中的上下文及可信运行态，不能传入任意 `ChatMessage[]`。

用户输入先进入临时缓冲，完成凭据检测、分类与来源标记后才可进入 Ledger 或 Transcript；Credential Data 只留下无内容占位并销毁原始缓冲。Task 结束时销毁私有 Ledger，跨 Task 内容必须经过 MemoryPersist。Public Transcript 可以在新 Task 中重新摄取，但只能成为已脱敏、不可信的会话上下文，不恢复旧授权或降低分类；审计只保存摘要和关联 ID，不复制 Ledger 内容。
