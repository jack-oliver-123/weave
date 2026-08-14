---
status: accepted
---

# 工作区变更使用可恢复事务提交

普通 Windows 和 Linux 文件系统不提供通用的跨多文件瞬时原子事务，因此 Weave 不承诺一次动作的所有路径在同一瞬间切换。Workspace Commit Broker 将完整 diff 作为 Transactional Action Change Set：先验证全部路径和授权范围，再获取工作区提交锁、重新校验基线身份与内容摘要，并使用同卷 staging、备份、持久化事务日志及逐路径原子 replace/rename 应用变化。

应用中失败时，Broker 必须在释放提交锁前按日志回滚全部已应用路径；进程崩溃后，下次开放工具模式前必须完成恢复。其他 Weave 动作不会观察部分提交，但不保证不受 Weave 控制的外部编辑器看不到多文件切换中的短暂中间状态。任何越界变化或外部并发冲突都会拒绝整批；恢复无法证明安全时保留现场并产生 Security Integrity Failure。网络和其他外部副作用不属于文件事务，也不能回滚。

事务日志使用 `PREPARED -> APPLYING -> COMMITTED -> CLEANED` 状态机并在每次状态及路径操作前持久化。存在 `COMMITTED` 标记时只完成清理，否则恢复执行前状态；恢复前每个路径必须匹配日志记录的 pre-state 或 post-state 身份与摘要。出现其他状态时进入 Workspace Recovery Conflict，不再自动写入并关闭工具模式，只提供脱敏只读报告和经用户明确确认的恢复操作。同卷 staging 与备份必须使用当前用户专属 ACL、对 Sandbox 和模型不可见；已完成事务立即清理，未解决现场不得自动删除。无法满足这些保证的平台将 `FilesystemWrite` 标记为不可用。
