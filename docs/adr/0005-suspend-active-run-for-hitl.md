---
status: accepted
---

# HITL 保持原 ActiveRun 挂起

Action Task Session 在批次预检产生 `ask` 时，通过原 `perform()` 事件流发出 Authorization Request 并保持当前 ActiveRun 挂起。ConversationManager 同时只保存一个 Pending Authorization；挂起期间只接受取消或绑定 `taskId + runId + requestId + authorizationEpoch + actionDigest`、且逐项覆盖全部待决动作的 `resolve_authorization`，普通用户输入仍按 busy 处理。

有效决定恢复同一异步流，不创建新 Run、不重新请求模型。过期、重复、缺失或包含额外动作的决定返回 `STALE_AUTHORIZATION_REQUEST` 或结构化校验错误，且不改变当前等待；明确拒绝生成 Denied Result 并允许 AgentLoop 继续，交互取消则按 Authorization Interruption 取消当前 Run。TUI 只在现有转录区追加授权事件，并复用固定底部操作栏，不创建第二滚动区域。
