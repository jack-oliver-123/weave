## ADDED Requirements

### Requirement: namespace bootstrap 必须形成安全化认证证据

Linux 与 WSL2 backend MUST 把 user/mount/PID/network namespace、最小运行时挂载和 chroot 启动成功作为版本化的必要 bootstrap probe。启动命令非零退出、没有产生完整 probe 输出或 bootstrap 状态未知时，Capability Report MUST 移除全部依赖该 backend 的能力，并 SHALL 只公开稳定错误码与失败 probe ID；原始 stderr、宿主路径、环境变量和命令正文 MUST NOT 进入模型、终端或普通错误消息。

#### Scenario: namespace 启动命令被宿主策略拒绝
- **WHEN** backend 启动 namespace 的命令非零退出且没有进入隔离运行时
- **THEN** Capability Report 将 bootstrap probe 标记为 `failed`、不发布 `FilesystemRead`，并返回包含 bootstrap probe ID 的安全化 `SANDBOX_UNAVAILABLE`

#### Scenario: namespace bootstrap 成功
- **WHEN** backend 成功建立全部 namespace、最小挂载与 chroot 并完成版本化 probe
- **THEN** bootstrap probe 标记为 `passed`，系统继续验证其他必要负向探针且不因 bootstrap 单独发布任何能力

### Requirement: bootstrap 失败不得运行无意义的 cleanup 探针

进程树 cleanup 探针 MUST 只在 namespace bootstrap 已成功并能启动受控子进程后运行。bootstrap 失败时系统 SHALL 立即把 cleanup 状态标记为 `failed` 并返回，不得等待不存在的子进程或尝试宿主执行 fallback。

#### Scenario: bootstrap 在创建受控子进程前失败
- **WHEN** 初始 namespace bootstrap 未成功
- **THEN** backend 不调用进程树 cleanup probe，立即发布失败报告且不产生固定 cleanup 等待延迟
