---
status: accepted
---

# Permission Mode 只提供保守默认值

Weave 提供 `read_only`、`supervised` 和 `autonomous` 三种 Permission Mode，只用于裁决未被权限规则覆盖的能力。普通文件读取和普通数据向固定模型或终端披露在三种模式中默认允许；文件写入与本地结构化进程分别为 `deny / ask / allow`；Raw Shell、高风险进程、网络出口、凭据代用和 Memory 持久化在 `read_only` 中拒绝，在其余模式中要求确认；敏感数据始终要求确认，凭据数据披露始终硬拒绝。

精确的可信 allow 规则可以覆盖模式产生的 `ask` 或 `deny`，但不能覆盖 Built-in Hard Denial、Path Capability Boundary 或 OS Sandbox。项目规则仍只能收紧模式。该设计刻意不提供 `full_access`：`autonomous` 表示减少本地、可回滚动作的确认次数，不表示取消数据出口或宿主隔离。
