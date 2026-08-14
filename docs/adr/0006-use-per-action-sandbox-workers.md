---
status: accepted
---

# Task Sandbox 内使用逐动作 Worker

Sandbox Runner 拆分为可信 Sandbox Supervisor、跨 Run 保留的 Task Sandbox 和逐动作创建的 Action Worker。Task Sandbox 只保存工作区写时复制视图、资源账本和明确获准的长驻进程；每个获准动作都由 Supervisor 根据 Capability Ticket 派生独立 Action Sandbox Profile，并在新的低权限 Worker 中执行，Worker 默认随动作及其完整进程树一起销毁。

进程默认声明 `lifetime: action`。开发服务器等需要跨动作存活的进程必须显式声明 `lifetime: task`，默认进入 HITL，且始终保持创建时的文件、网络、资源和后代进程限制，不能继承后续动作权限；Task 结束、即时收权或安全完整性故障会终止它们。Linux/WSL2 在 Task 工作区视图上创建逐动作 namespace，Windows Sandbox VM 可以按 Task 保留，但动作仍使用独立低权限身份与 Job。
