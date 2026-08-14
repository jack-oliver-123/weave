---
status: accepted
---

# 使用封闭的能力原语词汇

Weave 的 `Capability Manifest` 首版只允许文件读取、文件写入、进程启动、网络出口、凭据代用、数据披露和 Memory 持久化七类版本化能力原语。动作类型负责表达业务操作语义，能力原语只表达执行该动作所需跨越的安全边界；权限规则、能力票据和 Action Sandbox Profile 必须共享这套封闭词汇，未知能力失败关闭。

## Considered Options

- 为每个工具或扩展定义动态能力字符串：接入简单，但策略无法稳定验证语义，插件也可能通过新名称绕开既有约束。
- 把 Workspace Commit、网络代理或凭据注入等内部步骤分别索权：粒度更细，但会把实现细节暴露给用户，并允许一个原子动作被部分批准。
- 使用封闭原语并由一个动作携带完整能力清单：策略和 OS backend 可以共同验证最小权限，同时保持工具与扩展的业务语义独立演进。

## Consequences

- `FilesystemWrite` 同时覆盖创建、修改和删除；Workspace Commit Broker 是其内部执行机制，不形成额外用户授权。
- `ProcessSpawn` 绑定可执行身份、参数、工作目录和完整后代进程树；Raw Shell 使用同一原语但保留高风险标记。
- `NetworkEgress`、`CredentialUse` 和 `DataDisclose` 分别绑定网络目标、Broker 代用范围和目标出口，互不传递授权。
- 动作级裁决与每项能力裁决按 `deny > ask > allow` 合并；任一能力拒绝都会拒绝整个动作，任一能力待确认都会让完整动作进入 HITL，只有全部允许才能签发 Capability Ticket。
- 设备访问、原始 IPC、提权及宿主安全策略修改属于 Built-in Hard Denial，不生成 Capability Ticket。
