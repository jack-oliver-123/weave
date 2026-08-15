## ADDED Requirements

### Requirement: 基础 CI 必须验证确定性安全内核

现有必过 CI SHALL 在普通无特权 runner 上执行 Action Gateway 状态机、动作规范化、危险命令硬拒绝、路径边界、规则合并、权限模式、epoch 与授权绑定、拒绝继续、票据 schema、数据分类传播、Input/Output Guard、审计最小化和事务状态机的单元、契约、属性及模糊测试。测试 MUST 使用固定种子或保存失败 seed，并 MUST 不依赖真实 Provider、真实凭据或生产系统。

#### Scenario: 权限规则属性测试失败
- **WHEN** 任一生成用例发现 deny 可被 allow 覆盖或 allow 未逐能力覆盖
- **THEN** 基础 CI 失败，汇总门禁不得成功

### Requirement: 基础 CI 必须验证跨层安全回归

基础 CI SHALL 包含使用 fake Provider、fake Runner 和内存审计的端到端测试，覆盖整批预检零提前执行、同一 Run HITL、逐项决定绑定、拒绝后 Agent 继续、凭据不进入模型或日志、Public Transcript 隔离、结果披露独立授权、取消与撤销以及安全完整性故障终止。故障注入 SHALL 覆盖执行前审计失败、结果审计失败、票据过期与重放、事务各阶段崩溃和 `RECOVERY_CONFLICT`。

#### Scenario: HITL 前发生工具调用
- **WHEN** 端到端测试检测到批次全部决定完成前 fake Runner 收到任何动作
- **THEN** CI 失败并报告违反 batch preflight 不变量

### Requirement: OS backend 认证必须使用独立真实环境证据

Linux、WSL2 和 Windows backend MUST 分别在满足其版本与特权前提的真实环境中执行认证任务，验证进程身份、不可见宿主路径、原始网络、环境、设备、提权、资源限额、进程树、控制 IPC、Broker 不可见、工作区事务和崩溃恢复。一个平台的通过结果 MUST NOT 认证另一个平台或不同 backend 版本。

#### Scenario: Linux 认证通过而 Windows 未运行
- **WHEN** Linux 真实 sandbox 任务通过但 Windows 任务未调度
- **THEN** 证据只标记该 Linux backend 已认证，Windows 状态保持未运行且产品在 Windows 上 fail closed

### Requirement: 未执行或不稳定结果不得报告为已认证

backend 认证状态 MUST 区分 `passed | failed | not_run | skipped | unknown | flaky`。只有绑定确切 commit、操作系统版本、backend 版本、探针版本和完整必需测试集的 `passed` MAY 生成认证证据；`not_run`、`skipped`、`unknown`、超时、缺失探针或 flaky MUST NOT 被汇总为通过，也 MUST NOT 启用对应运行时能力。

#### Scenario: 特权 runner 缺失
- **WHEN** backend 认证任务因没有所需特权而 skipped
- **THEN** 汇总清楚显示未认证，不把基础 CI 的通过替代为 sandbox 通过

### Requirement: 运行时必须重新验证认证前提

发布时的 backend 证据 MUST NOT 取代本机运行时 Capability Probe。启动 Task 前，系统 SHALL 验证当前 OS、backend 二进制身份与版本、必需隔离能力和主动负向探针结果与认证声明匹配；任何漂移、未知或失败 MUST 移除相应工具能力并 fail closed。

#### Scenario: 已认证的 bubblewrap 二进制被替换
- **WHEN** 本机 backend 身份不再匹配已认证版本
- **THEN** 运行时不启用工具并要求重新完成 backend 认证，而不是沿用旧 CI 状态
